export function assessExtensionOutput(session) {
  const samples = session.observation?.samples ?? [];
  const lease = session.sessions?.find(s => s.id === 'extension-capture');
  if (!lease?.startedAt || !lease.cleanup?.applicationStopObserved) return { confirmed: false, reason: 'The owned session lifecycle is incomplete' };
  const mode = session.stimulus?.mode;
  const terms = mode === 'microphone-only' ? ['database', 'queries', 'maple', 'response', 'time']
    : ['technical', 'challenge', 'project', 'solved'];
  if (!['microphone-only', 'tab-only', 'interview'].includes(mode)) return { confirmed: false, reason: 'No controlled stimulus was recorded' };
  const baseline = session.audioPreflight?.baselinePanel ?? '';
  for (const sample of samples) {
    if (sample.surface !== 'extension-shadow-panel' || !sample.panelPresent || sample.at < lease.startedAt || sample.at > lease.cleanup.stopClickedAt) continue;
    for (const result of sample.results ?? []) {
      if (typeof result.question !== 'string' || typeof result.answer !== 'string' || result.answer.trim().length < 40 || baseline.includes(result.answer.trim())) continue;
      const words = new Set(result.question.toLowerCase().match(/[a-z]+/g) ?? []);
      if (terms.filter(term => words.has(term)).length < terms.length - 1) continue;
      return { confirmed: true, surface: 'extension-shadow-panel', observedAt: sample.at, mode, question: result.question, answer: result.answer };
    }
  }
  return { confirmed: false, reason: 'No fresh relevant question and answer were observed during the owned session' };
}
