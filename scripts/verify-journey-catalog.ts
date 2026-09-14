// CHE-231 — the catalog writer, held to the rules it exists to keep.
//
// scripts/verify-journey-identity.ts proves the identity rules against the
// titles production wrote. This proves what the writer does with that identity,
// by driving the real resolveJourney / recordWalk / recordCarry against an
// in-memory database (the stub style of verify-ephemeral.ts):
//
//   1. The same journey under three wordings is ONE row with three aliases.
//   2. A carried journey never moves lastWalkedAt, walkCount or the streak —
//      carrying is "this run had it", never "this run checked it".
//   3. An all-skipped walk verified nothing and does not count as a walk.
//   4. The failure streak counts consecutive bad walks and a healthy walk ends
//      it — a streak that cannot end is the CHE-109 mistake in a new column.
//   5. A run with no App gets an identity and no row: there is no history for a
//      one-off anonymous check to accumulate.
//   6. Cost lands on the check AND on the journey's running total.
//
// Run: npx tsx --tsconfig tsconfig.json scripts/verify-journey-catalog.ts

import type { AgentEnv } from "@/agent/env";
import { parseJson } from "@/lib/json";
import {
  recordCarry,
  recordJourneyCost,
  recordWalk,
  resolveJourney,
  withAlias,
} from "@/agent/journey-catalog";

type Row = Record<string, unknown>;

let failures = 0;
function check(what: string, ok: boolean, detail = "") {
  if (ok) console.log(`PASS  ${what}`);
  else {
    failures += 1;
    console.log(`FAIL  ${what}${detail ? `  →  ${detail}` : ""}`);
  }
}

// A database just real enough for this module: findMany/findFirst/findUnique/
// create/update over two arrays, including Prisma's { increment } shorthand.
function stubDb() {
  const appJourney: Row[] = [];
  const journey: Row[] = [];
  let ids = 0;
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as Row)) {
        row[k] = ((row[k] as number) ?? 0) + Number((v as Row).increment);
      } else {
        row[k] = v;
      }
    }
  };
  const table = (rows: Row[], defaults: Row = {}) => ({
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: `x${++ids}`, createdAt: new Date(), ...defaults, ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error("no such row");
      apply(row, data);
      return row;
    },
  });
  const db = { appJourney: table(appJourney, { walkCount: 0, consecutiveBad: 0, costUsd: 0 }), journey: table(journey) };
  return { env: { db } as unknown as AgentEnv, appJourney, journey };
}

const APP = { appId: "app_1" };
const day = (n: number) => new Date(`2026-09-${String(n).padStart(2, "0")}T12:00:00.000Z`);

