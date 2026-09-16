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

/** What their analytics counted. Never called an estimate. */
export function measuredLine(m: TheirMeasurement): NumberLine | null {
  if (m.conversion === null) return null;
  return {
    label: "Actually finished",
    value: `${m.conversion}% of ${m.sample.toLocaleString("en-US")} people, last ${m.windowDays} days`,
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

/**
 * The sentence worth more than either number alone.
 *
 * When our judgement and their traffic disagree sharply, saying so is the most
 * valuable thing on the page — "we thought this was fine and most of your users
 * do not finish it" is what an owner is paying to be told. When they agree, the
 * agreement is worth one line too: it turns our opinion into something with
 * evidence behind it.
 *
 * Returns null when there is nothing worth saying, which is most of the time.
 * A page that comments on every journey teaches people to skip the comments.
 */
export function comparisonLine(ours: OurJudgement, theirs: TheirMeasurement): string | null {
  if (ours.conversion === null || theirs.conversion === null) return null;
  const gap = theirs.conversion - ours.conversion;

  // Below this the two are saying the same thing and a sentence adds nothing.
  if (Math.abs(gap) < SHARP_DISAGREEMENT) {
    return theirs.conversion >= HEALTHY_CONVERSION
      ? null
      : `We expected this to be hard going, and your own numbers agree: ${theirs.conversion}% finish it.`;
  }

  if (gap < 0) {
    // The valuable one: we were optimistic and their users are not finishing.
    return `We expected most people to get through this. Your own numbers say ${100 - theirs.conversion}% do not finish it.`;
  }
  return `This looked harder than it turns out to be — ${theirs.conversion}% of your users finish it.`;
}

/** Percentage points between our estimate and their count before it is news. */
export const SHARP_DISAGREEMENT = 20;
/** At or above this, a journey is doing fine and needs no commentary. */
export const HEALTHY_CONVERSION = 50;
