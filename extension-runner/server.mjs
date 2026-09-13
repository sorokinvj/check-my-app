import http from 'node:http';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import WebSocket, { WebSocketServer } from 'ws';
import { installFromStore } from './store.mjs';
import { Cdp } from './cdp.mjs';
import { pageForTarget } from './targets.mjs';
import { SessionLedger, stopWithConfirmation } from './lifecycle.mjs';
import { NativeSurface } from './surface.mjs';
import { SessionObservation, readExtensionPanel } from './observation.mjs';
import { childIsRunning, ownedProtocolAction, disconnectInspectionClients } from './health.mjs';
import { stimulusFor, microphoneMatchesStimulus } from './stimulus.mjs';
import { signInAccountOnce, readAccountBalance, readAccountSnapshot } from './joblander-account.mjs';
import { BillingObservation } from './billing.mjs';
import { assessExtensionOutput } from './result.mjs';
import { sessionView } from './session-view.mjs';
import { preparePractice, inspectPractice, startPractice, stopPractice, readPractice, practiceControls, enablePracticeMicrophone, observePracticeRequests, PracticeStartRejected, preparePracticeStart, restorePracticeInsights } from './joblander-practice.mjs';

const exec = promisify(execFile);
const token = process.env.RUNNER_CONTROL_TOKEN;
delete process.env.RUNNER_CONTROL_TOKEN;
if (process.env.RUNNER_ISOLATED !== '1' || !token || token.length < 32) throw new Error('An isolated container and control token are required');
const root = '/tmp/extension-run';
await mkdir(root, { recursive: true });
await mkdir(process.env.HOME, { recursive: true });
let session = null, ledger = null, initializing = false, closed = false, closing = null, chrome = null, cdp = null, upstream = null;
let observation = null, observationBrowser = null;
let billing = null, billingFinal = null;
let practiceObservation = null;
let detachPracticeRequests = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
const native = new NativeSurface(input => new Promise((resolve, reject) => {
  const child = execFile('python3', ['native.py', 'surface'], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) { reject(new Error('Native surface unavailable or changed')); return; }
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Native surface returned an invalid result')); }
  });
  child.stdin.end(JSON.stringify(input));
}));

function authorized(req) {
  const value = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

function publicUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || url.hostname.endsWith('.local')) throw new Error('A public HTTPS companion URL is required');
  return url.href;
}

async function closeBrowser(reason) {
  if (closing) return closing;
  closing = dispose(reason);
  return closing;
}

async function dispose(reason) {
  if (closed) return;
  await closePopup().catch(() => {});
  if (ledger) {
    await ledger.endAll();
    await finalizeBilling();
    if (session) {
      session.startRejections = ledger.snapshot().filter(s => s.state === 'not-started');
      session.sessions = ledger.snapshot().filter(s => s.state !== 'not-started');
      session.applicationCleanup = !session.sessions.length ? 'not-started' : ledger.clean ? 'ui-stop-observed' : 'unverified';
      session.billingCleanup = session.sessions.length ? session.billing?.assessment.cleanupConfirmed ? 'confirmed' : 'unverified' : 'not-started';
      if (session.sessions.length) session.productResult = assessExtensionOutput(session);
    }
  }
  closed = true;
  if (session) { session.closedAt = new Date().toISOString(); session.closeReason = reason; }
  try { await cdp?.send('Browser.close'); } catch { /* The process may already have exited. */ }
  if (childIsRunning(chrome)) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(4000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
  }
  cdp?.close();
  // Closing a browser proves only browser disposal. Application Stop must be
  // witnessed and recorded by the agent before requesting disposal.
}

