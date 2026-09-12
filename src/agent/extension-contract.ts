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
  sessionId: string;
  ownerRunId: string;
  name: string;
  targetUrl: string;
  targetTabId: string;
  popupPath: string | null;
  browserVersion: string;
  allowSessions?: boolean;
  runtimeFailure?: { kind: string; code?: number | null; signal?: string | null; at?: string };
  sessions?: Array<{ id: string; state: string; cleanup?: { applicationStopObserved?: boolean } | null }>;
  applicationCleanup?: string;
  billingCleanup?: string;
  productResult?: { confirmed: boolean; observedAt?: number; mode?: string };
  billing?: { assessment?: { twoMinuteSteps?: boolean } };
}

export interface ExtensionRunnerInput {
  ownerRunId: string;
  extensionId: string;
  targetUrl: string;
  maxDurationSeconds: number;
  allowSessions: boolean;
  maxSessionSeconds: number;
  stimulusMode?: "interview" | "tab-only" | "microphone-only";
}

export function isExtensionTarget(run: Pick<ExtensionTarget, "targetKind" | "targetUrl">): boolean {
  return run.targetKind === "extension" || isChromeStoreUrl(run.targetUrl);
}

export function extensionInput(run: ExtensionTarget, phase: string): ExtensionRunnerInput | null {
  const store = parseExtensionLink(run.targetUrl);
  if (!isExtensionTarget(run)) return null;
  if (!store || (run.extensionId && run.extensionId !== store.id)) throw new Error("Extension identity does not match its Store link");
  const options = readExtensionOptions(run.extensionConfig);
  return {
    ownerRunId: `${run.id}_${phase}`,
    extensionId: store.id,
    targetUrl: options.companionUrl || "fixture:interview",
    maxDurationSeconds: 1200,
    allowSessions: phase.startsWith("walk-") && options.allowSessions === true && Boolean(run.testEmail && run.testPasswordEnc),
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
