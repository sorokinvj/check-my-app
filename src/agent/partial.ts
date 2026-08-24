// Partial watch runs (CHE-57) — the middle rung of the mode ladder.
//
// A watch whose last check found trouble in two journeys out of five does not
// need the other three walked again tonight. It needs the two bad ones
// re-walked, hard, and the three good ones stated as what they are: verified
// recently, carried forward, not re-checked today.
//
// The ladder, in the order the workflow tries it:
//   1. SMOKE (replay.ts) — baseline healthy and its known pages still serve:
//      carry the whole verdict, $0.01, done.
//   2. PARTIAL (here) — baseline has both bad and good journeys: skip discovery
//      entirely, re-walk the bad ones, copy the good ones forward, synthesize
//      over the combined picture.
//   3. FULL — everything else.
//
// What partial does NOT do: it does not skip synthesis. A smoke pass can end a
// run without a verdict of its own because it re-verifies nothing; a partial run
// produces fresh evidence and must be adjudicated like any other run — verdict
// integrity guards included.
//
// Two honesty rules hold this together:
//   - Provenance is the run that ACTUALLY walked a journey. Carrying a journey
//     that was itself carried points carriedFromRunId further back, never at the
//     run we copied from — so a carry chain can never launder a two-week-old
//     walk into "checked yesterday".
//   - Carried evidence expires on the same clock as the smoke path
//     (FULL_RUN_MAX_AGE_DAYS). One stale journey sends the whole run full.
//
// Bias on every uncertainty, as in replay.ts: fall through to the full run.

import type { AgentEnv } from "./env";
import { FULL_RUN_MAX_AGE_DAYS, findLastWalkedRun } from "./replay";

// The only journey statuses worth carrying: "ok" (everything worked) and
// "partial" (everything attempted worked, some steps went unverified). Anything
// else — broken, exposed, risky, confusing, skipped — is either a problem the
// owner is waiting on or a journey that verified nothing, and both get re-walked.
const CARRIABLE_STATUSES = new Set(["ok", "partial"]);

// The re-walk proposal reuses the baseline's own step labels. Long journeys get
// clipped so the walking prompt stays a plan, not a transcript.
const MAX_PROPOSED_STEPS = 12;

/** A journey copied forward from an earlier run instead of walked again. */
export interface CarriedJourney {
  /** Journey row on the baseline run that gets copied (with its steps + evidence). */
  sourceJourneyId: string;
  /** Position in this run — baseline order, re-indexed to 0..n-1. */
  order: number;
  title: string;
  /** The run that actually walked it. Provenance root, not the run we copy from. */
  sourceRunId: string;
  sourceRunNumber: number;
}

/** A journey that was bad last time and gets walked again from its old plan. */
export interface RewalkJourney {
  order: number;
  title: string;
  /** Baseline step labels, fed to walkOneJourney as the proposed steps. */
  steps: string[];
  /** What it looked like last time — for the run feed, not for the verdict. */
  previousStatus: string;
}

export interface PartialPlan {
  taken: true;
  /** Run the journeys are copied from (the last one that actually walked). */
  baselineRunId: string;
  baselineRunNumber: number;
  /** Reused instead of re-running discovery/anatomy — same app, same map. */
  anatomy: string | null;
  carry: CarriedJourney[];
  rewalk: RewalkJourney[];
  /** Oldest real walk among the carried journeys — the weakest link we're standing on. */
  oldestVerifiedAt: string;
}

export interface PartialSkipped {
  taken: false;
  reason: string;
}

export type PartialDecision = PartialPlan | PartialSkipped;

// ─── Decision ────────────────────────────────────────────────────────────────

