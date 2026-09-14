import type { ExtensionSession } from "./extension-contract";
import type { RecordedAction } from "./tools";

export interface NativeReplayControl { role: string; name: string; editable: boolean; protected: boolean }
export type ExtensionReplayAction =
  | { kind: "open" | "close" | "audio" | "account" | "start" | "stop" | "practice-prepare" | "practice-start" }
  | { kind: "observe"; terminal: boolean }
  | { kind: "native-click"; control: NativeReplayControl }
  | { kind: "native-fill"; control: NativeReplayControl; value: string }
  | { kind: "native-expect"; names: string[] }
  | { kind: "page"; action: RecordedAction };

export function extensionReplaySpec(title: string, identity: ExtensionSession, actions: ExtensionReplayAction[], coreResult: boolean, accountingConfirmed = false): string {
  if (!actions.length) throw new Error("No observed extension actions to export");
  const plan = { title, identity: {
    extensionId: identity.extensionId, packageVersion: identity.packageVersion,
    installedVersion: identity.installedVersion, artifactSha256: identity.artifactSha256,
  }, targetUrl: identity.targetUrl === "http://127.0.0.1:9091/" ? "fixture:interview" : identity.targetUrl,
  scenario: identity.scenario ?? "interview", stimulusMode: identity.stimulus?.mode ?? "interview",
  maxSessionSeconds: identity.maxSessionSeconds ?? 180, coreResult, accountingConfirmed, actions };
  return `// Replays the observed native extension surfaces in a fresh isolated executor.
// Requires CMA_EXTENSION_RUNNER_URL and CMA_EXTENSION_RUNNER_TOKEN for the native
// executor, plus TEST_EMAIL / TEST_PASSWORD when the recorded journey signs in.
// Paid sessions additionally require CMA_ALLOW_SESSIONS=1. The executor owns Stop.
// Run with: npx playwright test <this-file> --workers=1
import { test, expect, chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const plan = ${JSON.stringify(plan, null, 2)};
${EXTENSION_REPLAY_RUNTIME}
`;
}

