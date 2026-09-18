# The doer

The half of the loop that does the tickets.

CheckMyApp has filed tickets against itself since August, and the same hand kept
closing them — the builder grading its own work, which rule §8 forbids toward
customers and should never have been acceptable here. This is the other half.

## Who does what

- **Mender** writes the code (owner, 2026-09-18). A cheap model in a bash loop
  whose only output is a patch, judged by its own gate — apply, setup,
  typecheck, lint, the `verify:*` registry, and for a bug a test that fails
  without the patch and passes with it — in a checkout the model never saw
  (`JobLander-app/mender`; the gate is `mender.yml` in this repository). It runs
  inside the doer tick, in Actions, and is handed the ticket as a file built
  from our own database (`scripts/doer/board-queue.ts`), never a tracker
  credential. Until 2026-09-18 the implementer was Codex, asked by a comment;
  Codex answers only a ChatGPT-linked identity and could not push here
  (CHE-155), and six claims in a row came back "the implementer never came".
- **Codex** reviews. Reviews arrive as a formal review with inline comments
  when it has findings, and as a "Completed" row in its summary comment when it
  has none; the shepherd reads both (`scripts/doer/review.mjs`) and asks with
  the owner's token when nothing else will produce a verdict.
- **The machine** merges when nothing objects (`scripts/doer/machine.mjs`).
- **A later run** decides whether the problem is gone.

## What it may and may not do

The dispatcher claims one ticket, opens a branch, has Mender attempt it on that
branch, and opens the PR with the patch and its price. It may mark a ticket
**shipped** once merged.

It may never mark one **fixed**. That word belongs to a later CheckMyApp run
walking the deployed product from outside (`src/agent/reconcile.ts`), which marks
a link `resolved` only when a fresh walk fails to reproduce the failure. A merged
fix that reappears comes back as a new regression, exactly as a customer's would.

JOB-902 is why this is not ceremony: merged twenty minutes after filing, a
triumph on any speed metric, and incomplete — the route still refused anonymous
visitors, and the next day's run caught it.

## Running it

- **Automatically** — every two hours (`.github/workflows/doer.yml`), and on
  demand from the Actions tab.
- **Locally, without touching anything** — `node scripts/doer/tick.mjs --dry-run`
  prints the decision and acts on nothing.

## The queue

GitHub issues in this repository labelled **`doer`**, oldest first so nothing
starves. An issue is written the way we write a customer's ticket (rule §9): the
symptom, the evidence, and how to know it is gone. Never files, causes or fixes —
the implementer has the repository and diagnoses for itself, and a ticket of ours
that contains a proposed fix is a defect in the ticket.

| Label | Effect |
|---|---|
| `doer` | in the queue |
| `doer:hold` | skipped, without leaving the queue |
| `doer:stop` | on any open issue, halts every tick |

**Merging is the default.** The gate merges when every judge is clean, and the
brakes are `doer:hold` for one ticket and `doer:stop` for all of them.

It was opt-in until 2026-09-03, which made "stopped, waiting for a person" the
loop's normal state — the same manual button we refused when we chose the PR
handoff over the Linear one, moved to the end of the pipeline instead of the
middle.

Three things carry the default, and none of them is anybody's approval:

- **the problem is evidence, not opinion.** A ticket here comes from a
  CheckMyApp run against the deployed product — CHE-88 came out of run #100 with
  a screenshot and a repro. Nobody's judgement started it;
- **the gate is arithmetic.** Work exists outside `.doer/`, every check green
  for this head, a verdict published for this head, zero unresolved threads,
  rounds ≤ 3. There is no opinion in that list, and a person reading the same
  green ticks adds none;
- **the merge decides nothing about the problem.** `resolved` still comes only
  from a later run walking the deployed site from outside.

The honest counter-argument is not that a human should approve. It is that an
automated judge can fail silently — which happened four times on 2026-09-03, in
four different ways. Every one of them published **nothing**, and the gate
requires a published verdict, so the gate held each time. A person on a merge
button would not have caught any of them; they see the same green ticks.

An earlier version of this paragraph justified the default by saying the owner
had already approved the work when he filed the ticket. He had not: the queue's
issues were opened through his account by agents, minutes before the dispatcher
claimed them. The claim was invented to make the argument close, and it is
recorded here because a rule resting on a made-up premise is worth less than no
rule.

## What blocks a tick, on purpose

- a `doer:stop` label anywhere;
- an open doer PR that nobody has ruled on — nothing new may be built while
  nothing old has been judged. If the shepherd has handed findings back on it
  (a round marker newer than the head), the tick's first duty is that round:
  Mender runs again on the PR's branch with the findings appended to the
  ticket, and pushes or reports;
- an empty queue, which is a state worth naming rather than silence;
- a ticket whose attempts keep coming back red steps aside after two
  (CHE-211). A red attempt is recorded as a closed draft PR on the ticket's
  branch carrying Mender's report, which is also where the price of every
  attempt lives — the ledger on the runner is ephemeral and is kept as a
  workflow artifact.

## The merge gate

Merging requires every judge to have spoken **for the current head**. Three
things that are not approval, and each is how a gate merges a change nobody
reviewed:

- a check still running — "computing" is not "passed";
- no checks reported yet — absence of a verdict is not a verdict;
- an approval of an earlier push — it was about a different diff.

A fourth, learned on 2026-09-03 and costing four runs to see: a reviewer can go
green having read nothing. It was denied the tool that starts it, then spawned
background agents and ended its turn waiting for them, then skipped entirely
because the branch's copy of the workflow lagged `main`. Each time the job
reported success and published nothing. The rule that held was the one above —
a verdict must be *reported for this head*, and silence never is.

## Acceptance

A clean review proves the code is well written. It says nothing about whether
this diff is the thing that was asked for.

- **User-visible symptom** → accepted by the verifier: the next run does not
  reproduce it. Nothing to write.
- **Internal defect** → accepted by a script in this repo that runs in CI. The
  `npm run verify:*` scripts are the closed registry — the fixed set of commands
  this loop is allowed to treat as proof. `verify:gates` and `verify:doer` are
  the first two.

A ticket of the second kind is not shippable without one.

## Rails, and what each cost

| Rail | Paid for by |
|---|---|
| never push to `main`, PR only | the rule that already governs the one path writing to a customer's repo |
| one open PR at a time | a queue where a slow review becomes two slow reviews |
| the implementer never touches `CLAUDE.md` | nine rules, each written after a failure that cost trust |
| the rails are tested before each tick | a decision that cannot be tested is one nobody should trust unattended |
| it runs in Actions, not on a VM | JobLander's dispatcher died of an out-of-memory kill on 26 August; nobody noticed for six days because the board still looked alive — CheckMyApp had been covering for it |

## What stays the owner's

The rules and what the product is for. Secrets, billing, anything that
provisions or destroys. Whether a capability is worth having at all — "we cannot
sign in with Google" is a market decision wearing a ticket's clothes. And the
first ten minutes of a stranger's experience, which no loop measures.