async function start(input) {
  if (session || initializing || closed) throw new Error('This container already belongs to a run');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.ownerRunId)) throw new Error('Run identity required');
  const targetUrl = input.targetUrl === 'fixture:interview' ? 'http://127.0.0.1:9091/' : publicUrl(input.targetUrl);
  const stimulus = stimulusFor(input.stimulusMode);
  initializing = true;
  ledger = new SessionLedger(input.ownerRunId, Date.now, entries => {
    if (entries.length && entries.every(e => ['stopped', 'unverified', 'not-started'].includes(e.state))) void finalizeBilling().catch(() => {});
  });
  const deadlineMs = Math.min(1200, Math.max(60, Number(input.maxDurationSeconds) || 600)) * 1000;
  const expiresAt = Date.now() + deadlineMs;
  setTimeout(() => void closeBrowser('deadline'), deadlineMs).unref();
  try {
    const identity = await installFromStore(input.extensionId, `${root}/extension`);
    if (closed) throw new Error('Session expired during installation');
    session = { sessionId: randomUUID(), ownerRunId: input.ownerRunId, ...identity, installedVersion: null,
      startedAt: new Date().toISOString(), expiresAt: new Date(expiresAt).toISOString(), targetUrl, scenario: input.scenario ?? 'interview',
      profileId: input.ownerRunId, stimulus, targetTabId: null, popupTargetId: null, allowSessions: input.allowSessions === true, maxSessionSeconds: Math.min(600, Math.max(60, Number(input.maxSessionSeconds) || 180)), closedAt: null, applicationCleanup: 'unverified' };
    spawn('openbox', [], { stdio: 'ignore' });
    chrome = spawn(chromium.executablePath(), [
      '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1',
      '--force-renderer-accessibility=complete', '--enable-automation', '--password-store=basic',
      '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=/opt/runner/${stimulus.microphone.file}`,
      '--window-size=1366,1000', '--window-position=0,0',
      `--user-data-dir=${root}/profile`, `--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    chrome.once('exit', (code, signal) => {
      if (!closed && !closing && session) {
        session.runtimeFailure = { kind: 'browser-exited', code, signal, at: new Date().toISOString() };
        void closeBrowser('browser-exited').catch(() => {});
      }
    });
    for (let i = 0; i < 120; i++) {
      try { const res = await fetch('http://127.0.0.1:9222/json/version'); upstream = (await res.json()).webSocketDebuggerUrl; break; } catch { await delay(100); }
    }
    if (!upstream) throw new Error('Chromium failed to become ready');
    cdp = await Cdp.connect(upstream);
    const info = await cdp.send('Browser.getVersion'); session.browserVersion = info.product;
    let sw;
    for (let i = 0; i < 100; i++) {
      const targets = (await cdp.send('Target.getTargets')).targetInfos;
      sw = targets.find(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${input.extensionId}/`));
      if (sw) break;
      await delay(100);
    }
    if (!sw) throw new Error('Installed extension identity was not observed');
    const swSession = await cdp.attach(sw.targetId);
    await cdp.send('Runtime.enable', {}, swSession);
    let observed;
    for (let i = 0; i < 100; i++) {
      observed = await cdp.evaluate(swSession, 'globalThis.chrome?.runtime?.id ? ({id:chrome.runtime.id,version:chrome.runtime.getManifest().version}) : null');
      if (observed) break;
      await delay(100);
    }
    if (!observed) throw new Error('Extension runtime did not initialize: ' + JSON.stringify(await cdp.evaluate(swSession, '({url:globalThis.location?.href,chromeKeys:Object.keys(globalThis.chrome ?? {})})')));
    if (observed.id !== input.extensionId || observed.version !== identity.packageVersion) throw new Error('Installed version differs from Store package');
    session.installedVersion = observed.version;
    session.serviceWorkerTargetId = sw.targetId;
    const { targetId } = await cdp.send('Target.createTarget', { url: targetUrl });
    session.targetTabId = targetId;
    await cdp.send('Target.activateTarget', { targetId });
    return session;
  } catch (error) { await closeBrowser('preflight-failed'); throw error; }
  finally { initializing = false; }
}

