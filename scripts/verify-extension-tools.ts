import assert from "node:assert/strict";
import { ExtensionBrowser } from "../src/agent/extension-browser";
import { ExtensionRuntimeError } from "../src/agent/extension-error";
import { executeTool, type ToolEnv } from "../src/agent/tools";

async function main() {
const extension = Object.assign(Object.create(ExtensionBrowser.prototype), {
  identity: { extensionId: "hafhjepjihcimcljkdphpinannbdmnhf", targetUrl: "http://127.0.0.1:9091/" },
  browser: { isConnected: () => true }, popup: false, productReads: new Set<string>(),
}) as ExtensionBrowser;
let pageReads = 0;
const panel = { locator: () => panel, count: async () => 0, isVisible: async () => false };
const env = { extension, page: { locator: () => panel, evaluate: async () => { pageReads++; throw new Error("Fixture body must not be read"); } },
  knownUrls: new Set(["https://observed.example.test/help"]), networkLog: [], consoleLog: [],
} as unknown as ToolEnv;
extension.page = env.page;
assert.match(await executeTool(env, "read_page", {}), /No extension-owned panel/);
assert.match(await executeTool(env, "screenshot", {}), /No extension-owned panel/);
assert.equal(pageReads, 0, "Fixture text and screenshots are never product evidence");
assert.equal(extension.discoveryObservations(), "");
assert.match(await executeTool(env, "verify_links", { urls: ["https://guessed.example.test"] }), /not observed/);
assert.equal(await extension.tool(env, "verify_links", { urls: ["https://observed.example.test/help"] }), undefined);

Object.assign(extension, { browser: { isConnected: () => false } });
await assert.rejects(executeTool(env, "read_page", {}), ExtensionRuntimeError, "A disconnected owned browser aborts the loop instead of becoming a product result");
Object.assign(extension, { runner: { fetch: async () => new Response("gone", { status: 410 }) } });
await assert.rejects(executeTool(env, "extension_read", {}), ExtensionRuntimeError);
Object.assign(extension, { runner: { fetch: async () => { throw new Error("transport gone"); } } });
await assert.rejects(executeTool(env, "extension_read", {}), ExtensionRuntimeError);
console.log("Extension tools: product-only observations, observed links and fatal runtime propagation pass");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
