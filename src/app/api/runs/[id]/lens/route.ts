import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { canMutateOwned } from "@/lib/auth";
import { updateLensSchema } from "@/lib/validation";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";

// PATCH /api/runs/{publicId}/lens — Loop C: user edits the App Lens or reacts
// to it. The next Daily Watch run reads the corrected Lens + feedback.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CHE-193: our own checker never marks a lens. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const prisma = await getDbFromContext();
  const json = await req.json().catch(() => null);
  const parsed = updateLensSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const run = await prisma.run.findUnique({
    where: { publicId: (await params).id },
    select: { id: true, ownerId: true },
  });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (!(await canMutateOwned(prisma, run.ownerId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const updated = await prisma.run.update({
    where: { id: run.id },
    data: {
      ...(parsed.data.lens !== undefined && { appLens: JSON.stringify(parsed.data.lens) }),
      ...(parsed.data.feedback !== undefined && { lensFeedback: parsed.data.feedback }),
    },
    select: { appLens: true, lensFeedback: true },
  });

  return NextResponse.json(updated);
}
