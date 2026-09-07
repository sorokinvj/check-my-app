// CHE-202 verification: a PR-preview hostname is a run, not an app.
//
// Exercised against a stub Prisma and a stub R2 bucket — no database, no
// network — through the real functions:
//   1. the gate: an anonymous request for an ephemeral run is refused with the
//      code the API answers 400 with; an owner's is allowed; nobody who did
//      not ask gets one;
//   2. the TTL: only a positive integer in EPHEMERAL_RUN_TTL_DAYS counts,
//      anything else is the 7-day default;
//   3. startCheck for an owner with `ephemeral` creates a run that is marked,
//      dated, owned — and touches no App table at all (the stub has none and
//      throws if asked);
//   4. Enable Daily Watch on an ephemeral run is refused before any write —
//      the App upsert it would otherwise do never happens;
//   5. a re-check of an ephemeral run is ephemeral, with a fresh expiry;
//   6. the sweep deletes exactly the expired ephemeral runs with their
//      journeys, steps, findings, evidence rows, ledgers and snapshot, and the
//      R2 objects nothing else references — a screenshot shared with a live
//      run stays; a live ephemeral run and a plain owned run are untouched;
//   7. the janitor: its test-account sweep (rule §6) never touches an
//      ephemeral run — there is no App row for the app-based sweep to find,
//      and an ordinary owner's run is outside the ownership-based one; and
//      the tick's ephemeral sweep hands the R2 binding through.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-ephemeral.ts

process.env.CREDENTIALS_SECRET ??= "verify-ephemeral-secret";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  EPHEMERAL_REQUIRES_OWNER_CODE,
  EPHEMERAL_RUN_TTL_DAYS,
  ephemeralExpiry,
  ephemeralGate,
  ephemeralTtlDaysFromEnv,
  sweepExpiredEphemeralRuns,
} from "@/lib/ephemeral";
import { startCheck } from "@/lib/start-check";
import { enableWatchForRun } from "@/lib/watch-enable";
import { createRecheckRun } from "@/lib/recheck";
import { evidenceUrl } from "@/lib/storage";
import { sweepExpiredEphemeral, sweepTestAccounts } from "@/agent/janitor";
import type { AgentEnv } from "@/agent/env";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ─── A tiny in-memory Prisma: the where-shapes src/lib uses, nothing more ────

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; lt?: Date; gte?: Date; not?: unknown };
      if ("in" in c && !c.in!.includes(v)) return false;
      if ("lt" in c && !(v instanceof Date && v < c.lt!)) return false;
      if ("gte" in c && !(v instanceof Date && v >= c.gte!)) return false;
      if ("not" in c && v === c.not) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

function table(rows: Row[], name: string, log: string[]) {
  return {
    findMany: async ({ where = {}, take }: { where?: Where; take?: number; select?: unknown; orderBy?: unknown }) => {
      const out = rows.filter((r) => matches(r, where));
      return take ? out.slice(0, take) : out;
    },
    findUnique: async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where = {} }: { where?: Where }) => rows.find((r) => matches(r, where)) ?? null,
    deleteMany: async ({ where }: { where: Where }) => {
      const gone = rows.filter((r) => matches(r, where));
      for (const g of gone) rows.splice(rows.indexOf(g), 1);
      log.push(`${name}.deleteMany ${gone.length}`);
      return { count: gone.length };
    },
    create: async ({ data }: { data: Row }) => {
      const row = { id: `${name}_${rows.length + 1}`, publicId: `pub_${name}_${rows.length + 1}`, ...data };
      rows.push(row);
      log.push(`${name}.create`);
      return row;
    },
    update: async ({ where, data }: { where: Where; data: Row }) => {
      const row = rows.find((r) => matches(r, where));
      if (row) Object.assign(row, data);
      log.push(`${name}.update`);
      return row;
    },
    updateMany: async ({ where, data }: { where: Where; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      log.push(`${name}.updateMany ${hit.length}`);
      return { count: hit.length };
    },
    upsert: async () => {
      throw new Error(`${name}.upsert must not be called`);
    },
    count: async ({ where = {} }: { where?: Where }) => rows.filter((r) => matches(r, where)).length,
  };
}