async function openPopup(input) {
  if (!session || closed) throw new Error('Session unavailable');
  if (ledger?.snapshot().some(entry => entry.state !== 'stopped')) throw new Error('Stop the owned session before reopening its popup');
  if (ledger?.snapshot().length && !session.billing?.assessment) throw new Error('Wait for session minute accounting before reopening the popup');
  // A successful Browser.close can leave an inspection transport alive. Only
  // this attempt's clients connect here; end them before a native invocation
  // can create a popup target that an old inspector would auto-attach to.
  await disconnectInspectionClients(wss.clients);
  if (wss.clients.size) throw new Error('Owned page inspection is still connected');
  const targetId = input.targetId ?? session.targetTabId;
  const targets = (await cdp.send('Target.getTargets')).targetInfos;
  const popupUrl = `chrome-extension://${session.extensionId}/${session.popupPath}`;
  if (targets.some(t => t.url === popupUrl)) throw new Error('An extension popup is already open; close it before another invocation');
  const target = targets.find(t => t.targetId === targetId && t.type === 'page');
  if (!target || new URL(target.url).origin !== new URL(session.targetUrl).origin) throw new Error('Target tab does not belong to this extension scenario');
  await cdp.send('Target.activateTarget', { targetId });
  session.targetTabId = targetId;
  const window = await cdp.send('Browser.getWindowForTarget', { targetId });
  const before = { targetId, windowId: window.windowId, url: target.url, at: new Date().toISOString() };
  native.invalidate();
  await exec('python3', ['native.py', 'popup', session.name], { timeout: 12_000 });
  for (let i = 0; i < 50; i++) {
    const fresh = (await cdp.send('Target.getTargets')).targetInfos;
    const candidates = fresh.filter(t => t.url === popupUrl);
    if (candidates.length > 1) throw new Error('Native popup target is ambiguous');
    const popup = candidates[0];
    if (popup) {
      session.popupTargetId = popup.targetId;
      session.targetWindowId = window.windowId;
      session.popupInvocation = { ...before, popupTargetId: popup.targetId, via: 'native-action' };
      return { before, popup: { targetId: popup.targetId, type: popup.type, url: popup.url }, via: 'native-action', at: new Date().toISOString() };
    }
    await delay(100);
  }
  throw new Error('Native popup did not appear');
}

async function currentPopup() {
  if (!session || closed || !session.popupTargetId) throw new Error('Open the native popup first');
  const url = `chrome-extension://${session.extensionId}/${session.popupPath}`;
  const targets = (await cdp.send('Target.getTargets')).targetInfos.filter(t => t.url === url);
  if (targets.length !== 1 || targets[0].targetId !== session.popupTargetId) throw new Error('Native popup target is missing or ambiguous');
  if (wss.clients.size) throw new Error('Page inspection is connected while the native popup is active');
  return { url, targetId: session.popupTargetId };
}

async function closePopup() {
  if (!session?.popupTargetId || !cdp || closed) return { closed: true };
  const targetId = session.popupTargetId;
  const targets = (await cdp.send('Target.getTargets')).targetInfos;
  if (targets.some(t => t.targetId === targetId)) {
    await currentPopup();
    await exec('xdotool', ['key', 'Escape'], { timeout: 3000 });
    for (let i = 0; i < 40; i++) {
      const fresh = (await cdp.send('Target.getTargets')).targetInfos;
      if (!fresh.some(t => t.targetId === targetId)) break;
      if (i === 39) throw new Error('Native popup did not close');
      await delay(50);
    }
  }
  session.popupTargetId = null;
  native.invalidate();
  await cdp.send('Target.activateTarget', { targetId: session.targetTabId });
  return { closed: true, targetId: session.targetTabId };
}

