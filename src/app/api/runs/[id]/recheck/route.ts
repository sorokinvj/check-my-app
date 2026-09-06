import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { hashClientKey } from "@/lib/crypto";
import { createRecheckRun } from "@/lib/recheck";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";

// POST /api/runs/{publicId}/recheck — Journey 7: re-run with the same params.
// Logic shared with the verdict page's server action (CHE-73) in lib/recheck.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CHE-193: our own checker never starts a re-check. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const prisma = await getDbFromContext();
  // ?full=1 → CHE-74 full re-check (partial/smoke skip themselves).
  const full = new URL(req.url).searchParams.get("full") === "1";
  const anonKeyHash = await hashClientKey(req.headers.get("cf-connecting-ip"));
  const result = await createRecheckRun(prisma, (await params).id, { full, anonKeyHash });
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (result.kind === "unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  if (result.kind === "quota") {
    return NextResponse.json({ error: result.reason }, { status: 403 });
  }
  if (result.kind === "reused") {
    return NextResponse.json({ id: result.publicId, reused: true }, { status: 200 });
  }
  return NextResponse.json({ id: result.publicId }, { status: 201 });
}
