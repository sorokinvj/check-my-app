# CheckMyApp

> Paste a link. We'll show you your app.

CheckMyApp takes the URL of a (often vibe-coded) web app plus optional test
credentials and, within ~2 hours, returns a **product mirror**: the user journeys
it discovered, the app anatomy it mapped, and the bugs/risks/exposures it found
along the way — on a shareable verdict page. Optionally, **Daily Watch** re-runs
on a schedule and alerts on regressions.

It is **not** a generic QA tool. It's a *product mirror with QA fallout* — that
distinction drives every UI decision.

This repo is the MVP scaffold: real structure and data model, with the agent's
heavy lifting stubbed behind clearly-marked `TODO`s.

## The three loops (MVP scope)

- **Loop A — One-off Check:** submit URL → agent maps the app → walks discovered
  journeys → produces a verdict page (App Lens + User Journeys + App Anatomy +
  Findings).
- **Loop B — Daily Check:** after the first run, enable "Watch this app daily";
  the agent re-runs the same journeys and diffs against the baseline.
- **Loop C — Feedback:** mark findings (known / fixed / false positive) and edit
  the App Lens; Daily Check uses these to filter noise.

Out of scope for MVP: payments, accounts/login, public sharing, badges, mobile/
cross-browser, cryptographic evidence bundles, pricing tiers.

## Screens

| # | Route            | Screen        | Component / Page |
|---|------------------|---------------|------------------|
| 1 | `/check`         | Submit        | `components/submit-form.tsx` |
| 2 | `/run/{id}`      | In-progress   | `components/run-live.tsx` (SSE) |
| 3 | `/verdict/{id}`  | Verdict       | `app/verdict/[id]/page.tsx` |
| 4 | `/watch/{slug}`  | Watch settings| `app/watch/[slug]/page.tsx` |

## Architecture

```
Browser ──POST /api/checks──▶ Next.js ──enqueue──▶ Redis (BullMQ)
   ▲                             │                      │
   │  SSE /api/runs/{id}/stream  │                      ▼
   └─────────────────────────────┘               Worker process
                                                  src/worker/index.ts
                                                        │
                                   6-phase agent pipeline (per run)
                                   connecting → surface_scan → discovery
                                   → walking → anatomy → writing
                                        │            │          │
                                   Playwright   Evidence    Anthropic
                                   (Chromium)   (S3/disk)   (App Lens)
                                                        │
                                                   Postgres (Prisma)
```

- **Web app** (`src/app`) — Next.js 14 App Router, Tailwind. Thin: accept
  submissions, render live progress over SSE, render verdicts from the DB.
- **Worker** (`src/worker`) — consumes the run queue and drives the agent
  pipeline. Long-lived (~2h/run), low concurrency. Run separately from the web.
- **Agent pipeline** (`src/worker/agent`) — `pipeline.ts` orchestrates 6 phases;
  `discovery.ts`, `execution.ts`, `synthesis.ts` do the work; `evidence.ts`
  captures/stores artifacts; `browser.ts` owns Playwright.
- **Scheduler** (`src/worker/scheduler.ts`) — spawns Daily Watch runs when due.

### Data model (Prisma)

`Run` → `Journey` → `Step`, plus `Finding`, with `Evidence` attached to steps and
findings. `Watch` turns a target into recurring runs. Evidence is **first-class**:
a step/finding without verifiable artifacts isn't trusted. See `prisma/schema.prisma`.

## Getting started

```bash
cp .env.example .env        # fill in ANTHROPIC_API_KEY, CREDENTIALS_SECRET
npm install
npx playwright install chromium
npm run infra:up            # Postgres + Redis via Docker
npm run db:push             # apply schema
npm run db:seed             # optional: demo joblander.app verdict at /verdict/demo-verdict
npm run dev                 # web app on http://localhost:3000
npm run worker              # in a second terminal: the agent worker
```

Open http://localhost:3000 → you're redirected to `/check`.

> The pipeline runs end-to-end today but produces empty results — discovery,
> execution and synthesis are stubbed. With `ANTHROPIC_API_KEY` unset, synthesis
> uses an offline placeholder so nothing blocks locally.

## Configuration

See `.env.example`. Key vars: `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_MODEL`, `CREDENTIALS_SECRET` (encrypts test credentials at rest),
S3-compatible `STORAGE_*` (falls back to `./storage`), and `EMAIL_*`.

## Privacy

Test credentials are encrypted at rest (AES-256-GCM), never logged, never in
evidence, and cleared after a run unless an active Watch retains them. Password
fields should be blurred in screenshots (TODO in `evidence.ts`).

## Frontend (implemented)

All four PRD screens with Loop C interactions:

- **/check** — submit form; login/notes behind one toggle
- **/run/{id}** — live two-column theatre over SSE: activity feed + the agent's
  latest browser screenshot + "Agent currently: …" (worker updates
  `currentAction` / `liveScreenshotUrl` via `setLiveState()` in `pipeline.ts`)
- **/verdict/{id}** — App Lens (inline edit ✏ + Looks right / Something's off),
  journey strips with clickable step detail, App Anatomy blocks, findings with
  evidence links and triage marks (known / fixed / dispute), Daily Watch footer,
  Re-check now, newer-run banner
- **/watch/{slug}** — run history, frequency (Daily / 6h / Manual), notify rule,
  pause/resume, cancel

API: `PATCH /api/runs/{id}/lens`, `POST /api/runs/{id}/recheck`,
`PATCH /api/findings/{id}`, `POST /api/watch`, `PATCH|DELETE /api/watch/{slug}`.

## What's stubbed (next up)

- `discovery.ts` — stack detection, automated login, nav crawl, journey clustering
- `execution.ts` — the per-step agent loop + outcome classification
- `synthesis.ts` — turning observations into Findings (App Lens prompt is wired)
- `evidence.ts` — S3/R2 upload + password blurring
- Daily Watch diffing, email provider
