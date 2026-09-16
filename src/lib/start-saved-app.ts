import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "./enums";
import { assertCanStartRun } from "./plans";
import { nextRunNumber } from "./db";
import { triggerRun } from "./trigger";
import { effectiveSiteCap } from "./site-cap";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";

// CHE-253: `owner` is the person acting and the team they act for. The quota
// and the plan are the team's; ownerId on the new run stays the person, because
// attribution is what isOwnRun (src/agent/notify-verdict.ts) reads to decide
// whether a verdict about one of our own hosts is silenced.
export async function startSavedApp(
  db: PrismaClient,
  owner: { id: string; teamId: string; plan: UserPlan },
  appId: string,
  deps = { trigger: triggerRun, siteCap: effectiveSiteCap },
): Promise<{ publicId: string } | { error: string }> {
  const app = await db.app.findFirst({ where: { ...teamOwned(owner.teamId), id: appId, ownerId: owner.id } });
  if (!app) return { error: "App not found." };
  const active = await db.run.findFirst({
    where: { ...teamOwned(owner.teamId), appId, ownerId: owner.id, status: { notIn: ["completed", "partial", "failed"] } },
    select: { publicId: true },
  });
  if (active) return active;
  const gate = await assertCanStartRun(db, { id: owner.teamId, plan: owner.plan }, null, { siteCap: deps.siteCap() });
  if (!gate.ok) return { error: gate.reason };
  const run = await db.run.create({ ...alreadyScoped("created with its team"),
    data: {
      runNumber: await nextRunNumber(db), ownerId: owner.id, teamId: owner.teamId, appId: app.id,
      targetUrl: app.targetUrl, appSlug: app.appSlug, targetKind: app.targetKind,
      extensionId: app.extensionId, extensionConfig: app.extensionConfig,
      testEmail: app.testEmail, testPasswordEnc: app.testPasswordEnc,
      scopeHints: app.scopeHints, userNotes: app.userNotes, focusAreas: app.focusAreas,
      forceFull: app.targetKind === "extension", status: "queued",
    },
    select: { id: true, publicId: true },
  });
  await deps.trigger(run.id);
  return { publicId: run.publicId };
}
