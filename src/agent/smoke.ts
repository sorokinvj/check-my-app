// The smoke pass itself: which pages to re-visit, in what order, and what
// each answer means (CHE-51, CHE-132, CHE-179, CHE-187).
//
// Split out of replay.ts because this half has to run against a stub page:
// replay.ts launches Browser Rendering, and the rule that decides whether a
// day costs $0.01 or $0.61 must be checked by scripts/verify-smoke-gate.ts,
// not by waiting for the next tick.
//
// CHE-179, 2026-09-04 — the first day CHE-132 handed the smoke pass every
// page the survey had seen, all three watched apps went full instead of
// smoke: one page each did not answer within 20 s (checkmyapp.dev /sign-in,
// joblander.app a tutorial, meetbashar.com a learn page) and the pass called
// that "trouble". ≈ +$0.6–0.75 per app per day, the opposite of the program.
// CLAUDE.md rule 3: silence is not evidence. A page that does not answer in
// time is `unreached` — retried once with a longer timeout, listed, never
// counted as healthy, and a failure only when the page is one the journeys
// depend on (the homepage and the `core` set). An HTTP 5xx, an uncaught JS
// error and a console burst are positive evidence and stay failures anywhere.
//
// CHE-187, 2026-09-06 — the console class of the same regression. Run #153
// on joblander.app: "75 console errors while loading the pages — running the
// full check". The limit of five was written when the pass visited at most
// six pages (CHE-51) and was a total across all of them; since CHE-132 the
// pass visits up to thirty, and a production site that logs two or three
// errors per page (blocked analytics, a missing asset, a CSP report) trips a
// total limit every day. Now the count is per page — a burst is one page
// logging five — and messages our own environment causes (a blocked tracker,
// an aborted navigation, a third party's 4xx) are recorded but never counted.

import type { ConsoleMessage, Page } from "@cloudflare/playwright";

// Time budget. The survey (CHE-132) hands the smoke pass every page it saw
// serve, so the cap is by pages AND by wall clock: the ladder was six pages
// at ~20 s worst case, and thirty pages at that worst case would move the
// verdict email, which the owner ruled out. Probing stops when the budget is
// spent; the pages left over are counted, never claimed healthy.
export const MAX_SMOKE_PAGES = 30;
export const PROBE_BUDGET_MS = 90_000;
// The pre-CHE-132 cap: homepage + up to six pages from the recorded specs and
// the anatomy. Those are the pages a journey depends on, so a silence there
// is worth a full run; a silence on a page the survey merely saw is not.
export const CORE_SMOKE_PAGES = 6;
export const HOME_TIMEOUT_MS = 30_000;
export const PAGE_TIMEOUT_MS = 20_000;
// One retry for a page that did not answer, with room to spare: a cold
// function or a slow origin answers in 30 s far more often than it is down.
export const RETRY_TIMEOUT_MS = 30_000;
// Let the homepage's JS actually run before we judge its console.
const SETTLE_MS = 1_500;
// Production apps log the odd console error (blocked analytics, a 404 asset).
// A burst is different, and an *uncaught* exception is different again — that
// one is a single-instance signal. The limit is per page (CHE-187): it was a
// run-wide total when the pass visited six pages, and thirty pages at two or
// three errors each is a chatty site, not a broken one.
export const CONSOLE_ERROR_LIMIT = 5;

/**
 * Console errors that say nothing about the customer's product (CHE-187).
 * Each is either caused by the checker's own environment or belongs to a
 * third party the owner cannot fix from their page. They are recorded on the
 * probe for diagnosis and never counted toward the burst limit. One list, so
 * the next phrasing goes here and not into a prompt or a second filter.
 */
