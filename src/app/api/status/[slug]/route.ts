import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://checkmyapp.dev";

// GET /api/status/{slug} — the poll-side half of CHE-53: latest completed run
// for one of the caller's apps, for dashboards/uptime pages that pull instead
// of listening to the webhook push.
//
// Auth is the owner's session for now. TODO(CHE-52): accept an API key
// (Authorization: Bearer cma_…) so headless monitors can call this without a
// browser session.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const db = await getDbFromContext();
  const user = await getOptionalUser(db);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const app = await db.app.findUnique({
    where: { ownerId_appSlug: { ownerId: user.id, appSlug: (await params).slug } },
    select: { id: true, appSlug: true },
  });
  if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });

  const run = await db.run.findFirst({
    where: { appId: app.id, status: "completed" },
    orderBy: { completedAt: "desc" },
    select: { verdict: true, runNumber: true, completedAt: true, publicId: true },
  });
  if (!run) return NextResponse.json({ error: "No completed runs yet" }, { status: 404 });

  return NextResponse.json({
    app: app.appSlug,
    verdict: run.verdict,
    runNumber: run.runNumber,
    completedAt: run.completedAt,
    verdictUrl: `${APP_URL}/verdict/${run.publicId}`,
  });
}
