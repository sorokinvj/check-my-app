// Our estimate and their measurement, side by side, never mistaken for each
// other (CHE-240).
//
// Two numbers about the same journey come from completely different places:
//
//   price, conversion (ours)  — a judgement we formed by walking it (CHE-235)
//   conversion (measured)     — a count from the customer's own analytics (CHE-239)
//
// A reader who cannot tell which is which will act on the wrong one. "45 of 100
// finish" is a thing we believe; "38% of 412 people over 14 days" is a thing
// that happened, and only the second is worth rearranging a roadmap for. So
// every line this file produces names its source, and no line can be produced
// without one — the label is not decoration applied at render time, it is part
// of the value.
//
// Rule 1 applies to every string here: these are read by the customer. Nothing
// about how we check, no browser, no request counts, and above all no homework
// — never "verify this yourself". src/lib/verdict-language.ts is the mechanism;
// scripts/verify-journey-numbers.ts holds these strings to it directly.

export type NumberSource = "ours" | "measured";

export interface OurJudgement {
  /** Actions a person performs to finish. Null when we did not price it. */
  price: number | null;
  /** Out of 100, our estimate of how many finish. Null when unpriced. */
  conversion: number | null;
}

export interface TheirMeasurement {
  /** 0-100, or null when we counted and the sample was too small. */
  conversion: number | null;
  /** People who reached the first stage. Always known when a point exists. */
  sample: number;
  windowDays: number;
  /**
   * The two ends of the path that was counted, as pages of the customer's own
   * product.
   *
   * They are part of the value, not decoration (CHE-279). The funnel we measure
   * along comes from a walk, and a walk enters the app at its front door and
   * stops wherever it stopped — neither end is reliably the journey's own start
   * or finish. Naming both makes the number true whatever the funnel turned out
   * to span; leaving them out is what let "50 of 1,690" be read as "3% of people
   * finish logging in", about a login that works.
   */
  from: string;
  to: string;
}

/** Why there is no measured number. Each is a different sentence, on purpose. */
export type NoMeasurement =
  /** The team has connected no analytics at all. */
  | "not_connected"
  /** Connected, and this journey has no funnel to measure along. */
  | "no_funnel"
  /** Connected and measurable, but nothing has counted it yet. */
  | "not_measured_yet"
  /** Connected, measured, and there were too few people to mean anything. */
  | "below_floor";

export interface NumberLine {
  label: string;
  value: string;
  /** Named on every line. A number without its source is the whole defect. */
  source: string;
  sourceKind: NumberSource;
}

/** What we judged, in the customer's terms. Never called a measurement. */
export function ourLines(j: OurJudgement): NumberLine[] {
  const lines: NumberLine[] = [];
  if (j.price !== null) {
    lines.push({
      label: "Effort",
      value: `${j.price} ${j.price === 1 ? "action" : "actions"} to finish`,
      source: "our estimate",
      sourceKind: "ours",
    });
  }
  if (j.conversion !== null) {
    lines.push({
      label: "Likely to finish",
      value: `${j.conversion} of 100`,
      source: "our estimate",
      sourceKind: "ours",
    });
  }
  return lines;
}

/**
 * What their analytics counted. Never called an estimate, and never called a
 * finish.
 *
 * It says "of the people who reached A, this many went on to B" and stops
 * there, because that is the whole of what was counted. The earlier version
 * said "Actually finished — 3% of 1,690 people", which is the same arithmetic
 * carrying a claim the arithmetic does not support: the 1,690 were everyone who
 * arrived at the app, not everyone who set out to do this (CHE-279).
 */
export function measuredLine(m: TheirMeasurement): NumberLine | null {
  if (m.conversion === null) return null;
  return {
    label: "Along this path",
    value:
      `${m.conversion}% of the ${m.sample.toLocaleString("en-US")} people who reached ` +
      `${m.from} went on to ${m.to}, last ${m.windowDays} days`,
    source: "your analytics",
    sourceKind: "measured",
  };
}

/**
 * The sentence for a journey with no measured number.
 *
 * Three different facts, three different sentences, and none of them an empty
 * cell pretending to be a zero. A blank where a number belongs reads as "nobody
 * finished this", which would be a claim about the customer's product that
 * nothing supports.
 */
export function noMeasurementLine(reason: NoMeasurement, sample?: number): string {
  switch (reason) {
    case "not_connected":
      return "Connect your analytics to see how many people actually finish this.";
    case "no_funnel":
      return "This journey does not have a measurable path yet, so there is no completion rate for it.";
    case "not_measured_yet":
      // Deliberately NOT "not enough traffic": that would state something about
      // the customer's users we have not established.
      return "No completion rate for this one yet — it will appear after the next check.";
    case "below_floor":
      return sample !== undefined
        ? `Not enough traffic to measure yet — ${sample.toLocaleString("en-US")} ${sample === 1 ? "person" : "people"} in the last two weeks.`
        : "Not enough traffic to measure yet.";
  }
}

// ── There is deliberately no comparison between the two numbers ──────────────
//
// There was one, and it was the best line on the page when it was right:
// "We expected most people to get through this. Your own numbers say 97% do not
// finish it." It is removed because the subtraction underneath it is invalid
// (CHE-279).
//
// Our estimate answers "of the people who set out to do this, how many finish".
// The measurement answers "of the people who reached one page, how many reached
// another" — and the first of those pages is where our walk entered the app, so
// it is shared by most journeys of that app and carries no intent. Two numbers
// over different denominators can be subtracted, and the result is an artefact.
// On joblander.app that artefact was 67 points, and the sentence it produced was
// about a login our own walk had just completed successfully.
//
// This is not a claim that the comparison is worthless. It is a claim that we
// cannot make it yet, which makes it our gap rather than a caveat for the
// customer (rule 2). It returns the day a funnel provably spans its journey at
// both ends — and on that day it is one function and a threshold, not a
// redesign. Until then, both numbers stand on the page with their sources
// named, and the reader draws no line between them that we have not earned.
//
// scripts/verify-measured-denominator.ts reads this file and fails if a
// comparison reappears under any name.
