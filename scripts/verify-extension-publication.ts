import assert from "node:assert/strict";
import { build } from "esbuild";
import { publicExtensionObservation, prepareExtensionPublication, JOBLANDER_EXTENSION_ID } from "../src/agent/extension-publication";
import { extensionPhaseEvidence, extensionAccountingStep } from "../src/agent/extension-evidence";
import type { ExtensionSession } from "../src/agent/extension-contract";
import { putScreenshot, type AgentEnv } from "../src/agent/env";
import { hasEnvironmentLeak, hasHomework } from "../src/lib/verdict-language";
import { dedupKeyForFinding } from "../src/lib/tracker/file";

async function main() {
  const identity: ExtensionSession = { extensionId: JOBLANDER_EXTENSION_ID, packageVersion: "1", installedVersion: "1", artifactSha256: "a".repeat(64),
    ownerRunId: "fixture", sessionId: "session", name: "JobLander", targetUrl: "fixture:interview", targetTabId: "tab", popupPath: "popup.html", browserVersion: "Chrome/145", popupSignedIn: true };
  const session = (scenario: ExtensionSession["scenario"]): ExtensionSession => ({ ...identity, scenario,
    accountBaseline: { source: "account-ui", balance: 100 },
    sessions: Array.from({ length: scenario === "practice-extension" ? 2 : 1 }, (_, i) => ({ id: `session-${i}`, state: "stopped", startedAt: 1_000,
      cleanup: { applicationStopObserved: true, stopClickedAt: 151_000 } })),
    productResult: { confirmed: true }, applicationCleanup: "ui-stop-observed", billingCleanup: "confirmed",
    billing: { assessment: { status: "confirmed", twoMinuteSteps: true, observedMinutes: 3,
      sessions: [{ id: "PRIVATE_HISTORY_ROW", kind: "extension", dateUtc: "2026-09-13 00:00", durationSeconds: 150 }] } },
  });
  const privateText = "PRIVATE_RESUME_EMPLOYER and PRIVATE_DIALOGUE_CONTENT";
  const paid = session("interview");
  const final = { disposed: true, session: { ...paid, privateText } };
  const report = publicExtensionObservation(identity, final, extensionAccountingStep(final), false)!;
  assert.equal(report.steps.filter(s => s.status === "ok").length, 4);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|100|Chrome/);
  assert.equal(publicExtensionObservation(identity, { ...final, disposed: false }, null, false), null);
  assert.equal(publicExtensionObservation(identity, { ...final, session: { ...paid, runtimeFailure: { kind: "browser-exited" } } }, null, false), null);
  const noResponse = publicExtensionObservation(identity, { ...final, session: { ...paid, productResult: { confirmed: false } } }, null, false)!;
  assert.equal(noResponse.steps[1].status, "skipped");
  assert.doesNotMatch(noResponse.summary, /produced a new response/);
  const readOnly = { disposed: true, session: { ...identity, accountBaseline: paid.accountBaseline, sessions: [], applicationCleanup: "not-started", billingCleanup: "not-started" } };
  const readReport = publicExtensionObservation(identity, readOnly, null, false)!;
  assert.equal(readReport.session, false);
  assert.equal(readReport.steps.length, 2);
  assert.ok(readReport.steps.every(s => s.status === "ok"));
  assert.match(readReport.summary, /did not start a session/);

  const phases = Object.fromEntries((["interview", "practice", "practice-extension"] as const).map((scenario, i) => {
    const state = session(scenario);
    if (scenario !== "interview") state.billing = { assessment: { status: "inconclusive" } };
    return [`walk-${i}`, extensionPhaseEvidence(`walk-${i}`, { ...identity, scenario }, { disposed: true, session: state })];
  }));
  phases["walk-3"] = extensionPhaseEvidence("walk-3", identity, readOnly);
  const evidence = { identity: { extensionId: identity.extensionId }, phases };
  const journeys = Object.keys(phases).map((_, order) => ({ id: `journey-${order}`, order, title: `Journey ${order}` }));
  const writes: Record<string, unknown>[] = [];
  const privateAudits = new Map<string, string>();
  let deleted = 0;
  const env = { bindings: { EVIDENCE: { put: async (key: string, value: string) => { privateAudits.set(key, value); } } }, db: {
    journey: { findMany: async () => journeys, update: async ({ data }: { data: object }) => { writes.push(data); } },
    step: { findMany: async () => [{ journeyId: "journey-3", gapClass: "range_input", observed: privateText, unverifiedReason: "our_capability" },
      { journeyId: "journey-3", gapClass: null, observed: privateText, unverifiedReason: "missing_access" }],
      deleteMany: async ({ where }: { where: object }) => { assert.deepEqual(where, { journey: { runId: "new-run" } }); deleted++; },
      create: async ({ data }: { data: object }) => { writes.push(data); } },
  } } as unknown as AgentEnv;
  const result = (await prepareExtensionPublication(env, "new-run", JSON.stringify(evidence)))!;
  assert.equal(result.verdict, "mostly_ok");
  assert.equal(result.partial, true);
  assert.deepEqual(result.findings, [], "An unstarted panel or unavailable accounting cannot produce a customer defect");
  assert.match(result.bottomLine, /final rounding were not confirmed/);
  assert.equal(writes.filter(w => w.status === "skipped").length, 4);
  assert.ok(writes.some(w => w.gapClass === "range_input" && w.unverifiedReason === "our_capability"), "The machine-classified gap must remain available to the downstream tracker filer");
  assert.doesNotMatch(JSON.stringify(writes), /PRIVATE_/);
  assert.ok(writes.some(w => w.unverifiedReason === "missing_access"), "A per-control access gap must survive publication");
  assert.match(privateAudits.get("private/runs/new-run/checker-gaps.json")!, /PRIVATE_DIALOGUE_CONTENT/, "Original evidence remains internally retrievable without copying it into the verdict or customer tickets");
  assert.equal(deleted, 1);
  assert.equal(hasEnvironmentLeak(JSON.stringify(writes)), false);
  assert.equal(hasHomework(JSON.stringify(writes)), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|empty panel|not refreshing/);
  const saved = phases["walk-0"];
  phases["walk-0"] = { ...saved, productResultConfirmed: false };
  await assert.rejects(prepareExtensionPublication(env, "new-run", JSON.stringify(evidence)), /three session outcomes/);
  assert.equal(deleted, 1, "Invalid evidence is rejected before any published row changes");
  phases["walk-0"] = { ...saved, cleanupComplete: false };
  await assert.rejects(prepareExtensionPublication(env, "new-run", JSON.stringify(evidence)), /verified observation/);
  phases["walk-0"] = saved;
  const failed = { disposed: true, session: { ...paid, productResult: { confirmed: false,
    failure: { source: "visible-product-alert", text: `Connection failed: ${privateText}`, observedAt: 99, surface: "extension" } } } };
  phases["walk-0"] = extensionPhaseEvidence("walk-0", identity, failed);
  const broken = (await prepareExtensionPublication(env, "new-run", JSON.stringify(evidence)))!;
  assert.equal(broken.verdict, "broken");
  assert.equal(broken.findings.length, 1);
  assert.deepEqual(broken.findings[0].stepRef, { journeyIndex: 0, stepIndex: 1 });
  assert.doesNotMatch(JSON.stringify(broken), /PRIVATE_/);
  const toTicket = (finding: typeof broken.findings[number]) => ({ ...finding, detail: JSON.stringify(finding.detail), anchor: JSON.stringify({ errorSignature: finding.errorSignature }) });
  const firstKey = dedupKeyForFinding(toTicket(broken.findings[0]), { appSlug: `extension:${identity.extensionId}` });
  const otherFailure = { ...failed, session: { ...failed.session, productResult: { ...failed.session.productResult,
    failure: { ...failed.session.productResult.failure, text: "Responses are unavailable." } } } };
  phases["walk-0"] = extensionPhaseEvidence("walk-0", identity, otherFailure);
  const otherBroken = (await prepareExtensionPublication(env, "new-run", JSON.stringify(evidence)))!;
  const nextKey = dedupKeyForFinding(toTicket(otherBroken.findings[0]), { appSlug: `extension:${identity.extensionId}` });
  assert.notEqual(firstKey, nextKey, "Suppressing one alert must not suppress a different error in the same scenario");
  assert.equal(nextKey, dedupKeyForFinding(toTicket(otherBroken.findings[0]), { appSlug: `extension:${identity.extensionId}` }));

  const objects = new Map<string, unknown>();
  const storageEnv = { bindings: { EVIDENCE: { put: async (key: string, body: unknown) => { objects.set(key, body); } } } } as unknown as AgentEnv;
  const screenshot = new Uint8Array([1, 2, 3]);
  const privateImage = await putScreenshot(storageEnv, screenshot, { privateRunId: "fixture-run" });
  const publicImage = await putScreenshot(storageEnv, screenshot);
  assert.notEqual(privateImage.storageUrl, publicImage.storageUrl, "A content hash alone must not turn a private capture into a public one");
  assert.equal(objects.size, 2);
  assert.match(privateImage.storageUrl, /private\/runs\/fixture-run\/screenshots\//);
  const nativeImage = await putScreenshot(storageEnv, screenshot, { publicRunId: "fixture-run" });
  assert.match(nativeImage.storageUrl, /extensions\/fixture-run\/screenshots\//);
  const mocks: Record<string, string> = {
    "next/server": "export const NextResponse = { json: (value, init) => new Response(JSON.stringify(value), init) };",
    "@opennextjs/cloudflare": "export const getCloudflareContext = () => { fixture.contextCalls++; return { env: { EVIDENCE: fixture.bucket } }; };",
  };
  const bundle = await build({ entryPoints: ["src/app/api/evidence/[...path]/route.ts"], bundle: true, write: false, platform: "node", format: "cjs",
    plugins: [{ name: "external-boundaries", setup(build) {
      build.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: "fixture" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js" }));
    } }],
  });
  const fixture = { contextCalls: 0, bucket: { get: async () => ({ body: "fixture public evidence" }) } };
  const mod = { exports: {} as { GET(req: Request, args: { params: Promise<{ path: string[] }> }): Promise<Response> } };
  new Function("module", "exports", "fixture", bundle.outputFiles[0].text)(mod, mod.exports, fixture);
  const get = (path: string[]) => mod.exports.GET(new Request("https://example.test/api/evidence/" + path.join("/")), { params: Promise.resolve({ path }) });
  for (const path of [["private", "transcripts", "run.json"], ["private", "extensions", "attempt", "cleanup.json"], ["private", "extensions", "attempt", "phase.json"], ["private", "screenshots", "hash.png"], ["extensions", "run_walk-0", "cleanup.json"]]) {
    assert.equal((await get(path)).status, 404);
  }
  assert.equal(fixture.contextCalls, 0, "Private evidence is rejected before storage is consulted");
  assert.equal((await get(["transcripts", "public-audit.json"])).status, 200);
  const verdictMocks: Record<string, string> = { ...mocks, "@/lib/db": "export const getDbFromContext = async () => fixture.db;" };
  const verdictBundle = await build({ entryPoints: ["src/app/api/runs/[id]/verdict/route.ts"], bundle: true, write: false, platform: "node", format: "cjs",
    plugins: [{ name: "verdict-boundaries", setup(build) {
      build.onResolve({ filter: /.*/ }, args => verdictMocks[args.path] ? { path: args.path, namespace: "fixture" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: verdictMocks[args.path], loader: "js" }));
    } }],
  });
  const draft = { targetKind: "extension", status: "walking", verdict: null as string | null, bottomLine: privateText,
    journeys: [{ summary: privateText }], findings: [{ title: privateText }], llmUsage: [] };
  const verdictFixture = { db: { run: { findUnique: async () => draft } } };
  const verdictMod = { exports: {} as { GET(req: Request, args: { params: Promise<{ id: string }> }): Promise<Response> } };
  new Function("module", "exports", "fixture", verdictBundle.outputFiles[0].text)(verdictMod, verdictMod.exports, verdictFixture);
  for (const status of ["walking", "writing", "failed", "partial"]) {
    draft.status = status;
    const response = await verdictMod.exports.GET(new Request("https://example.test/api/runs/fixture/verdict"), { params: Promise.resolve({ id: "fixture" }) });
    assert.doesNotMatch(await response.text(), /PRIVATE_/, "Draft or failed extension observations must not be public through the structured API");
  }
  draft.status = "partial"; draft.verdict = "mostly_ok"; draft.bottomLine = result.bottomLine; draft.journeys = []; draft.findings = [];
  const published = await verdictMod.exports.GET(new Request("https://example.test/api/runs/fixture/verdict"), { params: Promise.resolve({ id: "fixture" }) });
  assert.equal((await published.json()).bottom_line, result.bottomLine);
  const reviewBundle = await build({ entryPoints: ["src/app/api/runs/[id]/review/route.ts"], bundle: true, write: false, platform: "node", format: "cjs",
    plugins: [{ name: "review-boundaries", setup(build) {
      build.onResolve({ filter: /.*/ }, args => verdictMocks[args.path] ? { path: args.path, namespace: "fixture" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: verdictMocks[args.path], loader: "js" }));
    } }],
  });
  const reviewMod = { exports: {} as typeof verdictMod.exports };
  new Function("module", "exports", "fixture", "require", reviewBundle.outputFiles[0].text)(reviewMod, reviewMod.exports, verdictFixture, require);
  Object.assign(draft, { publicId: "fixture", appSlug: "extension:fixture", anatomy: null, startedAt: new Date(), completedAt: null,
    verdict: null, bottomLine: privateText, journeys: [{ summary: privateText }], findings: [{ title: privateText }] });
  for (const status of ["walking", "writing", "failed"]) {
    draft.status = status;
    const review = await reviewMod.exports.GET(new Request("https://example.test/api/runs/fixture/review"), { params: Promise.resolve({ id: "fixture" }) });
    const body = await review.text();
    assert.doesNotMatch(body, /PRIVATE_/, "The full coding-agent review API must enforce the same publication boundary");
    assert.equal(JSON.parse(body).findings.length, 0);
  }
  const statusMocks = { ...mocks, "@/lib/db": "export const getDbFromContext = async () => fixture.db;", "@/lib/auth": "export const getOptionalUser = async () => fixture.user;" } as Record<string, string>;
  const statusBundle = await build({ entryPoints: ["src/app/api/status/[slug]/route.ts"], bundle: true, write: false, platform: "node", format: "cjs",
    plugins: [{ name: "status-boundaries", setup(build) {
      build.onResolve({ filter: /.*/ }, args => statusMocks[args.path] ? { path: args.path, namespace: "fixture" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: statusMocks[args.path], loader: "js" }));
    } }],
  });
  const statusFixture = { user: { id: "owner" }, db: { app: { findUnique: async () => ({ id: "app", appSlug: "extension:fixture" }) },
    run: { findFirst: async ({ where }: { where: { appId: string; status: { in: string[] }; verdict: { not: null } } }) => {
      assert.equal(where.appId, "app");
      return [ { status: "partial", verdict: null, runNumber: 3 }, { status: "partial", verdict: "broken", runNumber: 2 }, { status: "completed", verdict: "all_good", runNumber: 1 } ]
        .find(row => where.status.in.includes(row.status) && row.verdict !== where.verdict.not);
    } } } };
  const statusMod = { exports: {} as { GET(req: Request, args: { params: Promise<{ slug: string }> }): Promise<Response> } };
  new Function("module", "exports", "fixture", statusBundle.outputFiles[0].text)(statusMod, statusMod.exports, statusFixture);
  const status = await statusMod.exports.GET(new Request("https://example.test/api/status/extension:fixture"), { params: Promise.resolve({ slug: "extension:fixture" }) });
  const latest = await status.json();
  assert.equal(latest.verdict, "broken");
  assert.equal(latest.runNumber, 2, "Polling must return the latest published partial failure, not the previous green result or an unpublished draft");
  console.log("Extension publication: verified outcomes, neutral coverage gaps, private dialogue exclusion and public evidence boundary pass");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
