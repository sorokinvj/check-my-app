// Subscription tier limits (CHE-34). Enforcement only — no billing yet (Stripe /
// Clerk Billing wire later, per the PRD). `User.plan` drives the gates.

import type { UserPlan, WatchFrequency } from "./enums";
import type { PrismaClient } from "@/generated/prisma/client";

export interface PlanLimits {
  // 0 = no Daily Watch (one-off runs only).
  maxWatches: number;
  // Most-frequent cadence allowed; null = no recurring checks.
  maxFrequency: WatchFrequency | null;
  trackerIntegration: boolean;
}

export const PLAN_LIMITS: Record<UserPlan, PlanLimits> = {
  // Free gets ONE daily watch: every verdict page advertises "Enable Daily
  // Watch", and with no billing wired a 0-cap made the button a dead end for
  // every account that exists. One watch is the product's hook; caps bite at
  // the second app.
  free: { maxWatches: 1, maxFrequency: "daily", trackerIntegration: false },
  starter: { maxWatches: 1, maxFrequency: "daily", trackerIntegration: true },
  growth: { maxWatches: 10, maxFrequency: "every_6h", trackerIntegration: true },
  business: { maxWatches: 50, maxFrequency: "every_6h", trackerIntegration: true },
  enterprise: {
    maxWatches: Number.MAX_SAFE_INTEGER,
    maxFrequency: "every_6h",
    trackerIntegration: true,
  },
};

// Run quotas (CHE-40 phase 1 — limits only, no checkout). A run costs real
// money to execute, so the free funnel is capped at both ends: one taste for a
// stranger, a handful for a signed-up account. Every paid plan is uncapped for
// now; per-tier run allowances land with billing.
export const ANON_RUNS_PER_DAY = 1;
export const FREE_RUNS_LIFETIME = 3;

const FREQ_RANK: Record<WatchFrequency, number> = { manual: 0, daily: 1, every_6h: 2 };

export function canUseFrequency(plan: UserPlan, freq: WatchFrequency): boolean {
  const max = PLAN_LIMITS[plan].maxFrequency;
  return max !== null && FREQ_RANK[freq] <= FREQ_RANK[max];
}

export type WatchGate = { ok: true } | { ok: false; reason: string };

// Gate for enabling/configuring a Daily Watch. existingWatchId set → it's an
// update of an existing watch, so it doesn't count against the per-plan cap.
export async function assertCanAddWatch(
  db: PrismaClient,
  opts: {
    ownerId: string;
    plan: UserPlan;
    frequency: WatchFrequency;
    existingWatchId?: string | null;
  },
): Promise<WatchGate> {
  const limits = PLAN_LIMITS[opts.plan];
  if (limits.maxWatches === 0) {
    return { ok: false, reason: "Daily Watch isn't available on the Free plan — upgrade to enable it." };
  }
  if (!canUseFrequency(opts.plan, opts.frequency)) {
    return { ok: false, reason: `Your plan doesn't allow ${opts.frequency} checks.` };
  }
  if (!opts.existingWatchId) {
    const count = await db.watch.count({ where: { ownerId: opts.ownerId, active: true } });
    if (count >= limits.maxWatches) {
      return { ok: false, reason: `Plan limit reached: ${limits.maxWatches} watched app(s).` };
    }
  }
  return { ok: true };
}

export type RunGate = { ok: true } | { ok: false; reason: string; code: "quota_anon" | "quota_free" };

// Gate for starting a one-off run from the submit form. Only that route calls
// it: Watch/scheduler runs are already paid for by the plan that enabled them
// and must never be blocked by a quota.
//
// `anonKeyHash` identifies the client of an anonymous submission; null means we
// couldn't derive one (see hashClientKey), and an unidentifiable client is let
// through rather than blocked — over-counting strangers would break the funnel
// this whole product runs on.
export async function assertCanStartRun(
  db: PrismaClient,
  owner: { id: string; plan: UserPlan } | null,
  anonKeyHash: string | null,
): Promise<RunGate> {
  if (owner) {
    if (owner.plan !== "free") return { ok: true };
    const used = await db.run.count({ where: { ownerId: owner.id } });
    if (used >= FREE_RUNS_LIFETIME) {
      return {
        ok: false,
        code: "quota_free",
        reason: `You've used all ${FREE_RUNS_LIFETIME} runs on the Free plan. Enable Daily Watch on an app you've already checked, or upgrade for unlimited runs.`,
      };
    }
    return { ok: true };
  }

  if (!anonKeyHash) return { ok: true };
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const used = await db.run.count({ where: { anonKeyHash, createdAt: { gte: since } } });
  if (used >= ANON_RUNS_PER_DAY) {
    return {
      ok: false,
      code: "quota_anon",
      reason: "That was your free run for today. Sign up for a free account to get more.",
    };
  }
  return { ok: true };
}