async function startExtensionSession() {
  if (!session || closed || closing || !session.allowSessions) throw new Error('Session-start permission is required');
  if (session.scenario === 'practice') throw new Error('The practice-only scenario does not authorize extension capture');
  if (!session.audioPreflight?.passed) throw new Error('Audio fixture preflight must pass before starting a session');
  if (!session.accountBaseline) throw new Error('A fresh account balance and history are required before a paid session');
  if (Date.now() + session.maxSessionSeconds * 1000 + 120_000 > Date.parse(session.expiresAt)) throw new Error('The browser lease has insufficient time for this session, Stop and the balance recheck');
  if (session.extensionId !== 'hafhjepjihcimcljkdphpinannbdmnhf') throw new Error('No verified Stop sequence for this extension');
  const targets = (await cdp.send('Target.getTargets')).targetInfos;
  const popup = targets.find(t => t.targetId === session.popupTargetId && t.url === `chrome-extension://${session.extensionId}/${session.popupPath}`);
  if (!popup) throw new Error('Open the native popup on the recorded tab first');
  const stop = async () => {
    await closePopup();
    await cdp.send('Target.activateTarget', { targetId: session.targetTabId });
    const targetBrowser = await chromium.connectOverCDP(upstream);
    try {
      const target = await pageForTarget(targetBrowser.contexts()[0], cdp, session.targetTabId);
      if (!target) throw new Error('Owned session tab unavailable');
      return await stopWithConfirmation({
        stop: target.getByRole('button', { name: 'End session', exact: true }),
        confirm: target.getByRole('button', { name: 'Confirm end session', exact: true }),
        stopped: target.getByRole('button', { name: /^(End session|Confirm end session)$/ }),
      });
    } finally {
      // Stop runs before waiting on observation so a slow sample cannot consume
      // the application's three-second confirmation window.
      if (observation) session.observation = await observation.finish();
      if (!billing) { await observationBrowser?.close().catch(() => {}); observationBrowser = null; }
      await targetBrowser.close().catch(() => {});
    }
  };
  ledger.register({ id: 'extension-capture', targetId: session.targetTabId, maxSeconds: session.maxSessionSeconds, stop });
  let browser;
  try {
    // No new Playwright/CDP connection while a native popup is active: Chrome
    // opens its inspector, changing lastFocusedWindow before tabCapture.
    const surface = await native.read(popup.url, popup.targetId);
    const startControl = surface.nodes.find(n => n.role === 'static' && n.name === 'Show JobLander Insights');
    if (!startControl) throw new Error('Native session-start control was not observed');
    // The general native action tool refuses session controls. This path has
    // already registered ownership, permission and the independent Stop timer.
    const snapshot = native.snapshot;
    const node = snapshot.refs.get(startControl.ref);
    native.invalidate();
    await native.invoke({ operation: 'click', url: popup.url, node });
    await delay(200);
    await closePopup();
    await cdp.send('Target.activateTarget', { targetId: session.targetTabId });
    browser = await chromium.connectOverCDP(upstream);
    const page = await pageForTarget(browser.contexts()[0], cdp, session.targetTabId);
    if (!page) throw new Error('Owned session tab unavailable');
    await page.getByRole('button', { name: 'End session', exact: true }).waitFor({ state: 'visible', timeout: 12_000 });
    ledger.started('extension-capture');
    observation = new SessionObservation({ ownerRunId: session.ownerRunId, targetId: session.targetTabId,
      baseline: session.audioPreflight.baselinePanel ?? '', read: async () => native.redact(await readExtensionPanel(page)) });
    observationBrowser = browser; browser = null;
    observation.start();
    const accountPage = await pageForTarget(observationBrowser.contexts()[0], cdp, session.accountTabId);
    if (!accountPage) throw new Error('The owned account tab is unavailable');
    billing = new BillingObservation({ baseline: session.accountBaseline,
      readBalance: () => readAccountBalance(accountPage), readSnapshot: () => readAccountSnapshot(accountPage) });
    billing.start();
    return { started: true, at: new Date().toISOString(), sessions: ledger.snapshot() };
  } catch (error) { await ledger.endAll(); throw error; }
  finally { await browser?.close(); }
}

async function finalizeBilling() {
  if (!billing) return null;
  billingFinal ??= billing.finish(ledger.snapshot().filter(s => s.state !== 'not-started')).then(result => {
    session.billing = result;
    session.billingCleanup = result.assessment.cleanupConfirmed ? 'confirmed' : 'unverified';
    return result;
  }).finally(async () => { detachPracticeRequests?.(); await observationBrowser?.close().catch(() => {}); observationBrowser = null; });
  return billingFinal;
}

async function practicePreflight() {
  if (!session || closed || closing || session.popupTargetId || ledger.snapshot().length || !session.accountBaseline) throw new Error('Practice preparation requires a fresh account and no active session');
  if (!['practice', 'practice-extension'].includes(session.scenario)) throw new Error('This scenario does not include practice');
  if (session.extensionId !== 'hafhjepjihcimcljkdphpinannbdmnhf' || new URL(session.targetUrl).origin !== 'https://joblander.app') throw new Error('Practice requires its own product tab');
  const browser = await chromium.connectOverCDP(upstream);
  try {
    const page = await pageForTarget(browser.contexts()[0], cdp, session.targetTabId);
    session.practicePreflight = await preparePractice(page);
    return session.practicePreflight;
  } finally { await browser.close(); await cdp.send('Target.activateTarget', { targetId: session.targetTabId }); }
}

