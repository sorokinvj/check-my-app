// CHE-133 verification: discovery confirms the known map instead of remapping.
//
// A full run used to start discovery from zero every time — up to 55
// iterations, ~9% of a run's cost — although the app was mapped on the last
// full check. With memory, the previous anatomy and journeys are rendered into
// the discovery prompt with an instruction to confirm them in 8-15 tool calls,
// and the iteration budget drops to 20.
//
// Pure: no browser, no network, no model, no database. Everything below
// exercises the deterministic pieces — the prompt block, the prompt assembly
// with and without memory, the DISCOVERY_MEMORY parser and the two iteration
// budgets — exactly as the discovery loop and the workflow use them.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-known-map.ts

import { discoveryMemoryEnabled } from "@/agent/env";
import {
  DISCOVERY_ITERATIONS,
  DISCOVERY_ITERATIONS_WITH_MEMORY,
  discoverySystem,
  KNOWN_MAP_CAPS,
  knownMapBlock,
  type KnownMap,
} from "@/agent/instructions";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const seq = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);

// A run with every optional block switched on, so the assertions can prove the
// owner's blocks survive both prompt shapes.
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

// A map deliberately over every cap, with a placeholder string planted where
// a step label would carry it if a run ever stored one.
const oversized: KnownMap = {
  runNumber: 42,
  walkedAt: "2026-09-02T10:15:00.000Z",
  anatomy: {
    pages: seq("/page", KNOWN_MAP_CAPS.pages + 5),
    actions: seq("action", KNOWN_MAP_CAPS.actions + 5),
    services: seq("service", KNOWN_MAP_CAPS.services + 5).map((name) => ({ name, role: `${name} role` })),
    tech: { frontend: "Next.js", hosting: "Cloudflare", auth: "Clerk", realtime: "" },
  },
  journeys: Array.from({ length: KNOWN_MAP_CAPS.journeys + 2 }, (_, j) => ({
    title: `Journey ${j + 1}`,
    steps: seq(`j${j + 1}-step`, KNOWN_MAP_CAPS.steps + 3),
  })),
};
oversized.journeys[0].steps[2] = "Fill the password field with {{TEST_PASSWORD}}";

