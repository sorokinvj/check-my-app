// The one-attempt rule for a rejected credential (CHE-100).
//
// On 2026-08-24 the password we held for a customer's QA account was stale. The
// agent submitted it five times in one run. Every consequence was ours: two
// tickets filed against a product that worked, an investigation by their team to
// disprove them, and a Firebase lockout that refused a real user with their own
// correct password twenty-seven seconds later.
//
// An auth endpoint answering 401 to a bad password is the product working. Rule
// §8: we do not settle "ours or theirs" by looking deeper into the customer — we
// remove our ability to get it wrong. So the first rejection ends the subject
// for the whole run.
//
// State lives on the Run row rather than in memory for one reason: a run is a
// Workflow of separate steps, discovery and each journey among them. Memory does
// not survive a replay and does not cross a step boundary; the rule has to do
// both, or "one attempt" quietly becomes one attempt per journey.

import type { AgentEnv } from "./env";

export async function credentialsAlreadyRejected(
  env: AgentEnv,
  runId: string | undefined,
): Promise<boolean> {
  if (!runId) return false;
  const row = await env.db.run.findUnique({
    where: { id: runId },
    select: { credentialsRejected: true },
  });
  return row?.credentialsRejected ?? false;
}

// Never throws: failing to record this must not fail a run. The in-memory flag
// the caller already set still holds for the rest of the current phase, so the
// worst case of a write failure is that the next phase tries once more — not
// that the walk resumes hammering the endpoint.
export async function recordCredentialRejection(
  env: AgentEnv,
  runId: string | undefined,
  signature: string,
): Promise<void> {
  console.warn(`[credentials] rejected for run ${runId ?? "(none)"}: ${signature}`);
  if (!runId) return;
  try {
    await env.db.run.update({ where: { id: runId }, data: { credentialsRejected: true } });
  } catch (err) {
    console.warn(
      `[credentials] could not record rejection: ${err instanceof Error ? err.message : err}`,
    );
  }
}
