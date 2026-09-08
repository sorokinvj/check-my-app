// One tick of the doer (design: "the second half of the loop", 2026-09-02).
//
// CheckMyApp files tickets against itself. Until now a person closed them, which
// is the builder grading its own work — the thing rule §8 forbids. This claims
// one ticket, hands it to an implementer that is not us, and stops. Whether the
// work is actually FIXED is never decided here: the dispatcher may say shipped,
// and only a later CheckMyApp run walking the deployed product from outside may
// say resolved (src/agent/reconcile.ts).
//
// Runs in GitHub Actions rather than on a VM for one reason paid for on
// 2026-09-01: JobLander's dispatcher died of an out-of-memory kill on 26 August
// and nobody noticed for six days, because a stopped machine is silent while a
// failed workflow is loud.
//
// Usage:
//   node scripts/doer/tick.mjs --dry-run   # decide and print, touch nothing
//   node scripts/doer/tick.mjs             # act

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { decideTick, branchFor, isDoerBranch, STOP_LABEL } from "./eligibility.mjs";
import { partition } from "./queue.mjs";
import { shadowRun } from "./shadow.mjs";

const DRY = process.argv.includes("--dry-run");
const REPO = process.env.DOER_REPO ?? "sorokinvj/check-my-app";
const BASE = "main";

function gh(args, { json = true } = {}) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return json ? JSON.parse(out || "null") : out;
}
function run(cmd, args) {
  if (DRY) return console.log(`   [dry-run] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
}
const say = (s) => console.log(s);

// ─── What the implementer is told ────────────────────────────────────────────
//
// Deliberately short and all constraint. It gets the symptom from the ticket and
// diagnoses for itself — it has the repository, which we deliberately never take
// from a customer (rule §9). What it does NOT get is permission to decide the
// work is done.
function taskComment(item) {
  return [
    // Proven on 2026-09-02 (karass experiment): a non-review "@codex" comment
    // ON A PULL REQUEST starts a task that commits to THAT PR's branch. The
    // same mention on a Linear issue does not — that task ends with "make_pr
    // tool is not available" and waits for a person to press a button. So the
    // branch-and-PR first, mention second, is the only shape of this handoff
    // with no human in the middle, and simplifying it away would have put one
    // back. The repository is pinned inside the sentence because the docs say
    // it only binds there: "include it in your comment, for example: @Codex fix
    // this in openai/codex".
    `@codex implement this ticket in ${REPO}, on this branch.`,
    ``,
    `**${item.ticket} — ${item.label}**`,
    ``,
    `Filed by our own runs, seen ${item.occurrences} time(s). The ticket on the board`,
    `carries every run that tripped it, in the filer's own words; read it there.`,
    ``,
    `---`,
    `**Rules for this change, in order of precedence:**`,
    ``,
    `1. **Scope is the ticket.** No drive-by refactors, no side quests. If the ticket`,
    `   cannot be done as written, say so in a comment and change nothing.`,
    `2. **Never touch \`CLAUDE.md\`.** Those nine rules are the owner's, each written`,
    `   after a failure that cost trust. A change that edits the rules it is judged`,
    `   against is not a change.`,
    `3. **Read \`AGENTS.md\` and \`CLAUDE.md\` before you start.** AGENTS.md carries the`,
    `   commands, what counts as done, and the conventions this project does not`,
    `   state anywhere else; CLAUDE.md is its constitution.`,
    `4. **The commands in AGENTS.md must pass** — including every \`npm run verify:*\`,`,
    `   which are the closed set this loop treats as proof. The OpenNext build`,
    `   fails in your environment by design; do not chase it.`,
    `5. **If the fix is not user-visible, it lands with a \`verify:\` script of its own.**`,
    `   A merged diff proves the code is well written; it says nothing about whether`,
    `   this is the thing that was asked for.`,
    `6. **If \`main\` has moved, rebase on it explicitly** — your checkout is a`,
    `   snapshot taken when the task started, and naming a recent commit will not`,
    `   make it visible to you.`,
    `7. **Commit to this branch. Do not merge, do not touch \`main\`.** Whether the`,
    `   problem is actually gone is decided by a later run of CheckMyApp against the`,
    `   deployed product, never by you and never by me.`,
  ].join("\n");
}

