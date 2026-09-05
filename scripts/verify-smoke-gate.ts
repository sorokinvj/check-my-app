// CHE-179 verification: the smoke pass treats a page that does not answer as
// unreached, not as trouble.
//
// 2026-09-04, the first day the survey (CHE-132) handed the smoke pass every
// page it had seen: all three watched apps went full instead of smoke —
// checkmyapp.dev because /sign-in did not answer within 20 s, joblander.app
// and meetbashar.com because one deep content page each did not. $0.61–0.75
// per app instead of $0.01, for a silence. CLAUDE.md rule 3: silence is not
// evidence. The rule now (src/agent/smoke.ts), exercised here against a stub
// page that can time out per URL, with no browser and no product:
//   a. a timeout on an `extra` page (one the survey saw) → the pass is ok,
//      the page is in `unreached`, "N pages healthy" does not count it, and
//      the same page answering on the retry is healthy;
//   b. a timeout on the homepage or a `core` page (spec/anatomy) → trouble;
//   c. HTTP 500 on any page → trouble, as before;
//   d. the retry is one, with the longer timeout; an uncaught error and a
//      console burst are still trouble; core is probed before extra; the
//      budget still leaves pages `skipped`, never healthy;
//   e. the feed line the owner reads says what answered and what did not,
//      about their pages only.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-smoke-gate.ts

import {
  CORE_SMOKE_PAGES,
  MAX_SMOKE_PAGES,
  PAGE_TIMEOUT_MS,
  RETRY_TIMEOUT_MS,
  probeTargets,
  smokeOutcomeLine,
  splitSmokeTargets,
  type ProbePage,
} from "@/agent/smoke";
import { hasEnvironmentLeak } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://target.test";
const u = (path: string) => `${ORIGIN}${path}`;

// Per-URL behaviour: a status to answer with, "timeout" to never answer, or
// "slow" to time out on the first attempt and answer 200 on the next.
type Behaviour = number | "timeout" | "slow";

interface Stub {
  page: ProbePage;
  /** Every navigation as "<path> @<timeout>" in order. */
  calls: string[];
  fire: (event: "console" | "pageerror", payload: unknown) => void;
}

function stubPage(behaviour: Record<string, Behaviour>): Stub {
  const calls: string[] = [];
  const attempts = new Map<string, number>();
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const page = {
    goto: async (url: string, opts?: { timeout?: number }) => {
      const path = new URL(url).pathname;
      calls.push(`${path} @${opts?.timeout ?? 0}`);
      const n = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, n);
      const b = behaviour[path] ?? 200;
      if (b === "timeout" || (b === "slow" && n === 1)) {
        throw new Error(`page.goto: Timeout ${opts?.timeout ?? 0}ms exceeded.`);
      }
      const status = b === "slow" ? 200 : b;
      return { status: () => status };
    },
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.from(""),
  } as unknown as ProbePage;
  return {
    page,
    calls,
    fire: (event, payload) => {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
  };
}