export async function planPartialRun(
  env: AgentEnv,
  run: { id: string; watchId: string | null },
  now: Date = new Date(),
): Promise<PartialDecision> {
  if (!run.watchId) return { taken: false, reason: "one-off check — nothing to carry forward" };

  // Deliberately the last run that WALKED, not run.baselineRunId: the baseline
  // may itself be a green smoke pass with zero journeys, and the journeys we
  // want are one run further back. Age is checked below either way.
  const baseline = await findLastWalkedRun(env, run.watchId);
  if (!baseline?.completedAt) {
    return { taken: false, reason: "no earlier walked run to build on" };
  }
  const baselineAge = ageInDays(baseline.completedAt, now);
  if (baselineAge >= FULL_RUN_MAX_AGE_DAYS) {
    return {
      taken: false,
      reason: `the last real walk was ${Math.floor(baselineAge)} days ago — time for a full check`,
    };
  }

  // Credentials that appeared or changed since the last real walk invalidate
  // the carried picture: those journeys were walked without them (or as a
  // different account), so the authenticated part of the product was never
  // verified by anything we'd be carrying (CHE-69 / CHE-64: creds are often
  // added via the settings screen after the first runs). Watch runs keep their
  // credential columns after completion, so the baseline row is comparable.
  const [currentCreds, baselineCreds] = await Promise.all([
    env.db.run.findUnique({
      where: { id: run.id },
      select: { testEmail: true, testPasswordEnc: true },
    }),
    env.db.run.findUnique({
      where: { id: baseline.id },
      select: { testEmail: true, testPasswordEnc: true },
    }),
  ]);
  const hasCreds = Boolean(currentCreds?.testEmail && currentCreds?.testPasswordEnc);
  const baselineHadCreds = Boolean(baselineCreds?.testEmail && baselineCreds?.testPasswordEnc);
  if (hasCreds && (!baselineHadCreds || currentCreds?.testEmail !== baselineCreds?.testEmail)) {
    return {
      taken: false,
      reason: baselineHadCreds
        ? "the test account changed since the last full walk — re-checking everything"
        : "test credentials were added since the last full walk — re-checking everything",
    };
  }

  const journeys = await env.db.journey.findMany({
    where: { runId: baseline.id },
    orderBy: { order: "asc" },
    select: {
      id: true,
      title: true,
      status: true,
      carriedFromRunId: true,
      steps: { orderBy: { order: "asc" }, select: { label: true } },
    },
  });
  const good = journeys.filter((j) => CARRIABLE_STATUSES.has(j.status));
  const bad = journeys.filter((j) => !CARRIABLE_STATUSES.has(j.status));
  if (bad.length === 0) {
    // Nothing to re-walk. Either the smoke path already carried this run (and we
    // never got here), or it couldn't — in which case a full check is the honest
    // way to re-establish a picture nobody has re-verified.
    return { taken: false, reason: "nothing was wrong last time — re-checking everything" };
  }
  if (good.length === 0) {
    return { taken: false, reason: "every journey had trouble last time — walking them all" };
  }

  // Provenance + expiry. A journey the baseline itself carried was walked
  // further back; that older date is the one that has to be inside the drift
  // bound, and it's the one the bottom line quotes.
  const sourceIds = [...new Set(good.map((j) => j.carriedFromRunId ?? baseline.id))];
  const sources = await env.db.run.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, runNumber: true, completedAt: true },
  });
  const byId = new Map(sources.map((s) => [s.id, s]));

  // One pass over the baseline's journeys in their own order, so each half gets
  // its slot from the same counter. Orders must be distinct across both halves:
  // walkOneJourney claims (runId, order) by deleting it first, and a collision
  // would delete a journey we just carried.
  const carry: CarriedJourney[] = [];
  const rewalk: RewalkJourney[] = [];
  let oldest: Date | null = null;
  for (let order = 0; order < journeys.length; order++) {
    const j = journeys[order];
    if (!CARRIABLE_STATUSES.has(j.status)) {
      rewalk.push({
        order,
        title: j.title,
        // An empty plan would leave the walker with nothing but the mission
        // text; the title is a worse plan than real steps but a much better one
        // than none.
        steps: j.steps.length ? j.steps.map((s) => s.label).slice(0, MAX_PROPOSED_STEPS) : [j.title],
        previousStatus: j.status,
      });
      continue;
    }
    const source = byId.get(j.carriedFromRunId ?? baseline.id);
    if (!source?.completedAt) {
      // Undateable evidence is unusable evidence: we cannot tell the owner what
      // "carried" means here, so we don't carry at all.
      return { taken: false, reason: `couldn't date the evidence behind "${j.title}"` };
    }
    const age = ageInDays(source.completedAt, now);
    if (age >= FULL_RUN_MAX_AGE_DAYS) {
      return {
        taken: false,
        reason:
          `"${j.title}" was last actually walked ${Math.floor(age)} days ago — ` +
          "carrying it again would be stale, so this is a full check",
      };
    }
    if (!oldest || source.completedAt < oldest) oldest = source.completedAt;
    carry.push({
      sourceJourneyId: j.id,
      order,
      title: j.title,
      sourceRunId: source.id,
      sourceRunNumber: source.runNumber,
    });
  }

  return {
    taken: true,
    baselineRunId: baseline.id,
    baselineRunNumber: baseline.runNumber,
    anatomy: baseline.anatomy,
    carry,
    rewalk,
    oldestVerifiedAt: (oldest ?? baseline.completedAt).toISOString(),
  };
}

