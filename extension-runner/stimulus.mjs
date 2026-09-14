const interviewer = 'Please describe a technical challenge in project Cedar and explain how you solved it.';
const candidate = 'In project Cedar, I improved the database queries and reduced response time by thirty percent. I measured the result before and after the change.';
const microphoneQuestion = 'How would you improve database queries in project Maple and measure response time?';
const practiceAnswer = 'Hi Aria. I would like to practice a technical interview. In project Maple, I improved database queries and reduced response time by thirty percent. Could you ask me a follow-up question about that?';

export function stimulusFor(mode = 'interview') {
  if (!['interview', 'tab-only', 'microphone-only', 'practice'].includes(mode)) throw new Error('Unsupported audio stimulus mode');
  return {
    mode, language: 'en-US',
    microphone: { role: 'candidate', audible: mode !== 'tab-only',
      file: mode === 'tab-only' ? 'silence.wav' : mode === 'microphone-only' ? 'microphone-question.wav' : mode === 'practice' ? 'practice-answer.wav' : 'candidate.wav',
      phrase: mode === 'tab-only' ? null : mode === 'microphone-only' ? microphoneQuestion : mode === 'practice' ? practiceAnswer : candidate },
    tab: { role: mode === 'practice' ? 'live coach' : 'interviewer', audible: mode !== 'microphone-only', file: mode === 'practice' ? null : 'interviewer.wav', phrase: mode === 'microphone-only' || mode === 'practice' ? null : interviewer },
  };
}

export function microphoneMatchesStimulus(stimulus, rms) {
  return Number.isFinite(rms) && (stimulus.microphone.audible ? rms > 0.005 : rms >= 0 && rms < 0.001);
}
