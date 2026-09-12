function wait(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    if (signal?.aborted) done(); else signal?.addEventListener('abort', done, { once: true });
  });
}

// Sampling belongs to the executor's session lifetime, never to a later agent
// turn. The first JobLander capture stopped before that later turn could read it.
export class SessionObservation {
  constructor({ ownerRunId, targetId, read, baseline = '', intervalMs = 1000, readTimeoutMs = 3000, maxSamples = 240, now = Date.now }) {
    this.ownerRunId = ownerRunId; this.targetId = targetId; this.read = read; this.baseline = baseline;
    this.intervalMs = intervalMs; this.readTimeoutMs = readTimeoutMs; this.maxSamples = maxSamples; this.now = now;
    this.samples = []; this.controller = new AbortController(); this.task = null; this.stoppedAt = null;
  }
  start() {
    if (this.task) throw new Error('Session observation already started');
    this.startedAt = this.now();
    this.task = this.collect();
  }
  async collect() {
    while (!this.controller.signal.aborted) {
      const at = this.now();
      let timeout;
      try {
        const value = await Promise.race([
          this.read(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Session observation timed out')), this.readTimeoutMs); }),
        ]);
        this.samples.push({ at, ...value, changedFromBaseline: Boolean(value.text && value.text !== this.baseline) });
      } catch (error) { this.samples.push({ at, error: error.message }); }
      finally { clearTimeout(timeout); }
      if (this.samples.length > this.maxSamples) this.samples.splice(1, this.samples.length - this.maxSamples);
      await wait(this.intervalMs, this.controller.signal);
    }
  }
  async finish() {
    this.controller.abort();
    await this.task;
    this.stoppedAt ??= this.now();
    return this.snapshot();
  }
  snapshot() {
    return { ownerRunId: this.ownerRunId, targetId: this.targetId, startedAt: this.startedAt, stoppedAt: this.stoppedAt, baseline: this.baseline, samples: [...this.samples] };
  }
}

export async function readExtensionPanel(page) {
  return page.evaluate(() => {
    const host = document.querySelector('#joblander-extension-host');
    const panel = host?.shadowRoot?.querySelector('#joblander-extension-root');
    const audio = document.querySelector('audio');
    const results = Array.from(panel?.querySelectorAll('[data-testid="question"]') ?? []).flatMap(question => {
      const box = question.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return [];
      // This card relationship was observed in the production panel. A changed
      // structure returns no answer rather than mistaking its timer for output.
      const card = question.parentElement?.parentElement?.parentElement;
      const answer = Array.from(card?.children ?? []).filter(child => !child.contains(question)).map(child => child.innerText).join('\n').trim();
      return [{ question: question.innerText?.trim() ?? '', answer: answer.slice(0, 8000) }];
    });
    return {
      surface: 'extension-shadow-panel',
      text: panel?.innerText?.slice(0, 12_000) ?? '',
      panelPresent: Boolean(panel && panel.getBoundingClientRect().width),
      results,
      ...(location.origin === 'http://127.0.0.1:9091' && audio ? { tabStimulus: { playing: !audio.paused, currentTime: audio.currentTime, readyState: audio.readyState } } : {}),
    };
  });
}
