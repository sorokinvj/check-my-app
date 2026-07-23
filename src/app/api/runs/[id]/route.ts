import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { parseJson } from "@/lib/json";
import type { RunEvent } from "@/lib/types";

// GET /api/runs/{publicId} — run status + live feed for the in-progress page.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const run = await prisma.run.findUnique({
    where: { publicId: (await params).id },
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

  return NextResponse.json({ ...run, events: parseJson<RunEvent[]>(run.events) });
}
