export function assessExtensionOutput(session) {
  const result = assessOutputs(session);
  const failure = assessVisibleSessionFailure(session);
  return failure ? { ...result, confirmed: false, failure } : result;
}

function assessOutputs(session) {
  const practice = session.sessions?.some(s => s.id === 'ai-practice');
  const capture = session.sessions?.some(s => s.id === 'extension-capture');
  if (!practice) return assessInterviewOutput(session);
  const conversation = assessPracticeOutput(session);
  if (!capture) return conversation;
  const interview = assessInterviewOutput(session);
  return { ...interview, confirmed: interview.confirmed && conversation.confirmed, practice: conversation };
}

export function assessVisibleSessionFailure(session) {
  if (!session.audioPreflight?.passed || session.runtimeFailure) return null;
  for (const [id, observation, surface] of [
    ['extension-capture', session.observation, 'extension-shadow-panel'],
    ['ai-practice', session.practiceObservation, 'practice-page'],
  ]) {
    const lease = session.sessions?.find(s => s.id === id);
    if (!lease?.startedAt || !lease.cleanup?.applicationStopObserved) continue;
    for (const sample of observation?.samples ?? []) {
      if (sample.surface !== surface || sample.at < lease.startedAt || sample.at > lease.cleanup.stopClickedAt) continue;
      if (surface === 'extension-shadow-panel' ? !sample.panelPresent : !sample.callActive) continue;
      for (const text of sample.alerts ?? []) {
        if (typeof text !== 'string' || text.length > 1000 || observation.baseline?.includes(text)) continue;
        if (!/\b(error|failed|unavailable|unable to|could not)\b/i.test(text)) continue;
        if (/\b(?:no|zero|without)\s+(?:\w+\s+){0,2}(?:errors?|failures?)\b|\b(?:error|failure)[ -]free\b|\b(?:error|failure).{0,40}\b(?:resolved|cleared|recovered)\b/i.test(text)) continue;
        if (/credential|password|sign.?in|log.?in|permission|denied|microphone|insufficient|balance|minutes|payment|quota|too many|rate.?limit|429/i.test(text)) continue;
        return { source: 'visible-product-alert', text, observedAt: sample.at, surface };
      }
    }
  }
  return null;
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
  let candidateObserved = false;
  const seenCoachReplies = new Set();
  for (const sample of session.practiceObservation?.samples ?? []) {
    if (sample.surface !== 'practice-page' || !sample.callActive || sample.at < lease.startedAt || sample.at > lease.cleanup.stopClickedAt) continue;
    for (const utterance of sample.utterances ?? []) {
      if (typeof utterance.text !== 'string') continue;
      if (utterance.speaker === 'You' && technical(utterance.text)) candidateObserved = true;
      // A relevant follow-up can refer to "those queries" without repeating
      // the candidate's project name. Require a concrete topic term after the
      // complete controlled candidate input, rather than a generic greeting.
      const related = /\b(?:maple|database|quer(?:y|ies)|response time|latency|indexes|indexing|bottleneck)\b/i.test(utterance.text);
      if (utterance.speaker !== 'Aria') continue;
      const reply = utterance.text.trim().replace(/\s+/g, ' ');
      const fresh = !seenCoachReplies.has(reply);
      seenCoachReplies.add(reply);
      // Transcript snapshots are cumulative. An earlier question remains on
      // screen after the candidate speaks; a later poll cannot make it a reply.
      if (fresh && candidateObserved && utterance.text.length >= 40 && related) {
        return { confirmed: true, surface: 'practice-page', mode: 'practice', observedAt: sample.at, answer: utterance.text };
      }
    }
  }
  return { confirmed: false, reason: 'A new relevant coach response after the candidate utterance was not observed' };
}
