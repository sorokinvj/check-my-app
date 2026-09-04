// CHE-171 verification: a 404 on an address nobody published is not a defect.
//
// Run #142 (the CHE-168 DeepSeek spike on joblander.app): the nav model's
// first action in a journey was `navigate https://joblander.app/landing`,
// which it called "the documented landing URL". Nothing documented it — not
// the homepage, not sitemap.xml, not a read_page digest, not the survey. The
// 404 became a step, the step a finding ("/landing returns a 404 dead-end",
// broken/low), and the finding JOB-929 on the customer's board. CLAUDE.md rule
// 3: "broken" needs evidence a real user would hit, and no user types an
// address nothing links to.
//
// The cure is a set, not a sentence: ToolEnv.knownUrls holds every address the
// run has actually seen published, filled by the tools themselves. Three
// things must hold, and all three are exercised here through the real
// executeTool with a stub page — no browser, no tokens, no product:
//   1. the set is filled deterministically — the target, every href read_page
//      sees (all of them, not the 40 it prints), where a navigate or click
//      lands, and whatever the workflow seeds from the survey;
//   2. navigate to a 404/410 outside the set answers with a refusal that says
//      so, and does not add the address (typing it twice does not make it
//      real); the same status on a published address is reported as before;
//   3. report_step cannot write a broken/confusing step off such a 404 — it is
//      written skipped/not_applicable with the reason in product language —
//      while a 404 on a published address, or one the product's own request
//      produced, stays exactly what the model said.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-unpublished-404.ts

import {
  coerceUnpublished404,
  executeTool,
  knownUrlKey,
  knownUrlsFrom,
  type RecordedAction,
  type ReportedStep,
  type ToolEnv,
} from "@/agent/tools";
import { hasEnvironmentLeak } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://target.test";

