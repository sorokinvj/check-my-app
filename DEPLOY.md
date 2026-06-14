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
