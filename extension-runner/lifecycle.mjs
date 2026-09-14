// These are product controls, exercised locally so the short confirmation
// window cannot be consumed by a network round trip to the planning agent.
export function sessionStopDeferred(sessions, minimumSeconds, now = Date.now()) {
  if (minimumSeconds === undefined) return false;
  if (!Number.isInteger(minimumSeconds) || minimumSeconds < 0 || minimumSeconds > 120) throw new Error('Invalid minimum observation duration');
  return sessions.some(session => session.state === 'active' && Number.isFinite(session.startedAt) && now - session.startedAt < minimumSeconds * 1000);
}

export async function stopWithConfirmation({ stop, confirm, stopped, now = Date.now, windowMs = 2800 }) {
  // Native Stop timed out while scrolling in the combined call. Establish
  // reachability without clicking before the short confirmation window starts.
  await stop.click({ trial: true, timeout: 10_000 });
  const startedAt = now();
  await stop.click({ timeout: 1500 });
  const stopClickDoneAt = now();
  const confirmedAt = startedAt;
  // Run 7 (2026-09-14) threw here with 1573ms of windowMs=2800 left at the
  // confirm click — we could not tell whether that was consumed by the stop
  // click, the visibility wait, or the click itself, because the error
  // carried none of the split. Every branch below reports the same
  // breakdown so the next real failure is diagnosable from its message
  // alone, without re-instrumenting. windowMs models the extension's own
  // confirmation-dialog lifetime (server.mjs's "three-second window"
  // comment), not a budget we are free to widen without evidence it is
  // actually the extension that is slow — see docs/extension-verification.md
  // (a clean run showed End→Confirm as close as 486ms), so the fix for a
  // timeout here is diagnosis, not a bigger number.
  const budgetAt = label => `stopClick=${stopClickDoneAt - startedAt}ms ${label}=${now() - stopClickDoneAt}ms elapsed=${now() - confirmedAt}ms/${windowMs}ms`;
  let confirmVisibleAt;
  try {
    await confirm.waitFor({ state: 'visible', timeout: Math.max(1, windowMs - (now() - confirmedAt)) });
    confirmVisibleAt = now();
  } catch (error) {
    throw new Error(`Stop confirmation expired waiting for the dialog to appear (${budgetAt('waitFor')}): ${error.message}`);
  }
  if (now() - confirmedAt >= windowMs) throw new Error(`Stop confirmation expired before the dialog was visible (${budgetAt('waitFor')})`);
  try {
    await confirm.click({ timeout: Math.max(1, windowMs - (now() - confirmedAt)) });
  } catch (error) {
    throw new Error(`Stop confirmation expired clicking Confirm (${budgetAt('click')}, visibleAfter=${confirmVisibleAt - stopClickDoneAt}ms): ${error.message}`);
  }
  const clickedAt = now();
  await stopped.waitFor({ state: 'hidden', timeout: 15_000 });
  return { stopClickedAt: startedAt, confirmClickedAt: clickedAt, stoppedAt: now(), applicationStopObserved: true };
}

export function settleSessionCleanup(entries, { failed, stopped }) {
  if (entries.some(entry => entry.state === 'unverified')) return failed();
  if (entries.length && entries.every(entry => ['stopped', 'not-started'].includes(entry.state))) return stopped();
}

export class SessionLedger {
  constructor(ownerRunId, now = Date.now, onSettled = () => {}) { this.ownerRunId = ownerRunId; this.now = now; this.onSettled = onSettled; this.entries = []; this.cleanupTail = Promise.resolve(); }
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
    if (task.entry.state === 'not-started') return task.entry;
    if (task.promise) return task.promise;
    clearTimeout(task.timer);
    // Two paid meters can share one tab. Their Stop dialogs must not race for
    // focus, including when separate deadlines fire at the same instant.
    task.promise = this.cleanupTail.then(async () => {
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
    });
    this.cleanupTail = task.promise.then(() => {}, () => {});
    return task.promise;
  }
  started(id) {
    const task = this.entries.find(t => t.entry.id === id);
    if (!task || task.entry.state !== 'pending') throw new Error('Session cannot start outside its pending lease');
    task.entry.state = 'active'; task.entry.startedAt = this.now();
  }
  rejected(id, reason) {
    const task = this.entries.find(t => t.entry.id === id);
    if (!task || task.entry.state !== 'pending') throw new Error('Only an explicitly rejected pending Start can be released');
    clearTimeout(task.timer);
    task.entry.state = 'not-started'; task.entry.rejection = reason;
  }
  async endAll() { return Promise.all(this.entries.map(t => this.end(t.entry.id))); }
  snapshot() { return this.entries.map(t => ({ ...t.entry })); }
  get clean() { return this.entries.every(t => ['stopped', 'not-started'].includes(t.entry.state)); }
}
