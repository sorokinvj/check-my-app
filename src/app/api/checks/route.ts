import { NextResponse } from "next/server";
import { getDbFromContext, nextRunNumber } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";
import { triggerRun } from "@/lib/trigger";
import { encryptSecret } from "@/lib/crypto";
import { appSlugFromUrl } from "@/lib/utils";
import { createCheckSchema } from "@/lib/validation";
import { verifyTurnstile } from "@/lib/turnstile";

// POST /api/checks — create a run from a submission and trigger it.
export async function POST(req: Request) {
  const prisma = await getDbFromContext();
  const json = (await req.json().catch(() => null)) as { turnstileToken?: string } | null;

  // Bot protection (enforced only when TURNSTILE_SECRET is configured).
  const ok = await verifyTurnstile(
    json?.turnstileToken,
    req.headers.get("cf-connecting-ip") ?? undefined,
  );
  if (!ok) {
    return NextResponse.json({ error: "Verification failed — please retry." }, { status: 403 });
  }

  const parsed = createCheckSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const input = parsed.data;

  // Attribute the run to the signed-in owner (if any) so it's tenant-scoped and
  // shows on their dashboard; anonymous free-run funnel keeps ownerId null.
  const owner = await getOptionalUser(prisma);

  const run = await prisma.run.create({
    data: {
      runNumber: await nextRunNumber(prisma),
      targetUrl: input.url,
      appSlug: appSlugFromUrl(input.url),
      testEmail: input.testEmail || null,
      testPasswordEnc: input.testPassword ? encryptSecret(input.testPassword) : null,
      userNotes: input.userNotes || null,
      notifyEmail: input.notifyEmail || null,
      ownerId: owner?.id ?? null,
      status: "queued",
    },
    select: { id: true, publicId: true },
  });

  await triggerRun(run.id);

  // The /run/{id} URL uses the unguessable public id.
  return NextResponse.json({ id: run.publicId }, { status: 201 });
}
