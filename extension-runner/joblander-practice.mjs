export async function practiceControls(page) {
  return page.locator('button').evaluateAll(buttons => buttons.map((button, index) => {
    const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
    return { index, text: button.innerText.trim(), label: button.getAttribute('aria-label') ?? '',
      ownDocument: button.getRootNode() === document,
      color: style.backgroundColor, width: rect.width, height: rect.height,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden',
      icon: button.querySelector('svg')?.outerHTML.slice(0, 3000) ?? '', disabled: button.disabled };
  }));
}

// The live practice probe observed an unnamed, transparent 24px button with
// a lucide-x icon. Its colored surround is outside the button. Matching the
// button's background missed Stop, so bind to the observed icon. Its hit area
// can resize with layout; visibility and uniqueness remain required.
export function practiceStopControl(controls) {
  const candidates = controls.filter(control => {
    return control.ownDocument && control.visible && !control.disabled && !control.text && !control.label && control.icon
      && /\blucide-x(?:\s|")/.test(control.icon)
      && control.width > 0 && control.height > 0;
  });
  if (candidates.length !== 1) throw new Error('The practice Stop control is unavailable or ambiguous');
  return candidates[0];
}

export async function preparePractice(page) {
  await page.goto('https://joblander.app/practice', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.getByRole('button', { name: 'Start call', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByRole('button', { name: 'Select Aria', exact: true }).click();
  // The call and footer language selectors are separate controls.
  const selectors = page.getByRole('combobox');
  if ((await selectors.nth(0).innerText()).trim() !== 'Aria' || (await selectors.nth(1).innerText()).trim() !== 'English') throw new Error('The selected Aria and English practice controls were not observed');
  const text = await page.locator('body').innerText();
  return { surface: 'practice-page', url: page.url(), coach: 'Aria', language: 'English', startAvailable: true, text: text.slice(0, 8000) };
}

export async function inspectPractice(page) {
  await page.goto('https://joblander.app/practice', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.getByRole('button', { name: 'Start call', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  return { surface: 'practice-page', startAvailable: true, controls: [{ role: 'button', name: 'Start call' }],
    selections: await page.getByRole('combobox').allTextContents() };
}

export async function startPractice(page) {
  await page.getByRole('button', { name: 'Start call', exact: true }).click();
  await page.waitForFunction(() => /A practice session is already running in another tab\./.test(document.body.innerText)
    || ![...document.querySelectorAll('button')].some(button => button.innerText.trim() === 'Start call' && button.getBoundingClientRect().width > 0), undefined, { timeout: 20_000 });
  if (/A practice session is already running in another tab\./.test(await page.locator('body').innerText())) throw new PracticeStartRejected('The account already has a practice session');
  await page.getByRole('button', { name: 'Start call', exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
  let control;
  for (let i = 0; i < 40; i++) {
    try { control = practiceStopControl(await practiceControls(page)); break; } catch { await page.waitForTimeout(500); }
  }
  if (!control) throw new Error('The practice call controls did not appear');
  return { control, at: Date.now() };
}

export async function positionPracticeInsights(page) {
  const panel = page.locator('#joblander-extension-host');
  const collapse = panel.getByRole('button', { name: 'Collapse insights', exact: true });
  if (await collapse.isVisible()) await collapse.click({ timeout: 10_000 });
  const header = panel.locator('header[role="status"]');
  if (!await header.isVisible()) return false;
  if (await header.count() !== 1) throw new Error('The interview assistance header is ambiguous');
  const bounds = await header.boundingBox();
  if (!bounds || bounds.width < 300 || bounds.height < 20) throw new Error('The interview assistance header is unavailable');
  // The observed draggable header keeps capture active when collapsed. Move
  // its empty grab area above practice's controls, using ordinary pointer
  // input; a CSS rewrite would hide the real obstruction from the check.
  await page.mouse.move(bounds.x + 230, bounds.y + bounds.height / 2);
  await page.mouse.down();
  try { await page.mouse.move(250, 65, { steps: 12 }); }
  finally { await page.mouse.up(); }
  return true;
}

export async function preparePracticeStart(page, combined) {
  if (combined && !await positionPracticeInsights(page)) throw new Error('The interview assistance header is unavailable');
  // Trial input cannot start a call. Ownership is registered only after the
  // intended Start is reachable, so an overlay cannot create a phantom meter.
  await page.getByRole('button', { name: 'Start call', exact: true }).click({ trial: true, timeout: 3000 });
  return { insightsCollapsed: combined, startReachable: true };
}

export async function restorePracticeInsights(page) {
  await page.locator('#joblander-extension-host').getByRole('button', { name: 'Expand insights', exact: true }).click({ timeout: 3000 });
  await page.locator('#joblander-extension-host').getByRole('button', { name: 'Collapse insights', exact: true }).waitFor({ state: 'visible', timeout: 3000 });
  return { insightsExpanded: true };
}

export class PracticeStartRejected extends Error {}

export async function stopPractice(page) {
  if (new URL(page.url()).origin !== 'https://joblander.app' || !/\/practice\/?$/.test(new URL(page.url()).pathname)) throw new Error('The owned practice page changed');
  // A failed extension Stop can leave its expanded panel over practice's Stop.
  // Move it through its actual controls before ending this independent meter.
  // A changed overlay must not prevent a reachable practice Stop; the trial
  // below still refuses a button that remains obstructed.
  const insightsPositioned = await positionPracticeInsights(page).catch(() => false);
  const control = practiceStopControl(await practiceControls(page));
  const button = await page.locator('button').nth(control.index).elementHandle();
  if (!button) throw new Error('The practice Stop control disappeared');
  const stillStop = () => button.evaluate(node => {
    const candidates = [...document.querySelectorAll('button')].filter(candidate => {
      const rect = candidate.getBoundingClientRect();
      return !candidate.disabled && !candidate.innerText.trim() && !candidate.getAttribute('aria-label')
        && Boolean(candidate.querySelector('svg.lucide-x')) && rect.width > 0 && rect.height > 0
        && getComputedStyle(candidate).visibility !== 'hidden';
    });
    return node.isConnected && node.getRootNode() === document && candidates.length === 1 && candidates[0] === node;
  });
  let stopClickedAt;
  try {
    if (!await stillStop()) throw new Error('The practice Stop control changed');
    await button.click({ trial: true, timeout: 10_000 });
    if (!await stillStop()) throw new Error('The practice Stop control changed');
    stopClickedAt = Date.now();
    await button.click({ timeout: 1500 });
  } finally { await button.dispose(); }
  // Practice first shows its completion/rating surface. Returning to practice
  // happens only after that positive completion signal, without rating it.
  if (!await page.getByRole('button', { name: 'Start call', exact: true }).isVisible()) {
    await page.getByText(/^session complete$/i).waitFor({ state: 'visible', timeout: 15_000 });
    await page.goto('https://joblander.app/practice', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  }
  await page.getByRole('button', { name: 'Start call', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  return { stopClickedAt, stoppedAt: Date.now(), applicationStopObserved: true, control, insightsPositioned };
}

export async function readPractice(page) {
  const text = (await page.locator('body').innerText()).slice(0, 16000);
  const transcript = page.getByRole('button', { name: 'View full transcript', exact: true });
  // The live transcript labels the candidate with the account display name.
  // Read its observed two-span rows, not arbitrary colon text elsewhere on
  // the page; normalize only the other participant in this two-person call.
  const rows = await transcript.isVisible() ? await transcript.evaluate(button => [...button.parentElement.querySelectorAll('div')].flatMap(row => {
    const spans = [...row.children];
    return spans.length === 2 && spans.every(node => node.tagName === 'SPAN') && /:\s*$/.test(spans[0].textContent)
      ? [{ speaker: spans[0].textContent.replace(/:\s*$/, '').trim(), text: spans[1].textContent.trim() }] : [];
  })) : [];
  const utterances = normalizePracticeUtterances(rows);
  return { surface: 'practice-page', text, utterances,
    alerts: await page.locator('body').evaluate(body => [...body.querySelectorAll('[role="alert"]')].filter(el => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    }).map(el => el.innerText?.trim() ?? '').filter(Boolean)),
    callActive: !await page.getByRole('button', { name: 'Start call', exact: true }).isVisible() };
}

export function normalizePracticeUtterances(rows) {
  const candidates = new Set(rows.filter(row => row.speaker !== 'Aria').map(row => row.speaker));
  if (candidates.size > 1 || [...candidates].some(name => !name || name.length > 80)) throw new Error('Practice participants are ambiguous');
  return rows.map(row => ({ speaker: row.speaker === 'Aria' ? 'Aria' : 'You', text: row.text.slice(0, 5000) }));
}

export async function enablePracticeMicrophone(page) {
  // Call controls appear before the coach joins. Wait for actual dialogue
  // before changing the microphone, rather than terminating a joining call.
  await page.getByRole('button', { name: 'View full transcript', exact: true }).waitFor({ state: 'visible', timeout: 35_000 });
  const liveMicrophone = page.locator('button[data-lk-source="microphone"]');
  const liveControls = await liveMicrophone.evaluateAll(nodes => nodes.flatMap((node, index) => node.getRootNode() === document && node.getBoundingClientRect().width > 0 ? [{ index }] : []));
  if (liveControls.length) {
    if (liveControls.length !== 1) throw new Error('The practice microphone control is ambiguous');
    const microphone = liveMicrophone.nth(liveControls[0].index);
    const state = () => microphone.evaluate(node => ({ enabled: node.getAttribute('data-lk-enabled'), pressed: node.getAttribute('aria-pressed') }));
    const before = await state();
    if (before.enabled !== before.pressed || !['true', 'false'].includes(before.enabled)) throw new Error('The practice microphone state is unavailable');
    if (before.enabled === 'false') await microphone.click({ timeout: 3000 });
    for (let i = 0; i < 30; i++) {
      const after = await state();
      if (after.enabled === 'true' && after.pressed === 'true') return { microphoneOn: true, source: 'microphone-control', before, after };
      await page.waitForTimeout(100);
    }
    throw new Error('The practice microphone did not turn on');
  }
  const inputs = page.getByRole('checkbox');
  const candidates = await inputs.evaluateAll(nodes => nodes.flatMap((node, index) => node.getRootNode() === document ? [{ index }] : []));
  if (candidates.length === 0) {
    // This production Linux UI exposes the microphone as an unnamed button,
    // unlike the macOS checkbox described in the PRD. Bind to its observed
    // muted microphone glyph, then require the glyph to change after clicking.
    const before = practiceMutedMicrophone(await practiceControls(page));
    await page.locator('button').nth(before.index).click({ timeout: 3000 });
    for (let i = 0; i < 30; i++) {
      const enabled = (await practiceControls(page)).filter(control => control.ownDocument && control.visible && !control.disabled && !control.text && !control.label && control.icon.includes('M2.975 8.002') && control.icon.includes('M5 3a3 3'));
      if (enabled.length === 1) return { microphoneOn: true, before: before.icon, after: enabled[0].icon };
      await page.waitForTimeout(100);
    }
    throw new Error('The practice microphone did not change to its on state');
  }
  if (candidates.length !== 1) throw new Error('The practice microphone control is ambiguous');
  const microphone = inputs.nth(candidates[0].index);
  const checked = () => microphone.evaluate(node => node.getAttribute('aria-checked') ?? (typeof node.checked === 'boolean' ? String(node.checked) : null));
  const before = await checked();
  if (before !== 'true' && before !== 'false') throw new Error('The practice microphone state is unavailable');
  if (before === 'false') await microphone.click({ timeout: 3000 });
  for (let i = 0; i < 30 && await checked() !== 'true'; i++) await page.waitForTimeout(100);
  if (await checked() !== 'true') throw new Error('The practice microphone did not turn on');
  return { microphoneOn: true };
}

export function practiceMutedMicrophone(controls) {
  const matches = controls.filter(control => control.ownDocument && control.visible && !control.disabled && !control.text && !control.label && control.icon?.includes('M12.227 11.52'));
  if (matches.length !== 1) throw new Error('The observed muted microphone control is unavailable or ambiguous');
  return matches[0];
}

export function observePracticeRequests(page, records) {
  const describe = request => {
    const url = new URL(request.url());
    if (url.hostname !== 'joblander.app' && !url.hostname.endsWith('.cloudfunctions.net')) return null;
    if (!['fetch', 'xhr'].includes(request.resourceType())) return null;
    return { at: Date.now(), url: url.origin + url.pathname, method: request.method() };
  };
  const append = value => { records.push(value); if (records.length > 150) records.splice(1, records.length - 150); };
  const response = value => { const request = describe(value.request()); if (request) append({ ...request, status: value.status() }); };
  const failed = value => { const request = describe(value); if (request) append({ ...request, error: 'Request did not complete' }); };
  page.on('response', response); page.on('requestfailed', failed);
  return () => { page.off('response', response); page.off('requestfailed', failed); };
}
