import assert from 'node:assert/strict';
import { SessionLedger, stopWithConfirmation, sessionStopDeferred, settleSessionCleanup } from '../extension-runner/lifecycle.mjs';

const active = [{ state: 'active', startedAt: 0 }];
assert.equal(sessionStopDeferred(active, 120, 94_000), true, 'Normal completion must preserve the two-minute observation window');
assert.equal(sessionStopDeferred(active, 120, 120_000), false);
assert.equal(sessionStopDeferred([...active, { state: 'active', startedAt: 20_000 }], 120, 120_000), true, 'Both meters need their own observation window');
assert.equal(sessionStopDeferred(active, undefined, 94_000), false, 'Cancellation and disposal must not wait for acceptance duration');
assert.equal(sessionStopDeferred([{ state: 'stopped', startedAt: 0 }], 120, 94_000), false);
assert.throws(() => sessionStopDeferred(active, 121), /Invalid/);
assert.throws(() => sessionStopDeferred(active, -1), /Invalid/);

let time = 0;
const calls = [];
const control = name => ({
 click: async options => { calls.push(name + (options?.trial ? ':ready' : '')); time += options?.trial ? 4000 : 20; },
 waitFor: async () => { calls.push(`${name}:observed`); time += 20; },
});
const stopped = await stopWithConfirmation({ stop: control('End session'), confirm: control('Confirm end session'), stopped: control('panel'), now: () => time });
assert.deepEqual(calls, ['End session:ready', 'End session', 'Confirm end session:observed', 'Confirm end session', 'panel:observed']);
assert.equal(stopped.applicationStopObserved, true);
assert.equal(stopped.stopClickedAt, 4000, 'Slow reachability checks must finish before starting the confirmation clock');
assert.ok(stopped.confirmClickedAt - stopped.stopClickedAt < 2800);
let lateClicks = 0;
await assert.rejects(stopWithConfirmation({
 stop: control('End session'),
 confirm: { waitFor: async () => { time += 3000; }, click: async () => { lateClicks++; } },
 stopped: control('panel'), now: () => time,
}), /expired/);
assert.equal(lateClicks, 0, 'An expired confirmation must not re-arm Stop');
let attemptedStop = false;
await assert.rejects(stopWithConfirmation({
 stop: { click: async options => { if (options.trial) throw new Error('Stop is obstructed'); attemptedStop = true; } },
 confirm: control('Confirm end session'), stopped: control('panel'),
}), /obstructed/);
assert.equal(attemptedStop, false, 'A failed readiness check must not arm the confirmation');
await assert.rejects(stopWithConfirmation({
 stop: control('End session'), confirm: control('Confirm end session'),
 stopped: { waitFor: async () => { throw new Error('panel still present'); } },
}), /panel still present/, 'Clicking Confirm alone is not Stop proof');

const ledger = new SessionLedger('owner-run');
let stops = 0;
const lease = ledger.register({ id: 'capture', targetId: 'one-tab', maxSeconds: 600, stop: async () => { stops++; return { applicationStopObserved: true }; } });
assert.throws(() => ledger.register({ id: 'capture', targetId: 'other-tab', maxSeconds: 600, stop: async () => ({}) }), /Unique/);
assert.equal(lease.state, 'pending');
assert.equal(ledger.clean, false, 'A registered Start requires cleanup even if it is interrupted');
await assert.rejects(ledger.end('foreign'), /does not belong/);
await Promise.all([ledger.end('capture'), ledger.endAll(), ledger.end('capture')]);
assert.equal(stops, 1, 'Concurrent cleanup must not double-click a session');
assert.equal(ledger.clean, true);
assert.equal(ledger.snapshot()[0].ownerRunId, 'owner-run');

const failed = new SessionLedger('other-run');
failed.register({ id: 'unknown-stop', targetId: 'tab', maxSeconds: 600, stop: async () => ({ browserClosed: true }) });
await failed.endAll();
assert.equal(failed.clean, false, 'Disposing a browser never proves application Stop');
assert.equal(failed.snapshot()[0].state, 'unverified');
const settlements = [];
const handlers = { failed: () => settlements.push('close-browser'), stopped: () => settlements.push('read-balance-after-stop') };
settleSessionCleanup([{ state: 'active' }], handlers);
assert.deepEqual(settlements, []);
settleSessionCleanup([{ state: 'unverified' }, { state: 'active' }], handlers);
assert.deepEqual(settlements, ['close-browser'], 'A failed Stop must trigger disposal while the other meter is still active');
settleSessionCleanup([{ state: 'stopped' }, { state: 'not-started' }], handlers);
assert.deepEqual(settlements, ['close-browser', 'read-balance-after-stop']);
console.log('Extension lifecycle: local confirmation, deadlines, ownership and cleanup proof verified');

const timed = new SessionLedger('deadline-run');
timed.register({ id: 'deadline', targetId: 'tab', maxSeconds: 1, stop: async () => ({ applicationStopObserved: true }) });
await new Promise(resolve => setTimeout(resolve, 1100));
assert.equal(timed.snapshot()[0].state, 'stopped', 'Cleanup runs without a follow-up request');

const paired = new SessionLedger('paired-meters');
const order = [];
let releaseFirst;
paired.register({ id: 'extension', targetId: 'same-tab', maxSeconds: 600, stop: async () => {
  order.push('extension-confirm');
  await new Promise(resolve => { releaseFirst = resolve; });
  order.push('extension-stopped');
  return { applicationStopObserved: true };
} });
paired.register({ id: 'practice', targetId: 'same-tab', maxSeconds: 600, stop: async () => {
  order.push('practice-stopped'); return { applicationStopObserved: true };
} });
const ending = paired.endAll();
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(order, ['extension-confirm']);
releaseFirst();
await ending;
assert.deepEqual(order, ['extension-confirm', 'extension-stopped', 'practice-stopped']);
assert.equal(paired.clean, true);
const rejected = new SessionLedger('rejected-start');
rejected.register({ id: 'ai-practice', targetId: 'owned-tab', maxSeconds: 600, stop: async () => { throw new Error('Must not stop a different session'); } });
rejected.rejected('ai-practice', 'Already active in another tab');
await rejected.endAll();
assert.equal(rejected.snapshot()[0].state, 'not-started');
assert.equal(rejected.clean, true);
assert.throws(() => rejected.started('ai-practice'), /pending/);
