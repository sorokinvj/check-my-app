"use server";

import { requireUser } from "@/lib/auth";
import { generateApiKey, hashApiKey } from "@/lib/apiKeys";

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
