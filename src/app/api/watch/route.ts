import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";
import { assertCanAddWatch, watchTrialEnd } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { createWatchSchema } from "@/lib/validation";

function nextRunFrom(frequency: "daily" | "every_6h" | "manual"): Date | null {
  if (frequency === "manual") return null;
  const hours = frequency === "daily" ? 24 : 6;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

// POST /api/watch — Loop B: enable Daily Watch from a verdict. Owner feature
// (CHE-33): requires auth; finds-or-creates the owner's App for the run's target,
// then upserts the owned Watch (keyed by appId, not the global appSlug — CHE-36).
export async function POST(req: Request) {
  const db = await getDbFromContext();
  const user = await getOptionalUser(db);
  if (!user) {
    return NextResponse.json({ error: "Sign in to enable Daily Watch" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = createWatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const run = await db.run.findUnique({
    where: { publicId: parsed.data.runId },
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
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // Don't let one owner adopt another owner's run (CHE-33). Adoption is only
  // valid for an anonymous run or one already theirs.
  if (run.ownerId && run.ownerId !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

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
  const existingWatch = await db.watch.findUnique({ where: { appId: app.id }, select: { id: true } });
  const gate = await assertCanAddWatch(db, {
    ownerId: user.id,
    plan: user.plan as UserPlan,
    frequency: parsed.data.frequency,
    existingWatchId: existingWatch?.id ?? null,
  });
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 403 });

  const watch = await db.watch.upsert({
    where: { appId: app.id },
    create: {
      appId: app.id,
      ownerId: user.id,
      appSlug: run.appSlug,
      targetUrl: run.targetUrl,
      frequency: parsed.data.frequency,
      notifyOnChangeOnly: parsed.data.notifyOnChangeOnly,
      notifyEmail: run.notifyEmail,
      testEmail: run.testEmail,
      testPasswordEnc: run.testPasswordEnc,
      nextRunAt: nextRunFrom(parsed.data.frequency),
      // CHE-54: Free enables a 7-day trial watch; paid plans get null (no expiry).
      trialEndsAt: watchTrialEnd(user.plan as UserPlan),
    },
    update: {
      active: true,
      // trialEndsAt is deliberately absent: reconfiguring or resuming an
      // existing watch must not restart its trial clock.
      frequency: parsed.data.frequency,
      notifyOnChangeOnly: parsed.data.notifyOnChangeOnly,
      nextRunAt: nextRunFrom(parsed.data.frequency),
    },
  });

  // Adopt the source run into the owner's app + watch (becomes the baseline).
  await db.run.update({
    where: { id: run.id },
    data: { watchId: watch.id, ownerId: user.id, appId: app.id },
  });

  return NextResponse.json({ slug: watch.appSlug }, { status: 201 });
}