function main() {
  // 1 — the block names the run it comes from, in the owner's words.
  const block = knownMapBlock(oversized);
  check("block names the run", block.includes("last full check, Run #42"));
  check("block dates the walk", block.includes("walked 2026-09-02"));

  // 2 — caps. Every list is cut at its stated limit; the item just past the
  // cap is absent while the item at the cap is present.
  const capped = (prefix: string, cap: number) =>
    block.includes(`- ${prefix}-${cap}`) && !block.includes(`- ${prefix}-${cap + 1}`);
  check(`pages capped at ${KNOWN_MAP_CAPS.pages}`, capped("/page", KNOWN_MAP_CAPS.pages));
  check(`actions capped at ${KNOWN_MAP_CAPS.actions}`, capped("action", KNOWN_MAP_CAPS.actions));
  check(
    `services capped at ${KNOWN_MAP_CAPS.services}`,
    block.includes(`- service-${KNOWN_MAP_CAPS.services} — service-${KNOWN_MAP_CAPS.services} role`) &&
      !block.includes(`service-${KNOWN_MAP_CAPS.services + 1}`),
  );
  check(
    `journeys capped at ${KNOWN_MAP_CAPS.journeys}`,
    block.includes(`${KNOWN_MAP_CAPS.journeys}. "Journey ${KNOWN_MAP_CAPS.journeys}"`) &&
      !block.includes(`"Journey ${KNOWN_MAP_CAPS.journeys + 1}"`),
  );
  check(
    `steps capped at ${KNOWN_MAP_CAPS.steps}`,
    block.includes(`${KNOWN_MAP_CAPS.steps}) j1-step-${KNOWN_MAP_CAPS.steps}`) &&
      !block.includes(`j1-step-${KNOWN_MAP_CAPS.steps + 1}`),
  );
  check("tech pairs rendered, empty values dropped", block.includes("- frontend: Next.js") && !block.includes("realtime"));

  // 3 — the placeholder passes through as the literal string: never expanded,
  // never dropped. The prompt only ever carries the placeholder; the fill tool
  // is the one place a value exists.
  check("{{TEST_PASSWORD}} passes through verbatim", count(block, "{{TEST_PASSWORD}}") === 1, String(count(block, "{{TEST_PASSWORD}}")));
  check("no password-looking value appears", !block.includes("not-a-real-secret"));

  // 4 — a journey without steps renders as its title alone.
  const bare = knownMapBlock({
    runNumber: 3,
    walkedAt: "2026-08-30T00:00:00.000Z",
    anatomy: { pages: ["/"], actions: [], services: [], tech: {} },
    journeys: [{ title: "Sign in and see the dashboard", steps: [] }],
  });
  check("journey without steps renders as its title", bare.includes('1. "Sign in and see the dashboard"'));
  check("journey without steps has no step lines", !bare.includes("   1)"));
  check("empty anatomy sections are omitted", !bare.includes("Actions:") && !bare.includes("External services:"));

  // 5 — prompt assembly: with memory the block replaces the exploration budget;
  // without it the budget is there and no block is.
  const withMemory = discoverySystem(run, oversized);
  const withoutMemory = discoverySystem(run);
  check("with memory: block present", withMemory.includes("KNOWN MAP") && withMemory.includes("Run #42"));
  check("with memory: no 15-25 tool calls line", !withMemory.includes("15-25 tool calls"));
  check("with memory: confirm budget present", withMemory.includes("Budget 8-15 tool calls"));
  check("without memory: 15-25 tool calls line present", withoutMemory.includes("15-25 tool calls"));
  check("without memory: no block", !withoutMemory.includes("KNOWN MAP") && !withoutMemory.includes("Run #42"));

  // 6 — the owner's blocks are untouched by the mode.
  for (const [name, marker] of [
    ["focus", "OWNER'S PRIORITY CONCERNS"],
    ["focus journey rule", "must cover EACH of the owner's"],
    ["credentials", "TEST CREDENTIALS ARE PROVIDED"],
    ["credentials journey rule", "one of your proposed journeys MUST be"],
    ["crud", "CRUD LIFECYCLE CHECKING IS ENABLED"],
    ["client instructions", "SCOPE LIMITS (authoritative)"],
    ["client notes", "CLIENT NOTES (authoritative)"],
    ["JSON contract", "respond with ONLY a JSON object"],
  ] as const) {
    check(`${name} block in both prompts`, withMemory.includes(marker) && withoutMemory.includes(marker));
  }
  check(
    "the two prompts differ only by the budget paragraph",
    withMemory.replace(knownMapBlock(oversized), "§") === withoutMemory.replace(/EXPLORATION BUDGET:[\s\S]*?"explore more"\./, "§"),
  );

  // 7 — DISCOVERY_MEMORY parsing. Only an explicit "off" disables memory.
  const parse = (v: string | undefined) => discoveryMemoryEnabled({ DISCOVERY_MEMORY: v });
  check("env unset → on", parse(undefined) === true);
  check('env "" → on', parse("") === true);
  check('env "on" → on', parse("on") === true);
  check('env "garbage" → on', parse("garbage") === true);
  check('env "off" → off', parse("off") === false);
  check('env "OFF " → off', parse("OFF ") === false);

  // 8 — the iteration budgets discovery hands to the loop.
  check("budget with memory is 20", DISCOVERY_ITERATIONS_WITH_MEMORY === 20, String(DISCOVERY_ITERATIONS_WITH_MEMORY));
  check("budget without memory is 55", DISCOVERY_ITERATIONS === 55, String(DISCOVERY_ITERATIONS));

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
