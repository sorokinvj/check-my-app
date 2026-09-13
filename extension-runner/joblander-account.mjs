const dashboard = 'https://joblander.app/dashboard';

export function parseMinuteBalance(text) {
  const matches = [...text.matchAll(/(?:^|\n)Minutes[ \t]*\n\s*(\d+)[ \t]*(?=\n|$)/g)];
  if (matches.length !== 1) throw new Error('The displayed minute balance is unavailable or ambiguous');
  const balance = Number(matches[0][1]);
  if (!Number.isSafeInteger(balance)) throw new Error('The displayed minute balance is invalid');
  return balance;
}

export async function signInAccount(page, email, password) {
  if (!email || !password) throw new Error('Test-account access is required for the minute balance');
  await page.goto('https://joblander.app/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.getByPlaceholder('Email address', { exact: true }).fill(email);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => /(?:^|\n)Minutes\s*(?:\n|$)/.test(document.body.innerText)
    || /invalid (?:login|credentials|password|email)|incorrect (?:email|password)|wrong password|too many (?:attempts|requests)|auth\/(?:invalid-credential|wrong-password|user-not-found)/i.test(document.body.innerText), undefined, { timeout: 20_000 });
  if (credentialRejection(await page.locator('body').innerText())) return { credentialRejected: true };
  await page.getByText('Minutes', { exact: true }).waitFor({ state: 'visible', timeout: 1000 });
  return { signedIn: true };
}

export function credentialRejection(text) {
  return /invalid (?:login|credentials|password|email)|incorrect (?:email|password)|wrong password|too many (?:attempts|requests)|auth\/(?:invalid-credential|wrong-password|user-not-found)/i.test(text);
}

export async function signInAccountOnce(state, page, email, password) {
  if (state.accountCredentialsRejected) return { credentialRejected: true };
  if (state.accountSignInAttempted) throw new Error('The account sign-in attempt is already consumed');
  state.accountSignInAttempted = true;
  const result = await signInAccount(page, email, password);
  if (result.credentialRejected) state.accountCredentialsRejected = true;
  return result;
}

export async function readAccountBalance(page, refresh = true) {
  if (refresh) await page.goto(dashboard, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.getByText('Minutes', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  // Read after hydration has settled, rather than accepting the first cached
  // number painted while the account is being restored.
  await page.waitForTimeout(2000);
  const balance = parseMinuteBalance(await page.locator('body').innerText());
  return { at: Date.now(), source: 'account-ui', url: dashboard, balance };
}

async function readHistory(page, kind) {
  await page.getByRole('tab', { name: kind === 'extension' ? 'Meetings' : 'My Stories', exact: true }).click();
  const prefix = kind === 'extension' ? '/meeting/' : '/practice/coaching_';
  await page.waitForFunction(prefix => [...document.querySelectorAll('a[href]')].some(a => a.href.includes(prefix)) ||
    /no (?:meetings|practice sessions|sessions)(?: yet| found)|haven.t (?:had|completed|started)/i.test(document.body.innerText), prefix, { timeout: 15_000 });
  const cards = await page.locator('a[href]').evaluateAll((anchors, prefix) => anchors
    .filter(a => a.href.includes(prefix)).map(a => ({ href: a.href, text: a.innerText })), prefix);
  if (!cards.length) {
    const text = await page.locator('body').innerText();
    if (!/no (?:meetings|practice sessions|sessions)(?: yet| found)|haven.t (?:had|completed|started)/i.test(text)) throw new Error('The session history has not finished loading');
  }
  return cards.map(card => {
    const date = card.text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)?.[0];
    const duration = card.text.trim().match(/(?:(\d+)m\s*)?(\d+)s$/);
    if (!date || !duration) throw new Error('A displayed session lacks its date or duration');
    return { id: card.href, kind, dateUtc: date, durationSeconds: Number(duration[1] ?? 0) * 60 + Number(duration[2]) };
  });
}

export async function readAccountSnapshot(page) {
  const balance = await readAccountBalance(page);
  const history = [...await readHistory(page, 'extension'), ...await readHistory(page, 'practice')];
  return { ...balance, history, historyReadAt: Date.now() };
}