export const IGNORED_CONSOLE_ERRORS: ReadonlyArray<{
  why: string;
  matches: (text: string, url: string, targetOrigin: string) => boolean;
}> = [
  {
    // Ours: the checker's browser blocks trackers; a real user's may not.
    why: "request blocked by the checker's browser",
    matches: (text, url) => /ERR_BLOCKED_BY_CLIENT/i.test(`${text} ${url}`),
  },
  {
    // Ours: the pass navigates away before the previous page's requests
    // finish, and the browser reports each one as aborted.
    why: "request aborted by the pass navigating on",
    matches: (text, url) => /net::ERR_ABORTED/i.test(`${text} ${url}`),
  },
  {
    // Nobody's: a missing favicon is one 404 a real user never sees.
    why: "missing favicon",
    matches: (text, url) => /favicon\.ico/i.test(`${text} ${url}`),
  },
  {
    // Nobody's: analytics, ads and error-reporting hosts fail from a
    // datacenter IP for reasons of their own (consent, geo, bot rules) and
    // the owner has no page to fix. Matched by host, so a product's own
    // "Facebook login failed" still counts.
    why: "third-party analytics, ads or error-reporting host",
    matches: (text, url) =>
      /(google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.(com|net)|hotjar\.(com|io)|posthog\.com|segment\.(io|com)|ingest(\.[a-z0-9-]+)*\.sentry\.io|intercom(cdn)?\.(com|io))/i.test(
        `${text} ${url}`,
      ),
  },
  {
    // Nobody's: a report-only CSP violation is the owner measuring a policy
    // they have not enforced. Nothing on the page is blocked by it.
    why: "Content Security Policy report-only violation",
    matches: (text) => /\[Report Only\]/i.test(text),
  },
  {
    // Nobody's: a 4xx from another origin (a CDN refusing a datacenter IP, a
    // geo-fenced font) depends on where the request comes from. The same
    // message for the product's own origin is a missing asset and counts.
    why: "HTTP 4xx from another origin",
    matches: (text, url, targetOrigin) => {
      if (!/Failed to load resource: the server responded with a status of 4\d\d/i.test(text)) return false;
      try {
        return new URL(url).origin !== targetOrigin;
      } catch {
        return false;
      }
    },
  },
];

/** True when a console error is one of IGNORED_CONSOLE_ERRORS — recorded, never counted. */
export function isIgnoredConsoleError(text: string, url: string, targetOrigin: string): boolean {
  return IGNORED_CONSOLE_ERRORS.some((rule) => rule.matches(text, url, targetOrigin));
}

export interface PageProbe {
  url: string;
  /** HTTP status of the final answer, or null when the page never answered. */
  status: number | null;
  error?: string;
  /** How many navigations it took: 1, or 2 when the first did not answer. */
  attempts: number;
  /** Console errors this page logged that count toward the burst limit (CHE-187). */
  consoleErrors: number;
  /** Console errors this page logged that match IGNORED_CONSOLE_ERRORS — kept for diagnosis. */
  ignoredConsoleErrors: number;
  /** The first counted console message, so a burst can be read without re-running. */
  consoleSample?: string;
}

/** Which pages the smoke pass re-visits, and which of them a journey depends on. */
export interface SmokeTargetSets {
  /** Spec goto URLs + anatomy paths, up to CORE_SMOKE_PAGES. A silence here is trouble. */
  core: string[];
  /** Pages the survey saw serve. A silence here is `unreached`, not trouble. */
  extra: string[];
}

export interface ProbeOutcome {
  /** One entry per page visited, the homepage first. */
  probes: PageProbe[];
  /** Pages that answered (any HTTP status) — what "N pages healthy" counts. */
  healthy: number;
  /** Pages that did not answer on either attempt. Never healthy; trouble only when core. */
  unreached: string[];
  /** Known pages left unvisited because the probe budget ran out (CHE-132). */
  skipped: number;
  failures: string[];
  /** Counted console errors across every page visited — a fact, not a rule (CHE-187). */
  consoleErrors: number;
  pageErrors: number;
  screenshotUrl: string | null;
}

