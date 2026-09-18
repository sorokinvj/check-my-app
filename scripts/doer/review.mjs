// The reviewer's side of the loop: Codex (owner, 2026-09-18).
//
// Mender writes, Codex reviews, the machine merges. A different vendor on
// purpose — one model that both writes and approves is the arrangement rule §8
// exists to forbid. Until now the reviewer was a Claude workflow, disabled on
// 2026-09-14 because it reviewed every pull request in the repository rather
// than the doer's.
//
// Codex is asked by a comment, and answers only an identity linked to a ChatGPT
// account (CHE-155: the same words from github-actions[bot] got no answer for
// an hour; from the owner's identity, an answer in eight minutes). So the
// shepherd asks with the owner's token, and only when it has to.
//
// Two facts decide whether it has to, both read from GitHub rather than
// inferred: has the reviewer finished on THIS head, and has it already been
// asked about this head. Everything here is pure; the shepherd supplies the
// facts.

/** The account Codex reviews as. Named, never inferred. */
export const REVIEWER_LOGIN = "chatgpt-codex-connector[bot]";

/** The marker Codex puts in the one comment it keeps editing with its status. */
export const CODEX_SUMMARY_MARKER = "codex-pull-request-review-summary";

/** What the shepherd writes to ask. Codex's docs name exactly this phrase. */
export const REVIEW_REQUEST = "@codex review";

/**
 * What Codex's summary comment says about a head.
 *
 * A review with findings leaves a formal review and inline comments, each
 * carrying the commit sha — the shepherd already reads those. A review with
 * NO findings leaves neither: it edits its summary comment to "Completed" for
 * that commit and reacts 👍. Read that table, or a clean review is invisible
 * and the gate waits forever for a verdict it was given (the same shape as
 * 2026-09-03, when a clean Claude review was a plain comment).
 *
 * Measured on #149, 2026-09-18: the row reads
 *   | 📝 **Code Review** | ✅ **Completed** … | `ffd1f1c` | Manual request |
 * and while running, "🔄 **Running**" in the same column.
 *
 * @returns {"completed"|"running"|null}
 */
export function codexSummaryState(body, headSha) {
  const text = String(body ?? "");
  if (!text.includes(CODEX_SUMMARY_MARKER)) return null;
  const short = String(headSha ?? "").slice(0, 7);
  if (!short) return null;
  for (const line of text.split("\n")) {
    if (!line.includes(`\`${short}\``)) continue;
    if (/Completed/i.test(line)) return "completed";
    if (/Running/i.test(line)) return "running";
  }
  return null;
}

/**
 * Should the shepherd ask Codex to review this head now?
 *
 * Not when a verdict already exists, not while a review is running, not when
 * we already asked about this head, and not in the first minutes after a push
 * — Codex reviews a pull request opened for review on its own, and asking
 * again buys a second review of the same diff.
 *
 * @param {object} f
 * @param {boolean} f.verdictForHead a formal review, inline comment or completed summary for this head
 * @param {"completed"|"running"|null} f.summaryState
 * @param {boolean} f.askedSinceHead an "@codex review" comment newer than the head commit
 * @param {number} f.headAgeMinutes
 * @param {number} [f.graceMinutes]
 * @returns {{ask:boolean, reason:string}}
 */
export function reviewRequestNeeded({ verdictForHead, summaryState, askedSinceHead, headAgeMinutes, graceMinutes = 10 }) {
  if (verdictForHead) return { ask: false, reason: "the reviewer has already spoken for this head" };
  if (summaryState === "running") return { ask: false, reason: "a review of this head is running" };
  if (askedSinceHead) return { ask: false, reason: "already asked about this head — waiting for the answer" };
  if (Number(headAgeMinutes ?? 0) < graceMinutes) {
    return { ask: false, reason: `head is ${Math.round(headAgeMinutes)} min old — giving the automatic review time to start` };
  }
  return { ask: true, reason: "no verdict, no review running, nobody has asked — asking" };
}

/**
 * Has anyone asked for a review of this head? A request older than the head
 * was about a different diff.
 *
 * @param {{body:string, createdAt:string}[]} comments
 * @param {string} headAt ISO time of the head commit
 */
export function askedSinceHead(comments = [], headAt) {
  const at = Date.parse(headAt);
  if (!Number.isFinite(at)) return false;
  return comments.some(
    (c) => String(c.body ?? "").toLowerCase().includes(REVIEW_REQUEST) && Date.parse(c.createdAt) > at,
  );
}
