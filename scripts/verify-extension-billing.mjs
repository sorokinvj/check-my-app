import assert from 'node:assert/strict';
import { assessUiBilling, BillingObservation } from '../extension-runner/billing.mjs';
import { parseMinuteBalance, signInAccountOnce, credentialRejection } from '../extension-runner/joblander-account.mjs';
assert.equal(parseMinuteBalance('Account\nMinutes\n\n1600\nFrom $0.08 per minute'), 1600);
assert.throws(() => parseMinuteBalance('100 minutes $10'), /unavailable/);
assert.throws(() => parseMinuteBalance('Minutes\n100\nMinutes\n200\n'), /ambiguous/);
const start = Date.UTC(2026, 8, 12, 18, 0, 5);
const row = { id: 'https://example.test/meeting/owned', kind: 'extension', dateUtc: '2026-09-12 18:00', durationSeconds: 149 };
const baseline = { source: 'account-ui', at: start - 5000, balance: 100, history: [] };
const stopped = { ...baseline, at: start + 152000, balance: 97, history: [row] };
const later = { ...stopped, at: stopped.at + 65000 };
const sessions = [{ id: 'extension-capture', startedAt: start, cleanup: { applicationStopObserved: true } }];
const samples = [{ source: 'account-ui', balance: 99 }, { source: 'account-ui', balance: 98 }];
const args = { baseline, stopped, later, sessions, samples };
assert.equal(assessUiBilling(args).cleanupConfirmed, true);
assert.equal(assessUiBilling(args).twoMinuteSteps, true);
assert.equal(assessUiBilling({ ...args, samples: [] }).twoMinuteSteps, false, 'Final debit alone does not prove two live minute steps');
assert.equal(assessUiBilling({ ...args, later: { ...later, balance: 96 } }).cleanupConfirmed, false);
assert.equal(assessUiBilling({ ...args, later: { ...later, at: stopped.at + 1000 } }).cleanupConfirmed, false);
assert.equal(assessUiBilling({ ...args, stopped: { ...stopped, balance: 98 }, later: { ...later, balance: 98 } }).cleanupConfirmed, true);
assert.equal(assessUiBilling({ ...args, later: { ...later, history: [{ ...row, durationSeconds: 120 }] } }).status, 'inconclusive', 'Whole-second duration cannot settle a subsecond minute boundary');
assert.equal(assessUiBilling({ ...args, later: { ...later, history: [{ ...row, dateUtc: '2026-09-11 18:00' }] } }).status, 'inconclusive');
assert.equal(assessUiBilling({ ...args, sessions: [{ ...sessions[0], cleanup: {} }] }).cleanupConfirmed, false);
const practice = { ...row, id: 'https://example.test/practice/owned', kind: 'practice', durationSeconds: 189 };
const both = { ...args, sessions: [...sessions, { ...sessions[0], id: 'ai-practice' }], stopped: { ...stopped, balance: 93, history: [row, practice] }, later: { ...later, balance: 93, history: [row, practice] }, samples: [{ source: 'account-ui', balance: 98 }, { source: 'account-ui', balance: 96 }] };
assert.equal(assessUiBilling(both).expectedMinutes, 7, 'Each meter is rounded independently');
assert.equal(assessUiBilling(both).twoMinuteSteps, true);
const blocked = new BillingObservation({ baseline, readBalance: () => new Promise(() => {}), readSnapshot: () => new Promise(() => {}), finishTimeoutMs: 5 });
blocked.start();
assert.equal((await blocked.finish(sessions)).assessment.cleanupConfirmed, false, 'A stalled balance read cannot prevent bounded cleanup or produce a pass');
console.log('Extension billing: displayed balance, independent rounding, live minute steps, attribution and cessation gates pass');

const missingMeter = assessUiBilling({ ...both, later: { ...both.later, history: [practice] } });
assert.equal(missingMeter.cleanupConfirmed, true, 'Positive Stop and stable balance establish cessation even when a meter has no history row');
assert.equal(missingMeter.status, 'inconclusive', 'A missing meter cannot establish independent billing');
assert.equal(missingMeter.expectedMinutes, undefined);
assert.equal(missingMeter.observedMinutes, 7);
assert.equal(assessUiBilling({ ...both, later: { ...both.later, balance: 92, history: [practice] } }).cleanupConfirmed, false, 'Missing history never excuses continued usage');

let submissions = 0;
const loginPage = {
 goto: async () => {}, getByPlaceholder: () => ({ fill: async () => {} }),
 getByRole: () => ({ click: async () => { submissions++; } }), waitForFunction: async () => {},
 locator: () => ({ innerText: async () => 'Invalid credentials' }),
};
const loginState = {};
assert.equal((await signInAccountOnce(loginState, loginPage, 'fixture@example.test', 'fixture-password')).credentialRejected, true);
assert.equal((await signInAccountOnce(loginState, loginPage, 'fixture@example.test', 'fixture-password')).credentialRejected, true);
assert.equal(submissions, 1, 'Rejected account access cannot submit twice');
assert.equal(credentialRejection('Loading your account'), false);
const uncertain = {};
await assert.rejects(signInAccountOnce(uncertain, { ...loginPage, waitForFunction: async () => { throw new Error('Connection interrupted'); } }, 'fixture@example.test', 'fixture-password'));
await assert.rejects(signInAccountOnce(uncertain, loginPage, 'fixture@example.test', 'fixture-password'), /consumed/);
assert.equal(submissions, 2, 'An interrupted submission cannot be resubmitted either');
