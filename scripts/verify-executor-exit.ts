import assert from "node:assert/strict";
import { describeExecutorExit } from "../src/agent/extension-exit";
import { hasEnvironmentLeak } from "../src/lib/verdict-language";

// A run that lost its executor must say why. Without this, every container
// death reads "the container is not running" and the next reader has to guess
// between our memory limit, our crash and the extension itself.
async function main() {
  const lost = new Error("The container is not running, consider calling start()");

  assert.equal(describeExecutorExit(lost, null), lost.message, "With no exit recorded the message stays as it was");
  assert.equal(describeExecutorExit(lost, undefined), lost.message);
  assert.equal(describeExecutorExit("plain string failure", null), "plain string failure");

  const killed = describeExecutorExit(lost, { exitCode: 137, reason: "exit", at: Date.now() });
  assert.match(killed, /out of memory or evicted/, "SIGKILL must name the platform kill, not leave a bare code");
  assert.match(killed, /^The container is not running/, "The original failure stays first — the exit explains it, never replaces it");

  assert.match(describeExecutorExit(lost, { exitCode: 139, reason: "runtime_signal", at: 0 }), /SIGSEGV/);
  assert.match(describeExecutorExit(lost, { exitCode: 143, reason: "runtime_signal", at: 0 }), /SIGTERM/);
  assert.match(describeExecutorExit(lost, { exitCode: 0, reason: "exit", at: 0 }), /stopped cleanly/);
  assert.match(describeExecutorExit(lost, { exitCode: 1, reason: "exit", at: 0 }), /exited with code 1/,
    "An unmapped code is still reported, never swallowed");

  // These strings describe OUR machinery. They are diagnostics on the run row,
  // never customer-facing text — rule 1 — so the leak detector must agree that
  // they would be a leak if anyone ever put them in a verdict.
  assert.equal(hasEnvironmentLeak(killed), true, "Executor detail is internal by construction; a verdict carrying it is a leak");

  console.log("verify-executor-exit: ok");
}

main();
