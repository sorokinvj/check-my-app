// Watch scheduler (CHE-41). The agent worker's cron tick claims every Watch row
// whose nextRunAt has come due, creates a queued Run for it and starts the
// CheckRunWorkflow — the same two steps the web app does in /api/checks, minus
// the HTTP hop (here the workflow binding is the worker's own).
//
// Cost is bounded twice over: at most MAX_PER_TICK runs start per tick, and a
// Watch whose previous run is still moving is skipped entirely.

import { nextRunNumber } from "@/lib/db";
import type { UserPlan, WatchFrequency } from "@/lib/enums";
import { PLAN_LIMITS } from "@/lib/plans";
import { sweepExpiredPendingChecks, sweepTestAccounts } from "./janitor";
import { sendWatchTrialPaused } from "@/lib/email";
import { shouldSkipWatch } from "@/lib/plans";
import { makeAgentEnv, type AgentEnv, type AgentBindings } from "./env";

// The cron fires every 15 minutes and a full run costs real money, so cap the
// fan-out per tick rather than the number of watches we're willing to hold.
const MAX_PER_TICK = 3;
// Read more candidates than we can start so watches blocked by an in-flight run
// don't starve the ones behind them in the queue.
const CANDIDATE_LIMIT = 20;

const INTERVAL_HOURS: Record<WatchFrequency, number> = { daily: 24, every_6h: 6, manual: 0 };

// How long a watch paused by an expired free trial waits before the scheduler
// looks at it again (CHE-54). It is NOT a claim — no run happens — it just keeps
// the paused row from sitting permanently at the head of the due queue, which is
// ordered by nextRunAt and only CANDIDATE_LIMIT deep: a handful of never-upgraded
// trials would otherwise starve every paying watch behind them. The cost is that
// an owner who upgrades waits up to an hour, not a full daily cycle.
const TRIAL_RECHECK_HOURS = 1;

// A run in any other status is still moving; its Watch must not fire again yet.
const TERMINAL_STATUSES = ["completed", "partial", "failed"];

export interface TickResult {
  started: string[];
  skipped: number;
}

