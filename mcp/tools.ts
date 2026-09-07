// The CheckMyApp MCP tools, as plain functions over the public HTTP API.
//
// mcp/server.ts registers these on a stdio McpServer; scripts/verify-mcp.ts
// calls them directly with a stubbed fetch. Everything that touches the
// outside world — fetch, the clock, sleeping between polls — comes in through
// `deps`, so the contract can be verified without a network and without
// waiting 30 seconds per poll.
//
// Contract with the API (CHE-200, 2026-09-07 — the routes this mirrors):
//   POST /api/checks                201 {id} | 200 {id, reused: true} (anonymous,
//                                   fresh verdict exists) | 400 {error} |
//                                   403 {error} (Turnstile, anonymous only) |
//                                   403 {error, code: "self_check_read_only"} |
//                                   429 {error, code: quota_site|quota_anon|quota_free}
//   GET  /api/runs/{id}             200 {publicId, status, verdict, events, errorMessage, …} | 404 {error}
//   GET  /api/runs/{id}/verdict     200 {verdict, deploy, bottom_line, journeys, findings, cost_usd, …} | 404 {error}
//   GET  /api/checks/lookup?url=…   200 {found: false} | {found: true, run: {publicId, …}, stale, ageDays, …}
//
// A refusal is never thrown: it comes back as a tool result with `isError`
// and a stable `code`, so the calling agent can branch on it (quota → stop,
// not_found → wrong id) instead of parsing an exception string.

import { z } from "zod";

export interface ToolDeps {
  base: string;
  apiKey?: string;
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

// Every status that can come back from GET /api/runs/{id}. The three terminal
// ones are what wait_for_run waits for; a `failed` run is CheckMyApp not
// finishing, not the checked app being broken.
export const TERMINAL_STATUSES = ["completed", "partial", "failed"] as const;

export const WAIT_POLL_MS = 30_000;
export const WAIT_CAP_MS = 45 * 60_000;

// Stable failure codes a tool result can carry. The API's own codes pass
// through untouched; the rest are derived here from status + message when the
// route answers with `{error}` alone.
export type FailureCode =
  | "quota_site"
  | "quota_anon"
  | "quota_free"
  | "self_check_read_only"
  | "turnstile_failed"
  | "invalid_input"
  | "unauthorized"
  | "not_found"
  | "unavailable"
  | "no_completed_run"
  | `http_${number}`;

export interface Failure {
  ok: false;
  code: FailureCode;
  error: string;
  http_status: number | null;
  hint: string;
  remaining?: number;
}

export const inputSchemas = {
  start_check: {
    url: z.string().url().describe("Deployed app URL to check, e.g. https://your-app.com"),
    notes: z
      .string()
      .max(2000)
      .optional()
      .describe("What to focus on this run (recently merged changes, critical flows)"),
    scope_hints: z
      .string()
      .max(2000)
      .optional()
      .describe("Hard limits, e.g. 'Do not touch /admin. Do not delete anything.'"),
    notify_email: z.string().email().optional().describe("Email for the verdict-ready notice"),
    deploy_sha: z
      .string()
      .min(7)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional()
      .describe("Commit/build id this deploy shipped, e.g. $GITHUB_SHA — binds the verdict to it"),
    deploy_env: z
      .string()
      .max(40)
      .optional()
      .describe("Environment the deploy landed in, e.g. production or staging"),
  },
  get_check_status: {
    run_id: z.string().describe("Run id returned by start_check"),
  },
  wait_for_run: {
    run_id: z.string().describe("Run id returned by start_check"),
  },
  get_verdict: {
    domain_or_run_id: z
      .string()
      .describe("Run id from start_check, or a domain/URL (e.g. your-app.com) for its latest run"),
  },
};

export type StartCheckArgs = {
  url: string;
  notes?: string;
  scope_hints?: string;
  notify_email?: string;
  deploy_sha?: string;
  deploy_env?: string;
};

export interface WaitProgress {
  polls: number;
  status: string;
  elapsed_s: number;
}

export interface WaitOptions {
  onProgress?: (p: WaitProgress) => Promise<void> | void;
  signal?: AbortSignal;
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
  status?: string;
  bottom_line?: string | null;
  findings?: Array<{ title: string; category: string; severity: string }>;
  deploy?: { sha: string; env: string | null } | null;
  cost_usd?: number | null;
  [key: string]: unknown;
}

function text(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError } : {}) };
}

