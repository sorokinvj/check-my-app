import { parseExtensionLink, isChromeStoreUrl, readExtensionOptions } from "@/lib/extension-target";

export interface ExtensionTarget {
  id: string;
  targetUrl: string;
  targetKind?: string;
  extensionId?: string | null;
  extensionConfig?: string | null;
  testEmail?: string | null;
  testPasswordEnc?: string | null;
}

export interface ExtensionIdentity {
  extensionId: string;
  packageVersion: string;
  installedVersion: string;
  artifactSha256: string;
}

export interface ExtensionSession extends ExtensionIdentity {
  scenario?: "interview" | "practice" | "practice-extension";
  stimulus?: { mode?: "interview" | "tab-only" | "microphone-only" | "practice" };
  sessionId: string;
  ownerRunId: string;
  name: string;
  targetUrl: string;
  targetTabId: string;
  popupPath: string | null;
  browserVersion: string;
  allowSessions?: boolean;
  popupSignedIn?: boolean;
  accountBaseline?: { source?: string; balance?: number };
  maxSessionSeconds?: number;
  runtimeFailure?: { kind: string; code?: number | null; signal?: string | null; at?: string };
  sessions?: Array<{ id: string; state: string; startedAt?: number; cleanup?: { applicationStopObserved?: boolean; stopClickedAt?: number } | null }>;
  applicationCleanup?: string;
  billingCleanup?: string;
  productResult?: { confirmed: boolean; observedAt?: number; mode?: string;
    failure?: { source: string; text: string; observedAt: number; surface: string } };
  billing?: { assessment?: { status?: string; twoMinuteSteps?: boolean; expectedMinutes?: number; observedMinutes?: number; cessationMs?: number;
    postStopChange?: number; postStopSettledMs?: number;
    sessions?: Array<{ id: string; kind: string; dateUtc: string; durationSeconds: number }> } };
}

export interface ExtensionRunnerInput {
  scenario?: "interview" | "practice" | "practice-extension";
  ownerRunId: string;
  extensionId: string;
  targetUrl: string;
  maxDurationSeconds: number;
  allowSessions: boolean;
  maxSessionSeconds: number;
  stimulusMode?: "interview" | "tab-only" | "microphone-only" | "practice";
}

export function extensionStepConfig(isExtension: boolean) {
  // A ten-minute paid session also needs installation, login and post-Stop
  // observation. A named native lease must never be reopened by a step retry.
  return isExtension ? { timeout: "25 minutes" as const, retries: { limit: 0, delay: "1 second" as const } } : {};
}

export function extensionToolAllowed(identity: Pick<ExtensionSession, "extensionId" | "scenario" | "allowSessions">, name: string): boolean {
  const practice = name === "extension_prepare_practice" || name === "extension_start_practice";
  const paid = practice || ["extension_start_session", "extension_observe_session", "extension_stop_sessions"].includes(name);
  const adapter = paid || name === "extension_account_preflight" || name === "extension_audio_preflight";
  if (adapter && identity.extensionId !== "hafhjepjihcimcljkdphpinannbdmnhf") return false;
  if (paid && !identity.allowSessions) return false;
  if (practice && !["practice", "practice-extension"].includes(identity.scenario ?? "interview")) return false;
  return name !== "extension_start_session" || identity.scenario !== "practice";
}

export function isExtensionTarget(run: Pick<ExtensionTarget, "targetKind" | "targetUrl">): boolean {
  return run.targetKind === "extension" || isChromeStoreUrl(run.targetUrl);
}

export function extensionInput(run: ExtensionTarget, phase: string, scenario?: ExtensionRunnerInput["scenario"]): ExtensionRunnerInput | null {
  const store = parseExtensionLink(run.targetUrl);
  if (!isExtensionTarget(run)) return null;
  if (!store || (run.extensionId && run.extensionId !== store.id)) throw new Error("Extension identity does not match its Store link");
  const options = readExtensionOptions(run.extensionConfig);
  const practice = scenario === "practice" || scenario === "practice-extension";
  if (practice && store.id !== "hafhjepjihcimcljkdphpinannbdmnhf") throw new Error("This practice scenario belongs to a different extension");
  return {
    scenario: scenario ?? "interview",
    ownerRunId: `${run.id}_${phase}`,
    extensionId: store.id,
    targetUrl: practice ? "https://joblander.app/practice" : options.companionUrl || "fixture:interview",
    ...(practice ? { stimulusMode: "practice" as const } : {}),
    maxDurationSeconds: 1200,
    // Reading account history must not start another paid interview. Only a
    // discovered session journey carries an explicit scenario authorization.
    allowSessions: phase.startsWith("walk-") && scenario !== undefined && options.allowSessions === true && Boolean(run.testEmail && run.testPasswordEnc),
    maxSessionSeconds: options.maxSessionSeconds ?? 180,
  };
}

export function assertExtensionIdentity(actual: ExtensionIdentity, expected?: ExtensionIdentity): void {
  if (!/^[a-p]{32}$/.test(actual.extensionId) || !actual.installedVersion || actual.installedVersion !== actual.packageVersion || !/^[a-f0-9]{64}$/.test(actual.artifactSha256)) {
    throw new Error("Extension installation identity is unverified");
  }
  if (expected && (actual.extensionId !== expected.extensionId || actual.installedVersion !== expected.installedVersion || actual.artifactSha256 !== expected.artifactSha256)) {
    throw new Error("The extension changed during this check; results cannot be combined across versions");
  }
}

export function extensionCleanupComplete(session: ExtensionSession): boolean {
  if (!session.sessions) return false;
  if (session.sessions.length === 0) return session.applicationCleanup === "not-started";
  return session.sessions.every(s => s.state === "stopped" && s.cleanup?.applicationStopObserved === true)
    && session.applicationCleanup === "ui-stop-observed" && session.billingCleanup === "confirmed";
}

export function gateExtensionStep(step: Record<string, unknown>, reason: "missing_access" | "our_capability"): void {
  step.status = "skipped";
  step.unverifiedReason = reason;
  step.attempted = "Open this part of the extension.";
  step.observed = reason === "missing_access"
    ? "Test-account access or permission is missing for this action."
    : "This extension action was not verified in this check.";
  if (reason === "our_capability") step.gapClass = "extension_runtime";
  else delete step.gapClass;
}