// A page that answers navigate with a status per path, renders a digest whose
// anchors are whatever the test put there, and whose one clickable control
// lands on /after-click.
function stubPage(opts: { statuses: Record<string, number>; hrefs: string[]; networkLog: string[] }) {
  let url = `${ORIGIN}/`;
  const locator = {
    first: () => locator,
    count: async () => 1,
    or: () => locator,
    elementHandle: async () => null,
    click: async () => {
      opts.networkLog.push(`GET ${ORIGIN}/after-click → 200`);
      url = `${ORIGIN}/after-click`;
    },
  };
  return {
    url: () => url,
    goto: async (u: string) => {
      url = u;
      const path = new URL(u).pathname;
      return { status: () => opts.statuses[path] ?? 200 };
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    // read_page's digest is a function; every other evaluate is a string
    // (hydration tick, mutation counter) and gets the number those expect.
    evaluate: async (script: unknown) =>
      typeof script === "function"
        ? {
            url,
            title: "Stub",
            headings: [],
            links: opts.hrefs.slice(0, 40).map((h) => `"link" → ${h}`),
            hrefs: opts.hrefs,
            buttons: [],
            fields: [],
          }
        : 0,
    addInitScript: async () => {},
    on: () => {},
    getByRole: () => locator,
    getByText: () => locator,
    locator: () => locator,
  };
}

function stubEnv(opts: {
  statuses?: Record<string, number>;
  hrefs?: string[];
  known?: Set<string> | null;
  trail?: boolean;
}): ToolEnv {
  const networkLog: string[] = [];
  return {
    page: stubPage({ statuses: opts.statuses ?? {}, hrefs: opts.hrefs ?? [], networkLog }),
    targetOrigin: ORIGIN,
    networkLog,
    consoleLog: [],
    writeAllowed: false,
    credentials: { rejected: false },
    ...(opts.trail === false ? {} : { actionTrail: [] }),
    ...(opts.known === null ? {} : { knownUrls: opts.known ?? knownUrlsFrom(`${ORIGIN}/`) }),
  } as unknown as ToolEnv;
}

function step(status: ReportedStep["status"], observed: string, attempted = "Open the page"): ReportedStep {
  return { label: "Open the page", status, attempted, observed };
}

async function main() {
  // 1 — one spelling per address, and the workflow's seed.
  check("key: host is lower-cased, trailing slash and fragment dropped, query kept",
    knownUrlKey("HTTPS://Target.TEST/Pricing/?plan=pro#top") === "https://target.test/Pricing?plan=pro",
    String(knownUrlKey("HTTPS://Target.TEST/Pricing/?plan=pro#top")));
  check("key: a bare path resolves against the base", knownUrlKey("/docs", ORIGIN) === `${ORIGIN}/docs`);
  check("key: mailto and garbage are not addresses",
    knownUrlKey("mailto:hi@target.test") === null && knownUrlKey("not a url") === null);
  const seeded = knownUrlsFrom(`${ORIGIN}/`, [`${ORIGIN}/pricing`, "/docs/"]);
  check("seed: the target, an absolute page and a bare path from the survey are all known",
    seeded.has(`${ORIGIN}/`) && seeded.has(`${ORIGIN}/pricing`) && seeded.has(`${ORIGIN}/docs`),
    [...seeded].join(" "));

  // 2 — read_page fills the set with EVERY href, not the 40 it prints.
  {
    const hrefs = Array.from({ length: 45 }, (_, i) => `${ORIGIN}/page-${i + 1}`);
    hrefs.push("/relative-link", "mailto:hi@target.test");
    const env = stubEnv({ hrefs });
    const digest = await executeTool(env, "read_page", {});
    const printed = (digest.match(/→ https:\/\/target\.test\/page-\d+/g) ?? []).length;
    check("read_page: the digest still prints 40 links", printed === 40, String(printed));
    check("read_page: the 45th href is known although it was not printed",
      env.knownUrls!.has(`${ORIGIN}/page-45`) && env.knownUrls!.has(`${ORIGIN}/relative-link`),
      `${env.knownUrls!.size} known`);
    check("read_page: a mailto link is not an address", ![...env.knownUrls!].some((k) => k.includes("mailto")));
  }

  // 3 — navigate: a 404 on a linked address is reported as before; on an
  // unseen one it is refused and NOT remembered.
  {
    const env = stubEnv({ statuses: { "/pricing": 404, "/landing": 404, "/old": 410, "/fresh": 200, "/down": 500 } });
    env.knownUrls!.add(`${ORIGIN}/pricing`);
    const linked = await executeTool(env, "navigate", { url: "/pricing" });
    check("navigate: 404 on a published address is reported plainly",
      linked === `Navigated to ${ORIGIN}/pricing (status 404)`, linked);
    const unseen = await executeTool(env, "navigate", { url: "/landing" });
    check("navigate: 404 on an unseen address carries the refusal",
      unseen.startsWith(`Navigated to ${ORIGIN}/landing (status 404). This address is not linked from any page you have read`) &&
        unseen.includes("do not report it as broken"),
      unseen.slice(0, 80));
    check("navigate: the unseen address is still unknown afterwards", !env.knownUrls!.has(`${ORIGIN}/landing`));
    const again = await executeTool(env, "navigate", { url: "/landing" });
    check("navigate: typing it twice does not make it real", again.includes("do not report it as broken"));
    const gone = await executeTool(env, "navigate", { url: "/old" });
    check("navigate: 410 is treated like 404", gone.includes("(status 410). This address is not linked"), gone.slice(0, 60));
    const fresh = await executeTool(env, "navigate", { url: "/fresh" });
    check("navigate: 200 on an unseen address is untouched and becomes known",
      fresh === `Navigated to ${ORIGIN}/fresh (status 200)` && env.knownUrls!.has(`${ORIGIN}/fresh`), fresh);
    const down = await executeTool(env, "navigate", { url: "/down" });
    check("navigate: a 500 is the product's own word, never gated",
      down === `Navigated to ${ORIGIN}/down (status 500)`, down);
    const trail = env.actionTrail as RecordedAction[];
    check("navigate: the refused 404 is still recorded with its status (CHE-129)",
      trail.some((a) => a.kind === "navigate" && a.url === `${ORIGIN}/landing` && a.outcome.status === 404),
      `${trail.length} actions`);
    await executeTool(env, "click", { role: "link", name: "Somewhere" });
    check("click: where a click lands is known", env.knownUrls!.has(`${ORIGIN}/after-click`));
  }

  // 4 — report_step, with the trail: the step that JOB-929 was filed from.
  {
    const env = stubEnv({ statuses: { "/landing": 404 } });
    await executeTool(env, "navigate", { url: "/landing" });
    const reported: ReportedStep[] = [];
    env.onReportStep = async (s) => {
      reported.push(s);
    };
    await executeTool(env, "report_step", step("broken",
      "The documented landing URL https://target.test/landing returns a 404 dead-end.",
      "Navigate to the landing page"));
    const s = reported[0];
    check("report_step: broken off an unseen 404 is written skipped / not_applicable",
      s.status === "skipped" && s.unverifiedReason === "not_applicable", `${s.status}/${s.unverifiedReason}`);
    check("report_step: the reason is appended in product language",
      s.observed.endsWith(" This address is not part of the product's navigation.") &&
        !hasEnvironmentLeak(s.observed),
      s.observed);
  }
  // A published 404 with the trail: stays broken — the product sent the user there.
  {
    const env = stubEnv({ statuses: { "/pricing": 404 } });
    env.knownUrls!.add(`${ORIGIN}/pricing`);
    await executeTool(env, "navigate", { url: "/pricing" });
    const reported: ReportedStep[] = [];
    env.onReportStep = async (s) => {
      reported.push(s);
    };
    await executeTool(env, "report_step", step("broken", "The Pricing link in the header opens /pricing, which returns 404."));
    check("report_step: broken off a 404 on a published address survives",
      reported[0].status === "broken" && reported[0].unverifiedReason === undefined, reported[0].status);
  }
  // A 404 the product's own request produced (a click, no navigate in the
  // trail): the model's word stands — that is what a real user hits.
  {
    const env = stubEnv({});
    await executeTool(env, "click", { role: "button", name: "Sign in" });
    const reported: ReportedStep[] = [];
    env.onReportStep = async (s) => {
      reported.push(s);
    };
    await executeTool(env, "report_step", step("broken", "Clicking Sign in posts to /api/login, which answers 404."));
    check("report_step: a 404 from the product's own request (no typed navigate) stays broken",
      reported[0].status === "broken", reported[0].status);
  }
  // The confusing spelling of the same mistake, and a step with no address in
  // the text at all — the trail supplies it.
  {
    const env = stubEnv({ statuses: { "/landing": 404 } });
    await executeTool(env, "navigate", { url: "/landing" });
    const s = step("confusing", "The landing page could not be found (404), which would confuse a new visitor.");
    coerceUnpublished404(s, env);
    check("coerce: confusing off an unseen 404 named only by the trail is skipped",
      s.status === "skipped" && s.unverifiedReason === "not_applicable", `${s.status}/${s.unverifiedReason}`);
  }

  // 5 — the text-only path (no trail, as a bare ToolEnv would have).
  {
    const env = stubEnv({ trail: false });
    env.knownUrls!.add(`${ORIGIN}/pricing`);
    const unseen = step("broken", "/landing returns a 404 dead-end.");
    coerceUnpublished404(unseen, env);
    check("coerce (no trail): a cited unseen path with a 404 is skipped", unseen.status === "skipped");
    const known = step("broken", "/pricing returns a 404 dead-end.");
    coerceUnpublished404(known, env);
    check("coerce (no trail): a cited published path with a 404 stays broken", known.status === "broken");
    const mixed = step("broken", "From /pricing I typed /landing and got 404.");
    coerceUnpublished404(mixed, env);
    check("coerce (no trail): one published address among those cited keeps the step", mixed.status === "broken");
    const server = step("broken", "/landing returns 404 and the console shows a 500 from /api/session.");
    coerceUnpublished404(server, env);
    check("coerce: a server error in the same step is never gated", server.status === "broken");
    const noAddress = step("broken", "The page said not found.");
    coerceUnpublished404(noAddress, env);
    check("coerce: no address anywhere → nothing to decide, step untouched", noAddress.status === "broken");
    const ok = step("ok", "/landing returns 404 but that is fine.");
    coerceUnpublished404(ok, env);
    check("coerce: only broken/confusing are rewritten", ok.status === "ok");
  }

  // 6 — without the set (a script's bare ToolEnv) nothing changes.
  {
    const env = stubEnv({ statuses: { "/landing": 404 }, known: null });
    const plain = await executeTool(env, "navigate", { url: "/landing" });
    check("no set: navigate reports the 404 as before", plain === `Navigated to ${ORIGIN}/landing (status 404)`, plain);
    const s = step("broken", "/landing returns 404.");
    coerceUnpublished404(s, env);
    check("no set: report_step is untouched", s.status === "broken");
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
