import assert from "node:assert/strict";
import { extensionInput, assertExtensionIdentity, extensionCleanupComplete, isExtensionTarget, gateExtensionStep, type ExtensionSession } from "../src/agent/extension-contract";

const id = "hafhjepjihcimcljkdphpinannbdmnhf";
const run = { id: "run-extension-123", targetKind: "extension", targetUrl: `https://chromewebstore.google.com/detail/${id}`, extensionId: id, extensionConfig: JSON.stringify({ allowSessions: true, maxSessionSeconds: 180 }), testEmail: "test@example.test", testPasswordEnc: "encrypted-fixture" };
assert.equal(extensionInput({ ...run, targetKind: "website", targetUrl: "https://example.test" }, "scan"), null);
assert.equal(isExtensionTarget({ targetUrl: run.targetUrl }), true, "A legacy Store-link run must never survey the listing as its product");
assert.equal(extensionInput(run, "discovery")?.allowSessions, false);
assert.equal(extensionInput(run, "walk-0", "interview")?.allowSessions, true);
assert.equal(extensionInput(run, "walk-0")?.allowSessions, false, "An account or sign-in journey cannot inherit paid session permission");
assert.equal(extensionInput({ ...run, testPasswordEnc: null }, "walk-0", "interview")?.allowSessions, false);
assert.equal(extensionInput({ ...run, extensionConfig: '{}' }, "walk-0", "interview")?.allowSessions, false);
assert.equal(extensionInput(run, "walk-0")?.ownerRunId, "run-extension-123_walk-0");
assert.throws(() => extensionInput({ ...run, extensionId: "a".repeat(32) }, "scan"), /does not match/);
assert.throws(() => extensionInput({ ...run, targetUrl: "https://chromewebstore.google.com/detail/bad" }, "scan"), /does not match/);
const identity = { extensionId: id, packageVersion: "1.2.3", installedVersion: "1.2.3", artifactSha256: "a".repeat(64) };
assertExtensionIdentity(identity);
assert.throws(() => assertExtensionIdentity({ ...identity, installedVersion: "1.2.4" }), /unverified/);
assert.throws(() => assertExtensionIdentity({ ...identity, artifactSha256: "b".repeat(64) }, identity), /changed/);
const session: ExtensionSession = { ...identity, sessionId: "session-123", ownerRunId: run.id, name: "Example", targetUrl: "https://example.test", targetTabId: "tab-123", popupPath: "popup.html", browserVersion: "Chrome/145", sessions: [], applicationCleanup: "not-started" };
assert.equal(extensionCleanupComplete(session), true);
assert.equal(extensionCleanupComplete({ ...session, sessions: undefined }), false);
const stopped = { ...session, sessions: [{ id: "capture", state: "stopped", cleanup: { applicationStopObserved: true } }], applicationCleanup: "ui-stop-observed", billingCleanup: "unverified" };
assert.equal(extensionCleanupComplete(stopped), false, "Visible Stop is not proof that billing stopped");
assert.equal(extensionCleanupComplete({ ...stopped, billingCleanup: "confirmed" }), true);
assert.equal(extensionCleanupComplete({ ...stopped, billingCleanup: "confirmed", sessions: [{ id: "capture", state: "stopped", cleanup: null }] }), false, "A claimed stopped state needs the actual application observation");
for (const reason of ["missing_access", "our_capability"] as const) {
  for (const status of ["ok", "broken", "risky"]) {
    const step: Record<string, unknown> = { status, attempted: "Started a session", observed: "The session is broken" };
    gateExtensionStep(step, reason);
    assert.equal(step.status, "skipped");
    assert.equal(step.unverifiedReason, reason);
    assert.equal(String(step.observed).includes("broken"), false, "A refused native operation cannot become a product allegation or a passing step");
  }
}
console.log("Extension executor: routing, consent, immutable identity and independent cleanup evidence pass");
