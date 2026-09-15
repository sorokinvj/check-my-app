import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extensionArtifactEvidence } from "../src/agent/extension-artifact";

const result = extensionArtifactEvidence({ disposed: true, session: {
  extensionId: "a".repeat(32), installedVersion: "1.0", profileId: "private-profile",
  accountBaseline: { balance: 100, history: [{ id: "unrelated-history" }] },
  sessions: [{ id: "extension-capture", state: "stopped", startedAt: 1, cleanup: { applicationStopObserved: true, stopClickedAt: 149001, error: "private-error" } }],
  productResult: { confirmed: true, question: "An observed question", answer: "An observed answer", privateField: "private-result" },
  billing: { baseline: { history: [{ id: "unrelated-history" }] }, later: { balance: 97, history: [] }, assessment: {
    status: "confirmed", expectedMinutes: 3, observedMinutes: 3, cessationMs: 70000,
    sessions: [{ id: "private-account-history-link", kind: "extension", dateUtc: "2026-09-12 20:20", durationSeconds: 149 }],
  } },
} });
assert.equal(result.disposed, true);
assert.equal(result.session.productResult.confirmed, true);
assert.equal(result.session.billing.assessment.observedMinutes, 3);
assert.equal(result.session.sessions[0].cleanup.applicationStopObserved, true);
assert.equal(result.session.billing.assessment.sessions[0].durationSeconds, 149);
assert.doesNotMatch(JSON.stringify(result), /unrelated-history|private-|accountBaseline|"history"|"balance"/);
// A paid run that could not confirm its billing has to record WHICH refusal it
// was. Run #194 stopped two sessions, could not confirm the meters, and left
// "inconclusive" with no way to tell which of the checks said no (CHE-250).
// Read the refusals out of the executor so a new one is covered the day it is
// written, rather than the day someone remembers this file.
const billing = readFileSync(new URL("../extension-runner/billing.mjs", import.meta.url), "utf8");
const reasons = [...billing.matchAll(/inconclusive\('([^']+)'\)/g), ...billing.matchAll(/reason: '([^']+)'/g)].map(match => match[1]);
assert.ok(reasons.length >= 11, `Every refusal in billing.mjs must be covered here; found ${reasons.length}`);
for (const reason of reasons) {
  const refused = extensionArtifactEvidence({ session: { billing: { assessment: { status: "inconclusive", cleanupConfirmed: false, reason } } } });
  assert.equal(refused.session.billing.assessment.reason, reason, `A run refusing for "${reason}" must say so in its artifact`);
  // Every reason is a constant written in our code. If one ever carries a
  // balance, a date or an address, it stops being safe to keep here.
  assert.doesNotMatch(reason, /\d|@|https?:/, `A refusal reason may not carry account values: "${reason}"`);
}

// Same blind spot one level up: the cleanup's own refusal. Read the constants
// out of the runner so a new one is covered when it is written.
const runner = readFileSync(new URL("../src/agent/extension-runner.ts", import.meta.url), "utf8");
const failures = [...runner.matchAll(/cleanupFailure: ["`]([^"`$]+)["`]/g)].map(match => match[1]);
assert.ok(failures.length >= 2, `Every cleanupFailure constant must be covered here; found ${failures.length}`);
for (const cleanupFailure of failures) {
  assert.equal(extensionArtifactEvidence({ disposed: false, cleanupFailure }).cleanupFailure, cleanupFailure,
    `A phase that failed cleanup for "${cleanupFailure}" must say so in its artifact`);
}
assert.equal(Object.hasOwn(extensionArtifactEvidence({ disposed: true }), "cleanupFailure"), false,
  "A clean phase carries no failure field at all");
assert.equal(Object.hasOwn(extensionArtifactEvidence({ cleanupFailure: { note: "not a string" } }), "cleanupFailure"), false,
  "Only the runner's own text is carried, never an object from somewhere else");

assert.equal(extensionArtifactEvidence(undefined).disposed, false);
assert.deepEqual(extensionArtifactEvidence({ session: { sessions: "invalid" } }).session.sessions, []);
console.log("Extension artifacts preserve owned result and minute evidence without prior account history");
