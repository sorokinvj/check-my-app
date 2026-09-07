// The state machine that drives one pull request to a decision (CHE-122).
//
// Owner, 2026-09-02: a process whose only job is taking an open PR through
// review → fixes → review again, up to three rounds, and then deciding.
//
// Roles, and the reason they are separate:
//   doer      — Codex. Writes the code.
//   reviewer  — Claude. Judges the code. A different vendor on purpose: one
//               model that both writes and approves is the arrangement rule §8
//               exists to forbid, and it is why this product exists at all.
//   gate      — this machine. Merges when nothing objects. It holds no opinion,
//               because an opinion here would put judgement back where evidence
//               already suffices.
//   verifier  — a later CheckMyApp run walking the deployed product. The only
//               thing allowed to say the problem is gone.
//
// Written as a declared machine rather than a chain of ifs so the states are
// something you can read, draw and test, instead of something you infer.

import { createMachine, createActor } from "xstate";

/** Three rounds. After that the loop is not converging and a person should look. */
export const MAX_ROUNDS = 3;

/**
 * How long a claim may sit with nothing in it but the claim before the doer
 * takes it back (CHE-209).
 *
 * Six hours, which is three ticks of the dispatcher and long enough that an
 * implementer working normally has already committed something: the one time
 * the handoff worked end to end, the work landed sixteen minutes after the
 * mention. It is not longer because the cost of waiting is the whole queue —
 * one doer PR may be open at a time — and not shorter because a hiccup in the
 * implementer's queue should not cost a claim.
 *
 * The number lives here, alone, so that changing the patience of the loop is
 * one edit in one place rather than a search.
 */
export const CLAIM_EXPIRY_HOURS = 6;

// A check that ran and correctly did nothing is not a failure. Our deploy job
// reports "skipped" on every PR because it deploys from main only — found by a
// live tick, after invented test cases missed it. Everything else unknown still
// blocks: cancelled, timed_out and stale are absences of a verdict, not verdicts.
const PASSING = new Set(["success", "neutral", "skipped"]);

/**
 * Everything the machine is allowed to decide from. Deliberately small, and
 * every field is a fact read from GitHub rather than a phrase interpreted:
 * classifying on wording reads the vocabulary and misses the intent.
 *
 * @typedef {object} PrFacts
 * @property {string} headSha
 * @property {{name:string, conclusion:string|null, headSha:string}[]} checks
 * @property {boolean} reviewReportedForHead did a reviewer finish on THIS head
 * @property {number} unresolvedFindings open, non-outdated review threads
 * @property {number} roundsUsed fix rounds already spent on this PR
 * @property {boolean} mayMerge the owner opted this one in
 * @property {boolean} hasImplementerWork does the PR change anything outside .doer/
 */