// ─── State ───────────────────────────────────────────────────────────────────
//
// The queue is what our own runs filed and nothing else (CHE-118). It is read
// from our database rather than from labels on GitHub issues, because the
// tickets were never there: a run that cannot verify a step files a "[Checker
// gap] …", a rejected claim files a "[Checker defect] …", and both leave a row
// in IssueLink. The label queue was filled by a person once, in September, and
// by nobody since (CHE-170).
//
// Shelling out to tsx rather than importing: this file is plain node and the
// reader needs the product's own hashing to recognise a capability. The tick
// already shells out to `gh` for everything else.
const board = JSON.parse(
  execFileSync("npx", ["tsx", "--tsconfig", "tsconfig.json", "scripts/doer/board-queue.ts", "--json"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  }),
);
const { queue, refused } = partition(board.known);

// Every tick says what it saw, including what it refused and why. A queue that
// silently drops most of what it is offered looks identical to an empty one,
// and telling those two apart is the whole of CHE-152.
say(`Board: ${board.known.length} open ticket(s) of ours, ${queue.length} admitted, ${refused.length} refused`);
for (const r of refused) say(`   refused ${r.ticket} — ${r.reason}`);
for (const u of board.unknown ?? []) {
  say(`   ${u.ticket} matches no capability this repository knows about — the two lists have drifted apart`);
}

// How many claims for each ticket came back unanswered (CHE-211). No new store
// for this: a withdrawn claim leaves a closed pull request on the ticket's own
// branch, and that is the history. Merged ones are not counted — those are
// claims that ended in work.
const closedDoerPrs = gh([
  "pr", "list", "--repo", REPO, "--state", "closed", "--limit", "100",
  "--json", "headRefName,mergedAt",
]).filter((p) => isDoerBranch(p.headRefName) && !p.mergedAt);

const withdrawnByTicket = {};
for (const p of closedDoerPrs) {
  // Branches are `doer/<ticket>-<slug>`; the ticket is what the tick put there.
  const ticket = p.headRefName.slice("doer/".length).split("-").slice(0, 2).join("-").toUpperCase();
  withdrawnByTicket[ticket] = (withdrawnByTicket[ticket] ?? 0) + 1;
}

// The repository-wide stop stays on GitHub, where a person who wants the doer to
// stop is already looking. It is the one brake that must not require the board.
const issues = gh([
  "issue", "list", "--repo", REPO, "--state", "open", "--limit", "100",
  "--json", "number,title,labels",
]).map((i) => ({ ...i, labels: i.labels.map((l) => l.name) }));

const openPrs = gh([
  "pr", "list", "--repo", REPO, "--state", "open", "--limit", "50",
  "--json", "number,headRefName,headRefOid",
]);
const openDoerPrs = openPrs
  .filter((p) => isDoerBranch(p.headRefName))
  .map((p) => ({ number: p.number, headRef: p.headRefName, headSha: p.headRefOid }));

const stopped = issues.some((i) => i.labels.includes(STOP_LABEL));

// Driving an open PR to a decision is NOT this process's job (CHE-122): that is
// the shepherd, which runs on its own faster rhythm because a PR needs a nudge
// in minutes, not in the two hours between claims. This one only claims.
//
// ─── Then: may we start something new? ───────────────────────────────────────
const decision = decideTick({ queue, openDoerPrs, stopped, withdrawnByTicket });
if (!decision.act) {
  say(`No new work this tick: ${decision.reason}`);
  process.exit(0);
}

for (const t of decision.steppedAside ?? []) {
  say(`   ${t.ticket} steps aside — ${t.withdrawn} claim(s) came back unanswered; it waits for an implementer that delivers`);
}

const item = decision.item;
const branch = branchFor(item.ticket.toLowerCase(), item.label);
if (!branch.startsWith("doer/")) throw new Error(`refusing to push a branch outside doer/: ${branch}`);
say(`Claiming ${item.ticket} — ${item.label}`);
say(`Branch: ${branch}`);

