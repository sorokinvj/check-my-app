import assert from "node:assert/strict";
import ts from "typescript";
import { extensionReplaySpec, type ExtensionReplayAction } from "../src/agent/extension-replay";
import type { ExtensionSession } from "../src/agent/extension-contract";

const identity = { extensionId: "a".repeat(32), packageVersion: "1.0", installedVersion: "1.0", artifactSha256: "b".repeat(64), targetUrl: "http://127.0.0.1:9091/", maxSessionSeconds: 150 } as ExtensionSession;
const control = { role: "entry", name: "", editable: true, protected: true };
const actions: ExtensionReplayAction[] = [{ kind: "open" }, { kind: "native-fill", control, value: "{{TEST_PASSWORD}}" },
  { kind: "close" }, { kind: "account" }, { kind: "audio" }, { kind: "open" }, { kind: "start" }, { kind: "observe" }];
const source = extensionReplaySpec("Native capture", identity, actions, true);
assert.equal(source.includes("popup.html"), false);
assert.equal(source.includes("fixture:interview"), true);
assert.equal(source.includes("process.env.TARGET_URL"), false);
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
assert.equal(compiled.diagnostics?.length, 0);

async function replay(mode: "normal" | "drift" | "cleanup" | "denied") {
  let run: (args: unknown) => Promise<void> = async () => {};
  const calls: string[] = [];
  const test = Object.assign((_title: string, fn: typeof run) => { run = fn; }, { setTimeout() {} });
  const expect = Object.assign((value: unknown) => ({
    toBe: (expected: unknown) => assert.equal(value, expected),
    toBeUndefined: () => assert.equal(value, undefined),
    toHaveLength: (n: number) => assert.equal((value as unknown[]).length, n),
    toBeGreaterThan: (n: number) => assert.ok(Number(value) > n),
  }), { poll: (fn: () => Promise<unknown>) => ({ toBe: async (expected: unknown) => assert.equal(await fn(), expected) }) });
  const env = { CMA_EXTENSION_RUNNER_URL: "http://isolated.test", CMA_EXTENSION_RUNNER_TOKEN: "local-verification-placeholder",
    CMA_ALLOW_SESSIONS: mode === "denied" ? "0" : "1", TEST_EMAIL: "qa@example.test", TEST_PASSWORD: "local-test-value" };
  new Function("require", "exports", "process", compiled.outputText)((id: string) => {
    if (id === "@playwright/test") return { test, expect, chromium: { connectOverCDP: () => { throw new Error("Native test must not open a page browser"); } } };
    if (id === "node:crypto") return { randomUUID: () => "local-verify-id" };
    throw new Error("Unexpected generated dependency");
  }, {}, { env });
  let ref = 0;
  const request = { fetch: async (url: string, options: { method: string; data?: Record<string, unknown> }) => {
    const path = new URL(url).pathname; calls.push(options.method + " " + path);
    let data: unknown = {};
    if (path === "/session" && options.method === "POST") data = { ...identity, ...(mode === "drift" ? { installedVersion: "2.0" } : {}), sessionId: "owned", targetTabId: "owned-tab" };
    if (path === "/popup/read") data = { nodes: [{ ...control, ref: String(++ref) }] };
    if (path === "/popup/action") { assert.equal(options.data?.ref, String(ref)); assert.equal(options.data?.value, env.TEST_PASSWORD); assert.equal(options.data?.credential, true); }
    if (path === "/account/preflight") data = { historyObserved: true };
    if (path === "/fixture/preflight") data = { passed: true };
    if (path === "/session/start") data = { started: true };
    if (path === "/session/observe") data = { complete: true, minuteAccounting: "confirmed" };
    if (path === "/session" && options.method === "DELETE") data = { disposed: true, session: { sessions: [{}], applicationCleanup: "ui-stop-observed", billingCleanup: mode === "cleanup" ? "unverified" : "confirmed", productResult: { confirmed: true } } };
    return { ok: () => true, json: async () => data };
  } };
  if (mode === "normal") await run({ request }); else await assert.rejects(run({ request }));
  assert.equal(calls.includes("DELETE /session"), mode !== "denied", "An interrupted replay must clean up, even after identity rejection");
  if (mode === "drift") assert.equal(calls.includes("POST /popup"), false);
  if (mode === "normal") assert.equal(calls.filter(c => c === "POST /session/start").length, 1);
}
async function main() { for (const mode of ["normal", "drift", "cleanup", "denied"] as const) await replay(mode); console.log("Generated native replay: credential substitution, identity rejection, paid permission and mandatory cleanup pass"); }
main().catch(error => { console.error(error); process.exitCode = 1; });
