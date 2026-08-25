// Re-check a run with the same params (Journey 7). Shared by the API route and
// the verdict page's server action (CHE-73) so both spawn identical runs: same
// target/credentials/owner, previous run as baseline for the verdict diff.

import type { PrismaClient } from "@/generated/prisma/client";
import { nextRunNumber } from "@/lib/db";
import { canMutateOwned } from "@/lib/auth";
import { triggerRun } from "@/lib/trigger";

export type RecheckResult =
  | { kind: "not_found" }
  | { kind: "unauthorized" }
  | { kind: "ok"; publicId: string };

export async function createRecheckRun(
  prisma: PrismaClient,
  publicId: string,
  opts: { full?: boolean } = {},
): Promise<RecheckResult> {
  const prev = await prisma.run.findUnique({
    where: { publicId },
    select: {
      id: true,
      targetUrl: true,
      appSlug: true,
      testEmail: true,
      testPasswordEnc: true,
      scopeHints: true,
      userNotes: true,
      notifyEmail: true,
      watchId: true,
      appId: true,
      ownerId: true,
    },
  });
  if (!prev) return { kind: "not_found" };

  // A recheck spends money + may touch the owner's app — owned runs require the
  // owner; anonymous runs are authorized by the unguessable publicId (CHE-33).
  if (!(await canMutateOwned(prisma, prev.ownerId))) return { kind: "unauthorized" };

  const run = await prisma.run.create({
    data: {
      runNumber: await nextRunNumber(prisma),
      targetUrl: prev.targetUrl,
      appSlug: prev.appSlug,
      testEmail: prev.testEmail,
      testPasswordEnc: prev.testPasswordEnc,
      scopeHints: prev.scopeHints,
      userNotes: prev.userNotes,
      notifyEmail: prev.notifyEmail,
      watchId: prev.watchId,
      appId: prev.appId,
      ownerId: prev.ownerId,
      baselineRunId: prev.id,
      // CHE-74: an explicit full re-check must not be eaten by smoke/partial.
      forceFull: opts.full ?? false,
      status: "queued",
    },
    select: { id: true, publicId: true },
  });

  await triggerRun(run.id);
  return { kind: "ok", publicId: run.publicId };
}