if (!DRY) {
  mkdirSync(".doer", { recursive: true });
  // What the implementer is handed: the capability, and where to read the rest.
  // The ticket's own body — every run that tripped this, in the filer's words —
  // stays on the board, which is the one place it cannot go stale.
  writeFileSync(
    ".doer/TICKET.md",
    `# ${item.label}\n\nTicket: ${item.ticket} (${item.kind}, seen ${item.occurrences} time(s))\n`,
  );
}
run("git", ["config", "user.name", "checkmyapp-doer"]);
run("git", ["config", "user.email", "doer@checkmyapp.dev"]);
// A branch left behind by a failed claim is invisible to the eligibility check,
// which counts open PRs — so the tick claims the same ticket again, and the push
// fails as a non-fast-forward every two hours forever. That is what happened on
// 2026-09-03: the 16:23 tick pushed doer/6, could not open the PR, and left the
// branch; every tick after it died on the push instead of naming the real cause.
//
// Deleting it is safe by construction: a doer branch with no PR carries one
// commit, the claim, and the claim is what this tick is about to write again.
if (!DRY) {
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { stdio: "ignore" });
    say(`Found a leftover ${branch} with no PR — removing it before claiming again.`);
    run("git", ["push", "origin", "--delete", branch]);
  } catch {
    // exit code 2 means no such branch, which is the normal case.
  }
}

run("git", ["checkout", "-b", branch]);
run("git", ["add", "-f", ".doer/TICKET.md"]);
run("git", ["commit", "-m", `doer: claim ${item.ticket} — ${item.label}`]);
run("git", ["push", "-u", "origin", branch]);

// If the PR cannot be opened, take the branch back down. A pushed branch with no
// PR is the orphan above — it poisons every later tick on the same ticket, and
// the failure it produces then names the push rather than the reason the PR could
// not be created. Fail loudly at the real cause instead.
try {
  run("gh", [
    "pr", "create", "--repo", REPO, "--base", BASE, "--head", branch,
    "--title", `[doer] ${item.label}`,
    // No "Closes": the ticket lives on the board, and whether the problem is
    // actually gone is decided by a later CheckMyApp run walking the deployed
    // product from outside (src/agent/reconcile.ts), never by a merge here.
    "--body", `Claimed from ${item.ticket}. The implementer works on this branch; the merge gate and a later CheckMyApp run decide the rest.`,
  ]);
} catch (err) {
  if (!DRY) {
    say(`Could not open the pull request — removing ${branch} so the next tick is not blocked by it.`);
    try { execFileSync("git", ["push", "origin", "--delete", branch], { stdio: "inherit" }); } catch {}
  }
  throw err;
}
const prNumber = DRY ? "(dry-run)" : gh(["pr", "view", branch, "--repo", REPO, "--json", "number"]).number;
say(`PR opened: #${prNumber}`);

run("gh", ["pr", "comment", String(prNumber), "--repo", REPO, "--body", taskComment(item)]);
say("Handed to the implementer. This tick is done — nothing here decides whether it worked.");

// ─── The same ticket, a second implementer (CHE-128) ─────────────────────────
//
// Strictly after everything above, and unable to affect any of it. Comparing
// two implementers on two different tickets measures the tickets; this puts
// both on one. What comes out is a draft on journeyman/*, which the shepherd
// cannot see (it reads doer/* and skips drafts) and the queue does not count.
//
// It runs last and its result is ignored on purpose: a measurement that can
// take production down with it is not a measurement, it is a dependency.
// …and it does not run on a board ticket. The shadow leg hands the second
// implementer a GitHub issue URL (shadow.mjs) and there is no GitHub issue any
// more. Said out loud instead of skipped quietly: the double run is how the two
// implementers were compared (CHE-128), and it is off until something gives the
// runner a ticket it can read. Its epic is closed and its report is written, so
// this costs a comparison nobody is currently making — not a measurement in
// flight.
say(
  `Shadow run skipped for ${item.ticket}: the second implementer reads a GitHub issue URL, ` +
    `and this ticket lives on the board (CHE-118).`,
);
