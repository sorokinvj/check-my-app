// CHE-232 production probe: what the rotation would choose, on the real
// catalogs, right now.
//
// Read-only and run-free. It answers the question a verify-* script cannot —
// not "are the rules right" (scripts/verify-journey-rotation.ts holds those)
// but "what do the rules DO to the apps we actually have", which is where a
// budget of five against a catalog of thirty-one stops being hypothetical.
//
// Usage (needs CLOUDFLARE_API_TOKEN from .env):
//   npx tsx --tsconfig tsconfig.json scripts/probe-rotation.ts
//
// It shells out to wrangler rather than opening a D1 binding, because this is a
// local operator tool and the binding only exists inside the worker.

import { execFileSync } from "node:child_process";
import Module from "node:module";

// partial.ts → replay.ts → browser.ts wants the `cloudflare:workers` builtin at
// load time; nothing here touches a browser.
const moduleLoader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = moduleLoader._load;
moduleLoader._load = function (request: string, ...rest: unknown[]) {
  if (request === "cloudflare:workers") return {};
  return realLoad.call(this, request, ...rest);
};

interface Row {
  id: string;
  appSlug: string;
  title: string;
  status: string | null;
  plan: string;
  lastWalkedAt: string | null;
  lastWalkedRunId: string | null;
  consecutiveBad: number;
}

function query<T>(sql: string): T[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "checkmyapp", "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as Array<{ results: T[] }>;
  return parsed[0]?.results ?? [];
}

async function main() {
  const { planRotation, JOURNEY_WALK_BUDGET } = await import("@/agent/partial");
  const { FULL_RUN_MAX_AGE_DAYS } = await import("@/agent/replay");
  type CatalogJourneyState = import("@/agent/journey-catalog").CatalogJourneyState;

  const rows = query<Row>(
    `SELECT j.id, a.appSlug, j.title, j.status, j.plan, j.lastWalkedAt, j.lastWalkedRunId, j.consecutiveBad
     FROM AppJourney j JOIN App a ON a.id = j.appId
     WHERE j.retiredAt IS NULL ORDER BY a.appSlug;`,
  );

  const byApp = new Map<string, CatalogJourneyState[]>();
  for (const r of rows) {
    const list = byApp.get(r.appSlug) ?? [];
    list.push({
      appJourneyId: r.id,
      title: r.title,
      plan: [],
      status: r.status,
      lastWalkedAt: r.lastWalkedAt ? new Date(r.lastWalkedAt) : null,
      lastWalkedRunId: r.lastWalkedRunId,
      consecutiveBad: r.consecutiveBad,
    });
    byApp.set(r.appSlug, list);
  }

  const now = new Date();
  const ceiling = JOURNEY_WALK_BUDGET * FULL_RUN_MAX_AGE_DAYS;
  console.log(
    `Budget ${JOURNEY_WALK_BUDGET}/run · carry window ${FULL_RUN_MAX_AGE_DAYS}d · ` +
      `a catalog over ${ceiling} cannot be kept inside that window\n`,
  );

  for (const [appSlug, journeys] of [...byApp.entries()].sort()) {
    const r = planRotation({ journeys, now });
    const age = (j: CatalogJourneyState) =>
      j.lastWalkedAt ? `${((now.getTime() - j.lastWalkedAt.getTime()) / 86_400_000).toFixed(1)}d` : "never";
    console.log(`── ${appSlug} — ${journeys.length} live journeys${journeys.length > ceiling ? "  ⚠ over the ceiling" : ""}`);
    console.log(`   walk (${r.walk.length}):`);
    for (const j of r.walk) console.log(`     · ${j.title}  [${j.status ?? "never walked"}, ${age(j)}]`);
    console.log(`   carry (${r.carry.length})${r.carry.length ? `, oldest ${age(r.carry.reduce((a, b) => (a.lastWalkedAt! < b.lastWalkedAt! ? a : b)))}` : ""}`);
    if (r.deferred.length) {
      console.log(`   DEFERRED (${r.deferred.length}) — neither walked nor carried, this is our coverage gap:`);
      for (const j of r.deferred) console.log(`     · ${j.title}  [${j.status ?? "never walked"}, ${age(j)}]`);
    }
    // How many daily runs before every journey has been walked at least once,
    // if nothing breaks and nothing is added.
    const state = journeys.map((j) => ({ ...j }));
    const seen = new Set<string>();
    let day = 0;
    for (; day < 60 && seen.size < state.length; day++) {
      const at = new Date(now.getTime() + day * 86_400_000);
      for (const j of planRotation({ journeys: state, now: at }).walk) {
        seen.add(j.appJourneyId);
        const row = state.find((s) => s.appJourneyId === j.appJourneyId);
        if (row) {
          row.lastWalkedAt = at;
          row.status = "ok";
          row.consecutiveBad = 0;
          row.lastWalkedRunId = row.lastWalkedRunId ?? "simulated";
        }
      }
    }
    console.log(
      `   full circuit: ${seen.size === state.length ? `${day} daily runs` : `not reached in 60 days (${seen.size}/${state.length})`}\n`,
    );
  }
}

void main();
