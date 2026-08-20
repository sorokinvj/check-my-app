#!/usr/bin/env npx tsx
// CheckMyApp MCP server (stdio) — lets agentic frameworks (Claude Code, any
// MCP client) run production checks as part of their own loops. The canonical
// use: a post-merge/post-deploy hook asks CheckMyApp to walk the freshly
// deployed app and blocks (or files tickets) on the verdict.
//
//   claude mcp add checkmyapp -- npx tsx mcp/server.ts
//   CHECKMYAPP_URL=https://checkmyapp.dev   # default; point at staging to test
//
// Tools mirror the public HTTP API — this process holds no secrets; anonymous
// checks are the free-run funnel, owner features stay in the web UI.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.CHECKMYAPP_URL ?? "https://checkmyapp.dev";

interface RunSnapshot {
  publicId: string;
  status: string;
  verdict: string | null;
  events?: Array<{ text?: string }> | null;
  errorMessage?: string | null;
}

async function getRun(id: string): Promise<RunSnapshot> {
  const res = await fetch(`${BASE}/api/runs/${id}`);
  if (!res.ok) throw new Error(`GET /api/runs/${id} → ${res.status}`);
  return (await res.json()) as RunSnapshot;
}

const server = new McpServer({ name: "checkmyapp", version: "1.0.0" });

server.tool(
  "start_check",
  "Start a CheckMyApp production check of a deployed web app. Returns the run id " +
    "plus live and verdict URLs. A full check takes ~20-40 minutes; poll " +
    "get_check_status. Use notes to focus the agent on what just shipped " +
    "(e.g. 'PR #123 changed the checkout flow — verify checkout first').",
  {
    url: z.string().url().describe("Deployed app URL to check, e.g. https://your-app.com"),
    notes: z
      .string()
      .optional()
      .describe("What to focus on this run (recently merged changes, critical flows)"),
    scope_hints: z
      .string()
      .optional()
      .describe("Hard limits, e.g. 'Do not touch /admin. Do not delete anything.'"),
    notify_email: z.string().email().optional().describe("Email for the verdict-ready notice"),
  },
  async ({ url, notes, scope_hints, notify_email }) => {
    const res = await fetch(`${BASE}/api/checks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        userNotes: notes,
        scopeHints: scope_hints,
        notifyEmail: notify_email,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`start_check failed: ${res.status} ${body}`);
    }
    const { id } = (await res.json()) as { id: string };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            run_id: id,
            live_url: `${BASE}/run/${id}`,
            verdict_url: `${BASE}/verdict/${id}`,
            hint: "Poll get_check_status every few minutes until status is terminal.",
          }),
        },
      ],
    };
  },
);

server.tool(
  "get_check_status",
  "Status of a CheckMyApp run: phase (connecting/surface_scan/discovery/walking/" +
    "anatomy/writing), terminal state (completed/partial/failed), verdict when done, " +
    "and the latest progress events.",
  { run_id: z.string().describe("Run id returned by start_check") },
  async ({ run_id }) => {
    const run = await getRun(run_id);
    const terminal = ["completed", "partial", "failed"].includes(run.status);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: run.status,
            terminal,
            verdict: run.verdict,
            error: run.errorMessage ?? null,
            recent_events: (run.events ?? []).slice(-5).map((e) => e.text),
            verdict_url: terminal ? `${BASE}/verdict/${run_id}` : null,
          }),
        },
      ],
    };
  },
);

server.tool(
  "get_verdict",
  "Full verdict of a completed run: bottom line, per-journey outcomes, findings " +
    "by severity, and cost. Use this to decide whether the deploy is healthy " +
    "(all_good / mostly_ok) or needs action (needs_attention / broken). " +
    "A verdict of `unverified` means the check walked nothing — no signal either way.",
  { run_id: z.string().describe("Run id of a completed check") },
  async ({ run_id }) => {
    const res = await fetch(`${BASE}/api/runs/${run_id}/verdict`);
    if (res.status === 404) {
      // Older deployments without the verdict API — degrade to the status view.
      const run = await getRun(run_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              verdict: run.verdict,
              verdict_url: `${BASE}/verdict/${run_id}`,
              note: "Structured verdict API unavailable; open verdict_url for details.",
            }),
          },
        ],
      };
    }
    if (!res.ok) throw new Error(`get_verdict failed: ${res.status}`);
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

// No top-level await: tsx transpiles this file as CJS (repo tsconfig).
const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("[checkmyapp-mcp] failed to start:", err);
  process.exit(1);
});