async function startPracticeSession() {
  if (!session?.allowSessions || closed || closing || !session.practicePreflight || !session.audioPreflight?.passed || !session.accountBaseline || session.popupTargetId) throw new Error('Practice requires session permission, account, audio and page preparation');
  if (!['practice', 'practice-extension'].includes(session.scenario)) throw new Error('This scenario does not authorize practice');
  if (session.scenario === 'practice-extension' && !ledger.snapshot().some(s => s.id === 'extension-capture' && s.state === 'active')) throw new Error('Start the extension before its simultaneous practice');
  if (Date.now() + session.maxSessionSeconds * 1000 + 120_000 > Date.parse(session.expiresAt)) throw new Error('The practice lease has insufficient time for Stop and minute accounting');
  const stop = async () => {
    const browser = await chromium.connectOverCDP(upstream);
    try {
      const page = await pageForTarget(browser.contexts()[0], cdp, session.targetTabId);
      return await stopPractice(page);
    } finally {
      if (practiceObservation) session.practiceObservation = await practiceObservation.finish();
      await browser.close();
    }
  };
  observationBrowser ??= await chromium.connectOverCDP(upstream);
  const page = await pageForTarget(observationBrowser.contexts()[0], cdp, session.targetTabId);
  try {
    session.practiceRequests = [];
    detachPracticeRequests = observePracticeRequests(page, session.practiceRequests);
    await cdp.send('Target.activateTarget', { targetId: session.targetTabId });
    session.practiceLayout = await preparePracticeStart(page, session.scenario === 'practice-extension');
    ledger.register({ id: 'ai-practice', targetId: session.targetTabId, maxSeconds: session.maxSessionSeconds, stop });
    session.practiceStart = await startPractice(page);
    ledger.started('ai-practice');
    if (!billing) {
      const accountPage = await pageForTarget(observationBrowser.contexts()[0], cdp, session.accountTabId);
      billing = new BillingObservation({ baseline: session.accountBaseline,
        readBalance: () => readAccountBalance(accountPage), readSnapshot: () => readAccountSnapshot(accountPage) });
      billing.start();
    }
    practiceObservation = new SessionObservation({ ownerRunId: session.ownerRunId, targetId: session.targetTabId,
      baseline: session.practicePreflight.text, read: async () => native.redact(await readPractice(page)) });
    practiceObservation.start();
    session.practiceMicrophone = await enablePracticeMicrophone(page);
    if (session.scenario === 'practice-extension') session.practiceLayout = { ...session.practiceLayout, ...await restorePracticeInsights(page) };
    return { started: true, session: 'Practice', sessions: ledger.snapshot() };
  } catch (error) {
    session.practiceFailure = { message: error.message, controls: await practiceControls(page).catch(() => []), page: await readPractice(page).catch(() => null) };
    if (error instanceof PracticeStartRejected) ledger.rejected('ai-practice', 'The product explicitly refused Start because another practice is active');
    await ledger.endAll(); throw error;
  }
}

async function accountPreflight(input) {
  if (!session || closed || closing || ledger.snapshot().length || session.popupTargetId) throw new Error('Account preflight requires a fresh attempt with its popup closed');
  if (session.accountTabId && session.accountBaseline) return { balance: session.accountBaseline.balance, source: 'account-ui', historyObserved: true, practice: session.practiceDiscovery };
  if (session.accountCredentialsRejected) return { credentialRejected: true };
  if (session.accountSignInAttempted) throw new Error('The account sign-in attempt is already consumed');
  if (session.extensionId !== 'hafhjepjihcimcljkdphpinannbdmnhf') throw new Error('Account verification is unavailable for this extension');
  if (typeof input.email !== 'string' || typeof input.password !== 'string' || !input.email || !input.password) throw new Error('Test-account access is required');
  native.secrets.set(input.email, '{{TEST_EMAIL}}'); native.secrets.set(input.password, '{{TEST_PASSWORD}}');
  const browser = await chromium.connectOverCDP(upstream);
  try {
    const page = await browser.contexts()[0].newPage();
    const channel = await browser.contexts()[0].newCDPSession(page);
    session.accountTabId = (await channel.send('Target.getTargetInfo')).targetInfo.targetId;
    await channel.detach();
    const access = await signInAccountOnce(session, page, input.email, input.password);
    if (access.credentialRejected) return access;
    session.accountBaseline = await readAccountSnapshot(page);
    const practicePage = await browser.contexts()[0].newPage();
    try { session.practiceDiscovery = await inspectPractice(practicePage); }
    finally { await practicePage.close(); }
    return { balance: session.accountBaseline.balance, source: 'account-ui', historyObserved: true, practice: session.practiceDiscovery };
  } finally { await browser.close(); await cdp.send('Target.activateTarget', { targetId: session.targetTabId }); }
}

