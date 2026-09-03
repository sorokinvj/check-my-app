// Replay-first daily checks (CHE-51).
//
// A full agent run costs ~$0.53. A Daily Watch that has already been walked
// end-to-end doesn't need that every 24h — most days nothing changed. This
// module is the cheap pre-check the workflow runs first: if it comes back
// green, the run completes carrying the baseline's verdict forward and the
// LLM phases never start.
//
// WHAT THIS IS NOT: it is not a replay of the agent-written Playwright specs.
// Those are standard @playwright/test files (test.describe / expect /
// getByRole) and need the Playwright test runner — which cannot run on
// workerd. scripts/replay.ts does that job on Node, offline. Nor can we replay
// the recorded Steps: they store prose (label / attempted / observed), not
// machine-executable actions.
//
// So the honest contract is a SMOKE check, and it is labelled that way
// everywhere the owner can see it (events, bottom line, verdict page):
//   1. load the homepage in a real browser (Browser Rendering, one session),
//   2. re-visit the URLs the recorded specs navigate to — extracted statically
//      from GeneratedTest.content — plus the paths in the baseline's anatomy,
//   3. every one of them must answer below HTTP 500 and actually load,
//   4. no uncaught JS exceptions, no console-error burst.
// It proves the app is up and its known pages still serve. It proves nothing
// about whether the journeys still work — that's what a full run is for, and
// since CHE-132 a full run is forced when the page survey says the app
// changed, not on a weekly calendar.
//
// Bias on every uncertainty: fall through to the full run. A false alarm costs
// $0.53; a missed regression costs the owner's trust.

import type { Browser, Page } from "@cloudflare/playwright";
import type { Verdict } from "@/lib/enums";
import type { AppAnatomy } from "@/lib/types";
import { normalizeAnatomy } from "@/lib/anatomy";
import { parseJson } from "@/lib/json";
import { agentContextOptions, applyNameShim, launchAgentBrowser } from "./browser";
import { putScreenshot, type AgentEnv } from "./env";
import { fullRunGate, gateInputFrom, smokeTargetsFromSnapshot, type SurveyOutcome } from "./snapshot";

// Browser-time only — no tokens are spent on a smoke pass. Recorded so a run's
// cost column is never a lie by omission and the ledger still sums correctly.
export const SMOKE_COST_USD = 0.01;

// The fuse (CHE-132). Until 2026-09-03 this was the calendar: once the last
// real walk was this old, the next watch run was a full one no matter how
// healthy the pages looked. The owner's decision is that a full walk happens
// when the app CHANGED, and the page survey (survey.ts / snapshot.ts) now
// answers that from a plain fetch — so this bound applies only when two
// snapshots cannot be compared: the first snapshot of an app, a blocked
// homepage, a survey that errored. Still shared with the partial mode
// (CHE-57), which carries journeys forward off the same evidence and must
// expire on the same clock — one drift bound for the whole ladder, not two
// that can disagree.
export const FULL_RUN_MAX_AGE_DAYS = 7;
// How far back to look for that last real walk. Comfortably more than
// FULL_RUN_MAX_AGE_DAYS of daily runs, so the search never ends early on a
// watch that is behaving normally.
const FULL_RUN_LOOKBACK = 12;

// A verdict we're willing to carry forward without re-walking. Anything worse
// means the owner is waiting on a fix confirmation, and "the pages still load"
// is not that. "unverified" is excluded too — a baseline that verified nothing
// is not a baseline.
const REPLAYABLE_VERDICTS: Verdict[] = ["all_good", "mostly_ok"];

