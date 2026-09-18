// CHE-279 verification: a measured number never claims to be the journey's
// completion rate.
//
// Found by dogfooding on 2026-09-17 (CHE-244), against real production data.
// The funnel we derive from a walk does not span the journey at either end:
//
//   Journey  "Log in to an existing account"  (joblander.app, run #209, status ok)
//   Walked   /  →  /login  →  /login  →  /login
//   Stored   / → /login
//   PostHog  / 1690  →  /login 50
//
// Stage 1 is where OUR WALK entered the app, so the denominator is everyone who
// arrived, whatever they came to do — 5 of 6 funnels on checkmyapp.dev begin at
// the same page, and 2 of 2 on joblander.app. The last stage is wherever the
// URL happened to sit when the walk ended: sign-in demonstrably worked, and the
// trail still ends on /login rather than on anything behind it.
//
// So "50 of 1690" is a true count of a path and a false answer to "how many
// people finish logging in". Rendered through CHE-240 it read:
//
//   Actually finished — 3% of 1,690 people, last 14 days
//   We expected most people to get through this. Your own numbers say 97% do
//   not finish it.
//
// about a login that works. That is rule 8's failure exactly — our incapacity
// sold as the customer's defect — and nothing fails on the way there: the
// funnel is well-formed, the query is right, the API answers, the number
// renders.
//
// Two mechanisms, because the wording alone would drift back:
//
//   1. no customer-facing string about a MEASURED number may say the people it
//      counted finished, completed or converted — we counted a path, and the
//      path is not the journey;
//   2. nothing may do arithmetic between our estimate and their measurement.
//      The two have different denominators, so any gap between them is an
//      artefact. This is structural: the guard reads the source.
//
// Both come back the day a funnel provably spans its journey. Neither is a
// statement that measuring is wrong — only that this measurement is not that
// number.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-measured-denominator.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { journeyPages, noMeasurementLine, pagesLine, type NoMeasurement } from "@/lib/journey-numbers";
import { movementOf, movementSentence, type MetricPoint } from "@/lib/metric-movement";
import { pathEndsOf } from "@/lib/posthog/measure";
import { hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const root = join(import.meta.dirname, "..");
function source(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

/**
 * Words that turn a count of a path into a claim about finishing.
 *
 * "finished" is the one that actually shipped. The rest are the same sentence
 * reached by a different route, which is how this would come back.
 */
const COMPLETION_WORDS = [
  "finish",
  "finished",
  "finishes",
  "complete",
  "completed",
  "completes",
  "completion",
  "convert",
  "converted",
  "conversion rate",
  "made it through",
  "got through",
  "drop off",
  "dropped off",
];

/** Every measured string the module can emit, across its whole range. */
function measuredStrings(): string[] {
  const out: string[] = [];
  const shapes = [
    [{ stage: "/", count: 1690 }, { stage: "/signup", count: 13 }, { stage: "/login", count: 5 }],
    [{ stage: "/", count: 1690 }, { stage: "/login", count: 50 }],
    [{ stage: "/login", count: 1 }, { stage: "/practice", count: 1 }],
    [{ stage: "/", count: 41234 }, { stage: "/x", count: 0 }],
  ];
  for (const stages of shapes) {
    const l = pagesLine(journeyPages(stages, "/"), 14);
    if (l) out.push(l.label, l.value, l.source);
  }
  return out;
}

console.log("\n— a measured number describes pages, not a finish —\n");

{
  const strings = measuredStrings();
  check("the module emits measured strings at all", strings.length > 0);

  for (const word of COMPLETION_WORDS) {
    const guilty = strings.filter((s) => s.toLowerCase().includes(word));
    check(
      `no measured string says "${word}"`,
      guilty.length === 0,
      guilty.slice(0, 2).join(" | "),
    );
  }
}

console.log("\n— every page the count refers to is named —\n");

{
  // A number with only one end named is the defect wearing a different label:
  // the reader still supplies "…of the journey" for the missing half. Counts
  // avoid that by construction — each one is attached to the page it counted.
  const line = pagesLine(
    journeyPages(
      [
        { stage: "/", count: 1690 },
        { stage: "/signup", count: 13 },
        { stage: "/login", count: 5 },
      ],
      "/",
    ),
    14,
  );
  check("a measured line exists", line !== null);
  check("it names the page people reached", line?.value.includes("/signup") === true, line?.value);
  check("it names where they went next", line?.value.includes("/login") === true, line?.value);
  check("it says how many people", line?.value.includes("13") === true, line?.value);
  check("it says the window", line?.value.includes("14 days") === true, line?.value);
  check("it is sourced to their analytics", line?.source === "your analytics", line?.source);

  // The entry page is the app's whole audience and drowns the journey.
  check("it does NOT lead with the entry page's crowd",
    line?.value.includes("1,690") === false, line?.value);
}

console.log("\n— no percentage is claimed for a journey —\n");

{
  const strings = measuredStrings();
  const withPercent = strings.filter((s) => s.includes("%"));
  check(
    "no measured string carries a percent sign at all",
    withPercent.length === 0,
    withPercent.join(" | "),
  );
  check(
    "journey-numbers exports no line that takes a conversion rate",
    !/TheirMeasurement/.test(
      readFileSync(join(import.meta.dirname, "..", "src/lib/journey-numbers.ts"), "utf8"),
    ),
  );
}

console.log("\n— the alert sentence describes a path too, and it is the one that is emailed —\n");

{
  // A real fall: 40% → 15% over enough people to be significant and material.
  const day = (n: number) => new Date(2026, 8, n);
  const history: MetricPoint[] = [
    { conversion: 40, sampleSize: 400, measuredAt: day(1) },
    { conversion: 41, sampleSize: 400, measuredAt: day(4) },
    { conversion: 39, sampleSize: 400, measuredAt: day(7) },
    { conversion: 15, sampleSize: 400, measuredAt: day(10) },
  ];
  // Newest first, the order the caller reads them in.
  const movement = movementOf([...history].reverse());
  const sentence = movementSentence("Sign up / create a new account", movement, {
    from: "/",
    to: "/signup",
  });

  check("a real fall still produces an alert", typeof sentence === "string", String(sentence));
  for (const word of COMPLETION_WORDS) {
    check(
      `the alert never says "${word}"`,
      !(sentence ?? "").toLowerCase().includes(word),
      sentence ?? "",
    );
  }
  check("it names both ends of what moved", /\/signup/.test(sentence ?? ""), sentence ?? "");
  check("it still carries the size of the move", /points? down/.test(sentence ?? ""), sentence ?? "");
  check("it counts its own unit correctly", !/\b1 points\b/.test(sentence ?? ""), sentence ?? "");
  check("no homework in the emailed sentence", !hasHomework(sentence ?? ""));
  check("no narration in the emailed sentence", !hasNarration(sentence ?? ""));
}

{
  // The gate: a point whose path cannot be read sends nothing rather than a
  // sentence that gets read as "fewer people finish this journey".
  check("unreadable steps yield no path", pathEndsOf("not json") === null);
  check("a one-stage path is no path", pathEndsOf(JSON.stringify([{ stage: "/only", count: 9 }])) === null);
  check("absent steps yield no path", pathEndsOf(null) === null);
  const ok = pathEndsOf(
    JSON.stringify([
      { stage: "/", count: 1690 },
      { stage: "/signup", count: 13 },
      { stage: "/login", count: 5 },
    ]),
  );
  check("a real stored path reads its two ends", ok?.from === "/" && ok?.to === "/login", JSON.stringify(ok));
}

console.log("\n— a comparison is reachable only from a finished walk —\n");

{
  // This section used to assert that NO comparison existed anywhere. CHE-279
  // removed it because the two numbers had different denominators: our estimate
  // counts people who set out to do the journey, the measurement counted
  // everyone who reached the app's front door.
  //
  // CHE-283 restored it under the condition that makes it true, and changing
  // this guard was part of that ticket's own acceptance criteria — "updated
  // deliberately as part of that change, not worked around". So what is
  // asserted now is not absence but REACHABILITY: a comparison must be
  // impossible to obtain without first proving the walk finished.
  const numbers = source("src/lib/journey-numbers.ts");
  const block = source("src/components/journey-numbers-block.tsx");

  check(
    "the comparison takes a completion, never a bare measurement",
    /export function comparisonLine\(ours: OurJudgement, theirs: TheirCompletion\)/.test(numbers),
    "its only entry point must be the type that encodes the entitlement",
  );
  check(
    "a completion cannot be built from pages alone without the caller deciding",
    /export function completionOf\(/.test(numbers),
  );
  check(
    "the block gates the comparison on the walk having finished",
    /walkFinished \? completionOf/.test(block),
    "no other path may reach comparisonLine",
  );
  check(
    "…and reaches comparisonLine only through that completion",
    /comparisonLine\(ours, completion\)/.test(block) && /completion \? comparisonLine/.test(block),
  );
  check(
    "the pages line itself still claims no completion",
    !/finish/i.test(numbers.slice(numbers.indexOf("export function pagesLine"), numbers.indexOf("export function journeyPages"))),
  );
}

console.log("\n— rule 1 still holds on everything above —\n");

{
  const reasons: NoMeasurement[] = ["not_connected", "no_funnel", "not_measured_yet", "below_floor"];
  const all = [...measuredStrings(), ...reasons.map((r) => noMeasurementLine(r)), noMeasurementLine("below_floor", 25)];
  for (const s of all) {
    if (hasHomework(s)) check(`no homework: "${s}"`, false);
    if (hasNarration(s)) check(`no narration: "${s}"`, false);
  }
  check(`${all.length} customer-facing strings carry no leak`, true);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
