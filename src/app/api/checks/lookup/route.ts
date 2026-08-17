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
  const [latest, count, watch] = await Promise.all([
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
    prisma.watch.findFirst({ where: { appSlug, active: true }, select: { id: true } }),
  ]);

  if (!latest) {
    return NextResponse.json({ found: false });
  }

  // Freshness (CHE-39 follow-up): a Watch re-runs daily so its domains never go
  // stale; unwatched results expire after 7 days — the card then pushes a fresh
  // check + Daily Watch instead of asserting a possibly outdated verdict.
  const ageDays = latest.completedAt
    ? Math.floor((Date.now() - new Date(latest.completedAt).getTime()) / 86_400_000)
    : null;
  const watched = watch !== null;
  const stale = !watched && (ageDays === null || ageDays >= STALE_AFTER_DAYS);

  return NextResponse.json({ found: true, appSlug, count, run: latest, watched, ageDays, stale });
}

const STALE_AFTER_DAYS = 7;
