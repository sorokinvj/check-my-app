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
  journeyMetric,
  journeysForKnowledge,
  journeysForMap,
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
  // Enough of Prisma's `where` for these reads: equality, and the one operator
  // the catalog queries use ({ not: null } for "was actually walked").
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && "not" in (v as Row)) return row[k] !== (v as Row).not;
      return row[k] === v;
    });
  const order = (rows: Row[], by: unknown): Row[] => {
    const clauses = (Array.isArray(by) ? by : by ? [by] : []) as Array<Record<string, "asc" | "desc">>;
    if (!clauses.length) return rows;
    return [...rows].sort((a, b) => {
      for (const clause of clauses) {
        const [field, dir] = Object.entries(clause)[0];
        const av = a[field] ?? 0;
        const bv = b[field] ?? 0;
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  };
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
    findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: unknown; take?: number } = {}) => {
      const found = order(rows.filter((r) => matches(r, where)), orderBy);
      return typeof take === "number" ? found.slice(0, take) : found;
    },
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

// 7 — the read paths planning uses (CHE-232).
{
  const { env } = stubDb();
  const core = await resolveJourney(env, APP, "Sign up for a new account");
  const rare = await resolveJourney(env, APP, "Explore the roles directory");
  const blind = await resolveJourney(env, APP, "Install the Chrome extension");
  // Walked twenty times; the plan is what the last walk actually did.
  for (let n = 1; n <= 20; n += 1) {
    await recordWalk(env, { appJourneyId: core.appJourneyId, runId: `r${n}`, runNumber: n, title: "Sign up for a new account", status: "ok", plan: ["open /signup", "fill the form", "submit"], at: day(n % 28 || 1) });
  }
  await recordWalk(env, { appJourneyId: rare.appJourneyId, runId: "r21", runNumber: 21, title: "Explore the roles directory", status: "confusing", plan: [], at: day(2) });
  await recordWalk(env, { appJourneyId: blind.appJourneyId, runId: "r22", runNumber: 22, title: "Install the Chrome extension", status: "skipped", plan: [], at: day(3) });

  const map = await journeysForMap(env, "app_1", 12);
  check("the map is the app's journeys, best-established first", map?.[0].title === "Sign up for a new account", JSON.stringify(map?.map((j) => j.title)));
  check("…with the plan the last walk actually took", map?.[0].steps.join(" | ") === "open /signup | fill the form | submit", JSON.stringify(map?.[0].steps));
  check("…a journey with no plan is offered by its title, not as an empty one", map?.[1].steps.length === 1 && map?.[1].steps[0] === "Explore the roles directory", JSON.stringify(map?.[1]));
  check("…and a journey whose last walk verified nothing is left out", !map?.some((j) => j.title.includes("Chrome extension")), JSON.stringify(map?.map((j) => j.title)));

  const known = await journeysForKnowledge(env, "app_1", 5);
  check("knowledge names the journeys and how each one last ended", known[0].status === "ok" && known[1].status === "confusing", JSON.stringify(known));
  check("…dated by the last real walk", /^\d{4}-\d{2}-\d{2}T/.test(known[0].walkedAt), known[0].walkedAt);

  const { env: empty } = stubDb();
  check("an app with no journeys yet hands back no map at all, not an empty one", (await journeysForMap(empty, "app_1", 12)) === null);
  check("…and no knowledge", (await journeysForKnowledge(empty, "app_1", 5)).length === 0);

  // A journey that has never been walked is a proposal, not history.
  const { env: fresh } = stubDb();
  await resolveJourney(fresh, APP, "Sign up for a new account");
  check("a journey nothing has walked yet is not offered as knowledge", (await journeysForKnowledge(fresh, "app_1", 5)).length === 0);
}

// 8 — the price the user pays, on the catalog (CHE-235).
{
  const { env, appJourney } = stubDb();
  const j = await resolveJourney(env, APP, "Sign up for a new account", "app");
  check("a journey remembers where it lives", appJourney[0].surface === "app", String(appJourney[0].surface));

  const first = await journeyMetric(env, j.appJourneyId, { price: 6, conversion: 65, note: "five fields and a late password rule" });
  await recordWalk(env, { appJourneyId: j.appJourneyId, runId: "r1", runNumber: 1, title: "Sign up for a new account", status: "ok", plan: ["open /signup"], metric: first, at: day(1) });
  check("the first price lands on the journey", appJourney[0].price === 6 && appJourney[0].conversion === 65);
  check("…with nothing behind it yet", appJourney[0].prevPrice === undefined || appJourney[0].prevPrice === null);
  check("…and the run that set it", appJourney[0].metricRunId === "r1");

  const moved = await journeyMetric(env, j.appJourneyId, { price: 8, conversion: 45, note: "two fields added and an email code is now required" });
  await recordWalk(env, { appJourneyId: j.appJourneyId, runId: "r2", runNumber: 2, title: "Sign up for a new account", status: "ok", plan: ["open /signup"], metric: moved, at: day(2) });
  check("a named change moves the number", appJourney[0].price === 8 && appJourney[0].conversion === 45);
  check("…and keeps what it was before", appJourney[0].prevPrice === 6 && appJourney[0].prevConversion === 65, `${appJourney[0].prevPrice}/${appJourney[0].prevConversion}`);

  const silent = await journeyMetric(env, j.appJourneyId, { price: 9, conversion: 40, note: "" });
  check("an unexplained change is not even offered to the catalog", silent === null);
  await recordWalk(env, { appJourneyId: j.appJourneyId, runId: "r3", runNumber: 3, title: "Sign up for a new account", status: "ok", plan: ["open /signup"], metric: silent, at: day(3) });
  check("…so the stored number stands", appJourney[0].price === 8 && appJourney[0].conversion === 45);
  check("…and so does the run that really set it", appJourney[0].metricRunId === "r2", String(appJourney[0].metricRunId));

  const confirmed = await journeyMetric(env, j.appJourneyId, { price: 8, conversion: 45, note: "" });
  await recordWalk(env, { appJourneyId: j.appJourneyId, runId: "r4", runNumber: 4, title: "Sign up for a new account", status: "ok", plan: ["open /signup"], metric: confirmed, at: day(4) });
  check("confirming a number does not erase what it moved from", appJourney[0].prevPrice === 6 && appJourney[0].prevConversion === 65, `${appJourney[0].prevPrice}/${appJourney[0].prevConversion}`);

  // A page with more than one journey on it — the owner's case.
  const second = await resolveJourney(env, APP, "Upload your resume", "/settings");
  const third = await resolveJourney(env, APP, "Pair the Chrome extension", "/settings");
  check("two journeys on one page are two journeys", second.appJourneyId !== third.appJourneyId && appJourney.length === 3, `${appJourney.length} rows`);
  const again = await resolveJourney(env, APP, "Upload a resume file", "/settings");
  check("…and a reworded one rejoins its own", again.appJourneyId === second.appJourneyId);

  // An anonymous run has no catalog row to compare against — it still prices
  // the journey for its own row, as a first value.
  check(
    "a run with no catalog still prices the journey for its own row",
    (await journeyMetric(env, null, { price: 3, conversion: 90, note: "an anonymous check still counts actions" }))?.price === 3,
  );
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
