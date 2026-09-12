export function sessionView({ session, sessions, observation, practiceObservation, billing }) {
  const samples = observation?.samples ?? [];
  const startedAt = Math.min(...sessions.flatMap(s => s.startedAt ? [s.startedAt] : []));
  const latest = [...samples].reverse().find(s => s.surface === 'extension-shadow-panel' && s.panelPresent && s.at >= startedAt && s.results?.length);
  return {
    sessions: sessions.map(s => ({ name: s.id === 'extension-capture' ? 'Interview assistance' : 'Practice', state: s.state,
      ...(s.startedAt ? { elapsedSeconds: Math.floor(((s.cleanup?.stopClickedAt ?? Date.now()) - s.startedAt) / 1000) } : {}),
      applicationStopObserved: s.cleanup?.applicationStopObserved === true })),
    questionAndAnswers: latest?.results ?? [],
    practiceConversation: [...(practiceObservation?.samples ?? [])].reverse().find(s => s.surface === 'practice-page' && s.callActive && s.at >= startedAt && s.utterances?.length)?.utterances ?? [],
    ...(latest ? { observedAt: latest.at } : {}),
    minuteAccounting: billing?.assessment?.status ?? (sessions.length ? 'pending' : 'not-started'),
    ...(billing?.assessment?.status === 'confirmed' ? { minutesUsed: billing.assessment.observedMinutes, balanceUnchangedAfterStop: true } : {}),
    complete: sessions.length > 0 && sessions.every(s => ['stopped', 'unverified'].includes(s.state)) && Boolean(billing?.assessment),
    runtimeFailed: Boolean(session?.runtimeFailure),
  };
}
