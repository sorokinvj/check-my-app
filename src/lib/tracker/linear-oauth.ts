// Linear OAuth2 handshake (CHE-31). Multi-tenant: each owner authorizes their
// own workspace; we store the resulting access token (encrypted) per App.
// Spec: authorize https://linear.app/oauth/authorize, token exchange
// POST https://api.linear.app/oauth/token (form-urlencoded). Actor=Application
// is set in the Linear app settings so tickets are created by the integration.

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

// read = list teams/labels/states; write + issues:create + comments:create = file/update tickets.
const SCOPES = "read,write,issues:create,comments:create";

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: SCOPES,
    state: opts.state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface LinearToken {
  access_token: string;
  expires_in?: number;
  scope: string;
  token_type: string;
}

export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<LinearToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Linear token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as LinearToken;
}

// First team in the authorized workspace — used as the default ticket destination
// (team selection UI is a later refinement; most owners have one main team).
export async function fetchFirstTeam(
  accessToken: string,
): Promise<{ id: string; name: string } | null> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query: "{ teams(first: 1) { nodes { id name } } }" }),
  });
  const json = (await res.json()) as {
    data?: { teams: { nodes: { id: string; name: string }[] } };
  };
  return json.data?.teams.nodes[0] ?? null;
}
