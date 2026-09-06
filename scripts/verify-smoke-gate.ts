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
// CHE-187, 2026-09-06 — the console class of the same regression. Run #153
// on joblander.app went full on "75 console errors while loading the pages":
// a limit of five, written for a six-page pass (CHE-51), applied as a total
// across the thirty pages CHE-132 now hands over. The rule now:
//   f. thirty-one pages at three errors each → ok, the total recorded and
//      not trouble; one page at six → trouble naming that page; the counter
//      resets between pages (four on one page, four on the next → ok);
//   g. errors our own environment causes (a blocked tracker, an aborted
//      request, a third party's 4xx, a report-only CSP violation) are recorded
//      on the probe and never counted — six of them → ok; the same 4xx on
//      the product's own origin still counts; an uncaught exception is still
//      trouble on its own;
//   h. the trouble line names the page and its count; the ok line has no
//      console sentence at all.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-smoke-gate.ts

import {
  CONSOLE_ERROR_LIMIT,
  CORE_SMOKE_PAGES,
  IGNORED_CONSOLE_ERRORS,
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

/** A console error the stub page logs while a navigation is in flight. */
interface ConsoleError {
  text: string;
  /** The resource the message is about, as Playwright's msg.location().url. */
  url?: string;
}

/** What a Playwright ConsoleMessage looks like to the listener in smoke.ts. */
function consoleError(text: string, url = ""): unknown {
  return { type: () => "error", text: () => text, location: () => ({ url, lineNumber: 0, columnNumber: 0 }) };
}

interface Stub {
  page: ProbePage;
  /** Every navigation as "<path> @<timeout>" in order. */
  calls: string[];
  fire: (event: "console" | "pageerror", payload: unknown) => void;
}

function stubPage(
  behaviour: Record<string, Behaviour>,
  /** Console errors each path logs during its navigation (CHE-187). */
  logs: (path: string) => ConsoleError[] = () => [],
): Stub {
  const calls: string[] = [];
  const attempts = new Map<string, number>();
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const fire = (event: string, payload: unknown) => {
    for (const h of handlers.get(event) ?? []) h(payload);
  };
  const page = {
    goto: async (url: string, opts?: { timeout?: number }) => {
      const path = new URL(url).pathname;
      calls.push(`${path} @${opts?.timeout ?? 0}`);
      const n = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, n);
      for (const e of logs(path)) fire("console", consoleError(e.text, e.url));
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
  return { page, calls, fire };
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
    for (let i = 0; i < 5; i++) stubBurst.fire("console", consoleError(`TypeError: cannot read properties of undefined (${i})`, u("/app.js")));
    const burst = await pendingBurst;
    check("d: five console errors on one page are trouble, naming the page", burst.failures.some((f) => f === "/ logged 5 console errors"), burst.failures.join("; "));
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

  // f — the console limit is per page (CHE-187). Run #153's shape: thirty-one
  // pages, a few errors on each, none of them a burst.
  {
    const known = Array.from({ length: CORE_SMOKE_PAGES }, (_, i) => u(`/k${i}`));
    const surveyed = Array.from({ length: MAX_SMOKE_PAGES }, (_, i) => u(`/s${i}`));
    const sets = splitSmokeTargets(known, surveyed);
    const chatty = (path: string) => [
      { text: "Failed to load resource: the server responded with a status of 404 ()", url: u(`${path}/hero.webp`) },
      { text: "Uncaught (in promise) TypeError: Cannot read properties of null", url: u("/app.js") },
      { text: "Warning: a widget failed to hydrate", url: u("/app.js") },
    ];
    const stub = stubPage({}, chatty);
    const out = await probeTargets(stub.page, u("/"), sets);
    check("f: 31 pages × 3 errors → smoke ok", out.failures.length === 0 && out.probes.length === 31, `failures=${out.failures.join("; ")} probes=${out.probes.length}`);
    check("f: … the total is recorded as a fact (93), not a rule", out.consoleErrors === 93, String(out.consoleErrors));
    check("f: … and each probe carries its own count", out.probes.every((p) => p.consoleErrors === 3 && p.ignoredConsoleErrors === 0), JSON.stringify(out.probes.slice(0, 2)));
    check("f: … with the first counted message kept for diagnosis", out.probes[0].consoleSample === chatty("/")[0].text, out.probes[0].consoleSample);
    const one = stubPage({}, (path) => (path === "/s3" ? Array.from({ length: 6 }, (_, i) => ({ text: `ReferenceError: x${i} is not defined`, url: u("/app.js") })) : []));
    const burst = await probeTargets(one.page, u("/"), sets);
    check("f: one page with 6 → trouble naming that page", JSON.stringify(burst.failures) === JSON.stringify(["/s3 logged 6 console errors"]), burst.failures.join("; "));
    check("f: … the burst page's probe says 6; the total says 6", burst.probes.find((p) => p.url === u("/s3"))?.consoleErrors === 6 && burst.consoleErrors === 6, String(burst.consoleErrors));
    const four = (path: string) => (path === "/sign-in" || path === "/pricing" ? Array.from({ length: 4 }, (_, i) => ({ text: `TypeError: t${i}`, url: u("/app.js") })) : []);
    const split = stubPage({}, four);
    const reset = await probeTargets(split.page, u("/"), { core, extra });
    check("f: the counter resets between pages (4 on A, 4 on B → ok, total 8)", reset.failures.length === 0 && reset.consoleErrors === 8, `failures=${reset.failures.join("; ")} total=${reset.consoleErrors}`);
    check("f: the limit that decides is the exported one", CONSOLE_ERROR_LIMIT === 5, String(CONSOLE_ERROR_LIMIT));
    // The homepage's errors arrive after domcontentloaded, during the settle;
    // they belong to the homepage, not to the first core page.
    const late = stubPage({});
    (late.page as unknown as { waitForTimeout: () => Promise<void> }).waitForTimeout = async () => {
      for (let i = 0; i < 5; i++) late.fire("console", consoleError(`TypeError: late ${i}`, u("/app.js")));
    };
    const settled = await probeTargets(late.page, u("/"), { core, extra });
    check("f: errors logged while the homepage settles count for the homepage", JSON.stringify(settled.failures) === JSON.stringify(["/ logged 5 console errors"]) && settled.probes[0].consoleErrors === 5 && settled.probes[1].consoleErrors === 0, settled.failures.join("; "));
  }

  // g — noise our own environment causes is recorded, never counted.
  {
    const blocked = stubPage({}, (path) => (path === "/pricing" ? Array.from({ length: 6 }, () => ({ text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT", url: "https://www.googletagmanager.com/gtm.js" })) : []));
    const out = await probeTargets(blocked.page, u("/"), { core, extra });
    check("g: 6 errors that are all ERR_BLOCKED_BY_CLIENT → ok", out.failures.length === 0 && out.consoleErrors === 0, `failures=${out.failures.join("; ")} total=${out.consoleErrors}`);
    check("g: … recorded on the probe for diagnosis", out.probes.find((p) => p.url === u("/pricing"))?.ignoredConsoleErrors === 6, JSON.stringify(out.probes.find((p) => p.url === u("/pricing"))));
    const noise: ConsoleError[] = [
      { text: "Failed to load resource: net::ERR_ABORTED 200", url: u("/api/session") },
      { text: "Failed to load resource: the server responded with a status of 404 ()", url: u("/favicon.ico") },
      { text: "Failed to load resource: the server responded with a status of 403 ()", url: "https://www.google-analytics.com/collect" },
      { text: "Failed to load resource: net::ERR_CONNECTION_REFUSED", url: "https://o123.ingest.us.sentry.io/api/1/envelope/" },
      { text: "POST https://api.segment.io/v1/t 400", url: "https://cdn.segment.com/analytics.js" },
      { text: "Failed to load resource: the server responded with a status of 401 ()", url: "https://api-iam.intercom.io/messenger/web/ping" },
      { text: "[Report Only] Refused to load the script 'https://cdn.example.com/x.js' because it violates the following Content Security Policy directive", url: u("/") },
      { text: "Failed to load resource: the server responded with a status of 403 ()", url: "https://fonts.example-cdn.com/inter.woff2" },
      { text: "Failed to load resource: the server responded with a status of 429 ()", url: "https://connect.facebook.net/en_US/fbevents.js" },
    ];
    const all = stubPage({}, (path) => (path === "/docs" ? noise : []));
    const ignored = await probeTargets(all.page, u("/"), { core, extra });
    const docs = ignored.probes.find((p) => p.url === u("/docs"));
    check("g: every listed kind of noise is ignored", ignored.failures.length === 0 && docs?.consoleErrors === 0 && docs.ignoredConsoleErrors === noise.length, JSON.stringify(docs));
    check("g: every rule carries its why", IGNORED_CONSOLE_ERRORS.every((r) => r.why.length > 0), String(IGNORED_CONSOLE_ERRORS.length));
    const own = stubPage({}, (path) => (path === "/docs" ? Array.from({ length: 5 }, (_, i) => ({ text: "Failed to load resource: the server responded with a status of 404 ()", url: u(`/assets/${i}.js`) })) : []));
    const missing = await probeTargets(own.page, u("/"), { core, extra });
    check("g: the same 4xx on the product's own origin counts (5 missing assets → trouble)", JSON.stringify(missing.failures) === JSON.stringify(["/docs logged 5 console errors"]), missing.failures.join("; "));
    const fb = stubPage({}, (path) => (path === "/docs" ? Array.from({ length: 5 }, () => ({ text: "Facebook login failed: invalid app id", url: u("/app.js") })) : []));
    const product = await probeTargets(fb.page, u("/"), { core, extra });
    check("g: a product's own message that names a tracker still counts", product.failures.length === 1, product.failures.join("; "));
    const stub = stubPage({}, (path) => (path === "/pricing" ? [{ text: "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT", url: "https://www.googletagmanager.com/gtm.js" }] : []));
    const pending = probeTargets(stub.page, u("/"), { core, extra });
    stub.fire("pageerror", new Error("TypeError: x is undefined"));
    const uncaught = await pending;
    check("g: an uncaught exception is still trouble on its own", JSON.stringify(uncaught.failures) === JSON.stringify(['uncaught JS error on load — "TypeError: x is undefined"']), uncaught.failures.join("; "));
  }

  // h — the feed line: the count appears only when it decided something.
  {
    const trouble = smokeOutcomeLine({ ok: false, healthy: 31, unreached: [], failures: ["/tutorials/103-safe-practice-mock-interviews logged 6 console errors"], baselineRunNumber: 152 }, u("/"));
    check("h: trouble names the page and its count", trouble === "Smoke found trouble: /tutorials/103-safe-practice-mock-interviews logged 6 console errors — running the full check", trouble);
    const ok = smokeOutcomeLine({ ok: true, healthy: 31, unreached: [], failures: [], baselineRunNumber: 152 }, u("/"));
    check("h: the ok line has no console sentence (93 errors recorded, none spoken)", !/console/i.test(ok), ok);
    check("h: no machinery leaks", !hasEnvironmentLeak(trouble) && !hasEnvironmentLeak(ok));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
