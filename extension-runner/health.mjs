export function childIsRunning(child) {
  // Node leaves exitCode null when a child dies from a signal.
  return Boolean(child?.pid && child.exitCode === null && child.signalCode === null && !child.killed);
}

export function ownedProtocolAction(message, targetId) {
  if (message.method === 'Browser.close') return 'disconnect';
  if (message.method === 'Browser.crash' || message.method === 'Target.disposeBrowserContext' ||
      (message.method === 'Target.closeTarget' && message.params?.targetId === targetId)) return 'refuse';
  return 'forward';
}

export async function disconnectInspectionClients(clients, graceMs = 250) {
  const peers = [...clients];
  const closed = peers.map(peer => peer.readyState === 3 ? Promise.resolve() : new Promise(resolve => peer.once('close', resolve)));
  for (const peer of peers) peer.close();
  let timer;
  await Promise.race([Promise.all(closed), new Promise(resolve => { timer = setTimeout(resolve, graceMs); })]);
  clearTimeout(timer);
  for (const peer of peers) if (peer.readyState !== 3) peer.terminate();
  let deadline;
  try {
    await Promise.race([Promise.all(closed), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Owned inspection clients did not disconnect')), 1000); })]);
  } finally { clearTimeout(deadline); }
}
