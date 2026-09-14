// CHE-234 verification: a check an owner starts by hand against an app they
// own is a check OF THAT APP.
//
// Until this, only the scheduler set `Run.appId`. So the dashboard's "check
// now", the API and the app-review skill produced runs that walked the app's
// journeys and updated none of their history — 30 such runs in production by
// the time it was noticed (run #181 among them). The catalog hangs off App, so
// an app-less run leaves the journey's price, status and walk count exactly as
// the last watch tick left them.
//
// Exercised against a stub Prisma — no database, no network — through the real
// startCheck:
//   1. an owner's run of their own app carries that App's id;
//   2. an ephemeral run of the same owner and the same slug does not (CHE-202:
//      a PR preview is not the app), and never reads the App table;
//   3. an anonymous run carries none and never reads the App table;
//   4. one owner's App is never attached to another owner's run, and a slug
//      that belongs to no App leaves the run app-less — identity is the
//      (ownerId, appSlug) pair the schema makes unique, not the host alone;
//   5. an extension target attaches by its own slug ("extension:<id>"), the
//      form appSlugFromUrl gives a Chrome Web Store link;
//   6. the lookup is one query, and the run is created with the id in it —
//      not created app-less and updated afterwards, which would leave a window
//      where the agent reads a run whose app is not yet set.
//
// What this cannot show, being stub-bound: that the attached run's cost then
// counts inside the app's daily agent budget (src/agent/scheduler.ts reads
// `Run WHERE appId = …` for the day). That is the deliberate side effect of
// attaching — the same app's spend, whoever pressed the button — and it is
// visible in production as a watch tick that goes smoke-only the day after a
// hand-started check.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-owner-app-attach.ts

process.env.CREDENTIALS_SECRET ??= "verify-owner-app-attach-secret";

import type { PrismaClient } from "@/generated/prisma/client";
import { startCheck } from "@/lib/start-check";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

type Row = Record<string, unknown>;

const OWNER = "user_owner";
const OTHER = "user_other";

// The Apps production has, in the two shapes that matter: a website and a
// Chrome extension, plus one that belongs to somebody else.
const APPS: Row[] = [
  { id: "app_own", ownerId: OWNER, appSlug: "checkmyapp.dev" },
  { id: "app_ext", ownerId: OWNER, appSlug: "extension:hafhjepjihcimcljkdphpinannbdmnhf" },
  { id: "app_other", ownerId: OTHER, appSlug: "someone-else.app" },
];

function stubDb() {
  const runs: Row[] = [];
  const log: string[] = [];
  const db = {
    run: {
      // nextRunNumber (src/lib/db.ts) checks the counter's candidate against
      // the table; nothing here has a run number yet, so it is always free.
      findUnique: async () => null,
      create: async ({ data }: { data: Row }) => {
        log.push("run.create");
        const row = { id: `run_${runs.length + 1}`, publicId: `pub_${runs.length + 1}`, ...data };
        runs.push(row);
        return row;
      },
      update: async () => {
        log.push("run.update");
        throw new Error("a run must be created with its appId, not updated into one");
      },
    },
    app: {
      findUnique: async ({ where }: { where: Row }) => {
        log.push("app.findUnique");
        const key = where.ownerId_appSlug as { ownerId: string; appSlug: string } | undefined;
        if (!key) throw new Error(`App lookup must use the (ownerId, appSlug) unique key, got ${JSON.stringify(where)}`);
        return APPS.find((a) => a.ownerId === key.ownerId && a.appSlug === key.appSlug) ?? null;
      },
    },
    counter: { upsert: async () => ({ name: "runNumber", value: runs.length + 1 }) },
  };
  return { db: db as unknown as PrismaClient, runs, log };
}

async function start(opts: {
  url: string;
  ownerId: string | null;
  ephemeral?: boolean;
}): Promise<{ row: Row; log: string[] }> {
  const { db, runs, log } = stubDb();
  await startCheck(
    db,
    {
      input: { url: opts.url },
      ownerId: opts.ownerId,
      anonKeyHash: opts.ownerId ? null : "anon_hash",
      ...(opts.ephemeral ? { ephemeral: { expiresAt: new Date("2026-12-01T00:00:00.000Z") } } : {}),
    },
    { trigger: async () => {} },
  );
  return { row: runs[0], log };
}

async function main() {
  // 1 — the owner's own app.
  {
    const { row, log } = await start({ url: "https://checkmyapp.dev/pricing", ownerId: OWNER });
    check("owner: a hand-started check of their own app carries the App id",
      row.appId === "app_own", JSON.stringify({ appSlug: row.appSlug, appId: row.appId }));
    check("owner: the app was looked up once", log.filter((l) => l === "app.findUnique").length === 1, log.join(", "));
  }

  // 2 — the same owner, the same slug, ephemeral.
  {
    const { row, log } = await start({ url: "https://checkmyapp.dev/pricing", ownerId: OWNER, ephemeral: true });
    check("ephemeral: a preview run of the same app stays app-less",
      row.appId === null && row.ephemeral === true, JSON.stringify({ appId: row.appId, ephemeral: row.ephemeral }));
    check("ephemeral: the App table is never read", !log.some((l) => l.startsWith("app.")), log.join(", "));
  }

  // 3 — an anonymous visitor.
  {
    const { row, log } = await start({ url: "https://checkmyapp.dev/", ownerId: null });
    check("anonymous: a public check carries no app", row.appId === null, JSON.stringify({ appId: row.appId }));
    check("anonymous: the App table is never read", !log.some((l) => l.startsWith("app.")), log.join(", "));
  }

  // 4 — identity is the pair, not the host.
  {
    const mine = await start({ url: "https://someone-else.app/", ownerId: OWNER });
    check("identity: another owner's App is not attached to this owner's run",
      mine.row.appId === null, JSON.stringify({ appSlug: mine.row.appSlug, appId: mine.row.appId }));
    const theirs = await start({ url: "https://someone-else.app/", ownerId: OTHER });
    check("identity: its own owner's run does attach", theirs.row.appId === "app_other", String(theirs.row.appId));
    const unknown = await start({ url: "https://nobody-registered-this.example/", ownerId: OWNER });
    check("identity: a slug that belongs to no App leaves the run app-less",
      unknown.row.appId === null, JSON.stringify({ appSlug: unknown.row.appSlug, appId: unknown.row.appId }));
  }

  // 5 — an extension target.
  {
    const { row } = await start({
      url: "https://chromewebstore.google.com/detail/hafhjepjihcimcljkdphpinannbdmnhf",
      ownerId: OWNER,
    });
    check("extension: a Store link attaches by its extension slug",
      row.appId === "app_ext" && row.appSlug === "extension:hafhjepjihcimcljkdphpinannbdmnhf",
      JSON.stringify({ appSlug: row.appSlug, appId: row.appId }));
  }

  // 6 — one write, with the id already in it. (stubDb throws on run.update;
  // reaching here at all means no second write happened.)
  {
    const { log } = await start({ url: "https://checkmyapp.dev/", ownerId: OWNER });
    check("write: the run is created with its app, never updated into one",
      log.filter((l) => l.startsWith("run.")).join() === "run.create", log.join(", "));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
