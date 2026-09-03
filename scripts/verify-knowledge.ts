// CHE-136 verification: the three prompts read what earlier runs settled.
//
// The data about an app already lived in the tables, but each run read only
// the baseline: the walker spent iterations proving a known not-a-bug again,
// synthesis re-wrote findings the owner had settled (the "by design" signature
// suppressed the ticket, never the finding), and a page that changed since the
// last check got no more attention than one that did not. AppKnowledge is the
// one small object composed from those rows and rendered into the discovery,
// walking and synthesis prompts.
//
// Pure: no browser, no network, no model, no database. Everything below
// exercises the deterministic pieces — composition and its caps, the survey
// contribution, the three prompt blocks, and the prompt assembly with and
// without knowledge — exactly as the workflow and the prompts use them.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-knowledge.ts

import {
  KNOWLEDGE_CAPS,
  discoverySystem,
  knowledgeBlock,
  walkingSystem,
} from "@/agent/instructions";
import { SETTLED_CAP, composeKnowledge, snapshotInput, type AppKnowledge } from "@/agent/knowledge";
import type { SurveyOutcome } from "@/agent/snapshot";
import { synthesisSystem } from "@/agent/synthesis";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const seq = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

// Rule 1 hygiene, as a habit: the blocks are model-facing, but a prompt that
// talks about our machinery teaches the model to. Whole words only — "owner"
// is not "our", "check" is not "checker".
const MACHINERY = /\b(our|checker|browser|model)\b/i;

const run = {
  targetUrl: "https://target.test",
  scopeHints: "Stay out of /admin",
  userNotes: "The blog is a separate product",
  testEmail: "tester@target.test",
  testPasswordEnc: "enc:not-a-real-secret",
  focusAreas: "Checkout must work",
  writeAllowed: true,
  testMarker: "CheckMyApp test r7",
};

const EMPTY = { marks: [], settledLinks: [], snapshot: null, journeys: [] };

