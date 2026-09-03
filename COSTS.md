# Operating Costs — baseline ledger

Canonical record of what running CheckMyApp costs. This is the **baseline** any
future optimization project measures against. Two cost planes: **Anthropic API**
(the agent's thinking) and **Cloudflare** (compute/storage/browser). Update this
file whenever a measurement or a plan changes — don't let numbers live only in
Linear comments.

PRD targets (from Notion §5): **≤ $1.50 per first run · ≤ $0.50 per daily re-run.**

---

## Anthropic API (per run)

| When | Model strategy | Measured / projected | Notes |
|------|----------------|----------------------|-------|
| Milestone 1 | Opus 4.8 everywhere | **~$2.5–2.8 / full run** | 1.7–1.9× over the $1.50 target |
| M1 total | — | **~$9–10** across ~5 keyed runs | dev + acceptance |
| CHE-20 spike | Sonnet 4.6 nav | **$0.004 / iteration → ~$0.73 / run** projected | under target; naive (no context-growth modeling) |
| M2 target | Sonnet 4.6 nav + Opus 4.8 synthesis | **≤ $1.50** first run, **≤ $0.50** daily (replay-first) | CHE-16 |

**M1 cost breakdown** (measured, runs #8+#9 = $5.54 / 362 iterations):
- output tokens (thinking + tool-call JSON) — **50%**
- cache_read (re-reading the growing transcript each iteration) — **28%**
- cache_write — **22%**
- input — negligible (caching works)
- screenshots are NOT sent to the model (only URL strings + text digests) — already efficient

Opus 4.8 pricing: $5 / $25 per 1M (in/out), cache write ×1.25, read ×0.1.
Sonnet 4.6 pricing: $3 / $15 per 1M, cache write ×1.25, read ×0.1.

---

## Cloudflare (monthly, M2 onward)

Verified 2026-06 from CF pricing docs.

| Resource | Free tier | Paid | Our dev usage |
|----------|-----------|------|---------------|
| Workers Paid base | — | **$5 / mo** minimum | flip ON at CHE-14 (first full BR self-check) |
| Requests | 100k / day | $0.30 / extra 1M | trivial |
| Browser Rendering | **10 min / day**, 3 concurrent | **10 hr / mo incl**, then $0.09/hr; 10 concurrent incl, then $2/extra | 1 full run ≈ 20 min → Free blocks even 1/day |
| D1 | 5 GB, 5M reads + 100k writes / day | scale-to-zero, $0.001/M read, $1/M write, $0.75/GB-mo | metadata only (evidence in R2) → ~free for ages |
| R2 | 10 GB, no egress fees | $0.015/GB-mo after | evidence/transcripts/specs; 90-day retention planned |
| Workflows / Queues / Cron | available on Free | higher CPU limits | orchestration |

**Realistic dev-phase Cloudflare cost: ~$5/mo** (Workers Paid base; browser hours
within the 10 hr included; D1/R2 within free). Most of M2 builds on Free —
Paid is only required for sustained Browser Rendering (>10 min/day).

---

## Fixed monthly subscriptions

Named by the owner, 2026-09-03. They were missing from this ledger entirely,
which made every per-run number look like the whole cost — the floor is paid
before a single run happens.

| Service | What it buys | $/mo |
|---------|--------------|------|
| Linear | the CHE board; also the tracker the product files into and reads back | 19 |
| Resend | verdict emails to owners | ~19 |
| Cloudflare Workers Paid | account base for both workers (browser hours on top) | 5 |
| ChatGPT Pro | Codex, the implementer half of the doer loop | owner's plan |
| Claude | the reviewer half, via subscription token rather than per-call API | owner's plan |

**Consequence for pricing.** ~$43/mo of named floor before any run. At the
Growth tier's ~$0.61/week for a healthy watched app, the floor is what the
first paying customers cover — not the marginal run.

---

## Running spend log

Append actual measured spend here as milestones progress. Keep it terse.

| Date | What | Anthropic $ | Cloudflare $ | Source |
|------|------|-------------|--------------|--------|
| 2026-06-11 | M1 dev + acceptance (~5 keyed self-checks, Opus) | ~$9–10 | $0 (all local) | worker logs, Linear CHE-6/16 |
| 2026-06-12 | M2 spikes (CHE-20 browser, CHE-21 D1, CHE-22 SSE) | ~$0.02 | $0 (Free tier) | spike runs |
| 2026-06-14 | First full agent run on Cloudflare (Sonnet-nav + Opus-synth, example.com) | **$0.10** (Run.costUsd) | $0 (local) | live Workflow run |
| 2026-06-16 | joblander.app first client, run #2 — discovery returned 0 journeys (no walk) | **$0.45** (Run.costUsd) | incl. browser hrs | live run cmqgny6 |
| 2026-06-16 | joblander.app first client, run #6 — full walk, 5 journeys / 9 findings | **$2.25** (Run.costUsd) | incl. browser hrs | live run cmqgojm |
| 2026-07-22 | joblander.app prod runs #10 (empty-walk hallucinated verdict) + #11 (false-positive Broken) | **$2.05 + $2.01** | incl. browser hrs | led to hydration+evidence fixes |
| 2026-07-23 | Verification runs #12/#13 after agent fixes — #13: mostly_ok, 0 broken findings, honest hedging | **$2.11 + $2.12** | incl. browser hrs | fixes 77e61d7/4029bc8 confirmed |
| 2026-08-16 | First cheap-model prod runs (glm-5.2 nav + Opus synth): #17 example.com **$0.07**, #18 theins.ru (5 journeys walked) **$0.47** ($0.40 glm + $0.07 Opus) | **$0.54** | incl. browser hrs | LlmUsage ledger |

**Model decision (2026-08-16):** staying on `z-ai/glm-5.2` nav + `claude-opus-4-8`
synthesis. Kimi K3 benches better on agentic/browser tasks but costs $2.80/$14
per 1M on OpenRouter vs glm-5.2's $0.308/$0.968 (~10–14×) — a theins-class run
would be ~$4–5, over the $1.50 target. Cerebras is an inference host (speed),
not a cost/quality lever; our runs are async so speed isn't the bottleneck.
Revisit = one spike run with `ANTHROPIC_NAV_MODEL=moonshotai/kimi-k3`.

**Replay-first daily checks (CHE-51, shipped 2026-08-22):** a Watch run no longer
starts with tokens. `src/agent/replay.ts` runs a free smoke check first — one
Browser Rendering session that re-visits the homepage plus up to 6 URLs extracted
from the app's recorded Playwright specs and baseline anatomy, and requires every
one to answer below HTTP 500 with no uncaught JS errors. Green ⇒ the run
completes at **$0.01** (browser time only, no `LlmUsage` row) carrying the
baseline verdict forward; red or ineligible ⇒ the full ~$0.53 run as before.
A full run is forced anyway when the last real walk is ≥ 7 days old, when the
baseline verdict was worse than `mostly_ok`, or when the app has no recorded
specs. Expected steady state for a healthy daily watch: **6 smoke days + 1 full
day per week ≈ $0.61/week** vs $3.71 — but only for apps that stay green.

**Cost model — corrected with real data:** the earlier "well under $1.50" estimate
was wrong for a rich authenticated app. A full joblander-class run (5 journeys
walked end-to-end, each its own agent loop + browser session) costs **~$2.25** on
Sonnet-nav + Opus-synth. The dominant cost is walking, not discovery/synthesis —
each journey is a full 50-iteration loop. Levers if we need to cut this: cap
journeys walked (currently 5), drop walking maxIterations (50), or move walking
to Haiku for the act/observe steps. A discovery-only run (0 journeys) is ~$0.45.

---

## Cost-reduction initiative (CHE-58, started 2026-08-23)

**Metric.** North-star **¢ per walked journey** (normalizes app complexity, measures efficiency not the 3-vs-5-journey mix). Driver **model calls per walked journey** (price/model-independent). Baselines (glm-era ≥2026-08-16, from LlmUsage): **5.8¢/journey · 24 calls/journey** (~209 output tok/call); $/run avg $0.33; phase share **walking 69% · synthesis 21.7% · discovery 9.3%**. Cost is output-token-dominated; cache-hit 90.6%; vision unused (0%).

**Experiments (empirical; negative results kept — they prevent bad "optimizations"):**
- **E1 — cheaper synthesis: REJECTED.** haiku-4-5 synth is −75% ($0.105→$0.026) but over-escalates severity (analytics-401 → `high exposed`), which flips the verdict to a false Broken (the CHE-37/42 class) and slips past checkVerdictIntegrity. Synthesis stays on Opus — the 21.7% is calibration, not waste. (glm-synth untested offline: OpenRouter key is worker-only.)
- **E2 — fold digest into navigate/click to skip read_page: REJECTED.** Same-target A/B (theins.ru): calls/journey 20.4→25.8, ¢/journey 6.0→7.1 — glm kept calling read_page and the fatter results added tokens. Reverted. Exposed a blind spot: **walking transcripts weren't persisted** (only discovery was) — fixed (transcripts/{runId}-walk-{order}.json) so future walking cost analysis is diagnosable, not blind.
- **E3 — walking `thinking` OFF: WIN (kept, deployed).** Same-target A/B (theins.ru vs #18): **¢/journey 6.0→1.7 (−72%)**, out-tok/call 209→153, verdict still honest (needs_attention), journeys/findings intact (CHE-37 hedging held — that discipline is in the prompt, not thinking). Bigger than the output cut alone: thinking blocks also accumulated in-context and were re-read (cache) each iteration; removing them shrinks the whole growing context. Walking is 69% of spend → ~−48% total run cost. Synthesis keeps Opus+thinking (calibration). Caveat n=1; multi-target confirmation from the next tick. **New working baseline once confirmed: ~2¢/journey.**
- **E4 — fleet ¢/journey with E3 code: the −72% did NOT generalize.** 8-run fleet (cal.com, ghost.org, joblander, linear.app, pelicanbay.pt, posthog.com, seedcast.app, tally.so; 34 journeys, all `mostly_ok`): **avg ¢/journey = 6.04 vs 5.8 baseline (flat)**, avg $/run = 0.257 vs 0.33 (−22%). The single-target theins.ru A/B (6.0→1.7) did NOT reproduce across apps — ¢/journey is dominated by per-app complexity (out-tok/call ranged 102–384) and thinking-off didn't move the fleet mean. The $/run drop is mostly from fewer journeys walked per run (4.25 vs ~5.7), not cheaper journeys. **Correction: the earlier "new working baseline ~2¢/journey" (E3, n=1) was optimistic and is retracted; steady-state ¢/journey is ~6.** E3 stays deployed (still cheaper output tokens, verdicts held honest), but it is not the win the single A/B implied.
- **E5 (queued):** same thinking-off on discovery (exploration, less reasoning-critical).

## Run-cost trend (CHE-131) — snapshot 2026-09-03

Every hypothesis above was argued from a fleet average or a single A/B. This
section is the same ledger joined per app **in run order**, which is the only
shape in which "is a run getting cheaper?" is a question with an answer.
Regenerate with `npm run cost:trend` (reads production D1 through wrangler;
`--since`, `--app`, `--json`, `--local` — see `scripts/cost-trend.mjs`). All
120 runs since 2026-08-16 (the glm era). ¢/journey and calls/journey as
defined in CHE-58; averages are means of per-run values; $ is `Run.costUsd`.

**Fleet by mode**

| mode | runs | total $ | avg $ | avg ¢/journey | avg calls/journey |
| --- | --- | --- | --- | --- | --- |
| full | 86 | 42.69 | 0.50 | 8.9 | 25.2 |
| partial | 20 | 7.34 | 0.37 | 17.4 | 36.2 |
| smoke | 4 | 0.04 | 0.01 |  |  |
| empty | 3 | 0.38 | 0.13 |  |  |
| failed | 7 | 0.00 |  | 11.8 | 28.0 |

**Fleet by ISO week**

| week | runs | smoke | partial | full | total $ | avg full $ |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-W33 | 2 | 0 | 0 | 2 | 0.54 | 0.27 |
| 2026-W34 | 40 | 0 | 2 | 37 | 11.97 | 0.31 |
| 2026-W35 | 64 | 1 | 17 | 39 | 31.91 | 0.64 |
| 2026-W36 | 14 | 3 | 1 | 8 | 6.03 | 0.70 |

Self-check placeholders (example.com, your-app.com, `*.example.com`,
`test-app-*`; 5 slugs) are inside those totals: 35 runs, $6.65.

**Trend per app** — first 3 vs last 3 runs of the mode (fewer where n < 6):

- **theins.ru** — full: n=4, first 2 vs last 2 (#18–#30 → #45–#48): ¢/journey 5.3 → 4.4 (-17%), $/run 0.42 → 0.32 (-24%); partial: n=0 — no trend yet
- **checkmyapp.dev** — full: n=13, first 3 vs last 3 (#25–#29 → #108–#130): ¢/journey 9.6 → 28.8 (+200%), $/run 0.50 → 1.48 (+197%); partial: n=6, first 3 vs last 3 (#49–#100 → #104–#120): ¢/journey 16.9 → 16.1 (-5%), $/run 0.35 → 0.40 (+15%)
- **joblander.app** — full: n=19, first 3 vs last 3 (#20–#26 → #121–#128): ¢/journey 8.3 → 15.2 (+83%), $/run 0.51 → 0.84 (+63%); partial: n=9, first 3 vs last 3 (#50–#63 → #70–#132): ¢/journey 14.9 → 36.9 (+148%), $/run 0.28 → 0.50 (+79%)
- **linear.app** — full: n=3, first 1 vs last 1 (#54–#54 → #112–#112): ¢/journey 2.0 → 17.7 (+793%), $/run 0.22 → 0.80 (+267%); partial: n=0 — no trend yet
- **meetbashar.com** — full: n=11, first 3 vs last 3 (#91–#93 → #129–#136): ¢/journey 12.7 → 11.4 (-10%), $/run 0.83 → 0.38 (-54%); partial: n=2, first 1 vs last 1 (#102–#102 → #118–#118): ¢/journey 7.6 → 10.9 (+43%), $/run 0.14 → 0.17 (+21%)

**Watched apps, run by run**

checkmyapp.dev

| run | date | mode | walked/carried | $ | disc$ | walk$ | synth$ | ¢/journey | calls/journey | vision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #19 | 2026-08-17 | empty | 0/0 | 0.06 | 0.05 |  | 0.01 |  |  | no |
| #25 | 2026-08-18 | full | 5/0 | 0.56 | 0.06 | 0.42 | 0.09 | 8.5 | 36.0 | no |
| #27 | 2026-08-19 | full | 5/0 | 0.43 | 0.08 | 0.31 | 0.10 | 6.1 | 41.8 | no |
| #29 | 2026-08-20 | full | 4/0 | 0.50 | 0.05 | 0.57 | 0.10 | 14.2 | 46.8 | no |
| #32 | 2026-08-21 | full | 5/0 | 1.36 | 0.05 | 1.17 | 0.15 | 23.3 | 48.2 | no |
| #43 | 2026-08-22 | full | 4/0 | 0.19 | 0.03 | 0.09 | 0.07 | 2.2 | 25.8 | no |
| #49 | 2026-08-23 | partial | 2/2 | 0.16 |  | 0.10 | 0.09 | 5.2 | 38.5 | no |
| #64 | 2026-08-24 | full | 5/0 | 0.75 | 0.07 | 0.60 | 0.10 | 11.9 | 40.6 | no |
| #71 | 2026-08-25 | full | 4/0 | 0.72 | 0.19 | 0.48 | 0.08 | 12.0 | 27.0 | yes |
| #79 | 2026-08-26 | partial | 1/3 | 0.23 |  | 0.17 | 0.06 | 17.0 | 40.0 | yes |
| #81 | 2026-08-26 | failed (forced) | 0/0 |  |  |  |  |  |  |  |
| #82 | 2026-08-26 | failed (forced) | 0/0 |  |  |  |  |  |  |  |
| #83 | 2026-08-26 | full (forced) | 5/0 | 1.13 | 0.10 | 1.65 | 0.08 | 33.1 | 53.8 | yes |
| #90 | 2026-08-26 | full (forced) | 4/0 | 0.74 | 0.12 | 0.60 | 0.05 | 14.9 | 29.5 | yes |
| #95 | 2026-08-27 | full (forced) | 5/0 | 0.91 | 0.07 | 0.84 | 0.08 | 16.8 | 41.8 | yes |
| #100 | 2026-08-27 | partial | 3/2 | 0.66 |  | 0.86 | 0.08 | 28.5 | 58.3 | yes |
| #104 | 2026-08-28 | partial | 2/3 | 0.52 |  | 0.45 | 0.06 | 22.7 | 40.5 | yes |
| #108 | 2026-08-28 | full (forced) | 5/0 | 1.47 | 0.13 | 1.36 | 0.09 | 27.3 | 49.2 | yes |
| #113 | 2026-08-29 | full (forced) | 5/0 | 1.34 | 0.12 | 1.57 | 0.08 | 31.3 | 54.8 | yes |
| #116 | 2026-08-29 | partial | 2/3 | 0.43 |  | 0.33 | 0.09 | 16.6 | 39.0 | yes |
| #120 | 2026-08-30 | partial | 2/3 | 0.26 |  | 0.18 | 0.08 | 9.0 | 33.0 | yes |
| #123 | 2026-08-31 | smoke | 0/0 | 0.01 |  |  |  |  |  |  |
| #127 | 2026-09-01 | smoke | 0/0 | 0.01 |  |  |  |  |  |  |
| #130 | 2026-09-02 | full | 5/0 | 1.63 | 0.25 | 1.40 | 0.09 | 28.0 | 38.4 | yes |
| #134 | 2026-09-03 | smoke | 0/0 | 0.01 |  |  |  |  |  |  |

joblander.app

| run | date | mode | walked/carried | $ | disc$ | walk$ | synth$ | ¢/journey | calls/journey | vision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #20 | 2026-08-17 | full | 5/0 | 0.63 | 0.04 | 0.54 | 0.13 | 10.9 | 34.4 | no |
| #24 | 2026-08-18 | full | 5/0 | 0.43 | 0.08 | 0.23 | 0.12 | 4.6 | 22.2 | no |
| #26 | 2026-08-19 | full | 5/0 | 0.48 | 0.05 | 0.47 | 0.10 | 9.4 | 33.6 | no |
| #28 | 2026-08-20 | full | 5/0 | 0.46 | 0.03 | 0.32 | 0.11 | 6.4 | 26.8 | no |
| #31 | 2026-08-21 | full | 5/0 | 0.38 | 0.05 | 0.21 | 0.12 | 4.1 | 21.2 | no |
| #42 | 2026-08-22 | full | 5/0 | 0.49 | 0.01 | 0.34 | 0.13 | 6.8 | 34.2 | no |
| #44 | 2026-08-22 | full | 5/0 | 0.22 | 0.02 | 0.11 | 0.10 | 2.1 | 22.8 | no |
| #50 | 2026-08-23 | partial | 4/1 | 0.23 |  | 0.11 | 0.12 | 2.7 | 26.8 | no |
| #51 | 2026-08-23 | full | 5/0 | 0.27 | 0.03 | 0.15 | 0.09 | 3.0 | 19.6 | no |
| #61 | 2026-08-24 | full | 5/0 | 0.33 | 0.03 | 0.21 | 0.09 | 4.2 | 18.6 | no |
| #62 | 2026-08-24 | partial | 1/4 | 0.18 |  | 0.09 | 0.09 | 9.2 | 27.0 | no |
| #63 | 2026-08-24 | partial | 1/4 | 0.43 |  | 0.33 | 0.10 | 32.8 | 48.0 | no |
| #65 | 2026-08-24 | partial | 3/2 | 0.56 |  | 0.45 | 0.10 | 15.2 | 27.3 | no |
| #67 | 2026-08-25 | full | 5/0 | 0.91 | 0.21 | 0.59 | 0.13 | 11.8 | 43.0 | no |
| #68 | 2026-08-25 | partial | 2/3 | 0.51 |  | 0.40 | 0.11 | 20.1 | 38.5 | yes |
| #69 | 2026-08-25 | partial | 1/4 | 0.30 |  | 0.17 | 0.13 | 16.9 | 39.0 | yes |
| #70 | 2026-08-25 | partial | 1/4 | 0.34 |  | 0.39 | 0.11 | 39.0 | 82.0 | yes |
| #72 | 2026-08-25 | empty | 0/0 | 0.16 | 0.14 |  | 0.02 |  |  | yes |
| #73 | 2026-08-25 | empty (forced) | 0/0 | 0.15 | 0.13 |  | 0.02 |  |  | yes |
| #74 | 2026-08-25 | full (forced) | 5/0 | 2.31 | 0.14 | 2.09 | 0.12 | 41.8 | 39.6 | yes |
| #76 | 2026-08-26 | full | 5/0 | 0.22 | 0.12 |  | 0.10 |  |  | yes |
| #77 | 2026-08-26 | failed (forced) | 1/0 |  | 0.09 |  |  |  |  | yes |
| #78 | 2026-08-26 | full (forced) | 5/0 | 0.63 | 0.07 | 0.49 | 0.07 | 9.8 | 23.0 | yes |
| #80 | 2026-08-26 | smoke | 0/0 | 0.01 |  |  |  |  |  |  |
| #99 | 2026-08-27 | full (forced) | 5/0 | 1.13 | 0.08 | 0.97 | 0.08 | 19.5 | 31.6 | yes |
| #101 | 2026-08-27 | partial | 2/3 | 0.73 |  | 0.69 | 0.08 | 34.3 | 50.0 | yes |
| #106 | 2026-08-28 | full | 1/0 | 0.27 | 0.16 | 0.08 | 0.03 | 8.3 | 22.0 | yes |
| #117 | 2026-08-29 | full | 5/0 | 0.83 | 0.08 | 0.72 | 0.06 | 14.3 | 28.6 | yes |
| #121 | 2026-08-30 | full | 5/0 | 0.72 | 0.07 | 0.59 | 0.07 | 11.7 | 25.6 | yes |
| #124 | 2026-08-31 | full | 5/0 | 1.23 | 0.12 | 1.11 | 0.08 | 22.2 | 41.2 | yes |
| #128 | 2026-09-01 | full | 4/0 | 0.56 | 0.12 | 0.46 | 0.07 | 11.6 | 26.8 | yes |
| #132 | 2026-09-02 | partial | 1/3 | 0.43 |  | 0.38 | 0.06 | 37.5 | 37.0 | yes |
| #135 | 2026-09-03 | failed | 5/0 |  | 0.18 | 0.59 |  | 11.8 | 28.0 | yes |

meetbashar.com

| run | date | mode | walked/carried | $ | disc$ | walk$ | synth$ | ¢/journey | calls/journey | vision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #91 | 2026-08-26 | full | 5/0 | 0.51 | 0.05 | 0.45 | 0.07 | 9.0 | 23.6 | yes |
| #92 | 2026-08-26 | full (forced) | 5/0 | 1.11 | 0.23 | 0.79 | 0.10 | 15.8 | 32.2 | yes |
| #93 | 2026-08-26 | full (forced) | 5/0 | 0.85 | 0.12 | 0.67 | 0.07 | 13.3 | 27.6 | yes |
| #94 | 2026-08-27 | full (forced) | 5/0 | 0.57 | 0.06 | 0.43 | 0.07 | 8.7 | 21.6 | yes |
| #98 | 2026-08-27 | full (forced) | 5/0 | 0.72 | 0.07 | 0.58 | 0.08 | 11.5 | 26.2 | yes |
| #102 | 2026-08-27 | partial | 1/4 | 0.14 |  | 0.08 | 0.06 | 7.6 | 20.0 | yes |
| #107 | 2026-08-28 | full | 5/0 | 1.05 | 0.08 | 0.89 | 0.08 | 17.8 | 31.6 | yes |
| #118 | 2026-08-29 | partial | 1/4 | 0.17 |  | 0.11 | 0.06 | 10.9 | 26.0 | yes |
| #122 | 2026-08-30 | full | 5/0 | 0.96 | 0.05 | 0.85 | 0.06 | 16.9 | 30.6 | yes |
| #125 | 2026-08-31 | full | 5/0 | 0.76 | 0.08 | 0.61 | 0.06 | 12.3 | 25.8 | yes |
| #129 | 2026-09-01 | full | 1/0 | 0.23 | 0.10 | 0.11 | 0.03 | 10.7 | 27.0 | yes |
| #133 | 2026-09-02 | full | 1/0 | 0.21 | 0.06 | 0.12 | 0.03 | 12.2 | 24.0 | yes |
| #136 | 2026-09-03 | full | 5/0 | 0.69 | 0.05 | 0.57 | 0.08 | 11.4 | 25.2 | yes |

**Replay audit (CHE-129):** `Journey.replayStatus` not deployed at snapshot
time — the script prints "replay audit: column not deployed yet" until it is.

**Ledger drift.** Run.costUsd below Σ LlmUsage by more than $0.02 on 29 of 120 runs; Σ Run.costUsd = $50.44, Σ LlmUsage = $55.03. 19 runs carry more walking rows than walked journeys (retried walk steps): #20, #23, #26, #27, #29, #53, #70, #83, #86, #88, #91, #95, #96, #100, #111, #112, #113, #126, #128. Two known causes, both ours: the forced
Playwright-spec call after a walk is booked in `LlmUsage` but not in
`Run.costUsd`, and a retried walk step leaves its first attempt's row behind
under a journey id that no longer exists. `Run.costUsd` is therefore ~9% under
what was actually spent; the tables above use it because it is the number
every other row in this file uses.

**Reading.** ¢/journey is not trending down on any watched app. Split by nav
model instead of by date, the whole movement is one step: full runs before
vision (n=45) average **4.9¢/journey, 23.9 calls/journey, 192 out-tok/call,
$0.32/run**; full runs on vision (n=40) average **13.4¢, 26.7 calls, 159
out-tok/call, $0.70/run** — 2.7× per journey with calls and output tokens
flat or lower, so the increase is per-call input (images re-read from the
growing context every iteration), which is what CHE-70 guessed from n=1 and
is now visible across 85 runs. Per app the same: joblander full 6.3¢ → 17.4¢,
checkmyapp.dev 11.1¢ → 23.3¢ across the switch. meetbashar.com (vision-only,
n=11) is flat at 11–13¢; its −54% in $/run comes from #129 and #133 walking 1
journey instead of 5, not from cheaper journeys. Partials cost less per run
($0.37 vs $0.50) but more per journey (17.4¢ vs 8.9¢): they re-walk exactly
the journeys that went badly last time, and those take 36 calls against 25.
Where the money goes: full runs $42.69 (86 runs), partials $7.34 (20), smoke
$0.04 (4), discovery-empty $0.38 — the replay-first steady state of "6 smoke
days + 1 full" is not what the fleet does; 13 of 86 full runs were forced and
smoke ran 4 times in 120 runs.

**Not concluded from this data.** Whether vision paid for itself — the ledger
records cost, not the two false-broken classes it killed, so quality-per-dollar
stays a judgement, not a number. Whether ¢/journey on a given app moves for
reasons other than the model switch: run-to-run variance within one era is
2–3× (joblander vision fulls range 8.3¢–41.8¢) and journeys walked vary 1–5,
so a first-3/last-3 delta inside one era is noise until n is much larger.
Whether calls/journey — CHE-58's named driver — drives anything: it moved
+12% while ¢/journey moved +170%, so on this data it is not the lever.

## Vision nav (CHE-70, deployed 2026-08-25)

Nav model switched `z-ai/glm-5.2` → `z-ai/glm-5v-turbo` (same per-token price:
$1.2/$4 per 1M vs $1.19/$3.74) and every screenshot now goes INTO the model
context as a compressed JPEG (~1.5–2k tokens each) — the agent judges what it
photographs. Measured joblander runs, 2026-08-25/26:

| Run | Mode | Nav | Cost | Note |
|-----|------|-----|------|------|
| #67 | full walk | glm-5.2 (text) | **$0.91** | pre-vision reference |
| #68 | partial (2 journeys) | 5v-turbo | $0.51 | first vision run |
| #69 | partial (1) | 5v-turbo | $0.30 | |
| #70 | partial (1) | 5v-turbo | $0.34 | |
| #73 | full, FAILED discovery | 5v-turbo | $0.15 | glm-5v ignores output_config json_schema → 0 journeys; fixed by struct-model routing (b41d570) |
| #74 | full walk | 5v-turbo + glm-5.2 struct | **$2.31** | all 5 journeys ok, incl. live LiveKit call |

**Takeaway:** vision costs ~2.5× on FULL walks ($0.91 → $2.31 — images
accumulate in the growing walking context and get cache-re-read each
iteration), but partials stay $0.30–0.51 — and partials are the daily
steady state. The quality jump paid for itself the same day (killed two
false-broken classes: LiveKit "cannot be driven", 429 "broken widget").
Optimization candidates if full-walk cost matters later: downscale JPEGs,
drop image blocks from context after N turns, image-free discovery.
Structured extraction (discovery/synthesis-retry JSON) routes to glm-5.2 —
the GLM vision variants ignore `output_config` json_schema.

## How to measure going forward

- **Per-run Anthropic $**: the agent core logs `[agent] iter N: ... in/cache/out`
  per iteration; CHE-16 persists the rolled-up total to `Run.costUsd`. Read it
  from the DB, not by hand.
- **Cloudflare monthly**: CF dashboard → Billing; Browser Rendering + D1 + R2
  usage meters. Snapshot into the log table above at each milestone gate.
- **Optimization projects** start by quoting the relevant row here as the
  before-number, and add an after-number on completion.

## Image window in the walking context (CHE-130, deployed 2026-09-03)

The first lever of the run-economics program (Notion «Экономика рана — Starter
$29»; tickets CHE-129…137). `src/agent/core.ts` now keeps only the last
`WALK_IMAGE_WINDOW` screenshots (default 3, `off` = the old behaviour) as image
blocks in the walking conversation; older ones become a text placeholder, once,
in place, so the prompt-cache prefix changes once per screenshot rather than
once per iteration. Discovery is untouched (CHE-135 is its ticket).

**A/B, same target, forced full walk, vision nav (`glm-5v-turbo`), Opus synthesis:**

| Run | Date | Window | Run.costUsd | Ledger Σ | Walking (completed attempts) | Σ walking input tok | Σ walking cache-read tok | Calls / journey | Verdict | Journeys |
|-----|------|--------|-------------|----------|------------------------------|---------------------|--------------------------|-----------------|---------|----------|
| #74 | 2026-08-25 | none | **$2.31** | $2.35 | $2.09 (5 journeys) | 1,030,846 | 3,060,104 | 39.6 | mostly_ok | 5 walked, LiveKit call ok |
| #137 | 2026-09-03 | 3 | **$0.80** | $1.35 (see note) | $0.67 (5 journeys) | 174,720 | 1,540,608 | 29.8 | all_good | 5 walked (4 ok, 1 partial), LiveKit call ok |

Walking −68%, run −65% against the criterion of ≤ $1.20. Non-cached input
tokens per walked journey fell ~6× (the images were being re-sent, not only
re-read from cache); cache reads halved because the growing context is half the
size. Verdict quality held: the same five journeys, the live WebRTC coaching
call reported ok, the previously reported PATCH /user 401 confirmed fixed.
n=1 on one app — the fleet number comes from `npm run cost:trend` after a week
of watch runs (CHE-131), which is the check that E3/E4 taught us to wait for.

Note on the ledger: #137's `LlmUsage` carries two extra walking rows ($0.55)
under journey ids that no longer exist — two `walk-N` steps were retried by the
Workflows engine, almost certainly because the CHE-129 deploy landed at 21:33
UTC while this run was walking (deploying mid-run restarts in-flight steps).
`Run.costUsd` counts only the attempts that completed; the ledger counts what
was billed. Both are recorded above; the discrepancy class is CHE-145.
