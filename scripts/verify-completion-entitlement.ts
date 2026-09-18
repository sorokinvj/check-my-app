// CHE-283 verification: we speak about completion only where we reached it.
//
// The ticket was filed believing the derivation picked the wrong stage. It does
// not. The cause is upstream and simpler: **we frequently do not finish the
// journey.** Across runs #214, #215, #222, #223 and #225, eight of sixteen
// journeys had their FINAL step skipped —
//
//   Sign up for a new account             5 steps, 2 skipped   never finished
//   Log in and access the practice module 6 steps, 3 skipped   never finished
//   Practice with an AI interview coach   4 steps, 4 skipped   never finished
//   Connect integrations                  2 steps, 2 skipped   never finished
//
// — and those are the valuable ones. It is deliberate, not a defect: without
// test credentials a run checks read-only rather than creating records in a
// customer's product. Run #213's own feed says so.
//
// A trail that never performed the finishing action cannot contain the
// completion page. No stage-picking rule recovers a page nobody reached. So the
// rule is about entitlement rather than arithmetic:
//
//   a completion rate exists only for a journey whose walk finished it,
//   and the comparison with our estimate is reachable only through one.
//
// That is why `comparisonLine` takes a `TheirCompletion` and nothing else. The
// type IS the proof obligation — you cannot reach the sentence without first
// having constructed the thing that says the walk finished.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-completion-entitlement.ts

import {
  comparisonLine,
  completionOf,
  journeyPages,
  type JourneyPages,
} from "@/lib/journey-numbers";
import { hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

/** joblander's signup shape: entry, then the journey's own two pages. */
const SIGNUP: JourneyPages = journeyPages(
  [
    { stage: "/", count: 1690 },
    { stage: "/signup", count: 13 },
    { stage: "/login", count: 5 },
  ],
  "/",
);

console.log("\n— a completion rate is of the journey's own pages, not the app's traffic —\n");

{
  const c = completionOf(SIGNUP, 14);
  check("a completion exists for a two-page journey", c !== null);
  check("it counts from the journey's own first page, not the entry page",
    c?.sample === 13, String(c?.sample));
  check("…so the rate is 5 of 13, not 5 of 1,690",
    c?.conversion === 38, String(c?.conversion));
  check("it names both ends", c?.from === "/signup" && c?.to === "/login", `${c?.from} → ${c?.to}`);
}

{
  const onePage = journeyPages([{ stage: "/", count: 900 }, { stage: "/login", count: 50 }], "/");
  check("one own page is arrival, not conversion — no completion",
    completionOf(onePage, 14) === null, JSON.stringify(completionOf(onePage, 14)));

  const nobody = journeyPages(
    [{ stage: "/", count: 10 }, { stage: "/a", count: 0 }, { stage: "/b", count: 0 }],
    "/",
  );
  check("a rate out of zero is no rate", completionOf(nobody, 14) === null);
}

console.log("\n— the comparison cannot be reached without a completion —\n");

{
  const c = completionOf(SIGNUP, 14)!;
  const optimistic = comparisonLine({ price: 6, conversion: 65 }, c);
  check("we were optimistic and their users are not getting through → said plainly",
    optimistic !== null && /62% did not reach \/login/.test(optimistic), String(optimistic));
  check("…and it names the denominator it used", optimistic?.includes("13") === true, String(optimistic));
  check("…and never says the word finish about their users",
    optimistic !== null && !/finish/i.test(optimistic), String(optimistic));

  const pessimistic = comparisonLine({ price: 6, conversion: 5 }, c);
  check("we were pessimistic and they do better → also said",
    pessimistic !== null && /looked harder/.test(pessimistic), String(pessimistic));

  const agree = comparisonLine({ price: 6, conversion: 45 }, c);
  check("agreement on a struggling journey is worth a line",
    agree !== null && /agree/.test(agree), String(agree));

  const healthy = completionOf(
    journeyPages([{ stage: "/", count: 900 }, { stage: "/a", count: 100 }, { stage: "/b", count: 85 }], "/"),
    14,
  )!;
  check("agreement on a healthy journey says nothing",
    comparisonLine({ price: 6, conversion: 80 }, healthy) === null);

  check("no estimate of ours, no comparison",
    comparisonLine({ price: null, conversion: null }, c) === null);
}

console.log("\n— rule 1 on every sentence this can produce —\n");

{
  const c = completionOf(SIGNUP, 14)!;
  const all: string[] = [];
  for (const ourC of [0, 5, 45, 65, 95]) {
    const s = comparisonLine({ price: 6, conversion: ourC }, c);
    if (s) all.push(s);
  }
  check("there are sentences to check", all.length >= 3, String(all.length));
  check("none asks the customer to verify anything", !all.some(hasHomework), all.filter(hasHomework).join(" | "));
  check("none narrates how we check", !all.some(hasNarration), all.filter(hasNarration).join(" | "));
  check("none names a file, a cause or a fix",
    !all.some((s) => /\bfix\b|because|caused|should|\.tsx?\b|src\//i.test(s)), all.join(" | "));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
