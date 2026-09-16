// A deploy waits for an extension check to finish. Run by CI before the
// migrations and the deploy itself.
//
// A deploy rebuilds and rolls the container image, and an extension run in
// flight dies with it — "Runtime signalled the container to exit due to a new
// version rollout" (CHE-272, runs #195 and #202). A website run only
// re-executes its current step; an extension run loses its executor, cannot
// confirm that a paid session stopped charging, and publishes nothing. When a
// session had started, it also leaves a paid meter with nobody holding its Stop.
//
// The convention we had — announce the merge, check D1 first — needs three
// sessions to remember it and fails when the person merging is asleep or new.
// This is the same rule with nobody to remember it. It also outlives the
// convention: a scheduled extension check appears on no announcement at all.
//
// Skipped, not failed, when there are no credentials: the deploy job is already
// a no-op then, and a gate that fails a pipeline it cannot inform is worse than
// no gate.

import { readFileSync } from "node:fs";
import { LIVE_RUN_STATUSES } from "../src/lib/enums";

const WAIT_MS = Number(process.env.DEPLOY_GATE_WAIT_MS ?? 25 * 60 * 1000);
const POLL_MS = Number(process.env.DEPLOY_GATE_POLL_MS ?? 30_000);

interface LiveRun { runNumber: number; status: string; appSlug: string }

function databaseId(): string {
  const config = readFileSync(new URL("../wrangler-agent.jsonc", import.meta.url), "utf8");
  const id = /"database_id"\s*:\s*"([0-9a-f-]+)"/.exec(config)?.[1];
  if (!id) throw new Error("wrangler-agent.jsonc has no database_id — the gate cannot find the database to ask");
  return id;
}

async function liveExtensionRuns(account: string, token: string, database: string): Promise<LiveRun[]> {
  const statuses = LIVE_RUN_STATUSES.map(status => `'${status}'`).join(", ");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: `SELECT runNumber, status, appSlug FROM Run WHERE targetKind = 'extension' AND status IN (${statuses})` }),
  });
  if (!response.ok) throw new Error(`D1 refused the question (HTTP ${response.status}); the gate cannot tell whether a run is in flight`);
  const body = await response.json() as { success: boolean; result?: { results: LiveRun[] }[]; errors?: unknown };
  if (!body.success) throw new Error(`D1 refused the question: ${JSON.stringify(body.errors)}`);
  return body.result?.[0]?.results ?? [];
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    console.log("deploy-gate: no Cloudflare credentials — nothing to deploy into, so nothing to wait for.");
    return;
  }
  const database = databaseId();
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const running = await liveExtensionRuns(account, token, database);
    if (!running.length) {
      console.log("deploy-gate: no extension check in flight — deploying.");
      return;
    }
    const names = running.map(run => `#${run.runNumber} ${run.appSlug} (${run.status})`).join(", ");
    if (Date.now() >= deadline) {
      console.error(`deploy-gate: still in flight after ${Math.round(WAIT_MS / 60_000)} minutes: ${names}.`);
      console.error("Deploying now would kill it and leave a paid session with nobody to stop it. Re-run this job when the check is done, or cancel the run deliberately.");
      process.exitCode = 1;
      return;
    }
    console.log(`deploy-gate: waiting for ${names}…`);
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  // An unanswerable question is not permission to proceed: the whole point is
  // that nobody is watching.
  console.error(`deploy-gate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
