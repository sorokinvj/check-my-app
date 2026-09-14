import assert from "node:assert/strict";
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
assert.equal(extensionArtifactEvidence(undefined).disposed, false);
assert.deepEqual(extensionArtifactEvidence({ session: { sessions: "invalid" } }).session.sessions, []);
console.log("Extension artifacts preserve owned result and minute evidence without prior account history");