/** Core = the first CORE_SMOKE_PAGES known pages; extra = the rest plus the survey's, deduped, under the cap. */
export function splitSmokeTargets(known: string[], surveyed: string[]): SmokeTargetSets {
  const core = known.slice(0, CORE_SMOKE_PAGES);
  const seen = new Set(core);
  const extra: string[] = [];
  for (const url of [...known.slice(CORE_SMOKE_PAGES), ...surveyed]) {
    if (seen.has(url)) continue;
    seen.add(url);
    extra.push(url);
  }
  return { core, extra: extra.slice(0, Math.max(0, MAX_SMOKE_PAGES - core.length)) };
}

/** The slice of a Playwright Page the probe uses — a stub can supply it. */
export type ProbePage = Pick<Page, "goto" | "on" | "waitForTimeout" | "screenshot">;

export interface ProbeOptions {
  /** Stores the homepage screenshot and returns its URL; absent in tests. */
  saveScreenshot?: (page: ProbePage) => Promise<string | null>;
  /** Injected clock for the budget; defaults to Date.now. */
  now?: () => number;
  budgetMs?: number;
}

export async function probeTargets(
  page: ProbePage,
  targetUrl: string,
  targets: SmokeTargetSets,
  opts: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const now = opts.now ?? (() => Date.now());
  const budgetMs = opts.budgetMs ?? PROBE_BUDGET_MS;
  const probes: PageProbe[] = [];
  const failures: string[] = [];
  const unreached: string[] = [];
  const uncaught: string[] = [];
  let screenshotUrl: string | null = null;
  const targetOrigin = originOf(targetUrl);

  // One listener for the whole pass; the tally it feeds is reset before each
  // navigation and copied onto that page's probe afterwards (CHE-187). What
  // the homepage logs while its JS settles lands on the homepage.
  const tally: ConsoleTally = { counted: 0, ignored: 0, sample: undefined };
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    const url = msg.location()?.url ?? "";
    if (isIgnoredConsoleError(text, url, targetOrigin)) {
      tally.ignored++;
      return;
    }
    tally.counted++;
    tally.sample ??= text.slice(0, 160);
  });
  page.on("pageerror", (err: Error) => {
    if (uncaught.length < 5) uncaught.push(err.message.slice(0, 200));
  });

  const visit = async (url: string, timeout: number): Promise<PageProbe> => {
    tally.counted = 0;
    tally.ignored = 0;
    tally.sample = undefined;
    const probe = await probeWithRetry(page, url, timeout);
    return withConsole(probe, tally);
  };

  const home = await visit(targetUrl, HOME_TIMEOUT_MS);
  if (home.status !== null) {
    await page.waitForTimeout(SETTLE_MS);
    // Re-read after the settle: the homepage's JS logs after domcontentloaded.
    probes.push(withConsole(home, tally));
    if (opts.saveScreenshot) {
      try {
        screenshotUrl = await opts.saveScreenshot(page);
      } catch {
        /* the live screenshot is a nicety, never a verdict */
      }
    }
  } else {
    probes.push(home);
  }

  // Core first, so the pages a journey depends on are probed before the
  // budget can run out; then whatever else the survey saw. The budget is wall
  // clock from the first navigation. A page that is not probed is not counted
  // anywhere but `skipped` — "N pages healthy" names only pages that answered.
  const ordered = [
    ...targets.core.map((url) => ({ url, core: true })),
    ...targets.extra.map((url) => ({ url, core: false })),
  ];
  const coreUrls = new Set([targetUrl, ...targets.core]);
  const startedAt = now();
  for (const { url } of ordered) {
    if (now() - startedAt >= budgetMs) break;
    probes.push(await visit(url, PAGE_TIMEOUT_MS));
  }

  for (const p of probes) {
    const label = shortLabel(p.url, targetUrl);
    if (p.status === null) {
      unreached.push(p.url);
      if (coreUrls.has(p.url)) failures.push(`${label} ${describeSilence(p.error)}`);
    } else if (p.status >= 500) {
      failures.push(`${label} returned HTTP ${p.status}`);
    }
    // A burst is one page logging CONSOLE_ERROR_LIMIT counted errors. The
    // run-wide total decides nothing (CHE-187) and is only spoken when it
    // did — so the failure names the page, and the ok line says nothing.
    if (p.consoleErrors >= CONSOLE_ERROR_LIMIT) {
      failures.push(`${label} logged ${p.consoleErrors} console errors`);
    }
  }
  if (uncaught.length) {
    failures.push(`uncaught JS error on load — "${uncaught[0]}"`);
  }

  return {
    probes,
    healthy: probes.length - unreached.length,
    unreached,
    skipped: ordered.length - (probes.length - 1),
    failures,
    consoleErrors: probes.reduce((n, p) => n + p.consoleErrors, 0),
    pageErrors: uncaught.length,
    screenshotUrl,
  };
}

