// GitHub issue #9 / CHE-108: a visitor had no way to see what a verdict looks
// like without handing over a link of their own. This is the one place that
// decides which public verdict stands in as the example.
//
// Requirements for the target:
//   - public and anonymous, so it opens without signing in;
//   - a product that is not ours (rule §6: never a CheckMyApp self-check);
//   - produced after the leak gate (src/lib/verdict-language.ts) existed, and
//     read once more by a person before it is linked here. The previous
//     target, run #18 of the same product from 2026-08-16, was retired for a
//     rule §1 leak in a journey step ("This needs a real-browser check.")
//     written before the gate.
//
// A clean run is an acceptable example. Rule §5: 0 findings is a valid, good
// run, and the journeys and the coverage note still show what a verdict
// contains. Findings are not a requirement.
//
// Current: theins.ru, run #143, "All good", 0 findings, completed
// 2026-09-04. Swap the path here and nowhere else.
export const EXAMPLE_VERDICT_PATH = "/verdict/cmtnf9n670003wh1rc9o2rild";
