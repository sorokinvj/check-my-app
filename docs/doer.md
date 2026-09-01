# The doer

The half of the loop that does the tickets.

CheckMyApp has filed tickets against itself since August, and the same hand kept
closing them — the builder grading its own work, which rule §8 forbids toward
customers and should never have been acceptable here. This is the other half.

## What it may and may not do

The dispatcher claims one ticket, opens a branch and a PR, and asks an
implementer to work. It may mark a ticket **shipped** once merged.

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
| `doer:automerge` | the dispatcher may merge this one when every judge is clean |
| `doer:stop` | on any open issue, halts every tick |

**Merging is opt-in.** By default the doer proposes and stops; a person merges.

## What blocks a tick, on purpose

- a `doer:stop` label anywhere;
- an open doer PR that nobody has ruled on — nothing new may be built while
  nothing old has been judged;
- an empty queue, which is a state worth naming rather than silence.

## The merge gate

Merging requires every judge to have spoken **for the current head**. Three
things that are not approval, and each is how a gate merges a change nobody
reviewed:

- a check still running — "computing" is not "passed";
- no checks reported yet — absence of a verdict is not a verdict;
- an approval of an earlier push — it was about a different diff.

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
