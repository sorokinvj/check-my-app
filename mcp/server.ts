#!/usr/bin/env npx tsx
// CheckMyApp MCP server (stdio) — lets agentic frameworks (Claude Code, any
// MCP client) run production checks as part of their own loops. The canonical
// use: a post-merge/post-deploy hook asks CheckMyApp to walk the freshly
// deployed app and blocks (or files tickets) on the verdict.
//
//   claude mcp add checkmyapp -e CHECKMYAPP_API_KEY=cma_… -- npx tsx mcp/server.ts
//   CHECKMYAPP_URL=https://checkmyapp.dev   # default; point at staging to test
//   CHECKMYAPP_API_KEY=cma_…                # owner key (dashboard → API keys):
//                                           # runs as the owner, owner-plan quota.
//                                           # Required against production —
//                                           # anonymous submissions need a
//                                           # browser Turnstile token there.
//
// The tools themselves live in mcp/tools.ts (plain functions over the public
// HTTP API, verified by scripts/verify-mcp.ts without a network). This file is
// only the transport: it registers them and turns the blocking tools' polling
// into MCP progress notifications so a client that resets its request timeout
// on progress can block for the whole run.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTools, inputSchemas, type Tools } from "./tools";

export const SERVER_VERSION = "1.4.0";

export function registerTools(server: McpServer, tools: Tools): void {
  server.registerTool(
    "start_check",
    {
      description:
        "Start a CheckMyApp production check of a deployed web app. Returns the run id " +
        "plus live and verdict URLs. A full check takes ~20-40 minutes; call " +
        "wait_for_run (blocking) or poll get_check_status. Use notes to focus the " +
        "agent on what just shipped (e.g. 'PR #123 changed checkout — verify it first'). " +
        "Set CHECKMYAPP_API_KEY: the run is then attributed to the key's owner and follows " +
        "their plan quota, and the API's bot check does not apply. A refusal comes back " +
        "with isError and a stable `code` (quota_site, quota_anon, quota_free, " +
        "turnstile_failed, self_check_read_only, ephemeral_requires_owner, invalid_input) plus " +
        "a hint — do not retry a quota refusal. Pass deploy_sha (and deploy_env) in CI so the " +
        "verdict names the exact build it checked — that is what makes the result safe to gate " +
        "a release on. Set ephemeral: true for a throwaway hostname such as a PR preview: it " +
        "needs the owner API key (an anonymous ephemeral request is refused with code " +
        "ephemeral_requires_owner), the run stays private and is never listed publicly, no app " +
        "is created or kept for the hostname, and the run is deleted after about 7 days.",
      inputSchema: inputSchemas.start_check,
    },
    (args) => tools.start_check(args),
  );

  server.registerTool(
    "get_check_status",
    {
      description:
        "Status of a CheckMyApp run: phase (queued/connecting/surface_scan/discovery/" +
        "walking/anatomy/writing), terminal state (completed/partial/failed), verdict " +
        "when done, and the latest progress events. isError with code not_found when the " +
        "id is unknown.",
      inputSchema: inputSchemas.get_check_status,
    },
    (args) => tools.get_check_status(args),
  );

  server.registerTool(
    "wait_for_run",
    {
      description:
        "Block until a CheckMyApp run finishes, then return the full verdict (bottom " +
        "line, findings by severity, cost, verdict URL). Polls every 30s, gives up after " +
        "45 minutes (returning timed_out with the last known status — call again). Emits " +
        "MCP progress notifications on every poll, so pass a progress token and reset " +
        "the request timeout on progress. Use after start_check in post-deploy hooks: " +
        "one call, one answer. A `failed` status is CheckMyApp not finishing, not the " +
        "app being broken.",
      inputSchema: inputSchemas.wait_for_run,
    },
    (args, extra) =>
      tools.wait_for_run(args, {
        signal: extra.signal,
        onProgress: async (p) => {
          const progressToken = extra._meta?.progressToken;
          if (progressToken === undefined) return;
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: p.polls,
              message: `${p.status} · ${p.elapsed_s}s elapsed`,
            },
          });
        },
      }),
  );

  server.registerTool(
    "get_verdict",
    {
      description:
        "Full verdict of a completed run: bottom line, per-journey outcomes, findings " +
        "(title/category/severity), cost_usd, and the deploy identity the run was bound " +
        "to (`deploy: {sha, env}`, null if none). Accepts a run id OR a domain/URL — a " +
        "domain resolves to its latest completed run (with an API key, your own runs " +
        "included). Use this to decide whether the deploy is healthy (all_good / " +
        "mostly_ok) or needs action (needs_attention / broken). A verdict of " +
        "`unverified` means the check walked nothing — no signal either way. isError with " +
        "code not_found (unknown id) or no_completed_run (domain never completed a run).",
      inputSchema: inputSchemas.get_verdict,
    },
    (args) => tools.get_verdict(args),
  );

  server.registerTool(
    "get_review",
    {
      description:
        "The run's result in the shape you act on — this is the tool to call when you are " +
        "going to fix what the check found. Where get_verdict answers 'is the deploy fine?', " +
        "this returns every finding in full (where it happens, what was tried, what happened, " +
        "why it matters, evidence URLs), every journey step as walked, the pages and steps " +
        "that were not covered, and for each finding the sentence that says when it counts as " +
        "gone (`next_actions`). It names symptoms and evidence, never files or fixes — what to " +
        "change is your call. isError with code not_found when the id is unknown.",
      inputSchema: inputSchemas.get_review,
    },
    (args) => tools.get_review(args),
  );

  server.registerTool(
    "wait_for_review",
    {
      description:
        "Block until a CheckMyApp run finishes, then return get_review's payload — the one " +
        "call for 'check this deploy and give me something I can work from'. Same polling as " +
        "wait_for_run (every 30s, 45-minute cap, MCP progress notifications: pass a progress " +
        "token and reset the request timeout on progress), and on the cap it returns " +
        "timed_out with the last status. The result opens with a head — verdict, findings by " +
        "severity, how many next_actions — and carries the whole review under `review`.",
      inputSchema: inputSchemas.wait_for_review,
    },
    (args, extra) =>
      tools.wait_for_review(args, {
        signal: extra.signal,
        onProgress: async (p) => {
          const progressToken = extra._meta?.progressToken;
          if (progressToken === undefined) return;
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: p.polls,
              message: `${p.status} · ${p.elapsed_s}s elapsed`,
            },
          });
        },
      }),
  );
}

export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer({ name: "checkmyapp", version: SERVER_VERSION });
  const tools = createTools({
    base: env.CHECKMYAPP_URL ?? "https://checkmyapp.dev",
    apiKey: env.CHECKMYAPP_API_KEY || undefined,
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  });
  registerTools(server, tools);
  return server;
}

// Entry point only when run directly (tsx transpiles this file as CJS — repo
// tsconfig — so `require.main` is the test). Importing it registers nothing
// and opens no transport.
if (require.main === module) {
  const transport = new StdioServerTransport();
  createServer()
    .connect(transport)
    .catch((err) => {
      console.error("[checkmyapp-mcp] failed to start:", err);
      process.exit(1);
    });
}
