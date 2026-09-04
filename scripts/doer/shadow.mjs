// The shadow run (CHE-128): a second implementer on the same ticket.
//
// Comparing Journeyman with Codex across different tickets measures the
// tickets, not the implementers — the spread between two tickets is larger than
// the spread between two models. So one ticket gets both, and the second one
// publishes a DRAFT that never merges.
//
// Why a draft and not a race: two mergeable PRs on one ticket require picking a
// winner, and picking is a judgement the gate deliberately does not have
// (machine.mjs: "it holds no opinion"). A shadow keeps the loop's autonomy and
// still gives a controlled A/B against a known reference.
//
// Two rails already in this repository make that cheap, and both were checked
// against the code before this file was written rather than assumed:
//
//   - shepherd.mjs takes only PRs that are `doer/*` AND not drafts, so a draft
//     on `journeyman/*` is invisible to the merge gate twice over;
//   - tick.mjs counts only `doer/*` branches for the one-open-PR rail, so a
//     shadow PR does not block the queue.
//
// Both predicates now live in eligibility.mjs and are covered by verify:doer,
// because the whole design rests on them and a rail nobody tests is a comment.
//
// Three rules this file exists to keep:
//
//   1. A Journeyman failure never fails the tick. It is a measurement running
//      alongside production, not a dependency of it. Every path below returns;
//      none throws.
//   2. Every attempt is priced, including the failed ones. Journeyman writes
//      that row itself; this file checks that it landed and says so loudly when
//      it did not, because an unpriced attempt is what makes the week's total a
//      guess.
//   3. The shadow is never mergeable. The `journeyman/` prefix is the mechanism;
//      the draft flag and the `shadow` label are what a person sees. If the
//      draft conversion fails the PR is still unreachable by the gate, and the
//      failure is logged rather than swallowed.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Journeyman creates its own branches under this prefix and refuses any other. */
export const SHADOW_BRANCH_PREFIX = "journeyman/";
/** What a person sees on the PR. The prefix is what the gate sees. */
export const SHADOW_LABEL = "shadow";

export function isShadowBranch(ref) {
  return String(ref ?? "").startsWith(SHADOW_BRANCH_PREFIX);
}

/**
 * May the shadow leg run here at all? Pure, because "it silently did nothing"
 * is the failure mode this whole file is trying to avoid.
 *
 * Journeyman is a CLI on the operator's machine, not a service. In GitHub
 * Actions — where the dispatcher actually runs — none of this is present, and
 * the honest outcome is a named skip rather than a broken tick.
 *
 * @returns {{run:boolean, reason:string}}
 */
export function decideShadow({ home = "", hasCli = false, hasUv = false, disabled = false }) {
  if (disabled) return { run: false, reason: "turned off for this tick (DOER_SHADOW=0)" };
  if (!home) return { run: false, reason: "no journeyman checkout found — set JOURNEYMAN_HOME" };
  if (!hasCli) return { run: false, reason: `no cli/main.py under ${home}` };
  if (!hasUv) return { run: false, reason: "uv is not on PATH — journeyman runs under uv" };
  return { run: true, reason: `journeyman at ${home}` };
}

/**
 * The argv for `uv`. The ticket class is left to journeyman unless forced: it
 * infers the class from the issue's own labels and lets "bug" win ties, which
 * is the stricter reading and not ours to weaken from here.
 */
export function shadowCommand({ repo, issueNumber, tier, budget, ticketClass, runnerTimeout, rehearse = false }) {
  const args = [
    "run", "cli/main.py", "run",
    `https://github.com/${repo}/issues/${issueNumber}`,
    "--tier", tier,
    "--budget", Number(budget).toFixed(2),
    "--runner-timeout", String(runnerTimeout),
  ];
  if (ticketClass) args.push("--class", ticketClass);
  // Journeyman's own --dry-run: the real gate, a stubbed model, nothing
  // published and nothing spent. It is the only way to exercise this leg
  // end-to-end — home discovery, the spawn, the ledger row, the PR snapshot —
  // without buying a model call every time somebody changes a line here.
  if (rehearse) args.push("--dry-run");
  return args;
}

/**
 * Which open `journeyman/*` PRs appeared while we were running. Journeyman
 * names its own branch from the issue title, with a slug rule that is its own
 * and could drift from ours; recomputing that name here would be a second copy
 * of somebody else's decision. A before/after snapshot asks GitHub instead.
 */
