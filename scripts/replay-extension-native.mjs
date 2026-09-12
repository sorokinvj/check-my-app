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
if (sessionSeconds && (process.env.CMA_ALLOW_SESSION !== '1' || !evidenceFile || !Number.isInteger(sessionSeconds) || sessionSeconds < 125 || sessionSeconds > 300)) throw new Error('A paid session requires CMA_ALLOW_SESSION=1, CMA_SESSION_SECONDS=125..300 and CMA_EVIDENCE_FILE');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(path, input, method) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (input === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Runner ${path}: HTTP ${response.status}`);
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
    extensionId: 'hafhjepjihcimcljkdphpinannbdmnhf', targetUrl: 'fixture:interview',
    maxDurationSeconds: 600, allowSessions: sessionSeconds > 0, maxSessionSeconds: sessionSeconds || 60,
    stimulusMode: process.env.CMA_STIMULUS_MODE ?? 'interview',
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
    const deadline = Date.now() + (sessionSeconds + 30) * 1000;
    while (Date.now() < deadline) {
      const state = await call('/state');
      await writeFile(evidenceFile, JSON.stringify(state), { mode: 0o600 });
      if (state.session.sessions.every(s => ['stopped', 'unverified'].includes(s.state))) break;
      await delay(5000);
    }
  }
} finally {
  const final = await call('/session', undefined, 'DELETE');
  if (evidenceFile) await writeFile(evidenceFile, JSON.stringify(final), { mode: 0o600 });
  console.log(JSON.stringify({ disposed: final.disposed, applicationCleanup: final.session?.applicationCleanup, billingCleanup: final.session?.billingCleanup,
    samples: final.session?.observation?.samples.length ?? 0 }));
}
