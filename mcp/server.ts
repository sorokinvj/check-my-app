#!/usr/bin/env npx tsx
// CheckMyApp MCP server (stdio) — lets agentic frameworks (Claude Code, any
// MCP client) run production checks as part of their own loops. The canonical
// use: a post-merge/post-deploy hook asks CheckMyApp to walk the freshly
// deployed app and blocks (or files tickets) on the verdict.
//
//   claude mcp add checkmyapp -- npx tsx mcp/server.ts
//   CHECKMYAPP_URL=https://checkmyapp.dev   # default; point at staging to test
//   CHECKMYAPP_API_KEY=cma_…                # optional owner key (dashboard →
//                                           # API keys): runs as the owner,
//                                           # owner-plan quota, no anon 1/day cap
//
// Tools mirror the public HTTP API. Without a key this process holds no
// secrets and anonymous checks are the free-run funnel; with a key it acts as
// the owner (Bearer auth), and owner features beyond that stay in the web UI.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.CHECKMYAPP_URL ?? "https://checkmyapp.dev";
const API_KEY = process.env.CHECKMYAPP_API_KEY;

// All HTTP goes through here so the owner key (when present) rides every call.
function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (API_KEY) headers.set("Authorization", `Bearer ${API_KEY}`);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

interface RunSnapshot {
  publicId: string;
  status: string;
  verdict: string | null;
  events?: Array<{ text?: string }> | null;
  errorMessage?: string | null;
}

interface VerdictPayload {
  verdict: string | null;
  bottom_line?: string | null;
  findings?: Array<{ title: string; category: string; severity: string }>;
  // Deploy identity (CHE-56); absent on deployments older than that API.
  deploy?: { sha: string; env: string | null } | null;
  [key: string]: unknown;
}

async function getRun(id: string): Promise<RunSnapshot> {
  const res = await api(`/api/runs/${id}`);
  if (!res.ok) throw new Error(`GET /api/runs/${id} → ${res.status}`);
  return (await res.json()) as RunSnapshot;
}

// "joblander.app" / "https://joblander.app" → latest run's publicId via the
// public lookup; a bare run id passes through untouched. Run publicIds are
// cuids (no dots); anything with a dot is a domain.
async function resolveRunId(domainOrRunId: string): Promise<string> {
  const s = domainOrRunId.trim();
  if (!s.includes(".") && !s.includes("/")) return s;
  const res = await api(`/api/checks/lookup?url=${encodeURIComponent(s)}`);
  if (!res.ok) throw new Error(`lookup failed for "${s}": ${res.status}`);
  const data = (await res.json()) as { found: boolean; run?: { publicId: string } };
  if (!data.found || !data.run) {
    throw new Error(`No completed run found for "${s}". Start one with start_check.`);
  }
  return data.run.publicId;
}

const TERMINAL = ["completed", "partial", "failed"];

const server = new McpServer({ name: "checkmyapp", version: "1.2.0" });

