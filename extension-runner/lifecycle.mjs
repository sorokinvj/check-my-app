// These are product controls, exercised locally so the short confirmation
// window cannot be consumed by a network round trip to the planning agent.
export async function stopWithConfirmation({ stop, confirm, stopped, now = Date.now, windowMs = 2800 }) {
  const startedAt = now();
  await stop.click({ timeout: 1500 });
  const confirmedAt = startedAt;
  await confirm.waitFor({ state: 'visible', timeout: Math.max(1, windowMs - (now() - confirmedAt)) });
  if (now() - confirmedAt >= windowMs) throw new Error('Stop confirmation expired');
  await confirm.click({ timeout: Math.max(1, windowMs - (now() - confirmedAt)) });
  const clickedAt = now();
  await stopped.waitFor({ state: 'hidden', timeout: 15_000 });
  return { stopClickedAt: startedAt, confirmClickedAt: clickedAt, stoppedAt: now(), applicationStopObserved: true };
}

export class SessionLedger {
  constructor(ownerRunId, now = Date.now, onSettled = () => {}) { this.ownerRunId = ownerRunId; this.now = now; this.onSettled = onSettled; this.entries = []; }
  register({ id, targetId, maxSeconds, stop }) {
    if (!id || !targetId || this.entries.some(e => e.entry.id === id)) throw new Error('Unique owned session identity required');
    if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 600) throw new Error('Invalid session limit');
    const entry = { id, targetId, ownerRunId: this.ownerRunId, registeredAt: this.now(), expiresAt: this.now() + maxSeconds * 1000, state: 'pending', cleanup: null };
    const task = { entry, stop, promise: null, timer: null };
    this.entries.push(task);
    // Registration precedes Start, so an interrupted Start still has cleanup.
    task.timer = setTimeout(() => void this.end(id).catch(() => {}), maxSeconds * 1000);
    task.timer.unref?.();
    return entry;
  }
  async end(id) {
    const task = this.entries.find(t => t.entry.id === id);
    if (!task) throw new Error('Session does not belong to this run');
    if (task.promise) return task.promise;
    clearTimeout(task.timer);
    task.promise = (async () => {
      task.entry.state = 'stopping';
      try {
        const result = await task.stop();
        if (result?.applicationStopObserved !== true) throw new Error('Application Stop was not observed');
        task.entry.state = 'stopped'; task.entry.cleanup = result;
      } catch (error) {
        task.entry.state = 'unverified'; task.entry.cleanup = { error: error.message, at: this.now() };
      }
      this.onSettled(this.snapshot());
      return task.entry;
    })();
    return task.promise;
  }
  started(id) {
    const task = this.entries.find(t => t.entry.id === id);
    if (!task || task.entry.state !== 'pending') throw new Error('Session cannot start outside its pending lease');
    task.entry.state = 'active'; task.entry.startedAt = this.now();
  }
  async endAll() { return Promise.all(this.entries.map(t => this.end(t.entry.id))); }
  snapshot() { return this.entries.map(t => ({ ...t.entry })); }
  get clean() { return this.entries.every(t => t.entry.state === 'stopped'); }
}