async function main() {
// 1 — one journey, three wordings.
{
  const { env, appJourney } = stubDb();
  const a = await resolveJourney(env, APP, "Sign up for a new account");
  const b = await resolveJourney(env, APP, "Account Registration");
  const c = await resolveJourney(env, APP, "New user signs up via email/password");
  check("three wordings of signing up resolve to one journey", a.appJourneyId === b.appJourneyId && b.appJourneyId === c.appJourneyId, `${a.appJourneyId} / ${b.appJourneyId} / ${c.appJourneyId}`);
  check("…and the first one is the one that opened it", a.isNew && !b.isNew && !c.isNew);
  check("…under the key its intent names", a.key === "signup", a.key);
  check("…and only one row exists", appJourney.length === 1, `${appJourney.length} rows`);

  for (const title of ["Sign up for a new account", "Account Registration", "New user signs up via email/password"]) {
    await recordWalk(env, { appJourneyId: a.appJourneyId, runId: "r1", runNumber: 1, title, status: "ok", plan: ["open /signup"], at: day(1) });
  }
  const aliases = parseJson<string[]>(String(appJourney[0].aliases)) ?? [];
  check("every wording is kept as an alias — a merge is auditable, not just asserted", aliases.length === 3, aliases.join(" | "));
  check("the row's title is the wording of the last walk", appJourney[0].title === "New user signs up via email/password", String(appJourney[0].title));

  // A different intent must not join it.
  const login = await resolveJourney(env, APP, "Log in to an existing account");
  check("logging in opens its own journey", login.appJourneyId !== a.appJourneyId && appJourney.length === 2, `${appJourney.length} rows`);
}

// 2 — carrying is not checking.
{
  const { env, appJourney } = stubDb();
  const j = await resolveJourney(env, APP, "Practice an interview with the AI coach");
  await recordWalk(env, { appJourneyId: j.appJourneyId, runId: "r1", runNumber: 1, title: "Practice an interview with the AI coach", status: "ok", plan: ["open /practice"], at: day(1) });
  const walkedAt = appJourney[0].lastWalkedAt as Date;
  await recordCarry(env, { appJourneyId: j.appJourneyId, runId: "r2", runNumber: 2 });
  check("a carry records that the run had the journey", appJourney[0].lastRunNumber === 2);
  check("a carry does not move lastWalkedAt", appJourney[0].lastWalkedAt === walkedAt);
  check("a carry does not move lastWalkedRunId", appJourney[0].lastWalkedRunId === "r1");
  check("a carry does not count as a walk", appJourney[0].walkCount === 1, String(appJourney[0].walkCount));
}

// 3 — a walk that verified nothing.
{
  const { env, appJourney } = stubDb();
  const j = await resolveJourney(env, APP, "Install the Chrome extension");
  await recordWalk(env, { appJourneyId: j.appJourneyId, runId: "r1", runNumber: 1, title: "Install the Chrome extension", status: "skipped", plan: [], at: day(1) });
  check("an all-skipped walk is recorded as the journey's status", appJourney[0].status === "skipped");
  check("…but never as a walk", appJourney[0].walkCount === 0 && appJourney[0].lastWalkedAt == null);
  check("…and leaves the plan alone", (appJourney[0].plan ?? "[]") === "[]", String(appJourney[0].plan));
}

// 4 — the streak, and its end.
{
  const { env, appJourney } = stubDb();
  const j = await resolveJourney(env, APP, "Checkout and pay");
  const walk = (n: number, status: string) =>
    recordWalk(env, { appJourneyId: j.appJourneyId, runId: `r${n}`, runNumber: n, title: "Checkout and pay", status, plan: ["open /cart"], at: day(n) });
  await walk(1, "ok");
  check("a healthy journey has no streak and no failing-since", appJourney[0].consecutiveBad === 0 && appJourney[0].failingSince === null);
  await walk(2, "broken");
  await walk(3, "broken");
  check("two bad walks in a row count two", appJourney[0].consecutiveBad === 2, String(appJourney[0].consecutiveBad));
  check("failing-since is the FIRST bad walk, not the latest", (appJourney[0].failingSince as Date).toISOString() === day(2).toISOString(), String(appJourney[0].failingSince));
  await walk(4, "partial");
  check("a healthy walk ends the streak", appJourney[0].consecutiveBad === 0 && appJourney[0].failingSince === null);
  check("…and the walk count is every walk, healthy or not", appJourney[0].walkCount === 4, String(appJourney[0].walkCount));
}

// 5 — no App, no catalog.
{
  const { env, appJourney } = stubDb();
  const j = await resolveJourney(env, { appId: null }, "Sign up for a new account");
  check("an anonymous run still gets the identity", j.key === "signup", j.key);
  check("…and no catalog row", j.appJourneyId === null && appJourney.length === 0);
  await recordWalk(env, { appJourneyId: null, runId: "r1", runNumber: 1, title: "Sign up", status: "ok", plan: [] });
  check("…and writing one is a no-op, not a crash", appJourney.length === 0);
}

// 6 — cost, on the check and on the journey.
{
  const { env, appJourney, journey } = stubDb();
  const j = await resolveJourney(env, APP, "Practice an interview with the AI coach");
  const check1 = await env.db.journey.create({ data: { runId: "r1", order: 0, title: "Practice", status: "ok", appJourneyId: j.appJourneyId } });
  await recordJourneyCost(env, { journeyId: check1.id, appJourneyId: j.appJourneyId, costUsd: 0.1234 });
  const check2 = await env.db.journey.create({ data: { runId: "r2", order: 0, title: "Practice", status: "ok", appJourneyId: j.appJourneyId } });
  await recordJourneyCost(env, { journeyId: check2.id, appJourneyId: j.appJourneyId, costUsd: 0.2 });
  check("each check carries what it cost", journey[0].costUsd === 0.1234 && journey[1].costUsd === 0.2);
  check("the journey carries what it has cost us so far", Math.abs((appJourney[0].costUsd as number) - 0.3234) < 1e-9, String(appJourney[0].costUsd));
}

// Aliases: bounded, deduped on the normalised form, newest last.
{
  check("an alias list dedupes on wording, not on case", withAlias(["Sign Up"], "sign up").length === 1);
  check("…keeps the newest spelling", withAlias(["Sign Up"], "sign up")[0] === "sign up");
  const many = Array.from({ length: 60 }, (_, i) => `title ${i}`);
  check("…and is bounded", withAlias(many, "one more").length === 40, String(withAlias(many, "one more").length));
}
}

main().then(() => {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
