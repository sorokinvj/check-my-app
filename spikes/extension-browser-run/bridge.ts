import { ExtensionBrowser } from "../../src/agent/extension-browser";
import { prepareAgentPage, type ToolEnv } from "../../src/agent/tools";
import type { AgentEnv } from "../../src/agent/env";
import type { ExtensionRunnerInput } from "../../src/agent/extension-contract";

let used = false;
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || used) return new Response("One POST probe per process", { status: 409 });
    used = true;
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
    const env = { bindings: { EXTENSION_RUNNER: { getByName: () => runner } } } as unknown as AgentEnv;
    let extension: ExtensionBrowser | undefined;
    try {
      extension = await ExtensionBrowser.open(env, {
        ownerRunId: `worker-bridge-${Date.now()}`, extensionId: "hafhjepjihcimcljkdphpinannbdmnhf",
        targetUrl: "fixture:interview", maxDurationSeconds: 180, maxSessionSeconds: 60, allowSessions: false,
      });
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
      return Response.json({ initialTitle, finalTitle: await toolEnv.page.title(), nativePopupRead: true, exactTargetRestored: true, inspectorOpened: false, installedVersion: extension.identity.installedVersion });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    } finally { await extension?.finish(); }
  },
};
