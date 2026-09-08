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
// CHE-212: neither must OUR OWN pages. The first version of this attached the
// header to the whole browser context (extraHTTPHeaders), so it rode on every
// subresource, including the Clerk bundle on clerk.checkmyapp.dev — a custom
// header makes that script request non-simple, the browser must preflight it,
// the bundle URL answers 307, a preflight may not be redirected, Clerk never
// loads, the sign-in page renders empty. Run #156 published that as "Sign-in
// page renders blank", severity high, and emailed the owner: rule 8, a claim
// resting on our own state. The announcement now goes only on the requests the
// web half actually inspects, and only where a custom header cannot cause a
// preflight (see shouldAnnounceSelfCheck).
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

// The methods the web half's read-only guard looks at — the same four the
// refusal shape below matches. A GET or HEAD is never guarded, so a page, a
// script, a stylesheet, an image or a font never needs the announcement.
const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function hostKey(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// One request the checker's browser is about to make. `initiatorUrl` is the URL
// of the frame that started it (Playwright's request.frame().url()), or null
// when that is unknowable — a service worker, a detached frame.
export interface SelfCheckRequest {
  url: string;
  method: string;
  initiatorUrl?: string | null;
}

// Does THIS request carry the announcement? Four conditions, all necessary:
//
//   1. the run's target is one of our hosts — a customer's app never sees it;
//   2. the request goes to the target's own host, exactly. Subdomains are ours
//      (isSelfHost still says so, and the click gate and 403 reading depend on
//      that) but they are a different origin, and Clerk lives on one: CHE-212;
//   3. the method is one the web half guards. Every subresource a visitor
//      loads is a GET, so a document, script, style, image or font goes out
//      byte-identical to a visitor's;
//   4. the request is same-origin with the frame that made it. A custom header
//      can only force a CORS preflight on a CROSS-origin request; refusing to
//      add one there is what makes "the checker never changes how the product
//      loads" a property of the code rather than a hope. Unknown initiator is
//      treated as cross-origin: losing an announcement costs a 403 we could
//      have read, adding a preflight costs the customer a false verdict.
export function shouldAnnounceSelfCheck(
  targetUrl: string,
  request: SelfCheckRequest,
  extra?: string,
): boolean {
  if (!isSelfUrl(targetUrl, extra)) return false;
  if (!MUTATING_METHODS.has(request.method.trim().toUpperCase())) return false;

  let target: URL;
  let requested: URL;
  try {
    target = new URL(targetUrl);
    requested = new URL(request.url);
  } catch {
    return false;
  }
  if (hostKey(requested.hostname) !== hostKey(target.hostname)) return false;

  const initiator = request.initiatorUrl ? originOf(request.initiatorUrl) : null;
  return initiator !== null && initiator === requested.origin;
}

// The header map for a request that must carry the announcement, or undefined.
// Kept pure so the verify script can prove the whole rule — customer host, our
// subdomain, a CDN, a document GET, a mutating API call — without Playwright.
export function selfCheckRequestHeaders(
  targetUrl: string,
  request: SelfCheckRequest,
  extra?: string,
): Record<string, string> | undefined {
  return shouldAnnounceSelfCheck(targetUrl, request, extra)
    ? { [SELF_CHECK_HEADER]: SELF_CHECK_HEADER_VALUE }
    : undefined;
}

// ─── Attaching it: routing, not context headers (CHE-212) ────────────────────
//
// Playwright's shapes, declared structurally so this module still loads on
// plain Node (the verify script drives the real handler with a stub context;
// browser.ts hands it a real BrowserContext).
export interface SelfCheckRoutedRequest {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  frame(): { url(): string };
}
export interface SelfCheckRoute {
  request(): SelfCheckRoutedRequest;
  continue(options?: { headers?: Record<string, string> }): Promise<void>;
}
export interface SelfCheckRoutable {
  route(
    matcher: (url: URL) => boolean,
    handler: (route: SelfCheckRoute) => Promise<void>,
  ): Promise<void>;
}

// Installs the announcement on a context. Nothing is intercepted at all unless
// the run targets one of our hosts, and even then the matcher lets only the
// target's own host through — a subdomain (clerk.), a CDN, a font provider is
// never routed, so those requests cannot differ from a visitor's by so much as
// a header order. Inside the handler the decision is shouldAnnounceSelfCheck's
// alone, and whatever happens the request continues.
export async function announceSelfCheckOn(
  context: SelfCheckRoutable,
  targetUrl: string,
  extraHosts?: string,
): Promise<void> {
  if (!isSelfUrl(targetUrl, extraHosts)) return;
  let targetHost: string;
  try {
    targetHost = hostKey(new URL(targetUrl).hostname);
  } catch {
    return;
  }

  await context.route(
    (url: URL) => hostKey(url.hostname) === targetHost,
    async (route) => {
      try {
        const request = route.request();
        let initiatorUrl: string | null = null;
        try {
          initiatorUrl = request.frame().url();
        } catch {
          /* a service worker or a detached frame: treated as cross-origin */
        }
        const extra = selfCheckRequestHeaders(
          targetUrl,
          { url: request.url(), method: request.method(), initiatorUrl },
          extraHosts,
        );
        if (extra) {
          await route.continue({ headers: { ...request.headers(), ...extra } });
          return;
        }
      } catch {
        /* our own bookkeeping never fails a request */
      }
      await route.continue().catch(() => {});
    },
  );
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
