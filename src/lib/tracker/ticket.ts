import type { TicketDraft } from "./types";

// What the watch-diff (CHE-25, agent worker) must hand us for each 🔴 regression.
// Kept minimal and mapped onto the existing Finding/Journey/Step shapes — this is
// the producer↔ticket contract; CHE-25 fills it.
export interface Regression {
  journeyTitle: string;
  failingStep: string; // exact failing step, e.g. "step 4 'Start session' is a no-op"
  failureSignature: string; // observed error / console / status — drives dedup
  isCriticalJourney: boolean; // → Urgent vs High
  baselineDiff: string; // what regressed vs the last good run
  repro: string; // runnable Playwright spec source OR precise click-path
  evidenceUrls: string[]; // screenshot / console / network excerpts (R2)
}

export interface TicketContext {
  runNumber: number;
  runPublicId: string;
  startedAtIso: string;
  appSlug: string;
  verdictUrl: string;
  // From the owner's TicketPolicy.
  pickupLabels: string[];
  repoLabel: string | null;
  provenanceLabel: string;
  state: string;
  titleFormat: string;
}

// Compose a Contract-v1-shaped ticket. A frontend journey regression has NO
// server-log signature, so the repro (a runnable spec / click-path) IS the
// signature the consumer's dispatcher reproduces before fixing.
export function buildTicketDraft(r: Regression, ctx: TicketContext): TicketDraft {
  const oneLine = `${r.journeyTitle}: ${r.failingStep}`;
  const title = ctx.titleFormat.replace("{verdict}", oneLine);

  const labelNames = [...ctx.pickupLabels, ctx.repoLabel, ctx.provenanceLabel].filter(
    (l): l is string => Boolean(l),
  );

  const description = [
    `**Origin:** CheckMyApp Daily Watch — run #${ctx.runNumber} (${ctx.runPublicId}) at ${ctx.startedAtIso}`,
    `**Surface / repo:** ${ctx.appSlug}${ctx.repoLabel ? ` / ${ctx.repoLabel.replace(/^repo:\s*/, "")}` : ""}`,
    "",
    `**Journey + failing step:** ${r.journeyTitle} → ${r.failingStep}`,
    "",
    "**Reproduction** — frontend regression, no GCP/server-log signature; repro is the signature:",
    "```ts",
    r.repro,
    "```",
    "",
    `**Baseline diff:** ${r.baselineDiff}`,
    "",
    "**Evidence:**",
    `- Verdict: ${ctx.verdictUrl}`,
    ...r.evidenceUrls.map((u) => `- ${u}`),
  ].join("\n");

  return {
    title,
    description,
    labelNames,
    stateName: ctx.state,
    priority: r.isCriticalJourney ? 1 : 2,
  };
}
