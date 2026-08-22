"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";

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

// Outbound integrations (CHE-53): generic webhook + Slack incoming webhook,
// fired after every completed watch run. Blank URL = disable. The signing
// secret is write-only: blank keeps the current one, and it's dropped with the
// webhook URL so a disabled endpoint leaves no secret behind.
export async function setIntegrationEndpoints(appId: string, formData: FormData) {
  const { user, db } = await requireUser();
  const app = await db.app.findFirst({
    where: { id: appId, ownerId: user.id },
    select: { id: true },
  });
  if (!app) throw new Error("app not found");

  const webhookUrl = String(formData.get("webhookUrl") ?? "").trim() || null;
  const slackWebhookUrl = String(formData.get("slackWebhookUrl") ?? "").trim() || null;
  const webhookSecret = String(formData.get("webhookSecret") ?? "").trim();
  for (const url of [webhookUrl, slackWebhookUrl]) {
    if (url && !/^https:\/\/.+/.test(url)) {
      throw new Error("Webhook URLs must be https://");
    }
  }

  const data: { webhookUrl: string | null; slackWebhookUrl: string | null; webhookSecretEnc?: string | null } = {
    webhookUrl,
    slackWebhookUrl,
  };
  if (!webhookUrl) data.webhookSecretEnc = null;
  else if (webhookSecret) data.webhookSecretEnc = encryptSecret(webhookSecret);

  await db.app.update({ where: { id: appId }, data });
  revalidatePath("/dashboard");
}
