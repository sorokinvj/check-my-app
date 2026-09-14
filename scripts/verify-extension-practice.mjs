import assert from 'node:assert/strict';
import { practiceStopControl, practiceMutedMicrophone, stopPractice, observePracticeRequests, normalizePracticeUtterances, preparePracticeStart, positionPracticeInsights } from '../extension-runner/joblander-practice.mjs';
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
assert.deepEqual(normalizePracticeUtterances([{ speaker: 'Casey QA', text: 'In project Maple I improved database queries.' }, { speaker: 'Aria', text: 'Which queries did you optimize?' }]), [{ speaker: 'You', text: 'In project Maple I improved database queries.' }, { speaker: 'Aria', text: 'Which queries did you optimize?' }]);
assert.throws(() => normalizePracticeUtterances([{ speaker: 'Casey', text: 'One' }, { speaker: 'Alex', text: 'Two' }]), /ambiguous/);
let clicked = false;
const page = {
  url: () => 'https://joblander.app/practice',
  locator: selector => selector === '#joblander-extension-host'
    ? { getByRole: () => ({ isVisible: async () => false }), locator: () => ({ isVisible: async () => false }) }
    : { evaluateAll: async () => [avatar, stop], nth: index => ({ elementHandle: async () => ({
      evaluate: async () => true, dispose: async () => {},
      click: async options => { assert.equal(index, 5); if (!options.trial) clicked = true; },
    }) }) },
  getByRole: () => ({ isVisible: async () => false, waitFor: async () => { throw new Error('Start call did not return'); } }),
  getByText: () => ({ waitFor: async () => { throw new Error('Start call did not return'); } }),
};
await assert.rejects(stopPractice(page), /did not return/, 'The click cannot prove the practice stopped');
assert.equal(clicked, true);
clicked = false;
await assert.rejects(stopPractice({ ...page, url: () => 'https://example.test/practice' }), /changed/);
assert.equal(clicked, false, 'Never stop an unrelated page');
let identityReads = 0, released = false;
const changedButton = { ...page, locator: selector => selector === '#joblander-extension-host' ? page.locator(selector) : {
  evaluateAll: async () => [avatar, stop], nth: () => ({ elementHandle: async () => ({
    evaluate: async () => ++identityReads === 1,
    click: async options => { assert.equal(options.trial, true, 'A changed control must never receive the real click'); },
    dispose: async () => { released = true; },
  }) }),
} };
await assert.rejects(stopPractice(changedButton), /control changed/);
assert.equal(identityReads, 2);
assert.equal(released, true);
clicked = false;
const changedOverlay = { ...page,
  locator: selector => selector !== '#joblander-extension-host' ? page.locator(selector) : {
    getByRole: () => ({ isVisible: async () => true, click: async () => { throw new Error('The overlay moved'); } }),
  },
  getByRole: () => ({ isVisible: async () => clicked, waitFor: async () => { assert.equal(clicked, true); } }),
};
const accessibleStop = await stopPractice(changedOverlay);
assert.equal(accessibleStop.applicationStopObserved, true);
assert.equal(accessibleStop.insightsPositioned, false, 'An overlay preparation failure must not prevent an otherwise reachable Stop');
const positions = [];
let collapsed = false;
const combined = { ...page,
  locator: selector => selector !== '#joblander-extension-host' ? page.locator(selector) : {
    getByRole: () => ({ isVisible: async () => !collapsed, click: async () => { collapsed = true; } }),
    locator: () => ({ isVisible: async () => true, count: async () => 1,
      boundingBox: async () => ({ x: 400, y: 300, width: 400, height: 40 }) }),
  },
  mouse: { move: async (x, y) => { assert.equal(collapsed, true); positions.push([x, y]); }, down: async () => {}, up: async () => {} },
};
assert.equal(await positionPracticeInsights(combined), true);
assert.deepEqual(positions, [[630, 320], [250, 65]], 'The expanded panel must be collapsed and moved away through pointer input');
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
let trials = 0;
const readyPage = { getByRole: () => ({ click: async input => { assert.equal(input.trial, true, 'Readiness must never start a call'); trials++; } }) };
assert.equal((await preparePracticeStart(readyPage, false)).startReachable, true);
assert.equal(trials, 1);
await assert.rejects(preparePracticeStart({ getByRole: () => ({ click: async input => { assert.equal(input.trial, true); throw new Error('Overlay intercepts Start'); } }) }, false), /Overlay/);
console.log('Practice lifecycle rejects ambiguous controls, changed tabs and unobserved Stop');
