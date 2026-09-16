import type { AgentEnv } from "./env";
import { createHash } from "node:crypto";
import { assertExtensionIdentity, extensionCleanupComplete, type ExtensionIdentity, type ExtensionSession, type ExtensionTarget } from "./extension-contract";
import { parseExtensionLink, readExtensionOptions } from "@/lib/extension-target";
import { publicExtensionObservation, preservedExtensionGaps } from "./extension-publication";
import { putText } from "./env";

export interface ExtensionFinalEvidence { disposed: boolean; session?: ExtensionSession }

export async function completeExtensionAccessCheck(env: AgentEnv, runId: string, costUsd: number): Promise<"unverified"> {
  const preserved = await preservedExtensionGaps(env, runId);
  await env.db.step.deleteMany({ where: { journey: { runId } } });
  await env.db.journey.updateMany({ where: { runId }, data: { status: "skipped", summary: "Session checks need test-account access and permission to start and stop sessions." } });
  for (const [journeyId, steps] of preserved) {
    for (const [order, step] of steps.entries()) await env.db.step.create({ data: { journeyId, order, ...step } });
  }
  await env.db.run.update({ where: { id: runId }, data: {
    status: "partial", verdict: "unverified", errorMessage: null,
    bottomLine: "Session checks need test-account access and permission to start and stop sessions. Add these in your extension settings to check interview assistance, practice and their combined use.",
    currentAction: null, completedAt: new Date(), costUsd,
  } });
  return "unverified";
}

export function extensionProductFailureStep(final: ExtensionFinalEvidence) {
  const failure = final.session?.productResult?.failure;
  if (!final.disposed || !final.session || final.session.runtimeFailure || !extensionCleanupComplete(final.session) || failure?.source !== "visible-product-alert") return null;
  return { label: "Session response", status: "broken" as const,
    attempted: "Receive a response during the session.", observed: `The session displayed an error: ${failure.text}` };
}

export function extensionAccountingStep(final: ExtensionFinalEvidence) {
  const session = final.session;
  const accounting = session?.billing?.assessment;
  if (!final.disposed || !session || !session.sessions?.length) return null;
  // A phase whose cleanup could not be confirmed knows LESS than one whose
  // minutes could not be confirmed — and until now it recorded MORE. The step
  // was omitted entirely, so the journey rolled up on the model's own steps
  // and landed "ok": run #194's two-meter walk sits in the catalog as ok with
  // its cleanup unverified. The worse case cannot read better than the milder
  // one, so it gets a step of its own and the gap that belongs to it.
  if (!extensionCleanupComplete(session)) {
    return { label: "Session minutes", status: "skipped" as const, unverifiedReason: "our_capability" as const, gapClass: "extension_session_cleanup",
      attempted: "End the session and check what it charged.",
      observed: "Whether this session stopped charging, and what it finally charged, were not established." };
  }
  if (accounting?.status !== "confirmed" || !accounting.twoMinuteSteps || !Number.isSafeInteger(accounting.observedMinutes) || !accounting.sessions?.length) {
    return { label: "Session minutes", status: "skipped" as const, unverifiedReason: "our_capability" as const, gapClass: "extension_minute_accounting",
      attempted: "Check minute-by-minute charges and each session's final rounding.",
      observed: "The sessions ended and the balance settled. Minute-by-minute charges and final rounding were not confirmed." };
  }
  const durations = accounting.sessions.map(row => `${row.durationSeconds} seconds`).join(" and ");
  return { label: "Session minutes", status: "ok" as const,
    attempted: "End the session and check its minute usage.",
    observed: `${accounting.observedMinutes} minutes were used for the session${accounting.sessions.length === 1 ? "" : "s"} lasting ${durations}. Charging stopped when the session did.` };
}

