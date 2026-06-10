import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enqueueRun } from "@/lib/queue";
import { encryptSecret } from "@/lib/crypto";
import { appSlugFromUrl } from "@/lib/utils";
import { createCheckSchema } from "@/lib/validation";

// POST /api/checks — create a run from a submission and enqueue it.
export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = createCheckSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const input = parsed.data;

  const run = await prisma.run.create({
    data: {
      targetUrl: input.url,
      appSlug: appSlugFromUrl(input.url),
      testEmail: input.testEmail || null,
      testPasswordEnc: input.testPassword ? encryptSecret(input.testPassword) : null,
      userNotes: input.userNotes || null,
      notifyEmail: input.notifyEmail || null,
      status: "queued",
    },
    select: { id: true, publicId: true },
  });

  await enqueueRun(run.id);

  // The /run/{id} URL uses the unguessable public id.
  return NextResponse.json({ id: run.publicId }, { status: 201 });
}
