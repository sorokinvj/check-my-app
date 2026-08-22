import { NextResponse } from "next/server";
import { getDbFromContext, nextRunNumber } from "@/lib/db";
import { getOwnerFromRequest } from "@/lib/auth";
import { triggerRun } from "@/lib/trigger";
import { encryptSecret, hashClientKey } from "@/lib/crypto";
import { assertCanStartRun } from "@/lib/plans";
import { appSlugFromUrl } from "@/lib/utils";
import { createCheckSchema } from "@/lib/validation";
import { verifyTurnstile } from "@/lib/turnstile";
import type { UserPlan } from "@/lib/enums";

// POST /api/checks — create a run from a submission and trigger it.
export async function POST(req: Request) {
  const prisma = await getDbFromContext();
  const json = (await req.json().catch(() => null)) as { turnstileToken?: string } | null;
  const clientIp = req.headers.get("cf-connecting-ip");

  // Attribute the run to the caller (if any) so it's tenant-scoped and shows on
  // their dashboard: a Clerk session or an owner API key (CHE-52). Anonymous
  // free-run funnel keeps ownerId null.
  const auth = await getOwnerFromRequest(prisma, req);
  const owner = auth?.user ?? null;

  // Bot protection (enforced only when TURNSTILE_SECRET is configured).
  // API-key callers are machine-to-machine (CI hooks, MCP clients) — a valid
  // key already proves they're a real account, and they can't run a browser
  // Turnstile challenge, so the check applies to browser paths only.
  if (auth?.via !== "api_key") {
    const ok = await verifyTurnstile(json?.turnstileToken, clientIp ?? undefined);
    if (!ok) {
      return NextResponse.json({ error: "Verification failed — please retry." }, { status: 403 });
    }
  }

  const parsed = createCheckSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const input = parsed.data;

  // Run quota (CHE-40). Checked after Turnstile so bot floods never burn a real
  // client's allowance, and before the insert so a rejected run is never billed.
  const anonKeyHash = owner ? null : await hashClientKey(clientIp);
  const gate = await assertCanStartRun(
    prisma,
    owner ? { id: owner.id, plan: owner.plan as UserPlan } : null,
    anonKeyHash,
  );
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason, code: gate.code }, { status: 429 });
  }

  const run = await prisma.run.create({
    data: {
      runNumber: await nextRunNumber(prisma),
      targetUrl: input.url,
      appSlug: appSlugFromUrl(input.url),
      testEmail: input.testEmail || null,
      testPasswordEnc: input.testPassword ? encryptSecret(input.testPassword) : null,
      scopeHints: input.scopeHints || null,
      userNotes: input.userNotes || null,
      notifyEmail: input.notifyEmail || null,
      ownerId: owner?.id ?? null,
      anonKeyHash,
      status: "queued",
    },
    select: { id: true, publicId: true },
  });

  await triggerRun(run.id);

  // The /run/{id} URL uses the unguessable public id.
  return NextResponse.json({ id: run.publicId }, { status: 201 });
}
