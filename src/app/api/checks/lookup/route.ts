import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { appSlugFromUrl } from "@/lib/utils";
import { normalizeTargetUrl } from "@/lib/validation";

// GET /api/checks/lookup?url=… — domain-keyed result cache (CHE-39).
// Returns the latest completed run for the URL's domain so /check can prefill
// "we already checked this app". Anonymous runs are public by design (owner
// decision 2026-08-16); owner-scoped runs stay private to their owner.
export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url") ?? "";
  if (!url.trim()) {
    return NextResponse.json({ found: false });
  }

  const appSlug = appSlugFromUrl(normalizeTargetUrl(url));
  if (!appSlug.includes(".")) {
    return NextResponse.json({ found: false });
  }

  const prisma = await getDbFromContext();
  const where = { appSlug, ownerId: null, status: "completed" };
  const [latest, count] = await Promise.all([
    prisma.run.findFirst({
      where,
      orderBy: { completedAt: "desc" },
      select: {
        publicId: true,
        runNumber: true,
        verdict: true,
        bottomLine: true,
        completedAt: true,
      },
    }),
    prisma.run.count({ where }),
  ]);

  if (!latest) {
    return NextResponse.json({ found: false });
  }
  return NextResponse.json({ found: true, appSlug, count, run: latest });
}
