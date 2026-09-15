// One-off correction (CHE-247): give the two-meter extension scenario back the
// walk that was recorded against a different journey.
//
// Until 0031, identity was decided from titles alone, and these two share two
// of the shorter title's three tokens — 0.67 against a 0.60 threshold:
//
//   "Interview assistance and session minutes"   (scenario: interview)
//   "Practice with interview assistance"         (scenario: practice-extension)
//
// So run #194's third walk — the one that ran two paid meters at once and
// found billing confirmation failing, the most load-bearing evidence the
// extension work has — was filed under the interview journey. The catalog says
// the combined scenario has never been walked, and the interview journey
// carries a walk that was not its own.
//
// New runs separate correctly now that scenario is part of identity. This fixes
// the rows that already exist, and it does it the way the backfill does: read
// the per-run Journey rows, derive the catalog from them, write the derivation.
// No counter is edited by hand — a hand-edited counter is a number nobody can
// check.
//
// Usage:
//   npx tsx --tsconfig tsconfig.json scripts/recompute-extension-catalog.ts          # dry run
//   npx tsx --tsconfig tsconfig.json scripts/recompute-extension-catalog.ts --apply
//
// Needs CLOUDFLARE_API_TOKEN (set -a; source .env). Safe to re-run: it is
// idempotent, and a second pass reports no changes.

import { execFileSync } from "node:child_process";

// Which scenario each extension journey belongs to. Hard-coded on purpose: the
// source of truth is src/agent/extension-discovery.ts, where these titles and
// scenarios are written together, and this is a one-off correction rather than
// a rule. Verified against that file on 2026-09-15; if a title there changes
// later, this script is already history and should not be re-run.
const SCENARIO_BY_TITLE: Record<string, string | null> = {
  "Interview assistance and session minutes": "interview",
  "AI practice and session minutes": "practice",
  "Practice with interview assistance": "practice-extension",
  "Email sign-in": null,
};

const APPLY = process.argv.includes("--apply");

function sql<T>(command: string): T[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "checkmyapp", "--remote", "--json", "--command", command],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as Array<{ results: T[] }>;
  return parsed[0]?.results ?? [];
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface Check {
  journeyId: string;
  runNumber: number;
  runId: string;
  completedAt: string | null;
  title: string;
  status: string;
  appId: string;
  appJourneyId: string | null;
  journeyKey: string | null;
  scenario: string | null;
}

const HEALTHY = new Set(["ok", "partial"]);

