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

const liveCoach = { ...coach, at: 1800, utterances: [{ speaker: 'Aria', text: 'Okay, focusing on those queries and that 30% reduction. What part of the database stack were you working on?' }] };
const paraphrased = { ...session, ...practice, stimulus: { mode: 'practice' }, sessions: [...session.sessions, ...practice.sessions],
  practiceObservation: { samples: [candidate, liveCoach] }, observation: { samples: [{ ...sample, results: [{ question: 'What part of the database stack were you working on to achieve the 30% reduction?', answer }] }] } };
assert.equal(assessExtensionOutput(paraphrased).confirmed, true, 'The real coach question is stronger provenance than a fixed phrase');
for (const text of ['Tell me how you improved database queries in project Maple.', 'How did you improve database queries in project Maple']) {
  const prompt = { ...paraphrased, practiceObservation: { samples: [candidate, { ...liveCoach, utterances: [{ speaker: 'Aria', text }] }] },
    observation: { samples: [{ ...sample, results: [{ question: 'How did you improve database queries in project Maple?', answer }] }] } };
  assert.equal(assessExtensionOutput(prompt).confirmed, true, 'Imperative and unpunctuated spoken prompts have the same observed provenance');
}
for (const invalid of [
  { ...paraphrased, practiceObservation: { samples: [liveCoach] } },
  { ...paraphrased, practiceObservation: { samples: [candidate, { ...liveCoach, at: 4000 }] } },
  { ...paraphrased, observation: { samples: [{ ...sample, results: [{ question: 'Which database has the nicest logo?', answer }] }] } },
]) assert.equal(assessExtensionOutput(invalid).confirmed, false, 'A question needs current candidate input and an earlier matching coach question');
const repeatedAnswer = { ...paraphrased, practiceObservation: { samples: [candidate, { ...liveCoach, at: 2500 }] },
  observation: { samples: [1800, 2800].map(at => ({ ...structuredClone(paraphrased.observation.samples[0]), at })) } };
assert.equal(assessExtensionOutput(repeatedAnswer).confirmed, false, 'Later coach speech cannot validate an unchanged answer from an earlier poll');
const changedAnswer = structuredClone(repeatedAnswer);
changedAnswer.observation.samples[1].results[0].answer += ' I compared query plans before and after indexing the database.';
assert.equal(assessExtensionOutput(changedAnswer).confirmed, true, 'A new answer after the observed coach prompt is eligible');

const oldQuestionThenCandidate = { ...coach, at: 1800, utterances: [...coach.utterances, ...candidate.utterances] };
assert.equal(assessPracticeOutput({ ...practice, practiceObservation: { samples: [oldQuestionThenCandidate, { ...oldQuestionThenCandidate, at: 2500 }] } }).confirmed, false, 'A repeated cumulative transcript cannot turn the coach question into a new reply');
const newReply = { speaker: 'Aria', text: 'Which indexes did you add to improve those database queries, and how did you measure latency?' };
assert.equal(assessPracticeOutput({ ...practice, practiceObservation: { samples: [oldQuestionThenCandidate, { ...oldQuestionThenCandidate, at: 2500, utterances: [...oldQuestionThenCandidate.utterances, newReply] }] } }).confirmed, true);

const explicitFailure = { ...session, audioPreflight: { passed: true }, observation: { samples: [{ ...sample, results: [], alerts: ['The response service is unavailable.'] }] } };
assert.equal(assessExtensionOutput(explicitFailure).failure?.source, 'visible-product-alert');
for (const alert of ['No error occurred.', 'No error occurred and no requests failed.', 'Connected without any error.', 'The earlier error was resolved.', 'The earlier error is now resolved.', 'The error has been fully resolved.', 'The earlier error was automatically resolved.', 'Connection error: recovered.', 'The connection error was recovered automatically.', 'Error-free session.']) {
  const result = assessExtensionOutput({ ...explicitFailure, observation: { samples: [{ ...sample, alerts: [alert] }] } });
  assert.equal(result.failure, undefined, 'A negated or resolved error is not positive failure evidence');
  assert.equal(result.confirmed, true, 'An affirmative recovery does not invalidate an observed answer');
}
for (const alert of ['The error could not be resolved.', 'The error has not yet been resolved.', 'Connection failed, you can try again.', 'The error was not resolved.', 'The errors were not resolved.', 'The failure has not been cleared.', 'The error was resolved, but the response failed.', 'No errors connecting; the response service is unavailable.']) {
  const result = assessExtensionOutput({ ...explicitFailure, observation: { samples: [{ ...sample, alerts: [alert] }] } });
  assert.equal(result.confirmed, false, 'An unresolved error takes precedence over an earlier answer');
  assert.equal(result.failure?.source, 'visible-product-alert');
}
for (const alert of ['The error will be resolved.', 'This error can be resolved by retrying the request.', 'The connection error is being resolved.', 'The error has probably been resolved.', 'The service is not unavailable.', 'No errors were resolved.', 'Error details.', 'The request might have failed.']) {
  const result = assessExtensionOutput({ ...explicitFailure, observation: { samples: [{ ...sample, alerts: [alert] }] } });
  assert.equal(result.confirmed, false, 'Uncertain recovery cannot validate an earlier answer');
  assert.equal(result.failure, undefined, 'Ambiguous wording cannot become a product allegation');
}
assert.equal(assessExtensionOutput({ ...explicitFailure, audioPreflight: { passed: false } }).failure, undefined);
assert.equal(assessExtensionOutput({ ...explicitFailure, runtimeFailure: { kind: 'browser-exited' } }).failure, undefined);
assert.equal(assessExtensionOutput({ ...explicitFailure, observation: { samples: [{ ...sample, alerts: ['Too many requests: error 429'] }] } }).failure, undefined);
