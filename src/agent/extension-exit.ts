// How the extension executor died, kept next to the attempt that lost it.
// Container failures all surface as the same library message ("the container
// is not running", "the container just exited"); the exit code is the only
// thing that separates a crash from a kill from a clean stop.
export interface ExecutorExit {
  exitCode: number;
  reason: string;
  at: number;
}

// 137 is SIGKILL — on a container that is what the platform does when the
// instance runs out of memory. 139 is SIGSEGV. Both are ours, never the
// extension's, and the message has to say so to whoever reads the run.
const SIGNALS: Record<number, string> = {
  137: "killed (SIGKILL — out of memory or evicted)",
  139: "crashed (SIGSEGV)",
  143: "terminated (SIGTERM)",
};

// `runtime` is what the platform's own monitor said. It outranks the stop
// event, which reports a synthesized code 0 whenever the library never learned
// a real one — a clean stop and a death mid-boot read identically there.
export function describeExecutorExit(error: unknown, exit?: ExecutorExit | null, runtime?: string | null): string {
  const base = error instanceof Error ? error.message : String(error);
  if (runtime?.trim()) return `${base} — the executor ended: ${runtime.trim()}`;
  if (!exit || !Number.isFinite(exit.exitCode)) return base;
  const detail = SIGNALS[exit.exitCode] ?? (exit.exitCode === 0 ? "stopped cleanly" : `exited with code ${exit.exitCode}`);
  return `${base} — the executor ${detail} (${exit.reason})`;
}
