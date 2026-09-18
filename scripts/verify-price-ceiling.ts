// CHE-282 verification: the price is answerable to the walk that produced it.
//
// On 2026-09-17 a live verdict page said, about checkmyapp.dev's own core flow:
//
//   Effort            100 actions to finish   · our estimate
//   Likely to finish  100 of 100              · our estimate
//
// The flow is about three actions. Its sibling journeys are priced 1 to 5. The
// bound that should have caught it was a constant set to 200, so it passed —
// and `verify-journey-metrics.ts` had a green case named "out-of-range values
// are clamped, not thrown away", which made the area read as covered.
//
// A guard wide enough never to fire is indistinguishable from no guard.
//
// ── Why a constant cannot be the answer ──────────────────────────────────────
//
// `price` is a MODEL JUDGEMENT, not a count. The prompt asks the model to count
// what a person does on the shortest path and explicitly excludes our own
// detours, so nothing anywhere counts actions and compares. A number no
// mechanism can contradict will eventually be wrong in a way nobody notices.
//
// So the bound is a function of something observed: the steps this journey's own
// past walks recorded. A journey whose walks record five steps does not cost a
// hundred user actions, and that can be checked without knowing the product.
//
// The factor comes from production, not from taste. Across every priced journey
// on the board, price ÷ steps-per-walk ran:
//
//   Sign up via the free pricing CTA      5 / 3.0  = 1.7   ← the highest real one
//   Practice with an AI interview coach   7 / 4.9  = 1.4
//   Sign up / create an account           6 / 4.8  = 1.25
//   Log in to an existing account         5 / 4.9  = 1.0
//   Submit a URL for a free check         3 / 4.5  = 0.67
//   Sign in / OAuth through Clerk         1 / 8.0  = 0.13
//   Guest checks an app by URL          100 / 5.0  = 20    ← the absurd one
//
// Four sits five times above every real value and five times below the absurd
// one. There is no factor that separates them more cleanly.
//
// ── The second half: a wrong number that nothing can dislodge ────────────────
//
// Refusing the proposed value is not enough. The 100 was already stored, and
// every later run refused a new value and left the old one standing — which is
// exactly how it survived. So a stored price that fails the same test is
// cleared. An unpriced journey says "we have not priced this yet", which is
// true; a stored 100 says something false about the customer's product.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-price-ceiling.ts

import {
  ACTIONS_PER_STEP,
  METRIC_BOUNDS,
  MIN_PRICE_CEILING,
  decideMetric,
  priceCeiling,
} from "@/agent/journey-metrics";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const NOTE = "the signup form grew a confirmation step since the last check";

/** Every priced journey on the board on 2026-09-18, with what its walks record. */
const REAL: Array<{ title: string; price: number; steps: number }> = [
  { title: "Guest checks an app by URL", price: 100, steps: 5.0 },
  { title: "Practice with an AI interview coach", price: 7, steps: 4.9 },
  { title: "Sign up / create an account", price: 6, steps: 4.8 },
  { title: "Log in to an existing account", price: 5, steps: 4.9 },
  { title: "Sign up via the free pricing CTA", price: 5, steps: 3.0 },
  { title: "Submit a URL for a free check", price: 3, steps: 4.5 },
  { title: "Review a verdict and report a finding", price: 3, steps: 4.0 },
  { title: "Check a website anonymously", price: 3, steps: 5.0 },
  { title: "Enable daily monitoring from a verdict", price: 2, steps: 3.0 },
  { title: "Discover Product & Install Extension", price: 1, steps: 5.3 },
  { title: "Browse today's public checks", price: 1, steps: 4.6 },
  { title: "Sign in / OAuth through Clerk", price: 1, steps: 8.0 },
];

console.log("\n— the ceiling admits every real price and refuses the absurd one —\n");

for (const j of REAL) {
  const allowed = j.price <= priceCeiling(j.steps);
  const shouldBeAllowed = j.price !== 100;
  check(
    `${shouldBeAllowed ? "admits" : "REFUSES"} ${j.price} actions over ~${j.steps} steps — ${j.title}`,
    allowed === shouldBeAllowed,
    `ceiling ${priceCeiling(j.steps)}`,
  );
}

console.log("\n— the ceiling itself —\n");

check("a journey never walked falls back to the blunt constant",
  priceCeiling(null) === METRIC_BOUNDS.maxPrice, String(priceCeiling(null)));
check("…and so does one with no recorded steps",
  priceCeiling(0) === METRIC_BOUNDS.maxPrice, String(priceCeiling(0)));
check("a very short walk does not imply a very cheap journey",
  priceCeiling(1) === MIN_PRICE_CEILING, String(priceCeiling(1)));
check("past that, the ceiling follows the walk",
  priceCeiling(10) === 10 * ACTIONS_PER_STEP, String(priceCeiling(10)));
check("the factor leaves the highest real ratio a wide margin",
  ACTIONS_PER_STEP >= 2 * 1.7, `factor ${ACTIONS_PER_STEP} vs real max 1.7`);

console.log("\n— a refused price does not become the customer's number —\n");

{
  const d = decideMetric({ price: 100, conversion: 100, note: NOTE }, null, 5);
  check("an unsupportable first value is refused", d.value === null, JSON.stringify(d.value));
  check("…and marked unpriced, so it lands on our board", d.unpriced === true);
  check("…and the reason names the evidence, not a constant",
    /walks record/.test(d.reason) && /at most 20/.test(d.reason), d.reason);
}

console.log("\n— a stored number its own walks cannot support is cleared —\n");

{
  const stored = { price: 100, conversion: 100, note: NOTE };
  const d = decideMetric({ price: 90, conversion: 100, note: NOTE }, stored, 5);
  check("the stored value is not kept", d.kept === false, JSON.stringify(d));
  check("…it is cleared", d.clears === true);
  check("…and nothing is written in its place", d.value === null, JSON.stringify(d.value));
  check("…and the reason says the stored one failed too",
    /stored 100 fails the same test/.test(d.reason), d.reason);
}

{
  // The ordinary case must be untouched: a supportable stored value stands when
  // a new one is refused for any reason.
  const stored = { price: 6, conversion: 65, note: NOTE };
  const d = decideMetric({ price: 99, conversion: 50, note: NOTE }, stored, 5);
  check("a supportable stored value still stands", d.kept === true && d.value === stored, JSON.stringify(d.value));
  check("…and is not cleared", !d.clears);
}

console.log("\n— nothing else about the decision changed —\n");

{
  const d = decideMetric({ price: 6, conversion: 65, note: NOTE }, null, 5);
  check("a plausible value is taken", d.value?.price === 6 && d.value?.conversion === 65, JSON.stringify(d.value));

  const zero = decideMetric({ price: 0, conversion: 0, note: NOTE }, null, 5);
  check("zero is still refused as a non-answer", zero.value === null && zero.unpriced === true);

  const noNote = decideMetric({ price: 8, conversion: 40, note: "x" }, { price: 6, conversion: 65, note: NOTE }, 5);
  check("a changed number with no named reason is still refused",
    noNote.kept === true, JSON.stringify(noNote));

  const unwalked = decideMetric({ price: 30, conversion: 50, note: NOTE }, null, null);
  check("a journey never walked is still priced — one run of blunt bound",
    unwalked.value?.price === 30, JSON.stringify(unwalked.value));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
