import assert from 'node:assert/strict';
import { NativeSurface } from '../extension-runner/surface.mjs';

const url = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html';
let now = 1, actions = [];
let node = { path: [0], name: 'Sign in with email', role: 'push button', enabled: true, editable: false, protected: false, bounds: [10, 20, 80, 30] };
const native = new NativeSurface(async input => {
  if (input.operation === 'read') return { nodes: [structuredClone(node)] };
  actions.push(input); return { acted: true };
}, () => now);
const read = async () => (await native.read(url, 'native-popup')).nodes[0].ref;
const act = (ref, overrides = {}) => native.act({ url, targetId: 'native-popup', ref, operation: 'click', ...overrides });
let ref = await read();
await assert.rejects(act(ref, { targetId: 'other-popup' }), /expired/);
assert.equal(actions.length, 0);
ref = await read();
await assert.rejects(act(ref, { url: 'file:///tmp/popup.html' }), /expired/);
assert.equal(actions.length, 0, 'Opaque/null URL origins cannot authorize another document');
ref = await read();
now += 60_001;
await assert.rejects(act(ref), /expired/);
ref = await read();
await act(ref);
await assert.rejects(act(ref), /does not belong/);
assert.equal(actions.length, 1, 'A reference is consumed before an action can be replayed');
node.name = 'Show JobLander Insights'; node.role = 'static';
ref = await read();
await assert.rejects(act(ref), /Session controls/);
assert.equal(actions.length, 1, 'A display-looking label still cannot start a paid capture outside the ledger');
node.name = 'Upgrade';
ref = await read();
await assert.rejects(act(ref), /purchases/);
node = { ...node, name: '', role: 'password text', editable: true, protected: true };
ref = await read();
const publicRead = JSON.stringify(await native.read(url, 'native-popup'));
assert.equal(publicRead.includes('bounds'), false, 'The agent never selects native controls by guessed coordinates');
ref = await read();
await act(ref, { operation: 'fill', value: '{{TEST_PASSWORD}}' });
assert.equal(actions.at(-1).operation, 'fill');
assert.equal(actions.at(-1).node.protected, true);
const fixtureSecret = 'fixture-password-value';
ref = await read();
await act(ref, { operation: 'fill', value: fixtureSecret });
assert.deepEqual(native.redact({ samples: [{ text: `An echo: ${fixtureSecret}` }] }), { samples: [{ text: 'An echo: {{TEST_PASSWORD}}' }] });
ref = await read();
await assert.rejects(act(ref, { operation: 'fill', value: 'text\n' }), /Invalid/, 'Typing Enter must not bypass the submit/session gate');
node = { ...node, name: 'Sign in', role: 'push button', editable: false, protected: false };
ref = await read();
await act(ref);
ref = await read();
await assert.rejects(act(ref), /already attempted/, 'A slow sign-in cannot produce repeated credential submissions');
const form = [
  { ...node, name: 'Email', role: 'text', editable: true, path: [0] },
  { ...node, name: '', role: 'password text', editable: true, protected: true, path: [1] },
];
let fieldActions = 0;
const fields = new NativeSurface(async input => {
  if (input.operation === 'read') return { nodes: structuredClone(form) };
  // The native adapter re-resolves the exact observed control immediately
  // before input; preserving a sibling reference never bypasses that check.
  assert.deepEqual(input.node, form[input.node.path[0]]);
  fieldActions++;
  return { acted: true };
});
const siblingRefs = (await fields.read(url, 'native-popup')).nodes;
await fields.act({ url, targetId: 'native-popup', ref: siblingRefs[0].ref, operation: 'fill', value: 'fixture@example.test', credential: true });
await fields.act({ url, targetId: 'native-popup', ref: siblingRefs[1].ref, operation: 'fill', value: 'fixture-only-password', credential: true });
assert.equal(fieldActions, 2, 'One field input does not invalidate a still-current sibling field');
await assert.rejects(fields.act({ url, targetId: 'native-popup', ref: siblingRefs[0].ref, operation: 'fill', value: 'again' }), /does not belong/);
console.log('Native surfaces: document ownership, reference expiry, single-use input and paid action gates pass');