interface World {
  run: Row[];
  journey: Row[];
  step: Row[];
  finding: Row[];
  evidence: Row[];
  llmUsage: Row[];
  createdResource: Row[];
  appSnapshot: Row[];
  watch: Row[];
  user: Row[];
}

function world(): World {
  return {
    run: [],
    journey: [],
    step: [],
    finding: [],
    evidence: [],
    llmUsage: [],
    createdResource: [],
    appSnapshot: [],
    watch: [],
    user: [],
  };
}

function stubDb(w: World) {
  const log: string[] = [];
  let counter = 0;
  const db = {
    run: table(w.run, "run", log),
    journey: table(w.journey, "journey", log),
    step: table(w.step, "step", log),
    finding: table(w.finding, "finding", log),
    evidence: table(w.evidence, "evidence", log),
    llmUsage: table(w.llmUsage, "llmUsage", log),
    createdResource: table(w.createdResource, "createdResource", log),
    appSnapshot: table(w.appSnapshot, "appSnapshot", log),
    watch: table(w.watch, "watch", log),
    user: table(w.user, "user", log),
    counter: { upsert: async () => ({ name: "runNumber", value: ++counter }) },
    // No App table at all: any path that reaches for one throws, and the
    // failure names it.
    get app(): never {
      throw new Error("db.app was touched — an ephemeral run must never reach the App table");
    },
  };
  return { db: db as unknown as PrismaClient, log };
}

function stubBucket() {
  const deleted: string[] = [];
  const bucket = {
    delete: async (keys: string | string[]) => {
      deleted.push(...(Array.isArray(keys) ? keys : [keys]));
    },
  };
  return { bucket: bucket as unknown as R2Bucket, deleted };
}

const NOW = new Date("2026-09-07T12:00:00.000Z");
const OWNER = { id: "user_owner" };