async function audioPreflight() {
  if (!session || closed || closing || ledger.snapshot().length) throw new Error('Audio preflight must precede any paid session');
  const browser = await chromium.connectOverCDP(upstream);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    const origins = ['http://127.0.0.1:9091'];
    if (session.allowSessions) origins.push(new URL(session.targetUrl).origin, `chrome-extension://${session.extensionId}`);
    for (const origin of new Set(origins)) await cdp.send('Browser.grantPermissions', { origin, permissions: ['audioCapture'] });
    session.microphonePermissions = { origins: [...new Set(origins)], via: 'owned-profile-permission', at: new Date().toISOString() };
    await page.goto('http://127.0.0.1:9091/');
    const rms = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audio = new AudioContext();
      try {
        await audio.resume();
        const analyser = audio.createAnalyser();
        audio.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const until = Date.now() + 4000;
        let peakRms = 0;
        while (Date.now() < until) {
          analyser.getFloatTimeDomainData(samples);
          peakRms = Math.max(peakRms, Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length));
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return peakRms;
      } finally { stream.getTracks().forEach(t => t.stop()); await audio.close(); }
    });
    const audio = await readFile(`/opt/runner/${session.stimulus.microphone.file}`);
    const result = { kind: 'controlled-audio', mode: session.stimulus.mode, language: 'en-US', ...session.stimulus.microphone,
      sha256: createHash('sha256').update(audio).digest('hex'), rms, passed: microphoneMatchesStimulus(session.stimulus, rms), at: new Date().toISOString() };
    const target = await pageForTarget(context, cdp, session.targetTabId);
    if (!target) throw new Error('Owned target tab unavailable for the audio preflight');
    result.baselinePanel = (await readExtensionPanel(target)).text;
    if (session.targetUrl === 'http://127.0.0.1:9091/') {
      if (session.stimulus.tab.audible) await target.getByRole('button', { name: 'Play interviewer', exact: true }).click();
      else await target.locator('audio').evaluate(audio => { audio.pause(); audio.currentTime = 0; });
      result.tabStimulus = { language: 'en-US', ...session.stimulus.tab,
        sha256: createHash('sha256').update(await readFile('/opt/runner/interviewer.wav')).digest('hex'), ...(await readExtensionPanel(target)).tabStimulus };
      if (result.tabStimulus.playing !== session.stimulus.tab.audible) throw new Error('Tab audio does not match the selected stimulus');
    }
    session.audioPreflight = result;
    if (!result.passed) throw new Error('Microphone does not match the selected stimulus');
    return result;
  } finally { await page.close(); await browser.close(); }
}