// Time budget. The survey (CHE-132) hands the smoke pass every page it saw
// serve, so the cap is by pages AND by wall clock: the ladder was six pages
// at ~20 s worst case, and thirty pages at that worst case would move the
// verdict email, which the owner ruled out. Probing stops when the budget is
// spent; the pages left over are counted, never claimed healthy.
const MAX_SMOKE_PAGES = 30;
const PROBE_BUDGET_MS = 90_000;
const HOME_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 20_000;
// Let the homepage's JS actually run before we judge its console.
const SETTLE_MS = 1_500;
// Production apps log the odd console error (blocked analytics, a 404 asset).
// A burst is different, and an *uncaught* exception is different again — that
// one is a single-instance signal.
const CONSOLE_ERROR_LIMIT = 5;

export interface SmokeRun {
  id: string;
  appSlug: string;
  targetUrl: string;
  watchId: string | null;
  baselineRunId: string | null;
}

export interface PageProbe {
  url: string;
  status: number | null;
  error?: string;
}

/** The smoke check wasn't attempted; the caller runs the full agent check. */
export interface SmokeSkipped {
  taken: false;
  reason: string;
}

/** The smoke check ran. `ok` decides whether the full phases are skipped. */
export interface SmokeReport {
  taken: true;
  ok: boolean;
  /** Baseline verdict, carried onto this run when ok. */
  verdict: Verdict;
  /** Run the verdict came from (the watch's previous run). */
  baselineRunNumber: number;
  /** Run that last actually walked this app — what "nothing changed since" means. */
  fullRunNumber: number;
  /** Lens/anatomy JSON copied from that full run so the verdict page still describes the app. */
  appLens: string | null;
  anatomy: string | null;
  probes: PageProbe[];
  /** Known pages left unvisited because the probe budget ran out (CHE-132). */
  skipped: number;
  failures: string[];
  consoleErrors: number;
  pageErrors: number;
  screenshotUrl: string | null;
}

export type SmokeResult = SmokeSkipped | SmokeReport;

// ─── Decision + execution ────────────────────────────────────────────────────

export async function smokeReplay(
  env: AgentEnv,
  run: SmokeRun,
  survey?: SurveyOutcome | null,
  now: Date = new Date(),
): Promise<SmokeResult> {
  if (!run.watchId) return { taken: false, reason: "one-off check — nothing to replay against" };
  if (!run.baselineRunId) {
    return { taken: false, reason: "first run of this watch — no baseline to replay against" };
  }

  const baseline = await env.db.run.findUnique({
    where: { id: run.baselineRunId },
    select: { runNumber: true, status: true, verdict: true },
  });
  if (!baseline || baseline.status !== "completed") {
    return { taken: false, reason: "the previous run didn't complete" };
  }
  const verdict = baseline.verdict as Verdict | null;
  if (!verdict || !REPLAYABLE_VERDICTS.includes(verdict)) {
    return {
      taken: false,
      reason: `last verdict was "${verdict ?? "none"}" — that needs a real check, not a smoke test`,
    };
  }

  const full = await findLastWalkedRun(env, run.watchId);
  if (!full?.completedAt) {
    return { taken: false, reason: "no recent full agent check to carry forward" };
  }
  // CHE-132: the survey decides. A changed app gets a full walk whatever its
  // age; an unchanged one never gets one for age alone; with no comparison
  // the seven-day fuse holds as it always did.
  const ageDays = (now.getTime() - full.completedAt.getTime()) / 86_400_000;
  const gate = fullRunGate(gateInputFrom(survey, ageDays, FULL_RUN_MAX_AGE_DAYS));
  if (gate.force) return { taken: false, reason: gate.reason };

  // "Specs missing → full run": with nothing recorded there is nothing to
  // re-visit, and a homepage-only smoke pass would be worth less than its
  // reassurance.
  const specs = await env.db.generatedTest.findMany({
    where: { appSlug: run.appSlug },
    orderBy: [{ title: "asc" }, { version: "desc" }],
    distinct: ["title"],
    select: { content: true },
  });
  if (specs.length === 0) {
    return { taken: false, reason: "no recorded specs for this app yet" };
  }

  // Specs and anatomy say where the journeys went; the survey says what else
  // serves. Union, deduped, specs first so the pages a journey depends on are
  // probed before the budget can run out.
  const targets = [
    ...new Set([
      ...smokeTargets(
        run.targetUrl,
        specs.map((s) => s.content),
        normalizeAnatomy(parseJson<unknown>(full.anatomy)),
      ),
      ...smokeTargetsFromSnapshot(survey?.snapshot, run.targetUrl),
    ]),
  ].slice(0, MAX_SMOKE_PAGES);
  // Specs that navigate nowhere we can pin down (and an anatomy we couldn't
  // read paths out of) leave only the homepage. Same reasoning as no specs at
  // all: "the front door opens" is not enough to skip a day's check on.
  if (targets.length === 0) {
    return { taken: false, reason: "nothing beyond the homepage to re-check" };
  }

  const outcome = await probePages(env, run.targetUrl, targets);
  return {
    taken: true,
    ok: outcome.failures.length === 0,
    verdict,
    baselineRunNumber: baseline.runNumber,
    fullRunNumber: full.runNumber,
    appLens: full.appLens,
    anatomy: full.anatomy,
    ...outcome,
  };
}

