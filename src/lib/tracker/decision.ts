// Idempotency + escalation decision for a recurring regression (CHE-32).
// Pure: given the existing IssueLink (if any) and the policy threshold, decide
// whether to file a fresh ticket, comment on the open one, or comment + escalate.

export type TicketAction =
  | { kind: "create" }
  | { kind: "comment"; escalate: boolean }
  | { kind: "skip" };

export interface ExistingIssue {
  status: string; // "open" | "fixed" | "resolved" | "suppressed" — see IssueLink
  occurrences: number;
  escalatedAt: Date | null;
}

export function decideTicketAction(
  existing: ExistingIssue | null,
  escalateAfterRuns: number,
): TicketAction {
  // Suppressed = the ticket was Canceled upstream: ruled not-a-bug (CHE-61).
  // Auto-filing never touches this signature again. (The manual button treats
  // this as create — a human clicking through IS the override.)
  if (existing?.status === "suppressed") return { kind: "skip" };

  // No link yet, or the last one left "open" behind (resolved = fix verified,
  // fixed = tracker says Done) and the bug came back → new regression ticket.
  if (!existing || existing.status !== "open") return { kind: "create" };

  // Already filed and still open → comment, never refile. Escalate once, when the
  // recurrence count crosses the threshold (signal: automation isn't keeping up).
  const nextOccurrences = existing.occurrences + 1;
  const escalate = nextOccurrences >= escalateAfterRuns && existing.escalatedAt === null;
  return { kind: "comment", escalate };
}
