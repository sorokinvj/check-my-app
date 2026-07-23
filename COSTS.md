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

**Cost model — corrected with real data:** the earlier "well under $1.50" estimate
was wrong for a rich authenticated app. A full joblander-class run (5 journeys
walked end-to-end, each its own agent loop + browser session) costs **~$2.25** on
Sonnet-nav + Opus-synth. The dominant cost is walking, not discovery/synthesis —
each journey is a full 50-iteration loop. Levers if we need to cut this: cap
journeys walked (currently 5), drop walking maxIterations (50), or move walking
to Haiku for the act/observe steps. A discovery-only run (0 journeys) is ~$0.45.

---

## How to measure going forward

- **Per-run Anthropic $**: the agent core logs `[agent] iter N: ... in/cache/out`
  per iteration; CHE-16 persists the rolled-up total to `Run.costUsd`. Read it
  from the DB, not by hand.
- **Cloudflare monthly**: CF dashboard → Billing; Browser Rendering + D1 + R2
  usage meters. Snapshot into the log table above at each milestone gate.
- **Optimization projects** start by quoting the relevant row here as the
  before-number, and add an after-number on completion.