export const prMachine = createMachine({
  id: "pr",
  initial: "judging",
  context: ({ input }) => ({ ...input }),
  states: {
    // Everything is decided in one pass over the facts; the named states are
    // the outcomes, so a tick is always a transition and never a mystery.
    judging: {
      always: [
        // Before anything else: is there work here at all? The dispatcher opens
        // the PR with one file — .doer/TICKET.md — and only then asks the
        // implementer. On that PR CI is green (nothing to break), a review is
        // clean (nothing to judge) and findings are zero, so every later guard
        // says yes and the gate would merge a claim that did nothing — closing
        // the ticket, because the PR body says "Closes #N". Codex reacted twice
        // on 2026-09-03 and published nothing both times, which is exactly the
        // shape that would have hit this.
        // …and if the implementer never came at all, the claim is withdrawn
        // rather than waited on forever (CHE-209). PR #36 sat for two days with
        // nothing in it but the claim, and because only one doer PR may be open
        // at a time, the queue behind it could not move — a loop that stops
        // permanently the first time an implementer does not show up is not a
        // loop. Order matters: this is checked before the wait it replaces.
        { target: "withdrawn", guard: "claimAbandoned" },
        { target: "waitingForImplementer", guard: "noWorkYet" },
        { target: "waitingForChecks", guard: "checksIncomplete" },
        { target: "fixing", guard: "checksFailedAndRoundsLeft" },
        { target: "blocked", guard: "checksFailed" },
        { target: "waitingForReview", guard: "noReviewYet" },
        { target: "fixing", guard: "findingsAndRoundsLeft" },
        { target: "blocked", guard: "findings" },
        { target: "merging", guard: "mayMerge" },
        { target: "awaitingOwner" },
      ],
    },
    // Named waits. "Nothing is happening" is not a state; "waiting on checks for
    // head abc" is — it has an owner and something that would end it.
    waitingForChecks: { type: "final" },
    waitingForReview: { type: "final" },
    /** The PR is still only the claim; the implementer has published nothing. */
    waitingForImplementer: { type: "final" },
    /** The claim was never answered and is taken back, so the queue can move. */
    withdrawn: { type: "final" },
    /** Hand back to the doer for another round. */
    fixing: { type: "final" },
    /** Three rounds spent, or a failure no round can fix. A person looks. */
    blocked: { type: "final" },
    /** Nothing objects and the owner allowed it. */
    merging: { type: "final" },
    /** Nothing objects, but merging was never opted in. */
    awaitingOwner: { type: "final" },
  },
}).provide({
  guards: {
    // Deliberately "changes a file outside .doer/", not "has a second commit":
    // the same signal gates the reviewer (claude-review.yml paths-ignore), so
    // the two halves cannot disagree about whether this PR contains work.
    noWorkYet: ({ context: c }) => c.hasImplementerWork !== true,
    // Nothing but the claim, and long enough that "not yet" has become "not at
    // all". Only the two facts, and neither is a judgement about the work:
    // there is none. A PR with an implementer's commit in it is never withdrawn
    // here no matter how old — judging work is the gate's job and the
    // reviewer's, never the clock's.
    claimAbandoned: ({ context: c }) =>
      c.hasImplementerWork !== true && Number(c.ageHours ?? 0) >= CLAIM_EXPIRY_HOURS,
    checksIncomplete: ({ context: c }) => {
      const forHead = c.checks.filter((x) => x.headSha === c.headSha);
      // No checks at all is not success — absence of a verdict is not a verdict.
      return forHead.length === 0 || forHead.some((x) => x.conclusion === null);
    },
    checksFailed: ({ context: c }) =>
      c.checks.some((x) => x.headSha === c.headSha && !PASSING.has(x.conclusion)),
    checksFailedAndRoundsLeft: ({ context: c }) =>
      c.checks.some((x) => x.headSha === c.headSha && !PASSING.has(x.conclusion)) &&
      c.roundsUsed < MAX_ROUNDS,
    // A review counts only when it COMPLETED for the current head. A verdict
    // about an earlier push was about a different diff.
    noReviewYet: ({ context: c }) => !c.reviewReportedForHead,
    findings: ({ context: c }) => c.unresolvedFindings > 0,
    findingsAndRoundsLeft: ({ context: c }) =>
      c.unresolvedFindings > 0 && c.roundsUsed < MAX_ROUNDS,
    mayMerge: ({ context: c }) => c.mayMerge === true,
  },
});

/**
 * Run the machine over one PR's facts and say what to do, in words a person can
 * read in the run log.
 * @param {PrFacts} facts
 * @returns {{state:string, reason:string}}
 */
export function decidePr(facts) {
  const actor = createActor(prMachine, { input: facts }).start();
  const state = String(actor.getSnapshot().value);
  actor.stop();

  const forHead = facts.checks.filter((x) => x.headSha === facts.headSha);
  const running = forHead.filter((x) => x.conclusion === null).map((x) => x.name);
  const failed = forHead.filter((x) => !PASSING.has(x.conclusion)).map((x) => x.name);

  const reason = {
    waitingForChecks: forHead.length
      ? `waiting on ${running.join(", ")} for head ${facts.headSha.slice(0, 7)}`
      : `no checks have reported for head ${facts.headSha.slice(0, 7)} yet`,
    waitingForImplementer: "the PR is still only the claim — the implementer has published nothing",
    withdrawn:
      `nothing but the claim after ${Math.round(Number(facts.ageHours ?? 0))}h — the implementer never came, ` +
      `so the claim is taken back and the queue moves on`,
    waitingForReview: `waiting for a review of head ${facts.headSha.slice(0, 7)}`,
    fixing: failed.length
      ? `round ${facts.roundsUsed + 1} of ${MAX_ROUNDS}: failing ${failed.join(", ")}`
      : `round ${facts.roundsUsed + 1} of ${MAX_ROUNDS}: ${facts.unresolvedFindings} unresolved finding(s)`,
    blocked: failed.length
      ? `${MAX_ROUNDS} rounds spent and ${failed.join(", ")} still failing — a person should look`
      : `${MAX_ROUNDS} rounds spent and ${facts.unresolvedFindings} finding(s) still unresolved — a person should look`,
    merging: "checks green and no unresolved findings for this head",
    awaitingOwner: "nothing objects, but this PR was not opted in for merging",
  }[state];

  return { state, reason };
}
