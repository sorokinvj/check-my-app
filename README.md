# CheckMyApp

> Paste a link. We'll show you your app.

**Prod: https://checkmyapp.dev**

CheckMyApp takes the URL of a (often vibe-coded) web app plus optional test
credentials and, within ~20–30 minutes, returns a **product mirror**: the user
journeys it discovered, the app anatomy it mapped, and the bugs/risks/exposures
it found along the way — on a shareable verdict page. Optionally, **Daily
Watch** re-runs on a schedule and alerts on regressions.

It is **not** a generic QA tool. It's a *product mirror with QA fallout* — that
distinction drives every UI decision. Evidence is first-class: a step or
finding without verifiable artifacts isn't trusted.

## The three loops

- **Loop A — One-off Check:** submit URL → agent maps the app → walks
  discovered journeys → produces a verdict page (App Lens + User Journeys +
  App Anatomy + Findings + generated Playwright specs).
- **Loop B — Daily Check:** after the first run, enable "Watch this app daily";
  the agent re-runs the same journeys and diffs against the baseline.
- **Loop C — Feedback:** mark findings (known / fixed / false positive) and
  edit the App Lens; Daily Check uses these to filter noise.

## Screens

| # | Route            | Screen           | Notes |
|---|------------------|------------------|-------|
| 1 | `/check`         | Submit           | test creds + notify email behind "Add login & notes" |
| 2 | `/run/{id}`      | In-progress      | live SSE theatre: feed + agent's browser screenshot |
| 3 | `/verdict/{id}`  | Verdict          | App Lens, journeys, anatomy, findings, specs |
| 4 | `/watch/{slug}`  | Watch settings   | history, frequency, notify, pause |
| 5 | `/dashboard`     | Owner home       | Clerk-protected; apps under daily QA |
| 6 | `/onboarding`    | Add app wizard   | target + creds + urgent journeys + Linear |

## Architecture (Cloudflare, two workers)

```
Browser ──POST /api/checks──▶ checkmyapp-web (Next.js via OpenNext)
   ▲                              │ CHECK_RUN.create()  (cross-worker binding)
   │  SSE /api/runs/{id}/stream   ▼
   └───────────────────── checkmyapp-agent · CheckRunWorkflow (durable)
                                  │
             6 phases: connecting → surface_scan → discovery
                       → walking (per journey) → anatomy → writing
                                  │            │             │
                          Browser Rendering   R2 (evidence) Anthropic
                          (@cloudflare/       screenshots/  Sonnet nav ·
                           playwright)        transcripts   Opus synthesis
                                  │
                                 D1 (Prisma, workerd client, adapter-d1)
```

- **Web worker** (`src/app`) — Next.js App Router + Tailwind + Clerk. Thin:
  accept submissions, stream progress, render verdicts from D1, proxy evidence
  from private R2 (`/api/evidence`).
- **Agent worker** (`src/agent`) — the durable `CheckRunWorkflow`:
  `workflow.ts` orchestrates phases; `discovery.ts` / `execution.ts` /
  `synthesis.ts` do the work; `tools.ts` owns the Playwright toolbelt
  (hydration-robust click/fill, network-delta feedback, secret scrubbing);
  `browser.ts` owns Browser Rendering sessions.
- **Data model** (`prisma/schema.prisma`) — `Run` → `Journey` → `Step` +
  `Finding` (+ `Evidence` on both), `Watch` for recurring runs; M3 adds
  `User`/`App`/`TrackerIntegration`/`TicketPolicy`/`IssueLink` for owner
  accounts and per-owner QA→Linear. D1/SQLite: JSON columns are TEXT
  (parse on read — `src/lib/json.ts`), enums are strings (`src/lib/enums.ts`).

## Getting started (local)

```bash
cp .env.example .env        # fill ANTHROPIC_API_KEY, CREDENTIALS_SECRET, Clerk keys
npm install
npx prisma generate
npm run db:migrate:local    # D1 (miniflare) schema in .wrangler/state
npm run db:seed:local       # optional demo data
```

Two ways to run:

**Testing / prod-like (recommended): one wrangler runtime, both workers**

```bash
npm run dev:cf              # opennextjs build + wrangler dev -c web -c agent
```

Real cross-worker `CHECK_RUN` binding, no proxy sockets. No HMR — rebuild to
pick up changes.

**UI development (HMR): two processes**

```bash
npm run agent:dev           # wrangler dev, MUST own port 8787
npm run dev                 # next dev on :3000
```

In `next dev` there is no cross-worker binding — `src/lib/trigger.ts` falls
back to POST `localhost:8787/trigger` (override: `AGENT_DEV_URL`). Known traps:

- If something stale holds 8787, wrangler silently takes 8788 and every submit
  hangs. `lsof -nP -iTCP:8787 -sTCP:LISTEN` before starting.
- The platform-proxy D1 socket (`initOpenNextCloudflareForDev`) can die
  (Prisma `WASM_ERROR: ECONNRESET` on every query) — restart `next dev`.
- Locally-run Workflows do **not** resume after the agent process restarts —
  an in-flight run dies with its wrangler session. Prod Workflows are durable.

## Configuration

See `.env.example` (Cloudflare runtime gets these as worker secrets/vars, not
.env — see DEPLOY.md). Key vars: `ANTHROPIC_API_KEY`,
`ANTHROPIC_NAV_MODEL`/`ANTHROPIC_SYNTH_MODEL` (Sonnet nav · Opus synthesis),
`CREDENTIALS_SECRET` (AES-256-GCM for test creds at rest), Clerk keys,
`LINEAR_CLIENT_ID/SECRET` (per-owner tickets), `EMAIL_API_KEY`/`EMAIL_FROM`
(Resend; unset = log-only), Turnstile keys (bot protection, enforced when set).

## Deploy

See `DEPLOY.md`. Short version: `wrangler d1 migrations apply checkmyapp
--remote` → deploy agent (defines the Workflow) → OpenNext build + deploy web.
CF account: 491c3148 (workers.dev subdomain `frosty-fog-32a2`); prod domain
`checkmyapp.dev` is a custom domain on `checkmyapp-web`.

## Privacy & safety

Test credentials: encrypted at rest, substituted server-side (the LLM only sees
`{{TEST_EMAIL}}`/`{{TEST_PASSWORD}}` placeholders), scrubbed from logs and
transcripts, blurred in screenshots, refused off the target origin, cleared
after terminal runs unless a Watch retains them. Evidence R2 is private and
proxied through the web worker; verdict permalinks are unguessable.