server.tool(
  "start_check",
  "Start a CheckMyApp production check of a deployed web app. Returns the run id " +
    "plus live and verdict URLs. A full check takes ~20-40 minutes; call " +
    "wait_for_run (blocking) or poll get_check_status. Use notes to focus the " +
    "agent on what just shipped (e.g. 'PR #123 changed checkout — verify it first'). " +
    "With CHECKMYAPP_API_KEY set the run is attributed to the key's owner and " +
    "follows their plan quota; anonymous callers get 1 free run per 24h. Pass " +
    "deploy_sha (and deploy_env) in CI so the verdict names the exact build it " +
    "checked — that is what makes the result safe to gate a release on.",
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
    deploy_sha: z
      .string()
      .optional()
      .describe("Commit/build id this deploy shipped, e.g. $GITHUB_SHA — binds the verdict to it"),
    deploy_env: z
      .string()
      .optional()
      .describe("Environment the deploy landed in, e.g. production or staging"),
  },
  async ({ url, notes, scope_hints, notify_email, deploy_sha, deploy_env }) => {
    const res = await api(`/api/checks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        userNotes: notes,
        scopeHints: scope_hints,
        notifyEmail: notify_email,
        // Omitted entirely without a sha: `env` alone identifies no build.
        deploy: deploy_sha ? { sha: deploy_sha, env: deploy_env } : undefined,
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
            deploy: deploy_sha ? { sha: deploy_sha, env: deploy_env ?? null } : null,
            live_url: `${BASE}/run/${id}`,
            verdict_url: `${BASE}/verdict/${id}`,
            hint: "Call wait_for_run to block until the verdict, or poll get_check_status.",
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
    const terminal = TERMINAL.includes(run.status);
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
  "wait_for_run",
  "Block until a CheckMyApp run finishes, then return the full verdict (bottom " +
    "line, findings by severity, verdict URL). Polls every 30s, gives up after " +
    "45 minutes (returning the last known status). Use after start_check in " +
    "post-deploy hooks: one call, one answer.",
  { run_id: z.string().describe("Run id returned by start_check") },
  async ({ run_id }) => {
    const POLL_MS = 30_000;
    const CAP_MS = 45 * 60_000;
    const startedAt = Date.now();
    let run = await getRun(run_id);
    while (!TERMINAL.includes(run.status) && Date.now() - startedAt < CAP_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      run = await getRun(run_id);
    }

    if (!TERMINAL.includes(run.status)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              timed_out: true,
              waited_minutes: Math.round((Date.now() - startedAt) / 60_000),
              status: run.status,
              hint: "Run still in progress after 45 min — call wait_for_run again or check the live URL.",
              live_url: `${BASE}/run/${run_id}`,
            }),
          },
        ],
      };
    }

    // Terminal: return the structured verdict with a findings roll-up.
    const res = await api(`/api/runs/${run_id}/verdict`);
    const verdict: VerdictPayload = res.ok
      ? ((await res.json()) as VerdictPayload)
      : { verdict: run.verdict };
    const findings = verdict.findings ?? [];
    const bySeverity: Record<string, number> = {};
    for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: run.status,
            verdict: verdict.verdict ?? run.verdict,
            // Which build this verdict is about — null when the run named none,
            // so a CI gate can refuse to pass on someone else's run.
            deploy: verdict.deploy ?? null,
            bottom_line: verdict.bottom_line ?? null,
            findings_by_severity: bySeverity,
            findings: findings.map((f) => `[${f.severity}/${f.category}] ${f.title}`),
            error: run.errorMessage ?? null,
            verdict_url: `${BASE}/verdict/${run_id}`,
          }),
        },
      ],
    };
  },
);

server.tool(
  "get_verdict",
  "Full verdict of a completed run: bottom line, per-journey outcomes, findings " +
    "(title/category/severity), cost, and the deploy identity the run was bound " +
    "to (`deploy: {sha, env}`, null if none). Accepts a run id OR a domain/URL — a " +
    "domain resolves to its latest completed run. Use this to decide whether the " +
    "deploy is healthy (all_good / mostly_ok) or needs action (needs_attention / " +
    "broken). A verdict of `unverified` means the check walked nothing — no " +
    "signal either way.",
  {
    domain_or_run_id: z
      .string()
      .describe("Run id from start_check, or a domain/URL (e.g. your-app.com) for its latest run"),
  },
  async ({ domain_or_run_id }) => {
    const run_id = await resolveRunId(domain_or_run_id);
    const res = await api(`/api/runs/${run_id}/verdict`);
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
    const payload = (await res.json()) as VerdictPayload;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...payload, verdict_url: `${BASE}/verdict/${run_id}` }),
        },
      ],
    };
  },
);

// No top-level await: tsx transpiles this file as CJS (repo tsconfig).
const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("[checkmyapp-mcp] failed to start:", err);
  process.exit(1);
});
