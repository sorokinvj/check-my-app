export async function pageForTarget(context, cdp, targetId) {
  const { targetInfo } = await cdp.send('Target.getTargetInfo', { targetId });
  const candidates = context.pages().filter(page => page.url() === targetInfo.url);
  // Attaching another CDP session to a native popup opens DevTools and moves
  // the last-focused window. JobLander then observes "No active tab found".
  // A unique popup can be matched using the browser's existing target list;
  // an ambiguous popup is refused, never guessed by URL.
  if (targetInfo.url.startsWith('chrome-extension://')) {
    const twins = (await cdp.send('Target.getTargets')).targetInfos.filter(t => t.url === targetInfo.url);
    if (twins.length !== 1 || twins[0].targetId !== targetId || candidates.length !== 1) throw new Error('Native popup identity is ambiguous');
    return candidates[0];
  }
  for (const page of candidates) {
    const connection = await context.newCDPSession(page);
    try {
      const { targetInfo: candidate } = await connection.send('Target.getTargetInfo');
      if (candidate.targetId === targetId) return page;
    } finally { await connection.detach(); }
  }
  return null;
}
