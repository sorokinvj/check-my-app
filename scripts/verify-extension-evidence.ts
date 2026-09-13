import assert from "node:assert/strict";
import { extensionPhaseEvidence, persistExtensionPhase, extensionCoverageGap, extensionAccountingStep } from "../src/agent/extension-evidence";
import { hasEnvironmentLeak, productStepLabel } from "../src/lib/verdict-language";
import { productizeStep } from "../src/agent/tools";
import { extensionStepConfig, type ExtensionSession } from "../src/agent/extension-contract";
import type { AgentEnv } from "../src/agent/env";

async function main() {
  const identity: ExtensionSession = {
    extensionId: "a".repeat(32), packageVersion: "1.2", installedVersion: "1.2", artifactSha256: "a".repeat(64),
    ownerRunId: "run-123_scan", sessionId: "session-123", name: "Fixture extension", targetUrl: "https://example.test", targetTabId: "tab-123", popupPath: "popup.html", browserVersion: "Chrome/145",
  };
  const final = { disposed: true, session: { ...identity, sessions: [], applicationCleanup: "not-started", billingCleanup: "not-started" } };
  const scan = extensionPhaseEvidence("scan", identity, final);
  assert.equal(scan.cleanupComplete, true);
  assert.match(scan.artifactUrl, /run-123_scan\/cleanup.json$/);
  assert.equal(extensionPhaseEvidence("scan", identity, { disposed: false }).cleanupComplete, false);
  assert.equal(extensionPhaseEvidence("scan", identity, { ...final, session: { ...final.session, runtimeFailure: { kind: "browser-exited" } } }).cleanupComplete, false);
  assert.throws(() => extensionPhaseEvidence("scan", identity, { ...final, session: { ...final.session, ownerRunId: "another-run" } }), /another attempt/);
  let stored: string | null = null;
  const env = { db: { run: { findUnique: async () => ({ extensionEvidence: stored }), update: async ({ data }: { data: { extensionEvidence: string } }) => { stored = data.extensionEvidence; } } } } as unknown as AgentEnv;
  await persistExtensionPhase(env, "run-123", "scan", identity, final);
  const next = { ...identity, ownerRunId: "run-123_discovery", sessionId: "session-456" };
  await persistExtensionPhase(env, "run-123", "discovery", next, { disposed: true, session: { ...final.session, ...next } });
  const saved = JSON.parse(stored!);
  assert.deepEqual(Object.keys(saved.phases), ["scan", "discovery"]);
  assert.equal(saved.phases.discovery.ownerRunId, "run-123_discovery");
  assert.equal(saved.phases.scan.ownerRunId, "run-123_scan");
  await assert.rejects(persistExtensionPhase(env, "run-123", "walk-0", { ...next, artifactSha256: "b".repeat(64) }, { disposed: false }), /changed/);
  const joblander = { id: "run-123", targetUrl: "https://chromewebstore.google.com/detail/hafhjepjihcimcljkdphpinannbdmnhf", extensionConfig: JSON.stringify({ allowSessions: true }), testEmail: "fixture@example.test", testPasswordEnc: "encrypted-fixture" };
  assert.equal(extensionCoverageGap(joblander, stored), "our_capability", "Install/discovery/login alone cannot establish interview assistance");
  assert.equal(extensionCoverageGap({ ...joblander, testEmail: null }, stored), "missing_access");
  const complete = { phases: {
    "walk-0": { ...scan, phase: "walk-0", scenario: "interview", ownedSessions: 1, productResultConfirmed: true, cleanupComplete: true, twoMinuteStepsObserved: true, sustainedSessionsObserved: true },
    "walk-1": { ...scan, phase: "walk-1", scenario: "practice", ownedSessions: 1, productResultConfirmed: true, cleanupComplete: true, twoMinuteStepsObserved: true, sustainedSessionsObserved: true },
    "walk-2": { ...scan, phase: "walk-2", scenario: "practice-extension", ownedSessions: 2, productResultConfirmed: true, cleanupComplete: true, twoMinuteStepsObserved: true, sustainedSessionsObserved: true },
  } };
  assert.equal(extensionCoverageGap(joblander, JSON.stringify({ phases: { "walk-0": complete.phases["walk-0"] } })), "our_capability", "Interview alone does not cover the two discovered practice scenarios");
  assert.equal(extensionCoverageGap(joblander, JSON.stringify(complete)), null);
  complete.phases["walk-1"].sustainedSessionsObserved = false;
  assert.equal(extensionCoverageGap(joblander, JSON.stringify(complete)), "our_capability", "A short call cannot establish both required minute transitions");
  complete.phases["walk-1"].sustainedSessionsObserved = true;
  complete.phases["walk-2"].twoMinuteStepsObserved = false;
  assert.equal(extensionCoverageGap(joblander, JSON.stringify(complete)), null, "Unavailable minute precision remains partial coverage after the functions and safe cleanup were observed");
  complete.phases["walk-0"].cleanupComplete = false;
  assert.equal(extensionCoverageGap(joblander, JSON.stringify(complete)), "our_capability");
  assert.equal(extensionCoverageGap(joblander, "invalid evidence"), "our_capability");
  const accountingFinal = { disposed: true, session: { ...identity, sessions: [{ id: "extension-capture", state: "stopped", cleanup: { applicationStopObserved: true } }], applicationCleanup: "ui-stop-observed", billingCleanup: "confirmed", billing: { assessment: { status: "confirmed", twoMinuteSteps: true, observedMinutes: 3, sessions: [{ id: "own-history-row", kind: "extension", dateUtc: "2026-09-12 20:07", durationSeconds: 149 }] } } } };
  assert.match(extensionAccountingStep(accountingFinal)!.observed, /3 minutes.*149 seconds.*unchanged/);
  assert.equal(extensionAccountingStep({ ...accountingFinal, disposed: false }), null);
  assert.equal(extensionAccountingStep({ ...accountingFinal, session: { ...accountingFinal.session, billingCleanup: "unverified" } }), null);
  const partial = extensionAccountingStep({ ...accountingFinal, session: { ...accountingFinal.session, billing: { assessment: { status: "inconclusive" } } } });
  assert.equal(partial?.status, "skipped");
  assert.equal(partial?.unverifiedReason, "our_capability");
  assert.equal(partial?.gapClass, "extension_minute_accounting");
  assert.equal(hasEnvironmentLeak(partial!.observed), false);
  assert.equal(extensionAccountingStep({ ...accountingFinal, session: { ...accountingFinal.session, billing: { assessment: { ...accountingFinal.session.billing.assessment, twoMinuteSteps: false } } } })?.status, "skipped");
  assert.equal(extensionStepConfig(true).timeout, '25 minutes');
  assert.equal(extensionStepConfig(true).retries?.limit, 0);
  assert.deepEqual(extensionStepConfig(false), {});
  const failurePhase = { ...complete.phases['walk-0'], productResultConfirmed: false, sustainedSessionsObserved: false, cleanupComplete: true, productFailureObserved: true };
  assert.equal(extensionCoverageGap(joblander, JSON.stringify({ phases: { ...complete.phases, 'walk-0': failurePhase } })), null, 'A confirmed product error is an outcome, not missing capability');
  assert.equal(extensionCoverageGap(joblander, JSON.stringify({ phases: { ...complete.phases, 'walk-0': { ...failurePhase, cleanupComplete: false } } })), 'our_capability');
  const step = { label: "Pre-session account preflight", status: "ok" as const, attempted: "Read the account balance.", observed: "Balance: 1605 minutes. Audio preflight: ready. Session registered with owned expiry. applicationStopObserved: true confirmed." };
  productizeStep(step);
  assert.equal(step.label, "Session balance");
  assert.equal(step.observed, "Balance: 1605 minutes.");
  assert.equal(hasEnvironmentLeak(JSON.stringify(step)), false);
  assert.equal(productStepLabel("Session Stop observed"), "Session Stop observed");
  console.log("Extension evidence: per-phase provenance, preserved artifacts and cross-attempt rejection pass");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
