import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { hashClientKey } from "@/lib/crypto";
import { createRecheckRun } from "@/lib/recheck";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";

// POST /api/runs/{publicId}/recheck — Journey 7: re-run with the same params.
// Logic shared with the verdict page's server action (CHE-73) in lib/recheck.
//
// Contract (CHE-137):
//   POST …/recheck          the regular re-check — the ladder (smoke / partial /
//                           full decided by what changed). Not limited by plan.
//                           201 { id }
//   POST …/recheck?full=1   a full re-check (CHE-74: walks everything, no
//                           shortcut). Metered per plan and UTC month.
//                           201 { id, remaining }   remaining: number | null —
//                                                   full re-checks left this
//                                                   month after this one; null
//                                                   = the plan has no limit
//                           403 { error, remaining: 0 }   the month's allowance
//                                                   is used, the plan has none,
//                                                   or the caller is anonymous
//   Either form:            200 { id, reused: true }  anonymous caller, a fresh
//                                                   verdict already exists
//                           403 { error }           anonymous daily cap, or not
//                                                   the owner
//                           404 { error }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CHE-193: our own checker never starts a re-check. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const prisma = await getDbFromContext();
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
    // A refused full re-check says so in a number the UI can show: nothing left.
    return NextResponse.json(
      full ? { error: result.reason, remaining: 0 } : { error: result.reason },
      { status: 403 },
    );
  }
  if (result.kind === "reused") {
    return NextResponse.json({ id: result.publicId, reused: true }, { status: 200 });
  }
  return NextResponse.json(
    full ? { id: result.publicId, remaining: result.remaining ?? null } : { id: result.publicId },
    { status: 201 },
  );
}
