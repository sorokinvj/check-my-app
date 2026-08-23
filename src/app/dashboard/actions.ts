"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { generateApiKey, hashApiKey } from "@/lib/apiKeys";
import { assertCanAddWatch } from "@/lib/plans";
import type { UserPlan, WatchFrequency } from "@/lib/enums";

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

// Owner API keys (CHE-52). The raw key exists only in this return value — the
// DB keeps its SHA-256 hash, so this is the one time the owner can copy it.
export async function createApiKey(
  name: string,
): Promise<{ id: string; name: string; rawKey: string }> {
  const { user, db } = await requireUser();
  const rawKey = generateApiKey();
  const key = await db.apiKey.create({
    data: {
      ownerId: user.id,
      name: name.trim().slice(0, 100) || "API key",
      keyHash: await hashApiKey(rawKey),
    },
  });
  return { id: key.id, name: key.name, rawKey };
}

// Revoke = delete the row; the key stops resolving on the next request.
// deleteMany scoped to the owner so one tenant can't revoke another's key.
export async function revokeApiKey(id: string): Promise<void> {
  const { user, db } = await requireUser();
  await db.apiKey.deleteMany({ where: { id, ownerId: user.id } });
}

// Edit an app's settings after onboarding (CHE-64). Mirrors createApp's field →
// record mapping EXACTLY so the settings page and onboarding write the same
// places: creds/scope/notes on App (test creds also mirrored onto Watch, as
// onboarding does), cadence + notify email on Watch, ticket params on
// TicketPolicy. The password is write-only: a blank submission leaves
// testPasswordEnc untouched on both records.
export async function updateAppSettings(appId: string, formData: FormData) {
  const { user, db } = await requireUser();
  const app = await db.app.findFirst({
    where: { id: appId, ownerId: user.id },
    include: { watch: true, policy: true },
  });
  if (!app) throw new Error("app not found");

  const testEmail = (String(formData.get("testEmail") ?? "").trim() || null) as string | null;
  const testPassword = String(formData.get("testPassword") ?? "");
  const scopeHints = (String(formData.get("scopeHints") ?? "").trim() || null) as string | null;
  const userNotes = (String(formData.get("userNotes") ?? "").trim() || null) as string | null;
  const notifyEmail = (String(formData.get("notifyEmail") ?? "").trim() || null) as string | null;
  const frequency = String(formData.get("frequency") ?? "daily") as WatchFrequency;

  const pickupLabels = String(formData.get("pickupLabels") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const repoLabel = (String(formData.get("repoLabel") ?? "").trim() || null) as string | null;
  const urgentJourneys = String(formData.get("urgentJourneys") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Cadence gate (CHE-34): editing an existing watch doesn't count against the
  // per-plan cap, but the tier still can't select a faster cadence than allowed.
  const gate = await assertCanAddWatch(db, {
    ownerId: user.id,
    plan: user.plan as UserPlan,
    frequency,
    existingWatchId: app.watch?.id ?? null,
  });
  if (!gate.ok) throw new Error(gate.reason);

  // Write-only password: only re-encrypt when a non-empty value is submitted.
  const passwordUpdate = testPassword ? { testPasswordEnc: encryptSecret(testPassword) } : {};

  // App — creds/scope/notes (source of record for test creds).
  await db.app.update({
    where: { id: app.id },
    data: { testEmail, scopeHints, userNotes, ...passwordUpdate },
  });

  // Watch — cadence + notify email; test creds mirrored here exactly as
  // onboarding's nested create does (recurring runs read them off the Watch).
  if (app.watch) {
    await db.watch.update({
      where: { id: app.watch.id },
      data: { frequency, notifyEmail, testEmail, ...passwordUpdate },
    });
  }

  // TicketPolicy — the pickup contract with the owner's automation.
  if (app.policy) {
    await db.ticketPolicy.update({
      where: { appId: app.id },
      data: {
        pickupLabels: JSON.stringify(pickupLabels),
        repoLabel,
        priorityRule: JSON.stringify({ urgent: urgentJourneys }),
      },
    });
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/${app.id}`);
}
