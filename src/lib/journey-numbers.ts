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

/** One page we walked, and how many of their people reached it. */
export interface WalkedStage {
  stage: string;
  count: number;
}

/**
 * The pages of this journey that are the journey's own, and the one that is not.
 *
 * Our walk enters every journey through the app's front door, so that page is
 * stage one of almost every funnel and its count is the app's whole audience
 * (CHE-287). On joblander.app the entry drop is `/` 1,690 → `/signup` 13, which
 * says only that most visitors did not come to sign up. Reporting it as part of
 * the journey drowns the journey; dropping it leaves the pages the journey is
 * actually made of.
 *
 * `entry` is kept rather than discarded because "13 people reached your signup
 * form, out of 1,690 who came to the site" is a different and sometimes better
 * sentence than either half — but it is context, never the subject.
 */
export interface JourneyPages {
  own: WalkedStage[];
  entry: WalkedStage | null;
}

/**
 * A completion rate we are entitled to state, because the walk finished.
 *
 * The entitlement is the whole content of this type (CHE-283). A funnel derived
 * from a walk that never performed the journey's finishing action cannot contain
 * the completion page — no stage-picking rule recovers a page nobody reached —
 * and 8 of 16 journeys in production are in exactly that state, deliberately:
 * without test credentials we check read-only rather than create records in
 * someone's product.
 *
 * So this exists only where the walk's last step was not skipped, and `to` is
 * then genuinely where the journey ends rather than where we stopped.
 */
export interface TheirCompletion {
  /** 0-100, of the people who reached the journey's own first page. */
  conversion: number;
  /** People on that first page — the honesty of the number above. */
  sample: number;
  from: string;
  to: string;
  windowDays: number;
}

/**
 * The completion rate for a journey whose walk finished, or null.
 *
 * Null when there are fewer than two of the journey's own pages (one page is
 * arrival, not conversion) or when nobody reached the first — a rate out of
 * zero is not a small rate, it is no rate.
 */
export function completionOf(p: JourneyPages, windowDays: number): TheirCompletion | null {
  const own = p.own;
  if (own.length < 2) return null;
  const first = own[0];
  const last = own[own.length - 1];
  if (first.count <= 0) return null;
  return {
    conversion: Math.round((last.count / first.count) * 100),
    sample: first.count,
    from: first.stage,
    to: last.stage,
    windowDays,
  };
}

/**
 * The sentence that puts our judgement and their count together.
 *
 * Removed in CHE-279 and restored here under the condition that makes it valid:
 * it is reachable only from a `TheirCompletion`, which exists only when the walk
 * finished the journey. The version that was removed compared our estimate —
 * "of the people who set out to do this, how many finish" — against a count
 * whose denominator was everyone who arrived at the app, and on joblander.app
 * that produced "100% do not finish it" about a signup form our own walk had
 * just found clean.
 *
 * Null when there is nothing worth saying, which is most of the time: a page
 * that comments on every journey teaches people to skip the comments.
 */
export function comparisonLine(ours: OurJudgement, theirs: TheirCompletion): string | null {
  if (ours.conversion === null) return null;
  const gap = theirs.conversion - ours.conversion;

  if (Math.abs(gap) < SHARP_DISAGREEMENT) {
    return theirs.conversion >= HEALTHY_CONVERSION
      ? null
      : `We expected this to be hard going, and your own numbers agree: ${theirs.conversion}% of the ` +
          `${theirs.sample.toLocaleString("en-US")} people who reached ${theirs.from} got to ${theirs.to}.`;
  }
  if (gap < 0) {
    return (
      `We expected most people to get through this. Of the ${theirs.sample.toLocaleString("en-US")} who ` +
      `reached ${theirs.from}, ${100 - theirs.conversion}% did not reach ${theirs.to}.`
    );
  }
  return (
    `This looked harder than it turns out to be — ${theirs.conversion}% of the ` +
    `${theirs.sample.toLocaleString("en-US")} people who reached ${theirs.from} got to ${theirs.to}.`
  );
}

/** Percentage points between our estimate and their count before it is news. */
export const SHARP_DISAGREEMENT = 20;
/** At or above this, a journey is doing fine and needs no commentary. */
export const HEALTHY_CONVERSION = 50;

// There is deliberately no type here for a conversion rate we did not earn.
//
// There was one, and a rate rendered from it. It is gone because we cannot say
// what the rate is OF: the funnel's first stage is where our walk entered the
// app and its last is wherever the walk stopped, so neither end is the
// journey's own (CHE-279, CHE-283). Naming both ends made the sentence true,
// but it never made it useful — "0% of the 1,690 people who reached / went on
// to /login" is a fact about site traffic wearing a journey's name.
//
// What replaced it is `JourneyPages` above: the pages, and how many people were
// on each. A count has no denominator to get wrong (CHE-287).

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

/**
 * Split the stages we counted into the journey's own pages and the entry page.
 *
 * The entry page is recognised by the app's own address, not by position: a
 * journey that genuinely starts somewhere else keeps all its stages, and a
 * journey whose every stage is the entry page keeps none — which is an honest
 * "we have nothing to say about this one" rather than a number.
 */
export function journeyPages(
  stages: readonly WalkedStage[],
  entryPath: string,
): JourneyPages {
  const entryAt = stages.findIndex((s) => s.stage === entryPath);
  if (entryAt !== 0) return { own: [...stages], entry: null };
  return { own: stages.slice(1), entry: stages[0] };
}

/**
 * What their analytics counted, said as pages rather than as a rate.
 *
 * A count needs no denominator and cannot be misread: "13 people reached
 * /signup" is true whatever this journey turns out to be. A rate between two
 * named pages is safe for the same reason — both ends are on the page, so the
 * reader is not left to supply "…of the journey" (CHE-279).
 *
 * What this deliberately never says is how many people *finished the journey*.
 * We do not know where the journey starts or ends (CHE-283); we know which
 * pages we walked and how many people were on them.
 */
export function pagesLine(p: JourneyPages, windowDays: number): NumberLine | null {
  const own = p.own;
  if (own.length === 0) return null;

  const window = `last ${windowDays} days`;
  const people = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;

  if (own.length === 1) {
    return {
      label: "Reached",
      value: `${people(own[0].count)} reached ${own[0].stage}, ${window}`,
      source: "your analytics",
      sourceKind: "measured",
    };
  }

  // Two or more of the journey's own pages: say where they went, in order, so
  // the step people leave on is visible rather than inferred from one rate.
  const first = own[0];
  const rest = own
    .slice(1)
    .map((s) => `${s.count.toLocaleString("en-US")} to ${s.stage}`)
    .join(", then ");
  return {
    label: "Reached",
    value: `${people(first.count)} reached ${first.stage}, then ${rest} — ${window}`,
    source: "your analytics",
    sourceKind: "measured",
  };
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
