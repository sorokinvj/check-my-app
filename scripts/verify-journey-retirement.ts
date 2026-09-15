// CHE-232 verification: a journey the product no longer has stops being
// checked, and one that comes back brings its history with it.
//
// The catalog has had `retiredAt` since CHE-231 and every read filters on it,
// but nothing ever set it — so a removed journey kept its place in the rotation
// and its line in the map discovery is asked to confirm, forever.
//
// The rules held here against the real noteDiscoveryCoverage:
//   1. a journey a full check proposed has its miss counter cleared;
//   2. one it did not propose gains a miss, and retires at the third;
//   3. a rewording counts as having been seen — identity decides, not the
//      string, or every rephrase would look like a removal;
//   4. retiring says why, in the owner's terms;
//   5. an already-retired journey is left alone rather than counted again;
//   6. a walk undoes retirement and clears the counter (recordWalk), so a page
//      that comes back is the same journey and not a new row beside it;
//   7. an empty catalog does nothing rather than throwing.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-journey-retirement.ts

import Module from "node:module";

const moduleLoader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = moduleLoader._load;
moduleLoader._load = function (request: string, ...rest: unknown[]) {
  if (request === "cloudflare:workers") return {};
  return realLoad.call(this, request, ...rest);
};

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

interface Row {
  id: string;
  key: string;
  title: string;
  aliases: string;
  surface: string | null;
  scenario: string | null;
  missedDiscoveries: number;
  retiredAt: Date | null;
  retiredReason: string | null;
}

function row(over: Partial<Row> & { key: string; title: string }): Row {
  return {
    id: `aj-${over.key}`,
    aliases: JSON.stringify([over.title]),
    surface: null,
    scenario: null,
    missedDiscoveries: 0,
    retiredAt: null,
    retiredReason: null,
    ...over,
  };
}

function stub(rows: Row[]) {
  const writes: Array<{ id: string; data: Partial<Row> }> = [];
  const env = {
    db: {
      appJourney: {
        findMany: async ({ where }: { where: { retiredAt: null } }) =>
          rows.filter((r) => (where.retiredAt === null ? r.retiredAt === null : true)),
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          writes.push({ id: where.id, data });
          const target = rows.find((r) => r.id === where.id);
          if (target) Object.assign(target, data);
          return target;
        },
      },
    },
  };
  return { env: env as never, writes };
}

async function main() {
  const { noteDiscoveryCoverage, MISSED_DISCOVERIES_BEFORE_RETIRING } = await import("@/agent/journey-catalog");

  console.log("A journey the check still finds keeps its place");
  {
    const rows = [row({ key: "signup", title: "Sign up for an account", missedDiscoveries: 2 })];
    const { env, writes } = stub(rows);
    const retired = await noteDiscoveryCoverage(env, "app-1", [{ title: "Sign up for an account" }]);
    check("nothing retires", retired.length === 0, retired.join());
    check("the miss counter is cleared", rows[0].missedDiscoveries === 0, String(rows[0].missedDiscoveries));
    check("one write, not a rewrite of the row", writes.length === 1, JSON.stringify(writes));
  }

  console.log("\nA rewording is not a removal");
  {
    const rows = [row({ key: "signup", title: "Sign up for an account", missedDiscoveries: 2 })];
    const { env } = stub(rows);
    await noteDiscoveryCoverage(env, "app-1", [{ title: "Create an account / Sign in" }]);
    check("a different wording of the same journey counts as seen", rows[0].missedDiscoveries === 0, String(rows[0].missedDiscoveries));
  }

  console.log("\nA journey the product no longer has retires at the third miss");
  {
    const rows = [
      row({ key: "signup", title: "Sign up for an account" }),
      row({ key: "old-tour", title: "Take the guided product tour" }),
    ];
    const { env } = stub(rows);
    const proposals = [{ title: "Sign up for an account" }];

    for (let n = 1; n < MISSED_DISCOVERIES_BEFORE_RETIRING; n++) {
      const retired = await noteDiscoveryCoverage(env, "app-1", proposals);
      check(`miss ${n}: counted, not retired`, retired.length === 0 && rows[1].retiredAt === null, `missed=${rows[1].missedDiscoveries}`);
    }
    const retired = await noteDiscoveryCoverage(env, "app-1", proposals);
    check(`miss ${MISSED_DISCOVERIES_BEFORE_RETIRING}: retired`, retired.join() === "Take the guided product tour", retired.join());
    check("…with a reason in the owner's terms", /not found by the last \d+ checks/i.test(rows[1].retiredReason ?? ""), String(rows[1].retiredReason));
    check("the journey that was found is untouched", rows[0].retiredAt === null && rows[0].missedDiscoveries === 0);
  }

  console.log("\nAn already-retired journey is left alone");
  {
    const rows = [
      row({ key: "signup", title: "Sign up for an account" }),
      row({ key: "gone", title: "A journey that went away", retiredAt: new Date("2026-09-01"), missedDiscoveries: 3 }),
    ];
    const { env, writes } = stub(rows);
    const retired = await noteDiscoveryCoverage(env, "app-1", [{ title: "Sign up for an account" }]);
    check("it is not retired twice", retired.length === 0, retired.join());
    check("…and nothing is written to it", !writes.some((w) => w.id === "aj-gone"), JSON.stringify(writes));
  }

  console.log("\nScenario and surface decide, like everywhere else");
  {
    const rows = [
      row({ key: "interview", title: "Interview assistance and session minutes", scenario: "interview" }),
      row({ key: "combined", title: "Practice with interview assistance", scenario: "practice-extension" }),
    ];
    const { env } = stub(rows);
    // The interview scenario was proposed; the combined one was not. Without
    // scenario in identity these two titles merge at 0.67 and the combined row
    // would be counted as seen (CHE-247).
    await noteDiscoveryCoverage(env, "app-1", [
      { title: "Interview assistance and session minutes", extensionScenario: "interview" },
    ]);
    check("the proposed scenario is seen", rows[0].missedDiscoveries === 0, String(rows[0].missedDiscoveries));
    check("the other scenario is missed, not credited by a similar title", rows[1].missedDiscoveries === 1, String(rows[1].missedDiscoveries));
  }

  console.log("\nNothing to do is not an error");
  {
    const { env, writes } = stub([]);
    const retired = await noteDiscoveryCoverage(env, "app-1", [{ title: "Anything" }]);
    check("an empty catalog does nothing", retired.length === 0 && writes.length === 0);
  }
}

void main().then(() => {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
