// PostHog OAuth 2.0 (CHE-236) — the analytics connection, made once per team.
//
// PostHog is the first integration we connect WITHOUT registering an app with
// the provider. Its OAuth server accepts a Client ID Metadata Document: our
// `client_id` is a URL we host (/.well-known/posthog-client.json), and PostHog
// fetches it during the flow to learn our name, logo and allowed redirects.
// That means no client secret exists, which makes us a public client — and a
// public client without PKCE is an authorization code anyone who intercepts the
// redirect can spend. So PKCE is not optional here.
//
// Everything about the provider is READ FROM THE PROVIDER. The endpoints below
// are discovered from `/.well-known/oauth-authorization-server`, not written
// down: an endpoint we hardcode is an endpoint that silently rots, and this one
// is documented to route US/EU for us.
//
// Verified against the live server on 2026-09-16:
//   issuer                        https://oauth.posthog.com
//   authorization_endpoint        https://oauth.posthog.com/oauth/authorize/
//   token_endpoint                https://oauth.posthog.com/oauth/token/
//   revocation_endpoint           https://oauth.posthog.com/oauth/revoke/
//   code_challenge_methods        ["S256"]
//   token_endpoint_auth_methods   ["none", "client_secret_post", "private_key_jwt"]
//   216 scopes, mirroring personal API keys
//
// No Next imports: this compiles into the agent worker as well as the web app.

/** Where the provider describes itself. Region-agnostic; it routes US/EU. */
export const POSTHOG_ISSUER = "https://oauth.posthog.com";

/**
 * What we ask for, and nothing more.
 *
 * Reading a customer's analytics is the most invasive access this product has
 * ever asked for, and rule 8 is why the list is this short: we take what
 * answers "how many people finished this journey" and not one scope further.
 * No `:write` scope appears here and none ever should — we are a mirror, not a
 * participant in someone else's analytics.
 */
export const POSTHOG_SCOPES = [
  // Which project holds this app's data, and what it is called.
  "project:read",
  // The organisation name, so the dashboard can say who is connected.
  "organization:read",
  // The funnel itself: running a query is how a conversion number is obtained.
  "query:read",
  // Saved insights, so an owner who already built the funnel can point at it.
  "insight:read",
] as const;

/**
 * Our Client ID Metadata Document, as a value.
 *
 * This is the security boundary of the whole flow: PostHog fetches it mid-flow
 * and will refuse any redirect that is not listed here, exactly. So the origin
 * comes from configuration and nothing else — never from the incoming request,
 * whose Host header the caller controls. Pure, so
 * scripts/verify-posthog-oauth.ts can hold it to that rule.
 */