function ageInDays(then: Date, now: Date): number {
  return (now.getTime() - then.getTime()) / 86_400_000;
}

// ─── Carrying journeys forward ───────────────────────────────────────────────

// Copy one baseline journey (steps + evidence) onto this run. Evidence rows are
// duplicated pointing at the SAME storageUrl/sha256 — no screenshot is
// re-uploaded and no R2 object is rewritten, so the carried strip renders from
// the very bytes the original walk captured. capturedAt is copied too: the
// evidence was captured then, and stamping it now would be a small lie in the
// one place the product sells honesty.
//
// Idempotent like walkOneJourney: the (runId, order) slot is cleared first, so a
// Workflow step retry replaces the copy instead of duplicating it.
export async function carryJourney(
  env: AgentEnv,
  runId: string,
  entry: CarriedJourney,
): Promise<void> {
  const source = await env.db.journey.findUnique({
    where: { id: entry.sourceJourneyId },
    select: {
      title: true,
      status: true,
      summary: true,
      videoUrl: true,
      steps: {
        orderBy: { order: "asc" },
        select: {
          order: true,
          label: true,
          status: true,
          screenshotUrl: true,
          attempted: true,
          observed: true,
          consoleLog: true,
          networkLog: true,
          evidence: {
            select: { type: true, storageUrl: true, sha256: true, capturedAt: true },
          },
        },
      },
    },
  });
  if (!source) return;

  await env.db.journey.deleteMany({ where: { runId, order: entry.order } });
  const journey = await env.db.journey.create({
    data: {
      runId,
      order: entry.order,
      title: source.title,
      status: source.status,
      summary: source.summary,
      videoUrl: source.videoUrl,
      carriedFromRunId: entry.sourceRunId,
    },
  });

  // One step at a time with its evidence nested — the exact write shape
  // execution.ts already runs in production against D1.
  for (const step of source.steps) {
    await env.db.step.create({
      data: {
        journeyId: journey.id,
        order: step.order,
        label: step.label,
        status: step.status,
        screenshotUrl: step.screenshotUrl,
        attempted: step.attempted,
        observed: step.observed,
        consoleLog: step.consoleLog,
        networkLog: step.networkLog,
        evidence: step.evidence.length ? { create: step.evidence } : undefined,
      },
    });
  }
}

// ─── Owner-facing coverage line ──────────────────────────────────────────────

// The verdict page's bottom line has to state coverage before it states an
// opinion: a partial run's clean pill covers journeys nobody walked today.
// `rewalked` is counted from the DB after the walk, not taken from the plan: a
// journey whose walk aborted leaves a skipped row behind, and "re-checked 2 of
// 5" would then be a claim about work that didn't happen.
export function partialBottomLine(
  plan: PartialPlan,
  synthesized: string | null,
  rewalked: number,
): string {
  const k = plan.rewalk.length;
  const m = plan.carry.length;
  const missed = Math.max(0, k - rewalked);
  // Name the run only when every carried journey came from the same one —
  // otherwise "from Run #43 (last walked Aug 19)" would credit #43 with a walk
  // that happened three runs earlier.
  const sources = new Set(plan.carry.map((c) => c.sourceRunNumber));
  const from =
    sources.size === 1
      ? `carried forward from Run #${[...sources][0]}`
      : `carried forward from ${sources.size} earlier runs`;
  const prefix =
    `Re-checked ${rewalked} of ${k + m} journey${k + m === 1 ? "" : "s"}` +
    (missed ? ` (${missed} couldn't be re-walked this run)` : "") +
    `; ${m} ${from} (last walked ${formatDay(plan.oldestVerifiedAt)}).`;
  return synthesized ? `${prefix} ${synthesized.trim()}` : prefix;
}

/** "Aug 12" — no Intl dependency, identical on workerd and Node. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an earlier run";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
