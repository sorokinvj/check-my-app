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
  // API key creation. Mirrors the pricing page: "API access" is listed only
  // under Business, so it's Business+ (business, enterprise) here.
  apiAccess: boolean;
  // CHE-98: what one watched app may spend on agent work per day. Measured
  // reality is ~$0.44/tick, so these are budgets for roughly one deep check a
  // day plus room for a re-check when something is wrong. Beyond it, ticks
  // still run — as smoke passes, which cost ~$0.01 and still catch an app
  // going down. Set against revenue: Starter is $29/mo/app ≈ $0.97/day.
  dailyBudgetUsd: number;
}

export const PLAN_LIMITS: Record<UserPlan, PlanLimits> = {
  // Free gets ONE daily watch: every verdict page advertises "Enable Daily
  // Watch", and with no billing wired a 0-cap made the button a dead end for
  // every account that exists. One watch is the product's hook; caps bite at
  // the second app.
  free: {
    maxWatches: 1,
    maxFrequency: "daily",
    trackerIntegration: false,
    apiAccess: false,
    // A trial should be able to show its best work once a day.
    dailyBudgetUsd: 1.2,
  },
  starter: {
    maxWatches: 1,
    maxFrequency: "daily",
    trackerIntegration: true,
    apiAccess: false,
    dailyBudgetUsd: 1.2,
  },
  growth: {
    maxWatches: 5,
    maxFrequency: "every_6h",
    trackerIntegration: true,
    apiAccess: false,
    // $99/mo across 5 apps ≈ $0.66/day/app of revenue; one deep walk a day
    // plus smoke on the other ticks fits inside it.
    dailyBudgetUsd: 0.8,
  },
  business: {
    maxWatches: 50,
    maxFrequency: "every_6h",
    trackerIntegration: true,
    apiAccess: true,
    dailyBudgetUsd: 4,
  },
  enterprise: {
    maxWatches: Number.MAX_SAFE_INTEGER,
    maxFrequency: "every_6h",
    trackerIntegration: true,
    apiAccess: true,
    dailyBudgetUsd: 10,
  },
};

// Run quotas (CHE-40 phase 1 — limits only, no checkout). A run costs real
// money to execute, so the free funnel is capped at both ends: one taste for a
// stranger, a handful for a signed-up account. Every paid plan is uncapped for
// now; per-tier run allowances land with billing.
export const ANON_RUNS_PER_DAY = 1;
export const FREE_RUNS_LIFETIME = 3;

// Daily Watch on Free is a trial, not a tier (CHE-54): the one free watch runs
// for this many days so an owner sees the product do its job on their own app,
// then pauses until they subscribe.
export const WATCH_TRIAL_DAYS = 7;
const TRIAL_MS = WATCH_TRIAL_DAYS * 24 * 60 * 60 * 1000;

// trialEndsAt to stamp on a watch the given plan is enabling. Paid plans get
// null — no trial, no expiry.
export function watchTrialEnd(plan: UserPlan, now: Date = new Date()): Date | null {
  return plan === "free" ? new Date(now.getTime() + TRIAL_MS) : null;
}

// Scheduler rule for a trial watch, pure so the decision is testable without a
// database or a clock. Two properties matter:
//   - NULL trialEndsAt never expires (paid + legacy ownerless watches).
//   - The owner's CURRENT plan is what's checked, so an owner who upgrades
//     resumes on their own with no second flag to keep in sync — including
//     plans set by hand in D1, which no Stripe webhook would have cleared.
export function shouldSkipWatch(
  watch: { trialEndsAt: Date | null },
  ownerPlan: UserPlan | null,
  now: Date = new Date(),
): boolean {
  if (!watch.trialEndsAt) return false;
  if (ownerPlan !== "free") return false;
  return watch.trialEndsAt.getTime() <= now.getTime();
}

export type TrialState =
  | { kind: "none" }
  | { kind: "active"; daysLeft: number }
  | { kind: "ended" };

// What the dashboard should say about a watch's trial. Mirrors shouldSkipWatch
// — a state other than "ended" means the scheduler will still run it.
export function watchTrialState(
  watch: { trialEndsAt: Date | null } | null | undefined,
  ownerPlan: UserPlan | null,
  now: Date = new Date(),
): TrialState {
  if (!watch?.trialEndsAt || ownerPlan !== "free") return { kind: "none" };
  const left = watch.trialEndsAt.getTime() - now.getTime();
  if (left <= 0) return { kind: "ended" };
  // Round up: with 20 hours to go the owner has "1 day left", not zero.
  return { kind: "active", daysLeft: Math.ceil(left / (24 * 60 * 60 * 1000)) };
}

const FREQ_RANK: Record<WatchFrequency, number> = { manual: 0, daily: 1, every_6h: 2 };

export function canUseFrequency(plan: UserPlan, freq: WatchFrequency): boolean {
  const max = PLAN_LIMITS[plan].maxFrequency;
  return max !== null && FREQ_RANK[freq] <= FREQ_RANK[max];
}

export type WatchGate = { ok: true } | { ok: false; reason: string };

// Pure half of assertCanAddWatch: the cap decision given how many active
// watches the owner already has. Split out so the rule can be asserted without
// a database, and so the Free copy says what Free actually is — one app, on a
// trial — instead of a bare number.
export function watchCapReason(plan: UserPlan, activeWatches: number): string | null {
  const limits = PLAN_LIMITS[plan];
  if (limits.maxWatches === 0) {
    return "Daily Watch isn't available on the Free plan — upgrade to enable it.";
  }
  if (activeWatches < limits.maxWatches) return null;
  return plan === "free"
    ? `Free covers one app, on a ${WATCH_TRIAL_DAYS}-day trial. Upgrade to Starter to watch this one too.`
    : `Plan limit reached: ${limits.maxWatches} watched app(s).`;
}

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
  if (PLAN_LIMITS[opts.plan].maxWatches === 0) {
    return { ok: false, reason: watchCapReason(opts.plan, 0)! };
  }
  if (!canUseFrequency(opts.plan, opts.frequency)) {
    return { ok: false, reason: `Your plan doesn't allow ${opts.frequency} checks.` };
  }
  if (!opts.existingWatchId) {
    const count = await db.watch.count({ where: { ownerId: opts.ownerId, active: true } });
    const reason = watchCapReason(opts.plan, count);
    if (reason) return { ok: false, reason };
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
