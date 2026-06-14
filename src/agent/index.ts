// Agent worker entry. Exports the CheckRunWorkflow (durable orchestrator) and a
// thin fetch handler: the web app starts a run by creating a Workflow instance
// via the CHECK_RUN binding (see src/lib/trigger.ts). A manual POST /trigger is
// kept for ops/testing. Daily Watch cron lands with CHE-15's scheduler.

import type { AgentBindings } from "./env";
import type { CheckRunParams } from "./workflow";
import { CheckRunWorkflow } from "./workflow";

export { CheckRunWorkflow };

export default {
  async fetch(req: Request, env: AgentBindings): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "agent" });
    }

    // POST /trigger { runId } — start a run Workflow (ops/testing; the web app
    // normally triggers via the CHECK_RUN binding directly).
    if (req.method === "POST" && url.pathname === "/trigger") {
      const body = (await req.json().catch(() => ({}))) as Partial<CheckRunParams>;
      if (!body.runId) {
        return Response.json({ error: "runId required" }, { status: 400 });
      }
      const instance = await env.CHECK_RUN.create({ params: { runId: body.runId } });
      return Response.json({ id: instance.id, runId: body.runId }, { status: 201 });
    }

    return new Response("agent worker", { status: 200 });
  },
};
