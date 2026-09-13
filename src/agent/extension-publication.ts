import type { AppLens } from "@/lib/types";
import type { StepStatus, Verdict } from "@/lib/enums";
import type { ExtensionSession } from "./extension-contract";
import { extensionCleanupComplete } from "./extension-contract";
import type { ExtensionFinalEvidence } from "./extension-evidence";
import { putText, type AgentEnv } from "./env";
import { emptyUsage } from "./llm";
import type { SynthesizedFinding } from "./synthesis";

export const JOBLANDER_EXTENSION_ID = "hafhjepjihcimcljkdphpinannbdmnhf";

export interface ExtensionPublicStep {
  label: string;
  status: StepStatus;
  attempted: string;
  observed: string;
  unverifiedReason?: "our_capability" | "missing_access";
  gapClass?: string;
}

export interface ExtensionPublicObservation {
  scenario: string;
  session: boolean;
  steps: ExtensionPublicStep[];
  summary: string;
}

const scenarioNames: Record<string, string> = {
  interview: "Interview assistance",
  practice: "AI practice",
  "practice-extension": "Practice with interview assistance",
};

export function publicExtensionObservation(
  identity: ExtensionSession,
  final: ExtensionFinalEvidence,
  accounting: ExtensionPublicStep | null,
  productFailure: boolean,
): ExtensionPublicObservation | null {
  if (identity.extensionId !== JOBLANDER_EXTENSION_ID || !final.disposed || !final.session || final.session.runtimeFailure || !extensionCleanupComplete(final.session)) return null;
  const state = final.session;
  const scenario = identity.scenario ?? "interview";
  const name = scenarioNames[scenario];
  const session = Boolean(state.sessions?.length);
  const accountRead = state.accountBaseline?.source === "account-ui" && Number.isSafeInteger(state.accountBaseline.balance);
  const steps: ExtensionPublicStep[] = [];
  const readStep = (label: string, confirmed: boolean, observed: string): ExtensionPublicStep => ({
    label, status: confirmed ? "ok" : "skipped", attempted: label + ".",
    observed: confirmed ? observed : "This account action was not verified in this journey.",
    ...(!confirmed ? { unverifiedReason: "our_capability" as const, gapClass: "extension_runtime" } : {}),
  });
  if (!session) {
    steps.push(readStep("Sign in to the extension", identity.popupSignedIn === true,
      "The signed-in extension controls were visible."));
    steps.push(readStep("Read the account's minutes and history", accountRead,
      "The account's available minutes and session history were visible."));
    return { scenario, session, steps, summary: "This journey checked sign-in and account information. It did not start a session." };
  }
  steps.push(readStep("Read the account before the session", accountRead,
    "The account's available minutes and session history were visible before starting."));
  const response = state.productResult?.confirmed === true;
  steps.push({ label: "Session response", status: productFailure ? "broken" : response ? "ok" : "skipped",
    attempted: `Start ${name.toLowerCase()} and receive a response.`,
    observed: productFailure ? `${name} displayed an error during the session.` : response
      ? scenario === "practice-extension" ? "The practice coach responded and interview assistance returned a new answer."
        : scenario === "practice" ? "The practice coach gave a new response after the candidate's answer."
          : "Interview assistance returned a new answer for the interview question."
      : "A response was not verified during this session.",
    ...(!response && !productFailure ? { unverifiedReason: "our_capability" as const, gapClass: "extension_runtime" } : {}),
  });
  steps.push({ label: "End the session", status: "ok", attempted: `End ${name.toLowerCase()}.`,
    observed: "The session controls confirmed Stop, and the account balance stayed unchanged for at least one minute afterwards." });
  if (accounting) steps.push(accounting);
  return { scenario, session, steps, summary: productFailure ? `${name} displayed an error. The session was stopped.`
    : response ? `${name} produced a new response and stopped. The minute-usage checks below describe which charges were confirmed.`
      : `${name} stopped. A response was not verified during this session.` };
}

const appLens: AppLens = {
  oneLiner: "JobLander provides interview assistance and AI interview practice.",
  whoFor: "Job candidates preparing for interviews and taking live interviews.",
  coreValue: "Responses during interviews and feedback during practice.",
  businessModel: "Interview assistance and practice use the account's available minutes.",
  techSurface: "Extension popup, interview-assistance panel, practice and account pages.",
  criticalPaths: ["Extension sign-in", "Interview assistance", "AI practice", "Practice with interview assistance", "Session Stop and minute usage"],
  ifItBreaks: "Candidates can lose assistance during an interview or use minutes without receiving the expected help.",
};

export interface PublicationPhase {
  scenario: string;
  ownedSessions: number | null;
  cleanupComplete: boolean;
  productResultConfirmed: boolean;
  sustainedSessionsObserved: boolean;
  productFailureObserved: boolean;
  productFailureSignature?: string | null;
  publicObservation?: ExtensionPublicObservation | null;
}

