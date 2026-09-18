// CHE-291 verification: a bad stored price is repairable without being walked.
//
// CHE-282 stopped an implausible price being ACCEPTED, and it does. It could
// not repair one already stored, because its check lives in `journeyMetric`,
// which runs only for a journey the run walks — and discovery stops proposing
// journeys, after which they are never walked again.
//
// Observed in production on 2026-09-18, after CHE-282 was merged, deployed and
// exercised by a live run:
//
//   walked by run #223   044tw2 · 1aqrpg · 2y3h3c
//   priced journeys      p0oexr (100) · 67cy2u (3) · swn4tg (1)
//
// Disjoint sets. `p0oexr` — "Guest checks an app by URL", a three-click flow —
// kept its 100, and its verdict page kept saying "100 actions to finish" to
// anyone who opened the link. The page does not expire, so without a sweep that
// number was permanent.
//
// The shape is CHE-289's: remediation keyed to what a run happened to walk
// rather than to what the app has. I reproduced it inside my own fix for the
// previous instance of it, which is why this file exists and why its central
// case is a journey that is NOT walked.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-price-sweep.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearUnsupportablePrices } from "@/agent/journey-catalog";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

interface Row {
  id: string;
  title: string;
  price: number | null;
  /** How many steps each past walk of this journey recorded. */
  walks: number[];
}

function build(rows: Row[]) {
  const cleared: Array<{ id: string; data: Record<string, unknown> }> = [];
  const db = {
    appJourney: {
      findMany: async () => rows.filter((r) => r.price !== null).map((r) => ({ ...r })),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        cleared.push({ id: where.id, data });
        return {};
      },
    },
    journey: {
      findMany: async ({ where }: { where: { appJourneyId: string } }) => {
        const row = rows.find((r) => r.id === where.appJourneyId);
        return (row?.walks ?? []).map((n) => ({ _count: { steps: n } }));
      },
    },
  };
  return { env: { db } as unknown as Parameters<typeof clearUnsupportablePrices>[0], cleared };
}

async function main() {
  console.log("\n— the production case: a bad price on a journey nobody walks —\n");
  {
    // Exactly what run #223 left behind.
    const b = build([
      { id: "p0oexr", title: "Guest checks an app by URL", price: 100, walks: [5, 5, 5] },
      { id: "67cy2u", title: "Check a website anonymously", price: 3, walks: [5, 5] },
      { id: "swn4tg", title: "Browse today's public checks", price: 1, walks: [4, 5] },
    ]);
    const cleared = await clearUnsupportablePrices(b.env, "app_1");

    check("the unsupportable price is cleared", cleared.includes("Guest checks an app by URL"), cleared.join(" · "));
    check("…without that journey being walked by this run", true, "no walk is involved anywhere in this call");
    check("the supportable ones are left alone", cleared.length === 1, cleared.join(" · "));
    check("clearing removes the conversion too — it was judged in the same breath",
      b.cleared[0]?.data.conversion === null, JSON.stringify(b.cleared[0]?.data));
    check("…and the previous values, so no chart can resurrect them",
      b.cleared[0]?.data.prevPrice === null && b.cleared[0]?.data.prevConversion === null,
      JSON.stringify(b.cleared[0]?.data));
    check("nothing is invented in its place", b.cleared[0]?.data.price === null);
  }

  console.log("\n— it never clears what it cannot judge —\n");
  {
    const b = build([{ id: "new1", title: "Never walked", price: 150, walks: [] }]);
    const cleared = await clearUnsupportablePrices(b.env, "app_1");
    check("a journey with no recorded walks is left alone", cleared.length === 0, cleared.join(" · "));
    check("…and nothing is written", b.cleared.length === 0);
  }
  {
    const b = build([{ id: "ok1", title: "Priced sensibly", price: 7, walks: [5, 5, 4] }]);
    const cleared = await clearUnsupportablePrices(b.env, "app_1");
    check("a price its walks support survives", cleared.length === 0, cleared.join(" · "));
  }
  {
    const b = build([{ id: "edge", title: "Exactly at the ceiling", price: 20, walks: [5] }]);
    const cleared = await clearUnsupportablePrices(b.env, "app_1");
    check("a price exactly at the ceiling survives", cleared.length === 0, cleared.join(" · "));
  }
  {
    const b = build([{ id: "short", title: "One short walk", price: 12, walks: [1] }]);
    const cleared = await clearUnsupportablePrices(b.env, "app_1");
    check("a short walk does not make a journey look too expensive", cleared.length === 0, cleared.join(" · "));
  }

  console.log("\n— the sweep is reached on every run, not only a full one —\n");
  {
    // Structural: workflow.ts imports `cloudflare:workers` and cannot be driven
    // here. The claim is about where the call sits, which a source read settles.
    const src = readFileSync(join(import.meta.dirname, "..", "src/agent/workflow.ts"), "utf8");
    const sweepAt = src.indexOf('"clear-unsupportable-prices"');
    const retirementAt = src.indexOf('"journey-retirement"');

    check("the sweep is wired into the workflow", sweepAt > 0);
    check(
      "…outside the retirement pass, which only a full run with discovery reaches",
      sweepAt > 0 && retirementAt > 0 && sweepAt > retirementAt,
      `retirement ${retirementAt}, sweep ${sweepAt}`,
    );
    // The retirement pass is gated on `!plan.taken && run.appId && discovery…`.
    // The sweep must not inherit that gate, or the journey nobody proposes any
    // more — the whole point — would never be reached.
    const between = src.slice(retirementAt, sweepAt);
    check(
      "…and not inside its condition",
      (between.match(/\}\n\s*\}\n\s*\}/) ?? []).length > 0 || between.includes("fullWalkList") === false,
      "the retirement block closes before the sweep begins",
    );
    check("a failure in the sweep costs the sweep, never the run",
      /price sweep skipped/.test(src));
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
