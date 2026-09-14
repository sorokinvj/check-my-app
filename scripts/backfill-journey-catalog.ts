// CHE-231 — give the journeys we already walked their identity.
//
// The catalog is written going forward by the agent (src/agent/journey-catalog.ts).
// This backfills what is already in D1: every Journey row of every owned app,
// resolved to an AppJourney with the same rules a live run uses, so the day the
// catalog goes live it opens with the app's real history instead of an empty
// page.
//
// It prints SQL and touches nothing — read it, then apply it. Same shape as
// scripts/rekey-issuelinks.ts.
//
// Dump (add `> journeys.json`):
//
//   npx wrangler d1 execute checkmyapp --remote --json --command "
//     SELECT j.id, j.title, j.status, j.\"order\" AS ord, j.carriedFromRunId,
//            r.id AS runId, r.runNumber, r.appId, r.completedAt,
//            (SELECT SUM(u.costUsd) FROM LlmUsage u WHERE u.journeyId = j.id) AS costUsd
//     FROM Journey j JOIN Run r ON r.id = j.runId
//     WHERE r.appId IS NOT NULL
//     ORDER BY r.runNumber ASC, ord ASC"
//
// Then:
//
//   npx tsx scripts/backfill-journey-catalog.ts journeys.json > backfill.sql
//   npx wrangler d1 execute checkmyapp --remote --file backfill.sql
//
// Honesty rules the SQL keeps, the same three the live writer keeps:
//   - a carried row (carriedFromRunId set) never counts as a walk;
//   - an all-skipped journey never moves lastWalkedAt;
//   - the streak is recomputed from the rows in order, not guessed from the
//     last one.

import { readFileSync } from "node:fs";
import { journeyKey, matchJourney, normalizeTitle, type JourneyCandidate } from "../src/lib/journey-key";

interface Row {
  id: string;
  title: string;
  status: string;
  ord: number;
  carriedFromRunId: string | null;
  runId: string;
  runNumber: number;
  appId: string;
  completedAt: string | null;
  costUsd: number | null;
}

interface Entry extends JourneyCandidate {
  id: string;
  aliases: string[];
  /** How often each wording was used — the canonical title is the commonest. */
  wordings: Map<string, number>;
  status: string | null;
  lastRunId: string | null;
  lastRunNumber: number | null;
  lastWalkedAt: string | null;
  lastWalkedRunId: string | null;
  walkCount: number;
  consecutiveBad: number;
  failingSince: string | null;
  costUsd: number;
  createdAt: string;
}

const HEALTHY = new Set(["ok", "partial"]);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const nul = (s: string | null) => (s === null ? "NULL" : q(s));

const rows: Row[] = JSON.parse(readFileSync(process.argv[2], "utf8"))[0].results;
if (!rows.length) {
  console.log("-- nothing to backfill");
  process.exit(0);
}

const catalogs = new Map<string, Entry[]>();
const updates: string[] = [];
let matched = 0;

for (const row of rows) {
  const title = (row.title ?? "").trim();
  if (!title) continue;
  const catalog = catalogs.get(row.appId) ?? [];
  catalogs.set(row.appId, catalog);

  let entry = matchJourney(title, catalog) as Entry | null;
  if (entry) {
    matched += 1;
    if (!entry.aliases.some((a) => normalizeTitle(a) === normalizeTitle(title))) {
      entry.aliases.push(title);
    }
  } else {
    const at = row.completedAt ?? new Date().toISOString();
    entry = {
      id: `aj${cuidish()}`,
      key: journeyKey(title, catalog.map((c) => c.key)),
      title,
      aliases: [title],
      wordings: new Map(),
      status: null,
      lastRunId: null,
      lastRunNumber: null,
      lastWalkedAt: null,
      lastWalkedRunId: null,
      walkCount: 0,
      consecutiveBad: 0,
      failingSince: null,
      costUsd: 0,
      createdAt: at,
    };
    catalog.push(entry);
  }

  // The per-run row: identity always, cost only where the ledger has one.
  const cost = typeof row.costUsd === "number" ? row.costUsd : null;
  updates.push(
    `UPDATE Journey SET appJourneyId=${q(entry.id)}, journeyKey=${q(entry.key)}` +
      (cost !== null && !row.carriedFromRunId ? `, costUsd=${round6(cost)}` : "") +
      ` WHERE id=${q(row.id)};`,
  );

  // The catalog row, as the rows go by in run order. The title is the wording
  // this journey was given most often across its history — the live writer
  // takes the last walk's wording, but a backfill can see all of them at once,
  // and the commonest one is the one the owner will recognise.
  entry.wordings.set(title, (entry.wordings.get(title) ?? 0) + 1);
  entry.title = [...entry.wordings].sort((a, b) => b[1] - a[1])[0][0];
  entry.status = row.status;
  entry.lastRunId = row.runId;
  entry.lastRunNumber = row.runNumber;
  if (cost !== null && !row.carriedFromRunId) entry.costUsd = round6(entry.costUsd + cost);

  const walked = !row.carriedFromRunId && row.status !== "skipped";
  if (!walked) continue;
  entry.walkCount += 1;
  entry.lastWalkedAt = row.completedAt;
  entry.lastWalkedRunId = row.runId;
  if (HEALTHY.has(row.status)) {
    entry.consecutiveBad = 0;
    entry.failingSince = null;
  } else {
    entry.consecutiveBad += 1;
    entry.failingSince = entry.failingSince ?? row.completedAt;
  }
}

const all = [...catalogs.values()].flat();
console.log(`-- CHE-231 backfill: ${rows.length} journey rows → ${all.length} journeys across ${catalogs.size} apps`);
console.log(`-- ${matched} rows matched a journey already in the catalog; ${all.length} opened a new one`);
console.log("-- plan stays empty on purpose: the next walk writes the plan it actually took.");
for (const e of all) {
  console.log(
    `INSERT INTO AppJourney (id, appId, "key", title, aliases, plan, status, lastRunId, lastRunNumber, ` +
      `lastWalkedAt, lastWalkedRunId, walkCount, consecutiveBad, failingSince, costUsd, createdAt, updatedAt) VALUES (` +
      [
        q(e.id),
        q(appIdOf(e, catalogs)),
        q(e.key),
        q(e.title),
        q(JSON.stringify(e.aliases.slice(-40))),
        q("[]"),
        nul(e.status),
        nul(e.lastRunId),
        e.lastRunNumber === null ? "NULL" : String(e.lastRunNumber),
        nul(e.lastWalkedAt),
        nul(e.lastWalkedRunId),
        String(e.walkCount),
        String(e.consecutiveBad),
        nul(e.failingSince),
        String(e.costUsd),
        q(e.createdAt),
        q(new Date().toISOString()),
      ].join(", ") +
      ");",
  );
}
for (const u of updates) console.log(u);

function appIdOf(entry: Entry, byApp: Map<string, Entry[]>): string {
  for (const [appId, list] of byApp) if (list.includes(entry)) return appId;
  throw new Error(`no app for journey ${entry.key}`);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// Not cuid, and does not pretend to be: a collision-free opaque id for rows
// this script creates. Prisma only ever reads these back.
function cuidish(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
