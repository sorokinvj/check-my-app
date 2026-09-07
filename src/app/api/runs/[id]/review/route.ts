import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { loadReview } from "@/lib/review";

// GET /api/runs/{publicId}/review — the run's result in the shape a coding
// agent acts on (CHE-201): findings in full with absolute evidence URLs, every
// step as walked, what was not covered, and per finding the sentence that says
// when it is gone. Same visibility as /verdict and the verdict page: knowledge
// of the unguessable publicId is the capability, no session required.
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  // Evidence is served by this same host; the verdict page links it by
  // relative path and the browser fills in the origin, so an agent gets the
  // origin it fetched from.
  const review = await loadReview(prisma, (await params).id, new URL(req.url).origin);
  if (!review) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(review);
}
