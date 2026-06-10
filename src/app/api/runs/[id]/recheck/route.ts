import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enqueueRun } from "@/lib/queue";

// POST /api/runs/{publicId}/recheck — Journey 7: re-run with the same params.
// The new run carries the same target/credentials and points at the old run as
// its baseline so the verdict can diff.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const prev = await prisma.run.findUnique({
    where: { publicId: params.id },
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
    },
  });
  if (!prev) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const run = await prisma.run.create({
    data: {
      targetUrl: prev.targetUrl,
      appSlug: prev.appSlug,
      testEmail: prev.testEmail,
      testPasswordEnc: prev.testPasswordEnc,
      scopeHints: prev.scopeHints,
      userNotes: prev.userNotes,
      notifyEmail: prev.notifyEmail,
      watchId: prev.watchId,
      baselineRunId: prev.id,
      status: "queued",
    },
    select: { id: true, publicId: true },
  });

  await enqueueRun(run.id);

  return NextResponse.json({ id: run.publicId }, { status: 201 });
}
