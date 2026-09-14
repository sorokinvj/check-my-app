// CHE-235 — what a journey costs its user: the rules, and the one document.
//
// Two things are checked here, and both are the kind that rot silently:
//
//   1. The guide our model is handed (JOURNEY_METRICS_GUIDE) and the skill a
//      coding agent reads (.claude/skills/journey-metrics/SKILL.md) are the
//      SAME TEXT. Two copies of a rubric agree for about a month; after that
//      the numbers in the database were produced by rules nobody can read.
//   2. decideMetric enforces the rubric's own discipline rather than asking
//      for it — above all "a number that moves without a named change is
//      refused", which is what keeps a five-point drift every run from
//      reading like a trend.
//
// Run: npx tsx --tsconfig tsconfig.json scripts/verify-journey-metrics.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  decideMetric,
  JOURNEY_METRICS_GUIDE,
  METRIC_BOUNDS,
  MIN_PRICE,
  MIN_NOTE_CHARS,
  metricLine,
  type JourneyMetric,
} from "@/agent/journey-metrics";
import { journeyMetricsBlock } from "@/agent/instructions";
import { matchJourney, normalizeSurface, sameSurface } from "@/lib/journey-key";

let failures = 0;
function check(what: string, ok: boolean, detail = "") {
  if (ok) console.log(`PASS  ${what}`);
  else {
    failures += 1;
    console.log(`FAIL  ${what}${detail ? `  →  ${detail}` : ""}`);
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(repoRoot, ".claude/skills/journey-metrics/SKILL.md"), "utf8");

console.log("One document");
check("the skill carries the guide verbatim", skill.includes(JOURNEY_METRICS_GUIDE), "the two have drifted — regenerate SKILL.md from JOURNEY_METRICS_GUIDE");
check("…with frontmatter a skill loader can read", /^---\nname: journey-metrics\ndescription: /.test(skill));
check("…and says where the numbers live", skill.includes("AppJourney.price"));

console.log("\nThe guide says what it must");
for (const rule of [
  "price",
  "conversion",
  "shortest path",
  "scrolling, reading, looking, hovering, waiting",
  "anything we did as a checker",
  "A number that moves without a named change is a defect",
]) {
  check(`the guide states: ${rule}`, JOURNEY_METRICS_GUIDE.includes(rule));
}
check("the guide carries worked examples with both numbers", (JOURNEY_METRICS_GUIDE.match(/price \d+, conversion \d+/g) ?? []).length >= 4, String((JOURNEY_METRICS_GUIDE.match(/price \d+, conversion \d+/g) ?? []).length));
check(
  "…including one that broke without getting cheaper",
  /price 4, conversion 0/.test(JOURNEY_METRICS_GUIDE),
);

console.log("\nA first value");
{
  const d = decideMetric({ price: 6, conversion: 65, note: "five fields and a password rule shown only after a failed submit" }, null);
  check("is taken as given", d.value?.price === 6 && d.value?.conversion === 65 && !d.kept);
  const bare = decideMetric({ price: 6, conversion: 65, note: "" }, null);
  check("is taken even without an explanation — there is nothing to drift from", bare.value?.price === 6 && !bare.kept, JSON.stringify(bare));
  check("…and says so in place of the missing note", bare.value?.note === "first measurement", bare.value?.note);
}

console.log("\nA number that moves");
const previous: JourneyMetric = { price: 6, conversion: 65, note: "five fields" };
{
  const named = decideMetric({ price: 8, conversion: 45, note: "two fields added and an email code is now required" }, previous);
  check("moves when the change is named", named.value?.price === 8 && named.value?.conversion === 45 && !named.kept);

  const silent = decideMetric({ price: 7, conversion: 60, note: "" }, previous);
  check("is refused when nothing is named", silent.kept && silent.value?.price === 6 && silent.value?.conversion === 65, JSON.stringify(silent));
  check("…and the refusal says what it refused", /6→7/.test(silent.reason) && /65→60/.test(silent.reason), silent.reason);

  const excuse = decideMetric({ price: 7, conversion: 60, note: "changed" }, previous);
  check("a note too short to name anything is not a named change", excuse.kept, `${MIN_NOTE_CHARS} chars minimum; got "${String(excuse.value?.price)}"`);

  const same = decideMetric({ price: 6, conversion: 65, note: "" }, previous);
  check("an unchanged number needs no note at all", !same.kept && same.value?.price === 6);
  check("…and keeps the sentence that justified it", same.value?.note === "five fields", same.value?.note);
}

console.log("\nWhat a model cannot do to the numbers");
{
  const over = decideMetric({ price: 9999, conversion: 140, note: "everything is fine here honestly" }, null);
  check("out-of-range values are clamped, not thrown away", over.value?.price === METRIC_BOUNDS.maxPrice && over.value?.conversion === 100, JSON.stringify(over.value));
  const missing = decideMetric({ note: "no numbers" }, previous);
  check("a missing number leaves the stored one alone", missing.kept && missing.value?.price === 6);
  const none = decideMetric(null, null);
  check("no answer at all writes nothing", none.value === null && !none.kept);
  const words = decideMetric({ price: "8", conversion: "45", note: "two fields were added to the form" }, previous);
  check("numbers written as text still count", words.value?.price === 8 && words.value?.conversion === 45);

  // Run #192 (checkmyapp.dev, 2026-09-14), the first production run after the
  // metric shipped: the discovery model priced all four journeys at 0 actions
  // and 0% conversion, each with a note saying the figure was "not tracked".
  // Stored, that says every journey in the app is free and nobody finishes it.
  const notTracked = decideMetric(
    { price: 0, conversion: 0, note: "Not tracked — app has no signup funnel event exposed in the UI." },
    null,
  );
  check(
    "a journey priced at zero actions is refused, not stored",
    notTracked.value === null && notTracked.unpriced === true,
    JSON.stringify(notTracked),
  );
  const zeroOverStored = decideMetric({ price: 0, conversion: 0, note: "Not tracked — no event labels in UI." }, previous);
  check(
    "…and it cannot overwrite a price we already had",
    zeroOverStored.kept && zeroOverStored.value?.price === 6,
    JSON.stringify(zeroOverStored.value),
  );
  const cheapest = decideMetric({ price: MIN_PRICE, conversion: 98, note: "one click on the front page" }, null);
  check("one action is a real price and is kept", cheapest.value?.price === MIN_PRICE, JSON.stringify(cheapest.value));
  const broken = decideMetric({ price: 4, conversion: 0, note: "the submit button does nothing" }, null);
  check("conversion 0 stays legal — that is what a broken journey looks like", broken.value?.conversion === 0, JSON.stringify(broken.value));
}

console.log("\nA journey lives somewhere (app-wide or one page)");
{
  check("a path is normalised", normalizeSurface("/Settings/") === "/settings", String(normalizeSurface("/Settings/")));
  check("a full URL is reduced to its path", normalizeSurface("https://app.test/settings") === "/settings", String(normalizeSurface("https://app.test/settings")));
  check("app-wide has one spelling", normalizeSurface("app-wide") === "app" && normalizeSurface("app") === "app");
  check("two pages are not the same place", !sameSurface("/settings", "/billing"));
  check("an unknown surface is compatible with everything", sameSurface(null, "/settings") && sameSurface("/settings", undefined));

  // The case the owner named: a page with several journeys on it.
  const catalog = [
    { key: "settings", title: "Configure insight and coach preferences", surface: "/settings" },
    { key: "upload-resum", title: "Upload your resume", surface: "/settings" },
    { key: "install-extension", title: "Install the Chrome extension", surface: "/settings" },
  ];
  check(
    "a second journey on /settings is not swallowed by the first",
    matchJourney("Upload your resume", catalog, "/settings")?.key === "upload-resum",
    String(matchJourney("Upload your resume", catalog, "/settings")?.key),
  );
  check(
    "…and a reworded one still finds its own entry",
    matchJourney("Upload a resume file", catalog, "/settings")?.key === "upload-resum",
    String(matchJourney("Upload a resume file", catalog, "/settings")?.key),
  );
  check(
    "the same intent on a different page is a different journey",
    matchJourney("Configure notification preferences", catalog, "/account") === null,
    String(matchJourney("Configure notification preferences", catalog, "/account")?.key),
  );
  check(
    "…and on the same page it is the same journey",
    matchJourney("Configure coach settings", catalog, "/settings")?.key === "settings",
    String(matchJourney("Configure coach settings", catalog, "/settings")?.key),
  );
  check(
    "a journey with no surface recorded still matches its history",
    matchJourney("Upload your resume", catalog, null)?.key === "upload-resum",
  );
}

console.log("\nWhat the model is handed");
{
  const block = journeyMetricsBlock({
    runNumber: 12,
    walkedAt: "2026-09-10T00:00:00.000Z",
    anatomy: { pages: [], actions: [], services: [], tech: {} },
    journeys: [
      { title: "Sign up for a new account", steps: ["open /signup"], surface: "app", metric: { price: 6, conversion: 65, note: "five fields" } },
      { title: "Upload your resume", steps: ["open /settings"], surface: "/settings", metric: null },
    ],
  });
  check("the block carries the guide", block.includes(JOURNEY_METRICS_GUIDE));
  check("…and last time's numbers", block.includes("price 6, conversion 65"), block.slice(0, 80));
  check("…names where each journey lives", block.includes("[/settings]") && block.includes("[app]"));
  check("…and says plainly that a page can hold several journeys", block.includes("three journeys, not three wordings of one"));
  check("an unpriced journey is shown as unmeasured", block.includes("not measured yet"));
  check("metricLine on nothing says so", metricLine(null) === "not measured yet");

  const noMap = journeyMetricsBlock(null);
  check("with no known map the guide still goes in", noMap.includes(JOURNEY_METRICS_GUIDE));
  check("…and nothing pretends to be last time's number", !noMap.includes("WHAT THESE JOURNEYS COST LAST TIME"));
}

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
