import assert from 'node:assert/strict';
import { SessionLedger, stopWithConfirmation } from '../extension-runner/lifecycle.mjs';

let time = 0;
const calls = [];
const control = name => ({
 click: async () => { calls.push(name); time += 20; },
 waitFor: async () => { calls.push(`${name}:observed`); time += 20; },
});
const stopped = await stopWithConfirmation({ stop: control('End session'), confirm: control('Confirm end session'), stopped: control('panel'), now: () => time });
assert.deepEqual(calls, ['End session', 'Confirm end session:observed', 'Confirm end session', 'panel:observed']);
assert.equal(stopped.applicationStopObserved, true);
assert.ok(stopped.confirmClickedAt - stopped.stopClickedAt < 2800);
let lateClicks = 0;
await assert.rejects(stopWithConfirmation({
 stop: control('End session'),
 confirm: { waitFor: async () => { time += 3000; }, click: async () => { lateClicks++; } },
 stopped: control('panel'), now: () => time,
}), /expired/);
assert.equal(lateClicks, 0, 'An expired confirmation must not re-arm Stop');
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
console.log('Extension lifecycle: local confirmation, deadlines, ownership and cleanup proof verified');

const timed = new SessionLedger('deadline-run');
timed.register({ id: 'deadline', targetId: 'tab', maxSeconds: 1, stop: async () => ({ applicationStopObserved: true }) });
await new Promise(resolve => setTimeout(resolve, 1100));
assert.equal(timed.snapshot()[0].state, 'stopped', 'Cleanup runs without a follow-up request');
