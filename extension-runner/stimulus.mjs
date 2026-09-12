const interviewer = 'Please describe a technical challenge in project Cedar and explain how you solved it.';
const candidate = 'In project Cedar, I improved the database queries and reduced response time by thirty percent. I measured the result before and after the change.';
const microphoneQuestion = 'How would you improve database queries in project Maple and measure response time?';

export function stimulusFor(mode = 'interview') {
  if (!['interview', 'tab-only', 'microphone-only'].includes(mode)) throw new Error('Unsupported audio stimulus mode');
  return {
    mode, language: 'en-US',
    microphone: { role: 'candidate', audible: mode !== 'tab-only',
      file: mode === 'tab-only' ? 'silence.wav' : mode === 'microphone-only' ? 'microphone-question.wav' : 'candidate.wav',
      phrase: mode === 'tab-only' ? null : mode === 'microphone-only' ? microphoneQuestion : candidate },
    tab: { role: 'interviewer', audible: mode !== 'microphone-only', file: 'interviewer.wav', phrase: mode === 'microphone-only' ? null : interviewer },
  };
}

export function microphoneMatchesStimulus(stimulus, rms) {
  return Number.isFinite(rms) && (stimulus.microphone.audible ? rms > 0.005 : rms >= 0 && rms < 0.001);
}
