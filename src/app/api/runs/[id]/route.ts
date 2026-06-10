import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// GET /api/runs/{publicId} — run status + live feed for the in-progress page.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const run = await prisma.run.findUnique({
    where: { publicId: params.id },
    select: {
      publicId: true,
      appSlug: true,
      targetUrl: true,
      status: true,
      verdict: true,
      events: true,
      errorMessage: true,
      startedAt: true,
      completedAt: true,
    },
  });

  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json(run);
}