async function main() {
  // 1 — the gate.
  {
    const anon = ephemeralGate(true, null);
    check("gate: anonymous + ephemeral is refused with the owner-required code",
      !anon.ok && anon.code === EPHEMERAL_REQUIRES_OWNER_CODE && /API key|sign in/i.test(anon.reason),
      JSON.stringify(anon));
    const owner = ephemeralGate(true, OWNER);
    check("gate: owner + ephemeral is allowed", owner.ok && owner.ephemeral === true, JSON.stringify(owner));
    const notAsked = ephemeralGate(undefined, null);
    const ownerNotAsked = ephemeralGate(false, OWNER);
    check("gate: nobody who did not ask gets an ephemeral run",
      notAsked.ok && !notAsked.ephemeral && ownerNotAsked.ok && !ownerNotAsked.ephemeral);
  }

  // 2 — the TTL.
  {
    const cases: [unknown, number][] = [
      [undefined, EPHEMERAL_RUN_TTL_DAYS],
      ["", EPHEMERAL_RUN_TTL_DAYS],
      ["abc", EPHEMERAL_RUN_TTL_DAYS],
      ["0", EPHEMERAL_RUN_TTL_DAYS],
      ["-3", EPHEMERAL_RUN_TTL_DAYS],
      ["1.5", EPHEMERAL_RUN_TTL_DAYS],
      ["3", 3],
      [" 14 ", 14],
      [30, 30],
    ];
    check("ttl: default is 7 days", EPHEMERAL_RUN_TTL_DAYS === 7);
    check("ttl: only a positive integer in EPHEMERAL_RUN_TTL_DAYS counts",
      cases.every(([raw, want]) => ephemeralTtlDaysFromEnv({ EPHEMERAL_RUN_TTL_DAYS: raw }) === want),
      cases.map(([raw, want]) => `${JSON.stringify(raw)}→${ephemeralTtlDaysFromEnv({ EPHEMERAL_RUN_TTL_DAYS: raw })}(${want})`).join(" "));
    check("ttl: expiry is now + days", ephemeralExpiry(NOW, 7).toISOString() === "2026-09-14T12:00:00.000Z");
  }

  // 3 — startCheck for an owner: marked, dated, owned, and no App.
  {
    const w = world();
    const { db, log } = stubDb(w);
    const triggered: string[] = [];
    const expiresAt = ephemeralExpiry(NOW, 7);
    const run = await startCheck(
      db,
      {
        input: { url: "https://pr-123.preview.example.com/" },
        ownerId: OWNER.id,
        anonKeyHash: null,
        ephemeral: { expiresAt },
      },
      { trigger: async (id) => void triggered.push(id) },
    );
    const row = w.run[0];
    check("start: one run, handed to the agent", w.run.length === 1 && triggered[0] === run.id, `${w.run.length}/${triggered.join()}`);
    check("start: the run is ephemeral, dated, owned by the caller and has no app",
      row.ephemeral === true && (row.expiresAt as Date).getTime() === expiresAt.getTime() &&
        row.ownerId === OWNER.id && row.appId === undefined && row.anonKeyHash === null,
      JSON.stringify({ ephemeral: row.ephemeral, expiresAt: row.expiresAt, ownerId: row.ownerId, appId: row.appId }));
    check("start: the slug is the preview hostname", row.appSlug === "pr-123.preview.example.com", String(row.appSlug));
    check("start: no App table was touched", log.every((l) => !l.startsWith("app.")), log.join(", "));

    // And the same call without the flag is a plain run.
    await startCheck(db, { input: { url: "https://example.com/" }, ownerId: OWNER.id, anonKeyHash: null }, { trigger: async () => {} });
    const plain = w.run[1];
    check("start: without the flag a run is not ephemeral and has no expiry",
      plain.ephemeral === false && plain.expiresAt === null, JSON.stringify({ e: plain.ephemeral, x: plain.expiresAt }));
  }

  // 4 — Enable Daily Watch refuses before writing.
  {
    const w = world();
    w.run.push({ id: "run_e", publicId: "pub_e", ownerId: OWNER.id, appSlug: "pr-1.preview.test", targetUrl: "https://pr-1.preview.test/", ephemeral: true });
    const { db, log } = stubDb(w);
    const result = await enableWatchForRun(db, { id: OWNER.id, plan: "starter", clerkOrgId: null }, {
      runPublicId: "pub_e", frequency: "daily", notifyOnChangeOnly: true,
    });
    check("watch: an ephemeral run is refused with kind ephemeral", result.kind === "ephemeral", JSON.stringify(result));
    check("watch: nothing was written (no App upsert, no Watch, no run update)",
      log.length === 0 && w.watch.length === 0, log.join(", "));
  }

  // 5 — a re-check of an ephemeral run is ephemeral, freshly dated.
  {
    const w = world();
    w.run.push({
      id: "run_e", publicId: "pub_e", ownerId: OWNER.id, appSlug: "pr-1.preview.test", targetUrl: "https://pr-1.preview.test/",
      testEmail: null, testPasswordEnc: null, scopeHints: null, userNotes: null, focusAreas: null, notifyEmail: null,
      watchId: null, appId: null, ephemeral: true, expiresAt: new Date("2026-09-10T00:00:00.000Z"),
      owner: { plan: "starter" },
    });
    const { db } = stubDb(w);
    const triggered: string[] = [];
    const later = new Date("2026-09-09T12:00:00.000Z");
    const r = await createRecheckRun(db, "pub_e", { full: false }, {
      canMutate: async () => true,
      trigger: async (id) => void triggered.push(id),
      siteCap: () => 20,
      now: () => later,
      ephemeralTtlDays: () => 3,
    });
    const created = w.run[1];
    check("recheck: ok, one new run triggered", r.kind === "ok" && w.run.length === 2 && triggered.length === 1, JSON.stringify(r));
    check("recheck: the new run is ephemeral with a fresh expiry from now + TTL, still app-less",
      created.ephemeral === true && (created.expiresAt as Date).toISOString() === "2026-09-12T12:00:00.000Z" &&
        created.appId === null && created.watchId === null && created.baselineRunId === "run_e",
      JSON.stringify({ e: created.ephemeral, x: created.expiresAt, app: created.appId }));
  }

  // 6 — the sweep.
  {
    const w = world();
    const shared = evidenceUrl("screenshots/aaaa.png"); // seen by the expired run AND a live one
    const own = evidenceUrl("screenshots/bbbb.png"); // the expired run's alone
    const findingShot = evidenceUrl("screenshots/cccc.png");
    const transcript = evidenceUrl("transcripts/run_x.json");
    const video = evidenceUrl("videos/run_x_j1.webm");
    const live = evidenceUrl("live/run_x.png");
    const external = "https://elsewhere.example.com/not-ours.png";

    // Expired ephemeral run with a full tree.
    w.run.push({ id: "run_x", ephemeral: true, expiresAt: new Date("2026-09-07T11:59:59.000Z"), transcriptUrl: transcript, liveScreenshotUrl: live });
    w.journey.push({ id: "j1", runId: "run_x", videoUrl: video });
    w.step.push({ id: "s1", journeyId: "j1", screenshotUrl: shared }, { id: "s2", journeyId: "j1", screenshotUrl: own });
    w.finding.push({ id: "f1", runId: "run_x" });
    w.evidence.push(
      { id: "e1", stepId: "s1", findingId: null, storageUrl: shared },
      { id: "e2", stepId: "s2", findingId: null, storageUrl: own },
      { id: "e3", stepId: null, findingId: "f1", storageUrl: findingShot },
      { id: "e4", stepId: "s2", findingId: "f1", storageUrl: external },
    );
    w.llmUsage.push({ id: "u1", runId: "run_x" });
    w.createdResource.push({ id: "c1", runId: "run_x" });
    w.appSnapshot.push({ id: "snap_x", runId: "run_x", appId: null });

    // A second expired ephemeral run, no children — deleted too.
    w.run.push({ id: "run_y", ephemeral: true, expiresAt: new Date("2026-09-01T00:00:00.000Z"), transcriptUrl: null, liveScreenshotUrl: null });

    // A live ephemeral run — untouched, and it shares the screenshot.
    w.run.push({ id: "run_live", ephemeral: true, expiresAt: new Date("2026-09-08T00:00:00.000Z"), transcriptUrl: null, liveScreenshotUrl: null });
    w.journey.push({ id: "j_live", runId: "run_live", videoUrl: null });
    w.step.push({ id: "s_live", journeyId: "j_live", screenshotUrl: shared });
    w.evidence.push({ id: "e_live", stepId: "s_live", findingId: null, storageUrl: shared });

    // A plain owned run, older than everything, no expiry — never a candidate.
    w.run.push({ id: "run_plain", ephemeral: false, expiresAt: null, transcriptUrl: evidenceUrl("transcripts/plain.json"), liveScreenshotUrl: null });
    w.journey.push({ id: "j_plain", runId: "run_plain", videoUrl: null });
    w.step.push({ id: "s_plain", journeyId: "j_plain", screenshotUrl: evidenceUrl("screenshots/plain.png") });
    w.finding.push({ id: "f_plain", runId: "run_plain" });
    w.appSnapshot.push({ id: "snap_plain", runId: "run_plain", appId: null });

    const { db } = stubDb(w);
    const { bucket, deleted } = stubBucket();
    const result = await sweepExpiredEphemeralRuns(db, NOW, bucket);

    check("sweep: two runs deleted, five objects removed", result.runs === 2 && result.evidence === 5, JSON.stringify(result));
    check("sweep: the expired runs are gone, the live ephemeral and the plain run remain",
      w.run.map((r) => r.id).sort().join() === "run_live,run_plain", w.run.map((r) => r.id).join());
    check("sweep: the expired run's journeys, steps, findings, evidence, ledgers and snapshot are gone",
      !w.journey.some((j) => j.runId === "run_x") && !w.step.some((s) => s.journeyId === "j1") &&
        !w.finding.some((f) => f.runId === "run_x") && !w.evidence.some((e) => ["e1", "e2", "e3", "e4"].includes(e.id as string)) &&
        w.llmUsage.length === 0 && w.createdResource.length === 0 && !w.appSnapshot.some((s) => s.runId === "run_x"),
      JSON.stringify({ j: w.journey.length, s: w.step.length, f: w.finding.length, e: w.evidence.length, snap: w.appSnapshot.length }));
    check("sweep: the live ephemeral run's tree and the plain run's tree are intact",
      w.journey.length === 2 && w.step.length === 2 && w.finding.length === 1 && w.evidence.length === 1 && w.appSnapshot.length === 1);
    const gone = [...deleted].sort();
    check("sweep: R2 loses the expired run's own screenshot, the finding's, the transcript, the video and the live frame",
      gone.join() === ["live/run_x.png", "screenshots/bbbb.png", "screenshots/cccc.png", "transcripts/run_x.json", "videos/run_x_j1.webm"].sort().join(),
      gone.join());
    check("sweep: a screenshot the live run also references is NOT deleted", !deleted.includes("screenshots/aaaa.png"));
    check("sweep: an external URL is never handed to R2", !deleted.some((k) => k.includes("elsewhere")));
    check("sweep: the plain run's objects are untouched", !deleted.some((k) => k.includes("plain")));

    check("sweep: the count reported equals the keys deleted", result.evidence === deleted.length, `${result.evidence} vs ${deleted.length}`);

    // Idempotent: a second sweep finds nothing.
    const again = await sweepExpiredEphemeralRuns(db, NOW, bucket);
    check("sweep: a second pass deletes nothing", again.runs === 0 && again.evidence === 0 && deleted.length === gone.length, JSON.stringify(again));

    // Without a bucket the rows still go; objects are reported as 0.
    const w2 = world();
    w2.run.push({ id: "run_z", ephemeral: true, expiresAt: new Date("2026-09-01T00:00:00.000Z"), transcriptUrl: evidenceUrl("transcripts/z.json"), liveScreenshotUrl: null });
    const { db: db2 } = stubDb(w2);
    const noBucket = await sweepExpiredEphemeralRuns(db2, NOW);
    check("sweep: without a bucket the rows are deleted and evidence is reported as 0",
      noBucket.runs === 1 && noBucket.evidence === 0 && w2.run.length === 0, JSON.stringify(noBucket));
  }

  // 7 — the janitor's test-account sweeps skip an ephemeral run; the tick's
  // ephemeral sweep passes the bucket through.
  {
    const w = world();
    // The self-check account with a stale App (swept) and, separately, an
    // ordinary owner's live ephemeral run (no App, no snapshot) — old enough
    // that every grace period has passed.
    const old = new Date("2026-08-01T00:00:00.000Z");
    w.user.push({ id: "user_test", isTestAccount: true }, { id: OWNER.id, isTestAccount: false });
    const apps: Row[] = [{ id: "app_test", ownerId: "user_test", appSlug: "self.test", createdAt: old }];
    w.run.push(
      { id: "run_self", ownerId: "user_test", appId: "app_test", watchId: "w1", snapshotId: null, ephemeral: false, expiresAt: null, createdAt: old },
      { id: "run_eph", ownerId: OWNER.id, appId: null, watchId: null, snapshotId: "snap_eph", ephemeral: true, expiresAt: new Date("2026-12-01T00:00:00.000Z"), createdAt: old },
    );
    w.appSnapshot.push({ id: "snap_eph", runId: "run_eph", appId: null });
    const { db, log } = stubDb(w);
    // The janitor's queries reach through the owner relation and the App
    // table, which the sweep stub has no business with; here they exist.
    const users = w.user;
    const withOwner = (rows: Row[], where: Where) => {
      const { owner, ...rest } = where as Where & { owner?: { isTestAccount: boolean } };
      return rows.filter((r) => matches(r, rest) && (!owner || users.find((u) => u.id === r.ownerId)?.isTestAccount === owner.isTestAccount));
    };
    // Picked table by table: spreading the stub would trip its App trap.
    const base = db as unknown as Record<string, unknown>;
    const runTable = base.run as Record<string, unknown>;
    const janitorDb = {
      journey: base.journey, step: base.step, finding: base.finding, evidence: base.evidence,
      llmUsage: base.llmUsage, createdResource: base.createdResource, appSnapshot: base.appSnapshot,
      watch: base.watch, user: base.user, counter: base.counter,
      app: {
        findMany: async ({ where }: { where: Where }) => withOwner(apps, where),
        deleteMany: async ({ where }: { where: Where }) => ({ count: apps.filter((a) => matches(a, where)).length }),
      },
      run: {
        ...runTable,
        findMany: async ({ where = {} }: { where?: Where }) => withOwner(w.run, where),
        updateMany: async ({ where, data }: { where: Where; data: Row }) => {
          const hit = w.run.filter((r) => matches(r, where));
          for (const r of hit) Object.assign(r, data);
          log.push(`run.updateMany ${hit.length}`);
          return { count: hit.length };
        },
      },
      issueLink: { deleteMany: async () => ({ count: 0 }) },
      ticketPolicy: { deleteMany: async () => ({ count: 0 }) },
      trackerIntegration: { deleteMany: async () => ({ count: 0 }) },
      repoIntegration: { deleteMany: async () => ({ count: 0 }) },
    };
    const { bucket, deleted } = stubBucket();
    const env = { db: janitorDb, bindings: { EVIDENCE: bucket } } as unknown as AgentEnv;

    const before = JSON.stringify(w.run.find((r) => r.id === "run_eph"));
    const swept = await sweepTestAccounts(env, NOW);
    const after = JSON.stringify(w.run.find((r) => r.id === "run_eph"));
    check("janitor: the test-account sweep removes the self-check app and detaches its run",
      swept.appsRemoved === 1 && w.run.find((r) => r.id === "run_self")?.appId === null, JSON.stringify(swept));
    check("janitor: an ordinary owner's ephemeral run is untouched by the test-account sweeps — no App to find, not theirs to detach",
      before === after && w.appSnapshot.some((s) => s.id === "snap_eph") && w.run.some((r) => r.id === "run_eph"),
      `${before} → ${after}`);

    // The tick's own ephemeral sweep: nothing expired yet, so nothing goes;
    // then the run expires and the bucket it was given receives the delete.
    const none = await sweepExpiredEphemeral(env, NOW);
    check("janitor: the ephemeral sweep leaves a live ephemeral run alone", none.runs === 0 && w.run.some((r) => r.id === "run_eph"));
    w.run.find((r) => r.id === "run_eph")!.transcriptUrl = evidenceUrl("transcripts/eph.json");
    const later = await sweepExpiredEphemeral(env, new Date("2026-12-02T00:00:00.000Z"));
    check("janitor: once expired, the run goes and the R2 binding the tick holds receives the delete",
      later.runs === 1 && later.evidence === 1 && deleted.join() === "transcripts/eph.json" && !w.run.some((r) => r.id === "run_eph"),
      JSON.stringify({ later, deleted }));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
