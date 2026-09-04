// Releasing a workflow run that GitHub parked on our own branch (CHE-153).
//
// The repository is public, so `approval_policy: first_time_contributors` is
// set on it. A pull request opened by `github-actions[bot]` counts as one: on
// 2026-09-04 the doer opened PR #20 and its only run (33869905800) sat in
// `action_required` until a person pressed Approve. The merge gate requires
// green checks for the current head and rightly treats absence of a verdict as
// no verdict — so a run that never starts is a verdict that never arrives, and
// no doer PR can ever merge. The last step of an autonomous loop was a button.
//
// This releases that run, and only that run. It never touches the approval
// policy itself: that policy exists for strangers' forks, and weakening it for
// everyone in order to fix our own branch trades away somebody else's
// protection to buy ours.
//
// Three conditions, all of them required, none of them inferable by an outsider
// who does not already have write access here:
//
//   1. the branch is one of ours — `doer/*` or `journeyman/*`;
//   2. the run's head repository is THIS repository, never a fork;
//   3. an open pull request for that branch was opened by our bot.
//
// (3) is about the pull request's author, not the run's. After Codex pushes a
// fix the run's actor is `chatgpt-codex-connector[bot]`, and that run parks for
// the same reason — so keying on the run's actor would release the first run of
// a PR and park every round after it.

import { isDoerBranch } from "./eligibility.mjs";
import { isShadowBranch } from "./shadow.mjs";

/** The account the doer's pull requests are opened by. Named, never inferred. */
export const DOER_PR_AUTHOR = "github-actions[bot]";

/** What GitHub calls a run held for approval. */
export const PARKED_STATUS = "action_required";

/**
 * Is GitHub holding this run for a person?
 *
 * Not simply `status === "action_required"`, which is what the field is called
 * and what a reasonable reading of the docs suggests. The probe on 2026-09-04
 * manufactured a real parked run and GitHub reported it as
 * `status=completed, conclusion=action_required` — a finished run whose
 * conclusion is that somebody must act. Reading only `status` skipped it, and
 * the sweep would have released nothing while reporting success.
 *
 * The `?status=action_required` query filter does find such a run, which is why
 * the listing below still uses it: the API accepts a conclusion in that
 * parameter, and only the per-run field is confusing.
 */
export function isParked(run) {
  return run?.status === PARKED_STATUS || run?.conclusion === PARKED_STATUS;
}

/**
 * May this parked run be released without a person?
 *
 * Pure, because this is the one place in the loop that hands a public
 * repository's compute to code somebody else wrote, and a decision that cannot
 * be tested is a decision nobody should trust unattended.
 *
 * @param {object} args
 * @param {{id:number, status:string, conclusion:string|null, headBranch:string, headRepository:string}} args.run
 * @param {{headRef:string, headRepo:string, author:string}[]} args.prs open pull requests
 * @param {string} args.repo owner/name of this repository
 * @returns {{unpark:boolean, reason:string}}
 */
export function mayUnpark({ run, prs = [], repo }) {
  if (!isParked(run)) {
    return {
      unpark: false,
      reason: `not parked (status ${run?.status ?? "unknown"}, conclusion ${run?.conclusion ?? "none"})`,
    };
  }
  const branch = String(run.headBranch ?? "");

  // A fork's branch may be named anything at all, `doer/6-…` included. The head
  // repository is the part a stranger cannot forge.
  if (run.headRepository !== repo) {
    return { unpark: false, reason: `head is ${run.headRepository ?? "unknown"}, not ${repo} — a fork waits for a person` };
  }
  if (!isDoerBranch(branch) && !isShadowBranch(branch)) {
    return { unpark: false, reason: `${branch} is not one of our branches` };
  }

  // Write access to this repository is enough to push a `doer/*` branch, so the
  // prefix alone is not proof of authorship. The pull request's author is.
  const ours = prs.find(
    (p) => p.headRef === branch && p.headRepo === repo && p.author === DOER_PR_AUTHOR,
  );
  if (!ours) {
    return { unpark: false, reason: `no open pull request on ${branch} opened by ${DOER_PR_AUTHOR}` };
  }
  return { unpark: true, reason: `${branch} is ours — a pull request opened by ${DOER_PR_AUTHOR}` };
}

// ─── The impure half ─────────────────────────────────────────────────────────

/**
 * Release every parked run that belongs to us, and leave every other one alone.
 *
 * Takes its GitHub access as arguments so the decision above can be exercised
 * without a network, and so a failure to approve is reported rather than thrown:
 * an unreleased run is the state we were already in, not a reason to abandon a
 * shepherd tick that still has pull requests to drive.
 *
 * @returns {{released:number[], skipped:{id:number, reason:string}[], failed:{id:number, error:string}[]}}
 */
export function unparkOurRuns({ repo, gh, approve, say = console.log }) {
  const result = { released: [], skipped: [], failed: [] };

  let runs = [];
  try {
    runs = gh([
      "api", `repos/${repo}/actions/runs?status=${PARKED_STATUS}&per_page=50`,
      "--jq", "[.workflow_runs[] | {id, status, conclusion, headBranch: .head_branch, headRepository: .head_repository.full_name}]",
    ]) ?? [];
  } catch (err) {
    say(`[unpark] could not list parked runs: ${err.message.split("\n")[0]}`);
    return result;
  }
  if (runs.length === 0) return result;

  let prs = [];
  try {
    prs = gh([
      "api", `repos/${repo}/pulls?state=open&per_page=100`,
      "--jq", "[.[] | {headRef: .head.ref, headRepo: .head.repo.full_name, author: .user.login}]",
    ]) ?? [];
  } catch (err) {
    // Fail closed: without the pull requests, condition (3) cannot be checked,
    // and an unverifiable claim of ownership releases nothing.
    say(`[unpark] could not read open pull requests — releasing nothing: ${err.message.split("\n")[0]}`);
    return result;
  }

  for (const run of runs) {
    const { unpark, reason } = mayUnpark({ run, prs, repo });
    if (!unpark) {
      say(`[unpark] leaving run ${run.id} parked: ${reason}`);
      result.skipped.push({ id: run.id, reason });
      continue;
    }
    try {
      approve(run.id);
      say(`[unpark] released run ${run.id} on ${run.headBranch}: ${reason}`);
      result.released.push(run.id);
    } catch (err) {
      const error = err.message.split("\n").slice(0, 3).join(" ").trim();
      // Loud, and then on with the tick. If this is a permission GitHub does not
      // grant a workflow token, the whole loop stops at a button again — and the
      // one thing that must not happen is for it to stop there silently.
      say(`[unpark] FAILED to release run ${run.id} on ${run.headBranch}: ${error}`);
      result.failed.push({ id: run.id, error });
    }
  }
  return result;
}
