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
// belongs to someone else: Mender writes (in the tick), Codex reviews, and only
// a later CheckMyApp run may say the problem is gone.
//
//   node scripts/doer/shepherd.mjs --dry-run   # decide and print, touch nothing
//   node scripts/doer/shepherd.mjs             # act

import { execFileSync } from "node:child_process";
import { decidePr, MAX_ROUNDS, ROUND_MARKER, roundState } from "./machine.mjs";
import { HOLD_LABEL, STOP_LABEL, isMergeCandidate } from "./eligibility.mjs";
import { findingsText } from "./mender.mjs";
import { REVIEWER_LOGIN, REVIEW_REQUEST, askedSinceHead, codexSummaryState, reviewRequestNeeded } from "./review.mjs";
import { unparkOurRuns } from "./unpark.mjs";

const DRY = process.argv.includes("--dry-run");
const REPO = process.env.DOER_REPO ?? "sorokinvj/check-my-app";

function gh(args, { json = true, env = undefined } = {}) {
  const out = execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return json ? JSON.parse(out || "null") : out;
}
function act(cmd, args, opts = {}) {
  if (DRY) return console.log(`   [dry-run] ${cmd} ${args.slice(0, 4).join(" ")} …`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// Review threads, read from GitHub's own reviewThreads state rather than from
// the wording of a review. Classifying on a phrase reads the vocabulary and
// misses the intent, and it would also tie us to one reviewer's house style —
// this signal is the same whoever left the comment.
//
// isOutdated means the thread points at code the branch has since replaced; it
// is not an objection to what is there now. The bodies come along because the
// implementer's next round is built from them (mender.mjs findingsText).
function reviewThreads(prNumber) {
  const q = `query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:100){ nodes {
          isResolved isOutdated path line
          comments(first:10){ nodes { author { login } body } }
        } }
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
    return nodes
      .filter((t) => !t.isResolved && !t.isOutdated)
      .map((t) => ({
        path: t.path,
        line: t.line,
        comments: (t.comments?.nodes ?? []).map((c) => ({ author: c.author?.login ?? "?", body: c.body })),
      }));
  } catch (err) {
    // Fail closed. An unreadable review is not a clean review — merging on an
    // unknown is how a gate lets through a change nobody looked at.
    console.warn(`[shepherd] could not read review threads for #${prNumber}: ${err.message}`);
    return null;
  }
}

// Does this PR change anything a user could feel, or is it still just the claim?
// The tick opens a pull request only after Mender's patch is on the branch, so
// this is now a guard against a tick that died between the two pushes — and
// against a hand-opened doer/* PR that carries nothing. Until real files move,
// there is nothing to review and nothing to merge, and the later guards would
// all say yes, because green CI and a clean review are exactly what an empty
// diff produces.
function hasImplementerWork(prNumber) {
  try {
    const files = gh([
      // One page, not --paginate: with --jq gh emits one array PER page, which
      // is not parseable JSON. A hundred files is far past the point where the
      // first non-.doer name has already appeared.
      "api", `repos/${REPO}/pulls/${prNumber}/files?per_page=100`,
      "--jq", "[.[] | .filename]",
    ]) ?? [];
    return files.some((f) => !f.startsWith(".doer/"));
  } catch (err) {
    // Fail closed, as everywhere else in this gate: an unreadable diff is not a
    // diff we may merge.
    console.warn(`[shepherd] could not read files for #${prNumber}: ${err.message}`);
    return false;
  }
}

// Did the reviewer finish on THIS head? A verdict about an earlier push was
// about a different diff.
//
// Three shapes count, because a reviewer with findings uses a different one
// from a reviewer with nothing to say:
//
//   - a formal review on this commit (Codex with findings: state COMMENTED,
//     commit_id = head — measured on #149, 2026-09-18);
//   - an inline comment on this commit;
//   - Codex's summary comment showing "Completed" for this head's sha, which
//     is all a review with no findings leaves behind (review.mjs).
function reviewReportedForHead(prNumber, headSha, comments) {
  // A review by github-actions[bot] is never a verdict. Enabling Actions to
  // create pull requests also grants it the right to approve them, so a
  // workflow could otherwise approve the branch a workflow just pushed — the
  // author grading its own work, which rule §8 forbids and which this whole
  // loop exists to prevent. The permission was enabled on 2026-09-04 because
  // the doer cannot open a PR without it; this line is what makes that safe.
  const reviews = (gh([
    "api", `repos/${REPO}/pulls/${prNumber}/reviews`,
    "--jq", "[.[] | {sha:.commit_id, state:.state, who:.user.login}]",
  ]) ?? []).filter((r) => r.who !== "github-actions[bot]");
  if (reviews.some((r) => r.sha === headSha)) return true;

  const inline = gh([
    "api", `repos/${REPO}/pulls/${prNumber}/comments`,
    "--jq", "[.[] | {sha:.commit_id}]",
  ]) ?? [];
  if (inline.some((c) => c.sha === headSha)) return true;

  return comments.some((c) => c.who === REVIEWER_LOGIN && codexSummaryState(c.body, headSha) === "completed");
}

function summaryStateFor(comments, headSha) {
  for (const c of comments) {
    if (c.who !== REVIEWER_LOGIN) continue;
    const s = codexSummaryState(c.body, headSha);
    if (s) return s;
  }
  return null;
}

// A stop the owner set outranks everything, including a PR mid-round — and
// including the unparking below, which spends this repository's compute.
const stopped = gh([
  "issue", "list", "--repo", REPO, "--state", "open", "--limit", "100", "--json", "labels",
]).some((i) => i.labels.some((l) => l.name === STOP_LABEL));
if (stopped) {
  console.log(`Stopped — a ${STOP_LABEL} label is set. Nothing was touched.`);
  process.exit(0);
}

// Before reading verdicts, make sure they can exist at all (CHE-153).
//
// This repository is public and holds first-time contributors' workflow runs
// for approval. A pull request opened by our own bot counts as one, so PR #20's
// only run sat in `action_required` for twenty minutes on 2026-09-04 until a
// person pressed Approve. The gate below requires green checks for the current
// head and correctly refuses to read silence as success — so a run that never
// starts is a merge that never happens, and the loop's last step is a button.
//
// Released here rather than at the moment the PR is opened because every push
// by the tick parks a run of its own, and this process is the one that comes
// back every twenty minutes. Only our own branches are touched; the approval
// policy protecting strangers' forks is left exactly as it is.
unparkOurRuns({
  repo: REPO,
  gh,
  approve: (runId) => act("gh", ["api", "-X", "POST", `repos/${REPO}/actions/runs/${runId}/approve`]),
});

const prs = gh([
  "pr", "list", "--repo", REPO, "--state", "open", "--limit", "50",
  // createdAt so an unanswered claim can be told from a fresh one (CHE-209).
  "--json", "number,headRefName,headRefOid,isDraft,createdAt",
]).filter(isMergeCandidate);

if (prs.length === 0) {
  console.log("No open doer PRs to shepherd.");
  process.exit(0);
}

for (const pr of prs) {
  const comments = gh([
    "api", `repos/${REPO}/issues/${pr.number}/comments?per_page=100`,
    "--jq", "[.[] | {body: .body, createdAt: .created_at, who: .user.login}]",
  ]) ?? [];
  // Read as text: gh prints a bare jq string unquoted, which is not JSON.
  const headAt = gh([
    "api", `repos/${REPO}/commits/${pr.headRefOid}`, "--jq", ".commit.committer.date",
  ], { json: false }).trim();
  const { roundsUsed, pending } = roundState(comments, headAt);

  // Merging is the default, and this is the line that decides it (owner,
  // 2026-09-03). It used to require an opt-in label, which made "stopped,
  // waiting for a person" the loop's normal state — the same manual button we
  // rejected the Linear handoff for, moved to the end of the pipeline. The
  // brakes are the labels that already exist: doer:hold on the pull request,
  // doer:stop for everything.
  const prLabels = gh(["pr", "view", String(pr.number), "--repo", REPO, "--json", "labels"])?.labels ?? [];
  const mayMerge = !prLabels.some((l) => l.name === HOLD_LABEL);

  const checks = gh([
    "api", `repos/${REPO}/commits/${pr.headRefOid}/check-runs`,
    "--jq", "[.check_runs[] | {name:.name, conclusion:.conclusion, headSha:.head_sha}]",
  ]) ?? [];

  const threads = reviewThreads(pr.number);
  const facts = {
    headSha: pr.headRefOid,
    checks,
    hasImplementerWork: hasImplementerWork(pr.number),
    reviewReportedForHead: reviewReportedForHead(pr.number, pr.headRefOid, comments),
    unresolvedFindings: threads === null ? Number.POSITIVE_INFINITY : threads.length,
    roundsUsed,
    mayMerge,
    ageHours: (Date.now() - new Date(pr.createdAt).getTime()) / 3_600_000,
  };
  const { state, reason } = decidePr(facts);
  console.log(`PR #${pr.number} (${pr.headRefName}) → ${state}: ${reason}`);

  if (state === "waitingForReview") {
    // Codex reviews a pull request opened for review on its own, and answers
    // "@codex review" only from a ChatGPT-linked identity (CHE-155) — so the
    // ask goes out under the owner's token, and only when nothing else will
    // produce a verdict (review.mjs).
    const need = reviewRequestNeeded({
      verdictForHead: facts.reviewReportedForHead,
      summaryState: summaryStateFor(comments, pr.headRefOid),
      askedSinceHead: askedSinceHead(comments, headAt),
      headAgeMinutes: (Date.now() - Date.parse(headAt)) / 60_000,
    });
    console.log(`   review request: ${need.reason}`);
    if (need.ask) {
      if (!process.env.CODEX_REVIEW_TOKEN) {
        console.warn("   CODEX_REVIEW_TOKEN is not set — nobody can ask the reviewer, and this PR will wait forever");
      } else {
        act("gh", ["pr", "comment", String(pr.number), "--repo", REPO, "--body",
          `${REVIEW_REQUEST} in ${REPO}.\n\nAsked by the shepherd for head ${pr.headRefOid.slice(0, 7)}.`],
          { env: { ...process.env, GH_TOKEN: process.env.CODEX_REVIEW_TOKEN } });
      }
    }
  }

  if (state === "fixing") {
    if (pending) {
      // The implementer runs on the tick's rhythm, not ours. Asking again
      // before it has answered would burn the three rounds in an hour.
      console.log(`   round ${roundsUsed} is still waiting for the implementer — not asking again`);
    } else {
      const failed = checks
        .filter((c) => c.headSha === pr.headRefOid && !["success", "neutral", "skipped"].includes(c.conclusion))
        .map((c) => c.name);
      const findings = findingsText(threads ?? [], failed);
      act("gh", ["pr", "comment", String(pr.number), "--repo", REPO, "--body",
        `${ROUND_MARKER}\n**Round ${roundsUsed + 1} of ${MAX_ROUNDS}.** ${reason}\n\n` +
        `The next doer tick hands these to the implementer, on this branch:\n\n${findings}`]);
    }
  }

  if (state === "blocked") {
    act("gh", ["pr", "comment", String(pr.number), "--repo", REPO, "--body",
      `**Stopped after ${MAX_ROUNDS} rounds.** ${reason}\n\n` +
      `The loop is not converging, so it stops rather than spending a fourth round on the same ` +
      `ground. Nothing here is merged and nothing is lost — the branch and every round of ` +
      `review are above.`]);
    act("gh", ["pr", "edit", String(pr.number), "--repo", REPO, "--add-label", HOLD_LABEL]);
  }

  if (state === "withdrawn") {
    // Taken back, not judged. Nothing was built, so there is nothing to reject:
    // the ticket stays exactly as open as it was, and the next tick is free to
    // claim it again or claim something else. The branch goes too, or it would
    // be the orphan that blocked every later tick on the same ticket (CHE-139).
    act("gh", ["pr", "comment", String(pr.number), "--repo", REPO, "--body",
      `**Claim withdrawn.** ${reason}\n\n` +
      `Nothing was built and nothing is judged here — the ticket is untouched and may be ` +
      `claimed again. This exists so that one attempt that never finished cannot hold ` +
      `the whole queue, which is what happened for two days before CHE-209.`]);
    act("gh", ["pr", "close", String(pr.number), "--repo", REPO, "--delete-branch"]);
  }

  if (state === "merging") {
    act("gh", ["pr", "merge", String(pr.number), "--repo", REPO, "--squash", "--delete-branch"]);
    act("gh", ["pr", "comment", String(pr.number), "--repo", REPO, "--body",
      "Shipped. Whether the problem is actually gone is decided by the next CheckMyApp run " +
      "against the deployed product — not by this merge."]);
  }
}
