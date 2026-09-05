# Deploy — Cloudflare (milestone 2)

Two Workers: **checkmyapp-web** (Next.js via OpenNext) and **checkmyapp-agent**
(durable `CheckRunWorkflow` + Browser Rendering). Both share a D1 database and
an R2 bucket. **Workers Paid is required** for sustained Browser Rendering
(Free = 10 browser-min/day; one full run ≈ 20 min).

## One-time provisioning

```bash
# D1 database (capture the database_id into both wrangler*.jsonc)
npx wrangler d1 create checkmyapp

# R2 bucket
npx wrangler r2 bucket create checkmyapp-evidence
# Optional: 90-day retention lifecycle rule (CHE-12) via dashboard or API.

# Secrets — set on the AGENT worker (it runs the LLM + decrypts credentials)
npx wrangler secret put ANTHROPIC_API_KEY   --config wrangler-agent.jsonc
npx wrangler secret put CREDENTIALS_SECRET  --config wrangler-agent.jsonc
# Turnstile (CHE-18) — set on the WEB worker
npx wrangler secret put TURNSTILE_SECRET
# NEXT_PUBLIC_TURNSTILE_SITE_KEY is a build-time public var (vars, not secret).
```

## Deploy (also automated in CI — `.github/workflows/ci.yml`)

```bash
npx prisma generate                                   # workerd client
npx wrangler d1 migrations apply checkmyapp --remote  # schema
npx wrangler deploy --config wrangler-agent.jsonc     # agent worker (defines the Workflow)
npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy  # web worker
```

The web worker binds the agent's `CheckRunWorkflow` cross-worker (`script_name`
in `wrangler.jsonc`), so deploy the agent first.

## Site-wide free-check cap (launch day)

The site runs a fixed number of free anonymous checks per UTC day (default 20,
`ANON_RUNS_PER_DAY_SITE` in `src/lib/plans.ts`). The running cap can be raised or
lowered without a deploy: set the env var on the **web** worker and it takes
effect on the next request, in the gate, on `/checks/today`, and in the form's
counter. Only a positive integer counts; unset, empty or garbage means the
default, so a typo cannot open or close the site. No agent-worker redeploy.

```bash
# Launch day: 100 free checks (type 100 at the prompt)
npx wrangler secret put ANON_RUNS_PER_DAY_SITE
# The day after: back to the default
npx wrangler secret delete ANON_RUNS_PER_DAY_SITE     # or put 20
```

## CI secrets (GitHub → repo settings → secrets)

- `CLOUDFLARE_API_TOKEN` — scoped to Workers Scripts + D1 + R2 edit
- `CLOUDFLARE_ACCOUNT_ID`

## Security (CHE-18)

- Test credentials: AES-256-GCM at rest (`CREDENTIALS_SECRET`), decrypted only
  in-memory in the walking step, never logged, scrubbed from transcripts, blurred
  in screenshots; cleared after a terminal run unless a Watch retains them.
- R2 is private — evidence is proxied through the web Worker (`/api/evidence`);
  keys are content-addressed and the verdict permalink is unguessable.
- Turnstile gates `/check`; add a Cloudflare WAF rate-limit rule on `/api/checks`.

## Stripe setup (CHE-40 phase 3)

Billing code is deployed but inert until these exist — endpoints answer 503
`billing_unconfigured` and the pricing CTAs show a "launches soon" note.

1. In the Stripe dashboard create one product ("CheckMyApp") with two
   **monthly** recurring prices: Starter $29/mo and Growth $99/mo. Capture the
   two `price_…` ids.
2. Set the four env values:

```bash
# Secrets — set on the WEB worker (checkout + webhook run there)
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Also add all four (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`) to the local `.env` for build
parity, then re-sync the `WEB_BUILD_DOTENV` GitHub secret from it (CI writes
that secret out as `.env` before the OpenNext build).

3. Register a webhook endpoint at `https://checkmyapp.dev/api/webhooks/stripe`
   listening for `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted` — its signing secret is the
   `STRIPE_WEBHOOK_SECRET` above.

Price↔plan mapping: `STRIPE_PRICE_STARTER` → `plan=starter`,
`STRIPE_PRICE_GROWTH` → `plan=growth`; subscription deleted / past-due →
`free`. Business/enterprise stay manual (mailto), no Stripe involved.
