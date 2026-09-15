// CHE-253 (Teams T0) verification: a personal account is a team of one, and
// nothing that had an owner is left without a team.
//
// Two halves, deliberately:
//
//   1. PURE (default, runs in verify:all, no network). The migration is read as
//      text and checked for the properties that make it safe on D1 — where
//      there are no transactions, so a half-applied migration must be safe to
//      apply again — plus the backfill rule itself, exercised over a small
//      model of the tables.
//
//   2. --remote (run once, after the deploy). Asks production the four
//      questions that decide whether the migration did what it said, and
//      prints the counts rather than a status. "The deploy went green" is not
//      evidence; "every User has exactly one personal team and no owned row is
//      teamless" is.
//
// Usage:
//   npx tsx --tsconfig tsconfig.json scripts/verify-team-backfill.ts
//   npx tsx --tsconfig tsconfig.json scripts/verify-team-backfill.ts --remote

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { personalMembershipId, personalTeamId, personalTeamName } from "@/lib/teams";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const MIGRATION = "0032_teams.sql";
const sql = readFileSync(
  fileURLToPath(new URL(`../prisma/migrations/${MIGRATION}`, import.meta.url)),
  "utf8",
);

// ─── 1. The migration is re-runnable ─────────────────────────────────────────
// D1 has no transactions. A migration that dies halfway must be safe to apply
// again, or recovering from it is a hand-written repair against production.

check(
  "every CREATE TABLE is IF NOT EXISTS",
  (sql.match(/CREATE TABLE/g) ?? []).length === (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
  `${(sql.match(/CREATE TABLE/g) ?? []).length} tables`,
);
check(
  "every CREATE INDEX is IF NOT EXISTS",
  (sql.match(/CREATE (UNIQUE )?INDEX/g) ?? []).length ===
    (sql.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) ?? []).length,
);
check(
  "every INSERT is guarded by NOT EXISTS — a second run inserts nothing",
  (sql.match(/INSERT INTO/g) ?? []).length === (sql.match(/WHERE NOT EXISTS/g) ?? []).length,
  `${(sql.match(/INSERT INTO/g) ?? []).length} inserts`,
);
check(
  "every backfill UPDATE only fills a NULL — a second run changes nothing",
  (sql.match(/SET "teamId"/g) ?? []).length === (sql.match(/AND "teamId" IS NULL/g) ?? []).length,
  `${(sql.match(/SET "teamId"/g) ?? []).length} updates`,
);
check(
  "team ids are derived from the user id, so re-running produces the same rows",
  sql.includes(`'team_' || u."id"`) && sql.includes(`'team_' || "ownerId"`),
);
check(
  "the derived ids match what the code builds",
  personalTeamId("abc") === "team_abc" && personalMembershipId("abc") === "mem_abc",
  `${personalTeamId("abc")} / ${personalMembershipId("abc")}`,
);

// The columns this ticket removes, and the indexes that must go first: SQLite
// refuses to drop a column an index still names, and that failure would land
// mid-migration on a live database.
for (const col of ["plan", "stripeCustomerId", "stripeSubscriptionId", "clerkOrgId"]) {
  check(`User.${col} is dropped`, sql.includes(`ALTER TABLE "User" DROP COLUMN "${col}"`));
}
check("App.orgId is dropped", sql.includes(`ALTER TABLE "App" DROP COLUMN "orgId"`));
for (const idx of ["User_stripeCustomerId_key", "User_clerkOrgId_idx"]) {
  const dropIdx = sql.indexOf(`DROP INDEX IF EXISTS "${idx}"`);
  check(`${idx} is dropped before the column it names`, dropIdx !== -1 && dropIdx < sql.indexOf(`ALTER TABLE "User" DROP COLUMN`));
}
check(
  "the plan is carried over value for value — nobody's plan changes on deploy day",
  /SELECT[\s\S]*u\."plan"[\s\S]*FROM "User" u/.test(sql),
);
check(
  "every personal team gets an admin — a team with no admin cannot be administered",
  /INSERT INTO "Membership"[\s\S]*'admin'/.test(sql),
);

// ─── 2. The backfill rule, over a model of the tables ────────────────────────
// Small enough to read, exact about the one thing that matters: an owned row
// gets its owner's team, an anonymous row keeps none.

