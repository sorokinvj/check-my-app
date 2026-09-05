import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { getOwnerFromRequest } from "@/lib/auth";
import { hashClientKey } from "@/lib/crypto";
import { assertCanStartRun } from "@/lib/plans";
import { startCheck } from "@/lib/start-check";
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

  // Anonymous same-domain reuse (CHE-80). Six anonymous example.com runs in 30
  // minutes (2026-08-26, distributed IPs) each burned real LLM spend on a
  // target we had just verified. Anonymous runs are public anyway (owner call,
  // CHE-39), so an anon re-submission of a domain with a fresh completed
  // verdict gets that verdict instead of a new run. Owners always get a real
  // run — they may be testing a deploy that just went out.
  if (!owner) {
    const fresh = await prisma.run.findFirst({
      where: {
        appSlug: appSlugFromUrl(input.url),
        status: "completed",
        completedAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
      },
      orderBy: { completedAt: "desc" },
      select: { publicId: true },
    });
    if (fresh) {
      return NextResponse.json({ id: fresh.publicId, reused: true }, { status: 200 });
    }
  }

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

  // Insert + hand-off to the agent, shared with the paid one-off check.
  const run = await startCheck(prisma, { input, ownerId: owner?.id ?? null, anonKeyHash });

  // The /run/{id} URL uses the unguessable public id.
  return NextResponse.json({ id: run.publicId }, { status: 201 });
}
