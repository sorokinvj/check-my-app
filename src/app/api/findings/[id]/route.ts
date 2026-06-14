import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
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

  const finding = await prisma.finding
    .update({
      where: { id: (await params).id },
      data: { mark: parsed.data.mark },
      select: { id: true, mark: true },
    })
    .catch(() => null);

  if (!finding) return NextResponse.json({ error: "Finding not found" }, { status: 404 });
  return NextResponse.json(finding);
}
