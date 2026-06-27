"use server";

import { requireUser } from "@/lib/auth";

// Re-point an app's tracker to a different team (CHE-31 team picker). The default
// at connect time is the first team; JobLander must target the JobLander team,
// not whatever happens to be first.
export async function setTrackerTeam(appId: string, teamId: string, teamName: string) {
  const { user, db } = await requireUser();
  const app = await db.app.findFirst({
    where: { id: appId, ownerId: user.id },
    include: { tracker: true },
  });
  if (!app?.tracker) throw new Error("tracker not connected");
  await db.trackerIntegration.update({
    where: { appId },
    data: { teamId, externalOrg: teamName },
  });
}
