import assert from 'node:assert/strict';
import { practiceStopControl, practiceMutedMicrophone, stopPractice, observePracticeRequests } from '../extension-runner/joblander-practice.mjs';
import { EventEmitter } from 'node:events';

const stop = { index: 5, ownDocument: true, visible: true, disabled: false, text: '', label: '', icon: '<svg class="lucide lucide-x"/>', color: 'rgba(0, 0, 0, 0)', width: 24, height: 24 };
const avatar = { ...stop, index: 0, icon: '<svg class="lucide lucide-user"/>' };
assert.equal(practiceStopControl([avatar, stop]).index, 5);
assert.throws(() => practiceStopControl([stop, { ...stop, index: 6 }]), /ambiguous/);
for (const changed of [{ ownDocument: false }, { visible: false }, { disabled: true }, { text: 'Delete' }, { label: 'Delete' }, { width: 0 }, { icon: '' }, { icon: '<svg class="lucide lucide-x-circle"/>' }]) {
  assert.throws(() => practiceStopControl([{ ...stop, ...changed }]), /unavailable/);
}
assert.equal(practiceStopControl([{ ...stop, width: 64, height: 64 }]).index, 5, 'A resized hit area does not change the observed control');
const microphone = { ...stop, index: 2, icon: '<svg><path d="M12.227 11.52"/></svg>' };
assert.equal(practiceMutedMicrophone([microphone, stop]).index, 2);
assert.throws(() => practiceMutedMicrophone([microphone, { ...microphone, index: 3 }]), /ambiguous/);
assert.throws(() => practiceMutedMicrophone([{ ...microphone, ownDocument: false }]), /unavailable/);
let clicked = false;
const page = {
  url: () => 'https://joblander.app/practice',
  locator: () => ({ evaluateAll: async () => [avatar, stop], nth: index => ({ click: async () => { assert.equal(index, 5); clicked = true; } }) }),
  getByRole: () => ({ isVisible: async () => false, waitFor: async () => { throw new Error('Start call did not return'); } }),
  getByText: () => ({ waitFor: async () => { throw new Error('Start call did not return'); } }),
};
await assert.rejects(stopPractice(page), /did not return/, 'The click cannot prove the practice stopped');
assert.equal(clicked, true);
clicked = false;
await assert.rejects(stopPractice({ ...page, url: () => 'https://example.test/practice' }), /changed/);
assert.equal(clicked, false, 'Never stop an unrelated page');
const events = new EventEmitter(), requests = [];
const detach = observePracticeRequests(events, requests);
const request = { url: () => 'https://joblander.app/api/practice?private=value', method: () => 'POST', resourceType: () => 'fetch' };
events.emit('response', { request: () => request, status: () => 200 });
events.emit('requestfailed', request);
assert.equal(requests[0].status, 200);
assert.equal(requests[1].error, 'Request did not complete');
assert.doesNotMatch(JSON.stringify(requests), /private|value/);
detach();
events.emit('requestfailed', request);
assert.equal(requests.length, 2, 'Our later browser disposal is outside the product request observation');
console.log('Practice lifecycle rejects ambiguous controls, changed tabs and unobserved Stop');
