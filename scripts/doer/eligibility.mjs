// Which ticket the doer may pick up, and when it may not pick up anything.
//
// The second half of the loop (design, 2026-09-02). CheckMyApp files tickets
// against itself; until now a human closed them, which is the builder grading
// its own work — the one thing rule §8 forbids. This is the half that does them.
//
// Pure on purpose: every rail below is a decision, and a decision that cannot be
// tested is a decision nobody can trust overnight. The workflow supplies facts
// (issues, open PRs, flags) and this file supplies the verdict. `verify:doer`
// runs it against the cases that motivated each rail.

/** Issues carrying this label are the doer's queue. Nothing else is. */
export const QUEUE_LABEL = "doer";
/** Set by a person on an issue to keep the doer away from it. */
export const HOLD_LABEL = "doer:hold";
/** Only with this may the dispatcher merge; default is propose-and-stop. */
// No automerge label any more. Merging is the default and doer:hold is the
// brake (owner, 2026-09-03): a loop whose normal state is "waiting for a
// person" is not a loop, and the owner already decided the work should
// happen when the ticket was filed.
/** Repository-wide stop. One label on one issue halts every tick. */
export const STOP_LABEL = "doer:stop";

// Nothing new may be built while nothing old has been judged. An open PR that
// nobody has ruled on is the queue's real bottleneck, and starting a second one
// converts a slow review into two slow reviews (design: "rails, each one paid
// for"). One at a time is not timidity — the queue is nine tickets long.
export const MAX_OPEN_PRS = 1;

/**
 * @param {object} state
 * @param {{number:number,title:string,labels:string[],createdAt:string}[]} state.issues open issues
 * @param {{number:number,headRef:string}[]} state.openDoerPrs PRs the doer already has out
 * @param {boolean} state.stopped repository-wide stop flag
 * @returns {{act:false,reason:string} | {act:true,issue:object,mayMerge:boolean}}
 */
export function decideTick(state) {
  const { issues = [], openDoerPrs = [], stopped = false } = state;

  // A stop the owner set outranks everything, including a queue on fire.
  if (stopped) return { act: false, reason: "stopped — a doer:stop label is set" };

  if (openDoerPrs.length >= MAX_OPEN_PRS) {
    const list = openDoerPrs.map((p) => `#${p.number}`).join(", ");
    // Named, not silent. "Nothing is happening" is not a state; "waiting on a
    // verdict for #12" is — it has an owner and something that would end it.
    return { act: false, reason: `waiting on a verdict for ${list} — one open PR at a time` };
  }

  const queue = issues
    .filter((i) => i.labels.includes(QUEUE_LABEL))
    .filter((i) => !i.labels.includes(HOLD_LABEL))
    // Oldest first: a ticket that keeps losing to newer ones never gets built,
    // and the queue silently becomes a stack.
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (queue.length === 0) return { act: false, reason: "queue empty — nothing labelled for the doer" };

  const issue = queue[0];
  return { act: true, issue, mayMerge: !issue.labels.includes(HOLD_LABEL) };
}

// A branch name that says where the work came from, and that the merge gate can
// recognise as the doer's own. Anything not matching this prefix is somebody
// else's branch and the dispatcher must not touch it.
export const BRANCH_PREFIX = "doer/";

export function branchFor(issueNumber, title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${BRANCH_PREFIX}${issueNumber}${slug ? `-${slug}` : ""}`;
}

// Merge is allowed only when every judge has spoken FOR THE CURRENT HEAD.
// "Still computing", "unreadable", and "went quiet" are not approvals — they are
// the absence of one, and merging on an unknown is how a gate sails into a
// change nobody reviewed.
/**
 * @param {object} v
 * @param {boolean} v.mayMerge the ticket is not on hold
 * @param {string} v.headSha the sha the verdicts must be about
 * @param {{name:string,conclusion:string|null,headSha:string}[]} v.checks
 * @param {{state:string,headSha:string}[]} v.reviews
 * @returns {{merge:boolean,reason:string}}
 */
export function decideMerge(v) {
  const { mayMerge, headSha, checks = [], reviews = [] } = v;
  if (!mayMerge) return { merge: false, reason: "on hold — this one waits for the owner" };

  const forHead = checks.filter((c) => c.headSha === headSha);
  if (forHead.length === 0) return { merge: false, reason: "no checks have reported for this head yet" };

  const unfinished = forHead.filter((c) => c.conclusion === null);
  if (unfinished.length) {
    return { merge: false, reason: `still running: ${unfinished.map((c) => c.name).join(", ")}` };
  }
  // A job that correctly did not need to run is not a failure. Our deploy job
  // reports "skipped" on every PR because it only deploys from main — reading
  // that as a failure would block every merge forever, which a live tick found
  // and the invented test cases did not. Everything else unknown still blocks:
  // cancelled, timed out and stale are absences of a verdict, not verdicts.
  const PASSING = new Set(["success", "neutral", "skipped"]);
  const failed = forHead.filter((c) => !PASSING.has(c.conclusion));
  if (failed.length) {
    return { merge: false, reason: `failing: ${failed.map((c) => c.name).join(", ")}` };
  }

  const approvals = reviews.filter((r) => r.headSha === headSha && r.state === "APPROVED");
  if (approvals.length === 0) {
    return { merge: false, reason: "no review approved this head — a verdict on an older push is not a verdict" };
  }
  return { merge: true, reason: "checks green and reviewed for this head" };
}
