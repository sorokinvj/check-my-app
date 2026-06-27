// Idempotency + escalation decision for a recurring regression (CHE-32).
// Pure: given the existing IssueLink (if any) and the policy threshold, decide
// whether to file a fresh ticket, comment on the open one, or comment + escalate.

export type TicketAction =
  | { kind: "create" }
  | { kind: "comment"; escalate: boolean };

export interface ExistingIssue {
  status: string; // "open" | "resolved"
  occurrences: number;
  escalatedAt: Date | null;
}

export function decideTicketAction(
  existing: ExistingIssue | null,
  escalateAfterRuns: number,
): TicketAction {
  // No open link, or the last one was resolved and the bug came back → new ticket.
  if (!existing || existing.status === "resolved") return { kind: "create" };

  // Already filed and still open → comment, never refile. Escalate once, when the
  // recurrence count crosses the threshold (signal: automation isn't keeping up).
  const nextOccurrences = existing.occurrences + 1;
  const escalate = nextOccurrences >= escalateAfterRuns && existing.escalatedAt === null;
  return { kind: "comment", escalate };
}
