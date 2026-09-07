# CheckMyApp MCP server

`mcp/server.ts` is a stdio MCP server that lets any coding agent (Claude Code
first, any MCP client) run CheckMyApp production checks as part of its own
loop. It is a thin shim over the public HTTP API — it holds no secrets of its
own and stores nothing locally. The tool logic is in `mcp/tools.ts`; the
contract with the API is pinned by `scripts/verify-mcp.ts` (runs in CI, no
network) and exercised live by `scripts/mcp-smoke.ts` (by hand, one real run).

## Install (Claude Code)

From a checkout of this repo, with an owner API key:

```bash
claude mcp add checkmyapp -e CHECKMYAPP_API_KEY=cma_xxxxxxxx -- npx tsx mcp/server.ts
```

Create a key in the dashboard → **API keys** (https://checkmyapp.dev/dashboard).
The raw key is shown once at creation; only its SHA-256 hash is stored.
Revoking deletes the key immediately.

## Environment variables

| Variable             | Default                  | Purpose |
|----------------------|--------------------------|---------|
| `CHECKMYAPP_URL`     | `https://checkmyapp.dev` | API base; point at staging/local to test |
| `CHECKMYAPP_API_KEY` | —                        | Owner API key (`cma_…`). Runs are attributed to the owner and follow the owner's plan quota. **Required against production**: see below |

**Why the key is required in production.** Anonymous submissions to
`POST /api/checks` must carry a browser Turnstile token, and production has
Turnstile enabled. A machine caller cannot produce that token, so a keyless
`start_check` against checkmyapp.dev is answered `403` with code
`turnstile_failed` every time. API-key callers are exempt from the bot check
(a valid key is a stronger proof than a Turnstile token). Reads
(`get_check_status`, `wait_for_run`, `get_verdict`) work without a key — the
unguessable run id is the capability — but a domain lookup only includes your
own private runs when the key is set.

## Tools

- **`start_check`** `{url, notes?, scope_hints?, notify_email?, deploy_sha?,
  deploy_env?}` — start a production check of a deployed app. Returns
  `run_id`, `reused`, `deploy`, `live_url`, `verdict_url`. A full check takes
  ~20–40 minutes. Use `notes` to focus the run on what just shipped, and
  `deploy_sha` to bind the run to the build it verifies (see
  [Deploy identity](#deploy-identity)). `reused: true` means an anonymous
  submission of a domain with a fresh verdict got that verdict instead of a
  new run — it is not bound to your `deploy_sha`.
- **`wait_for_run`** `{run_id}` — block until the run is terminal (polls every
  30s, 45-minute cap), then return the verdict, bottom line, findings summary
  (`[severity/category] title`), `findings_by_severity`, `cost_usd`, the
  deploy identity, and the verdict URL. Emits an MCP progress notification on
  every poll; see [Long waits](#long-waits). On the cap it returns
  `timed_out: true` with the last status — call it again.
- **`get_check_status`** `{run_id}` — non-blocking poll: status
  (`queued`, `connecting`, `surface_scan`, `discovery`, `walking`, `anatomy`,
  `writing`, then `completed` / `partial` / `failed`), `terminal` flag,
  verdict when done, the latest progress events.
- **`get_verdict`** `{domain_or_run_id}` — structured verdict (bottom line,
  journeys, findings with title/category/severity, `cost_usd`, `deploy`).
  Accepts a run id or a domain/URL; a domain resolves to its latest completed
  run via `/api/checks/lookup` (with an API key, your own runs are included).

Every successful result carries `ok: true`.

## Refusals and error codes

A refusal is never an exception. It is a tool result with `isError: true` and
a JSON body:

```json
{ "ok": false, "code": "quota_site", "error": "<the API's own message>",
  "http_status": 429, "hint": "<what unblocks it>" }
```

| `code`                 | HTTP | Meaning | What to do |
|------------------------|------|---------|------------|
| `quota_site`           | 429  | Today's site-wide free checks are used up (resets midnight UTC) | Set `CHECKMYAPP_API_KEY`; or a $1 one-off check in the browser at `/check`. Do not retry |
| `quota_anon`           | 429  | This network's one anonymous run per day is used | Set `CHECKMYAPP_API_KEY`. Do not retry |
| `quota_free`           | 429  | The Free plan's lifetime runs are used | Upgrade in the dashboard, or enable Daily Watch on an already-checked app. Do not retry |
| `turnstile_failed`     | 403  | Anonymous submission without a browser Turnstile token (always, in production) | Set `CHECKMYAPP_API_KEY` |
| `self_check_read_only` | 403  | The request carried `x-checkmyapp-checker: 1`, the header of CheckMyApp's own checker; such requests never create anything | This server never sends it; something in between added it |
| `invalid_input`        | 400  | The API rejected an argument (the message names it) | Fix the argument |
| `unauthorized`         | 401/403 | Key not accepted, or not the owner of the run | Check the key |
| `not_found`            | 404  | No run with this id | Use the `run_id` from `start_check` |
| `no_completed_run`     | —    | `get_verdict` by domain: the domain has never completed a run | `start_check` it |
| `unavailable`          | 503  | CheckMyApp is temporarily unavailable | Try again in a minute |
| `http_<status>`        | any  | Anything else; `error` is the response text | — |

`quota_*` and `turnstile_failed` are the answers a keyless agent will meet in
production; with a key on a paid plan none of them apply.

## Long waits

A full check runs 20–40 minutes; the MCP SDK's default request timeout is 60
seconds. `wait_for_run` therefore sends a `notifications/progress` on every
poll (once per 30s) when the client passes a progress token. Clients that
reset the request timeout on progress (the TypeScript SDK's
`resetTimeoutOnProgress: true`, plus a `maxTotalTimeout` of about 50 minutes)
can block for the whole run in one call; Claude Code does this on its own.
A client that cannot should poll `get_check_status` instead.

## Post-deploy hook recipe

The canonical loop — CI deploys, the agent verifies the deploy actually works:

```
1. deploy finishes → agent calls
   start_check{ url: "https://your-app.com",
                notes: "PR #123 changed the checkout flow — verify checkout first",
                scope_hints: "Do not touch /admin. Do not delete anything.",
                deploy_sha: "<sha>", deploy_env: "production" }
2. wait_for_run{ run_id }        # blocks ≤45 min, returns the verdict
3. verdict all_good / mostly_ok  → done, release stands
   verdict needs_attention / broken → file the findings (or roll back),
   linking verdict_url as evidence
   isError with a quota code     → stop; the hint says what unblocks it
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
(`production`, `staging`, a preview name). The tool's input schema enforces
the same bounds as the API, so a bad value is refused before a request is
made. Both are optional, but they only earn their keep with an API key: a
`reused` anonymous answer is not bound to your build, and an anonymous run is
not attributed to your account, so nothing later can look it up by build.

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
          RESPONSE=$(curl -s -X POST "https://checkmyapp.dev/api/checks" \
            -H "Authorization: Bearer $CHECKMYAPP_API_KEY" \
            -H "Content-Type: application/json" \
            -d "{\"url\":\"$DEPLOY_URL\",
                 \"deploy\":{\"sha\":\"$SHA\",\"env\":\"production\"},
                 \"userNotes\":\"Post-deploy check for $SHA\"}")
          RUN_ID=$(jq -r '.id // empty' <<<"$RESPONSE")
          # A 429 (quota_site / quota_free) or a 403 answers with no id — fail
          # here, loudly, with the API's code, instead of polling a run that
          # was never created.
          test -n "$RUN_ID" || { echo "::error::CheckMyApp did not start a run: $RESPONSE"; exit 1; }
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
finishing, not your app being broken; the result says so.

## Verifying the server

- `npm run verify:mcp` — the contract test. Stubs `fetch` with answers shaped
  exactly like today's routes (201, 200 `reused`, 429 `quota_*`, 403
  `self_check_read_only`, 403 Turnstile, 400, 404, lookup found / not found),
  checks every tool's result, the input schema bounds, and drives the
  registered server through a real MCP client over an in-memory transport
  (tool list, refusal codes, progress notifications). No network; part of
  `verify:all` and CI.
- `npm run mcp:smoke` — the live smoke. Spawns `mcp/server.ts` over stdio as
  a client would and runs **one** owner-attributed check of
  `https://checkmyapp.dev` (the target is fixed: a smoke never spends a run
  on someone else's site), bound to `origin/main`'s short sha, then
  `get_check_status` three times, `wait_for_run` with progress-reset
  timeouts, `get_verdict`, and prints a summary (run id, verdict, cost,
  duration). Needs `CHECKMYAPP_API_KEY` in `.env`. A refusal is printed and
  the script exits non-zero without retrying. Costs a real run; never in CI.

## Without MCP

The same API is curl-able:

- `POST /api/checks` with `Authorization: Bearer cma_…` — `201 {id}`; a
  refusal is `429 {error, code}` or `403 {error, code}` as in the table above.
- `GET /api/runs/{id}` — status and live events; `404 {error}`.
- `GET /api/runs/{id}/verdict` — the structured verdict; `404 {error}`.
- `GET /api/checks/lookup?url=…` — `{found: false}` or `{found: true, run,
  stale, ageDays, …}`.
- `POST /api/runs/{id}/recheck` — re-run with the same parameters (`201
  {id}`); `?full=1` forces a full walk and is metered per plan and UTC month
  (`201 {id, remaining}`, `403 {error, remaining: 0}` when the allowance is
  used or the caller is anonymous). Not exposed as an MCP tool yet.

## Next (out of scope for v1)

Remote/Streamable-HTTP transport — a hosted MCP endpoint on checkmyapp.dev so
agents can connect without a repo checkout. v1 is stdio-only.
