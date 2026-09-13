export class ExtensionRuntimeError extends Error {
  constructor(message: string) { super(message); this.name = "ExtensionRuntimeError"; }
}

// A lost observation response held Run 5 until its 25-minute Workflow limit.
// Bound the entire response, including its body, even if a transport ignores
// AbortSignal. The caller's finally still owns application Stop and disposal.
export async function extensionOperation<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 120_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new ExtensionRuntimeError("The owned extension operation timed out")); controller.abort(); }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), expired]); }
  finally { clearTimeout(timer!); }
}