async function main() {
  const core = [u("/sign-in"), u("/pricing")];
  const extra = [u("/tutorials/103-safe-practice-mock-interviews"), u("/learn/does-bashar-contradict-himself"), u("/docs")];

  // a — a silence on an extra page: unreached, not trouble, not healthy.
  {
    const stub = stubPage({ "/tutorials/103-safe-practice-mock-interviews": "timeout" });
    const out = await probeTargets(stub.page, u("/"), { core, extra });
    check("a: extra page timing out twice → smoke ok", out.failures.length === 0, out.failures.join("; "));
    check("a: the page is listed as unreached", JSON.stringify(out.unreached) === JSON.stringify([u("/tutorials/103-safe-practice-mock-interviews")]), JSON.stringify(out.unreached));
    check("a: healthy counts the pages that answered only (home + 4)", out.healthy === 5 && out.probes.length === 6, `healthy=${out.healthy} probes=${out.probes.length}`);
    check("a: nothing skipped", out.skipped === 0, String(out.skipped));
    const retries = stub.calls.filter((c) => c.startsWith("/tutorials/"));
    check("a: exactly one retry, at the longer timeout", JSON.stringify(retries) === JSON.stringify([`/tutorials/103-safe-practice-mock-interviews @${PAGE_TIMEOUT_MS}`, `/tutorials/103-safe-practice-mock-interviews @${RETRY_TIMEOUT_MS}`]), retries.join(" | "));
    const probe = out.probes.find((p) => p.url.includes("/tutorials/"));
    check("a: the probe records two attempts and no status", probe?.attempts === 2 && probe.status === null, JSON.stringify(probe));
  }
  // a' — the same page answering on the retry is healthy.
  {
    const stub = stubPage({ "/learn/does-bashar-contradict-himself": "slow" });
    const out = await probeTargets(stub.page, u("/"), { core, extra });
    check("a': extra page answering on the retry → ok, nothing unreached, all healthy", out.failures.length === 0 && out.unreached.length === 0 && out.healthy === 6, `healthy=${out.healthy} unreached=${out.unreached.length}`);
    const probe = out.probes.find((p) => p.url.includes("/learn/"));
    check("a': the probe records two attempts and the status", probe?.attempts === 2 && probe.status === 200, JSON.stringify(probe));
  }

  // b — a silence on the homepage or a core page is trouble.
  {
    const stub = stubPage({ "/sign-in": "timeout" });
    const out = await probeTargets(stub.page, u("/"), { core, extra });
    check("b: core page timing out twice → trouble", out.failures.length === 1 && out.failures[0] === "/sign-in did not answer in time", out.failures.join("; "));
    check("b: … and it is also listed as unreached, not counted healthy", out.unreached.length === 1 && out.healthy === 5, `unreached=${out.unreached.length} healthy=${out.healthy}`);
    const stubHome = stubPage({ "/": "timeout" });
    const home = await probeTargets(stubHome.page, u("/"), { core, extra });
    check("b: homepage timing out twice → trouble", home.failures.some((f) => f === "/ did not answer in time"), home.failures.join("; "));
    check("b: the homepage got its retry too", stubHome.calls.filter((c) => c.startsWith("/ @")).length === 2, stubHome.calls.slice(0, 2).join(" | "));
    const stubSlowCore = stubPage({ "/sign-in": "slow" });
    const slow = await probeTargets(stubSlowCore.page, u("/"), { core, extra });
    check("b: core page answering on the retry → ok", slow.failures.length === 0 && slow.unreached.length === 0);
    const stubDns = stubPage({});
    (stubDns.page as unknown as { goto: (url: string) => Promise<never> }).goto = async (url: string) => {
      stubDns.calls.push(new URL(url).pathname);
      if (new URL(url).pathname === "/pricing") throw new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://target.test/pricing");
      return { status: () => 200 } as never;
    };
    const dns = await probeTargets(stubDns.page, u("/"), { core, extra });
    check("b: a core page that fails for another reason names it without the driver prefix", dns.failures[0] === "/pricing did not answer (net::ERR_NAME_NOT_RESOLVED at https://target.test/pricing)", dns.failures.join("; "));
  }

  // c — a 5xx anywhere is trouble; a 4xx is an answer.
  {
    const stub = stubPage({ "/docs": 500 });
    const out = await probeTargets(stub.page, u("/"), { core, extra });
    check("c: HTTP 500 on an extra page → trouble", out.failures.length === 1 && out.failures[0] === "/docs returned HTTP 500", out.failures.join("; "));
    check("c: a 500 is an answer — not retried, not unreached", stub.calls.filter((c) => c.startsWith("/docs")).length === 1 && out.unreached.length === 0);
    const stub404 = stubPage({ "/docs": 404 });
    const nf = await probeTargets(stub404.page, u("/"), { core, extra });
    check("c: HTTP 404 is an answer, not trouble (as before)", nf.failures.length === 0 && nf.healthy === 6);
  }

  // d — the other rules still hold.
  {
    const stub = stubPage({});
    const pending = probeTargets(stub.page, u("/"), { core, extra });
    stub.fire("pageerror", new Error("TypeError: x is undefined"));
    const out = await pending;
    check("d: an uncaught JS error is trouble", out.failures.some((f) => f.startsWith("uncaught JS error on load")), out.failures.join("; "));
    const stubBurst = stubPage({});
    const pendingBurst = probeTargets(stubBurst.page, u("/"), { core, extra });
    for (let i = 0; i < 5; i++) stubBurst.fire("console", { type: () => "error" });
    const burst = await pendingBurst;
    check("d: five console errors are trouble", burst.failures.some((f) => f === "5 console errors while loading the pages"), burst.failures.join("; "));
    const order = stubPage({});
    await probeTargets(order.page, u("/"), { core, extra });
    check("d: homepage, then core, then extra", JSON.stringify(order.calls.map((c) => c.split(" @")[0])) === JSON.stringify(["/", "/sign-in", "/pricing", "/tutorials/103-safe-practice-mock-interviews", "/learn/does-bashar-contradict-himself", "/docs"]), order.calls.join(" | "));
    // Budget: a clock that jumps past the budget after the second page.
    let tick = 0;
    const budget = stubPage({});
    const capped = await probeTargets(budget.page, u("/"), { core, extra }, { now: () => (tick++ < 3 ? 0 : 1_000_000) });
    check("d: the budget leaves pages skipped, never healthy", capped.skipped === 3 && capped.healthy === 3 && capped.failures.length === 0, `skipped=${capped.skipped} healthy=${capped.healthy}`);
  }

  // d' — the split: the first CORE_SMOKE_PAGES known pages are core, the rest
  // and the survey's pages are extra, deduped, under the cap.
  {
    const known = Array.from({ length: 8 }, (_, i) => u(`/k${i}`));
    const surveyed = [u("/k1"), u("/k7"), ...Array.from({ length: 40 }, (_, i) => u(`/s${i}`))];
    const sets = splitSmokeTargets(known, surveyed);
    check("d': core = the first six known pages", JSON.stringify(sets.core) === JSON.stringify(known.slice(0, CORE_SMOKE_PAGES)), sets.core.join(" "));
    check("d': extra starts with the known pages past six, then the survey's, deduped", sets.extra[0] === u("/k6") && sets.extra[1] === u("/k7") && sets.extra[2] === u("/s0") && !sets.extra.includes(u("/k1")), sets.extra.slice(0, 4).join(" "));
    check("d': core + extra stay under the cap", sets.core.length + sets.extra.length === MAX_SMOKE_PAGES, String(sets.core.length + sets.extra.length));
    const none = splitSmokeTargets([], []);
    check("d': nothing known, nothing surveyed → empty sets", none.core.length === 0 && none.extra.length === 0);
  }

  // e — the feed line the owner reads (2026-09-04's three apps, as they should have read).
  {
    const stub = stubPage({ "/tutorials/103-safe-practice-mock-interviews": "timeout" });
    const out = await probeTargets(stub.page, u("/"), { core, extra });
    const line = smokeOutcomeLine({ ok: out.failures.length === 0, ...out, baselineRunNumber: 134 }, u("/"));
    check("e: ok with one silent page", line === "All 5 pages healthy, 1 did not answer in time (/tutorials/103-safe-practice-mock-interviews) — carrying Run #134's verdict forward and skipping the full agent check", line);
    const clean = smokeOutcomeLine({ ok: true, healthy: 12, unreached: [], failures: [], baselineRunNumber: 134 }, u("/"));
    check("e: ok with every page answering reads as before", clean === "All 12 pages healthy, no uncaught errors — carrying Run #134's verdict forward and skipping the full agent check", clean);
    const trouble = smokeOutcomeLine({ ok: false, healthy: 4, unreached: [u("/sign-in")], failures: ["/sign-in did not answer in time"], baselineRunNumber: 134 }, u("/"));
    check("e: trouble names the page and the fact", trouble === "Smoke found trouble: /sign-in did not answer in time — running the full check", trouble);
    check("e: no machinery leaks into either line", !hasEnvironmentLeak(line) && !hasEnvironmentLeak(trouble) && !/page\.goto|playwright|headless|browser/i.test(line + trouble));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