interface ConsoleTally {
  counted: number;
  ignored: number;
  sample: string | undefined;
}

function withConsole(probe: PageProbe, tally: ConsoleTally): PageProbe {
  return {
    ...probe,
    consoleErrors: tally.counted,
    ignoredConsoleErrors: tally.ignored,
    ...(tally.sample ? { consoleSample: tally.sample } : {}),
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// A page that did not answer gets one more chance with a longer timeout. Only
// a silence is retried: an HTTP status of any kind is an answer, and asking
// twice would not change what a 500 means.
async function probeWithRetry(page: ProbePage, url: string, timeout: number): Promise<PageProbe> {
  const first = await probe(page, url, timeout);
  if (first.status !== null) return first;
  const second = await probe(page, url, RETRY_TIMEOUT_MS);
  return { ...second, attempts: 2 };
}

async function probe(page: ProbePage, url: string, timeout: number): Promise<PageProbe> {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    const status = res?.status() ?? null;
    return status === null
      ? { url, status: null, error: "no response", attempts: 1, consoleErrors: 0, ignoredConsoleErrors: 0 }
      : { url, status, attempts: 1, consoleErrors: 0, ignoredConsoleErrors: 0 };
  } catch (err) {
    return {
      url,
      status: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      attempts: 1,
      consoleErrors: 0,
      ignoredConsoleErrors: 0,
    };
  }
}

// What the owner reads about a core page that never answered. A timeout is
// the common case and is said in product terms; anything else (a DNS
// failure, a reset) keeps its reason, minus the driver's "page.goto:" prefix
// — the feed describes their page, not our tooling (CLAUDE.md rule 1).
function describeSilence(error: string | undefined): string {
  if (!error || /timeout/i.test(error)) return "did not answer in time";
  return `did not answer (${error.replace(/^page\.goto:\s*/i, "")})`;
}

/** "/pricing" for feed lines — the origin is already on screen. */
export function shortLabel(url: string, targetUrl: string): string {
  try {
    const u = new URL(url);
    if (u.origin !== new URL(targetUrl).origin) return url;
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

// ─── Feed wording ────────────────────────────────────────────────────────────
// Lives here rather than in workflow.ts so the sentence the owner reads on a
// $0.01 day is the sentence verify-smoke-gate checks. Facts about their pages
// only: what answered, what did not, and which verdict is carried forward.

export interface SmokeSummary {
  ok: boolean;
  healthy: number;
  unreached: string[];
  failures: string[];
  baselineRunNumber: number;
}

export function smokeOutcomeLine(smoke: SmokeSummary, targetUrl: string): string {
  if (!smoke.ok) return `Smoke found trouble: ${smoke.failures.join("; ")} — running the full check`;
  const n = smoke.healthy;
  const k = smoke.unreached.length;
  const silent =
    k > 0
      ? `, ${k} did not answer in time (${smoke.unreached.map((u) => shortLabel(u, targetUrl)).join(", ")})`
      : ", no uncaught errors";
  return (
    `All ${n} page${n === 1 ? "" : "s"} healthy${silent} — carrying Run ` +
    `#${smoke.baselineRunNumber}'s verdict forward and skipping the full agent check`
  );
}
