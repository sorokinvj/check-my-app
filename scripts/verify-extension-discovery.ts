import assert from "node:assert/strict";
import { shapeExtensionDiscovery } from "../src/agent/extension-discovery";
import { extensionInput, extensionToolAllowed, type ExtensionSession } from "../src/agent/extension-contract";

const identity = { extensionId: "hafhjepjihcimcljkdphpinannbdmnhf", installedVersion: "3.26.1" } as ExtensionSession;
const proposed = [{ title: "Toggle Insights and replace resume", steps: ["Upload a resume"] }];
const observed = [
  { surface: "native-popup", controls: [{ role: "push button", name: "Sign in with email" }, { role: "static", name: "Show JobLander Insights" }] },
  { source: "account-ui", balance: 1608, historyObserved: true },
  { surface: "practice-page", startAvailable: true, controls: [{ role: "button", name: "Start call" }] },
].map(read => JSON.stringify(read)).join("\n");
const result = shapeExtensionDiscovery(identity, observed, proposed);
assert.match(result.journeys[0].title, /Interview assistance/);
assert.match(result.journeys[0].steps.join(" "), /new answer.*confirmation.*unchanged balance/);
assert.deepEqual(result.journeys.slice(0, 3).map(j => j.extensionScenario), ["interview", "practice", "practice-extension"]);
const run = { id: "discovery-consent", targetKind: "extension", targetUrl: `https://chromewebstore.google.com/detail/${identity.extensionId}`, extensionConfig: JSON.stringify({ allowSessions: true }), testEmail: "test@example.test", testPasswordEnc: "encrypted-fixture" };
assert.equal(result.journeys.length, 5);
for (const [index, journey] of result.journeys.entries()) {
  const input = extensionInput(run, `walk-${index}`, journey.extensionScenario)!;
  assert.equal(input.allowSessions, index < 3, `${journey.title}: paid permission belongs only to the three session journeys`);
  assert.equal(extensionToolAllowed(input, "extension_account_preflight"), true);
  if (index >= 3) for (const tool of ["extension_start_session", "extension_prepare_practice", "extension_start_practice"]) {
    assert.equal(extensionToolAllowed(input, tool), false, `${journey.title} cannot acquire a paid session through ${tool}`);
  }
}
assert.match(result.journeys[2].steps.join(" "), /assistance first.*Start practice.*each duration separately/);
assert.equal(result.journeys.some(j => /replace resume|Upload/.test(JSON.stringify(j))), false);
assert.deepEqual(result.anatomy.services, [], "A login and document label do not prove internal service architecture");
assert.deepEqual(result.anatomy.tech, { Version: "3.26.1" }, "Minutes cannot become invented tokens or credits");
const absent = shapeExtensionDiscovery(identity, "", proposed);
assert.deepEqual(absent.journeys, [], "No observed control means no invented core journey");
const generic = shapeExtensionDiscovery({ ...identity, extensionId: "a".repeat(32) }, observed, proposed);
assert.deepEqual(generic.journeys, proposed);
console.log("Extension discovery: observed core action, bounded anatomy and absent-control cases pass");
