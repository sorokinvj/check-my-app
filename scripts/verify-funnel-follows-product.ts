// CHE-281 verification: a funnel changes when the change persists.
//
// First-derivation-wins exists for a good reason — if a funnel were rewritten
// by every walk that wandered, yesterday's 12% and today's 40% would look like
// a trend while measuring two different questions. It was never meant to
// outlast the pages it names.
//
// checkmyapp.dev moved its form off `/check`, which now answers 404. The survey
// even wrote it down — the stored anatomy literally contains "/check — 404" —
// and two funnels still began there:
//
//   p0oexr  Guest checks an app by URL      /check → /verdict/:id
//   2y3h3c  Evaluate pricing and start…     /check → /pricing
//
// Their counts decay to zero as the 14-day window rolls past the removal, and
// zero reads as "nobody comes here" rather than "this page is gone".
//
// So the rule is persistence, borrowed from journey retirement, which waits for
// three consecutive checks rather than trusting one: note the disagreement, and
// if it is still there after the grace window, the product moved and the funnel
// follows.
//
// This is also the first code that ever READS `funnelDriftAt`. It was written
// on every drifting run "so it is visible rather than silent" and displayed
// nowhere — a column that reads as coverage and provides none. Two other
// instances of that same pattern turned up today (`PostHogIntegration.scope`,
// and `missing_access` reaching no customer-facing surface).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-funnel-follows-product.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FUNNEL_DRIFT_GRACE_MS } from "@/agent/journey-catalog";
import { funnelDrifted } from "@/lib/funnel";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const DAY = 24 * 60 * 60 * 1000;
const STORED = ["/check", "/verdict/:id"];
const DERIVED = ["/", "/verdict/:id"];

console.log("\n— the grace window is a defensible length —\n");

check("a single odd walk cannot rewrite a funnel", FUNNEL_DRIFT_GRACE_MS > DAY,
  `${FUNNEL_DRIFT_GRACE_MS / DAY} days`);
check("…but a real product change is followed within the week",
  FUNNEL_DRIFT_GRACE_MS <= 7 * DAY, `${FUNNEL_DRIFT_GRACE_MS / DAY} days`);

console.log("\n— the real case: /check is gone and the funnel still names it —\n");

check("today's walk genuinely disagrees with the stored funnel",
  funnelDrifted(STORED, DERIVED), `${STORED.join(" → ")} vs ${DERIVED.join(" → ")}`);

console.log("\n— the decision, read from the source —\n");

{
  // `funnelUpdate` is not exported — it is an implementation detail of
  // recordWalk — so the branches are asserted by reading them. What matters is
  // that all four exist and that one of them is the replacement, because
  // before this change there was no replacement branch at all.
  const src = readFileSync(join(import.meta.dirname, "..", "src/agent/journey-catalog.ts"), "utf8");
  const fn = src.slice(src.indexOf("function funnelUpdate"), src.indexOf("export async function recordCarry"));

  check("agreeing again clears a past disagreement",
    /row\.funnelDriftAt \? \{ funnelRefusal: null, funnelDriftAt: null \}/.test(fn),
    "otherwise a one-off walk would eventually replace a current funnel");

  check("the first disagreement is only noted",
    /if \(!firstNoticed\) return \{ funnelRefusal: null, funnelDriftAt: at \}/.test(fn));

  check("inside the window nothing is rewritten",
    /drifting < FUNNEL_DRIFT_GRACE_MS/.test(fn));

  check("…and funnelDriftAt is NOT refreshed while waiting",
    !/drifting < FUNNEL_DRIFT_GRACE_MS[\s\S]{0,200}funnelDriftAt: at/.test(fn),
    "refreshing it each run would restart the clock forever and nothing would ever be replaced");

  check("past the window the funnel is replaced",
    /funnelStages: JSON\.stringify\(args\.funnel\.stages\)/.test(fn) &&
      /funnelDerivedAt: at/.test(fn),
    "the branch that did not exist before this change");

  check("…and the marker is cleared so the next drift starts its own clock",
    /funnelStages: JSON[\s\S]{0,200}funnelDriftAt: null/.test(fn));

  check("funnelDriftAt is now read, not only written",
    /row\.funnelDriftAt/.test(fn), "it was written every drifting run and read by nothing");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