function main() {
  // 1 — composition: null when there is nothing to know, a page count alone
  // included (no block renders it).
  check("null when everything is empty", composeKnowledge(EMPTY) === null);
  check(
    "null when only a page count is present",
    composeKnowledge({ ...EMPTY, snapshot: { pages: 12, changedPaths: [] } }) === null,
  );

  // 2 — dedup by title, case-insensitively; the owner's mark wins over the
  // tracker's settlement for the same title; only known/false_positive marks
  // and suppressed/resolved outcomes count.
  const composed = composeKnowledge({
    marks: [
      { title: "Footer link 404s", category: "broken", mark: "known" },
      { title: "  FOOTER LINK 404s ", category: "broken", mark: "false_positive" },
      { title: "Analytics beacon 401", category: "risky", mark: "watch" },
      { title: "Search ignores filters", category: "confusing", mark: "false_positive" },
    ],
    settledLinks: [
      { title: "footer link 404s", category: "broken", outcome: "suppressed" },
      { title: "Checkout total off by tax", category: "broken", outcome: "suppressed" },
      { title: "Signup email never arrives", category: "broken", outcome: "resolved" },
      { title: "Old ticket re-pointed", category: "broken", outcome: "superseded" },
    ],
    snapshot: { pages: 9, changedPaths: ["/pricing", "/pricing", "/docs"] },
    journeys: [{ title: "Sign in and see the dashboard", status: "ok", walkedAt: "2026-09-02T10:15:00.000Z" }],
  });
  check("composed is not null", composed !== null);
  const settled = composed?.settled ?? [];
  check("titles deduped case-insensitively", settled.filter((s) => /footer link 404s/i.test(s.title)).length === 1);
  check(
    "owner mark wins over tracker settlement for the same title",
    settled.find((s) => /footer link 404s/i.test(s.title))?.why === "owner_marked",
  );
  check("a watch mark is not settled", !settled.some((s) => s.title === "Analytics beacon 401"));
  check(
    "suppressed → tracker_canceled",
    settled.find((s) => s.title === "Checkout total off by tax")?.why === "tracker_canceled",
  );
  check("resolved → resolved", settled.find((s) => s.title === "Signup email never arrives")?.why === "resolved");
  check("superseded is not settled", !settled.some((s) => s.title === "Old ticket re-pointed"));
  check("owner marks come first", settled[0]?.why === "owner_marked" && settled[1]?.why === "owner_marked");
  check("changed paths deduped", JSON.stringify(composed?.changedPaths) === JSON.stringify(["/pricing", "/docs"]));
  check("page count carried", composed?.lastSnapshotPages === 9);
  check("journeys carried", composed?.journeys.length === 1);

  // 3 — the settled cap.
  const over = composeKnowledge({
    ...EMPTY,
    marks: seq("Mark", SETTLED_CAP + 3).map((title) => ({ title, category: "polish", mark: "known" })),
    settledLinks: seq("Settled", 5).map((title) => ({ title, category: null, outcome: "suppressed" })),
  });
  check(`settled capped at ${SETTLED_CAP}`, over?.settled.length === SETTLED_CAP, String(over?.settled.length));
  check("cap keeps owner marks over tracker settlements", over?.settled.every((s) => s.why === "owner_marked") === true);

  // 4 — the survey's contribution: added ∪ changed, only when two snapshots
  // were compared and differed.
  const snapshot = (changed: boolean | null, comparable: boolean): SurveyOutcome => ({
    comparable,
    previous: null,
    snapshot: {
      id: "s1",
      appSlug: "target.test",
      runId: "r1",
      takenAt: "2026-09-03T00:00:00.000Z",
      fingerprint: "f",
      pages: [1, 2, 3].map((n) => ({
        url: `https://target.test/p${n}`,
        path: `/p${n}`,
        status: 200,
        title: `P${n}`,
        hash: `h${n}`,
        forms: 0,
        links: 0,
      })),
      bundles: [],
      buildId: null,
      tech: [],
      sitemapUrls: 0,
      blocked: false,
      truncated: false,
      previousId: null,
      changed,
      diff: { addedPaths: ["/new"], removedPaths: ["/gone"], changedPaths: ["/pricing"], bundlesChanged: false, buildIdChanged: false },
    },
  });
  check("no survey → null", snapshotInput(null) === null && snapshotInput(undefined) === null);
  const changedIn = snapshotInput(snapshot(true, true));
  check("comparable && changed → changed ∪ added", JSON.stringify(changedIn?.changedPaths) === JSON.stringify(["/pricing", "/new"]));
  check("removed paths are not 'changed'", !changedIn?.changedPaths.includes("/gone"));
  check("page count is the survey's", changedIn?.pages === 3);
  check("comparable && unchanged → no paths", snapshotInput(snapshot(false, true))?.changedPaths.length === 0);
  check("not comparable → no paths, whatever the diff says", snapshotInput(snapshot(true, false))?.changedPaths.length === 0);
  check("first snapshot (changed null) → no paths", snapshotInput(snapshot(null, false))?.changedPaths.length === 0);

  // 5 — the blocks. A knowledge over every cap, with a placeholder planted in
  // a title exactly where a run might store one.
  const big: AppKnowledge = {
    settled: [
      { title: "Fill the password field with {{TEST_PASSWORD}} shows a hint", category: "confusing", why: "owner_marked" },
      { title: "Checkout total off by tax", category: "broken", why: "tracker_canceled" },
      { title: "Signup email never arrives", category: null, why: "resolved" },
    ],
    changedPaths: seq("/changed", KNOWLEDGE_CAPS.changedPaths + 4).map((p) => p.replace(" ", "-")),
    lastSnapshotPages: 30,
    journeys: Array.from({ length: KNOWLEDGE_CAPS.journeys + 2 }, (_, i) => ({
      title: `Journey ${i + 1}`,
      status: i === 0 ? "broken" : "ok",
      walkedAt: "2026-09-02T10:15:00.000Z",
    })),
  };
  for (const phase of ["discovery", "walking", "synthesis"] as const) {
    check(`${phase}: empty for null`, knowledgeBlock(null, phase) === "");
  }

  const discovery = knowledgeBlock(big, "discovery");
  check("discovery: heading", discovery.startsWith("KNOWN ABOUT THIS APP:"));
  check("discovery: settled section", discovery.includes("Settled — already ruled by the owner or confirmed fixed"));
  check("discovery: settled line with category", discovery.includes("- Checkout total off by tax (broken)"));
  check("discovery: settled line without category has no parens", discovery.includes("- Signup email never arrives\n") || discovery.endsWith("- Signup email never arrives"));
  check("discovery: a confirmed fix is listed as a regression to report, not a known condition",
    discovery.includes("Confirmed fixed on an earlier check") &&
      !discovery.slice(discovery.indexOf("Settled —"), discovery.indexOf("Confirmed fixed")).includes("Signup email never arrives"));
  check("discovery: changed section", discovery.includes("Changed since the last check — give these pages attention first:"));
  check(
    `discovery: changed paths capped at ${KNOWLEDGE_CAPS.changedPaths}`,
    discovery.includes(`- /changed-${KNOWLEDGE_CAPS.changedPaths}\n`) && !discovery.includes(`/changed-${KNOWLEDGE_CAPS.changedPaths + 1}`),
  );
  check("discovery: journeys section", discovery.includes("Last check's journeys and how they ended:"));
  check("discovery: journey line carries status and day", discovery.includes('- "Journey 1" — broken (2026-09-02)'));
  check(
    `discovery: journeys capped at ${KNOWLEDGE_CAPS.journeys}`,
    discovery.includes(`"Journey ${KNOWLEDGE_CAPS.journeys}"`) && !discovery.includes(`"Journey ${KNOWLEDGE_CAPS.journeys + 1}"`),
  );
  check("discovery: {{TEST_PASSWORD}} passes through verbatim", count(discovery, "{{TEST_PASSWORD}}") === 1);
  check("discovery: no password-looking value", !discovery.includes("not-a-real-secret"));

  const walking = knowledgeBlock(big, "walking");
  check("walking: heading", walking.startsWith("KNOWN ABOUT THIS APP:"));
  check("walking: settled and changed sections", walking.includes("Settled —") && walking.includes("Changed since the last check"));
  check("walking: no journeys section", !walking.includes("Last check's journeys") && !walking.includes('"Journey 1"'));
  check("walking: {{TEST_PASSWORD}} passes through verbatim", count(walking, "{{TEST_PASSWORD}}") === 1);

  const synthesis = knowledgeBlock(big, "synthesis");
  check("synthesis: never-file wording", synthesis.includes("SETTLED BY THE OWNER — never file these as findings again"));
  check("synthesis: known-condition clause", synthesis.includes("('a known condition')"));
  check("synthesis: settled lines", synthesis.includes("- Checkout total off by tax (broken)"));
  check("synthesis: a confirmed fix is a regression, not settled",
    synthesis.includes("CONFIRMED FIXED on an earlier check") &&
      !synthesis.slice(0, synthesis.indexOf("CONFIRMED FIXED")).includes("Signup email never arrives"));
  check("synthesis: changed-pages sentence", synthesis.includes("The following pages changed since the last check; findings there are new by default: /changed-1, "));
  check("synthesis: no journeys", !synthesis.includes('"Journey 1"'));
  check("synthesis: {{TEST_PASSWORD}} passes through verbatim", count(synthesis, "{{TEST_PASSWORD}}") === 1);
  check("synthesis: no heading line for the walker", !synthesis.includes("KNOWN ABOUT THIS APP"));

  for (const [phase, block] of [["discovery", discovery], ["walking", walking], ["synthesis", synthesis]] as const) {
    const hit = block.match(MACHINERY);
    check(`${phase}: block names no machinery (our/checker/browser/model)`, hit === null, hit?.[0]);
  }

  // A knowledge with only a page count renders nothing: a heading over
  // nothing is noise.
  const bare: AppKnowledge = { settled: [], changedPaths: [], lastSnapshotPages: 4, journeys: [] };
  check("discovery: nothing to say → empty", knowledgeBlock(bare, "discovery") === "");
  check("synthesis: nothing to say → empty", knowledgeBlock(bare, "synthesis") === "");

  // 6 — prompt assembly. Without knowledge the prompts are byte-identical to
  // the ones without the argument; with it, the block is the only difference,
  // and it comes after the client's instructions.
  const discoveryBefore = discoverySystem(run);
  const discoveryNull = discoverySystem(run, undefined, null);
  const discoveryWith = discoverySystem(run, undefined, big);
  check("discoverySystem: no argument === null", discoveryBefore === discoveryNull);
  check("discoverySystem: with knowledge differs", discoveryWith !== discoveryBefore);
  check("discoverySystem: the block is the only difference", discoveryWith === `${discoveryBefore}\n\n${discovery}`);
  check(
    "discoverySystem: block lands after the client instructions",
    discoveryWith.indexOf("KNOWN ABOUT THIS APP") > discoveryWith.indexOf("CLIENT NOTES (authoritative)"),
  );

  const steps = ["Open the pricing page", "Pick a plan"];
  const walkingBefore = walkingSystem(run, "Buy a plan", steps);
  const walkingNull = walkingSystem(run, "Buy a plan", steps, null);
  const walkingWith = walkingSystem(run, "Buy a plan", steps, big);
  check("walkingSystem: no argument === null", walkingBefore === walkingNull);
  check("walkingSystem: the block is the only difference", walkingWith === `${walkingBefore}\n\n${walking}`);
  check(
    "walkingSystem: block lands after the client instructions",
    walkingWith.indexOf("KNOWN ABOUT THIS APP") > walkingWith.indexOf("CLIENT NOTES (authoritative)"),
  );

  const synthBefore = synthesisSystem();
  const synthNull = synthesisSystem(null);
  const synthWith = synthesisSystem(big);
  check("synthesisSystem: no argument === null", synthBefore === synthNull);
  check("synthesisSystem: rules then contract, joined as before", synthBefore.includes("\n\nRespond with ONLY JSON:\n"));
  check(
    "synthesisSystem: block sits after the rules and before the JSON contract",
    synthWith.indexOf("SETTLED BY THE OWNER") > synthWith.indexOf("LANGUAGE OF EVERYTHING THE CUSTOMER READS") &&
      synthWith.indexOf("SETTLED BY THE OWNER") < synthWith.indexOf("Respond with ONLY JSON:"),
  );
  check("synthesisSystem: the block is the only difference", synthWith.replace(`\n\n${synthesis}`, "") === synthBefore);

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
