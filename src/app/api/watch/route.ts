import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { createWatchSchema } from "@/lib/validation";

function nextRunFrom(frequency: "daily" | "every_6h" | "manual"): Date | null {
  if (frequency === "manual") return null;
  const hours = frequency === "daily" ? 24 : 6;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

// POST /api/watch — Loop B: enable Daily Watch from a verdict. Upserts the
// Watch for the app, carrying credentials over from the source run so the
// scheduler can keep re-running.
export async function POST(req: Request) {
  const prisma = await getDbFromContext();
  const json = await req.json().catch(() => null);
  const parsed = createWatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const run = await prisma.run.findUnique({
    where: { publicId: parsed.data.runId },
    select: {
      id: true,
      appSlug: true,
      targetUrl: true,
      testEmail: true,
      testPasswordEnc: true,
      notifyEmail: true,
    },
  });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const watch = await prisma.watch.upsert({
    where: { appSlug: run.appSlug },
    create: {
      appSlug: run.appSlug,
      targetUrl: run.targetUrl,
      frequency: parsed.data.frequency,
      notifyOnChangeOnly: parsed.data.notifyOnChangeOnly,
      notifyEmail: run.notifyEmail,
      testEmail: run.testEmail,
      testPasswordEnc: run.testPasswordEnc,
      nextRunAt: nextRunFrom(parsed.data.frequency),
    },
    update: {
      active: true,
      frequency: parsed.data.frequency,
      notifyOnChangeOnly: parsed.data.notifyOnChangeOnly,
      nextRunAt: nextRunFrom(parsed.data.frequency),
    },
  });

  // Link the source run to the watch so it becomes the baseline.
  await prisma.run.update({ where: { id: run.id }, data: { watchId: watch.id } });

  return NextResponse.json({ slug: watch.appSlug }, { status: 201 });
}