export function newShadowPrs(before = [], after = []) {
  const seen = new Set(before.filter((p) => isShadowBranch(p.headRefName)).map((p) => p.number));
  return after.filter((p) => isShadowBranch(p.headRefName) && !seen.has(p.number));
}

// The ledger's columns are machine-generated identifiers and numbers — no free
// text ever reaches it — so a plain split is enough and a CSV parser is not.
//
// The \r is not decoration. Python's csv.writer terminates every line with
// CRLF, so splitting on "\n" alone leaves a carriage return glued to the last
// column: the header key became "ts\r", every row's ts read as undefined, and
// this file then reported a correctly written row as a MISSING one — announcing
// an unpriced attempt on every single run. Found by rehearsing the leg against
// the real ledger on 2026-09-04; a made-up fixture would have used "\n" and
// passed.
export function parseLedger(csv) {
  const lines = String(csv ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const cols = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

/** Rows written since a moment — how we tell our attempt's row from history's. */
export function ledgerRowsSince(csv, startedAtMs) {
  return parseLedger(csv).filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isFinite(t) && t >= startedAtMs;
  });
}

/**
 * A row that recorded no money for an attempt that really called a provider.
 * `stub` rows come from --dry-run and genuinely cost nothing.
 *
 * This is the shape journeyman itself calls a bug rather than a gap: on
 * 2026-09-04 a killed runner recorded $0.00 for an attempt the provider had
 * billed $0.155 for, and the ledger under-reported the month by a third.
 */
export function unpricedAttempt(row) {
  if (!row) return false;
  if (row.provider === "stub") return false;
  return Number(row.cost_usd) === 0;
}

/**
 * Why no shadow PR appeared. Worth a function because the three reasons are
 * completely different news: a rehearsal is working as intended, a red gate is
 * the measurement this project exists to take, and no row at all means the
 * attempt itself never landed anywhere.
 */
export function noPrExplanation({ row, rehearse = false }) {
  if (rehearse) return "a rehearsal — journeyman publishes nothing on --dry-run, by design";
  if (!row) return "journeyman recorded no attempt at all; look in its runs/ directory";
  if (row.verdict === "green") {
    return "journeyman's gate went green but no pull request appeared — that is a defect, not a result";
  }
  return `journeyman's gate was ${row.verdict}${row.failure_stage ? ` at ${row.failure_stage}` : ""}, and only green publishes`;
}

// ─── The impure half ─────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where journeyman lives. `JOURNEYMAN_HOME` when set — and then only there,
 * never falling back: an operator who names a path and silently gets a
 * different checkout is the "configuration" defect class in CLAUDE.md §8, our
 * own wrong input mistaken for somebody else's result. When it is unset the
 * sibling checkout is tried, which is the layout on the machine this runs on;
 * a wrong guess there is safe by construction, because decideShadow requires
 * cli/main.py to exist and the worst outcome is a named skip.
 */
export function findJourneymanHome(env = process.env, exists = (p) => existsSync(p)) {
  if (env.JOURNEYMAN_HOME) return resolve(env.JOURNEYMAN_HOME);
  const sibling = resolve(HERE, "../../../journeyman");
  return exists(join(sibling, "cli", "main.py")) ? sibling : "";
}

function onPath(bin) {
  try {
    execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

function ghJson(args) {
  try {
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }) || "null");
  } catch {
    return null;
  }
}

function openPrs(repo) {
  return ghJson([
    "pr", "list", "--repo", repo, "--state", "open", "--limit", "50",
    "--json", "number,headRefName,isDraft",
  ]) ?? [];
}

/**
 * Draft it and label it. Neither is what keeps it away from the gate — the
 * branch prefix does that — so a failure here is loud but not fatal.
 */
function markAsShadow(repo, prNumber, say) {
  try {
    execFileSync("gh", [
      "label", "create", SHADOW_LABEL, "--repo", repo,
      "--color", "6E6E6E", "--description", "a second implementer's run; never merges",
    ], { stdio: "ignore" });
  } catch {
    // Already exists, which is the normal case after the first shadow run.
  }
  for (const [what, args] of [
    ["draft", ["pr", "ready", String(prNumber), "--repo", repo, "--undo"]],
    ["label", ["pr", "edit", String(prNumber), "--repo", repo, "--add-label", SHADOW_LABEL]],
  ]) {
    try {
      execFileSync("gh", args, { stdio: "ignore" });
    } catch (err) {
      say(`   WARNING: could not set the ${what} on #${prNumber} — ${err.message.split("\n")[0]}`);
      say(`   It is still unreachable by the gate: the shepherd reads doer/* only.`);
    }
  }
}