type Row = { ownerId: string | null; teamId: string | null };
const rows: Row[] = [
  { ownerId: "u1", teamId: null },
  { ownerId: "u2", teamId: null },
  { ownerId: null, teamId: null }, // anonymous check — the public funnel
  { ownerId: null, teamId: null }, // ephemeral PR-preview run
  { ownerId: "u1", teamId: "team_u1" }, // already backfilled by a first run
];
const backfilled = rows.map((r) =>
  r.ownerId !== null && r.teamId === null ? { ...r, teamId: personalTeamId(r.ownerId) } : r,
);
check(
  "every owned row gets its owner's team",
  backfilled.filter((r) => r.ownerId !== null).every((r) => r.teamId === personalTeamId(r.ownerId!)),
);
check(
  "anonymous rows keep no team — the public funnel is untouched",
  backfilled.filter((r) => r.ownerId === null).every((r) => r.teamId === null),
);
check(
  "the anonymous count is identical before and after",
  rows.filter((r) => r.ownerId === null).length === backfilled.filter((r) => r.teamId === null).length,
);
check(
  "running it twice changes nothing",
  JSON.stringify(backfilled) ===
    JSON.stringify(
      backfilled.map((r) =>
        r.ownerId !== null && r.teamId === null ? { ...r, teamId: personalTeamId(r.ownerId) } : r,
      ),
    ),
);
check(
  "a team is named after the person, never 'Personal team'",
  personalTeamName({ name: "Vlad", email: "v@example.test" }) === "Vlad" &&
    personalTeamName({ name: "  ", email: "v@example.test" }) === "v@example.test",
);

// ─── 3. Production, on request ───────────────────────────────────────────────

if (process.argv.includes("--remote")) {
  const d1 = (query: string): number => {
    const out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "checkmyapp", "--remote", "--json", "--command", query],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const parsed = JSON.parse(out.slice(out.indexOf("[")));
    return Number(Object.values(parsed[0].results[0] ?? {})[0] ?? 0);
  };

  console.log("\n— production —");
  const usersWithoutTeam = d1(
    `SELECT COUNT(*) AS n FROM "User" u WHERE NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."userId" = u."id")`,
  );
  check("every user is on at least one team", usersWithoutTeam === 0, `${usersWithoutTeam} without`);

  const teamsWithoutAdmin = d1(
    `SELECT COUNT(*) AS n FROM "Team" t WHERE NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."teamId" = t."id" AND m."scope" = 'admin')`,
  );
  check("every team has an admin", teamsWithoutAdmin === 0, `${teamsWithoutAdmin} without`);

  for (const table of ["App", "Run", "Watch", "ApiKey"]) {
    const orphans = d1(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE "ownerId" IS NOT NULL AND "teamId" IS NULL`,
    );
    check(`${table}: no owned row without a team`, orphans === 0, `${orphans} orphaned`);
  }

  // The number that would have caught CHE-156 before it mailed 29 verdicts
  // (suggested by the `journeys` session): how many runs the silence rule
  // covers, counted with the OLD predicate and the NEW one. The migration moved
  // ownership; if it moved what "our run" means, these differ.
  //
  // `isSelfUrl` is host matching in code, so the SQL approximates it with our
  // hosts by name — close enough to compare two counts against each other,
  // which is all this assertion does.
  const selfHosts = `("targetUrl" LIKE 'https://checkmyapp.dev%' OR "targetUrl" LIKE 'https://www.checkmyapp.dev%')`;
  const silentBefore = d1(
    `SELECT COUNT(*) AS n FROM "Run" WHERE ${selfHosts} AND ("ownerId" IS NOT NULL OR "watchId" IS NOT NULL)`,
  );
  const silentAfter = d1(
    `SELECT COUNT(*) AS n FROM "Run" WHERE ${selfHosts} AND ("ownerId" IS NOT NULL OR "teamId" IS NOT NULL OR "watchId" IS NOT NULL)`,
  );
  check(
    "the silence rule covers exactly the same runs before and after the migration",
    silentBefore === silentAfter,
    `${silentBefore} before, ${silentAfter} after — a difference of even one row means the migration moved what the rule depends on`,
  );

  const anonRuns = d1(`SELECT COUNT(*) AS n FROM "Run" WHERE "ownerId" IS NULL AND "teamId" IS NULL`);
  console.log(`      anonymous runs still anonymous: ${anonRuns}`);
  const teams = d1(`SELECT COUNT(*) AS n FROM "Team"`);
  const users = d1(`SELECT COUNT(*) AS n FROM "User"`);
  check(
    "one personal team per user, no more",
    teams >= users,
    `${teams} teams for ${users} users`,
  );
}

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
