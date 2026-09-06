import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { canMutateOwned, getOptionalUser } from "@/lib/auth";
import { markFindingSchema } from "@/lib/validation";

// PATCH /api/findings/{id} — Loop C: triage a finding from the verdict page
// (known / fixed / false_positive). Daily Check uses marks to filter noise.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const json = await req.json().catch(() => null);
  const parsed = markFindingSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const existing = await prisma.finding.findUnique({
    where: { id: (await params).id },
    select: { id: true, run: { select: { ownerId: true } } },
  });
  if (!existing) return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  if (!(await canMutateOwned(prisma, existing.run.ownerId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const user = await getOptionalUser(prisma);
  const finding = await prisma.finding.update({
    where: { id: existing.id },
    data: {
      mark: parsed.data.mark,
      markedById: user?.id ?? null,
      markedAt: new Date(),
    },
    select: { id: true, mark: true, markedById: true, markedAt: true },
  });
  return NextResponse.json(finding);
}
