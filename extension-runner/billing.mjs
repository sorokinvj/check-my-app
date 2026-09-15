const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Cessation is the meter having STOPPED moving, not the meter never having
// moved. The old rule compared one reading at Stop with one a minute later and
// refused if they differed — but the minutes of the session that just ended are
// debited in exactly that window, so the answer depended on whether the debit
// landed before or after our first look: run #194 confirmed and #196 refused,
// same scenario and same code (CHE-250). `readings` is the post-Stop series,
// oldest first; charging has ceased when the last two agree.
export function assessUiBilling({ baseline, readings = [], sessions, samples = [] }) {
  let cessation = {};
  const inconclusive = reason => ({ status: 'inconclusive', cleanupConfirmed: false, ...cessation, reason });
  const stopped = readings[0], settled = readings.at(-1), previousReading = readings.at(-2);
  if (!baseline || readings.length < 2 || [baseline, ...readings].some(s => !s || s.source !== 'account-ui' || !Number.isSafeInteger(s.balance) || !Array.isArray(s.history))) return inconclusive('The displayed balance or history is missing');
  if (settled.at - previousReading.at < 65_000) return inconclusive('The post-Stop observation is too short');
  if (settled.balance !== previousReading.balance) return inconclusive('The displayed balance was still changing after Stop');
  if (!sessions.length || sessions.some(s => !s.startedAt || !s.cleanup?.applicationStopObserved)) return inconclusive('Owned application Stop is missing');
  // Stop and a settled balance establish cessation independently of whether
  // the product exposes enough history to verify each meter's rounding.
  // `postStopChange` is what the person watching the screen would have seen
  // move after the product told them the session had stopped.
  cessation = { cleanupConfirmed: true, observedMinutes: baseline.balance - settled.balance, cessationMs: settled.at - stopped.at,
    postStopChange: stopped.balance - settled.balance, postStopSettledMs: settled.at - stopped.at };
  const previous = new Set(baseline.history?.map(h => h.id) ?? []);
  const newRows = (settled.history ?? []).filter(h => !previous.has(h.id));
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
  const observedMinutes = baseline.balance - settled.balance;
  if (observedMinutes !== expectedMinutes) return inconclusive('The visible debit does not establish the per-session rounding');
  const deltas = samples.filter(s => s.source === 'account-ui').map(s => baseline.balance - s.balance);
  const twoMinuteSteps = rows.every(r => r.durationSeconds >= 120) && deltas.includes(sessions.length) && deltas.includes(sessions.length * 2);
  return { status: 'confirmed', cleanupConfirmed: true, expectedMinutes, observedMinutes, twoMinuteSteps, sessions: rows,
    cessationMs: settled.at - stopped.at, postStopChange: stopped.balance - settled.balance, postStopSettledMs: settled.at - stopped.at };
}

export class BillingObservation {
  // finishTimeoutMs covers the settle loop below: up to three readings with a
  // cessation wait between each, plus the reads themselves.
  constructor({ baseline, readBalance, readSnapshot, intervalMs = 15_000, cessationMs = 65_000, finishTimeoutMs = 240_000, maxReadings = 3 }) {
    this.maxReadings = maxReadings;
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
    this.cancel();
    let timeout;
    try {
      return await Promise.race([this.finishObservations(sessions), new Promise(resolve => {
        timeout = setTimeout(() => resolve({ baseline: this.baseline, samples: this.samples, assessment: { status: 'inconclusive', cleanupConfirmed: false, reason: 'Post-Stop account observation exceeded its deadline' } }), this.finishTimeoutMs);
      })]);
    } finally { clearTimeout(timeout); }
  }
  cancel() { this.stopping = true; clearTimeout(this.timer); this.wake?.(); }
  async finishObservations(sessions) {
    await this.task;
    try {
      // Read until two consecutive readings agree: that is the meter having
      // stopped. A balance that never moved settles on the second reading and
      // costs nothing extra; one still posting the ended session's minutes
      // takes one more.
      const readings = [await this.readSnapshot()];
      while (readings.length < this.maxReadings) {
        await delay(this.cessationMs);
        readings.push(await this.readSnapshot());
        if (readings.at(-1).balance === readings.at(-2).balance) break;
      }
      const assessment = assessUiBilling({ baseline: this.baseline, readings, sessions, samples: this.samples });
      return { baseline: this.baseline, samples: this.samples, readings, stopped: readings[0], later: readings.at(-1), assessment };
    } catch { return { baseline: this.baseline, samples: this.samples, assessment: { status: 'inconclusive', cleanupConfirmed: false, reason: 'Account UI observation unavailable' } }; }
  }
}
