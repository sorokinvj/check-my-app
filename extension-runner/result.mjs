export function assessExtensionOutput(session) {
  const practice = session.sessions?.some(s => s.id === 'ai-practice');
  const capture = session.sessions?.some(s => s.id === 'extension-capture');
  if (!practice) return assessInterviewOutput(session);
  const conversation = assessPracticeOutput(session);
  if (!capture) return conversation;
  const interview = assessInterviewOutput(session);
  return { ...interview, confirmed: interview.confirmed && conversation.confirmed, practice: conversation };
}

function assessInterviewOutput(session) {
  const samples = session.observation?.samples ?? [];
  const lease = session.sessions?.find(s => s.id === 'extension-capture');
  if (!lease?.startedAt || !lease.cleanup?.applicationStopObserved) return { confirmed: false, reason: 'The owned session lifecycle is incomplete' };
  const mode = session.stimulus?.mode;
  const terms = mode === 'practice' ? ['database', 'queries', 'maple', 'response'] : mode === 'microphone-only' ? ['database', 'queries', 'maple', 'response', 'time']
    : ['technical', 'challenge', 'project', 'solved'];
  if (!['microphone-only', 'tab-only', 'interview', 'practice'].includes(mode)) return { confirmed: false, reason: 'No controlled stimulus was recorded' };
  const baseline = session.audioPreflight?.baselinePanel ?? '';
  for (const sample of samples) {
    if (sample.surface !== 'extension-shadow-panel' || !sample.panelPresent || sample.at < lease.startedAt || sample.at > lease.cleanup.stopClickedAt) continue;
    for (const result of sample.results ?? []) {
      if (typeof result.question !== 'string' || typeof result.answer !== 'string' || result.answer.trim().length < 40 || baseline.includes(result.answer.trim())) continue;
      const words = new Set(result.question.toLowerCase().match(/[a-z]+/g) ?? []);
      if (terms.filter(term => words.has(term)).length < (mode === 'practice' ? 2 : terms.length - 1)) continue;
      return { confirmed: true, surface: 'extension-shadow-panel', observedAt: sample.at, mode, question: result.question, answer: result.answer };
    }
  }
  return { confirmed: false, reason: 'No fresh relevant question and answer were observed during the owned session' };
}

export function assessPracticeOutput(session) {
  const lease = session.sessions?.find(s => s.id === 'ai-practice');
  if (!lease?.startedAt || !lease.cleanup?.applicationStopObserved || session.practiceMicrophone?.microphoneOn !== true) return { confirmed: false, reason: 'The practice microphone or owned lifecycle is incomplete' };
  const technical = text => [/\bmaple\b/i, /\bdatabase\b/i, /\bquer(?:y|ies)\b/i, /\bresponse time\b/i].filter(term => term.test(text)).length >= 2;
  let candidateAt;
  for (const sample of session.practiceObservation?.samples ?? []) {
    if (sample.surface !== 'practice-page' || !sample.callActive || sample.at < lease.startedAt || sample.at > lease.cleanup.stopClickedAt) continue;
    for (const utterance of sample.utterances ?? []) {
      if (typeof utterance.text !== 'string') continue;
      if (utterance.speaker === 'You' && technical(utterance.text)) candidateAt ??= sample.at;
      if (candidateAt && sample.at > candidateAt && utterance.speaker === 'Aria' && utterance.text.length >= 40 && technical(utterance.text)) {
        return { confirmed: true, surface: 'practice-page', mode: 'practice', observedAt: sample.at, answer: utterance.text };
      }
    }
  }
  return { confirmed: false, reason: 'A new relevant coach response after the candidate utterance was not observed' };
}