// Kept in the generated file: exporting a native test must not silently turn
// popup.html into a normal tab, nor depend on private CheckMyApp source imports.
const EXTENSION_REPLAY_RUNTIME = String.raw`
test(plan.title, async ({ request }) => {
  test.setTimeout(1_320_000);
  const base = process.env.CMA_EXTENSION_RUNNER_URL;
  const token = process.env.CMA_EXTENSION_RUNNER_TOKEN;
  if (!base || !token) throw new Error('A fresh native extension executor URL and token are required');
  const paid = plan.actions.some(a => a.kind === 'start' || a.kind === 'practice-start');
  if (paid && process.env.CMA_ALLOW_SESSIONS !== '1') throw new Error('Explicit paid-session permission is required');
  let opened = false, browser: Browser | undefined, session: any;
  const disconnect = async () => { await browser?.close(); browser = undefined; };
  const call = async (path: string, input?: unknown, method?: string) => {
    const response = await request.fetch(base + path, {
      method: method ?? (input === undefined ? 'GET' : 'POST'),
      headers: { Authorization: 'Bearer ' + token }, data: input, timeout: 125_000,
    });
    // Response bodies may contain account data; keep request failures out of logs.
    if (!response.ok()) throw new Error('Native executor ' + path + ': HTTP ' + response.status());
    return response.json();
  };
  const substitute = (value: string) => value.replace(/\{\{TEST_(EMAIL|PASSWORD)\}\}/g, (_, key) => {
    const secret = process.env['TEST_' + key];
    if (!secret) throw new Error('Required test-account access is missing');
    return secret;
  });
  const native = async (control: any) => {
    let found: any;
    await expect.poll(async () => {
      const { nodes } = await call('/popup/read');
      const matches = nodes.filter((n: any) => n.role === control.role && Boolean(n.editable) === control.editable && Boolean(n.protected) === control.protected && (!control.name || n.name === control.name));
      if (matches.length > 1) throw new Error('Observed native control is ambiguous');
      found = matches[0]; return Boolean(found);
    }, { timeout: 15_000 }).toBe(true);
    return found.ref;
  };
  const targetPage = async () => {
    browser ??= await chromium.connectOverCDP(base.replace(/^http/, 'ws') + '/v1/devtools/browser/' + session.sessionId, { headers: { Authorization: 'Bearer ' + token }, timeout: 30_000 });
    const context = browser.contexts()[0];
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    for (const page of context.pages()) {
      if (page.url().startsWith('chrome-extension:')) continue;
      const channel = await context.newCDPSession(page);
      try { if ((await channel.send('Target.getTargetInfo')).targetInfo.targetId === session.targetTabId) return page; }
      finally { await channel.detach(); }
    }
    throw new Error('The recorded target tab is unavailable');
  };
  try {
    // Mark the attempt before the request: a failed response can still leave a
    // live session, and its finally path must ask the executor to clean it up.
    opened = true;
    session = await call('/session', { ownerRunId: 'replay-' + randomUUID(), ...plan.identity,
      targetUrl: plan.targetUrl, scenario: plan.scenario, stimulusMode: plan.stimulusMode, maxDurationSeconds: 1200, maxSessionSeconds: plan.maxSessionSeconds, allowSessions: paid });
    for (const [key, value] of Object.entries(plan.identity)) expect(session[key], 'Installed extension identity changed').toBe(value);
    for (const step of plan.actions as any[]) {
      if (step.kind === 'open') { await disconnect(); await call('/popup', { targetId: session.targetTabId }); }
      else if (step.kind === 'close') await call('/popup/close', {});
      else if (step.kind === 'native-click' || step.kind === 'native-fill') {
        const ref = await native(step.control);
        await call('/popup/action', { ref, operation: step.kind === 'native-click' ? 'click' : 'fill',
          ...(step.kind === 'native-fill' ? { value: substitute(step.value), credential: /\{\{TEST_(EMAIL|PASSWORD)\}\}/.test(step.value) } : {}) });
      } else if (step.kind === 'native-expect') {
        await expect.poll(async () => {
          const { nodes } = await call('/popup/read');
          return step.names.every((name: string) => nodes.some((n: any) => n.name === name));
        }, { timeout: 15_000 }).toBe(true);
      } else if (step.kind === 'audio') expect((await call('/fixture/preflight', {})).passed).toBe(true);
      else if (step.kind === 'account') {
        const result = await call('/account/preflight', { email: substitute('{{TEST_EMAIL}}'), password: substitute('{{TEST_PASSWORD}}') });
        expect(result.historyObserved).toBe(true);
      } else if (step.kind === 'start') {
        await disconnect(); expect((await call('/session/start', {})).started).toBe(true);
      } else if (step.kind === 'practice-prepare') {
        expect((await call('/practice/preflight', {})).startAvailable).toBe(true);
      } else if (step.kind === 'practice-start') {
        expect((await call('/practice/start', {})).started).toBe(true);
      } else if (step.kind === 'observe') {
        let result;
        const deadline = Date.now() + (plan.maxSessionSeconds + 150) * 1000;
        do { result = await call('/session/observe', {}); } while (step.terminal && !result.complete && Date.now() < deadline);
        if (step.terminal) {
          expect(result.complete).toBe(true);
          if (plan.accountingConfirmed) expect(result.minuteAccounting).toBe('confirmed');
        }
      } else if (step.kind === 'stop') {
        await disconnect(); await call('/popup/close', {});
        let stop = await call('/session/stop', { minimumSeconds: 120 });
        const deadline = Date.now() + 150_000;
        while (stop.deferred && Date.now() < deadline) {
          await call('/session/observe', {});
          stop = await call('/session/stop', { minimumSeconds: 120 });
        }
        expect(stop.deferred).toBe(false);
      }
      else if (step.kind === 'page') {
        const page = await targetPage(), action = step.action;
        if (action.surface?.kind === 'native_popup') throw new Error('Native popup cannot be replayed as a page');
        if (action.kind === 'navigate') await page.goto(action.url, { waitUntil: 'domcontentloaded' });
        else if (action.kind === 'click') {
          const target = action.selector ? page.locator(action.selector) : page.getByRole(action.role, { name: action.name, exact: true });
          await target.click();
        } else if (action.kind === 'fill') {
          if (!action.selector && !action.label) throw new Error('The recorded field has no identity');
          // Placeholder-only sign-in fields are observable targets too. Keep
          // exact, strict matching so drift cannot send credentials elsewhere.
          const target = action.selector ? page.locator(action.selector)
            : page.getByLabel(action.label, { exact: true }).or(page.getByPlaceholder(action.label, { exact: true })).or(page.getByRole('textbox', { name: action.label, exact: true }));
          await target.fill(substitute(action.value));
        }
      }
    }
  } finally {
    try { await disconnect(); } finally { if (opened) {
      const final = await call('/session', undefined, 'DELETE');
      expect(final.disposed).toBe(true);
      expect(final.session.runtimeFailure).toBeUndefined();
      if (paid) {
        expect(final.session.sessions.length).toBeGreaterThan(0);
        expect(final.session.applicationCleanup).toBe('ui-stop-observed');
        expect(final.session.billingCleanup).toBe('confirmed');
        if (plan.coreResult) expect(final.session.productResult.confirmed).toBe(true);
      } else { expect(final.session.sessions).toHaveLength(0); expect(final.session.applicationCleanup).toBe('not-started'); }
    } }
  }
});
`;
