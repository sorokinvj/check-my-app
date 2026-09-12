import { ExtensionBrowser } from "../../src/agent/extension-browser";
import { prepareAgentPage, type ToolEnv } from "../../src/agent/tools";
import type { AgentEnv } from "../../src/agent/env";
import { makeLlm } from "../../src/agent/llm";
import { discoverApp } from "../../src/agent/discovery";
import { encryptSecret } from "../../src/lib/crypto";
import type { ExtensionRunnerInput } from "../../src/agent/extension-contract";

let used = false;
let outcome: unknown = { state: "idle" };
export default {
  async fetch(request: Request, bindings: { EVIDENCE: R2Bucket }): Promise<Response> {
    if (request.headers.get("Origin")) return new Response("Local probe only", { status: 403 });
    if (request.method === "GET") return Response.json(outcome);
    if (request.method !== "POST" || used) return new Response("One POST probe per process", { status: 409 });
    used = true;
    outcome = { state: "running" };
    const call = async (path: string, method: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:19091${path}`, { method, headers: { "X-CMA-Spike": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.json();
    };
    let final: unknown;
    // Only the DO transport is replaced by a loopback bridge. Every operation
    // still runs against the real isolated Chrome and native popup.
    const runner = {
      openSession: (input: ExtensionRunnerInput) => call("/session", "POST", input),
      fetch: (req: Request) => {
        const target = new URL(req.url); target.host = "127.0.0.1:19091";
        const headers = new Headers(req.headers); headers.set("X-CMA-Spike", "1");
        return fetch(new Request(target, new Request(req, { headers })));
      },
      expire: async () => { final = await call("/session", "DELETE"); },
      finalEvidence: async () => final,
    };
    const env = { bindings: { ...bindings, EXTENSION_RUNNER: { getByName: () => runner } } } as unknown as AgentEnv;
    let extension: ExtensionBrowser | undefined;
    try {
      extension = await ExtensionBrowser.open(env, {
        ownerRunId: `worker-bridge-${Date.now()}`, extensionId: "hafhjepjihcimcljkdphpinannbdmnhf",
        targetUrl: "fixture:interview", maxDurationSeconds: 1200, maxSessionSeconds: 60, allowSessions: false,
      });
      if (new URL(request.url).pathname === "/discover") {
        const config = await call("/config", "GET") as { apiKey: string; email: string; password: string; navModel?: string };
        process.env.CREDENTIALS_SECRET = crypto.randomUUID();
        const passwordEnc = encryptSecret(config.password);
        env.bindings.ANTHROPIC_API_KEY = config.apiKey;
        if (config.navModel) env.bindings.ANTHROPIC_NAV_MODEL = config.navModel;
        config.password = "";
        const result = await discoverApp({
          env, browser: extension.browser, llm: makeLlm(env.bindings),
          run: { targetUrl: "https://chromewebstore.google.com/detail/hafhjepjihcimcljkdphpinannbdmnhf", testEmail: config.email, testPasswordEnc: passwordEnc,
            scopeHints: null, userNotes: "Map the extension's interview assistance, account and session controls. Use the existing test-account data; do not upload or replace a resume, purchase access or start a session during discovery.", focusAreas: "Native popup, interview assistance, session lifecycle" },
          onProgress: async note => { console.log(`[discovery-probe] ${note}`); outcome = { state: "running", action: note }; },
        });
        await bindings.EVIDENCE.put("extension-discovery.json", JSON.stringify(result));
        outcome = { state: "completed", journeys: result.journeys, anatomy: result.anatomy, notes: result.notes, toolCalls: result.transcript.filter(t => t.kind === "tool_call").length };
        return Response.json(outcome);
      }
      const initialTitle = await extension.page.title();
      const toolEnv: ToolEnv = { page: extension.page, extension, targetOrigin: "http://127.0.0.1:9091", networkLog: [], consoleLog: [] };
      await prepareAgentPage(toolEnv);
      const opened = await extension.tool(toolEnv, "extension_open", {});
      if (!opened?.includes("Sign in with email")) throw new Error(`Native popup unreadable: ${opened}`);
      const closed = await extension.tool(toolEnv, "extension_close", {});
      if (!closed?.includes("target-tab")) throw new Error(`Could not return to target tab: ${closed}`);
      const root = await extension.browser.newBrowserCDPSession();
      const targets = (await root.send("Target.getTargets")).targetInfos;
      await root.detach();
      if (targets.some(t => t.url.startsWith("devtools:"))) throw new Error("Popup inspection changed the active Chrome window");
      outcome = { state: "completed", initialTitle, finalTitle: await toolEnv.page.title(), nativePopupRead: true, exactTargetRestored: true, inspectorOpened: false, installedVersion: extension.identity.installedVersion };
      return Response.json(outcome);
    } catch (error) {
      outcome = { state: "failed", error: error instanceof Error ? error.message : String(error) };
      return Response.json(outcome, { status: 500 });
    } finally { await extension?.finish(); }
  },
};
