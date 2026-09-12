import assert from "node:assert/strict";
import { extensionPhaseEvidence, persistExtensionPhase, extensionCoverageGap } from "../src/agent/extension-evidence";
import type { ExtensionSession } from "../src/agent/extension-contract";
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
  const complete = { phases: { "walk-0": { ...scan, phase: "walk-0", ownedSessions: 1, productResultConfirmed: true, cleanupComplete: true } } };
  assert.equal(extensionCoverageGap(joblander, JSON.stringify(complete)), null);
  complete.phases["walk-0"].cleanupComplete = false;
  assert.equal(extensionCoverageGap(joblander, JSON.stringify(complete)), "our_capability");
  assert.equal(extensionCoverageGap(joblander, "invalid evidence"), "our_capability");
  console.log("Extension evidence: per-phase provenance, preserved artifacts and cross-attempt rejection pass");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
