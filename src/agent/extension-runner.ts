import { Container } from "@cloudflare/containers";
import type { AgentBindings } from "./env";
import type { ExtensionRunnerInput, ExtensionSession } from "./extension-contract";
interface Lease {
  token: string;
  expiresAt: number;
  closed: boolean;
  ownerRunId: string;
}

// One named object owns one browser attempt. The durable deadline survives a
// Workflow retry or disconnection; it never constitutes application Stop proof.
export class ExtensionRunner extends Container<AgentBindings> {
  defaultPort = 9090;
  sleepAfter = "25m";

  async openSession(input: ExtensionRunnerInput): Promise<ExtensionSession> {
    const duration = Math.min(1200, Math.max(60, input.maxDurationSeconds));
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = [...bytes].map(n => n.toString(16).padStart(2, "0")).join("");
    const lease: Lease = { token, expiresAt: Date.now() + duration * 1000, closed: false, ownerRunId: input.ownerRunId };
    await this.ctx.storage.transaction(async storage => {
      if (await storage.get("lease")) throw new Error("Extension attempt already has a lease");
      await storage.put("lease", lease);
    });
    await this.schedule(new Date(lease.expiresAt + 120_000), "expire");
    try {
      await this.startAndWaitForPorts({
        ports: 9090,
        startOptions: { envVars: { RUNNER_CONTROL_TOKEN: token } },
        cancellationOptions: { portReadyTimeoutMS: 60_000 },
      });
      const response = await this.fetch(new Request("http://runner/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, maxDurationSeconds: Math.max(1, Math.floor((lease.expiresAt - Date.now()) / 1000)) }),
      }));
      if (!response.ok) throw new Error(`Extension preflight failed: ${await response.text()}`);
      const session = await response.json<ExtensionSession>();
      await this.ctx.storage.put("identity", session);
      return session;
    } catch (error) {
      await this.expire().catch(() => {});
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const lease = await this.ctx.storage.get<Lease>("lease");
    if (!lease || lease.closed || Date.now() >= lease.expiresAt) {
      return Response.json({ error: "Extension attempt expired" }, { status: 410 });
    }
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${lease.token}`);
    return super.fetch(new Request(request, { headers }));
  }

  async expire(): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>("lease");
    if (!lease || lease.closed) return;
    await this.ctx.storage.put("lease", { ...lease, closed: true });
    let evidence: unknown = { disposed: false, applicationCleanup: "unverified" };
    try {
      const response = await super.fetch(new Request("http://runner/session", {
        method: "DELETE", headers: { Authorization: `Bearer ${lease.token}` },
        signal: AbortSignal.timeout(120_000),
      }));
      if (response.ok) evidence = await response.json();
    } catch {
      // An unreachable process says nothing about the application's paid state.
    } finally {
      // Persist before destroying the only browser that observed Stop. The
      // durable copy remains recoverable if the R2 write or Workflow fails.
      try {
        await this.ctx.storage.put("finalEvidence", evidence);
        await this.env.EVIDENCE.put(`extensions/${lease.ownerRunId}/cleanup.json`, JSON.stringify(evidence));
      } finally { await this.destroy(); }
    }
  }

  async finalEvidence(): Promise<{ disposed: boolean; session?: ExtensionSession }> {
    return await this.ctx.storage.get("finalEvidence") ?? { disposed: false };
  }
}
