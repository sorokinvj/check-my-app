// Which PostHog project holds this app's data (CHE-237).
//
// One PostHog account holds several projects; one CheckMyApp team watches
// several apps. Nobody can answer "which is which" but the owner — so we ask
// once, store it, and never ask again. Everything here exists to make that one
// question as short as possible.
//
// **Why the suggestion is not built on `app_urls`.** The ticket proposed
// offering "the project whose app URL matches the app we are watching" first.
// That field exists — and on the owner's own PostHog organisation, checked on
// 2026-09-16, it is empty on every project that could be read. It is a settings
// field almost nobody fills in, so a default built on it is code that looks
// helpful and never fires, which is worse than no default at all.
//
// So the suggestion is built on what the project has actually **received**: the
// distinct `$host` values in its recent events. On the same organisation, that
// query returned `checkmyapp.dev` (68 events) for the project actually holding
// checkmyapp.dev's data. Configuration can lie about intent; ingested events
// are what happened.
//
// No Next imports: this compiles into the agent worker too.

/** How far back to look for hosts. Long enough for a quiet app, short enough to
 *  forget a domain the owner has since abandoned. */
const HOST_WINDOW_DAYS = 30;
/** Hosts are for ranking, not for display — a handful is plenty. */
const HOST_LIMIT = 10;
/** A picker nobody asked for must not cost a query per project on a big
 *  account. Beyond this we list projects and offer no suggestion, which is the
 *  honest degradation: fewer promises, same answer available. */
export const MAX_PROJECTS_TO_PROBE = 12;

export interface PostHogProject {
  /** PostHog's numeric project id, as a string — it is an identifier, not a
   *  quantity, and it goes into a TEXT column. */
  id: string;
  name: string;
}

interface RawProject {
  id?: unknown;
  name?: unknown;
}

/**
 * The projects this token can see.
 *
 * `GET /api/organizations/@current/projects/` returns `{count, results}` with
 * `id` and `name` on each row — verified against the live API on 2026-09-16.
 * Note what it does NOT return: `app_urls`. That only appears on a single
 * project's detail, which is why the suggestion does not depend on it.
 */
export async function listProjects(
  args: { token: string; baseUrl: string; fetchImpl?: typeof fetch },
): Promise<PostHogProject[]> {
  const res = await (args.fetchImpl ?? fetch)(
    `${args.baseUrl.replace(/\/+$/, "")}/api/organizations/@current/projects/`,
    { headers: { authorization: `Bearer ${args.token}`, accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`PostHog projects ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as { results?: unknown };
  const rows = Array.isArray(body.results) ? (body.results as RawProject[]) : [];
  return rows
    .filter((p) => p.id !== undefined && p.id !== null)
    .map((p) => ({
      id: String(p.id),
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : `Project ${String(p.id)}`,
    }));
}

/**
 * The hosts a project has actually received events from, most active first.
 *
 * Returns an empty list rather than throwing: a project we cannot read is a
 * project we cannot suggest, which is a worse suggestion, not a failure of the
 * picker. The owner can still choose it by name.
 */
export async function hostsSeenBy(
  args: { token: string; baseUrl: string; projectId: string; fetchImpl?: typeof fetch },
): Promise<string[]> {
  const query = `SELECT properties.$host AS host, count() AS n FROM events`
    + ` WHERE timestamp > now() - INTERVAL ${HOST_WINDOW_DAYS} DAY AND properties.$host IS NOT NULL`
    + ` GROUP BY host ORDER BY n DESC LIMIT ${HOST_LIMIT}`;
  try {
    const res = await (args.fetchImpl ?? fetch)(
      `${args.baseUrl.replace(/\/+$/, "")}/api/projects/${encodeURIComponent(args.projectId)}/query/`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${args.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      },
    );
    if (!res.ok) return [];
    const body = (await res.json().catch(() => ({}))) as { results?: unknown };
    if (!Array.isArray(body.results)) return [];
    return (body.results as unknown[])
      .map((row) => (Array.isArray(row) && typeof row[0] === "string" ? row[0] : null))
      .filter((h): h is string => Boolean(h));
  } catch {
    return [];
  }
}

/** The bare host of a URL, lowercased, `www.` dropped, port kept off. */
export function hostOf(url: string): string | null {
  try {
    const h = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
    return h.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Registrable-ish suffix: the last two labels. Good enough to tell
 *  `app.example.com` and `example.com` apart from `example.org`. */
function baseDomain(host: string): string {
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

export type MatchStrength = "exact" | "same-domain" | "none";

/**
 * How well a project's observed hosts match the app we are watching.
 *
 * Deliberately strict about what counts as a match, because a wrong suggestion
 * accepted without reading is worse than no suggestion: it silently attributes
 * one product's numbers to another. `localhost` never matches anything — a
 * developer's machine is in almost every project's event stream and would make
 * every project look like every app's.
 */
export function matchStrength(appHost: string | null, projectHosts: readonly string[]): MatchStrength {
  if (!appHost) return "none";
  const target = appHost.toLowerCase().replace(/^www\./, "");
  if (isLocal(target)) return "none";

  const seen = projectHosts
    .map((h) => h.toLowerCase().replace(/^www\./, "").split(":")[0])
    .filter((h) => h && !isLocal(h));

  if (seen.includes(target)) return "exact";
  if (seen.some((h) => baseDomain(h) === baseDomain(target))) return "same-domain";
  return "none";
}

function isLocal(host: string): boolean {
  return (
    host === "localhost" ||
    host.startsWith("localhost:") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local")
  );
}

export interface RankedProject extends PostHogProject {
  match: MatchStrength;
  /** The observed host that earned the match, for the screen to show its work. */
  matchedHost: string | null;
}

/**
 * Projects ordered for a picker: the best match first, then by name.
 *
 * Pure, so scripts/verify-posthog-projects.ts can hold it to its rules without
 * a network. Ordering is stable — two projects with equal standing keep
 * alphabetical order rather than whatever the API returned, so the list does
 * not reshuffle between visits.
 */
export function rankProjects(
  appUrl: string,
  projects: readonly PostHogProject[],
  hostsByProject: Readonly<Record<string, readonly string[]>>,
): RankedProject[] {
  const appHost = hostOf(appUrl);
  const rank: Record<MatchStrength, number> = { exact: 0, "same-domain": 1, none: 2 };

  return projects
    .map((p) => {
      const hosts = hostsByProject[p.id] ?? [];
      const match = matchStrength(appHost, hosts);
      const normalized = (h: string) => h.toLowerCase().replace(/^www\./, "").split(":")[0];
      const matchedHost =
        match === "none"
          ? null
          : (hosts.find((h) =>
              match === "exact"
                ? normalized(h) === appHost
                : baseDomain(normalized(h)) === baseDomain(appHost ?? ""),
            ) ?? null);
      return { ...p, match, matchedHost };
    })
    .sort((a, b) => rank[a.match] - rank[b.match] || a.name.localeCompare(b.name));
}

/**
 * The one project we would offer first, or null when nothing earns it.
 *
 * Null is a real answer and the screen must render it as "pick one" rather than
 * preselecting a guess. An ambiguous match — two projects both claiming the
 * same host — is also null: two projects that both saw this host is exactly the
 * case where we do not know, and quietly picking the first is how one product's
 * numbers end up on another's page.
 */
export function suggestedProject(ranked: readonly RankedProject[]): RankedProject | null {
  const best = ranked[0];
  if (!best || best.match === "none") return null;
  const equallyGood = ranked.filter((p) => p.match === best.match);
  return equallyGood.length === 1 ? best : null;
}
