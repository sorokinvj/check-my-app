# CheckMyApp MCP server

`mcp/server.ts` is a stdio MCP server that lets any coding agent (Claude Code
first, any MCP client) run CheckMyApp production checks as part of its own
loop. It is a thin shim over the public HTTP API — it holds no secrets of its
own and stores nothing locally.

## Install (Claude Code)

From a checkout of this repo:

```bash
claude mcp add checkmyapp -- npx tsx mcp/server.ts
```

## Environment variables

| Variable             | Default                  | Purpose |
|----------------------|--------------------------|---------|
| `CHECKMYAPP_URL`     | `https://checkmyapp.dev` | API base; point at staging/local to test |
| `CHECKMYAPP_API_KEY` | — (anonymous)            | Owner API key (`cma_…`). Runs are attributed to the owner and follow the owner's plan quota instead of the anonymous 1 run / 24h / IP cap |

Create a key in the dashboard → **API keys** (https://checkmyapp.dev/dashboard).
The raw key is shown once at creation; only its SHA-256 hash is stored.
Revoking deletes the key immediately.

With a key:

```bash
claude mcp add checkmyapp -e CHECKMYAPP_API_KEY=cma_xxxxxxxx -- npx tsx mcp/server.ts
```

## Tools

- **`start_check`** `{url, notes?, scope_hints?, notify_email?}` — start a
  production check of a deployed app. Returns `run_id`, `live_url`,
  `verdict_url`. A full check takes ~20–40 minutes. Use `notes` to focus the
  run on what just shipped.
- **`wait_for_run`** `{run_id}` — block until the run is terminal (polls every
  30s, 45-minute cap), then return the verdict, bottom line, findings
  summary (`[severity/category] title`), and the verdict URL. One call, one
  answer — built for post-deploy hooks.
- **`get_check_status`** `{run_id}` — non-blocking poll: phase, terminal flag,
  verdict when done, latest progress events.
- **`get_verdict`** `{domain_or_run_id}` — structured verdict (bottom line,
  journeys, findings with title/category/severity, cost). Accepts a run id or
  a domain/URL; a domain resolves to its latest completed run via
  `/api/checks/lookup` (with an API key, your own runs are included).

## Post-deploy hook recipe

The canonical loop — CI deploys, the agent verifies the deploy actually works:

```
1. deploy finishes → agent calls
   start_check{ url: "https://your-app.com",
                notes: "PR #123 changed the checkout flow — verify checkout first",
                scope_hints: "Do not touch /admin. Do not delete anything." }
2. wait_for_run{ run_id }        # blocks ≤45 min, returns the verdict
3. verdict all_good / mostly_ok  → done, release stands
   verdict needs_attention / broken → file the findings (or roll back),
   linking verdict_url as evidence
```

For Claude Code specifically, a post-deploy hook prompt can be as small as:

> Deploy is out. Use the checkmyapp MCP: start_check on $DEPLOY_URL with notes
> about what this PR changed, then wait_for_run. If the verdict is worse than
> mostly_ok, summarize the findings and file one ticket per critical finding.

## Without MCP

The same API is curl-able: `POST /api/checks` (with
`Authorization: Bearer cma_…` for owner-attributed runs), `GET /api/runs/{id}`,
`GET /api/runs/{id}/verdict`, `GET /api/checks/lookup?url=…`.

## Next (out of scope for v1)

Remote/Streamable-HTTP transport — a hosted MCP endpoint on checkmyapp.dev so
agents can connect without a repo checkout. v1 is stdio-only.
