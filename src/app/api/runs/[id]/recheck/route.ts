import { NextResponse } from "next/server";
import { getDbFromContext, nextRunNumber } from "@/lib/db";
import { canMutateOwned } from "@/lib/auth";
import { triggerRun } from "@/lib/trigger";

// POST /api/runs/{publicId}/recheck — Journey 7: re-run with the same params.
// The new run carries the same target/credentials/owner and points at the old
// run as its baseline so the verdict can diff.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const prev = await prisma.run.findUnique({
    where: { publicId: (await params).id },
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
  if (!prev) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // A recheck spends money + may touch the owner's app — owned runs require the
  // owner; anonymous runs are authorized by the unguessable publicId (CHE-33).
  if (!(await canMutateOwned(prisma, prev.ownerId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
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
      notifyEmail: prev.notifyEmail,
      watchId: prev.watchId,
      appId: prev.appId,
      ownerId: prev.ownerId,
      baselineRunId: prev.id,
      status: "queued",
    },
    select: { id: true, publicId: true },
  });

  await triggerRun(run.id);

  return NextResponse.json({ id: run.publicId }, { status: 201 });
}
