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
  | { kind: "quota"; reason: string }
  | { kind: "reused"; publicId: string }
  | { kind: "ok"; publicId: string };

// How long an anonymous visitor gets the existing verdict instead of a new run
// (CHE-94). A verdict page URL is public by design, so an unguarded re-check
// button is an open tap on our LLM spend: one shared link, one bot, unlimited
// $0.30-$2.30 runs. Owners are unaffected — they may re-check whenever they
// like, including the full walk.
const ANON_REUSE_WINDOW_MS = 6 * 60 * 60 * 1000;

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
      focusAreas: true,
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

  // CHE-94. Everything below is about the ANONYMOUS path: the caller proved
  // nothing except that they have the link.
  const isAnonymous = !prev.ownerId;
  if (isAnonymous) {
    // A full walk is the expensive mode and exists for owners who just shipped
    // something. Nobody holding a public link gets to spend that.
    if (opts.full) {
      return {
        kind: "quota",
        reason: "A full re-check is available to the owner of this app. Sign in to run one.",
      };
    }
    const fresh = await prisma.run.findFirst({
      where: {
        appSlug: prev.appSlug,
        status: "completed",
        completedAt: { gte: new Date(Date.now() - ANON_REUSE_WINDOW_MS) },
      },
      orderBy: { completedAt: "desc" },
      select: { publicId: true },
    });
    if (fresh) return { kind: "reused", publicId: fresh.publicId };
  }

  const run = await prisma.run.create({
    data: {
      runNumber: await nextRunNumber(prisma),
      targetUrl: prev.targetUrl,
      appSlug: prev.appSlug,
      testEmail: prev.testEmail,
      testPasswordEnc: prev.testPasswordEnc,
      scopeHints: prev.scopeHints,
      userNotes: prev.userNotes,
      focusAreas: prev.focusAreas,
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
