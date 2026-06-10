// Daily Watch scheduler (Loop B). Periodically finds active Watches whose
// nextRunAt is due, spawns a fresh Run linked to the Watch (with retained
// credentials and the previous run as baseline), and enqueues it.
//
// Run this alongside the worker (e.g. its own process or a node-cron tick).
// Skeleton: the due-selection + baseline wiring is sketched; diffing lives in
// the pipeline's synthesis step (TODO).

import { prisma } from "@/lib/db";
import { enqueueRun } from "@/lib/queue";
import { appSlugFromUrl } from "@/lib/utils";

export async function tickDueWatches(now = new Date()): Promise<number> {
  const due = await prisma.watch.findMany({
    where: { active: true, frequency: { not: "manual" }, nextRunAt: { lte: now } },
    include: { runs: { orderBy: { startedAt: "desc" }, take: 1 } },
  });

  for (const watch of due) {
    const baseline = watch.runs[0];
    const run = await prisma.run.create({
      data: {
        targetUrl: watch.targetUrl,
        appSlug: appSlugFromUrl(watch.targetUrl),
        testEmail: watch.testEmail,
        testPasswordEnc: watch.testPasswordEnc,
        notifyEmail: watch.notifyEmail,
        watchId: watch.id,
        baselineRunId: baseline?.id ?? null,
        status: "queued",
      },
      select: { id: true },
    });
    await enqueueRun(run.id);

    await prisma.watch.update({
      where: { id: watch.id },
      data: { lastRunAt: now, nextRunAt: nextRunAt(watch.frequency, now) },
    });
  }

  return due.length;
}

function nextRunAt(frequency: "daily" | "every_6h" | "manual", from: Date): Date | null {
  const next = new Date(from);
  if (frequency === "daily") next.setHours(next.getHours() + 24);
  else if (frequency === "every_6h") next.setHours(next.getHours() + 6);
  else return null;
  return next;
}
