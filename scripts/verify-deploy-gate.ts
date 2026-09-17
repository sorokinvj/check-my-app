import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES, RUN_STATUSES, RUN_STATUS_KIND } from "../src/lib/enums";

// The gate exists because a deploy kills an extension run in flight (CHE-272),
// and it can only be trusted if it cannot go blind. Two ways it could: a new
// run status nobody classified, and a second copy of the status list somewhere
// that drifts from the first.
async function main() {
  // Exhaustive by construction — Record<RunStatus, …> will not compile with a
  // member missing — so this asserts the halves are disjoint and complete.
  assert.equal(LIVE_RUN_STATUSES.length + TERMINAL_RUN_STATUSES.length, RUN_STATUSES.length);
  assert.equal(LIVE_RUN_STATUSES.some(status => TERMINAL_RUN_STATUSES.includes(status)), false, "A status cannot be both");
  assert.ok(RUN_STATUSES.length >= 11, `Every run status must be classified; found ${RUN_STATUSES.length}`);
  for (const status of ["queued", "walking", "writing"] as const) assert.equal(RUN_STATUS_KIND[status], "live");
  // The one that was missing when this was three hand-kept lists.
  for (const status of ["completed", "partial", "failed", "canceled"] as const) assert.equal(RUN_STATUS_KIND[status], "terminal");

  const gate = readFileSync(new URL("./deploy-gate-extension.ts", import.meta.url), "utf8");
  assert.match(gate, /LIVE_RUN_STATUSES/, "The gate must read the classification, never spell its own list");
  assert.doesNotMatch(gate, /'(queued|walking|writing)'/, "A hardcoded status in the gate is a list that will drift");
  assert.match(gate, /targetKind = 'extension'/, "A website run re-executes a step; only an extension run dies, and only it is worth blocking a deploy for");
  assert.match(gate, /process\.exitCode = 1/, "An unanswerable question is not permission to deploy");

  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const gateAt = workflow.indexOf("deploy-gate-extension.ts");
  const migrationsAt = workflow.indexOf("d1 migrations apply");
  const deployAt = workflow.indexOf("wrangler deploy");
  assert.ok(gateAt > 0, "The deploy job must run the gate");
  assert.ok(gateAt < migrationsAt && gateAt < deployAt, "The gate runs before anything that touches production");
  assert.equal(workflow.slice(0, gateAt).includes("jobs:\n  check"), true, "The gate belongs to the deploy job, not the check job — a red check would block every merge");

  console.log("deploy gate: statuses classified once, the gate reads them, and it runs before production is touched");
}

main();