// ─── "When did anyone last actually walk this app?" ──────────────────────────

export interface WalkedRun {
  id: string;
  runNumber: number;
  completedAt: Date | null;
  appLens: string | null;
  anatomy: string | null;
}

// The verdict chain runs through smoke passes, so "the previous run" is not
// necessarily the last time anyone walked this app. Journeys are the tell: a
// smoke run writes none. Walked backwards with a count() per candidate rather
// than a `journeys: { some: {} }` relation filter — every query shape here is one
// this codebase already runs in production. The window is generous
// (FULL_RUN_MAX_AGE_DAYS of daily runs fits inside it) and running off the end
// just means a full run, which is the safe direction.
//
// Both cheap modes hang off this: smoke carries its verdict forward, partial
// (CHE-57) carries its healthy journeys forward.
export async function findLastWalkedRun(
  env: AgentEnv,
  watchId: string,
): Promise<WalkedRun | null> {
  const recent = await env.db.run.findMany({
    where: { watchId, status: "completed" },
    orderBy: { completedAt: "desc" },
    take: FULL_RUN_LOOKBACK,
    select: { id: true, runNumber: true, completedAt: true, appLens: true, anatomy: true },
  });
  for (const candidate of recent) {
    if ((await env.db.journey.count({ where: { runId: candidate.id } })) > 0) {
      return candidate;
    }
  }
  return null;
}

// ─── Target extraction ───────────────────────────────────────────────────────
// The recorded specs are the best record we have of where the journeys go:
// their goto() calls are literal URLs, no interpretation needed. Anatomy paths
// fill in the rest of the map. Everything is rebased onto this run's origin —
// the specs run against process.env.TARGET_URL, so their hardcoded fallback
// host is meaningless.