export async function preservedExtensionGaps(env: AgentEnv, runId: string) {
  const original = await env.db.step.findMany({ where: { journey: { runId }, unverifiedReason: { in: ["our_capability", "missing_access"] } },
    select: { journeyId: true, gapClass: true, label: true, attempted: true, observed: true, unverifiedReason: true, actions: true } });
  if (original.length) await putText(env, `private/runs/${runId}/checker-gaps.json`, JSON.stringify(original));
  const byJourney = new Map<string, ExtensionPublicStep[]>();
  for (const gap of original) {
    const steps = byJourney.get(gap.journeyId) ?? [];
    const missing = gap.unverifiedReason === "missing_access";
    const gapClass = missing ? undefined : gap.gapClass ?? "unclassified";
    if (!steps.some(step => step.gapClass === gapClass && step.unverifiedReason === gap.unverifiedReason)) steps.push({ label: "Additional controls", status: "skipped",
      attempted: "Check the journey's additional controls.", observed: missing ? "Additional account access or session permission is needed for these controls." : "The journey's additional controls were not fully verified.",
      unverifiedReason: missing ? "missing_access" : "our_capability", gapClass });
    byJourney.set(gap.journeyId, steps);
  }
  return byJourney;
}

// A model's empty-panel complaint survived the old findings gate in Run 4,
// even though those journeys had no session permission. Its bottom line also
// retained a discarded billing allegation and copied resume details. Public
// claims now come from the executor's observations; the full walk stays private.
export async function prepareExtensionPublication(env: AgentEnv, runId: string, rawEvidence: string) {
  const evidence = JSON.parse(rawEvidence) as { identity?: { extensionId?: string }; phases?: Record<string, PublicationPhase> };
  if (evidence.identity?.extensionId !== JOBLANDER_EXTENSION_ID) return null;
  const preserved = await preservedExtensionGaps(env, runId);
  const journeys = await env.db.journey.findMany({ where: { runId }, orderBy: { order: "asc" }, select: { id: true, order: true, title: true } });
  const reports = journeys.map(journey => {
    const phase = evidence.phases?.[`walk-${journey.order}`];
    if (!phase?.cleanupComplete || !phase.publicObservation) throw new Error("internal: extension publication has no verified observation for a journey");
    const report = { ...phase.publicObservation, steps: [...phase.publicObservation.steps] };
    const extra = (preserved.get(journey.id) ?? []).filter(gap => !report.steps.some(step => step.status === "skipped" && step.gapClass === gap.gapClass && step.unverifiedReason === gap.unverifiedReason));
    report.steps.push(...extra);
    if (extra.length) report.summary += " Additional controls were not fully verified.";
    return { journey, phase, report };
  });
  if (!reports.length) throw new Error("internal: extension publication has no journeys");
  for (const scenario of Object.keys(scenarioNames)) {
    if (!reports.some(({ phase, report }) => phase.scenario === scenario && report.scenario === scenario && report.session &&
      (phase.productFailureObserved || phase.productResultConfirmed && phase.sustainedSessionsObserved && phase.ownedSessions === (scenario === "practice-extension" ? 2 : 1)))) {
      throw new Error("internal: extension publication cannot establish all three session outcomes");
    }
  }
  const findings: SynthesizedFinding[] = [];
  await env.db.step.deleteMany({ where: { journey: { runId } } });
  for (const [index, { journey, phase, report }] of reports.entries()) {
    for (const [order, step] of report.steps.entries()) {
      await env.db.step.create({ data: { journeyId: journey.id, order, ...step } });
      if (step.status === "broken" && phase.productFailureObserved) findings.push({
        errorSignature: phase.productFailureSignature ?? undefined,
        title: `${scenarioNames[report.scenario]} displayed a session error`, category: "broken", severity: "high",
        detail: { where: scenarioNames[report.scenario], whatWeTried: [step.attempted], whatHappened: step.observed,
          whyItMatters: "Restore responses during active sessions so candidates receive the assistance they started the session for." },
        stepRef: { journeyIndex: index, stepIndex: order },
      });
    }
    const status = report.steps.some(s => s.status === "broken") ? "broken"
      : report.steps.some(s => s.status === "skipped") ? "partial" : "ok";
    await env.db.journey.update({ where: { id: journey.id }, data: { status, summary: report.summary } });
  }
  const incomplete = reports.filter(r => r.report.steps.some(s => s.status === "skipped"));
  const minuteGaps = reports.filter(r => r.report.steps.some(s => s.gapClass === "extension_minute_accounting"));
  const otherGaps = incomplete.filter(r => r.report.steps.some(s => s.status === "skipped" && s.gapClass !== "extension_minute_accounting"));
  const verdict: Verdict = findings.length ? "broken" : incomplete.length ? "mostly_ok" : "all_good";
  const bottomLine = [findings.length ? "A session displayed an error. All started sessions were stopped."
    : "Interview assistance, AI practice and their combined use produced new responses and stopped as expected.",
    minuteGaps.length ? `Minute-by-minute charges and final rounding were not confirmed for ${minuteGaps.map(r => scenarioNames[r.report.scenario].toLowerCase()).join(" and ")}.` : "Session minute usage and the unchanged balance after Stop were confirmed.",
    otherGaps.length ? "Some additional extension and account controls remain unverified." : "",
  ].filter(Boolean).join(" ");
  return { appLens, verdict, bottomLine, findings, costUsd: 0, usage: emptyUsage(),
    partial: incomplete.length > 0, audit: { identity: evidence.identity, journeys: reports.map(r => ({ title: r.journey.title, ...r.report })) } };
}
