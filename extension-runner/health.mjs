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
