// CHE-241 verification: a metric that moved, not one that wobbled.
//
// The expensive failure here is the FALSE POSITIVE. An alert that fires on
// noise teaches the owner to ignore the channel, and then the one that matters
// arrives somewhere nobody reads — CHE-109 is the same lesson in a different
// column. So most of this file is about cases that must produce silence.
//
// The numbers below are not decorative. Each one is a case where a naive
// implementation — "did it drop more than five points?" — gets it wrong:
//
//   40% of 50  →  32% of 50    an eight-point "drop" a coin could produce
//   40% of 5000 → 39.6% of 5000  statistically certain, worth nobody's morning
//   40% of 2000 → 28% of 1800    real, large, and the email worth sending
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-metric-movement.ts

import {
  MATERIAL_POINTS,
  MIN_BASELINE_POINTS,
  Z_95,
  baselineOf,
  isAlertable,
  movementOf,
  movementSentence,
  zScore,
  type MetricPoint,
} from "@/lib/metric-movement";
import { hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

/** The two pages a count was taken between. Every sentence names them (CHE-279). */
const PATH = { from: "/cart", to: "/thanks" } as const;

/** Points newest first, as CHE-239 stores them. */
const pts = (...rows: Array<[number | null, number]>): MetricPoint[] =>
  rows.map(([conversion, sampleSize], i) => ({
    conversion,
    sampleSize,
    measuredAt: new Date(Date.now() - i * 86400000),
  }));

function main() {
  console.log("The baseline is the journey's own history, and excludes today");
  {
    const p = pts([28, 1800], [40, 2000], [41, 2000], [39, 2000]);
    const b = baselineOf(p);
    check("the newest point is NOT in its own baseline",
      b !== null && Math.abs(b.conversion - 40) < 0.5, JSON.stringify(b));
    check("…which is the whole point: including it would hide the drop",
      b !== null && b.conversion > 35);
    check("the baseline pools people, not percentages",
      b !== null && b.sample === 6000, String(b?.sample));

    // A quiet week must not shout as loudly as a busy one.
    const lopsided = baselineOf(pts([50, 100], [10, 10], [50, 1000], [50, 1000], [50, 1000]));
    check("a 10-person week does not drag the baseline around",
      lopsided !== null && lopsided.conversion > 45, JSON.stringify(lopsided));

    check("too little history is no baseline at all",
      baselineOf(pts([40, 500], [40, 500], [40, 500])) === null);
    check("…and the floor is a stated number", MIN_BASELINE_POINTS >= 2, String(MIN_BASELINE_POINTS));
    check("unmeasured points do not count toward history",
      baselineOf(pts([40, 500], [null, 12], [null, 9], [null, 14], [40, 500])) === null);
  }

  console.log("\nThe z-test, because two proportions differ by chance all the time");
  {
    check("identical proportions give z = 0", zScore({ conversion: 40, sample: 100 }, { conversion: 40, sample: 100 }) === 0);
    check("a drop is negative",
      zScore({ conversion: 40, sample: 2000 }, { conversion: 28, sample: 1800 }) < 0);
    check("a rise is positive",
      zScore({ conversion: 28, sample: 1800 }, { conversion: 40, sample: 2000 }) > 0);

    // The same 8-point difference, at two sample sizes. This is the entire idea.
    const small = Math.abs(zScore({ conversion: 40, sample: 50 }, { conversion: 32, sample: 50 }));
    const large = Math.abs(zScore({ conversion: 40, sample: 5000 }, { conversion: 32, sample: 5000 }));
    check("8 points on 50 people is inside the noise", small < Z_95, small.toFixed(2));
    check("…the same 8 points on 5,000 people is not", large > Z_95, large.toFixed(2));
    check("…and the bigger sample gives the bigger statistic", large > small);

    check("nobody converting in either sample is not a movement",
      zScore({ conversion: 0, sample: 500 }, { conversion: 0, sample: 500 }) === 0);
    check("everybody converting in both is not a movement",
      zScore({ conversion: 100, sample: 500 }, { conversion: 100, sample: 500 }) === 0);
    check("an empty sample cannot move anything",
      zScore({ conversion: 40, sample: 0 }, { conversion: 90, sample: 10 }) === 0);
  }

  console.log("\nSilence: every case that must NOT produce an alert");
  {
    // A coin could produce this. The naive "dropped 8 points" check would fire.
    const wobble = movementOf(pts([32, 50], [40, 50], [40, 50], [40, 50], [40, 50]));
    check("an 8-point drop on 50 people is noise, not news",
      wobble.kind === "noise", `${wobble.kind} z=${"z" in wobble ? wobble.z.toFixed(2) : "-"}`);
    check("…and produces no sentence", movementSentence("Checkout", wobble, PATH) === null);
    check("…and is not alertable", !isAlertable(wobble));

    // Statistically certain and completely uninteresting.
    const tiny = movementOf(pts([39.6, 5000], [40, 5000], [40, 5000], [40, 5000], [40, 5000]));
    check("a fraction of a point on huge samples is immaterial, however certain",
      tiny.kind === "immaterial" || tiny.kind === "noise", `${tiny.kind}`);
    check("…and produces no sentence", movementSentence("Checkout", tiny, PATH) === null);

    const noHistory = movementOf(pts([12, 900], [40, 900]));
    check("two points is not a history", noHistory.kind === "no_baseline");
    check("no points at all is not a history", movementOf([]).kind === "no_baseline");
    check("a journey never measured has nothing to compare",
      movementOf(pts([null, 4], [null, 3], [null, 8], [null, 2])).kind === "no_baseline");

    check("the material threshold is a stated number", MATERIAL_POINTS >= 1, String(MATERIAL_POINTS));
  }

  console.log("\nThe alert worth sending");
  {
    const fell = movementOf(pts([28, 1800], [40, 2000], [41, 2000], [39, 2000]));
    check("a real, large fall is reported", fell.kind === "fell", `${fell.kind}`);
    check("…and it is alertable", isAlertable(fell));
    const sentence = movementSentence("Sign up and reach the dashboard", fell, PATH);
    check("…and the sentence names the journey", sentence?.includes("Sign up and reach the dashboard") === true, String(sentence));
    check("…the movement", sentence?.includes("12 points down") === true, String(sentence));
    check("…what it moved from", sentence?.includes("40%") === true, String(sentence));
    check("…and the sample it rests on", sentence?.includes("1,800") === true, String(sentence));
  }

  console.log("\nA rise is good news, and good news does not need a siren");
  {
    const rose = movementOf(pts([52, 2000], [40, 2000], [39, 2000], [41, 2000]));
    check("a real, large rise is recognised", rose.kind === "rose", `${rose.kind}`);
    check("…it gets a sentence", movementSentence("Checkout", rose, PATH) !== null);
    check("…but it is NOT alertable — direction is not symmetric in tone", !isAlertable(rose));
    const s = movementSentence("Checkout", rose, PATH) ?? "";
    check("…and the sentence does not sound like a warning",
      !/down|worse|fewer|problem|alert/i.test(s), s);
  }

  console.log("\nRule 1: the owner reads these");
  {
    const cases: string[] = [];
    for (const p of [
      pts([28, 1800], [40, 2000], [41, 2000], [39, 2000]),
      pts([52, 2000], [40, 2000], [39, 2000], [41, 2000]),
      pts([0, 900], [40, 2000], [41, 2000], [39, 2000]),
      pts([100, 900], [40, 2000], [41, 2000], [39, 2000]),
    ]) {
      const s = movementSentence("Sign up", movementOf(p), PATH);
      if (s) cases.push(s);
    }
    check("there are sentences to check", cases.length >= 3, String(cases.length));
    check("none asks the customer to verify anything", !cases.some((s) => hasHomework(s)), cases.filter(hasHomework).join(" | "));
    check("none narrates how we check", !cases.some((s) => hasNarration(s)), cases.filter(hasNarration).join(" | "));
    check("none mentions our machinery",
      !cases.some((s) => /\b(browser|headless|we walked|our check|crawl|test run)\b/i.test(s)), cases.join(" | "));
    // This check used to require the opposite: that every sentence said
    // "finishing for fewer/more people". It asserted the claim CHE-279 removed
    // — the count is of people moving between two pages, and the first of those
    // is where our walk entered the app, so "finishing" is not what was
    // counted. The check moves because it was wrong, not because the wording
    // became inconvenient.
    check("every sentence is about the customer's users moving between two named pages",
      cases.every((s) => /getting from \S+ to \S+/i.test(s)), cases.join(" | "));
    check("…and none of them claims those people finished the journey",
      !cases.some((s) => /finish|complete|convert/i.test(s)), cases.join(" | "));
  }

  console.log("\n'All good' and 'fewer people finish' are both true at once");
  {
    // The ticket is explicit: a green verdict beside a fallen conversion is not
    // a contradiction and must not be smoothed into one. Nothing in this module
    // consults the verdict, which is the mechanism — it cannot smooth what it
    // cannot see.
    const src = require("node:fs").readFileSync("src/lib/metric-movement.ts", "utf8") as string;
    check("the movement never reads a verdict, so it can never be overruled by one",
      !/verdict/i.test(src.replace(/\/\/.*$/gm, "")), "verdict referenced in code");
    check("…nor a finding, nor a run status",
      !/\bfinding\b|\brunStatus\b/i.test(src.replace(/\/\/.*$/gm, "")));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
