// The shepherd: takes an open pull request to a decision (CHE-122).
//
// Owner, 2026-09-02: a process whose only job is driving open PRs through
// review → fixes → review again, up to three rounds, and then deciding.
//
// It is separate from the dispatcher on purpose. Claiming a ticket is one job
// and happens rarely; driving a PR to done is another and needs a faster
// rhythm. Mixing them meant a PR waited two hours for a nudge it needed in ten
// minutes.
//
// This process holds no opinion. It reads facts, runs them through the machine
// (./machine.mjs), and does what the machine says. Every judgement in the loop
// belongs to someone else: Codex writes, Claude reviews, and only a later
// CheckMyApp run may say the problem is gone.
//
//   node scripts/doer/shepherd.mjs --dry-run   # decide and print, touch nothing
//   node scripts/doer/shepherd.mjs             # act

import { execFileSync } from "node:child_process";
import { decidePr, MAX_ROUNDS } from "./machine.mjs";
import { STOP_LABEL } from "./eligibility.mjs";

const DRY = process.argv.includes("--dry-run");
const REPO = process.env.DOER_REPO ?? "sorokinvj/check-my-app";

function gh(args, { json = true } = {}) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return json ? JSON.parse(out || "null") : out;
}
function act(cmd, args) {
  if (DRY) return console.log(`   [dry-run] ${cmd} ${args.slice(0, 4).join(" ")} …`);
  execFileSync(cmd, args, { stdio: "inherit" });
}

// A marker only this process writes, so counting rounds needs no extra storage
// and cannot be confused with a human asking for something.
const ROUND_MARKER = "<!-- doer:round -->";

// Unresolved review findings, read from GitHub's own reviewThreads state rather
// than from the wording of a review. Classifying on a phrase reads the
// vocabulary and misses the intent, and it would also tie us to one reviewer's
// house style — this signal is the same whoever left the comment.
//
// isOutdated means the thread points at code the branch has since replaced; it
// is not an objection to what is there now.
function unresolvedFindings(prNumber) {
  const q = `query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:100){ nodes { isResolved isOutdated } }
      }
    }
  }`;
  const [owner, repo] = REPO.split("/");
  try {
    const r = gh([
      "api", "graphql",
      "-f", `query=${q}`,
      "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `pr=${prNumber}`,
    ]);
    const nodes = r?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.filter((t) => !t.isResolved && !t.isOutdated).length;
  } catch (err) {
    // Fail closed. An unreadable review is not a clean review — merging on an
    // unknown is how a gate lets through a change nobody looked at.
    console.warn(`[shepherd] could not read review threads for #${prNumber}: ${err.message}`);
    return Number.POSITIVE_INFINITY;
  }
}

// Did a reviewer finish on THIS head? A verdict about an earlier push was about
// a different diff. Counted from both formal reviews and the review comments
// that the inline-comment reviewers leave.
function reviewReportedForHead(prNumber, headSha) {
  const reviews = gh([
    "api", `repos/${REPO}/pulls/${prNumber}/reviews`,
    "--jq", "[.[] | {sha:.commit_id, state:.state}]",
  ]) ?? [];
  if (reviews.some((r) => r.sha === headSha)) return true;
  const comments = gh([
    "api", `repos/${REPO}/pulls/${prNumber}/comments`,
    "--jq", "[.[] | {sha:.commit_id}]",
  ]) ?? [];
  return comments.some((c) => c.sha === headSha);
}

const prs = gh([
  "pr", "list", "--repo", REPO, "--state", "open", "--limit", "50",
  "--json", "number,headRefName,headRefOid,isDraft",
]).filter((p) => p.headRefName.startsWith("doer/") && !p.isDraft);

if (prs.length === 0) {
  console.log("No open doer PRs to shepherd.");
  process.exit(0);
}

// A stop the owner set outranks everything, including a PR mid-round.
const stopped = gh([
  "issue", "list", "--repo", REPO, "--state", "open", "--limit", "100", "--json", "labels",
]).some((i) => i.labels.some((l) => l.name === STOP_LABEL));
if (stopped) {
  console.log(`Stopped — a ${STOP_LABEL} label is set. ${prs.length} PR(s) left untouched.`);
  process.exit(0);
}

for (const pr of prs) {
  const issueNumber = Number(pr.headRefName.match(/^doer\/(\d+)/)?.[1]);
  const comments = gh([
    "api", `repos/${REPO}/issues/${pr.number}/comments`,
    "--jq", "[.[] | .body]",
  ]) ?? [];
  const roundsUsed = comments.filter((b) => b.includes(ROUND_MARKER)).length;

  const labels = issueNumber
    ? (gh(["issue", "view", String(issueNumber), "--repo", REPO, "--json", "labels"])?.labels ?? [])
    : [];
  const mayMerge = labels.some((l) => l.name === "doer:automerge");

  const checks = gh([
    "api", `repos/${REPO}/commits/${pr.headRefOid}/check-runs`,
    "--jq", "[.check_runs[] | {name:.name, conclusion:.conclusion, headSha:.head_sha}]",
  ]) ?? [];

  const facts = {
    headSha: pr.headRefOid,
    checks,
    reviewReportedForHead: reviewReportedForHead(pr.number, pr.headRefOid),
    unresolvedFindings: unresolvedFindings(pr.number),
    roundsUsed,
    mayMerge,
  };
  const { state, reason } = decidePr(facts);
  console.log(`PR #${pr.number} (${pr.headRefName}) → ${state}: ${reason}`);

  if (state === "fixing") {
    // A non-review "@codex" comment on a PR starts a task that commits to this
    // PR's branch — proven 2026-09-02. The repository is pinned inside the
    // sentence because that is the only place the docs say it binds.
    act("gh", ["pr", "comment", String(pr.number), "--repo", REPO, "--body",
      `${ROUND_MARKER}\n@codex address the review findings on this pull request, in ${REPO}.\n\n` +
      `This is round ${roundsUsed + 1} of ${MAX_ROUNDS}. ${reason}\n\n` +
      `Resolve each unresolved review thread by fixing what it points at, or — if a finding is ` +
      `wrong — reply on that thread saying why and leave the code as it is. Do not resolve a ` +
      `thread by silently agreeing with it.\n\n` +
      `Commit to this branch. If \`main\` has moved, rebase on it explicitly; your checkout is a ` +
      `snapshot from when the task started. Do not merge, do not touch \`main\`, and do not edit ` +
      `\`CLAUDE.md\` — see AGENTS.md for the commands and what counts as done.`]);
  }

  if (state === "blocked") {
    act("gh", ["pr", "comment", String(pr.number), "--repo", REPO, "--body",
      `**Stopped after ${MAX_ROUNDS} rounds.** ${reason}\n\n` +
      `The loop is not converging, so it stops rather than spending a fourth round on the same ` +
      `ground. Nothing here is merged and nothing is lost — the branch and every round of ` +
      `review are above.`]);
    if (issueNumber) {
      act("gh", ["issue", "edit", String(issueNumber), "--repo", REPO, "--add-label", "doer:hold"]);
    }
  }

  if (state === "merging") {
    act("gh", ["pr", "merge", String(pr.number), "--repo", REPO, "--squash", "--delete-branch"]);
    if (issueNumber) {
      act("gh", ["issue", "comment", String(issueNumber), "--repo", REPO, "--body",
        "Shipped. Whether the problem is actually gone is decided by the next CheckMyApp run " +
        "against the deployed product — not by this merge."]);
    }
  }
}
