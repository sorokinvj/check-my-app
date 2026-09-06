// Full re-check allowance per plan and month (CHE-137, owner 2026-09-06).
//
// The regular re-check is the ladder and is never limited here. A FULL
// re-check (forceFull, CHE-74) is metered: free 0, starter 5, growth 20,
// business 100 a UTC calendar month, enterprise unlimited. Counted as Run rows
// with forceFull for the same owner since the month began. What must hold, all
// through the real functions with a prisma-like stub — no database, no clock:
//   1. the gate per plan at used = 0, limit-1 and limit (ok / ok with 0 left /
//      refused), and the refusal names the plan's number and the next month;
//   2. enterprise is unlimited (remaining null), free has none and the refusal
//      names the upgrade;
//   3. utcMonthStart is the first of the month at midnight UTC, and the count
//      asks for exactly forceFull rows of this owner since then;
//   4. createRecheckRun: an owner on Starter with 5 used + full → quota and no
//      run; the same owner non-full → created, no allowance consulted; with
//      4 used + full → created with remaining 0; anonymous + full → today's
//      refusal, no count.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-recheck-limits.ts

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "@/lib/enums";
import {
  PLAN_LIMITS,
  fullRecheckGate,
  fullRechecksRemaining,
  fullRechecksUsed,
  nextUtcMonthLabel,
  utcMonthStart,
} from "@/lib/plans";
import { createRecheckRun, type RecheckDeps } from "@/lib/recheck";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// A Saturday in September: the next month is October, and the boundary is
// 2026-09-01T00:00:00Z.
const NOW = new Date("2026-09-06T21:15:00.000Z");

