import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { updateWatchSchema } from "@/lib/validation";

// PATCH /api/watch/{slug} — Screen 4 settings: frequency, notify rule, pause/resume.
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const prisma = await getDbFromContext();
  const json = await req.json().catch(() => null);
  const parsed = updateWatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const data: Record<string, unknown> = { ...parsed.data };
  // Recompute the next run when frequency changes or the watch is resumed.
  if (parsed.data.frequency || parsed.data.active === true) {
    const watch = await prisma.watch.findUnique({ where: { appSlug: (await params).slug } });
    if (!watch) return NextResponse.json({ error: "Watch not found" }, { status: 404 });
    const frequency = parsed.data.frequency ?? watch.frequency;
    data.nextRunAt =
      frequency === "manual"
        ? null
        : new Date(Date.now() + (frequency === "daily" ? 24 : 6) * 60 * 60 * 1000);
  }

  const watch = await prisma.watch
    .update({ where: { appSlug: (await params).slug }, data })
    .catch(() => null);
  if (!watch) return NextResponse.json({ error: "Watch not found" }, { status: 404 });

  return NextResponse.json({
    slug: watch.appSlug,
    active: watch.active,
    frequency: watch.frequency,
    notifyOnChangeOnly: watch.notifyOnChangeOnly,
    nextRunAt: watch.nextRunAt,
  });
}

// DELETE /api/watch/{slug} — cancel the watch entirely. Runs keep their history;
// retained credentials are dropped with the watch (privacy: §5).
export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const prisma = await getDbFromContext();
  const watch = await prisma.watch.findUnique({ where: { appSlug: (await params).slug } });
  if (!watch) return NextResponse.json({ error: "Watch not found" }, { status: 404 });

  await prisma.run.updateMany({ where: { watchId: watch.id }, data: { watchId: null } });
  await prisma.watch.delete({ where: { id: watch.id } });

  return NextResponse.json({ ok: true });
}