async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function screenshotRedactions() {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', ['native.py', 'redactions'], { timeout: 8000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error('Screenshot redaction unavailable')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Screenshot redaction returned invalid data')); }
    });
    child.stdin.end(JSON.stringify([...native.secrets.keys()]));
  });
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) { res.writeHead(401).end(); return; }
  try {
    const path = new URL(req.url, 'http://runner').pathname;
    if (session && !initializing && !childIsRunning(chrome) && path !== '/state' && !(req.method === 'DELETE' && path === '/session')) {
      res.writeHead(410, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'The owned browser is no longer running' })); return;
    }
    let result;
    if (req.method === 'POST' && path === '/session') result = await start(await body(req));
    else if (req.method === 'GET' && path === '/state') result = { session: session ? { ...session, observation: observation?.snapshot() ?? null, practiceObservation: practiceObservation?.snapshot() ?? null, sessions: ledger?.snapshot() ?? [] } : null, running: childIsRunning(chrome) && !closed };
    else if (req.method === 'POST' && path === '/fixture/preflight') result = await audioPreflight();
    else if (req.method === 'POST' && path === '/account/preflight') result = await accountPreflight(await body(req));
    else if (req.method === 'POST' && path === '/practice/preflight') result = await practicePreflight();
    else if (req.method === 'POST' && path === '/practice/start') result = await startPracticeSession();
    else if (req.method === 'POST' && path === '/session/start') result = await startExtensionSession();
    else if (req.method === 'POST' && path === '/session/observe') {
      if (!ledger?.snapshot().length) throw new Error('No session owned by this attempt has started');
      const view = () => sessionView({ session, sessions: ledger.snapshot(), observation: observation?.snapshot(), practiceObservation: practiceObservation?.snapshot(), billing: session.billing });
      for (let i = 0; i < 25 && !view().complete && !closed; i++) await delay(1000);
      result = view();
    }
    else if (req.method === 'POST' && path === '/session/stop') {
      await ledger?.endAll(); await finalizeBilling();
      result = sessionView({ session, sessions: ledger?.snapshot() ?? [], observation: observation?.snapshot(), practiceObservation: practiceObservation?.snapshot(), billing: session.billing });
    }
    else if (req.method === 'POST' && path === '/popup') result = await openPopup(await body(req));
    else if (req.method === 'GET' && path === '/popup/read') { const popup = await currentPopup(); result = await native.read(popup.url, popup.targetId); }
    else if (req.method === 'POST' && path === '/popup/action') {
      const input = await body(req), popup = await currentPopup();
      result = await native.act({ ...input, ...popup });
    }
    else if (req.method === 'POST' && path === '/popup/close') result = await closePopup();
    else if (req.method === 'GET' && path === '/native-tree') result = JSON.parse((await exec('python3', ['native.py', 'tree'], { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout);
    else if (req.method === 'GET' && path === '/desktop.png') {
      const before = await screenshotRedactions();
      await exec('import', ['-window', 'root', `${root}/desktop.png`]);
      const after = await screenshotRedactions();
      const masks = [...before, ...after].map(box => {
        if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) throw new Error('Screenshot redaction bounds are invalid');
        const [x1, y1, x2, y2] = box.map(Math.round);
        return `rectangle ${x1},${y1} ${x2},${y2}`;
      });
      if (masks.length) await exec('convert', [`${root}/desktop.png`, '-fill', '#111827', '-draw', masks.join(' '), `${root}/desktop.png`]);
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(await readFile(`${root}/desktop.png`)); return;
    } else if (req.method === 'DELETE' && path === '/session') { await closeBrowser('requested'); result = { disposed: true, session }; }
    else { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(native.redact(result)));
  } catch (error) { res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message })); }
});
server.on('upgrade', (req, socket, head) => {
  if (!authorized(req) || !session || closed || session.popupTargetId || new URL(req.url, 'http://runner').pathname !== `/v1/devtools/browser/${session.sessionId}`) { socket.destroy(); return; }
  const remote = new WebSocket(upstream, { maxPayload: 16 * 1024 * 1024 });
  remote.once('error', () => socket.destroy());
  remote.once('open', () => wss.handleUpgrade(req, socket, head, client => {
    client.on('message', (data, binary) => {
      const message = JSON.parse(data.toString());
      const action = ownedProtocolAction(message, session.targetTabId);
      // A connected client owns its transport, not the browser lease. Only the
      // runner's cleanup may dispose the profile after application Stop.
      if (action === 'disconnect') {
        session.clientDisposals = (session.clientDisposals ?? 0) + 1;
        client.send(JSON.stringify({ id: message.id, result: {} })); client.close(); return;
      }
      if (action === 'refuse') {
        client.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'Owned browser disposal requires session cleanup' } })); return;
      }
      if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary });
    });
    remote.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
    client.on('close', () => remote.close()); remote.on('close', () => client.close());
    client.on('error', () => remote.close()); remote.on('error', () => client.close());
  }));
});
process.on('SIGTERM', () => void closeBrowser('shutdown').finally(() => process.exit(0)));
server.listen(9090, '0.0.0.0');

// The stimulus page is reachable only inside this isolated browser container.
// It never serves an arbitrary path, credentials, the control API or user files.
http.createServer(async (req, res) => {
  if (req.url === '/interviewer.wav') {
    res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(await readFile('/opt/runner/interviewer.wav'));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic interview</title><h1>Synthetic interview</h1><p>Interviewer, English: Please describe a technical challenge in project Cedar and explain how you solved it.</p><audio controls loop src="/interviewer.wav"></audio><button onclick="document.querySelector('audio').play()">Play interviewer</button></html>`);
  } else res.writeHead(404).end();
}).listen(9091, '127.0.0.1');
