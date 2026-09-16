// Which PostHog account a token belongs to (CHE-236).
//
// OAuth hands us a token and says nothing about where the data behind it
// lives: `oauth.posthog.com` routes US/EU transparently for the handshake, but
// the API itself is per-region, and the token response carries no region field.
// The discovery document names one (`posthog_base_url`), but it is answering
// "where did THIS request land", not "where is this customer's data" — our
// worker's geography is not the customer's.
//
// So we ask instead of assuming: the hinted region first, then the other. The
// region that answers is the region, and it is written down, so every later
// read goes straight there. Two requests once, at connect time.
//
// This also answers a second question, which is why it runs before the row is
// stored: can this token read anything at all? A connection whose dashboard
// says "Connected" over a token that reads nothing is the CHE-269 shape again —
// silent until someone wonders why the numbers never arrived.
//
// No Next imports: this compiles into the agent worker too.

export interface PostHogRegion {
  region: "us" | "eu";
  baseUrl: string;
}

export const POSTHOG_REGIONS: readonly PostHogRegion[] = [
  { region: "us", baseUrl: "https://us.posthog.com" },
  { region: "eu", baseUrl: "https://eu.posthog.com" },
];

/** The regions to try, hinted region first. Always both, never fewer. */
export function probeOrder(hint?: string | null): readonly PostHogRegion[] {
  const first = POSTHOG_REGIONS.find((r) => hint === r.region || hint === r.baseUrl);
  if (!first) return POSTHOG_REGIONS;
  return [first, ...POSTHOG_REGIONS.filter((r) => r !== first)];
}

export interface PostHogAccount {
  region: "us" | "eu";
  baseUrl: string;
  organizationId: string;
  organizationName: string;
}

/**
 * The organisation this token belongs to, and the region it lives in.
 *
 * Throws when no region answers. That is deliberate: the caller is the connect
 * flow, and a token that cannot name its own organisation is not a connection
 * worth storing.
 */
export async function findAccount(
  token: string,
  args: { hint?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<PostHogAccount> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const refusals: string[] = [];

  for (const { region, baseUrl } of probeOrder(args.hint)) {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/api/organizations/@current/`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (err) {
      refusals.push(`${region}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // 401 means "not this region's token" as surely as it means "bad token" —
    // the next region decides which.
    if (res.status === 401 || res.status === 404) {
      refusals.push(`${region}: HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) {
      refusals.push(`${region}: HTTP ${res.status}`);
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      refusals.push(`${region}: no organisation in the response`);
      continue;
    }
    return {
      region,
      baseUrl,
      organizationId: body.id,
      // A nameless organisation is possible; the id is the identity, the name
      // is the label, and the dashboard needs something to print.
      organizationName: typeof body.name === "string" && body.name.trim() ? body.name.trim() : body.id,
    };
  }

  throw new Error(`no PostHog region accepted the token (${refusals.join("; ") || "no attempts"})`);
}