async function main() {
  // --- 1 + 2: the pure gate --------------------------------------------------

  const EXPECTED: Record<UserPlan, number | null> = {
    free: 0,
    starter: 5,
    growth: 20,
    business: 100,
    enterprise: null,
  };

  for (const plan of Object.keys(EXPECTED) as UserPlan[]) {
    const limit = PLAN_LIMITS[plan].fullRechecksPerMonth;
    check(`${plan}: fullRechecksPerMonth is ${EXPECTED[plan]}`, limit === EXPECTED[plan], String(limit));
    if (limit === null) {
      for (const used of [0, 7, 100_000]) {
        const g = fullRecheckGate(plan, used, NOW);
        check(`${plan}: used ${used} → ok, remaining null`, g.ok && g.remaining === null, JSON.stringify(g));
      }
      continue;
    }
    if (limit === 0) {
      const g = fullRecheckGate(plan, 0, NOW);
      check(`${plan}: used 0 → refused`, !g.ok, JSON.stringify(g));
      check(`${plan}: refusal names the upgrade and Starter's number`,
        !g.ok && /Upgrade to Starter/.test(g.reason) && /\b5 a month\b/.test(g.reason), g.ok ? "" : g.reason);
      check(`${plan}: refusal says the regular re-check is still there`,
        !g.ok && /regular re-check is still available/.test(g.reason), g.ok ? "" : g.reason);
      continue;
    }
    const fresh = fullRecheckGate(plan, 0, NOW);
    check(`${plan}: used 0 → ok, remaining ${limit - 1}`, fresh.ok && fresh.remaining === limit - 1, JSON.stringify(fresh));
    const last = fullRecheckGate(plan, limit - 1, NOW);
    check(`${plan}: used ${limit - 1} → ok, remaining 0`, last.ok && last.remaining === 0, JSON.stringify(last));
    const at = fullRecheckGate(plan, limit, NOW);
    check(`${plan}: used ${limit} → refused`, !at.ok, JSON.stringify(at));
    check(`${plan}: refusal names ${limit} a month and October 1`,
      !at.ok && new RegExp(`\\b${limit} a month\\b`).test(at.reason) && /until October 1\b/.test(at.reason),
      at.ok ? "" : at.reason);
    check(`${plan}: refusal says the regular re-check is still there`,
      !at.ok && /regular re-check is still available/.test(at.reason), at.ok ? "" : at.reason);
    const over = fullRecheckGate(plan, limit + 3, NOW);
    check(`${plan}: used ${limit + 3} → refused`, !over.ok, JSON.stringify(over));
  }

  // The refusal must not leak our machinery: no model, cost, browser, or
  // homework for the customer.
  {
    const g = fullRecheckGate("starter", 5, NOW);
    check("refusal wording is about their plan only",
      !g.ok && !/\$|token|model|browser|playwright|headless|verify (this|it) yourself/i.test(g.reason),
      g.ok ? "" : g.reason);
  }

  // --- 3: the month boundary and the counting contract -----------------------

  {
    check("utcMonthStart: first of the month, midnight UTC",
      utcMonthStart(NOW).toISOString() === "2026-09-01T00:00:00.000Z", utcMonthStart(NOW).toISOString());
    // Last second of the month in UTC is still this month; the first second of
    // the next is next month, whatever a local clock would say.
    const lastSecond = new Date("2026-09-30T23:59:59.000Z");
    check("utcMonthStart: 23:59:59Z on the 30th is still September",
      utcMonthStart(lastSecond).toISOString() === "2026-09-01T00:00:00.000Z");
    const firstSecond = new Date("2026-10-01T00:00:00.000Z");
    check("utcMonthStart: 00:00:00Z on Oct 1 is October",
      utcMonthStart(firstSecond).toISOString() === "2026-10-01T00:00:00.000Z");
    check("nextUtcMonthLabel: September → October 1", nextUtcMonthLabel(NOW) === "October 1", nextUtcMonthLabel(NOW));
    const december = new Date("2026-12-15T12:00:00.000Z");
    check("nextUtcMonthLabel: December → January 1", nextUtcMonthLabel(december) === "January 1", nextUtcMonthLabel(december));
    const decGate = fullRecheckGate("starter", 5, december);
    check("December refusal names January 1", !decGate.ok && /until January 1\b/.test(decGate.reason), decGate.ok ? "" : decGate.reason);
  }

  type CountWhere = { ownerId?: string | null; forceFull?: boolean; createdAt?: { gte: Date } };

  {
    const calls: CountWhere[] = [];
    const db = {
      run: {
        count: async ({ where }: { where: CountWhere }) => {
          calls.push(where);
          return 3;
        },
      },
    } as unknown as PrismaClient;
    const used = await fullRechecksUsed(db, "owner-1", NOW);
    check("fullRechecksUsed returns the count", used === 3, String(used));
    const w = calls[0];
    check("fullRechecksUsed: this owner's forceFull rows since the month began",
      w.ownerId === "owner-1" && w.forceFull === true && w.createdAt?.gte.toISOString() === "2026-09-01T00:00:00.000Z",
      JSON.stringify(w));

    const dash = await fullRechecksRemaining(db, { id: "owner-1", plan: "starter" }, NOW);
    check("fullRechecksRemaining (starter, 3 used): 2 of 5 left, resets October 1",
      dash.used === 3 && dash.limit === 5 && dash.remaining === 2 && dash.resetsOn === "October 1", JSON.stringify(dash));
    const ent = await fullRechecksRemaining(db, { id: "owner-1", plan: "enterprise" }, NOW);
    check("fullRechecksRemaining (enterprise): limit and remaining null",
      ent.limit === null && ent.remaining === null, JSON.stringify(ent));
    const overDb = { run: { count: async () => 9 } } as unknown as PrismaClient;
    const over = await fullRechecksRemaining(overDb, { id: "owner-1", plan: "starter" }, NOW);
    check("fullRechecksRemaining never goes negative", over.remaining === 0, JSON.stringify(over));
  }

  // --- 4: createRecheckRun with a stub prisma --------------------------------

  type PrevRow = {
    id: string;
    targetUrl: string;
    appSlug: string;
    testEmail: string | null;
    testPasswordEnc: string | null;
    scopeHints: string | null;
    userNotes: string | null;
    focusAreas: string | null;
    notifyEmail: string | null;
    watchId: string | null;
    appId: string | null;
    ownerId: string | null;
    owner: { plan: string } | null;
  };

  function prevRow(ownerId: string | null, plan: string | null): PrevRow {
    return {
      id: "run_prev",
      targetUrl: "https://example.test",
      appSlug: "example-test",
      testEmail: null,
      testPasswordEnc: null,
      scopeHints: null,
      userNotes: null,
      focusAreas: null,
      notifyEmail: null,
      watchId: null,
      appId: null,
      ownerId,
      owner: plan ? { plan } : null,
    };
  }

  // Answers the calls createRecheckRun makes: the previous run, the allowance
  // count (only when asked), the runNumber counter, the create. Everything is
  // recorded so a test can say "no count was consulted" or "no run was created".
  function stubDb(prev: PrevRow | null, fullUsed: number) {
    const counts: CountWhere[] = [];
    const creates: Array<Record<string, unknown>> = [];
    const db = {
      run: {
        findUnique: async ({ where }: { where: { publicId?: string; runNumber?: number } }) => {
          if (where.publicId) return prev;
          return null; // nextRunNumber's clash check
        },
        findFirst: async () => null, // no fresh verdict to reuse; no max runNumber
        count: async ({ where }: { where: CountWhere }) => {
          counts.push(where);
          if (where.forceFull === true) return fullUsed;
          return 0;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          creates.push(data);
          return { id: `run_new_${creates.length}`, publicId: `pub_new_${creates.length}` };
        },
      },
      counter: {
        upsert: async () => ({ name: "runNumber", value: 42 }),
      },
    };
    return { db: db as unknown as PrismaClient, counts, creates };
  }

  function stubDeps(): RecheckDeps & { triggered: string[] } {
    const triggered: string[] = [];
    return {
      triggered,
      canMutate: async () => true,
      trigger: async (id) => void triggered.push(id),
      siteCap: () => 20,
      now: () => NOW,
    };
  }

  // Owner on Starter, 5 full re-checks this month, asks for a full one → quota,
  // nothing created, nothing triggered.
  {
    const { db, creates } = stubDb(prevRow("owner-1", "starter"), 5);
    const deps = stubDeps();
    const r = await createRecheckRun(db, "pub_prev", { full: true }, deps);
    check("starter, 5 used, full → quota", r.kind === "quota", JSON.stringify(r));
    check("starter, 5 used, full → the refusal names 5 a month and October 1",
      r.kind === "quota" && /\b5 a month\b/.test(r.reason) && /until October 1\b/.test(r.reason),
      r.kind === "quota" ? r.reason : "");
    check("starter, 5 used, full → no run created, nothing triggered",
      creates.length === 0 && deps.triggered.length === 0, `${creates.length} creates, ${deps.triggered.length} triggers`);
  }

  // The same owner, regular re-check → created as before; the allowance is not
  // even consulted, and the run is not forceFull.
  {
    const { db, counts, creates } = stubDb(prevRow("owner-1", "starter"), 5);
    const deps = stubDeps();
    const r = await createRecheckRun(db, "pub_prev", { full: false }, deps);
    check("starter, 5 used, regular → ok", r.kind === "ok", JSON.stringify(r));
    check("starter, regular → no allowance count consulted", !counts.some((w) => w.forceFull === true), `${counts.length} counts`);
    check("starter, regular → run created with forceFull false, owner kept, baseline set",
      creates.length === 1 && creates[0].forceFull === false && creates[0].ownerId === "owner-1" && creates[0].baselineRunId === "run_prev",
      JSON.stringify(creates[0]));
    check("starter, regular → triggered once", deps.triggered.length === 1, String(deps.triggered.length));
    check("starter, regular → no `remaining` on the result", r.kind === "ok" && !("remaining" in r), JSON.stringify(r));
  }

  // The same owner with 4 used → the fifth is created, forceFull, and the result
  // says 0 remain after it.
  {
    const { db, counts, creates } = stubDb(prevRow("owner-1", "starter"), 4);
    const deps = stubDeps();
    const r = await createRecheckRun(db, "pub_prev", { full: true }, deps);
    check("starter, 4 used, full → ok with remaining 0", r.kind === "ok" && r.remaining === 0, JSON.stringify(r));
    check("starter, 4 used, full → run created with forceFull true",
      creates.length === 1 && creates[0].forceFull === true, JSON.stringify(creates[0]));
    const w = counts.find((c) => c.forceFull === true);
    check("starter, full → the count is this owner's forceFull rows since Sept 1",
      !!w && w.ownerId === "owner-1" && w.createdAt?.gte.toISOString() === "2026-09-01T00:00:00.000Z", JSON.stringify(w));
  }

  // Growth, 0 used → 19 remain after this one. Enterprise → null.
  {
    const growth = await createRecheckRun(stubDb(prevRow("owner-2", "growth"), 0).db, "pub_prev", { full: true }, stubDeps());
    check("growth, 0 used, full → remaining 19", growth.kind === "ok" && growth.remaining === 19, JSON.stringify(growth));
    const ent = await createRecheckRun(stubDb(prevRow("owner-3", "enterprise"), 500).db, "pub_prev", { full: true }, stubDeps());
    check("enterprise, 500 used, full → ok, remaining null", ent.kind === "ok" && ent.remaining === null, JSON.stringify(ent));
  }

  // Free owner, full → refused with the upgrade; regular → created.
  {
    const { db, creates } = stubDb(prevRow("owner-4", "free"), 0);
    const r = await createRecheckRun(db, "pub_prev", { full: true }, stubDeps());
    check("free, full → quota naming the upgrade",
      r.kind === "quota" && /Upgrade to Starter/.test(r.reason) && creates.length === 0, JSON.stringify(r));
    const regular = await createRecheckRun(db, "pub_prev", { full: false }, stubDeps());
    check("free, regular → ok", regular.kind === "ok" && creates.length === 1, JSON.stringify(regular));
  }

  // Anonymous + full → today's refusal (CHE-94), no allowance count, no run.
  {
    const { db, counts, creates } = stubDb(prevRow(null, null), 0);
    const deps = stubDeps();
    const r = await createRecheckRun(db, "pub_prev", { full: true, anonKeyHash: "hash-a" }, deps);
    check("anonymous, full → quota (sign in as the owner)",
      r.kind === "quota" && /owner of this app/.test(r.reason) && /Sign in/.test(r.reason), JSON.stringify(r));
    check("anonymous, full → no allowance count, no run",
      !counts.some((w) => w.forceFull === true) && creates.length === 0 && deps.triggered.length === 0,
      `${counts.length} counts, ${creates.length} creates`);
  }

  // Not the owner → unauthorized before any counting.
  {
    const { db, counts } = stubDb(prevRow("owner-1", "starter"), 0);
    const deps = { ...stubDeps(), canMutate: async () => false };
    const r = await createRecheckRun(db, "pub_prev", { full: true }, deps);
    check("someone else, full → unauthorized, nothing counted", r.kind === "unauthorized" && counts.length === 0, JSON.stringify(r));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
