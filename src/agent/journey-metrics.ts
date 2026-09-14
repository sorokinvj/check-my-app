// What a journey costs the person who walks it (CHE-235).
//
// Two numbers per journey, both stated from the USER's side and nobody else's:
//
//   price      — how many actions the person performs to get the thing done.
//   conversion — of 100 people who start it, how many finish.
//
// They are opinionated on purpose. A journey that takes eleven actions is worse
// than one that takes four, whatever the code looks like, and saying so is the
// product: "this is expensive for your user" is a sentence only an outside
// observer can say, and we are the outside observer.
//
// The guide below is the whole contract. It is the same text as
// .claude/skills/journey-metrics/SKILL.md (scripts/verify-journey-metrics.ts
// fails if they drift), so the rules a coding agent reads and the rules our own
// model is handed are one document, not two that agree for a while.
//
// This module is pure: the guide, the shapes, and the rules that police what
// comes back. Nothing here reads the database or calls a model.

/** A journey's two numbers as one value, plus the sentence that justifies them. */
export interface JourneyMetric {
  /** Actions the user performs. 0 means "nothing to do" and is almost always wrong. */
  price: number;
  /** Of 100 people who start, how many finish. 0-100. */
  conversion: number;
  /** Why it is what it is, or what changed since the last check. One sentence. */
  note: string;
}

/** What the model may not exceed, so one bad answer cannot poison a chart. */
export const METRIC_BOUNDS = { maxPrice: 200, maxConversion: 100 } as const;

/** A note shorter than this says nothing; the value it defends is not accepted. */
export const MIN_NOTE_CHARS = 12;

// ─── The guide ───────────────────────────────────────────────────────────────
// Rendered into the discovery prompt verbatim and published as the skill.

export const JOURNEY_METRICS_GUIDE = `# Pricing a journey

Every journey carries two numbers, and both are stated from the user's side —
not the product's, not the implementation's, and never ours.

- **price** — how many actions the person performs to get the thing done.
- **conversion** — of 100 people who start this journey, how many finish it.

Both are opinions. That is the point: "signing up costs your user eleven
actions" is a judgement about someone's product that only an outside observer
makes, and it is worth more than another green check mark.

## Counting the price

One action is one thing the person does. Count on the shortest path the product
actually offers, not the one it could have offered.

Counts as one action each:

- a click or tap that moves the journey forward — a button, a link, a menu item;
- one field filled, however long the value (an email is one, a 400-word bio is
  one);
- one choice made — a dropdown, a radio, a checkbox the flow requires, a date
  picked;
- a file chosen, an image cropped, a permission granted in a browser dialog;
- a confirmation the product demands ("Are you sure?", a cookie wall that blocks
  the page, a "continue" on an interstitial);
- leaving the product and coming back — opening the email for a code, copying it
  in: **two** (the trip out, the value in).

Does not count:

- scrolling, reading, looking, hovering, waiting;
- anything optional that the goal does not require;
- **anything we did as a checker.** Re-navigating to look again, opening a page
  twice to confirm what we saw, our own detours — those are our actions, not the
  user's, and they never reach this number.

If the journey cannot be finished, count the actions up to the point where it
stops and say so in the note. A broken journey must never look cheap — that is
what conversion is for.

## Judging the conversion

Of 100 people who start, how many finish. Anchors, and pick the nearest:

| conversion | what it looks like |
|-----------|--------------------|
| 95-100 | one obvious action, nothing to type, nothing to wait for |
| 80-94 | short and familiar: sign in, a 2-3 field form, clear errors |
| 60-79 | a real form (5+ fields), or one confusing moment a person recovers from |
| 40-59 | the journey leaves the product (email code, an app to install), or makes the user wait with no explanation |
| 20-39 | a dead end with a workaround only a determined person finds; several confusing steps in a row |
| 1-19 | needs something the user does not have to hand — an API key, an ID from somewhere else, a second device |
| 0 | cannot be finished at all: it is blocked, broken, or the control does nothing |

Two rules that keep this honest:

- **Price and conversion are not the same number twice.** A long flow people
  still complete (checkout at a shop they trust) is expensive and converts well.
  A one-click flow that fails silently is cheap and converts at zero.
- **Judge the product, not your patience.** "I would not bother" is not a
  measurement. Ask what a person who actually wants this outcome would do.

## Changing a number

A journey that already has these numbers arrives with them. You are not
re-deriving them from scratch — you are answering one question: **did this
journey change since then?**

- Nothing changed in the flow → keep both numbers exactly as they are, and say
  so in the note.
- Something changed → move the number and name the change: "a field was added
  to the form" (price 5 → 6), "the confirmation email is no longer required"
  (price 8 → 6, conversion 55 → 80), "the submit button now does nothing"
  (conversion 70 → 0).
- **A number that moves without a named change is a defect.** Nothing accepts a
  new value whose note does not say what changed — the previous number stands.

The first time a journey is seen there is nothing to compare with: assign both
numbers and let the note say what the flow is, in one sentence.

## Worked examples

**"Sign up for an account" — price 6, conversion 65.**
Open the sign-up page (1), fill email (2), fill password (3), confirm password
(4), accept the terms checkbox (5), submit (6). Conversion 65: five fields and a
password rule that is only shown after the first failed submit.

**"Sign up for an account", the next check — price 8, conversion 45.**
Two fields were added (first name, last name) and the account is not usable until
a code from the email is entered — the trip to the mailbox and back is two more
actions. Note: "two fields added and an email code is now required."

**"Read the pricing page" — price 1, conversion 100.**
Click "Pricing" in the navigation. Nothing to fill, nothing to wait for.

**"Practice an interview with the AI coach" — price 4, conversion 0.**
Open Practice (1), choose a role (2), choose a question set (3), press Start (4).
It converts at zero this check: pressing Start leaves the page on a spinner and
no session ever begins. Price stays 4 — the actions the person performs before
it fails are still four, and pretending the journey got cheaper because it broke
would be the wrong number in the wrong direction.

**"Invite a teammate" — price 5, conversion 25.**
Open Settings (1), open Members (2), press Invite (3), type the address (4), send
(5). Conversion 25: the invite form asks for a "workspace role ID" it never
explains and rejects anything else.`;

