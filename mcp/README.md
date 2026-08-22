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

- **`start_check`** `{url, notes?, scope_hints?, notify_email?, deploy_sha?,
  deploy_env?}` — start a production check of a deployed app. Returns `run_id`,
  `live_url`, `verdict_url`. A full check takes ~20–40 minutes. Use `notes` to
  focus the run on what just shipped, and `deploy_sha` to bind the run to the
  build it verifies (see [Deploy identity](#deploy-identity)).
- **`wait_for_run`** `{run_id}` — block until the run is terminal (polls every
  30s, 45-minute cap), then return the verdict, bottom line, findings
  summary (`[severity/category] title`), the deploy identity, and the verdict
  URL. One call, one answer — built for post-deploy hooks.
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

## Deploy identity

`start_check` takes an optional `deploy_sha` (plus `deploy_env`), stored on the
run and echoed back by `wait_for_run`, `get_verdict`, the verdict page header,
and the outbound webhook as `deploy: { sha, env }` (`null` when the run named
no build). It is what turns "the app is fine" into "**this build** is fine" —
without it, a gate can pass on a verdict that describes whatever was deployed
an hour ago.

`sha` is 7–64 characters of `[A-Za-z0-9._-]`, so a short sha, a merge-commit
sha, or a non-git build id all work. `env` is free text up to 40 characters
(`production`, `staging`, a preview name). Both are optional and available on
every submit path, but they only earn their keep with an API key: an anonymous
run isn't attributed to your account, so nothing later can look it up by build.

## CI gate recipe

The full loop: deploy, check the deploy, fail the job when the app is worse
than `mostly_ok`. Verdicts rank `all_good` > `mostly_ok` > `needs_attention` >
`broken`; `unverified` means the check walked nothing, which is no signal
either way — it must not count as a pass.

A check takes ~20–40 minutes, so run this as a **separate post-deploy job**
that gates promotion or triggers a rollback, not as a blocking step in the
deploy itself.

```yaml
# .github/workflows/post-deploy-check.yml
name: post-deploy check
on:
  workflow_run:
    workflows: [deploy]          # your existing deploy workflow
    types: [completed]

jobs:
  checkmyapp:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      CHECKMYAPP_API_KEY: ${{ secrets.CHECKMYAPP_API_KEY }}
      DEPLOY_URL: https://your-app.com
      SHA: ${{ github.event.workflow_run.head_sha }}
    steps:
      - name: Start the check, bound to this commit
        id: start
        run: |
          RUN_ID=$(curl -sf -X POST "https://checkmyapp.dev/api/checks" \
            -H "Authorization: Bearer $CHECKMYAPP_API_KEY" \
            -H "Content-Type: application/json" \
            -d "{\"url\":\"$DEPLOY_URL\",
                 \"deploy\":{\"sha\":\"$SHA\",\"env\":\"production\"},
                 \"userNotes\":\"Post-deploy check for $SHA\"}" \
            | jq -r '.id // empty')
          # A 429 (plan quota) or 403 answers with no id — fail here, loudly,
          # instead of polling a run that was never created.
          test -n "$RUN_ID" || { echo "::error::CheckMyApp did not start a run"; exit 1; }
          echo "run_id=$RUN_ID" >> "$GITHUB_OUTPUT"
          echo "Verdict will appear at https://checkmyapp.dev/verdict/$RUN_ID"

      - name: Wait for the verdict and gate on it
        run: |
          RUN_ID='${{ steps.start.outputs.run_id }}'
          # Reads need no key: the unguessable run id is the capability.
          for _ in $(seq 1 90); do          # 90 × 30s = 45 min
            STATUS=$(curl -s "https://checkmyapp.dev/api/runs/$RUN_ID" | jq -r '.status // empty')
            case "$STATUS" in completed|partial|failed) break ;; esac
            sleep 30
          done

          VERDICT=$(curl -s "https://checkmyapp.dev/api/runs/$RUN_ID/verdict" \
            | jq -r '.verdict // empty')
          echo "Verdict: $VERDICT — https://checkmyapp.dev/verdict/$RUN_ID"

          # Pass-list, not a fail-list: an unknown or missing verdict (timeout,
          # `unverified`, a value added later) fails the gate rather than
          # sneaking through as "not one of the bad ones".
          case "$VERDICT" in
            all_good|mostly_ok) exit 0 ;;
            *) echo "::error::CheckMyApp verdict '$VERDICT' for $SHA"; exit 1 ;;
          esac
```

With an agent in CI, the same gate is a prompt over the MCP tools — the agent
can also file tickets for what it found instead of only failing the job:

> Use the checkmyapp MCP. `start_check` on `$DEPLOY_URL` with
> `deploy_sha: $GITHUB_SHA`, `deploy_env: production`, and notes describing
> what this commit changed. Then `wait_for_run`. If the verdict is not
> `all_good` or `mostly_ok`, print the findings and exit non-zero.

Two things worth keeping: `wait_for_run` gates on the run *you* started, so
resolving a verdict by domain instead (`get_verdict{ domain_or_run_id:
"your-app.com" }`) can hand you an older deploy's result — check the returned
`deploy.sha` before acting on it. And a `failed` run is CheckMyApp not
finishing, not your app being broken; the verdict URL says which.

## Without MCP

The same API is curl-able: `POST /api/checks` (with
`Authorization: Bearer cma_…` for owner-attributed runs), `GET /api/runs/{id}`,
`GET /api/runs/{id}/verdict`, `GET /api/checks/lookup?url=…`.

## Next (out of scope for v1)

Remote/Streamable-HTTP transport — a hosted MCP endpoint on checkmyapp.dev so
agents can connect without a repo checkout. v1 is stdio-only.
