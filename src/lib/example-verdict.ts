// GitHub issue #9 / CHE-108: a visitor had no way to see what a verdict looks
// like without handing over a link of their own. This is the one place that
// decides which public verdict stands in as the example.
//
// Requirements for the target (rule §6: never a CheckMyApp self-check):
//   - public and anonymous, so it opens without signing in;
//   - a product that is not ours;
//   - a mixed result — some findings, not a flawless run — so the page shows
//     what a verdict actually contains.
//
// Current: joblander.app (from prisma/seed.ts), "Mostly OK", 4 findings,
// 3 journeys. Swap the path here and nowhere else.
export const EXAMPLE_VERDICT_PATH = "/verdict/demo-verdict";
