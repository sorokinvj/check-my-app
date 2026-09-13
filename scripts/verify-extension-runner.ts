import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function main() {
  // Run the real owner class against a transport double; no account, Docker,
  // Cloudflare binding or deployment environment is required by acceptance.
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/agent/extension-runner.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "container-transport", setup(build) {
      build.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({ path: "container", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `export class Container {
        constructor(ctx, env) { this.ctx = ctx; this.env = env; }
        async schedule() {} async startAndWaitForPorts() {}
        fetch(request) { return this.env.transport(request); }
        destroy() { return this.env.destroy(); }
        deleteSchedules(name) { this.env.deletedSchedules.push(name); }
      }`, loader: "js" }));
    } }] });
  const mod = { exports: {} as { ExtensionRunner: new (ctx: unknown, env: unknown) => {
    openSession(input: unknown): Promise<unknown>; expire(): Promise<void>; finalEvidence(): Promise<unknown>;
  } } };
  new Function("module", "exports", bundle.outputFiles[0].text)(mod, mod.exports);
  const { ExtensionRunner } = mod.exports;
  const records = new Map<string, unknown>();
  const storage = { get: async (key: string) => structuredClone(records.get(key)), put: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); }, transaction: async (action: (storage: unknown) => Promise<void>) => action(storage) };
  const pending: Promise<void>[] = [];
  const ctx = { storage, waitUntil: (promise: Promise<void>) => { pending.push(promise); } };
  let release!: (response: Response) => void, deletes = 0, destroys = 0, artifact = "";
  const env = { deletedSchedules: [] as string[], EVIDENCE: { put: async (key: string, value: string) => { assert.equal(key, "private/extensions/owned-attempt/cleanup.json"); artifact = value; } },
    destroy: async () => { destroys++; }, transport: async (request: Request) => {
      if (request.method === "DELETE") { deletes++; return new Promise<Response>(resolve => { release = resolve; }); }
      return Response.json({ ...await request.json() as object, sessionId: "owned-session" });
    } };
  const runner = new ExtensionRunner(ctx, env);
  await runner.openSession({ ownerRunId: "owned-attempt", maxDurationSeconds: 600 });
  const first = runner.expire(), second = runner.expire();
  assert.equal(first, second, "Concurrent callers await the same cleanup instead of observing an empty final record");
  await new Promise(resolve => setImmediate(resolve));
  const lease = records.get("lease") as { closing: boolean; closed: boolean };
  assert.equal(lease.closing, true);
  assert.equal(lease.closed, false, "A disconnected caller cannot permanently close an unfinished lease");
  assert.equal(deletes, 1);
  release(Response.json({ disposed: true, session: { ownerRunId: "owned-attempt", sessions: [], applicationCleanup: "not-started", accountBaseline: { history: ["private-history"] } } }));
  await Promise.all([first, second, ...pending]);
  assert.equal(destroys, 1);
  assert.equal((records.get("lease") as { closed: boolean }).closed, true);
  assert.equal((await runner.finalEvidence() as { disposed: boolean }).disposed, true);
  assert.doesNotMatch(artifact, /private-history/);
  await runner.expire();
  assert.equal(deletes, 1, "A completed attempt cannot start another cleanup browser");
  assert.ok(env.deletedSchedules.includes("expire"));

  // Recreate the object midway through cleanup, as after an isolate restart.
  // Its durable proof must survive even if the browser is already gone.
  records.set("lease", { ...(records.get("lease") as object), closed: false, closing: true });
  const resumed = new ExtensionRunner(ctx, { ...env, transport: async () => { throw new Error("Browser is gone"); } });
  await resumed.expire();
  assert.equal((await resumed.finalEvidence() as { disposed: boolean }).disposed, true);
  assert.equal((records.get("lease") as { closed: boolean }).closed, true);
  console.log("Extension owner: concurrent cleanup, durable recovery, disposal and artifact minimization pass");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
