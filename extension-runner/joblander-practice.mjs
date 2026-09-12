export async function practiceControls(page) {
  return page.locator('button').evaluateAll(buttons => buttons.map((button, index) => {
    const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
    return { index, text: button.innerText.trim(), label: button.getAttribute('aria-label') ?? '',
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
    return control.visible && !control.disabled && !control.text && !control.label && control.icon
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
  await page.getByRole('button', { name: 'Start call', exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
  let control;
  for (let i = 0; i < 40; i++) {
    try { control = practiceStopControl(await practiceControls(page)); break; } catch { await page.waitForTimeout(500); }
  }
  if (!control) throw new Error('The practice call controls did not appear');
  return { control, at: Date.now() };
}

export async function stopPractice(page) {
  if (new URL(page.url()).origin !== 'https://joblander.app' || !/\/practice\/?$/.test(new URL(page.url()).pathname)) throw new Error('The owned practice page changed');
  const control = practiceStopControl(await practiceControls(page));
  const stopClickedAt = Date.now();
  await page.locator('button').nth(control.index).click({ timeout: 1500 });
  // Practice first shows its completion/rating surface. Returning to practice
  // happens only after that positive completion signal, without rating it.
  if (!await page.getByRole('button', { name: 'Start call', exact: true }).isVisible()) {
    await page.getByText(/^session complete$/i).waitFor({ state: 'visible', timeout: 15_000 });
    await page.goto('https://joblander.app/practice', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  }
  await page.getByRole('button', { name: 'Start call', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  return { stopClickedAt, stoppedAt: Date.now(), applicationStopObserved: true, control };
}

export async function readPractice(page) {
  const text = (await page.locator('body').innerText()).slice(0, 16000);
  const utterances = text.split('\n').flatMap(line => {
    const match = /^(Aria|You):\s*(.+)$/.exec(line.trim());
    return match ? [{ speaker: match[1], text: match[2] }] : [];
  });
  return { surface: 'practice-page', text, utterances,
    callActive: !await page.getByRole('button', { name: 'Start call', exact: true }).isVisible() };
}

export async function enablePracticeMicrophone(page) {
  const inputs = page.getByRole('checkbox');
  const candidates = await inputs.evaluateAll(nodes => nodes.flatMap((node, index) => node.getRootNode() === document ? [{ index }] : []));
  if (candidates.length !== 1) throw new Error('The practice microphone control is unavailable or ambiguous');
  const microphone = inputs.nth(candidates[0].index);
  const checked = () => microphone.evaluate(node => node.getAttribute('aria-checked') ?? (typeof node.checked === 'boolean' ? String(node.checked) : null));
  const before = await checked();
  if (before !== 'true' && before !== 'false') throw new Error('The practice microphone state is unavailable');
  if (before === 'false') await microphone.click({ timeout: 3000 });
  for (let i = 0; i < 30 && await checked() !== 'true'; i++) await page.waitForTimeout(100);
  if (await checked() !== 'true') throw new Error('The practice microphone did not turn on');
  return { microphoneOn: true };
}
