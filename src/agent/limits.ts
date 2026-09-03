// CHE-134 — walking limits. Pure: no browser, no model, no DB, so the numbers
// that decide how long a walk may run can be verified without a run.
//
// Walking is 69% of run cost, at 25–40 model calls per journey, and the cost is
// output-token dominated (COSTS.md, CHE-58 / CHE-131). Two of those calls are
// mechanical waste: the model keeps exploring after it has written the spec,
// and the iteration cap was a flat 50 whatever the journey's size — a 3-step
// journey could burn the same budget as an 8-step one.

import type { ProposedJourney } from "./discovery";

// The floor is what a short journey still needs: navigate, act, screenshot and
// report each step, then the spec and the summary. The ceiling is the previous
// flat cap, so no journey walks longer than it did before CHE-134.
export const WALK_ITERATIONS_MIN = 24;
export const WALK_ITERATIONS_MAX = 50;

// After write_e2e_test the walk gets this many more iterations: enough to
// delete a record it created and call record_deleted (CHE-90 needs both before
// the walk ends), then the summary — not enough to re-read the app.
export const WALK_WRAP_UP_ITERATIONS = 3;

// 12 fixed iterations (navigate, sign in, spec, summary, slack) plus 5 per
// discovered step (act, observe, screenshot, report, one retry), clamped.
// 1 step → 24, 3 → 27, 5 → 37, 8 → 50.
export function walkingIterationCap(stepCount: number): number {
  const steps = Number.isFinite(stepCount) && stepCount > 0 ? Math.floor(stepCount) : 0;
  const raw = 12 + 5 * steps;
  return Math.min(WALK_ITERATIONS_MAX, Math.max(WALK_ITERATIONS_MIN, raw));
}

// Words that appear in almost any "what I'm worried about" sentence and name
// nothing in the product. Anything shorter than 4 letters is dropped before
// this list is consulted.
const FOCUS_STOP_WORDS = new Set([
  "must",
  "work",
  "works",
  "working",
  "should",
  "would",
  "could",
  "will",
  "that",
  "this",
  "these",
  "those",
  "with",
  "without",
  "from",
  "have",
  "does",
  "done",
  "been",
  "being",
  "they",
  "them",
  "their",
  "there",
  "then",
  "than",
  "when",
  "what",
  "which",
  "where",
  "while",
  "also",
  "into",
  "onto",
  "only",
  "need",
  "needs",
  "make",
  "sure",
  "please",
  "check",
  "checks",
  "every",
  "each",
  "about",
  "after",
  "before",
  "some",
  "more",
  "most",
  "very",
  "like",
  "just",
  "over",
  "under",
  "such",
  "still",
  "well",
  "want",
  "really",
  "always",
  "never",
  "properly",
  "correctly",
  "fine",
  "okay",
  "broken",
  "bugs",
  "issue",
  "issues",
  "problem",
  "problems",
  "important",
  "priority",
  "focus",
  "especially",
  "verify",
  "test",
  "tests",
  "testing",
  "look",
  "looks",
  "thing",
  "things",
]);

export function focusKeywords(focusAreas: string | null | undefined): string[] {
  if (!focusAreas) return [];
  const seen = new Set<string>();
  for (const raw of focusAreas.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 4 || FOCUS_STOP_WORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

// Journeys that cover a focus keyword walk first, in their original relative
// order; the rest follow in theirs. So when a walk budget is cut — by the cap
// above, by a run's time limit, by a Workflow retry — the cut lands on the
// journeys the owner did not single out. Returns the same array when there is
// nothing to move, so a caller can rely on identity meaning "unchanged".
export function orderByFocus(
  journeys: ProposedJourney[],
  focusAreas: string | null | undefined,
): ProposedJourney[] {
  const keywords = focusKeywords(focusAreas);
  if (keywords.length === 0) return journeys;
  const covers = (j: ProposedJourney): boolean => {
    const text = `${j.title}\n${j.steps.join("\n")}`.toLowerCase();
    return keywords.some((k) => text.includes(k));
  };
  const first = journeys.filter(covers);
  if (first.length === 0 || first.length === journeys.length) return journeys;
  return [...first, ...journeys.filter((j) => !covers(j))];
}
