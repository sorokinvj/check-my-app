// Explicit-input live probe. Run on the executor host with a disposable profile
// and an authorized test account; passwords are read locally and never printed.
import { readFile, writeFile } from 'node:fs/promises';
const base = process.env.CMA_RUNNER_URL;
const tokenFile = process.env.CMA_RUNNER_TOKEN_FILE;
const email = process.env.CMA_TEST_EMAIL;
const passwordFile = process.env.CMA_TEST_PASSWORD_FILE;
if (!base || !tokenFile || !email || !passwordFile) throw new Error('CMA_RUNNER_URL, CMA_RUNNER_TOKEN_FILE, CMA_TEST_EMAIL and CMA_TEST_PASSWORD_FILE are required');
const rawToken = (await readFile(tokenFile, 'utf8')).trim();
const token = rawToken.startsWith('RUNNER_CONTROL_TOKEN=') ? rawToken.slice('RUNNER_CONTROL_TOKEN='.length) : rawToken;
const password = (await readFile(passwordFile, 'utf8')).trim();
const sessionSeconds = Number(process.env.CMA_SESSION_SECONDS ?? 0);
const evidenceFile = process.env.CMA_EVIDENCE_FILE;
const scenario = process.env.CMA_SCENARIO ?? 'interview';
if (!['interview', 'practice-extension'].includes(scenario)) throw new Error('CMA_SCENARIO must be interview or practice-extension');
const combined = scenario === 'practice-extension';
if (combined && !sessionSeconds) throw new Error('The combined scenario exists to exercise two paid meters; it needs CMA_SESSION_SECONDS');
if (sessionSeconds && (process.env.CMA_ALLOW_SESSION !== '1' || !evidenceFile || !Number.isInteger(sessionSeconds) || sessionSeconds < 125 || sessionSeconds > 300)) throw new Error('A paid session requires CMA_ALLOW_SESSION=1, CMA_SESSION_SECONDS=125..300 and CMA_EVIDENCE_FILE');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(path, input, method) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (input === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: AbortSignal.timeout(120_000),
  });
  // The body can carry account data, so only the executor's own `error` string
  // is surfaced — every one of those is a code-authored message. Without it a
  // failure here is just an HTTP code, which is what made the first combined
  // attempt on 2026-09-14 undiagnosable.
  if (!response.ok) {
    const reason = await response.json().then(payload => payload?.error).catch(() => undefined);
    throw new Error(`Runner ${path}: HTTP ${response.status}${reason ? ` — ${reason}` : ''}`);
  }
  return response.json();
}
async function control(predicate) {
  for (let i = 0; i < 30; i++) {
    const surface = await call('/popup/read');
    const matches = surface.nodes.filter(predicate);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error('Ambiguous native control');
    await delay(250);
  }
  throw new Error('Native control did not appear');
}
try {
  const session = await call('/session', {
    ownerRunId: process.env.CMA_OWNER_RUN_ID ?? `native-replay-${Date.now()}`,
    extensionId: 'hafhjepjihcimcljkdphpinannbdmnhf',
    // The combined scenario captures the real practice page; interview-only
    // captures the local fixture. extensionInput() picks the same pair.
    targetUrl: combined ? 'https://joblander.app/practice' : 'fixture:interview',
    scenario,
    maxDurationSeconds: 900, allowSessions: sessionSeconds > 0, maxSessionSeconds: sessionSeconds || 60,
    stimulusMode: process.env.CMA_STIMULUS_MODE ?? (combined ? 'practice' : 'interview'),
  });
  console.log(JSON.stringify({ installedVersion: session.installedVersion, sessionId: session.sessionId }));
  await call('/popup', {});
  const signIn = await control(n => n.role === 'push button' && n.name === 'Sign in with email');
  await call('/popup/action', { operation: 'click', ref: signIn.ref });
  const emailField = await control(n => n.editable && !n.protected);
  await call('/popup/action', { operation: 'fill', ref: emailField.ref, value: email, credential: true });
  const passwordField = await control(n => n.editable && n.protected);
  await call('/popup/action', { operation: 'fill', ref: passwordField.ref, value: password, credential: true });
  const submit = await control(n => n.role === 'push button' && /^(Sign in|Log in|Login)$/i.test(n.name));
  await call('/popup/action', { operation: 'click', ref: submit.ref });
  await control(n => n.role === 'static' && n.name === 'Show JobLander Insights');
  console.log(JSON.stringify({ nativeLoginObserved: true, captureStarted: false }));
  // A normal click must not activate capture, even when it targets the exact
  // visible label. Exercise the actual HTTP guard, then re-read its state.
  const insights = await control(n => n.role === 'static' && n.name === 'Show JobLander Insights');
  let refused = false;
  try { await call('/popup/action', { operation: 'click', ref: insights.ref }); } catch { refused = true; }
  if (!refused) throw new Error('Paid capture escaped the native action gate');
  const state = await call('/state');
  if (state.session.sessions.length) throw new Error('A session unexpectedly started');
  console.log(JSON.stringify({ guardedCapture: true, ownedSessions: 0 }));
  if (sessionSeconds) {
    await call('/popup/close', {});
    await call('/account/preflight', { email, password });
    await call('/fixture/preflight', {});
    await call('/popup', {});
    const started = await call('/session/start', {});
    console.log(JSON.stringify({ captureStarted: started.started, limitSeconds: sessionSeconds }));
    // CMA_SCENARIO=practice-extension adds the second paid meter, which is the
    // only configuration that has ever failed Stop: run 7's confirmation click
    // went unanswered with a live practice call, the capture, Xvfb and
    // Playwright sharing one vCPU. The interview-only path above never
    // reproduced it, so a probe that cannot start practice cannot test the fix.
    if (combined) {
      const preflight = await call('/practice/preflight', {});
      if (!preflight.startAvailable) throw new Error('Practice Start was not available for the combined scenario');
      const practice = await call('/practice/start', {});
      console.log(JSON.stringify({ practiceStarted: practice.started, meters: practice.sessions?.length ?? 0 }));
    }
    const deadline = Date.now() + (sessionSeconds + 30) * 1000;
    while (Date.now() < deadline) {
      const state = await call('/state');
      await writeFile(evidenceFile, JSON.stringify(state), { mode: 0o600 });
      if (state.session.sessions.every(s => ['stopped', 'unverified'].includes(s.state))) break;
      await delay(5000);
    }
    // The point of the combined run: say which meters proved their Stop and
    // which only expired, without having to read the evidence file by hand.
    const settled = await call('/state');
    console.log(JSON.stringify({ meters: settled.session.sessions.map(s => ({ id: s.id, state: s.state,
      stopObserved: s.cleanup?.applicationStopObserved ?? false, error: s.cleanup?.error ?? null })) }));
  }
} finally {
  const final = await call('/session', undefined, 'DELETE');
  if (evidenceFile) await writeFile(evidenceFile, JSON.stringify(final), { mode: 0o600 });
  console.log(JSON.stringify({ disposed: final.disposed, applicationCleanup: final.session?.applicationCleanup, billingCleanup: final.session?.billingCleanup,
    samples: final.session?.observation?.samples.length ?? 0 }));
}
