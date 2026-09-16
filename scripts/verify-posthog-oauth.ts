// CHE-236 verification: the analytics connection, and the three things about it
// that are security rather than plumbing.
//
// PostHog does not have us registered as an app. Our `client_id` is the URL of a
// document we host, which PostHog fetches mid-flow to learn which redirect URIs
// may receive an authorization code issued in our name. That makes the document
// a boundary, not a description, and it makes us a public client — no secret
// exists, so PKCE is the only proof that the code is being redeemed by whoever
// started the flow.
//
// What this holds:
//   1. the metadata document lists exactly one redirect, built from
//      configuration, https-only, and refuses to exist over http;
//   2. PKCE is real — the challenge is the S256 of the verifier, and the
//      authorize URL carries it;
//   3. no `:write` scope is ever requested, and the list stays the short one;
//   4. discovery refuses rather than guesses: no S256 advertised, no flow;
//   5. a token result is a fact the caller must read — an expired connection
//      with no refresh says so instead of returning a stale token (CHE-269);
//   6. a rotated refresh token replaces the stored one, or the connection dies
//      on its second refresh rather than its first;
//   7. the region is asked for, not assumed — a US-hosted worker must not
//      strand an EU customer, and a token no region accepts is never stored
//      behind the word "Connected";
//   8. Disconnect revokes at the provider, so the customer's own list of apps
//      with access stops naming us.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-posthog-oauth.ts

process.env.CREDENTIALS_SECRET ??= "verify-posthog-secret";

import {
  POSTHOG_SCOPES,
  buildAuthorizeUrl,
  challengeFor,
  clientMetadata,
  createVerifier,
  discoverPostHog,
  revokeToken,
  unsupportedScopes,
  type PostHogEndpoints,
} from "@/lib/posthog/oauth";
import { findAccount, probeOrder } from "@/lib/posthog/api";
import { freshPostHogToken, isStranded } from "@/lib/posthog/token";
import { encryptSecret } from "@/lib/crypto";
import type { PrismaClient } from "@/generated/prisma/client";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ENDPOINTS: PostHogEndpoints = {
  issuer: "https://oauth.posthog.com",
  authorizationEndpoint: "https://oauth.posthog.com/oauth/authorize/",
  tokenEndpoint: "https://oauth.posthog.com/oauth/token/",
  revocationEndpoint: "https://oauth.posthog.com/oauth/revoke/",
  codeChallengeMethods: ["S256"],
  scopesSupported: [...POSTHOG_SCOPES, "insight:write", "project:write"],
  regionHint: "us",
};