const GOTO_PATTERNS: RegExp[] = [
  // goto('/check') · goto("https://app.example/check")
  /\.goto\(\s*['"]([^'"]+)['"]/g,
  // goto(BASE_URL + '/check')
  /\.goto\(\s*[A-Za-z_$][\w$]*\s*\+\s*['"]([^'"]+)['"]/g,
  // goto(`${BASE_URL}/check`)
  /\.goto\(\s*`\$\{[A-Za-z_$][\w$]*\}([^`]*)`/g,
];

export function smokeTargets(
  targetUrl: string,
  specs: string[],
  anatomy: AppAnatomy | null,
): string[] {
  let origin: string;
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    return [];
  }

  const out = new Set<string>();
  const home = new URL(targetUrl).toString();
  for (const spec of specs) {
    for (const pattern of GOTO_PATTERNS) {
      // Each RegExp is module-level and /g, so reset lastIndex per use.
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(spec)) !== null) {
        const url = rebase(m[1], origin);
        if (url && url !== home) out.add(url);
      }
    }
  }
  for (const entry of anatomy?.pages ?? []) {
    const path = anatomyPath(entry);
    if (!path) continue;
    const url = rebase(path, origin);
    if (url && url !== home) out.add(url);
  }
  return [...out].slice(0, MAX_SMOKE_PAGES);
}

// Anatomy pages are LLM-written labels, not URLs. The shapes actually stored
// (checked against real runs): "/tutorials/mirror-mode", "/login  (Log In
// page)", and "/ login  (Log In page)" — a path, optionally followed by a
// description, occasionally with a stray space inside the path itself. Take the
// leading token, drop the description, and discard anything still ambiguous
// rather than repairing it: probing an invented URL would pad "N pages healthy"
// with a page that never existed.
function anatomyPath(entry: string): string | null {
  const path = entry.split(/\s{2,}|\s+\(/)[0].trim();
  return /^\/\S*$/.test(path) ? path : null;
}

// Any literal → an absolute URL on the target's origin, or null if it isn't a
// plain http(s) path we can safely visit.
function rebase(raw: string, origin: string): string | null {
  const trimmed = raw.trim();
  // An unresolved template expression ("/app/${id}") isn't a real URL.
  if (!trimmed || trimmed.includes("${") || /\s/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed, origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return new URL(parsed.pathname + parsed.search, origin).toString();
  } catch {
    return null;
  }
}

// ─── The browser pass ────────────────────────────────────────────────────────

interface ProbeOutcome {
  probes: PageProbe[];
  skipped: number;
  failures: string[];
  consoleErrors: number;
  pageErrors: number;
  screenshotUrl: string | null;
}

async function probePages(
  env: AgentEnv,
  targetUrl: string,
  targets: string[],
): Promise<ProbeOutcome> {
  const probes: PageProbe[] = [];
  const failures: string[] = [];
  const uncaught: string[] = [];
  let consoleErrors = 0;
  let screenshotUrl: string | null = null;

  const browser: Browser = await launchAgentBrowser(env);
  const context = await browser.newContext(agentContextOptions(browser));
  try {
    const page: Page = await context.newPage();
    await applyNameShim(page);
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors++;
    });
    page.on("pageerror", (err: Error) => {
      if (uncaught.length < 5) uncaught.push(err.message.slice(0, 200));
    });

    const home = await probe(page, targetUrl, HOME_TIMEOUT_MS);
    probes.push(home);
    if (!home.error) {
      await page.waitForTimeout(SETTLE_MS);
      try {
        screenshotUrl = (await putScreenshot(env, await page.screenshot({ fullPage: false })))
          .storageUrl;
      } catch {
        /* the live screenshot is a nicety, never a verdict */
      }
    }

    // The budget is wall clock from the first navigation. A page that is not
    // probed is not counted anywhere but `skipped` — "N pages healthy" names
    // only pages actually visited.
    const startedAt = Date.now();
    for (const url of targets) {
      if (Date.now() - startedAt >= PROBE_BUDGET_MS) break;
      probes.push(await probe(page, url, PAGE_TIMEOUT_MS));
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  for (const p of probes) {
    const label = shortLabel(p.url, targetUrl);
    if (p.error) failures.push(`${label} didn't load (${p.error})`);
    else if (p.status === null) failures.push(`${label} returned no response`);
    else if (p.status >= 500) failures.push(`${label} returned HTTP ${p.status}`);
  }
  if (uncaught.length) {
    failures.push(`uncaught JS error on load — "${uncaught[0]}"`);
  }
  if (consoleErrors >= CONSOLE_ERROR_LIMIT) {
    failures.push(`${consoleErrors} console errors while loading the pages`);
  }

  return {
    probes,
    skipped: targets.length - (probes.length - 1),
    failures,
    consoleErrors,
    pageErrors: uncaught.length,
    screenshotUrl,
  };
}

async function probe(page: Page, url: string, timeout: number): Promise<PageProbe> {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    return { url, status: res?.status() ?? null };
  } catch (err) {
    return { url, status: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
  }
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
