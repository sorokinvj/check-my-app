// The verdict-ready email, and the two gates in front of it (CHE-156).
//
// Lifted out of workflow.ts unchanged except for the first gate. workflow.ts
// imports `cloudflare:workers`, so nothing in it can be driven on plain Node;
// the silence rule is the one thing in this file that must be provable without
// a Workers runtime, and scripts/verify-self-check-silence.ts drives the real
// `notifyVerdictReady` below rather than a copy of it.
//
// ─── Why the silence gate reads the TARGET and not the account ───────────────
//
// CLAUDE.md §6 promises a self-check is silent. Until CHE-156 that promise was
// keyed on `User.isTestAccount`, and the app the rule was written for —
// checkmyapp.dev — belongs to the owner's ordinary account (isTestAccount = 0).
// The key never matched the object. On 2026-09-07 run #156 published verdict
// `broken` about a sign-in page our own checker had broken (CHE-212) and mailed
// the owner about it; 29 of the 30 checkmyapp.dev runs in production carried a
// notifyEmail, so that was the rule, not the exception.
//
// The marker is a property of the target, and the mechanism that answers "is
// this ours" already exists: isSelfUrl (self-hosts.ts, CHE-193), the same list
// the browser context, the click gate and the read-only guard consult, extended
// by the SELF_CHECK_HOSTS binding so a preview host is covered without a
// deploy. One fact, one source.
//
// The test-account gate stays beside it rather than being replaced. It answers
// a different question — the placeholder apps the self-check registers
// (example.com, test-app-*) are not on our hosts and are swept by the janitor —
// and dropping it would put those back in the owner's inbox.
//
// Consequence worth stating out loud, because it is a choice and not an
// oversight: an anonymous visitor who runs a free public check of
// checkmyapp.dev and leaves an address gets no mail either. The verdict page is
// still public and still theirs to read. Production has never seen such a run
// (0 of 30 checkmyapp.dev runs are ownerless), and the alternative — "ours,
// unless a stranger asked" — reintroduces exactly the account-shaped reasoning
// this ticket exists to remove.

import { sendVerdictReady } from "@/lib/email";
import type { Verdict } from "@/lib/enums";
import { isSelfUrl } from "./self-hosts";
import type { AgentBindings, AgentEnv } from "./env";

export interface NotifiableRun {
  publicId: string;
  appSlug: string;
  targetUrl: string;
  notifyEmail: string | null;
  watchId: string | null;
  baselineRunId: string | null;
}

// Why this run stays quiet, in the words the run feed and the log line use.
// null = there is nothing self-check about it and the mail goes out.
export type SilenceReason = "our own product" | "a self-check account";

// The whole rule, as a pure function, so it can be asserted directly and so the
// log line and the decision cannot drift apart.
export function silenceReason(input: {
  targetUrl: string;
  ownedByTestAccount: boolean;
  selfCheckHosts?: string;
}): SilenceReason | null {
  if (isSelfUrl(input.targetUrl, input.selfCheckHosts)) return "our own product";
  if (input.ownedByTestAccount) return "a self-check account";
  return null;
}

// Shared by the full run and the replay-first pass. Non-fatal by construction:
// a notification failure must never fail a completed run.
export async function notifyVerdictReady(
  env: AgentEnv,
  bindings: AgentBindings,
  run: NotifiableRun,
  verdict: Verdict | null,
): Promise<void> {
  if (!run.notifyEmail) return;
  // CHE-105/CHE-156: self-checks are silent. A run of our own product exists so
  // CheckMyApp can check itself; the person running the business must be able
  // to forget it exists. Its results live on the verdict page, where they can be
  // looked at deliberately — they never arrive in anyone's inbox.
  const silent = silenceReason({
    targetUrl: run.targetUrl,
    ownedByTestAccount: await ownedByTestAccount(env, run.publicId),
    selfCheckHosts: bindings.SELF_CHECK_HOSTS,
  });
  if (silent) {
    // The reason is named so the next operator reading the feed sees a decision
    // rather than a delivery that failed quietly.
    console.log(
      `[notify] run ${run.publicId} checks ${silent} — staying silent (self-check, CLAUDE.md §6)`,
    );
    return;
  }
  if (run.watchId && !(await watchWantsNotice(env, run.watchId, run.baselineRunId, verdict))) {
    return;
  }
  // CHE-96: carry the answer into the mail. Read back rather than threaded
  // through, because both callers (smoke shortcut and full run) reach here at
  // different points, and the row is the single source of truth by now.
  const written = await env.db.run.findUnique({
    where: { publicId: run.publicId },
    select: {
      bottomLine: true,
      findings: { select: { category: true }, where: { mark: { not: "false_positive" } } },
    },
  });
  const findings = written?.findings ?? [];
  await sendVerdictReady({
    to: run.notifyEmail,
    appSlug: run.appSlug,
    publicId: run.publicId,
    verdict,
    recurring: Boolean(run.watchId),
    bottomLine: written?.bottomLine ?? null,
    findingCounts: {
      total: findings.length,
      broken: findings.filter((f) => f.category === "broken" || f.category === "exposed").length,
    },
    apiKey: bindings.EMAIL_API_KEY,
    from: bindings.EMAIL_FROM,
    baseUrl: bindings.APP_URL,
  }).catch((err) => {
    console.warn(`[notify] verdict email failed: ${err instanceof Error ? err.message : err}`);
  });
}

async function ownedByTestAccount(env: AgentEnv, publicId: string): Promise<boolean> {
  const row = await env.db.run.findUnique({
    where: { publicId },
    select: { owner: { select: { isTestAccount: true } } },
  });
  return Boolean(row?.owner?.isTestAccount);
}

// notifyOnChangeOnly means the owner only wants to hear from a recurring watch
// when something moved: the verdict differs from the baseline this run was
// diffed against. No baseline = first run of the watch = always worth sending.
async function watchWantsNotice(
  env: AgentEnv,
  watchId: string,
  baselineRunId: string | null,
  verdict: string | null,
): Promise<boolean> {
  const watch = await env.db.watch.findUnique({
    where: { id: watchId },
    select: { notifyOnChangeOnly: true },
  });
  if (!watch?.notifyOnChangeOnly) return true;
  if (!baselineRunId) return true;
  const baseline = await env.db.run.findUnique({
    where: { id: baselineRunId },
    select: { verdict: true },
  });
  return !baseline || baseline.verdict !== verdict;
}
