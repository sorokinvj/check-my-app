// CHE-200 verification: the MCP server's contract with today's HTTP API.
//
// mcp/server.ts was written against the API of 2026-08-22. Since then the API
// grew quota refusals with a `code` (429 quota_site / quota_anon / quota_free),
// the self-check refusal (403 self_check_read_only, CHE-193), an anonymous
// same-domain reuse answer (200 {id, reused: true}), and a Turnstile 403 that a
// keyless machine caller hits on every production submission. This script
// pins what the tools do with each of those, with fetch stubbed to answer
// exactly the shapes the routes in src/app/api produce — no network, no
// waiting between polls (the clock and sleep are injected too).
//
// Three layers:
//   1. the tool functions (mcp/tools.ts) against every route answer;
//   2. the input schemas (what a client may send) — the same bounds the API
//      enforces, so a bad deploy_sha is refused before a request is made;
//   3. the registered server over the SDK's in-memory transport: a real MCP
//      client lists the four tools, calls them, and receives progress
//      notifications while wait_for_run polls.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-mcp.ts

import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SELF_CHECK_HEADER, SELF_CHECK_READ_ONLY } from "@/lib/self-check";
import {
  createTools,
  inputSchemas,
  WAIT_CAP_MS,
  WAIT_POLL_MS,
  type ToolResult,
} from "../mcp/tools";
import { registerTools, SERVER_VERSION } from "../mcp/server";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const BASE = "https://checkmyapp.dev";
const RUN_ID = "cmf9w4k2x0001abcd12345678";
const OTHER_RUN_ID = "cmf9w4k2x0002abcd87654321";

// ---------------------------------------------------------------------------
// Fixtures — shaped exactly like the routes answer today.

// GET /api/runs/{id} (src/app/api/runs/[id]/route.ts)
function runSnapshot(status: string, extra: Record<string, unknown> = {}) {
  return {
    publicId: RUN_ID,
    appSlug: "checkmyapp.dev",
    targetUrl: "https://checkmyapp.dev",
    status,
    verdict: null,
    events: [
      { at: "2026-09-07T10:00:00.000Z", phase: "connecting", icon: "info", text: "Connected" },
      { at: "2026-09-07T10:00:05.000Z", phase: "surface_scan", icon: "ok", text: "Detected Next.js" },
      { at: "2026-09-07T10:00:09.000Z", phase: "discovery", icon: "working", text: "Mapping journeys" },
      { at: "2026-09-07T10:01:00.000Z", phase: "walking", icon: "working", text: "Journey 1/4" },
      { at: "2026-09-07T10:02:00.000Z", phase: "walking", icon: "ok", text: "Journey 1 ok" },
      { at: "2026-09-07T10:03:00.000Z", phase: "walking", icon: "working", text: "Journey 2/4" },
    ],
    errorMessage: null,
    startedAt: "2026-09-07T10:00:00.000Z",
    completedAt: null,
    ...extra,
  };
}

// GET /api/runs/{id}/verdict (src/app/api/runs/[id]/verdict/route.ts)
const VERDICT = {
  run_number: 212,
  app: "checkmyapp.dev",
  status: "completed",
  verdict: "mostly_ok",
  deploy: { sha: "78442cd", env: "production" },
  bottom_line: "The product works end to end; one form loses its draft on a slow connection.",
  journeys: [
    { title: "Landing to first check", status: "ok", summary: "Reached the check form and back." },
    { title: "Pricing", status: "partial", summary: "Plans render; checkout was out of scope." },
  ],
  findings: [
    { number: 1, title: "Check form clears on a slow submit", category: "risky", severity: "medium", mark: null },
    { number: 2, title: "FAQ anchor links skip the heading", category: "polish", severity: "low", mark: null },
    { number: 3, title: "Sign-in page title reads 'Untitled'", category: "polish", severity: "low", mark: null },
  ],
  cost_usd: 0.83,
  total_tokens: 412_311,
  completed_at: "2026-09-07T10:31:00.000Z",
};

const NOT_FOUND = { error: "Run not found" };

// POST /api/checks refusals (src/app/api/checks/route.ts, src/lib/plans.ts)
const QUOTA_SITE = {
  error: "Today's free checks are all used up. Run this one for $1, or read today's checks — it opens again at midnight UTC.",
  code: "quota_site",
};
const QUOTA_ANON = {
  error: "That was your free run for today. Sign up for a free account to get more.",
  code: "quota_anon",
};
const QUOTA_FREE = {
  error: "You've used all 3 runs on the Free plan. Enable Daily Watch on an app you've already checked, or upgrade for unlimited runs.",
  code: "quota_free",
};
const TURNSTILE_TODAY = { error: "Verification failed — please retry." };
const TURNSTILE_WITH_CODE = { ...TURNSTILE_TODAY, code: "turnstile_failed" };
const INVALID = { error: "Deploy sha looks too short" };

