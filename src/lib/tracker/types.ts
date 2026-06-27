// Tracker abstraction (CHE-31). Linear is the only implementation now; Jira /
// GitHub Issues can implement the same interface later. The producer side
// (watch-diff → ticket) never imports a concrete tracker — only this interface.

export interface TicketDraft {
  title: string;
  description: string;
  // Human label names; the adapter resolves them to tracker ids (creating any
  // that don't exist — e.g. the provenance label, per Contract v1).
  labelNames: string[];
  // Workflow state name, e.g. "Backlog" — adapter resolves to a state id.
  stateName: string;
  // Linear priority scale: 1 = Urgent, 2 = High, 3 = Medium, 4 = Low.
  priority: number;
}

export interface CreatedIssue {
  id: string;
  identifier: string; // e.g. "JOB-123"
  url: string;
}

export interface Tracker {
  createIssue(draft: TicketDraft): Promise<CreatedIssue>;
  addComment(issueId: string, body: string): Promise<void>;
}
