# CheckMyApp — product rules

Non-negotiable rules for anyone (human or agent) working on this codebase.
They exist because each one was violated in production and cost the owner
trust. Prompt tweaks are not enough: every rule below must have a
**deterministic mechanism** behind it, not just an instruction to a model.

## 1. The verdict is the product. Our machinery is invisible.

Customer-facing text — `Run.bottomLine`, findings, journey summaries, step
`attempted`/`observed`, emails — describes **the customer's product only**.

Never write, in anything a customer reads:

- how we check: "our test browser", "headless", "Playwright", request/mutation
  counts, "in our environment";
- an excuse dressed as a finding: "the button did nothing for us";
- **homework for the customer**: "verify in a real browser", "spot-check this
  yourself", "confirm manually". They pay us precisely so they don't have to.
  This is the worst version of the leak and it is a hard failure.

Mechanism: `src/lib/verdict-language.ts` — leak detection + strip, enforced
after synthesis in `src/agent/synthesis.ts` (findings dropped, bottom line
rewritten). Add new leak phrasings there, not to a prompt.

## 2. "We could not verify X" is a defect of ours, not a caveat for them.

Owner rule, 2026-08-27. If the checker could not check something, the answer is
never to tell the customer to live with it. It becomes a **high-priority ticket
on our own board**, deduped by capability and counted across every app that
trips it, until the capability exists.

- Steps carry `Step.unverifiedReason`: `our_capability` | `missing_access` |
  `not_applicable`.
- `our_capability` → `src/agent/capability-gaps.ts` files "[Checker gap] …"
  through our own tracker integration, on every run.
- `missing_access` (test credentials, a URL) is the one thing we may ask the
  owner for — that is access, not verification work.

Coverage language in the verdict ("we could not confirm X this run") is the
honest minimum while a gap exists. It is never the end of the story: the ticket
is. The goal is a product where that sentence disappears.

## 3. Verify, don't speculate — and reach for the tool.

- "broken" requires positive evidence a real user would hit: an error response,
  a console exception, a crash, wrong data. Silence is not evidence.
- Anything we can resolve server-side, we resolve: outbound links go to
  `verify_links` (YouTube via oEmbed) instead of being reported as a mystery.
- Evidence on the page outranks assumptions about our environment (live
  captions mean the call works, whatever a control looked like).
- HTTP 429 is our own request volume, never a finding.

## 4. Our own failures never reach the customer's verdict.

An outage on our side (LLM budget, provider 402, browser crash) fails the run
with an internal reason and publishes **nothing** — no verdict, no findings, no
email (`LlmBudgetError` → `src/agent/workflow.ts`). A customer must never read
a degraded verdict caused by our billing.

## 5. Findings are problems, not applause.

0 findings is a valid, good run. Never pad the list; positive confirmations
belong in journey summaries and the bottom line. Every finding's "why this
matters" must carry an action the owner could take.

## 6. Self-checks are silent, and they clean up after themselves.

CheckMyApp checks CheckMyApp by signing in as a real account and using the
product. That account is flagged `User.isTestAccount` and three things follow,
enforced in code rather than by habit:

- **Silent.** A run owned by a test account never emails anyone
  (`ownedByTestAccount` in `src/agent/workflow.ts`). Its results live in that
  account's own dashboard — sign in as it to look. The person running the
  business must be able to forget the self-check exists.
- **Disposable.** `src/agent/janitor.ts` runs on every scheduler tick and
  removes apps the test account accumulated (12-hour grace, so a fresh run is
  still inspectable). Verdicts are detached, never deleted — they cost money to
  produce and are the record of what we saw.
- **Ordinary otherwise.** It is a normal account you can sign into. Nothing
  about it is special-cased in the product itself.

This exists because the absence of it cost real money twice: a placeholder app
the agent registered was checked daily for two days, and a paused watch came
back to life because the agent pressed resume while exploring (CHE-89, CHE-98).

## 7. Dogfood, atomically.

Every change is one merge → one deploy → one verification against the real
product (a run, a browser check, a D1 query) before moving on. CheckMyApp
checks CheckMyApp; the loop that files tickets for customers files them for us
too (rule 2).

## 8. "Whose bug is it" is not a question we answer. It is one we make impossible.

Owner rule, 2026-08-30, after the JobLander case: of six tickets we filed on a
real customer's board in three days, three were our own defects. Their team
disproved them with Cloud Run logs, request byte sizes and Firebase state — and
on the third one began discussing how to suppress us.

The tempting conclusion is that we need their logs. It is the wrong one. In all
three cases the deciding evidence was **inside CheckMyApp**: our own click could
not drive the form, our own stored password was stale. The answer is not to
argue better. It is to have no defects of our own to mistake for theirs.

> A claim about the customer's product may only rest on evidence uncontaminated
> by our own state. If we cannot separate our incapacity from their defect,
> there is no finding — there is a ticket on our board.

This is rule 2 one step further: "we could not verify X" is our defect, and so
is "we could not tell whose defect X was". Four classes, and every rejected
ticket is filed against one of them (`src/agent/capability-gaps.ts`,
`IssueLink.defectClass`):

- **capability** — we could not perform the action and blamed the product;
- **configuration** — our own inputs were wrong (a stale credential, a bad URL);
- **interpretation** — we read absence of evidence as evidence of a defect;
- **bookkeeping** — we lost track of what we had filed or been told.

A ticket number goes into a code comment only after that ticket exists. Three
numbers here were written before they were assigned and later collided with real
tickets, which sends the next reader — human or agent — to the wrong history and
makes a rule look arbitrary. An arbitrary-looking rule gets deleted (CHE-102).

Mechanism, not intention: a tracker `Canceled` suppresses the signature **and**
opens "[Checker defect] …" on our own board, deduped by class and counted across
every customer that trips it (`src/agent/reconcile.ts`). The share of tickets
customers accept is the number that decides whether we are ready to be told to
anyone.

We do not take access to a customer's logs, error tracker or repository in order
to judge their product. The GitHub connection exists to export Playwright specs
and never enters a verdict.