export function clientMetadata(origin: string): Record<string, unknown> {
  const base = origin.replace(/\/+$/, "");
  if (!base.startsWith("https://")) {
    // A client_id served over http would let the document — and therefore the
    // allowed redirect list — be rewritten in transit.
    throw new Error(`PostHog client metadata needs an https origin, got ${origin || "(empty)"}`);
  }
  return {
    client_id: `${base}/.well-known/posthog-client.json`,
    client_name: "CheckMyApp",
    client_uri: base,
    logo_uri: `${base}/og.png`,
    redirect_uris: [`${base}/api/integrations/posthog/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // Public client: no secret exists, PKCE proves possession instead.
    token_endpoint_auth_method: "none",
    scope: POSTHOG_SCOPES.join(" "),
    // The scope ceiling, enforced by PostHog rather than by us: a token issued
    // to this client can never carry a scope outside this list, whatever our
    // authorize URL asks for. That turns "we only read" from a promise in a
    // comment into a rule the provider applies on every metadata refresh — the
    // difference between an intention and a mechanism. No `optional_scopes`:
    // all four are required, because a connection that cannot read the project
    // or run a query cannot answer the only question we connect for.
    "com.posthog": { scopes: [...POSTHOG_SCOPES] },
    // policy_uri and tos_uri are deliberately absent until those pages exist
    // (CHE-270): a broken privacy link on the screen where someone decides to
    // hand over their analytics is worse than none.
  };
}

export interface PostHogEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  /** What the server says it supports. Checked, not assumed. */
  codeChallengeMethods: string[];
  scopesSupported: string[];
  /**
   * Which region answered this discovery call. A HINT and nothing more: it says
   * where our request landed, not where the customer's data lives. The account
   * probe (src/lib/posthog/api.ts) settles that by asking.
   */
  regionHint: string | null;
}

interface RawMetadata {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  revocation_endpoint?: unknown;
  code_challenge_methods_supported?: unknown;
  scopes_supported?: unknown;
  posthog_region?: unknown;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Ask the provider where its endpoints are.
 *
 * Throws rather than falling back to a guess: a connection built on a guessed
 * endpoint would fail at consent time, in front of the customer, with nothing
 * to read. Better to refuse here, where the dashboard can say "analytics is
 * unavailable right now" and mean it.
 */
export async function discoverPostHog(
  issuer: string = POSTHOG_ISSUER,
  fetchImpl: typeof fetch = fetch,
): Promise<PostHogEndpoints> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`PostHog metadata ${res.status} from ${url}`);
  const raw = (await res.json()) as RawMetadata;

  const authorizationEndpoint = typeof raw.authorization_endpoint === "string" ? raw.authorization_endpoint : "";
  const tokenEndpoint = typeof raw.token_endpoint === "string" ? raw.token_endpoint : "";
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("PostHog metadata is missing an authorization or token endpoint");
  }
  const codeChallengeMethods = strings(raw.code_challenge_methods_supported);
  if (!codeChallengeMethods.includes("S256")) {
    // We have no client secret, so S256 is the only thing standing between a
    // stolen redirect and a usable token. If the provider stops offering it,
    // this integration stops rather than degrading quietly.
    throw new Error("PostHog no longer advertises S256 — refusing to start a public-client flow without PKCE");
  }
  return {
    issuer: typeof raw.issuer === "string" ? raw.issuer : issuer,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint: typeof raw.revocation_endpoint === "string" ? raw.revocation_endpoint : null,
    codeChallengeMethods,
    scopesSupported: strings(raw.scopes_supported),
    regionHint: typeof raw.posthog_region === "string" ? raw.posthog_region : null,
  };
}

/** Scopes we want that the server does not offer. Empty is the expected answer. */
export function unsupportedScopes(endpoints: PostHogEndpoints, scopes: readonly string[] = POSTHOG_SCOPES): string[] {
  if (endpoints.scopesSupported.length === 0) return [];
  return scopes.filter((s) => !endpoints.scopesSupported.includes(s));
}

const base64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A PKCE verifier: 32 random bytes, base64url. Never leaves our side. */
export function createVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** S256 challenge for a verifier. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

export function buildAuthorizeUrl(args: {
  endpoints: PostHogEndpoints;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(args.endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", (args.scopes ?? POSTHOG_SCOPES).join(" "));
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface PostHogTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute, not a duration — a duration is a bug waiting for a retry. */
  expiresAt: Date | null;
  scope: string | null;
}

interface RawTokens {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function readTokens(raw: RawTokens, now: Date): PostHogTokens {
  if (typeof raw.access_token !== "string" || !raw.access_token) {
    const detail = typeof raw.error_description === "string" ? raw.error_description : String(raw.error ?? "no token");
    throw new Error(`PostHog returned no access token: ${detail}`);
  }
  const lifetime = typeof raw.expires_in === "number" ? raw.expires_in : null;
  return {
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : null,
    expiresAt: lifetime ? new Date(now.getTime() + lifetime * 1000) : null,
    scope: typeof raw.scope === "string" ? raw.scope : null,
  };
}

/** Consent code → tokens. Public client: no secret, the verifier is the proof. */
export async function exchangeCode(args: {
  endpoints: PostHogEndpoints;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<PostHogTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.verifier,
  });
  const res = await (args.fetchImpl ?? fetch)(args.endpoints.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const raw = (await res.json().catch(() => ({}))) as RawTokens;
  if (!res.ok) {
    const detail = typeof raw.error_description === "string" ? raw.error_description : `HTTP ${res.status}`;
    throw new Error(`PostHog token exchange failed: ${detail}`);
  }
  return readTokens(raw, args.now ?? new Date());
}

/**
 * Refresh an expiring token. The reason this exists at the same time as the
 * connect flow rather than after it: CHE-68 is the lesson already paid for —
 * a connection that dies at the first expiry was never a connection, and
 * nobody notices until a customer's data silently stops arriving.
 */
/**
 * Tell PostHog the token is finished with (RFC 7009).
 *
 * Disconnect deletes our row either way — the customer asked for their
 * analytics to stop being read, and that must not depend on someone else's
 * server answering. This is the other half: without it the grant stays alive in
 * the customer's PostHog settings, listed as an app that still has access,
 * which is a lie told by omission on a screen we do not control.
 *
 * Returns whether the provider confirmed. The caller decides what to say; it
 * does not get to not know.
 */
export async function revokeToken(args: {
  endpoints: PostHogEndpoints;
  clientId: string;
  token: string;
  /** "refresh_token" revokes the whole grant where the server supports it. */
  hint?: "access_token" | "refresh_token";
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (!args.endpoints.revocationEndpoint) return false;
  const body = new URLSearchParams({ token: args.token, client_id: args.clientId });
  if (args.hint) body.set("token_type_hint", args.hint);
  try {
    const res = await (args.fetchImpl ?? fetch)(args.endpoints.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function refreshTokens(args: {
  endpoints: PostHogEndpoints;
  clientId: string;
  refreshToken: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<PostHogTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  });
  const res = await (args.fetchImpl ?? fetch)(args.endpoints.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const raw = (await res.json().catch(() => ({}))) as RawTokens;
  if (!res.ok) {
    const detail = typeof raw.error_description === "string" ? raw.error_description : `HTTP ${res.status}`;
    throw new Error(`PostHog token refresh failed: ${detail}`);
  }
  return readTokens(raw, args.now ?? new Date());
}
