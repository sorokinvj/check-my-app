// CHE-284 verification: a journey that got better says so, quietly.
//
// CHE-241 asked for asymmetry of TONE, not of existence: "a fall is a warning,
// a rise is worth one sentence and no alarm." Half of that shipped.
// `movementSentence` composed the rise sentence on every improving journey and
// `metricAlertsForRun` then dropped it, because it keeps only falls — which is
// right for the mail and wrong as the end of the story. The sentence was
// written and thrown away, every run, for every journey that improved.
//
// So the rise goes where the owner is already looking and nothing is
// interrupted: the verdict page. Two things have to stay true at once, and they
// pull in opposite directions, which is why both are asserted here:
//
//   1. the rise is visible on the page;
//   2. the rise still never reaches the alert path, so a quiet watch stays
//      quiet and good news never arrives as an interruption.
//
// The bar is deliberately identical to a fall's — material and significant,
// judged by the same `movementOf` over the same points. A page that celebrates
// noise is worse than a page that says nothing.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-rise-is-said.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAlertable, movementOf, movementSentence, type MetricPoint } from "@/lib/metric-movement";
import { hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const day = (n: number) => new Date(2026, 8, n);
const pts = (...convs: number[]): MetricPoint[] =>
  convs.map((conversion, i) => ({ conversion, sampleSize: 2000, measuredAt: day(20 - i) }));

/** A real, significant, material improvement: 40% for three checks, then 70%. */
const IMPROVED = pts(70, 39, 41, 40);
/** Flat. */
const FLAT = pts(40, 40, 40, 40);
/** A fall, for the contrast. */
const FELL = pts(15, 39, 41, 40);

const PATH = { from: "/cart", to: "/thanks" };

console.log("\n— the rise exists as a sentence —\n");

{
  const m = movementOf(IMPROVED);
  check("a real improvement is classified as a rise", m.kind === "rose", m.kind);

  const s = movementSentence("Check out", m, PATH);
  check("…and composes a sentence", typeof s === "string", String(s));
  check("…that says it got better", /more people are getting/.test(s ?? ""), s ?? "");
  check("…names both ends of the path", /\/cart/.test(s ?? "") && /\/thanks/.test(s ?? ""), s ?? "");
  check("…and never claims anyone finished the journey",
    !/finish|complete|convert/i.test(s ?? ""), s ?? "");
  check("no homework", !hasHomework(s ?? ""));
  check("no narration", !hasNarration(s ?? ""));
}

console.log("\n— and it still never raises a siren —\n");

{
  check("a rise is not alertable", !isAlertable(movementOf(IMPROVED)));
  check("…while a fall still is", isAlertable(movementOf(FELL)));
  check("flat is neither", !isAlertable(movementOf(FLAT)) && movementOf(FLAT).kind !== "rose",
    movementOf(FLAT).kind);
}

console.log("\n— the page shows it; the mail does not —\n");

{
  const block = readFileSync(
    join(import.meta.dirname, "..", "src/components/journey-numbers-block.tsx"),
    "utf8",
  );
  const load = readFileSync(
    join(import.meta.dirname, "..", "src/lib/journey-numbers-load.ts"),
    "utf8",
  );
  const alerts = readFileSync(
    join(import.meta.dirname, "..", "src/agent/metric-alerts.ts"),
    "utf8",
  );

  check("the loader computes the movement", /movementOf\(c\.metricPoints/.test(load));
  check("…and keeps only a rise", /movement\.kind === "rose"/.test(load),
    "a fall on the page as well would say the same alarming thing twice");
  check("…using the point's own stored path, not today's funnel",
    /pathEndsOf\(point\?\.steps/.test(load));
  check("the block renders it", /movementSentence\(title, rose\.movement/.test(block));

  // The half that must NOT change. If this ever passes because the alert path
  // started carrying rises, the quiet watch is broken and the guard has to say
  // so loudly.
  check("the alert path still drops everything that is not alertable",
    /if \(!isAlertable\(movement\)\) continue;/.test(alerts),
    "a rise must never break a quiet watch");
  check("…and the alert path does not read the page's rise field",
    !/\brose\b/.test(alerts), "the two paths stay separate on purpose");
}

console.log("\n— the bar is the same as a fall's —\n");

{
  // Two points is not a baseline; an immaterial move is not news. Same gates as
  // the alert, because a page that celebrates noise is worse than a silent one.
  check("two points are not enough for a rise", movementOf(pts(70, 40)).kind === "no_baseline");
  const tiny = movementOf(pts(42, 40, 40, 40));
  check("a real but immaterial improvement is not a rise", tiny.kind !== "rose", tiny.kind);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