// ─── Rules the answer has to pass ────────────────────────────────────────────

/** What a model returned for one journey, before anything trusts it. */
export interface RawMetric {
  price?: unknown;
  conversion?: unknown;
  note?: unknown;
}

export interface MetricDecision {
  /** The value to store, or null to store nothing at all. */
  value: JourneyMetric | null;
  /** What happened, for the log. Never customer-facing. */
  reason: string;
  /** True when the previous value was kept instead of the proposed one. */
  kept: boolean;
}

/**
 * Decide what to store for one journey, given what the model said and what the
 * catalog already held. The rules are the guide's, enforced rather than asked:
 *
 *   - out-of-range numbers are clamped, not rejected: a model that says 140%
 *     means "everybody", and losing the whole answer over it helps nobody;
 *   - a CHANGED number with no real note is refused, and the previous value
 *     stands — this is the one rule that keeps the metric from drifting a few
 *     points every run and looking like a trend;
 *   - a first value needs a note too, but any real sentence will do: there is
 *     nothing to drift from yet.
 */
export function decideMetric(raw: RawMetric | null | undefined, previous: JourneyMetric | null): MetricDecision {
  const price = clamp(toInt(raw?.price), 0, METRIC_BOUNDS.maxPrice);
  const conversion = clamp(toInt(raw?.conversion), 0, METRIC_BOUNDS.maxConversion);
  const note = typeof raw?.note === "string" ? raw.note.trim() : "";

  if (price === null || conversion === null) {
    return {
      value: previous,
      reason: previous ? "no numbers this run — the stored ones stand" : "no numbers this run",
      kept: Boolean(previous),
    };
  }

  const changed =
    !previous || previous.price !== price || previous.conversion !== conversion;
  if (changed && note.length < MIN_NOTE_CHARS) {
    if (previous) {
      return {
        value: previous,
        reason: `refused ${previous.price}→${price} / ${previous.conversion}→${conversion}: no change was named`,
        kept: true,
      };
    }
    // Nothing to keep. A first value with no explanation is still the only
    // value we have, and refusing it would leave the journey unpriced forever.
    return {
      value: { price, conversion, note: note || "first measurement" },
      reason: "first value, taken without an explanation",
      kept: false,
    };
  }

  return {
    value: { price, conversion, note: note || previous?.note || "unchanged" },
    reason: changed ? `${describe(previous)}${price}/${conversion}` : "unchanged",
    kept: false,
  };
}

function describe(previous: JourneyMetric | null): string {
  return previous ? `${previous.price}/${previous.conversion} → ` : "first value ";
}

/**
 * The line that tells the model what this journey cost last time. Empty when
 * the journey has no numbers yet — the guide covers that case on its own.
 */
export function metricLine(metric: JourneyMetric | null): string {
  if (!metric) return "not measured yet";
  return `price ${metric.price}, conversion ${metric.conversion}${metric.note ? ` (${metric.note})` : ""}`;
}

function toInt(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

function clamp(value: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  return Math.min(max, Math.max(min, value));
}
