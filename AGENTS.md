# Working in this repository

For an implementing agent. `CLAUDE.md` is the constitution — read it first and
treat it as binding. This file is the operating detail underneath it.

## Commands

Run these before you finish. They are what CI runs, in this order:

```
npx prisma generate      # the workerd client; its output is gitignored
npm run typecheck        # web app
npm run agent:typecheck  # agent worker — a separate tsconfig, easy to forget
npm run lint
npm run verify:gates     # the one-attempt credential rule
npm run verify:doer      # the doer's rails
```

**`npx opennextjs-cloudflare build` will fail for you and that is expected.** It
needs deploy-time environment this checkout does not carry. CI builds it; do not
chase that failure, and do not invent values to get past it.

Every `npm run verify:*` script is part of the acceptance registry — the closed
set of commands this project treats as proof. If you add one, add it to CI too.

## What "done" means

- The commands above pass.
- The change is the ticket and nothing else. No drive-by refactors.
- **If the fix is not visible to a user, it lands with a `verify:` script of its
  own.** A clean review proves the code is well written; it says nothing about
  whether this is the thing that was asked for.
- You may say the work is shipped. You may never say the problem is fixed —
  that is decided by a later run of this product walking the deployed site from
  outside (`src/agent/reconcile.ts`), and by nothing else.

## Boundaries

- Never push to `main`, never merge. Commit on the branch you were given.
- Never edit `CLAUDE.md`. Those rules are the owner's; each was written after a
  failure that cost trust, and a change that edits the rules it is judged
  against is not a change.
- Never edit `.github/workflows/` unless the ticket names it.
- Never put a real secret anywhere, including as a placeholder that looks real.

## Conventions that are not style

These are the ones worth stating, because guessing them wrongly is expensive.

**Anything a customer reads describes their product only.** Never our cost,
tokens, model names, browser, or environment — and never homework for them
("verify this yourself"). Enforced in `src/lib/verdict-language.ts`; add new
phrasings there rather than to a prompt.

**A rule needs a mechanism, not an instruction to a model.** If a ticket asks
for a behaviour, the answer is code that makes the wrong behaviour impossible,
not a sentence added to a prompt asking for the right one.

**"Broken" requires positive evidence** a real user would hit: an error
response, a console exception, wrong data. Silence is not evidence.

**Comments carry the why, not the what.** The code says what it does. A comment
earns its place by recording the incident or the constraint behind a decision —
several refusals in `src/agent/tools.ts` look arbitrary until you read why they
exist. A ticket number goes in a comment only after that ticket exists.

**Times are UTC.** Do not introduce a named timezone; the owner reads UTC.

## Shape of the codebase

- `src/app` — Next.js App Router, deployed to Cloudflare via OpenNext.
- `src/agent` — the checking agent, a separate Cloudflare Worker on workerd.
  It has its own tsconfig; `npm run typecheck` alone does not cover it.
- `src/lib` — shared by both, so it must not import anything Next-only.
- `prisma/` — schema plus hand-written SQL migrations in `prisma/migrations/`,
  applied by CI. Add a new numbered file; never edit one that has shipped.

## If you cannot do it

Say so in a comment and change nothing. An honest refusal with the commands you
ran is worth more here than a plausible diff — this project exists because a
confident wrong answer costs more than no answer.
