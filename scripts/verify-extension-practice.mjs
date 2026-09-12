import assert from 'node:assert/strict';
import { practiceStopControl, stopPractice } from '../extension-runner/joblander-practice.mjs';

const stop = { index: 5, visible: true, disabled: false, text: '', label: '', icon: '<svg class="lucide lucide-x"/>', color: 'rgba(0, 0, 0, 0)', width: 24, height: 24 };
const avatar = { ...stop, index: 0, icon: '<svg class="lucide lucide-user"/>' };
assert.equal(practiceStopControl([avatar, stop]).index, 5);
assert.throws(() => practiceStopControl([stop, { ...stop, index: 6 }]), /ambiguous/);
for (const changed of [{ visible: false }, { disabled: true }, { text: 'Delete' }, { label: 'Delete' }, { width: 0 }, { icon: '' }, { icon: '<svg class="lucide lucide-x-circle"/>' }]) {
  assert.throws(() => practiceStopControl([{ ...stop, ...changed }]), /unavailable/);
}
assert.equal(practiceStopControl([{ ...stop, width: 64, height: 64 }]).index, 5, 'A resized hit area does not change the observed control');
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
console.log('Practice lifecycle rejects ambiguous controls, changed tabs and unobserved Stop');
