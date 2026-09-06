// CHE-193: which hosts are OURS, and how the checker announces itself to them.
//
// The daily self-check of checkmyapp.dev (run #146, 2026-09-05 15:30 UTC)
// walked "Enable monitoring and re-check an app", pressed "Re-check now" on the
// PUBLIC verdict page of a stranger's app (theins.ru, run #143) and created two
// real runs (#147, #148 — the second from a different egress IP); the journey
// "Review a verdict report" pressed "Looks right ✓" and PATCHed a lens onto a
// verdict nobody asked it to grade. CLAUDE.md rule 6 says a self-check cleans
// up after itself; this one had nothing to clean because the damage was on
// other people's records. CHE-89 and CHE-98 were the same class (a placeholder
// app checked daily, a paused watch resumed by the agent).
//
// Two halves, one contract:
//   - the web app, when a request carries the header below: every mutating
//     API route answers HTTP 403, content-type application/json, body
//     {"error":"Self-checks are read-only.","code":"self_check_read_only"};
//     a server action (form POST) redirects back with `?self_check=read_only`
//     in the URL. GET is never affected.
//   - the agent (this module) sends that header to OUR hosts and to nobody
//     else, and reads either answer as "not available to this account", never
//     as a defect of the product. The network log carries only
//     "METHOD url → status", so the 403 is classified by shape (a mutating
//     request to a self host → 403); the `code` field is the contract to
//     check wherever a body is available.
// A customer's app must never receive the header: an unexpected custom header
// changes CORS/preflight behaviour, and their product was not built to see it.
//
// Pure: no Playwright, no bindings, so the verify script runs it on plain Node.

export const SELF_CHECK_HEADER = "x-checkmyapp-checker";
export const SELF_CHECK_HEADER_VALUE = "1";
// The JSON `code` a refused API answers with, and the query parameter a refused
// server action redirects back with.
export const SELF_CHECK_READ_ONLY_CODE = "self_check_read_only";
export const SELF_CHECK_REDIRECT_PARAM = "self_check";
export const SELF_CHECK_REDIRECT_VALUE = "read_only";

// Production. Subdomains are ours too (www., clerk. — Clerk's frontend API
// lives under our zone). Dev/staging hosts come from the SELF_CHECK_HOSTS
// binding, comma-separated, so a preview deploy can be self-checked without a
// code change.
export const DEFAULT_SELF_HOSTS: readonly string[] = ["checkmyapp.dev"];

function parseHosts(extra?: string): string[] {
  if (!extra) return [];
  return extra
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

// True for a listed host and for any subdomain of it. Suffix matching is on a
// dot boundary on purpose: evil-checkmyapp.dev is not ours, and neither is
// checkmyapp.dev.example.com.
export function isSelfHost(hostname: string, extra?: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  for (const own of [...DEFAULT_SELF_HOSTS, ...parseHosts(extra)]) {
    if (host === own || host.endsWith(`.${own}`)) return true;
  }
  return false;
}

// The same test for an origin or a full URL; anything unparsable is not ours.
export function isSelfUrl(url: string, extra?: string): boolean {
  try {
    return isSelfHost(new URL(url).hostname, extra);
  } catch {
    return false;
  }
}

// The extra request headers for a browser context whose run targets `targetUrl`:
// the announcement when the target is ours, nothing at all otherwise. Kept as a
// pure function so the verify script can prove "customer host → no header"
// without loading Playwright.
export function selfCheckHeaders(targetUrl: string, extra?: string): Record<string, string> | undefined {
  return isSelfUrl(targetUrl, extra) ? { [SELF_CHECK_HEADER]: SELF_CHECK_HEADER_VALUE } : undefined;
}

// A network-log line ("METHOD url → status") that is our own read-only guard
// answering: a mutating request to one of our hosts, refused with 403. Only
// that shape — a GET 403 is access control on a page, and a 403 on a customer's
// host is whatever the existing rules say it is. Returns the line, or null.
const MUTATING_403 = /^(POST|PATCH|PUT|DELETE)\s+(\S+)\s+→\s+403$/;

export function selfCheckRefusalIn(entries: string[], extra?: string): string | null {
  for (const line of entries) {
    const m = line.match(MUTATING_403);
    if (!m) continue;
    if (isSelfUrl(m[2], extra)) return line;
  }
  return null;
}

// A URL on one of our hosts that a refused server action redirected back to:
// `?self_check=read_only` is the web half's answer to a form POST the
// self-check made. The same parameter on a customer's host means nothing.
export function isSelfCheckRedirect(url: string, extra?: string): boolean {
  if (!isSelfUrl(url, extra)) return false;
  try {
    return new URL(url).searchParams.get(SELF_CHECK_REDIRECT_PARAM) === SELF_CHECK_REDIRECT_VALUE;
  } catch {
    return false;
  }
}
