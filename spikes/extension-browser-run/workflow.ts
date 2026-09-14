import { CheckRunWorkflow as ProductionCheckRunWorkflow } from "../../src/agent/workflow";
import { ExtensionBrowser } from "../../src/agent/extension-browser";
import type { AgentBindings } from "../../src/agent/env";
import type { ExtensionRunnerInput } from "../../src/agent/extension-contract";

const nativeTool = ExtensionBrowser.prototype.tool;
ExtensionBrowser.prototype.tool = async function(env, name, input) {
  console.log('[native-tool]', JSON.stringify({ name, popup: this.popup, synthetic: this.identity.targetUrl === 'http://127.0.0.1:9091/' }));
  return nativeTool.call(this, env, name, input);
};

// Local Workflow + local product D1, with native sessions in the isolated
// Cloudflare probe. The loopback proxy alone holds the probe's bearer token.
function nativeNamespace() {
  return { getByName(owner: string) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(owner)) throw new Error("Invalid probe owner");
    const request = (path: string, method = "GET", input?: unknown) => fetch(`http://127.0.0.1:19092/attempt/${owner}${path}`, {
      method, headers: { "X-CMA-Spike": "1", "Content-Type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const json = async (path: string, method?: string, input?: unknown) => {
      const response = await request(path, method, input);
      if (!response.ok) throw new Error(`Native Workflow probe ${path}: HTTP ${response.status}`);
      return response.json();
    };
    return {
      openSession: (input: ExtensionRunnerInput) => json("/session", "POST", input),
      expire: async () => { await json("/session", "DELETE"); },
      finalEvidence: () => json("/evidence"),
      fetch: (request: Request) => {
        const url = new URL(request.url);
        url.host = "127.0.0.1:19092";
        url.pathname = `/attempt/${owner}${url.pathname}`;
        const headers = new Headers(request.headers); headers.set("X-CMA-Spike", "1");
        return fetch(new Request(url, new Request(request, { headers })));
      },
    };
  } } as unknown as NonNullable<AgentBindings["EXTENSION_RUNNER"]>;
}

export class CheckRunWorkflow extends ProductionCheckRunWorkflow {
  constructor(ctx: ExecutionContext, env: AgentBindings) {
    super(ctx, { ...env, EXTENSION_RUNNER: nativeNamespace() });
  }
}

export default {
  async fetch(request: Request, env: AgentBindings) {
    if (request.headers.get("Origin")) return new Response("Loopback only", { status: 403 });
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/trigger" && request.method === "POST") {
      const { runId } = await request.json<{ runId: string }>();
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(runId)) return new Response("Invalid run", { status: 400 });
      const instance = await env.CHECK_RUN.create({ id: runId, params: { runId } });
      return Response.json({ id: instance.id, runId }, { status: 201 });
    }
    if (url.pathname === "/status") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("Missing id", { status: 400 });
      return Response.json(await (await env.CHECK_RUN.get(id)).status());
    }
    return new Response("Not found", { status: 404 });
  },
};