export function extensionPhaseEvidence(phase: string, identity: ExtensionSession, final: ExtensionFinalEvidence) {
  if (final.session) {
    assertExtensionIdentity(final.session, identity);
    if (final.session.ownerRunId !== identity.ownerRunId || final.session.sessionId !== identity.sessionId) throw new Error("Extension evidence belongs to another attempt");
  }
  return {
    phase, scenario: identity.scenario ?? "interview", ownerRunId: identity.ownerRunId, sessionId: identity.sessionId,
    artifactUrl: `/api/evidence/private/extensions/${encodeURIComponent(identity.ownerRunId)}/phase.json`,
    disposed: final.disposed,
    cleanupComplete: Boolean(final.disposed && final.session && !final.session.runtimeFailure && extensionCleanupComplete(final.session)),
    applicationCleanup: final.session?.applicationCleanup ?? "unverified",
    billingCleanup: final.session?.billingCleanup ?? "unverified",
    ownedSessions: final.session?.sessions?.length ?? null,
    runtimeFailure: final.session?.runtimeFailure?.kind ?? null,
    productResultConfirmed: final.session?.productResult?.confirmed === true,
    productFailureObserved: Boolean(extensionProductFailureStep(final)),
    productFailureSignature: extensionProductFailureStep(final) ? createHash("sha256").update(JSON.stringify([
      identity.scenario ?? "interview", final.session?.productResult?.failure?.surface,
      final.session?.productResult?.failure?.text.trim().toLowerCase().replace(/\s+/g, " "),
    ])).digest("hex") : null,
    twoMinuteStepsObserved: final.session?.billing?.assessment?.twoMinuteSteps === true,
    // What the person watching the screen would have seen move after the
    // product told them the session had stopped, and how long it took to come
    // to rest. The session stopping and the figure settling are two different
    // moments, and only the first one is announced.
    chargedAfterStop: Number.isSafeInteger(final.session?.billing?.assessment?.postStopChange) ? final.session!.billing!.assessment!.postStopChange! : null,
    chargeSettledMs: Number.isSafeInteger(final.session?.billing?.assessment?.postStopSettledMs) ? final.session!.billing!.assessment!.postStopSettledMs! : null,
    sustainedSessionsObserved: Boolean(final.session?.sessions?.length && final.session.sessions.every(s => s.startedAt && s.cleanup?.stopClickedAt && s.cleanup.stopClickedAt - s.startedAt >= 120_000)),
    publicObservation: publicExtensionObservation(identity, final, extensionAccountingStep(final), Boolean(extensionProductFailureStep(final))),
  };
}

export function extensionCoverageGap(run: ExtensionTarget, raw: string | null | undefined): "missing_access" | "our_capability" | null {
  if ((run.extensionId ?? parseExtensionLink(run.targetUrl)?.id) !== "hafhjepjihcimcljkdphpinannbdmnhf") return null;
  if (!run.testEmail || !run.testPasswordEnc || !readExtensionOptions(run.extensionConfig).allowSessions) return "missing_access";
  try {
    const evidence = JSON.parse(raw ?? "{}") as { phases?: Record<string, ReturnType<typeof extensionPhaseEvidence>> };
    const results = Object.entries(evidence.phases ?? {}).filter(([phase, result]) => phase.startsWith("walk-") && result.cleanupComplete).map(([, result]) => result);
    if (["interview", "practice", "practice-extension"].every(scenario => results.some(result => result.scenario === scenario &&
      (result.productFailureObserved || result.productResultConfirmed && result.sustainedSessionsObserved && result.ownedSessions === (scenario === "practice-extension" ? 2 : 1))))) return null;
  } catch { /* Incomplete provenance cannot establish the core flow. */ }
  return "our_capability";
}

export async function persistExtensionPhase(env: AgentEnv, runId: string, phase: string, identity: ExtensionSession, final: ExtensionFinalEvidence): Promise<void> {
  const row = await env.db.run.findUnique({ where: { id: runId }, select: { extensionEvidence: true } });
  const previous = row?.extensionEvidence ? JSON.parse(row.extensionEvidence) as { identity?: ExtensionIdentity; phases?: Record<string, unknown> } : {};
  assertExtensionIdentity(identity, previous.identity);
  const result = extensionPhaseEvidence(phase, identity, final);
  const evidence = {
    identity: { name: identity.name, extensionId: identity.extensionId, packageVersion: identity.packageVersion, installedVersion: identity.installedVersion, artifactSha256: identity.artifactSha256 },
    phases: { ...previous.phases, [phase]: result },
  };
  await env.db.run.update({ where: { id: runId }, data: { extensionEvidence: JSON.stringify(evidence) } });
  await putText(env, `private/extensions/${identity.ownerRunId}/phase.json`, JSON.stringify({ identity: evidence.identity, ...result }));
}
