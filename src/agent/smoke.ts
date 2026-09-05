// The smoke pass itself: which pages to re-visit, in what order, and what
// each answer means (CHE-51, CHE-132, CHE-179).
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

import type { Page } from "@cloudflare/playwright";

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
// one is a single-instance signal.
const CONSOLE_ERROR_LIMIT = 5;

export interface PageProbe {
  url: string;
  /** HTTP status of the final answer, or null when the page never answered. */
  status: number | null;
  error?: string;
  /** How many navigations it took: 1, or 2 when the first did not answer. */
  attempts: number;
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
  let consoleErrors = 0;
  let screenshotUrl: string | null = null;

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors++;
  });
  page.on("pageerror", (err: Error) => {
    if (uncaught.length < 5) uncaught.push(err.message.slice(0, 200));
  });

  const home = await probeWithRetry(page, targetUrl, HOME_TIMEOUT_MS);
  probes.push(home);
  if (home.status !== null) {
    await page.waitForTimeout(SETTLE_MS);
    if (opts.saveScreenshot) {
      try {
        screenshotUrl = await opts.saveScreenshot(page);
      } catch {
        /* the live screenshot is a nicety, never a verdict */
      }
    }
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
    probes.push(await probeWithRetry(page, url, PAGE_TIMEOUT_MS));
  }

  for (const p of probes) {
    const label = shortLabel(p.url, targetUrl);
    if (p.status === null) {
      unreached.push(p.url);
      if (coreUrls.has(p.url)) failures.push(`${label} ${describeSilence(p.error)}`);
    } else if (p.status >= 500) {
      failures.push(`${label} returned HTTP ${p.status}`);
    }
  }
  if (uncaught.length) {
    failures.push(`uncaught JS error on load — "${uncaught[0]}"`);
  }
  if (consoleErrors >= CONSOLE_ERROR_LIMIT) {
    failures.push(`${consoleErrors} console errors while loading the pages`);
  }

  return {
    probes,
    healthy: probes.length - unreached.length,
    unreached,
    skipped: ordered.length - (probes.length - 1),
    failures,
    consoleErrors,
    pageErrors: uncaught.length,
    screenshotUrl,
  };
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
      ? { url, status: null, error: "no response", attempts: 1 }
      : { url, status, attempts: 1 };
  } catch (err) {
    return {
      url,
      status: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      attempts: 1,
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
