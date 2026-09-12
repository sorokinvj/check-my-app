import assert from 'node:assert/strict';
import { assessExtensionOutput } from '../extension-runner/result.mjs';
const answer = 'Profile database queries, add covering indexes, cache repeated queries, and measure response-time percentiles.';
const sample = { at: 2000, surface: 'extension-shadow-panel', panelPresent: true, results: [{ question: 'How would you improve database queries in project Maple and measure response time?', answer }] };
const session = { stimulus: { mode: 'microphone-only' }, audioPreflight: { baselinePanel: '' },
  sessions: [{ id: 'extension-capture', startedAt: 1000, cleanup: { applicationStopObserved: true, stopClickedAt: 3000 } }], observation: { samples: [sample] } };
assert.equal(assessExtensionOutput(session).confirmed, true);
assert.equal(assessExtensionOutput({ ...session, audioPreflight: { baselinePanel: answer } }).confirmed, false, 'An old answer is not a new result');
for (const invalid of [
  { ...sample, surface: 'fixture' }, { ...sample, panelPresent: false }, { ...sample, at: 900 }, { ...sample, at: 4000 },
  { ...sample, results: [], text: '1:30 autoupdate on Waiting for question...' },
  { ...sample, results: [{ question: 'What is your favorite color?', answer }] },
  { ...sample, results: [{ ...sample.results[0], answer: 'Loading...' }] },
]) assert.equal(assessExtensionOutput({ ...session, observation: { samples: [invalid] } }).confirmed, false);
assert.equal(assessExtensionOutput({ ...session, sessions: [] }).confirmed, false);
console.log('Extension result: fresh relevant answer, correct surface, active interval and observed Stop gates pass');