export async function runDueWatches(
  bindings: AgentBindings,
  now: Date = new Date(),
): Promise<TickResult> {
  const env = makeAgentEnv(bindings);

  // CHE-105: clear what the self-check account left behind before deciding what
  // to run, so a stale placeholder app can never take a slot — or a budget.
  // Never fails the tick: housekeeping must not stop real work.
  try {
    await sweepTestAccounts(env, now);
  } catch (err) {
    console.warn(`[janitor] sweep failed: ${err instanceof Error ? err.message : err}`);
  }
  // Launch: parked $1 checks that were never paid for.
  try {
    await sweepExpiredPendingChecks(env, now);
  } catch (err) {
    console.warn(`[janitor] pending-check sweep failed: ${err instanceof Error ? err.message : err}`);
  }

  const due = await env.db.watch.findMany({
    where: {
      active: true,
      frequency: { not: "manual" },
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    // SQLite sorts NULL first, so watches that have never fired go to the front.
    orderBy: { nextRunAt: "asc" },
    take: CANDIDATE_LIMIT,
    select: {
      id: true,
      appSlug: true,
      targetUrl: true,
      frequency: true,
      notifyEmail: true,
      testEmail: true,
      testPasswordEnc: true,
      appId: true,
      ownerId: true,
      // Free-trial gate (CHE-54): the owner's plan is read fresh on every tick,
      // so an upgrade resumes the watch without anything else having to update it.
      trialEndsAt: true,
      trialNoticeSentAt: true,
      owner: { select: { plan: true } },
      // Owner-configured scope/notes live on the App; watch runs must carry
      // them (run #19 self-check submitted a real paid check because the
      // "don't press the button" scope hint never reached the agent).
      app: { select: { scopeHints: true, userNotes: true, focusAreas: true } },
    },
  });

  const started: string[] = [];
  let skipped = 0;

  for (const watch of due) {
    if (started.length >= MAX_PER_TICK) break;

    try {
      if (shouldSkipWatch(watch, (watch.owner?.plan ?? null) as UserPlan | null, now)) {
        skipped++;
        console.log(
          `[scheduler] watch ${watch.id} (${watch.appSlug}) skipped — free trial ended ` +
            `${watch.trialEndsAt?.toISOString()}, owner still on free`,
        );
        await pauseExpiredTrial(env, bindings, watch, now);
        continue;
      }

      const inFlight = await env.db.run.count({
        where: { watchId: watch.id, status: { notIn: TERMINAL_STATUSES } },
      });
      if (inFlight > 0) {
        skipped++;
        console.log(`[scheduler] watch ${watch.id} skipped — ${inFlight} run(s) still in flight`);
        continue;
      }

      // The run this one gets diffed against: the watch's latest finished run.
      const baseline = await env.db.run.findFirst({
        where: { watchId: watch.id, status: "completed" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });

      // Claim before running: with nextRunAt already pushed forward, an
      // overlapping tick (or a retry of this one) can't start the same watch
      // twice. Crashing after the claim costs a skipped cycle, not a double spend.
      const hours = INTERVAL_HOURS[watch.frequency as WatchFrequency] || 24;
      await env.db.watch.update({
        where: { id: watch.id },
        data: { lastRunAt: now, nextRunAt: new Date(now.getTime() + hours * 60 * 60 * 1000) },
      });

      // CHE-106: an app's agent budget for the day. Beyond it the tick still
      // happens — as a smoke pass, which still notices the app going down —
      // and the deep walk resumes tomorrow. Without this, Growth (5 apps on a
      // 6-hourly cadence) costs ~$264/mo against $99 of revenue.
      const budget = PLAN_LIMITS[(watch.owner?.plan ?? "free") as UserPlan].dailyBudgetUsd;
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      const spentToday = watch.appId
        ? ((
            await env.db.run.aggregate({
              where: { appId: watch.appId, createdAt: { gte: dayStart } },
              _sum: { costUsd: true },
            })
          )._sum.costUsd ?? 0)
        : 0;
      const smokeOnly = spentToday >= budget;
      if (smokeOnly) {
        console.log(
          `[scheduler] watch ${watch.id} (${watch.appSlug}) over budget: ` +
            `$${spentToday.toFixed(2)} of $${budget.toFixed(2)} today — smoke-only tick`,
        );
      }

      const run = await env.db.run.create({
        data: {
          runNumber: await nextRunNumber(env.db),
          smokeOnly,
          targetUrl: watch.targetUrl,
          appSlug: watch.appSlug,
          testEmail: watch.testEmail,
          testPasswordEnc: watch.testPasswordEnc,
          notifyEmail: watch.notifyEmail,
          scopeHints: watch.app?.scopeHints ?? null,
          userNotes: watch.app?.userNotes ?? null,
          focusAreas: watch.app?.focusAreas ?? null,
          watchId: watch.id,
          baselineRunId: baseline?.id ?? null,
          appId: watch.appId,
          ownerId: watch.ownerId,
          status: "queued",
        },
        select: { id: true },
      });

      await bindings.CHECK_RUN.create({ params: { runId: run.id } });
      started.push(run.id);
      console.log(`[scheduler] watch ${watch.id} (${watch.appSlug}) → run ${run.id}`);
    } catch (err) {
      // One bad watch must not take the whole tick down with it.
      console.error(
        `[scheduler] watch ${watch.id} failed to start: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { started, skipped };
}

// Housekeeping for a watch the trial gate just declined to run (CHE-54). The row
// stays active and untouched otherwise — pausing is a consequence of the plan,
// not a state we write — so upgrading is the only thing needed to resume it.
async function pauseExpiredTrial(
  env: AgentEnv,
  bindings: AgentBindings,
  watch: {
    id: string;
    appSlug: string;
    notifyEmail: string | null;
    trialNoticeSentAt: Date | null;
  },
  now: Date,
): Promise<void> {
  // Move it out of the head of the due queue first (see TRIAL_RECHECK_HOURS);
  // this has to happen even if the mail below fails.
  await env.db.watch.update({
    where: { id: watch.id },
    data: { nextRunAt: new Date(now.getTime() + TRIAL_RECHECK_HOURS * 60 * 60 * 1000) },
  });

  if (watch.trialNoticeSentAt || !watch.notifyEmail) return;

  try {
    await sendWatchTrialPaused({
      to: watch.notifyEmail,
      appSlug: watch.appSlug,
      apiKey: bindings.EMAIL_API_KEY,
      from: bindings.EMAIL_FROM,
      baseUrl: bindings.APP_URL,
    });
    // Stamped only after a successful send, so a transient Resend failure costs
    // a retry on the next tick rather than the notice itself.
    await env.db.watch.update({
      where: { id: watch.id },
      data: { trialNoticeSentAt: now },
    });
  } catch (err) {
    console.warn(
      `[scheduler] trial-paused email for watch ${watch.id} failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}
