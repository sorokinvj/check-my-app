import { Container } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import type { AgentBindings } from "./env";
import type { ExtensionRunnerInput, ExtensionSession } from "./extension-contract";
import { extensionArtifactEvidence } from "./extension-artifact";
import { describeExecutorExit, type ExecutorExit } from "./extension-exit";
interface Lease {
  token: string;
  expiresAt: number;
  closed: boolean;
  closing?: boolean;
  ownerRunId: string;
}

// One named object owns one browser attempt. The durable deadline survives a
// Workflow retry or disconnection; it never constitutes application Stop proof.
export class ExtensionRunner extends Container<AgentBindings> {
  defaultPort = 9090;
  sleepAfter = "25m";
  private cleanupPromise?: Promise<void>;

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
      try {
        return await this.bringUpExecutor(input, lease, token);
      } catch (error) {
        // Our own deploy takes containers away for minutes after the rollout
        // reports itself finished — five minutes on run #195, ten on #202,
        // both after deliberately waiting for "completed" (CHE-272). Losing a
        // paid run to our own release is not a fact about anyone's product.
        //
        // Safe here and only here: a paid session is started by a tool during
        // the walk, never by this call, so at this point no meter exists to
        // leave running. Once one does, an eviction must still fail the
        // attempt — a second container cannot press Stop on the first one's
        // session.
        if (!(await this.evictedByOurOwnRollout())) throw error;
        console.log("[extension-runner] executor evicted by our own rollout; taking a fresh container");
        await this.ctx.storage.delete("lastEviction");
        await this.destroy().catch(() => {});
        return await this.bringUpExecutor(input, lease, token);
      }
    } catch (error) {
      // Read after the attempt is torn down: the stop event lands during
      // cleanup, and a failure that reports nothing is the thing this whole
      // path exists to stop producing.
      await this.expire().catch(() => {});
      const exit = await this.ctx.storage.get<ExecutorExit>("lastExit");
      throw new Error(describeExecutorExit(error, exit));
    }
  }

  // One call starts the instance and waits for its port, then opens the
  // session on it. Splitting the start from the port wait to get an earlier
  // look at the runtime's monitor cost a run (#189): the extra start is a
  // second lifecycle on the same attempt.
  private async bringUpExecutor(input: ExtensionRunnerInput, lease: Lease, token: string): Promise<ExtensionSession> {
    await this.startAndWaitForPorts({
      ports: 9090,
      startOptions: { envVars: { RUNNER_CONTROL_TOKEN: token } },
      cancellationOptions: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 90_000 },
    });
    const response = await this.fetch(new Request("http://runner/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, maxDurationSeconds: Math.max(1, Math.floor((lease.expiresAt - Date.now()) / 1000)) }),
    }));
    if (!response.ok) throw new Error(`Extension preflight failed: ${await response.text()}`);
    const session = await response.json<ExtensionSession>();
    await this.ctx.storage.put("identity", session);
    return session;
  }

  // Two signals, because they race: the runtime names the rollout in the error
  // it hands onError, and the stop event carries SIGTERM. A container that
  // failed on its own merits exits 1 (a crash) or 137 (killed for memory) —
  // neither is the platform asking politely, so neither is retried here.
  private async evictedByOurOwnRollout(): Promise<boolean> {
    if (await this.ctx.storage.get<number>("lastEviction")) return true;
    return (await this.ctx.storage.get<ExecutorExit>("lastExit"))?.exitCode === 143;
  }

  // The executor's own death is the one fact a "the container is not running"
  // message never carries. Without the exit code every such failure reads the
  // same, and reading it as anything about the extension is exactly the
  // confusion rule 8 exists to prevent (CHE-233: five identical runs, no cause).
  // This is the whole of what is needed: in production it reported the real
  // code 1 of a container dying at boot. A second watcher on the runtime's own
  // monitor added nothing that this did not already say.
  override async onStop(params: StopParams): Promise<void> {
    const exit: ExecutorExit = { exitCode: params.exitCode, reason: params.reason, at: Date.now() };
    console.log(`[extension-runner] executor stopped: exitCode=${exit.exitCode} reason=${exit.reason}`);
    await this.ctx.storage.put("lastExit", exit).catch(() => {});
  }

  override onError(error: unknown): unknown {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[extension-runner] executor error: ${message}`);
    // The runtime says so in words when it is the one taking the container:
    // "Runtime signalled the container to exit due to a new version rollout".
    // Recorded rather than only logged, because the decision to take a fresh
    // container is made a moment later and cannot re-read a log line.
    if (/new version rollout/i.test(message)) {
      this.ctx.waitUntil(this.ctx.storage.put("lastEviction", Date.now()).then(() => {}, () => {}));
    }
    return error;
  }

  override async fetch(request: Request): Promise<Response> {
    const lease = await this.ctx.storage.get<Lease>("lease");
    if (!lease || lease.closed || lease.closing || Date.now() >= lease.expiresAt) {
      return Response.json({ error: "Extension attempt expired" }, { status: 410 });
    }
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${lease.token}`);
    return super.fetch(new Request(request, { headers }));
  }

  expire(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.cleanup().finally(() => { this.cleanupPromise = undefined; });
      this.ctx.waitUntil(this.cleanupPromise);
    }
    return this.cleanupPromise;
  }

  private async cleanup(): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>("lease");
    if (!lease || lease.closed) { this.deleteSchedules("expire"); return; }
    // A disconnected caller must not turn an in-progress cleanup into a
    // permanently closed lease with no result. A later alarm can resume it.
    await this.ctx.storage.put("lease", { ...lease, closing: true });
    const identity = await this.ctx.storage.get<ExtensionSession>("identity");
    let evidence: unknown = await this.ctx.storage.get("finalEvidence");
    const recovered = evidence !== undefined;
    evidence ??= { disposed: false, ...(identity ? { session: { ...identity, applicationCleanup: "unverified" } } : {}), cleanupFailure: "Executor unreachable" };
    // A dead executor has nothing left to tell us about the application's paid
    // state — and asking starts a second one, because a container fetch boots
    // an instance and waits for its port. Every failed run in CHE-233 paid for
    // that twice over: the step hung long enough for the runtime to cancel it
    // as never-returning, and the Workflow retried the whole attempt.
    const executorAlive = this.ctx.container ? this.ctx.container.running : true;
    try {
      if (!recovered && !executorAlive) {
        evidence = { ...(evidence as object), cleanupFailure: "Executor was no longer running" };
      } else if (!recovered) {
        if (identity) {
          try {
            const snapshot = await super.fetch(new Request("http://runner/state", {
              headers: { Authorization: `Bearer ${lease.token}` }, signal: AbortSignal.timeout(5_000),
            }));
            if (snapshot.ok) {
              const latest = await snapshot.json<{ session?: ExtensionSession }>();
              if (latest.session?.ownerRunId === identity.ownerRunId && latest.session.sessionId === identity.sessionId) {
                evidence = { ...(evidence as object), session: latest.session };
              }
            }
          } catch { /* Preserve the installation identity when observation is unavailable. */ }
        }
        const response = await super.fetch(new Request("http://runner/session", {
          method: "DELETE", headers: { Authorization: `Bearer ${lease.token}` },
          signal: AbortSignal.timeout(120_000),
        }));
        if (response.ok) evidence = await response.json();
        else evidence = { ...(evidence as object), cleanupFailure: `Executor returned HTTP ${response.status}` };
      }
    } catch (error) {
      evidence = { ...(evidence as object), cleanupFailure: error instanceof Error ? error.name : "Executor disconnected" };
      // An unreachable process says nothing about the application's paid state.
    } finally {
      // Persist before destroying the only browser that observed Stop. The
      // durable copy remains recoverable if the R2 write or Workflow fails.
      let persisted = false;
      try {
        await this.ctx.storage.put("finalEvidence", evidence);
        persisted = true;
        await this.env.EVIDENCE.put(`private/extensions/${lease.ownerRunId}/cleanup.json`, JSON.stringify(extensionArtifactEvidence(evidence)));
      } finally {
        await this.destroy();
        if (persisted) {
          await this.ctx.storage.put("lease", { ...lease, closed: true, closing: false });
          this.deleteSchedules("expire");
        }
      }
    }
  }

  async finalEvidence(): Promise<{ disposed: boolean; session?: ExtensionSession }> {
    return await this.ctx.storage.get("finalEvidence") ?? { disposed: false };
  }
}
