// Watch scheduler (CHE-41). The agent worker's cron tick claims every Watch row
// whose nextRunAt has come due, creates a queued Run for it and starts the
// CheckRunWorkflow — the same two steps the web app does in /api/checks, minus
// the HTTP hop (here the workflow binding is the worker's own).
//
// Cost is bounded twice over: at most MAX_PER_TICK runs start per tick, and a
// Watch whose previous run is still moving is skipped entirely.

import { nextRunNumber } from "@/lib/db";
import type { WatchFrequency } from "@/lib/enums";
import { makeAgentEnv, type AgentBindings } from "./env";

// The cron fires every 15 minutes and a full run costs real money, so cap the
// fan-out per tick rather than the number of watches we're willing to hold.
const MAX_PER_TICK = 3;
// Read more candidates than we can start so watches blocked by an in-flight run
// don't starve the ones behind them in the queue.
const CANDIDATE_LIMIT = 20;

const INTERVAL_HOURS: Record<WatchFrequency, number> = { daily: 24, every_6h: 6, manual: 0 };

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
      // Owner-configured scope/notes live on the App; watch runs must carry
      // them (run #19 self-check submitted a real paid check because the
      // "don't press the button" scope hint never reached the agent).
      app: { select: { scopeHints: true, userNotes: true } },
    },
  });

  const started: string[] = [];
  let skipped = 0;

  for (const watch of due) {
    if (started.length >= MAX_PER_TICK) break;

    try {
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

      const run = await env.db.run.create({
        data: {
          runNumber: await nextRunNumber(env.db),
          targetUrl: watch.targetUrl,
          appSlug: watch.appSlug,
          testEmail: watch.testEmail,
          testPasswordEnc: watch.testPasswordEnc,
          notifyEmail: watch.notifyEmail,
          scopeHints: watch.app?.scopeHints ?? null,
          userNotes: watch.app?.userNotes ?? null,
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