function main() {
  const checks = sql<Check>(
    `SELECT j.id AS journeyId, r.runNumber, r.id AS runId, r.completedAt, j.title, j.status,
            r.appId, j.appJourneyId, j.journeyKey, j.scenario
     FROM Journey j JOIN Run r ON r.id = j.runId
     WHERE r.appSlug LIKE 'extension:%' AND r.appId IS NOT NULL
     ORDER BY r.runNumber ASC, j."order" ASC;`,
  );
  if (checks.length === 0) {
    console.log("No extension journey checks with an App — nothing to recompute.");
    return;
  }

  const appId = checks[0].appId;
  const catalog = sql<{ id: string; key: string; title: string; scenario: string | null; walkCount: number }>(
    `SELECT id, key, title, scenario, walkCount FROM AppJourney WHERE appId = ${quote(appId)};`,
  );

  console.log(`App ${appId} — ${checks.length} checks across ${new Set(checks.map((c) => c.runNumber)).size} runs\n`);
  console.log("Catalog as it stands:");
  for (const row of catalog) {
    console.log(`  ${row.key.padEnd(30)} scenario=${String(row.scenario).padEnd(20)} walks=${row.walkCount}  "${row.title}"`);
  }

  // What each check SHOULD belong to: its scenario, from the title.
  const statements: string[] = [];
  const wanted = new Map<string, { scenario: string | null; title: string; checks: Check[] }>();
  for (const c of checks) {
    const scenario = SCENARIO_BY_TITLE[c.title] ?? null;
    const groupKey = scenario ?? `title:${c.title}`;
    const group = wanted.get(groupKey) ?? { scenario, title: c.title, checks: [] };
    group.checks.push(c);
    wanted.set(groupKey, group);
    if (c.scenario !== scenario && scenario) {
      statements.push(`UPDATE Journey SET scenario = ${quote(scenario)} WHERE id = ${quote(c.journeyId)};`);
    }
  }

  console.log("\nWhat the checks say:");
  for (const [groupKey, group] of wanted) {
    const runs = group.checks.map((c) => `#${c.runNumber}`).join(", ");
    console.log(`  ${groupKey.padEnd(24)} ${group.checks.length} walk(s) — ${runs}  "${group.title}"`);
  }

  // Each scenario needs its own catalog row. Reuse one that already carries the
  // scenario, or one whose title matches and has no scenario yet; otherwise it
  // has to be created.
  console.log("\nPlan:");
  for (const [, group] of wanted) {
    if (!group.scenario) continue;
    const byScenario = catalog.find((r) => r.scenario === group.scenario);
    const byTitle = catalog.find((r) => !r.scenario && r.title === group.title);
    const target = byScenario ?? byTitle;

    const walks = group.checks.filter((c) => c.status !== "skipped");
    const last = [...walks].reverse().find((c) => c.completedAt);
    // The failure streak, counted from the end: consecutive non-healthy walks.
    let streak = 0;
    for (const c of [...walks].reverse()) {
      if (HEALTHY.has(c.status)) break;
      streak += 1;
    }

    if (!target) {
      console.log(`  CREATE row for ${group.scenario} — "${group.title}", ${walks.length} walk(s)`);
      const id = `aj${Math.random().toString(36).slice(2, 12)}`;
      const key = `${group.scenario.replace(/[^a-z0-9]+/g, "-")}`;
      statements.push(
        `INSERT INTO AppJourney (id, appId, key, title, aliases, plan, scenario, status, walkCount, consecutiveBad, costUsd, createdAt, updatedAt) ` +
          `VALUES (${quote(id)}, ${quote(appId)}, ${quote(key)}, ${quote(group.title)}, ${quote(JSON.stringify([group.title]))}, '[]', ` +
          `${quote(group.scenario)}, ${quote(last?.status ?? "ok")}, ${walks.length}, ${streak}, 0, datetime('now'), datetime('now'));`,
      );
      if (last) {
        statements.push(
          `UPDATE AppJourney SET lastWalkedAt = ${quote(last.completedAt as string)}, lastWalkedRunId = ${quote(last.runId)}, ` +
            `lastRunId = ${quote(last.runId)}, lastRunNumber = ${last.runNumber} WHERE id = ${quote(id)};`,
        );
      }
      for (const c of group.checks) {
        statements.push(`UPDATE Journey SET appJourneyId = ${quote(id)}, journeyKey = ${quote(key)} WHERE id = ${quote(c.journeyId)};`);
      }
      continue;
    }

    const misfiled = group.checks.filter((c) => c.appJourneyId !== target.id);
    const countWrong = target.walkCount !== walks.length;
    if (misfiled.length === 0 && !countWrong && target.scenario === group.scenario) {
      console.log(`  ok     ${group.scenario} → ${target.key} (${walks.length} walk(s))`);
      continue;
    }
    console.log(
      `  FIX    ${group.scenario} → ${target.key}: ` +
        `${misfiled.length} check(s) re-pointed, walkCount ${target.walkCount} → ${walks.length}`,
    );
    if (target.scenario !== group.scenario) {
      statements.push(`UPDATE AppJourney SET scenario = ${quote(group.scenario)} WHERE id = ${quote(target.id)};`);
    }
    for (const c of misfiled) {
      statements.push(`UPDATE Journey SET appJourneyId = ${quote(target.id)}, journeyKey = ${quote(target.key)} WHERE id = ${quote(c.journeyId)};`);
    }
    statements.push(
      `UPDATE AppJourney SET walkCount = ${walks.length}, consecutiveBad = ${streak}, status = ${quote(last?.status ?? "ok")}` +
        (last ? `, lastWalkedAt = ${quote(last.completedAt as string)}, lastWalkedRunId = ${quote(last.runId)}, lastRunId = ${quote(last.runId)}, lastRunNumber = ${last.runNumber}` : "") +
        ` WHERE id = ${quote(target.id)};`,
    );
  }

  if (statements.length === 0) {
    console.log("\nNothing to change — the catalog already matches its checks.");
    return;
  }

  console.log(`\n${statements.length} statement(s):`);
  for (const s of statements) console.log(`  ${s}`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write these.");
    return;
  }

  for (const s of statements) {
    sql(s);
  }
  console.log(`\nApplied ${statements.length} statement(s).`);
}

main();
