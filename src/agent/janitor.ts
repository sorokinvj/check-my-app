// Housekeeping for the self-check account (CHE-100).
//
// CheckMyApp checks CheckMyApp by signing in as a real account and using the
// product. That account is deliberately ordinary — the owner can sign in as it
// and see exactly what the agent saw — but everything it accumulates is
// disposable, and nobody should have to remember to tidy it.
//
// Twice now the absence of this cost real money: a placeholder app the agent
// registered was checked daily for two days, and a watch the owner had paused
// came back to life because the agent pressed resume while exploring. The
// guards for both exist now; this is the backstop that makes them unnecessary.
//
// Deliberately narrow: only accounts flagged isTestAccount, only apps older
// than the grace period (so a self-check that just ran is still inspectable),
// and never anything belonging to a real owner.

import type { AgentEnv } from "./env";

// Long enough that the owner can sign in after a nightly self-check and see
// what happened; short enough that nothing accumulates.
const GRACE_HOURS = 12;

export interface JanitorResult {
  appsRemoved: number;
  watchesRemoved: number;
  slugs: string[];
}

export async function sweepTestAccounts(env: AgentEnv, now: Date = new Date()): Promise<JanitorResult> {
  const cutoff = new Date(now.getTime() - GRACE_HOURS * 60 * 60 * 1000);
  const stale = await env.db.app.findMany({
    where: { owner: { isTestAccount: true }, createdAt: { lt: cutoff } },
    select: { id: true, appSlug: true },
  });
  if (stale.length === 0) return { appsRemoved: 0, watchesRemoved: 0, slugs: [] };

  const ids = stale.map((a) => a.id);
  const watches = await env.db.watch.count({ where: { appId: { in: ids } } });

  // Runs are detached rather than deleted: their verdict pages are the record
  // of what the self-check saw, and they cost money to produce.
  await env.db.run.updateMany({ where: { appId: { in: ids } }, data: { appId: null, watchId: null } });
  await env.db.createdResource.updateMany({ where: { appId: { in: ids } }, data: { appId: null } });
  await env.db.issueLink.deleteMany({ where: { appId: { in: ids } } });
  await env.db.watch.deleteMany({ where: { appId: { in: ids } } });
  await env.db.ticketPolicy.deleteMany({ where: { appId: { in: ids } } });
  await env.db.trackerIntegration.deleteMany({ where: { appId: { in: ids } } });
  await env.db.repoIntegration.deleteMany({ where: { appId: { in: ids } } });
  await env.db.app.deleteMany({ where: { id: { in: ids } } });

  console.log(
    `[janitor] removed ${stale.length} test-account app(s): ${stale.map((a) => a.appSlug).join(", ")}`,
  );
  return { appsRemoved: stale.length, watchesRemoved: watches, slugs: stale.map((a) => a.appSlug) };
}
