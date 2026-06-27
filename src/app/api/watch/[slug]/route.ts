import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";
import { updateWatchSchema } from "@/lib/validation";

// Resolve the caller's own Watch for an app slug (CHE-33 tenant-scoped). Returns
// null if not signed in or the app/watch isn't theirs.
async function ownWatch(slug: string) {
  const db = await getDbFromContext();
  const user = await getOptionalUser(db);
  if (!user) return { db, watch: null, unauthorized: true as const };
  const app = await db.app.findUnique({
    where: { ownerId_appSlug: { ownerId: user.id, appSlug: slug } },
    include: { watch: true },
  });
  return { db, watch: app?.watch ?? null, unauthorized: false as const };
}

// PATCH /api/watch/{slug} — Screen 4 settings: frequency, notify rule, pause/resume.
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const json = await req.json().catch(() => null);
  const parsed = updateWatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { db, watch, unauthorized } = await ownWatch((await params).slug);
  if (unauthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!watch) return NextResponse.json({ error: "Watch not found" }, { status: 404 });

  const data: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.frequency || parsed.data.active === true) {
    const frequency = parsed.data.frequency ?? watch.frequency;
    data.nextRunAt =
      frequency === "manual"
        ? null
        : new Date(Date.now() + (frequency === "daily" ? 24 : 6) * 60 * 60 * 1000);
  }

  const updated = await db.watch.update({ where: { id: watch.id }, data });
  return NextResponse.json({
    slug: updated.appSlug,
    active: updated.active,
    frequency: updated.frequency,
    notifyOnChangeOnly: updated.notifyOnChangeOnly,
    nextRunAt: updated.nextRunAt,
  });
}

// DELETE /api/watch/{slug} — cancel the watch. Runs keep their history; retained
// credentials are dropped with the watch (privacy §5).
export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { db, watch, unauthorized } = await ownWatch((await params).slug);
  if (unauthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!watch) return NextResponse.json({ error: "Watch not found" }, { status: 404 });

  await db.run.updateMany({ where: { watchId: watch.id }, data: { watchId: null } });
  await db.watch.delete({ where: { id: watch.id } });
  return NextResponse.json({ ok: true });
}
