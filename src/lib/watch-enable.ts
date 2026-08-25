// Enable Daily Watch from a verdict (Loop B). Shared by the API route and the
// verdict page's server action (CHE-75) so both paths create identical watches:
// find-or-create the owner's App for the run's target, upsert the owned Watch,
// adopt the source run as baseline.

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan, WatchFrequency } from "@/lib/enums";
import { assertCanAddWatch, watchTrialEnd } from "@/lib/plans";

export type EnableWatchResult =
  | { kind: "unauthenticated" }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "gated"; reason: string }
  | { kind: "ok"; slug: string };

function nextRunFrom(frequency: WatchFrequency): Date | null {
  if (frequency === "manual") return null;
  const hours = frequency === "daily" ? 24 : 6;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export async function enableWatchForRun(
  db: PrismaClient,
  user: { id: string; plan: string; clerkOrgId: string | null } | null,
  opts: { runPublicId: string; frequency: WatchFrequency; notifyOnChangeOnly: boolean },
): Promise<EnableWatchResult> {
  if (!user) return { kind: "unauthenticated" };

  const run = await db.run.findUnique({
    where: { publicId: opts.runPublicId },
    select: {
      id: true,
      ownerId: true,
      appSlug: true,
      targetUrl: true,
      testEmail: true,
      testPasswordEnc: true,
      scopeHints: true,
      userNotes: true,
      notifyEmail: true,
    },
  });
  if (!run) return { kind: "not_found" };

  // Don't let one owner adopt another owner's run (CHE-33). Adoption is only
  // valid for an anonymous run or one already theirs.
  if (run.ownerId && run.ownerId !== user.id) return { kind: "forbidden" };

  // Find-or-create the owner's App for this target. upsert is race-safe under
  // D1 (no transactions) vs a check-then-create double-submit window.
  const app = await db.app.upsert({
    where: { ownerId_appSlug: { ownerId: user.id, appSlug: run.appSlug } },
    update: {},
    create: {
      ownerId: user.id,
      orgId: user.clerkOrgId ?? null,
      targetUrl: run.targetUrl,
      appSlug: run.appSlug,
      testEmail: run.testEmail,
      testPasswordEnc: run.testPasswordEnc,
      scopeHints: run.scopeHints,
      userNotes: run.userNotes,
    },
  });

  // Tier gate (CHE-34): updating an existing watch is fine; a new one counts.
  const existingWatch = await db.watch.findUnique({
    where: { appId: app.id },
    select: { id: true },
  });
  const gate = await assertCanAddWatch(db, {
    ownerId: user.id,
    plan: user.plan as UserPlan,
    frequency: opts.frequency,
    existingWatchId: existingWatch?.id ?? null,
  });
  if (!gate.ok) return { kind: "gated", reason: gate.reason };

  const watch = await db.watch.upsert({
    where: { appId: app.id },
    create: {
      appId: app.id,
      ownerId: user.id,
      appSlug: run.appSlug,
      targetUrl: run.targetUrl,
      frequency: opts.frequency,
      notifyOnChangeOnly: opts.notifyOnChangeOnly,
      notifyEmail: run.notifyEmail,
      testEmail: run.testEmail,
      testPasswordEnc: run.testPasswordEnc,
      nextRunAt: nextRunFrom(opts.frequency),
      // CHE-54: Free enables a 7-day trial watch; paid plans get null (no expiry).
      trialEndsAt: watchTrialEnd(user.plan as UserPlan),
    },
    update: {
      active: true,
      // trialEndsAt is deliberately absent: reconfiguring or resuming an
      // existing watch must not restart its trial clock.
      frequency: opts.frequency,
      notifyOnChangeOnly: opts.notifyOnChangeOnly,
      nextRunAt: nextRunFrom(opts.frequency),
    },
  });

  // Adopt the source run into the owner's app + watch (becomes the baseline).
  await db.run.update({
    where: { id: run.id },
    data: { watchId: watch.id, ownerId: user.id, appId: app.id },
  });

  return { kind: "ok", slug: watch.appSlug };
}
