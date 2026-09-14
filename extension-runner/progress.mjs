// Waiting for a page that is slow versus a page that is stuck.
//
// Every fixed timeout in this executor was chosen on a quiet machine, and on
// 2026-09-14 two of them failed on a loaded one and read as defects of the
// product under test: the Stop confirmation (renderer too busy to answer a
// click) and the account sign-in (20s budget, 7s observed idle, spent in the
// combined scenario). Measured the same sign-in three ways that day: 0.8s on
// the operator's machine, 2.1s in an idle container, 7.0s in a loaded one.
// No constant survives a 3.4x spread honestly — raise it and a stuck page
// costs minutes, lower it and a busy one is called broken.
//
// So stop asking how long it has been. Ask whether anything is still
// happening: a page that is still fetching or still mutating its DOM has not
// failed yet, however slow it is, and a page doing neither will not start
// because we waited longer. The ceiling stays only as a backstop against a
// page that keeps itself busy forever.
//
// This does NOT replace a budget that models the product's own behaviour —
// the extension's confirmation window is the product's clock, not ours, and
// waiting past it tests nothing. Those stay wall-clock by design.

const DEFAULT_IDLE_MS = 8_000;
const DEFAULT_CEILING_MS = 180_000;

// Resolves when `condition()` is true. Rejects when the page has been idle —
// no request finished, no DOM mutation — for `idleMs` while it is still false,
// or when `ceilingMs` passes regardless. The error says which, because "it was
// still working and we gave up" and "it stopped doing anything" are different
// findings and only one of them is about the page.
export async function waitForProgress(page, condition, options = {}) {
  const { idleMs = DEFAULT_IDLE_MS, ceilingMs = DEFAULT_CEILING_MS, what = 'the expected state', pollMs = 250 } = options;
  const startedAt = Date.now();
  let lastActivity = startedAt;
  let requests = 0;
  let mutations = 0;

  // Progress is read from whatever signals the page can actually give. A real
  // Playwright Page gives both network events and a DOM observer; a narrower
  // object (a test's page double, a surface that only exposes evaluate) gives
  // fewer, and the wait degrades to those rather than failing on the shape of
  // its argument.
  const onActivity = () => { lastActivity = Date.now(); requests += 1; };
  const NETWORK_EVENTS = ['requestfinished', 'requestfailed', 'response', 'framenavigated'];
  const listening = typeof page.on === 'function' && typeof page.off === 'function';
  if (listening) for (const event of NETWORK_EVENTS) page.on(event, onActivity);

  // A DOM observer covers the case the network cannot: hydration, rendering
  // and client-side routing that finish long after the last response.
  const observing = typeof page.evaluate !== 'function' ? false : await page.evaluate(() => {
    const state = { count: 0, at: Date.now() };
    window.__cmaProgress = state;
    new MutationObserver(records => { state.count += records.length; state.at = Date.now(); })
      .observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    return true;
  }).catch(() => false);

  try {
    for (;;) {
      if (await condition()) return { ms: Date.now() - startedAt, requests, mutations };

      if (observing) {
        const dom = await page.evaluate(() => window.__cmaProgress && { count: window.__cmaProgress.count, at: window.__cmaProgress.at }).catch(() => null);
        if (dom && dom.count > mutations) { mutations = dom.count; lastActivity = Date.now(); }
      }

      const elapsed = Date.now() - startedAt;
      const idle = Date.now() - lastActivity;
      if (idle >= idleMs) {
        throw new Error(`Waited for ${what}: the page went quiet ${Math.round(idle / 1000)}s ago and it never appeared `
          + `(${Math.round(elapsed / 1000)}s total, ${requests} responses, ${mutations} DOM changes)`);
      }
      if (elapsed >= ceilingMs) {
        throw new Error(`Waited for ${what}: still busy after ${Math.round(elapsed / 1000)}s without it appearing `
          + `(${requests} responses, ${mutations} DOM changes) — treated as stuck at the ceiling`);
      }
      if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(pollMs);
      else await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  } finally {
    if (listening) for (const event of NETWORK_EVENTS) page.off(event, onActivity);
    if (observing) await page.evaluate(() => { delete window.__cmaProgress; }).catch(() => {});
  }
}
