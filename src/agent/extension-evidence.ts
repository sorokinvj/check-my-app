import type { AgentEnv } from "./env";
import { assertExtensionIdentity, extensionCleanupComplete, type ExtensionIdentity, type ExtensionSession, type ExtensionTarget } from "./extension-contract";
import { parseExtensionLink, readExtensionOptions } from "@/lib/extension-target";

export interface ExtensionFinalEvidence { disposed: boolean; session?: ExtensionSession }

export function extensionProductFailureStep(final: ExtensionFinalEvidence) {
  const failure = final.session?.productResult?.failure;
  if (!final.disposed || !final.session || final.session.runtimeFailure || !extensionCleanupComplete(final.session) || failure?.source !== "visible-product-alert") return null;
  return { label: "Session response", status: "broken" as const,
    attempted: "Receive a response during the session.", observed: `The session displayed an error: ${failure.text}` };
}

export function extensionAccountingStep(final: ExtensionFinalEvidence) {
  const session = final.session;
  const accounting = session?.billing?.assessment;
  if (!final.disposed || !session || !session.sessions?.length || !extensionCleanupComplete(session)) return null;
  if (accounting?.status !== "confirmed" || !accounting.twoMinuteSteps || !Number.isSafeInteger(accounting.observedMinutes) || !accounting.sessions?.length) {
    return { label: "Session minutes", status: "skipped" as const, unverifiedReason: "our_capability" as const, gapClass: "extension_minute_accounting",
      attempted: "Check minute-by-minute charges and each session's final rounding.",
      observed: "The sessions ended and the balance stayed unchanged for at least one minute after Stop. Minute-by-minute charges and final rounding were not confirmed." };
  }
  const durations = accounting.sessions.map(row => `${row.durationSeconds} seconds`).join(" and ");
  return { label: "Session minutes", status: "ok" as const,
    attempted: "End the session and check its minute usage.",
    observed: `${accounting.observedMinutes} minutes were used for the session${accounting.sessions.length === 1 ? "" : "s"} lasting ${durations}. The balance stayed unchanged for at least one minute after Stop.` };
}

export function extensionPhaseEvidence(phase: string, identity: ExtensionSession, final: ExtensionFinalEvidence) {
  if (final.session) {
    assertExtensionIdentity(final.session, identity);
    if (final.session.ownerRunId !== identity.ownerRunId || final.session.sessionId !== identity.sessionId) throw new Error("Extension evidence belongs to another attempt");
  }
  return {
    phase, scenario: identity.scenario ?? "interview", ownerRunId: identity.ownerRunId, sessionId: identity.sessionId,
    artifactUrl: `/api/evidence/extensions/${encodeURIComponent(identity.ownerRunId)}/cleanup.json`,
    disposed: final.disposed,
    cleanupComplete: Boolean(final.disposed && final.session && !final.session.runtimeFailure && extensionCleanupComplete(final.session)),
    applicationCleanup: final.session?.applicationCleanup ?? "unverified",
    billingCleanup: final.session?.billingCleanup ?? "unverified",
    ownedSessions: final.session?.sessions?.length ?? null,
    runtimeFailure: final.session?.runtimeFailure?.kind ?? null,
    productResultConfirmed: final.session?.productResult?.confirmed === true,
    productFailureObserved: Boolean(extensionProductFailureStep(final)),
    twoMinuteStepsObserved: final.session?.billing?.assessment?.twoMinuteSteps === true,
    sustainedSessionsObserved: Boolean(final.session?.sessions?.length && final.session.sessions.every(s => s.startedAt && s.cleanup?.stopClickedAt && s.cleanup.stopClickedAt - s.startedAt >= 120_000)),
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
  const evidence = {
    identity: { name: identity.name, extensionId: identity.extensionId, packageVersion: identity.packageVersion, installedVersion: identity.installedVersion, artifactSha256: identity.artifactSha256 },
    phases: { ...previous.phases, [phase]: extensionPhaseEvidence(phase, identity, final) },
  };
  await env.db.run.update({ where: { id: runId }, data: { extensionEvidence: JSON.stringify(evidence) } });
}
