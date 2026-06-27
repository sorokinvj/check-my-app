import type { Tracker, TicketDraft, CreatedIssue } from "./types";

// Linear adapter over the GraphQL API (CHE-31). Multi-tenant SaaS auth = OAuth2
// access token (Bearer). The token comes from the owner's TrackerIntegration
// (decrypted at the call site) and is scoped to their workspace.
//
// NOTE: not yet exercised against the live API — wiring is blocked on the Linear
// OAuth app credentials. The GraphQL shapes follow Linear's documented schema;
// verify `team.states` vs `team.workflowStates` against the live API on first run.

const ENDPOINT = "https://api.linear.app/graphql";

export class LinearTracker implements Tracker {
  constructor(
    private readonly accessToken: string,
    private readonly teamId: string,
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as {
      data?: T;
      errors?: { message: string }[];
    };
    if (json.errors?.length) {
      throw new Error(`Linear API: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    if (!json.data) throw new Error("Linear API: empty response");
    return json.data;
  }

  // Resolve label names → ids for this team, creating any that don't exist
  // (Contract v1: CheckMyApp creates its provenance label once).
  private async resolveLabelIds(names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const data = await this.gql<{ team: { labels: { nodes: { id: string; name: string }[] } } }>(
      `query($id:String!){ team(id:$id){ labels{ nodes{ id name } } } }`,
      { id: this.teamId },
    );
    const byName = new Map(data.team.labels.nodes.map((l) => [l.name.toLowerCase(), l.id]));
    const ids: string[] = [];
    for (const name of names) {
      const existing = byName.get(name.toLowerCase());
      if (existing) {
        ids.push(existing);
        continue;
      }
      const created = await this.gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
        `mutation($input:IssueLabelCreateInput!){ issueLabelCreate(input:$input){ issueLabel{ id } } }`,
        { input: { name, teamId: this.teamId } },
      );
      ids.push(created.issueLabelCreate.issueLabel.id);
    }
    return ids;
  }

  private async resolveStateId(name: string): Promise<string | undefined> {
    // Linear's Team field is `workflowStates`, not `states`.
    const data = await this.gql<{
      team: { workflowStates: { nodes: { id: string; name: string }[] } };
    }>(
      `query($id:String!){ team(id:$id){ workflowStates{ nodes{ id name } } } }`,
      { id: this.teamId },
    );
    return data.team.workflowStates.nodes.find(
      (s) => s.name.toLowerCase() === name.toLowerCase(),
    )?.id;
  }

  async createIssue(draft: TicketDraft): Promise<CreatedIssue> {
    const [labelIds, stateId] = await Promise.all([
      this.resolveLabelIds(draft.labelNames),
      this.resolveStateId(draft.stateName),
    ]);
    const data = await this.gql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } };
    }>(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier url } } }`,
      {
        input: {
          teamId: this.teamId,
          title: draft.title,
          description: draft.description,
          priority: draft.priority,
          stateId,
          labelIds,
        },
      },
    );
    if (!data.issueCreate.success) throw new Error("Linear issueCreate returned success=false");
    return data.issueCreate.issue;
  }

  async addComment(issueId: string, body: string): Promise<void> {
    const data = await this.gql<{ commentCreate: { success: boolean } }>(
      `mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }`,
      { input: { issueId, body } },
    );
    if (!data.commentCreate.success) throw new Error("Linear commentCreate returned success=false");
  }
}