/**
 * Run the second implementer on the ticket the tick just claimed.
 *
 * Never throws. Returns what happened so the caller can print one line about
 * it; the caller's only obligation is to ignore a failure.
 *
 * @returns {{ran:boolean, reason:string, prs:number[], row:object|null}}
 */
export function shadowRun({ repo, issueNumber, dry = false, say = console.log, env = process.env }) {
  try {
    const home = findJourneymanHome(env);
    const decision = decideShadow({
      home,
      hasCli: !!home && existsSync(join(home, "cli", "main.py")),
      hasUv: onPath("uv"),
      disabled: env.DOER_SHADOW === "0",
    });
    if (!decision.run) {
      say(`Shadow run skipped: ${decision.reason}`);
      return { ran: false, reason: decision.reason, prs: [], row: null };
    }

    const args = shadowCommand({
      repo,
      issueNumber,
      tier: env.DOER_SHADOW_TIER ?? "t1",
      budget: Number(env.DOER_SHADOW_BUDGET ?? 1.0),
      ticketClass: env.DOER_SHADOW_CLASS || null,
      runnerTimeout: Number(env.DOER_SHADOW_RUNNER_TIMEOUT ?? 1800),
      rehearse: env.DOER_SHADOW_REHEARSE === "1",
    });

    if (dry) {
      say(`   [dry-run] (cd ${home} && uv ${args.join(" ")})`);
      return { ran: false, reason: "dry run", prs: [], row: null };
    }

    say(`Shadow run: ${decision.reason}`);
    say(`   uv ${args.join(" ")}`);

    const before = openPrs(repo);
    const ledger = join(home, "runs", "ledger.csv");
    const startedAt = Date.now();

    // The deadline is a last resort, not a control: journeyman bounds its own
    // runner and asks it to stop before killing it, precisely so the price
    // survives. A kill from here lands on a python process that writes its
    // ledger row last, so the row is lost — which is why the deadline is far
    // outside journeyman's own and why a missing row is shouted about below.
    const deadline = Number(env.DOER_SHADOW_TIMEOUT ?? 2700) * 1000;
    const r = spawnSync("uv", args, { cwd: home, stdio: "inherit", timeout: deadline });
    if (r.error?.code === "ETIMEDOUT") {
      say(`   The shadow run passed ${deadline / 1000}s and was stopped. Its price may not have been written.`);
    } else if (r.error) {
      say(`   The shadow run could not be started: ${r.error.message}`);
    } else {
      say(`   journeyman exited ${r.status} (1 just means the gate was not green).`);
    }

    // Priced or not, and said out loud either way.
    let row = null;
    const rows = existsSync(ledger) ? ledgerRowsSince(readFileSync(ledger, "utf8"), startedAt) : [];
    if (rows.length === 0) {
      say(`   WARNING: no ledger row for this attempt in ${ledger} — the attempt is unpriced,`);
      say(`   which is a bug, not a gap. The artifacts are under ${join(home, "runs")}.`);
    } else {
      row = rows[rows.length - 1];
      say(`   Ledger: ${row.verdict}${row.failure_stage ? ` at ${row.failure_stage}` : ""} · $${row.cost_usd} · ${row.model}`);
      if (unpricedAttempt(row)) {
        say(`   WARNING: that row records $0.00 for a real provider call — the attempt is unpriced.`);
      }
    }

    // Journeyman publishes only on green (M0, by design), so no PR here is
    // usually a measurement rather than a malfunction — but not always, and the
    // three cases are not the same news.
    const fresh = newShadowPrs(before, openPrs(repo));
    if (fresh.length === 0) {
      const why = noPrExplanation({ row, rehearse: env.DOER_SHADOW_REHEARSE === "1" });
      say(`   No shadow PR: ${why}.`);
      return { ran: true, reason: why, prs: [], row };
    }
    for (const pr of fresh) {
      say(`   Shadow PR #${pr.number} on ${pr.headRefName} — marking it draft and '${SHADOW_LABEL}'.`);
      markAsShadow(repo, pr.number, say);
    }
    return { ran: true, reason: "published", prs: fresh.map((p) => p.number), row };
  } catch (err) {
    // The whole point: production does not depend on this.
    say(`Shadow run failed and was ignored: ${err.message.split("\n")[0]}`);
    return { ran: false, reason: `failed: ${err.message.split("\n")[0]}`, prs: [], row: null };
  }
}
