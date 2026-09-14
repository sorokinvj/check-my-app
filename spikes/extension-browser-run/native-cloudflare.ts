import { ExtensionRunner } from "../../src/agent/extension-runner";
import type { ExtensionRunnerInput } from "../../src/agent/extension-contract";

export { ExtensionRunner };

interface ProbeBindings {
  PROBE_ACCESS_TOKEN: string;
  EXTENSION_RUNNER: DurableObjectNamespace<ExtensionRunner>;
}

// A separate Worker and bucket exercise the production executor without any
// application database, scheduled checks, notification service or LLM access.
export default {
  async fetch(request: Request, env: ProbeBindings): Promise<Response> {
    if (!env.PROBE_ACCESS_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.PROBE_ACCESS_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    const match = /^\/attempt\/([a-zA-Z0-9_-]{8,100})(\/.*)$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    const runner = env.EXTENSION_RUNNER.getByName(match[1]);
    const path = match[2];
    if (path === "/session" && request.method === "POST") {
      return Response.json(await runner.openSession(await request.json<ExtensionRunnerInput>()));
    }
    if (path === "/session" && request.method === "DELETE") {
      await runner.expire();
      return Response.json(await runner.finalEvidence());
    }
    if (path === "/evidence" && request.method === "GET") return Response.json(await runner.finalEvidence());
    return runner.fetch(new Request(`http://runner${path}${url.search}`, request));
  },
};
