// Creating a run from a submission and handing it to the agent — the one
// path, shared by the free form (/api/checks) and the paid one-off check
// (src/lib/one-check.ts). Everything that decides WHETHER a run may start —
// Turnstile, quotas, the same-domain reuse — stays with the caller; this is
// only what happens once that is settled.

import type { PrismaClient } from "@/generated/prisma/client";
import { nextRunNumber } from "@/lib/db";
import { triggerRun } from "@/lib/trigger";
import { encryptSecret } from "@/lib/crypto";
import { appSlugFromUrl } from "@/lib/utils";
import type { CreateCheckInput } from "@/lib/validation";

export interface StartCheckOptions {
  // The validated submission (createCheckSchema output).
  input: CreateCheckInput;
  // Attribution: a signed-in owner, or the anonymous client's salted IP hash.
  ownerId: string | null;
  anonKeyHash: string | null;
  // A paid one-off check: the Stripe Checkout Session that paid for it. The
  // column is unique, so a second start on the same payment fails at the
  // insert instead of producing a second run.
  paid?: { checkoutSessionId: string };
}

export interface StartCheckDeps {
  // Hands the queued run to the agent. Injectable so the start can be verified
  // without a Workflow binding or an agent worker.
  trigger: (runId: string) => Promise<void>;
}

export interface StartedCheck {
  id: string;
  publicId: string;
}

export async function startCheck(
  db: PrismaClient,
  opts: StartCheckOptions,
  deps: StartCheckDeps = { trigger: triggerRun },
): Promise<StartedCheck> {
  const { input } = opts;
  const run = await db.run.create({
    data: {
      runNumber: await nextRunNumber(db),
      targetUrl: input.url,
      appSlug: appSlugFromUrl(input.url),
      testEmail: input.testEmail || null,
      testPasswordEnc: input.testPassword ? encryptSecret(input.testPassword) : null,
      scopeHints: input.scopeHints || null,
      userNotes: input.userNotes || null,
      notifyEmail: input.notifyEmail || null,
      // Deploy identity (CHE-56) — set by CI so the verdict names a build.
      deploySha: input.deploy?.sha ?? null,
      deployEnv: input.deploy?.env || null,
      ownerId: opts.ownerId,
      anonKeyHash: opts.anonKeyHash,
      paidCheckoutSessionId: opts.paid?.checkoutSessionId ?? null,
      status: "queued",
    },
    select: { id: true, publicId: true },
  });

  await deps.trigger(run.id);
  return run;
}
