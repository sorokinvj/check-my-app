import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "./enums";
import { assertCanStartRun } from "./plans";
import { nextRunNumber } from "./db";
import { triggerRun } from "./trigger";
import { effectiveSiteCap } from "./site-cap";

export async function startSavedApp(
  db: PrismaClient,
  owner: { id: string; plan: UserPlan },
  appId: string,
  deps = { trigger: triggerRun, siteCap: effectiveSiteCap },
): Promise<{ publicId: string } | { error: string }> {
  const app = await db.app.findFirst({ where: { id: appId, ownerId: owner.id } });
  if (!app) return { error: "App not found." };
  const active = await db.run.findFirst({
    where: { appId, ownerId: owner.id, status: { notIn: ["completed", "failed"] } },
    select: { publicId: true },
  });
  if (active) return active;
  const gate = await assertCanStartRun(db, owner, null, { siteCap: deps.siteCap() });
  if (!gate.ok) return { error: gate.reason };
  const run = await db.run.create({
    data: {
      runNumber: await nextRunNumber(db), ownerId: owner.id, appId: app.id,
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