export function createTools(deps: ToolDeps) {
  const { base } = deps;

  // All HTTP goes through here so the owner key (when present) rides every
  // call. Nothing else is added: in particular never the self-check header —
  // that marks CheckMyApp's own checker, and a request carrying it creates
  // nothing (CHE-193).
  function api(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (deps.apiKey) headers.set("Authorization", `Bearer ${deps.apiKey}`);
    return deps.fetch(`${base}${path}`, { ...init, headers });
  }

  function hintFor(code: FailureCode): string {
    switch (code) {
      case "quota_site":
        return (
          "Today's free checks are used up for everyone; the cap resets at midnight UTC. " +
          "Set CHECKMYAPP_API_KEY (dashboard → API keys) to run as your account instead of " +
          `anonymously, or buy a $1 one-off check in the browser at ${base}/check.`
        );
      case "quota_anon":
        return (
          "That was the anonymous free run for today from this network. Set " +
          "CHECKMYAPP_API_KEY (dashboard → API keys) to run as your account."
        );
      case "quota_free":
        return (
          "The Free plan's lifetime runs are used. Upgrade the plan in the dashboard " +
          `(${base}/dashboard) or enable Daily Watch on an app you have already checked.`
        );
      case "self_check_read_only":
        return (
          "The request carried the header that marks CheckMyApp's own checker " +
          "(x-checkmyapp-checker: 1); such requests never create runs. This server does not " +
          "send it — something between this process and the API added it."
        );
      case "turnstile_failed":
        return (
          "Anonymous submissions need a browser proof-of-human token, which a machine caller " +
          "cannot produce. Set CHECKMYAPP_API_KEY (dashboard → API keys): key-authenticated " +
          "callers are exempt."
        );
      case "not_found":
        return "No run with this id. Use the run_id start_check returned; get_verdict also accepts a domain.";
      case "no_completed_run":
        return "Start one with start_check, or wait for the run in progress to finish.";
      case "invalid_input":
        return "Fix the argument the error names and call again.";
      case "unauthorized":
        return "The API key was not accepted. Check CHECKMYAPP_API_KEY (dashboard → API keys).";
      case "unavailable":
        return "CheckMyApp answered that it is temporarily unavailable. Try again in a minute.";
      default:
        return "Unexpected answer from CheckMyApp. The verdict page or the API status may say more.";
    }
  }

  async function failure(res: Response): Promise<ToolResult> {
    const raw = await res.text();
    let body: { error?: unknown; code?: unknown; remaining?: unknown } = {};
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      // Not JSON (an HTML error page, an empty body): the text is the message.
    }
    const error = typeof body.error === "string" ? body.error : raw.slice(0, 300) || res.statusText;
    let code: FailureCode;
    if (typeof body.code === "string") {
      code = body.code as FailureCode;
    } else if (res.status === 403 && /verification failed/i.test(error)) {
      code = "turnstile_failed";
    } else if (res.status === 400) {
      code = "invalid_input";
    } else if (res.status === 401) {
      code = "unauthorized";
    } else if (res.status === 403) {
      code = "unauthorized";
    } else if (res.status === 404) {
      code = "not_found";
    } else if (res.status === 503) {
      code = "unavailable";
    } else {
      code = `http_${res.status}`;
    }
    const out: Failure = { ok: false, code, error, http_status: res.status, hint: hintFor(code) };
    if (typeof body.remaining === "number") out.remaining = body.remaining;
    return text(out, true);
  }

  async function getRun(id: string): Promise<RunSnapshot | ToolResult> {
    const res = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (!res.ok) return failure(res);
    return (await res.json()) as RunSnapshot;
  }

  function isResult(x: unknown): x is ToolResult {
    return typeof x === "object" && x !== null && Array.isArray((x as ToolResult).content);
  }

  // "joblander.app" / "https://joblander.app" → latest completed run via the
  // public lookup (an API key includes the owner's private runs); a bare run
  // id passes through. Run ids are cuids (no dots); anything with a dot or a
  // slash is a domain.
  async function resolveRunId(domainOrRunId: string): Promise<string | ToolResult> {
    const s = domainOrRunId.trim();
    if (!s.includes(".") && !s.includes("/")) return s;
    const res = await api(`/api/checks/lookup?url=${encodeURIComponent(s)}`);
    if (!res.ok) return failure(res);
    const data = (await res.json()) as { found: boolean; run?: { publicId: string } };
    if (!data.found || !data.run) {
      const out: Failure = {
        ok: false,
        code: "no_completed_run",
        error: `No completed run found for "${s}".`,
        http_status: null,
        hint: hintFor("no_completed_run"),
      };
      return text(out, true);
    }
    return data.run.publicId;
  }

  const isTerminal = (status: string) =>
    (TERMINAL_STATUSES as readonly string[]).includes(status);

  return {
    async start_check(args: StartCheckArgs): Promise<ToolResult> {
      const { url, notes, scope_hints, notify_email, deploy_sha, deploy_env } = args;
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
      if (!res.ok) return failure(res);
      const { id, reused } = (await res.json()) as { id: string; reused?: boolean };
      const deploy = deploy_sha ? { sha: deploy_sha, env: deploy_env ?? null } : null;
      return text({
        ok: true,
        run_id: id,
        // 200 {reused: true}: an anonymous submission of a domain with a fresh
        // completed verdict gets that verdict, not a new run. It is not bound
        // to deploy_sha and describes whatever was deployed when it ran.
        reused: reused === true,
        deploy: reused ? null : deploy,
        live_url: `${base}/run/${id}`,
        verdict_url: `${base}/verdict/${id}`,
        hint: reused
          ? "An existing recent verdict for this domain was returned instead of a new run " +
            "(anonymous callers only). It is not bound to your deploy_sha; set CHECKMYAPP_API_KEY " +
            "for a fresh, attributed run."
          : "Call wait_for_run to block until the verdict, or poll get_check_status.",
      });
    },

    async get_check_status(args: { run_id: string }): Promise<ToolResult> {
      const run = await getRun(args.run_id);
      if (isResult(run)) return run;
      const terminal = isTerminal(run.status);
      return text({
        ok: true,
        run_id: run.publicId,
        status: run.status,
        terminal,
        verdict: run.verdict,
        error: run.errorMessage ?? null,
        recent_events: (run.events ?? []).slice(-5).map((e) => e.text),
        live_url: `${base}/run/${run.publicId}`,
        verdict_url: terminal ? `${base}/verdict/${run.publicId}` : null,
      });
    },

    async wait_for_run(args: { run_id: string }, opts: WaitOptions = {}): Promise<ToolResult> {
      const { run_id } = args;
      const startedAt = deps.now();
      let polls = 0;
      let run = await getRun(run_id);
      if (isResult(run)) return run;
      while (!isTerminal(run.status) && deps.now() - startedAt < WAIT_CAP_MS) {
        if (opts.signal?.aborted) break;
        polls++;
        await opts.onProgress?.({
          polls,
          status: run.status,
          elapsed_s: Math.round((deps.now() - startedAt) / 1000),
        });
        await deps.sleep(WAIT_POLL_MS);
        const next = await getRun(run_id);
        if (isResult(next)) return next;
        run = next;
      }

      if (!isTerminal(run.status)) {
        return text({
          ok: true,
          timed_out: true,
          waited_minutes: Math.round((deps.now() - startedAt) / 60_000),
          status: run.status,
          hint:
            "Run still in progress — call wait_for_run again, or poll get_check_status. " +
            "A full check takes ~20–40 minutes.",
          live_url: `${base}/run/${run_id}`,
        });
      }

      // Terminal: the structured verdict with a findings roll-up.
      const res = await api(`/api/runs/${encodeURIComponent(run_id)}/verdict`);
      const verdict: VerdictPayload = res.ok
        ? ((await res.json()) as VerdictPayload)
        : { verdict: run.verdict };
      const findings = verdict.findings ?? [];
      const bySeverity: Record<string, number> = {};
      for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      return text({
        ok: true,
        run_id,
        status: run.status,
        verdict: verdict.verdict ?? run.verdict,
        // Which build this verdict is about — null when the run named none,
        // so a CI gate can refuse to pass on someone else's run.
        deploy: verdict.deploy ?? null,
        bottom_line: verdict.bottom_line ?? null,
        findings_by_severity: bySeverity,
        findings: findings.map((f) => `[${f.severity}/${f.category}] ${f.title}`),
        cost_usd: verdict.cost_usd ?? null,
        error: run.errorMessage ?? null,
        verdict_url: `${base}/verdict/${run_id}`,
        ...(run.status === "failed"
          ? {
              hint:
                "A failed run is CheckMyApp not finishing, not the app being broken. " +
                "No verdict was published; start another check.",
            }
          : {}),
      });
    },

    async get_verdict(args: { domain_or_run_id: string }): Promise<ToolResult> {
      const run_id = await resolveRunId(args.domain_or_run_id);
      if (isResult(run_id)) return run_id;
      const res = await api(`/api/runs/${encodeURIComponent(run_id)}/verdict`);
      if (!res.ok) return failure(res);
      const payload = (await res.json()) as VerdictPayload;
      return text({ ok: true, run_id, ...payload, verdict_url: `${base}/verdict/${run_id}` });
    },
  };
}

export type Tools = ReturnType<typeof createTools>;
