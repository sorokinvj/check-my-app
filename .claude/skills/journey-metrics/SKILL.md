---
name: journey-metrics
description: Price a user journey the way CheckMyApp does — how many actions the person performs, and how many of 100 who start it finish. Use when filling in or changing a journey's price/conversion, when judging whether a flow got cheaper or more expensive between two checks, or when you need a rubric for "is this flow expensive for the user?" that gives the same answer twice.
---

# Pricing a journey

Every journey carries two numbers, and both are stated from the user's side —
not the product's, not the implementation's, and never ours.

- **price** — how many actions the person performs to get the thing done.
- **conversion** — of 100 people who start this journey, how many finish it.

Both are opinions. That is the point: "signing up costs your user eleven
actions" is a judgement about someone's product that only an outside observer
makes, and it is worth more than another green check mark.

**Neither is analytics.** You are not looking these up, and there is nothing to
look them up in: no funnel events, no dashboard, no labels in the UI. You count
what you watched a person have to do, and you judge how many would finish. So
"not tracked" is never an answer here, and neither is 0 actions — a journey is
something a person does, so it costs at least one. If you genuinely cannot tell,
say so in the note and give your best judgement anyway; a number with a doubt
beside it is useful, a zero is a false statement about someone's product.

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
explains and rejects anything else.

## Where these numbers live

They are not a report we write once. Every journey in CheckMyApp carries them:

- `AppJourney.price` / `AppJourney.conversion` — the app's journey as it stands
  today, with `prevPrice` / `prevConversion` behind it and the run that last
  moved them.
- `Journey.price` / `Journey.conversion` — what this particular check said.
- The rules above are enforced in `src/agent/journey-metrics.ts`
  (`decideMetric`), not merely requested: a changed number whose note names no
  change is refused, and the stored number stands.

This file and the guide our own model is handed are the same text.
`scripts/verify-journey-metrics.ts` fails if they drift.
