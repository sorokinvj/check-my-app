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
