// Run trigger. Starts the durable CheckRunWorkflow (defined in the agent worker,
// bound here cross-worker as CHECK_RUN) for a run. Replaces the old BullMQ
// enqueueRun — no Redis on Workers.

import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function triggerRun(runId: string): Promise<void> {
  const { env } = getCloudflareContext();
  const workflow = (env as unknown as { CHECK_RUN?: Workflow }).CHECK_RUN;
  if (!workflow) {
    console.warn(`[trigger] CHECK_RUN binding missing — run ${runId} left queued`);
    return;
  }
  await workflow.create({ params: { runId } });
}
