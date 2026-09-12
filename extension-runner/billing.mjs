const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function assessUiBilling({ baseline, stopped, later, sessions, samples = [] }) {
  const inconclusive = reason => ({ status: 'inconclusive', cleanupConfirmed: false, reason });
  if (!baseline || !stopped || !later || [baseline, stopped, later].some(s => s.source !== 'account-ui' || !Number.isSafeInteger(s.balance) || !Array.isArray(s.history))) return inconclusive('The displayed balance or history is missing');
  if (later.at - stopped.at < 65_000) return inconclusive('The post-Stop observation is too short');
  if (later.balance !== stopped.balance) return inconclusive('The displayed balance changed after Stop');
  if (!sessions.length || sessions.some(s => !s.startedAt || !s.cleanup?.applicationStopObserved)) return inconclusive('Owned application Stop is missing');
  const previous = new Set(baseline.history?.map(h => h.id) ?? []);
  const newRows = (later.history ?? []).filter(h => !previous.has(h.id));
  if (newRows.length !== sessions.length) return inconclusive('The new history rows cannot be attributed to the owned sessions');
  const rows = [];
  for (const session of sessions) {
    const kind = session.id === 'extension-capture' ? 'extension' : session.id === 'ai-practice' ? 'practice' : null;
    const matches = newRows.filter(h => h.kind === kind);
    if (matches.length !== 1) return inconclusive('An owned meter has no unique history row');
    const row = matches[0];
    const date = Date.parse(`${row.dateUtc.replace(' ', 'T')}:00Z`);
    if (!Number.isFinite(date) || Math.abs(date - session.startedAt) > 65_000 || !Number.isSafeInteger(row.durationSeconds) || row.durationSeconds < 1) return inconclusive('The history row does not identify the owned session');
    // A seconds-only display cannot settle a subsecond rounding boundary.
    if (row.durationSeconds % 60 === 0) return inconclusive('The displayed duration is on a minute-rounding boundary');
    rows.push(row);
  }
  const expectedMinutes = rows.reduce((sum, row) => sum + Math.ceil(row.durationSeconds / 60), 0);
  const observedMinutes = baseline.balance - stopped.balance;
  if (observedMinutes !== expectedMinutes) return inconclusive('The visible debit does not establish the per-session rounding');
  const deltas = samples.filter(s => s.source === 'account-ui').map(s => baseline.balance - s.balance);
  const twoMinuteSteps = rows.every(r => r.durationSeconds >= 120) && deltas.includes(sessions.length) && deltas.includes(sessions.length * 2);
  return { status: 'confirmed', cleanupConfirmed: true, expectedMinutes, observedMinutes, twoMinuteSteps, sessions: rows, cessationMs: later.at - stopped.at };
}

export class BillingObservation {
  constructor({ baseline, readBalance, readSnapshot, intervalMs = 15_000, cessationMs = 65_000, finishTimeoutMs = 110_000 }) {
    this.baseline = baseline; this.readBalance = readBalance; this.readSnapshot = readSnapshot;
    this.intervalMs = intervalMs; this.cessationMs = cessationMs; this.finishTimeoutMs = finishTimeoutMs; this.samples = []; this.stopping = false;
  }
  start() {
    if (this.task) throw new Error('Billing observation already started');
    this.task = (async () => {
      while (!this.stopping) {
        try { this.samples.push(await this.readBalance()); } catch { this.samples.push({ at: Date.now(), error: 'Account UI observation unavailable' }); }
        if (!this.stopping) await new Promise(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, this.intervalMs); });
      }
    })();
  }
  async finish(sessions) {
    this.stopping = true; clearTimeout(this.timer); this.wake?.();
    let timeout;
    try {
      return await Promise.race([this.finishObservations(sessions), new Promise(resolve => {
        timeout = setTimeout(() => resolve({ baseline: this.baseline, samples: this.samples, assessment: { status: 'inconclusive', cleanupConfirmed: false, reason: 'Post-Stop account observation exceeded its deadline' } }), this.finishTimeoutMs);
      })]);
    } finally { clearTimeout(timeout); }
  }
  async finishObservations(sessions) {
    await this.task;
    try {
      const stopped = await this.readSnapshot();
      await delay(this.cessationMs);
      const later = await this.readSnapshot();
      const assessment = assessUiBilling({ baseline: this.baseline, stopped, later, sessions, samples: this.samples });
      return { baseline: this.baseline, samples: this.samples, stopped, later, assessment };
    } catch { return { baseline: this.baseline, samples: this.samples, assessment: { status: 'inconclusive', cleanupConfirmed: false, reason: 'Account UI observation unavailable' } }; }
  }
}
