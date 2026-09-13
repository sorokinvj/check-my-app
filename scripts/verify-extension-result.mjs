import assert from 'node:assert/strict';
import { assessExtensionOutput, assessPracticeOutput } from '../extension-runner/result.mjs';
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

const candidate = { at: 1500, surface: 'practice-page', callActive: true, utterances: [{ speaker: 'You', text: 'In project Maple I improved database queries.' }] };
const coach = { at: 2000, surface: 'practice-page', callActive: true, utterances: [{ speaker: 'Aria', text: 'How did you identify which database queries were slow in project Maple, and measure the improvement?' }] };
const practice = { practiceMicrophone: { microphoneOn: true }, sessions: [{ ...session.sessions[0], id: 'ai-practice' }], practiceObservation: { samples: [candidate, coach] } };
assert.equal(assessExtensionOutput(practice).confirmed, true);
assert.equal(assessPracticeOutput({ ...practice, practiceMicrophone: {} }).confirmed, false);
assert.equal(assessPracticeOutput({ ...practice, practiceObservation: { samples: [coach] } }).confirmed, false, 'A greeting or response without candidate input cannot establish microphone delivery');
assert.equal(assessPracticeOutput({ ...practice, practiceObservation: { samples: [coach, { ...candidate, at: 2500 }] } }).confirmed, false, 'The response must follow the candidate');
assert.equal(assessPracticeOutput({ ...practice, practiceObservation: { samples: [candidate, { ...coach, at: 4000 }] } }).confirmed, false);
assert.equal(assessPracticeOutput({ ...practice, practiceObservation: { samples: [candidate, { ...coach, utterances: [{ speaker: 'Aria', text: 'What was the most challenging part of optimizing those queries?' }] }] } }).confirmed, true);
assert.equal(assessPracticeOutput({ ...practice, practiceObservation: { samples: [candidate, { ...coach, utterances: [{ speaker: 'Aria', text: 'Hello and welcome! I am happy to help you get started today.' }] }] } }).confirmed, false);
assert.equal(assessExtensionOutput({ ...session, ...practice, sessions: [...session.sessions, ...practice.sessions] }).confirmed, true);
assert.equal(assessExtensionOutput({ ...session, ...practice, observation: { samples: [] }, sessions: [...session.sessions, ...practice.sessions] }).confirmed, false, 'A combined scenario requires both products to answer');

const oldQuestionThenCandidate = { ...coach, at: 1800, utterances: [...coach.utterances, ...candidate.utterances] };
assert.equal(assessPracticeOutput({ ...practice, practiceObservation: { samples: [oldQuestionThenCandidate, { ...oldQuestionThenCandidate, at: 2500 }] } }).confirmed, false, 'A repeated cumulative transcript cannot turn the coach question into a new reply');
const newReply = { speaker: 'Aria', text: 'Which indexes did you add to improve those database queries, and how did you measure latency?' };
assert.equal(assessPracticeOutput({ ...practice, practiceObservation: { samples: [oldQuestionThenCandidate, { ...oldQuestionThenCandidate, at: 2500, utterances: [...oldQuestionThenCandidate.utterances, newReply] }] } }).confirmed, true);

const explicitFailure = { ...session, audioPreflight: { passed: true }, observation: { samples: [{ ...sample, results: [], alerts: ['The response service is unavailable.'] }] } };
assert.equal(assessExtensionOutput(explicitFailure).failure?.source, 'visible-product-alert');
assert.equal(assessExtensionOutput({ ...explicitFailure, audioPreflight: { passed: false } }).failure, undefined);
assert.equal(assessExtensionOutput({ ...explicitFailure, runtimeFailure: { kind: 'browser-exited' } }).failure, undefined);
assert.equal(assessExtensionOutput({ ...explicitFailure, observation: { samples: [{ ...sample, alerts: ['Too many requests: error 429'] }] } }).failure, undefined);