// GET /api/checks/lookup (src/app/api/checks/lookup/route.ts)
const LOOKUP_FOUND = {
  found: true,
  appSlug: "checkmyapp.dev",
  count: 3,
  run: {
    publicId: OTHER_RUN_ID,
    runNumber: 210,
    verdict: "all_good",
    bottomLine: "Everything we walked worked.",
    completedAt: "2026-09-06T09:00:00.000Z",
  },
  watched: true,
  ageDays: 1,
  stale: false,
};
const LOOKUP_NONE = { found: false };

// ---------------------------------------------------------------------------
// A fetch stub: an ordered script of answers, each matched against the request
// it is consumed by, plus a record of every request for the assertions.

interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}
type Answer = { status: number; json?: unknown; text?: string };

function harness(opts: { apiKey?: string } = {}) {
  const requests: Recorded[] = [];
  const script: Answer[] = [];
  const sleeps: number[] = [];
  let clock = 1_757_240_000_000; // an arbitrary fixed instant

  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ method: init?.method ?? "GET", url, headers, body });
    const next = script.shift();
    if (!next) throw new Error(`unscripted request: ${init?.method ?? "GET"} ${url}`);
    if (next.json !== undefined) {
      return new Response(JSON.stringify(next.json), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(next.text ?? "", { status: next.status });
  };

  const tools = createTools({
    base: BASE,
    apiKey: opts.apiKey,
    fetch: fetchStub,
    // Sleeping advances the clock instead of waiting, so a 45-minute cap is
    // reached in microseconds and the poll cadence is still observable.
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });

  return { tools, requests, script, sleeps, answer: (...a: Answer[]) => script.push(...a) };
}

function parse(result: ToolResult): Record<string, unknown> {
  const item = result.content[0];
  if (!item || item.type !== "text") throw new Error("tool result has no text content");
  return JSON.parse(item.text) as Record<string, unknown>;
}

