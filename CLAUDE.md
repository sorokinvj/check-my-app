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

## 6. Dogfood, atomically.

Every change is one merge → one deploy → one verification against the real
product (a run, a browser check, a D1 query) before moving on. CheckMyApp
checks CheckMyApp; the loop that files tickets for customers files them for us
too (rule 2).
