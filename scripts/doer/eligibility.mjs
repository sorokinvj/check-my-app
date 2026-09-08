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

// Two labels used to live here: `doer` marked an issue as the queue, and
// `doer:hold` kept the doer away from one. Both are gone as of CHE-118, and
// neither was replaced by an equivalent, so here is where each went.
//
// The queue is no longer a label on a GitHub issue: it is the open tickets our
// own runs filed, read from our database and admitted per capability
// (scripts/doer/board-queue.ts, scripts/doer/queue.mjs). Marking an issue by
// hand cannot summon the doer any more, which is the point — a queue a person
// fills by hand is what CHE-170 found and what this replaced.
//
// The hold split in two. As a queue filter it is gone: a ticket that should
// wait is moved out of `open` on the board and leaves the queue by itself. As a
// brake on a pull request already open it stays exactly where it was — the
// shepherd reads it off the PR to keep the merge gate shut (shepherd.mjs), and
// that brake must stay reachable by a person who is looking at the PR and has no
// reason to go near the board.
/** Set by a person on a doer pull request to keep the merge gate shut. */
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
 * How many unanswered claims a ticket may collect before it lets the queue move
 * past it (CHE-211).
 *
 * Two, because one withdrawal is an incident and two in a row is a pattern: the
 * implementer is not coming for this ticket today, and trying it a third time
 * costs another branch, another pull request and another set of CI minutes to
 * learn the same thing. It is not one, because a single failure can be a
 * hiccup in the implementer's own queue and a ticket should not be set aside
 * for that.
 */
export const MAX_WITHDRAWN_CLAIMS = 2;

/**
 * Whether to claim anything this tick, and which ticket.
 *
 * The queue arrives already built and already filtered: it is the open tickets
 * our own runs filed, admitted per capability by scripts/doer/queue.mjs and read
 * from our database by scripts/doer/board-queue.ts (CHE-118). What used to be
 * done here by a GitHub label is now done at the source, so this function is
 * left with the two rails that were always the point.
 *
 * The per-ticket hold that `doer:hold` used to provide has a better home now:
 * a ticket that should wait is moved out of `open` on the board, and it stops
 * being in the queue at all. Said out loud rather than dropped quietly, because
 * removing a brake in silence is how a brake turns out to be missing later.
 *
 * @param {object} state
 * @param {{ticket:string,label:string,createdAt:string}[]} state.queue admitted tickets, oldest first
 * @param {{number:number,headRef:string}[]} state.openDoerPrs PRs the doer already has out
 * @param {boolean} state.stopped repository-wide stop flag
 * @returns {{act:false,reason:string} | {act:true,item:object,mayMerge:boolean}}
 */
export function decideTick(state) {
  const { queue = [], openDoerPrs = [], stopped = false, withdrawnByTicket = {} } = state;

  // A stop the owner set outranks everything, including a queue on fire.
  if (stopped) return { act: false, reason: "stopped — a doer:stop label is set" };

  if (openDoerPrs.length >= MAX_OPEN_PRS) {
    const list = openDoerPrs.map((p) => `#${p.number}`).join(", ");
    // Named, not silent. "Nothing is happening" is not a state; "waiting on a
    // verdict for #12" is — it has an owner and something that would end it.
    return { act: false, reason: `waiting on a verdict for ${list} — one open PR at a time` };
  }

  // Oldest first: a ticket that keeps losing to newer ones never gets built, and
  // the queue silently becomes a stack. The reader sorts, and this re-sorts
  // rather than trusting it — the rail is here, where it is tested.
  const ordered = [...queue].sort((a, b) =>
    String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
  );

  if (ordered.length === 0) {
    return { act: false, reason: "queue empty — no open ticket of ours is admitted work" };
  }

  // A ticket whose claims keep coming back unanswered steps aside for the next
  // one (CHE-211). Without this the loop is a treadmill: the queue hands over
  // the oldest ticket, the implementer does not come, the claim is withdrawn
  // (CHE-209), and the next tick picks the same ticket for ever — CHE-96 was
  // claimed twice in twelve hours and the second admitted ticket was never
  // going to be reached. Motion that produces nothing is the thing the loop is
  // least allowed to look like.
  //
  // Stepping aside is not a verdict on the ticket: it stays open, untouched,
  // and comes back the moment an implementer can deliver (CHE-165, CHE-196).
  const fresh = [];
  const exhausted = [];
  for (const t of ordered) {
    const n = Number(withdrawnByTicket?.[t.ticket] ?? 0);
    (n >= MAX_WITHDRAWN_CLAIMS ? exhausted : fresh).push({ ...t, withdrawn: n });
  }

  if (fresh.length === 0) {
    const list = exhausted.map((t) => `${t.ticket} (${t.withdrawn}×)`).join(", ");
    return {
      act: false,
      reason:
        `every admitted ticket has had its claims withdrawn unanswered — ${list}. ` +
        `The queue is not empty and nothing is wrong with it: no implementer is delivering.`,
    };
  }

  return { act: true, item: fresh[0], mayMerge: true, steppedAside: exhausted };
}

// A branch name that says where the work came from, and that the merge gate can
// recognise as the doer's own. Anything not matching this prefix is somebody
// else's branch and the dispatcher must not touch it.
export const BRANCH_PREFIX = "doer/";

/**
 * A branch this dispatcher owns. Everything else — including the second
 * implementer's `journeyman/*` (CHE-128) — is somebody else's work, and the two
 * rails below are the only reason a shadow PR is safe to open at all.
 *
 * Exported rather than written inline twice because the shadow design rests on
 * both, and an invariant nobody can test is a comment.
 */
export function isDoerBranch(ref) {
  return String(ref ?? "").startsWith(BRANCH_PREFIX);
}

/**
 * A PR the merge gate may consider. A draft is a proposal, not a candidate, and
 * the shadow run publishes drafts deliberately.
 */
export function isMergeCandidate(pr) {
  return isDoerBranch(pr?.headRefName) && pr?.isDraft !== true;
}

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