/** A fetch that answers one canned response and records what it was asked. */
function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const next = responses.shift() ?? { status: 500, body: {} };
    const body: Record<string, string> = {};
    if (typeof init?.body === "string" || init?.body instanceof URLSearchParams) {
      new URLSearchParams(init.body as string).forEach((v, k) => (body[k] = v));
    }
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function main() {
  console.log("The metadata document is a boundary, not a description");
  {
    const doc = clientMetadata("https://checkmyapp.dev") as Record<string, unknown>;
    check("client_id is the document's own URL",
      doc.client_id === "https://checkmyapp.dev/.well-known/posthog-client.json", String(doc.client_id));
    check("exactly one redirect URI",
      Array.isArray(doc.redirect_uris) && (doc.redirect_uris as string[]).length === 1,
      JSON.stringify(doc.redirect_uris));
    check("…and it is our callback on our origin",
      (doc.redirect_uris as string[])[0] === "https://checkmyapp.dev/api/integrations/posthog/callback",
      (doc.redirect_uris as string[])[0]);
    check("no wildcard anywhere in the redirect list",
      !(doc.redirect_uris as string[]).some((u) => u.includes("*")), JSON.stringify(doc.redirect_uris));
    check("we declare ourselves a public client",
      doc.token_endpoint_auth_method === "none", String(doc.token_endpoint_auth_method));
    check("no client secret is present under any name",
      !Object.keys(doc).some((k) => /secret/i.test(k)), Object.keys(doc).join(","));

    // A trailing slash in configuration must not produce a double slash in the
    // one string PostHog matches exactly.
    const trailing = clientMetadata("https://checkmyapp.dev/") as Record<string, unknown>;
    check("a trailing slash does not corrupt the redirect",
      (trailing.redirect_uris as string[])[0] === "https://checkmyapp.dev/api/integrations/posthog/callback",
      (trailing.redirect_uris as string[])[0]);

    // http would let the allowed-redirect list itself be rewritten in transit.
    let refused = false;
    try {
      clientMetadata("http://checkmyapp.dev");
    } catch {
      refused = true;
    }
    check("an http origin is refused, not served", refused);
    let refusedEmpty = false;
    try {
      clientMetadata("");
    } catch {
      refusedEmpty = true;
    }
    check("an empty origin is refused too", refusedEmpty);
  }

  console.log("\nWe ask for reading, and only reading");
  {
    // The ceiling PostHog enforces on our behalf. This is the difference
    // between "we only read" as a comment and as a rule: a future bug in the
    // authorize URL cannot obtain a :write token if this list has none.
    const ceiling = (clientMetadata("https://checkmyapp.dev")["com.posthog"] ?? {}) as { scopes?: string[] };
    check("the metadata declares a scope ceiling", Array.isArray(ceiling.scopes), JSON.stringify(ceiling));
    check("…the ceiling is exactly what we request",
      JSON.stringify(ceiling.scopes) === JSON.stringify([...POSTHOG_SCOPES]), JSON.stringify(ceiling.scopes));
    check("…and it contains no :write scope",
      !(ceiling.scopes ?? []).some((s) => s.endsWith(":write")), (ceiling.scopes ?? []).join(" "));
    check("…and it is non-empty, or PostHog rejects the registration",
      (ceiling.scopes ?? []).length > 0, String((ceiling.scopes ?? []).length));

    check("no :write scope is requested", !POSTHOG_SCOPES.some((s) => s.endsWith(":write")), POSTHOG_SCOPES.join(" "));
    check("the list stays short — four scopes", POSTHOG_SCOPES.length === 4, String(POSTHOG_SCOPES.length));
    check("nothing we ask for is missing from the server", unsupportedScopes(ENDPOINTS).length === 0);
    check("a server that dropped a scope is detected",
      unsupportedScopes({ ...ENDPOINTS, scopesSupported: ["project:read"] }).length === 3,
      unsupportedScopes({ ...ENDPOINTS, scopesSupported: ["project:read"] }).join(","));
    check("a server that lists nothing is not treated as missing everything",
      unsupportedScopes({ ...ENDPOINTS, scopesSupported: [] }).length === 0);
  }

  console.log("\nPKCE is real, not decorative");
  {
    const verifier = createVerifier();
    const challenge = await challengeFor(verifier);
    check("the verifier is long enough to matter", verifier.length >= 43, `${verifier.length} chars`);
    check("verifier and challenge differ", verifier !== challenge);
    check("the challenge is stable for a verifier", (await challengeFor(verifier)) === challenge);
    check("a different verifier gives a different challenge", (await challengeFor(createVerifier())) !== challenge);
    // Known-answer test from RFC 7636 appendix B: if this drifts, the hashing
    // is wrong in a way no round-trip test would catch.
    check("S256 matches the RFC 7636 test vector",
      (await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")) === "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));

    const url = new URL(buildAuthorizeUrl({
      endpoints: ENDPOINTS,
      clientId: "https://checkmyapp.dev/.well-known/posthog-client.json",
      redirectUri: "https://checkmyapp.dev/api/integrations/posthog/callback",
      state: "state-123",
      challenge,
    }));
    check("the authorize URL carries the challenge, never the verifier",
      url.searchParams.get("code_challenge") === challenge && !url.toString().includes(verifier));
    check("…and says which method", url.searchParams.get("code_challenge_method") === "S256");
    check("…and asks for a code", url.searchParams.get("response_type") === "code");
  }

  console.log("\nDiscovery refuses rather than guesses");
  {
    const noS256 = stubFetch([{ body: { ...ENDPOINTS, authorization_endpoint: "x", token_endpoint: "y", code_challenge_methods_supported: ["plain"] } }]);
    let refused = false;
    try {
      await discoverPostHog("https://oauth.posthog.com", noS256.impl);
    } catch {
      refused = true;
    }
    check("a provider without S256 stops the flow", refused);

    const noEndpoints = stubFetch([{ body: { issuer: "https://oauth.posthog.com" } }]);
    let refusedMissing = false;
    try {
      await discoverPostHog("https://oauth.posthog.com", noEndpoints.impl);
    } catch {
      refusedMissing = true;
    }
    check("metadata without endpoints stops the flow", refusedMissing);
  }

  console.log("\nThe region is asked, not assumed");
  {
    // A fetch that answers by host, so "which region did we ask" is observable.
    const byHost = (answers: Record<string, { status: number; body?: unknown }>) => {
      const asked: string[] = [];
      const impl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        asked.push(url);
        const host = new URL(url).host;
        const a = answers[host] ?? { status: 401 };
        return new Response(JSON.stringify(a.body ?? {}), {
          status: a.status,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      return { impl, asked };
    };

    check("both regions are always candidates, whatever the hint",
      probeOrder("eu").length === 2 && probeOrder(null).length === 2 && probeOrder("mars").length === 2);
    check("the hinted region is tried first", probeOrder("eu")[0].region === "eu", probeOrder("eu")[0].region);
    check("…and a base-URL hint works the same", probeOrder("https://eu.posthog.com")[0].region === "eu");

    const euOnly = byHost({ "eu.posthog.com": { status: 200, body: { id: "org-7", name: "Acme GmbH" } } });
    const found = await findAccount("pha_token", { hint: "us", fetchImpl: euOnly.impl });
    check("a US hint does not strand an EU customer",
      found.region === "eu" && found.organizationName === "Acme GmbH" && found.organizationId === "org-7",
      JSON.stringify(found));
    check("…and the US endpoint was tried first, as hinted",
      euOnly.asked.length === 2 && euOnly.asked[0].includes("us.posthog.com"), euOnly.asked.join(" → "));

    const usOnly = byHost({ "us.posthog.com": { status: 200, body: { id: "org-1", name: "Acme Inc" } } });
    const hit = await findAccount("pha_token", { hint: "us", fetchImpl: usOnly.impl });
    check("the hinted region, when right, costs exactly one request",
      hit.region === "us" && usOnly.asked.length === 1, usOnly.asked.join(" → "));

    const nameless = byHost({ "us.posthog.com": { status: 200, body: { id: "org-2" } } });
    const unnamed = await findAccount("pha_token", { fetchImpl: nameless.impl });
    check("a nameless organisation falls back to its id rather than printing 'undefined'",
      unnamed.organizationName === "org-2", unnamed.organizationName);

    const nobody = byHost({});
    let refused = false;
    try {
      await findAccount("pha_token", { fetchImpl: nobody.impl });
    } catch {
      refused = true;
    }
    check("a token no region accepts is refused, not stored as 'Connected'", refused);
    check("…and both regions were asked before giving up", nobody.asked.length === 2, nobody.asked.join(" → "));
  }

  console.log("\nDisconnect ends the access, it does not just forget it");
  {
    const revoked = stubFetch([{ status: 200, body: {} }]);
    const ok = await revokeToken({
      endpoints: ENDPOINTS,
      clientId: "cid",
      token: "phr_old",
      hint: "refresh_token",
      fetchImpl: revoked.impl,
    });
    check("revocation is sent to the provider's revocation endpoint",
      ok && revoked.calls[0]?.url === ENDPOINTS.revocationEndpoint, revoked.calls[0]?.url ?? "(none)");
    check("…carrying the token and our client_id, and no secret",
      revoked.calls[0]?.body.token === "phr_old" &&
        revoked.calls[0]?.body.client_id === "cid" &&
        !("client_secret" in (revoked.calls[0]?.body ?? {})),
      JSON.stringify(revoked.calls[0]?.body));
    check("…and says it is the grant being revoked",
      revoked.calls[0]?.body.token_type_hint === "refresh_token", revoked.calls[0]?.body.token_type_hint);

    const down = stubFetch([{ status: 503, body: {} }]);
    check("a provider that refuses is reported, not claimed as success",
      (await revokeToken({ endpoints: ENDPOINTS, clientId: "cid", token: "t", fetchImpl: down.impl })) === false);
    check("a provider with no revocation endpoint is reported too",
      (await revokeToken({ endpoints: { ...ENDPOINTS, revocationEndpoint: null }, clientId: "cid", token: "t", fetchImpl: down.impl })) === false);
  }

  console.log("\nA token result is a fact the caller has to read (CHE-269)");
  {
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 3 * 60 * 60 * 1000);

    const updates: Array<Record<string, unknown>> = [];
    const db = {
      postHogIntegration: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return data;
        },
      },
    } as unknown as PrismaClient;

    const healthy = await freshPostHogToken(
      db,
      { id: "i1", teamId: "t1", accessTokenEnc: encryptSecret("pha_good"), refreshTokenEnc: null, expiresAt: later },
      { clientId: "cid" },
    );
    check("a token with hours left is used as it is",
      healthy.ok && healthy.token === "pha_good" && !healthy.refreshed, JSON.stringify(healthy));

    const stranded = await freshPostHogToken(
      db,
      { id: "i1", teamId: "t1", accessTokenEnc: encryptSecret("pha_old"), refreshTokenEnc: null, expiresAt: soon },
      { clientId: "cid" },
    );
    check("expiring with no refresh token says so instead of returning the stale one",
      !stranded.ok && /reconnect/i.test(stranded.ok ? "" : stranded.reason), JSON.stringify(stranded));

    const rotating = stubFetch([{ body: { access_token: "pha_new", refresh_token: "phr_rotated", expires_in: 3600 } }]);
    const refreshed = await freshPostHogToken(
      db,
      { id: "i1", teamId: "t1", accessTokenEnc: encryptSecret("pha_old"), refreshTokenEnc: encryptSecret("phr_old"), expiresAt: soon },
      { clientId: "cid", endpoints: ENDPOINTS, fetchImpl: rotating.impl },
    );
    check("an expiring token is refreshed", refreshed.ok && refreshed.token === "pha_new" && refreshed.refreshed, JSON.stringify(refreshed));
    check("…the refresh is sent as a public client, with no secret",
      rotating.calls[0]?.body.grant_type === "refresh_token" &&
        rotating.calls[0]?.body.client_id === "cid" &&
        !("client_secret" in (rotating.calls[0]?.body ?? {})),
      JSON.stringify(rotating.calls[0]?.body));
    check("…and a rotated refresh token replaces the stored one",
      updates.some((u) => typeof u.refreshTokenEnc === "string"), JSON.stringify(updates.at(-1)));

    const denied = stubFetch([{ status: 400, body: { error: "invalid_grant", error_description: "revoked" } }]);
    const revoked = await freshPostHogToken(
      db,
      { id: "i1", teamId: "t1", accessTokenEnc: encryptSecret("pha_old"), refreshTokenEnc: encryptSecret("phr_dead"), expiresAt: new Date(Date.now() - 1000) },
      { clientId: "cid", endpoints: ENDPOINTS, fetchImpl: denied.impl },
    );
    check("a revoked connection is reported, not swallowed",
      !revoked.ok && /revoked/.test(revoked.ok ? "" : revoked.reason), JSON.stringify(revoked));
  }

  console.log("\n'Connected' never outlives the connection");
  {
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    const future = new Date(now.getTime() + 60_000);
    const enc = encryptSecret("phr_live");

    check("expired with nothing to renew it reads as stranded",
      isStranded({ refreshTokenEnc: null, expiresAt: past }, now));
    check("expired WITH a refresh token does not — it renews on the next read",
      !isStranded({ refreshTokenEnc: enc, expiresAt: past }, now));
    check("not yet expired is not stranded",
      !isStranded({ refreshTokenEnc: null, expiresAt: future }, now));
    check("no recorded expiry is not stranded — we were told no lifetime, not that it died",
      !isStranded({ refreshTokenEnc: null, expiresAt: null }, now));
    check("expiring exactly now counts as expired",
      isStranded({ refreshTokenEnc: null, expiresAt: now }, now));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
