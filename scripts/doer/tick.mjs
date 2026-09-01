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
import { decideTick, decideMerge, branchFor, QUEUE_LABEL, STOP_LABEL } from "./eligibility.mjs";

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
function taskComment(issue) {
  return [
    `@codex implement this ticket on the current branch.`,
    ``,
    `**Ticket #${issue.number} — ${issue.title}**`,
    ``,
    issue.body?.trim() ? issue.body.trim() : "(see the linked CHE ticket)",
    ``,
    `---`,
    `**Rules for this change, in order of precedence:**`,
    ``,
    `1. **Scope is the ticket.** No drive-by refactors, no side quests. If the ticket`,
    `   cannot be done as written, say so in a comment and change nothing.`,
    `2. **Never touch \`CLAUDE.md\`.** Those nine rules are the owner's, each written`,
    `   after a failure that cost trust. A change that edits the rules it is judged`,
    `   against is not a change.`,
    `3. **Read \`CLAUDE.md\` before you start.** It is the constitution of this repo:`,
    `   what may appear in customer-facing text, what counts as evidence, and why`,
    `   several refusals are deterministic rather than advisory.`,
    `4. **\`npm run typecheck\`, \`npm run agent:typecheck\` and \`npm run lint\` must pass.**`,
    `   So must every \`npm run verify:*\` script — they are the acceptance registry,`,
    `   the closed set of commands this loop treats as proof.`,
    `5. **If the fix is not user-visible, it lands with a \`verify:\` script of its own.**`,
    `   A merged diff proves the code is well written; it says nothing about whether`,
    `   this is the thing that was asked for.`,
    `6. **Commit to this branch. Do not merge, do not touch \`main\`.** Whether the`,
    `   problem is actually gone is decided by a later run of CheckMyApp against the`,
    `   deployed product, never by you and never by me.`,
  ].join("\n");
}

// ─── State ───────────────────────────────────────────────────────────────────
const issues = gh([
  "issue", "list", "--repo", REPO, "--state", "open", "--limit", "100",
  "--json", "number,title,body,labels,createdAt",
]).map((i) => ({ ...i, labels: i.labels.map((l) => l.name) }));

const openPrs = gh([
  "pr", "list", "--repo", REPO, "--state", "open", "--limit", "50",
  "--json", "number,headRefName,headRefOid",
]);
const openDoerPrs = openPrs
  .filter((p) => p.headRefName.startsWith("doer/"))
  .map((p) => ({ number: p.number, headRef: p.headRefName, headSha: p.headRefOid }));

const stopped = issues.some((i) => i.labels.includes(STOP_LABEL));

// ─── First: can anything already open be merged? ─────────────────────────────
for (const pr of openDoerPrs) {
  const issueNumber = Number(pr.headRef.match(/^doer\/(\d+)/)?.[1]);
  const issue = issues.find((i) => i.number === issueNumber);
  const mayMerge = Boolean(issue?.labels.includes("doer:automerge"));

  const checks = gh([
    "api", `repos/${REPO}/commits/${pr.headSha}/check-runs`,
    "--jq", "[.check_runs[] | {name:.name, conclusion:.conclusion, headSha:.head_sha}]",
  ]) ?? [];
  const reviews = gh([
    "api", `repos/${REPO}/pulls/${pr.number}/reviews`,
    "--jq", "[.[] | {state:.state, headSha:.commit_id}]",
  ]) ?? [];

  const verdict = decideMerge({ mayMerge, headSha: pr.headSha, checks, reviews });
  say(`PR #${pr.number} (${pr.headRef}): ${verdict.merge ? "MERGE" : "hold"} — ${verdict.reason}`);
  if (verdict.merge) {
    run("gh", ["pr", "merge", String(pr.number), "--repo", REPO, "--squash", "--delete-branch"]);
    if (issue) {
      run("gh", ["issue", "comment", String(issue.number), "--repo", REPO, "--body",
        "Shipped. Whether it is actually gone is decided by the next CheckMyApp run against the deployed product — not by this merge."]);
    }
  }
}

// ─── Then: may we start something new? ───────────────────────────────────────
const decision = decideTick({ issues, openDoerPrs, stopped });
if (!decision.act) {
  say(`No new work this tick: ${decision.reason}`);
  process.exit(0);
}

const issue = decision.issue;
const branch = branchFor(issue.number, issue.title);
if (!branch.startsWith("doer/")) throw new Error(`refusing to push a branch outside doer/: ${branch}`);
say(`Claiming #${issue.number} — ${issue.title}`);
say(`Branch: ${branch}`);

if (!DRY) {
  mkdirSync(".doer", { recursive: true });
  writeFileSync(
    ".doer/TICKET.md",
    `# ${issue.title}\n\nGitHub issue: ${REPO}#${issue.number}\n\n${issue.body ?? ""}\n`,
  );
}
run("git", ["config", "user.name", "checkmyapp-doer"]);
run("git", ["config", "user.email", "doer@checkmyapp.dev"]);
run("git", ["checkout", "-b", branch]);
run("git", ["add", "-f", ".doer/TICKET.md"]);
run("git", ["commit", "-m", `doer: claim #${issue.number} — ${issue.title}`]);
run("git", ["push", "-u", "origin", branch]);

run("gh", [
  "pr", "create", "--repo", REPO, "--base", BASE, "--head", branch,
  "--title", `[doer] ${issue.title}`,
  "--body", `Claimed from #${issue.number}. The implementer works on this branch; the merge gate and a later CheckMyApp run decide the rest.\n\nCloses #${issue.number}`,
]);
const prNumber = DRY ? "(dry-run)" : gh(["pr", "view", branch, "--repo", REPO, "--json", "number"]).number;
say(`PR opened: #${prNumber}`);

run("gh", ["pr", "comment", String(prNumber), "--repo", REPO, "--body", taskComment(issue)]);
say("Handed to the implementer. This tick is done — nothing here decides whether it worked.");