async function main() {
  // 1 — the request the tools send.
  {
    const h = harness({ apiKey: "cma_0123456789abcdef0123456789abcdef" });
    h.answer({ status: 201, json: { id: RUN_ID } });
    const out = parse(
      await h.tools.start_check({
        url: "https://checkmyapp.dev",
        notes: "CHE-200 smoke",
        scope_hints: "Do not sign up.",
        deploy_sha: "78442cd",
        deploy_env: "production",
      }),
    );
    const req = h.requests[0];
    check("start_check: POST /api/checks", req.method === "POST" && req.url === `${BASE}/api/checks`);
    check("start_check: the API key rides as a Bearer token",
      req.headers.get("authorization") === "Bearer cma_0123456789abcdef0123456789abcdef");
    check(`start_check: never sends ${SELF_CHECK_HEADER}`, req.headers.get(SELF_CHECK_HEADER) === null);
    const body = req.body as Record<string, unknown>;
    check("start_check: body uses the API's field names",
      body.url === "https://checkmyapp.dev" && body.userNotes === "CHE-200 smoke" && body.scopeHints === "Do not sign up.",
      JSON.stringify(body));
    check("start_check: deploy identity passes through as {sha, env}",
      JSON.stringify(body.deploy) === JSON.stringify({ sha: "78442cd", env: "production" }));
    check("start_check: 201 → ok, run_id, reused false, deploy echoed, URLs",
      out.ok === true && out.run_id === RUN_ID && out.reused === false &&
        JSON.stringify(out.deploy) === JSON.stringify({ sha: "78442cd", env: "production" }) &&
        out.live_url === `${BASE}/run/${RUN_ID}` && out.verdict_url === `${BASE}/verdict/${RUN_ID}`,
      JSON.stringify(out));
  }
  {
    const h = harness();
    h.answer({ status: 201, json: { id: RUN_ID } });
    const out = parse(await h.tools.start_check({ url: "https://checkmyapp.dev", deploy_env: "staging" }));
    const req = h.requests[0];
    check("start_check (no key): no Authorization header", req.headers.get("authorization") === null);
    check("start_check: deploy omitted entirely without a sha (env alone names no build)",
      !("deploy" in (req.body as object)) && out.deploy === null);
  }

  // 2 — every refusal the route can answer with.
  {
    const h = harness();
    h.answer({ status: 200, json: { id: OTHER_RUN_ID, reused: true } });
    const out = parse(await h.tools.start_check({ url: "https://checkmyapp.dev", deploy_sha: "78442cd" }));
    check("start_check: 200 {reused} → reused true, deploy null (not our build), a hint",
      out.ok === true && out.reused === true && out.run_id === OTHER_RUN_ID && out.deploy === null &&
        String(out.hint).includes("not bound"),
      JSON.stringify(out));
  }
  for (const [name, fixture, status, expectCode, hintNeedle] of [
    ["429 quota_site", QUOTA_SITE, 429, "quota_site", "midnight UTC"],
    ["429 quota_anon", QUOTA_ANON, 429, "quota_anon", "CHECKMYAPP_API_KEY"],
    ["429 quota_free", QUOTA_FREE, 429, "quota_free", "Upgrade"],
    ["403 self_check_read_only", SELF_CHECK_READ_ONLY, 403, "self_check_read_only", SELF_CHECK_HEADER],
    ["403 Turnstile (today's body, no code)", TURNSTILE_TODAY, 403, "turnstile_failed", "CHECKMYAPP_API_KEY"],
    ["403 Turnstile (with code)", TURNSTILE_WITH_CODE, 403, "turnstile_failed", "CHECKMYAPP_API_KEY"],
    ["400 validation", INVALID, 400, "invalid_input", "Fix the argument"],
  ] as const) {
    const h = harness();
    h.answer({ status, json: fixture });
    const result = await h.tools.start_check({ url: "https://checkmyapp.dev" });
    const out = parse(result);
    check(`start_check: ${name} → isError, code ${expectCode}, the API's message, a hint`,
      result.isError === true && out.ok === false && out.code === expectCode &&
        out.error === (fixture as { error: string }).error && out.http_status === status &&
        String(out.hint).includes(hintNeedle),
      JSON.stringify(out));
  }
  {
    const h = harness();
    h.answer({ status: 502, text: "<html>Bad gateway</html>" });
    const result = await h.tools.start_check({ url: "https://checkmyapp.dev" });
    const out = parse(result);
    check("start_check: a non-JSON 502 → isError, code http_502, the text as the message",
      result.isError === true && out.code === "http_502" && out.error === "<html>Bad gateway</html>",
      JSON.stringify(out));
  }

  // 3 — get_check_status.
  {
    const h = harness();
    h.answer({ status: 200, json: runSnapshot("walking") });
    const out = parse(await h.tools.get_check_status({ run_id: RUN_ID }));
    check("get_check_status: GET /api/runs/{id}", h.requests[0].url === `${BASE}/api/runs/${RUN_ID}`);
    check("get_check_status: in progress → terminal false, last 5 events, no verdict_url yet",
      out.status === "walking" && out.terminal === false && out.verdict === null && out.verdict_url === null &&
        Array.isArray(out.recent_events) && out.recent_events.length === 5 &&
        (out.recent_events as string[])[4] === "Journey 2/4" && out.live_url === `${BASE}/run/${RUN_ID}`,
      JSON.stringify(out));
  }
  {
    const h = harness();
    h.answer({ status: 200, json: runSnapshot("completed", { verdict: "all_good", completedAt: "2026-09-07T10:31:00.000Z" }) });
    const out = parse(await h.tools.get_check_status({ run_id: RUN_ID }));
    check("get_check_status: completed → terminal true, verdict, verdict_url",
      out.terminal === true && out.verdict === "all_good" && out.verdict_url === `${BASE}/verdict/${RUN_ID}`);
  }
  {
    const h = harness();
    h.answer({ status: 404, json: NOT_FOUND });
    const result = await h.tools.get_check_status({ run_id: "nosuchrun" });
    const out = parse(result);
    check("get_check_status: 404 → isError, code not_found, the API's message",
      result.isError === true && out.code === "not_found" && out.error === "Run not found");
  }

  // 4 — wait_for_run.
  {
    const h = harness();
    h.answer(
      { status: 200, json: runSnapshot("discovery") },
      { status: 200, json: runSnapshot("walking") },
      { status: 200, json: runSnapshot("completed", { verdict: "mostly_ok" }) },
      { status: 200, json: VERDICT },
    );
    const progress: Array<{ polls: number; status: string; elapsed_s: number }> = [];
    const out = parse(await h.tools.wait_for_run({ run_id: RUN_ID }, { onProgress: (p) => { progress.push(p); } }));
    check(`wait_for_run: polls every ${WAIT_POLL_MS / 1000}s until terminal`,
      h.sleeps.length === 2 && h.sleeps.every((ms) => ms === WAIT_POLL_MS), JSON.stringify(h.sleeps));
    check("wait_for_run: a progress report per poll, carrying the status seen",
      progress.length === 2 && progress[0].status === "discovery" && progress[1].status === "walking" &&
        progress[1].polls === 2 && progress[1].elapsed_s === 30,
      JSON.stringify(progress));
    check("wait_for_run: then GET …/verdict",
      h.requests[3].url === `${BASE}/api/runs/${RUN_ID}/verdict`);
    check("wait_for_run: verdict, deploy, bottom line, cost, findings rolled up by severity",
      out.status === "completed" && out.verdict === "mostly_ok" &&
        JSON.stringify(out.deploy) === JSON.stringify(VERDICT.deploy) &&
        out.bottom_line === VERDICT.bottom_line && out.cost_usd === 0.83 &&
        JSON.stringify(out.findings_by_severity) === JSON.stringify({ medium: 1, low: 2 }) &&
        (out.findings as string[])[0] === "[medium/risky] Check form clears on a slow submit" &&
        out.verdict_url === `${BASE}/verdict/${RUN_ID}`,
      JSON.stringify(out));
  }
  {
    const h = harness();
    // Never terminal: the cap must end it, not the fixture running out.
    for (let i = 0; i < 200; i++) h.answer({ status: 200, json: runSnapshot("walking") });
    const out = parse(await h.tools.wait_for_run({ run_id: RUN_ID }));
    const expectedPolls = Math.ceil(WAIT_CAP_MS / WAIT_POLL_MS);
    check(`wait_for_run: gives up after ${WAIT_CAP_MS / 60_000} min with timed_out and the last status`,
      out.timed_out === true && out.status === "walking" && out.waited_minutes === 45 &&
        h.sleeps.length === expectedPolls && out.live_url === `${BASE}/run/${RUN_ID}`,
      JSON.stringify({ out, polls: h.sleeps.length }));
  }
  {
    const h = harness();
    h.answer(
      { status: 200, json: runSnapshot("failed", { errorMessage: "internal: browser session lost" }) },
      { status: 200, json: { ...VERDICT, status: "failed", verdict: null, bottom_line: null, findings: [], cost_usd: 0.12 } },
    );
    const out = parse(await h.tools.wait_for_run({ run_id: RUN_ID }));
    check("wait_for_run: a failed run → status failed, error, no verdict, hint that it is not the app",
      out.status === "failed" && out.verdict === null && out.error === "internal: browser session lost" &&
        String(out.hint).includes("not the app"),
      JSON.stringify(out));
  }
  {
    const h = harness();
    h.answer({ status: 404, json: NOT_FOUND });
    const result = await h.tools.wait_for_run({ run_id: "nosuchrun" });
    check("wait_for_run: 404 → isError not_found, no polling",
      result.isError === true && parse(result).code === "not_found" && h.sleeps.length === 0);
  }
  {
    const h = harness();
    h.answer({ status: 200, json: runSnapshot("walking") }, { status: 200, json: runSnapshot("walking") });
    const ac = new AbortController();
    const out = parse(await h.tools.wait_for_run({ run_id: RUN_ID }, {
      signal: ac.signal,
      onProgress: () => { ac.abort(); },
    }));
    check("wait_for_run: the client cancelling stops the polling",
      out.timed_out === true && h.sleeps.length === 1, JSON.stringify(out));
  }

  // 5 — get_verdict.
  {
    const h = harness();
    h.answer({ status: 200, json: VERDICT });
    const out = parse(await h.tools.get_verdict({ domain_or_run_id: RUN_ID }));
    check("get_verdict (run id): GET …/verdict directly, no lookup",
      h.requests.length === 1 && h.requests[0].url === `${BASE}/api/runs/${RUN_ID}/verdict`);
    check("get_verdict: the route's payload passes through, plus run_id and verdict_url",
      out.ok === true && out.run_id === RUN_ID && out.verdict === "mostly_ok" && out.run_number === 212 &&
        JSON.stringify(out.journeys) === JSON.stringify(VERDICT.journeys) &&
        JSON.stringify(out.findings) === JSON.stringify(VERDICT.findings) &&
        out.cost_usd === 0.83 && out.verdict_url === `${BASE}/verdict/${RUN_ID}`,
      JSON.stringify(out));
  }
  {
    const h = harness({ apiKey: "cma_0123456789abcdef0123456789abcdef" });
    h.answer({ status: 200, json: LOOKUP_FOUND }, { status: 200, json: { ...VERDICT, verdict: "all_good" } });
    const out = parse(await h.tools.get_verdict({ domain_or_run_id: "https://checkmyapp.dev/" }));
    check("get_verdict (domain): GET /api/checks/lookup?url=… with the key, then the run it names",
      h.requests[0].url === `${BASE}/api/checks/lookup?url=${encodeURIComponent("https://checkmyapp.dev/")}` &&
        h.requests[0].headers.get("authorization") !== null &&
        h.requests[1].url === `${BASE}/api/runs/${OTHER_RUN_ID}/verdict` &&
        out.run_id === OTHER_RUN_ID && out.verdict === "all_good",
      JSON.stringify(h.requests.map((r) => r.url)));
  }
  {
    const h = harness();
    h.answer({ status: 200, json: LOOKUP_NONE });
    const result = await h.tools.get_verdict({ domain_or_run_id: "never-checked.example" });
    const out = parse(result);
    check("get_verdict (domain): {found: false} → isError, code no_completed_run",
      result.isError === true && out.code === "no_completed_run" && h.requests.length === 1);
  }
  {
    const h = harness();
    h.answer({ status: 404, json: NOT_FOUND });
    const result = await h.tools.get_verdict({ domain_or_run_id: "nosuchrun" });
    check("get_verdict: 404 → isError, code not_found (the verdict API exists; the run does not)",
      result.isError === true && parse(result).code === "not_found");
  }

  // 6 — input schemas: the same bounds the API enforces, refused before a request.
  {
    const s = z.object(inputSchemas.start_check);
    check("schema: a valid call parses",
      s.safeParse({ url: "https://checkmyapp.dev", deploy_sha: "78442cd", deploy_env: "production" }).success);
    check("schema: deploy_sha shorter than 7 is refused", !s.safeParse({ url: "https://x.dev", deploy_sha: "abc12" }).success);
    check("schema: deploy_sha with a space is refused", !s.safeParse({ url: "https://x.dev", deploy_sha: "abc 1234" }).success);
    check("schema: a bare domain is refused (the API wants a URL)", !s.safeParse({ url: "checkmyapp.dev" }).success);
    check("schema: notes over 2000 chars are refused", !s.safeParse({ url: "https://x.dev", notes: "x".repeat(2001) }).success);
  }

  // 7 — the registered server, driven by a real MCP client over an in-memory pair.
  {
    const h = harness({ apiKey: "cma_0123456789abcdef0123456789abcdef" });
    const server = new McpServer({ name: "checkmyapp", version: SERVER_VERSION });
    registerTools(server, h.tools);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "verify-mcp", version: "0.0.0" });
    await client.connect(clientTransport);

    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    check("server: lists exactly the four tools",
      JSON.stringify(listed) === JSON.stringify(["get_check_status", "get_verdict", "start_check", "wait_for_run"]),
      JSON.stringify(listed));

    h.answer({ status: 429, json: QUOTA_SITE });
    const refused = await client.callTool({ name: "start_check", arguments: { url: "https://checkmyapp.dev" } });
    const refusedOut = parse(refused as ToolResult);
    check("server: a quota refusal reaches the client as isError with its code",
      refused.isError === true && refusedOut.code === "quota_site", JSON.stringify(refused));

    const bad = await client.callTool({ name: "start_check", arguments: { url: "https://x.dev", deploy_sha: "short" } });
    check("server: an invalid argument is refused by the schema, no request made",
      bad.isError === true && h.requests.length === 1);

    h.answer(
      { status: 200, json: runSnapshot("walking") },
      { status: 200, json: runSnapshot("anatomy") },
      { status: 200, json: runSnapshot("completed", { verdict: "mostly_ok" }) },
      { status: 200, json: VERDICT },
    );
    const notes: string[] = [];
    const waited = await client.callTool(
      { name: "wait_for_run", arguments: { run_id: RUN_ID } },
      undefined,
      { onprogress: (p) => { notes.push(`${p.progress}:${p.message ?? ""}`); }, resetTimeoutOnProgress: true },
    );
    const waitedOut = parse(waited as ToolResult);
    check("server: wait_for_run sends a progress notification per poll (timeout-reset for long waits)",
      notes.length === 2 && notes[0].startsWith("1:walking") && notes[1].startsWith("2:anatomy"),
      JSON.stringify(notes));
    check("server: and returns the verdict",
      waited.isError !== true && waitedOut.verdict === "mostly_ok" && waitedOut.cost_usd === 0.83);

    await client.close();
    await server.close();
  }

  console.log(failures === 0 ? "\nverify-mcp: all checks passed" : `\nverify-mcp: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-mcp: crashed:", err);
  process.exit(1);
});
