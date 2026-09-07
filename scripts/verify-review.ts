// CHE-201 verification: GET /api/runs/{id}/review hands a coding agent the
// whole result, and every sentence this payload composes obeys the rules the
// stored text already obeyed.
//
// Built over a stubbed prisma returning one fixture run — the demo seed's
// joblander.app run (prisma/seed.ts), with three things added that the seed
// does not have and the review must handle: an anatomy in discovery's
// "Label (`/path`)" form with one page no step reached; a step skipped for
// our_capability; and a finding whose "what happened" leads with our own
// machinery ("did nothing in our test browser"). No database, no model, no
// network.
//
// What must hold:
//   1. every field of the shape is present and typed, evidence URLs absolute
//      against the origin the review was fetched from;
//   2. next_actions: one per finding, derived from the finding's own fields,
//      no machinery, no homework, no walker's voice (§1), no file / cause /
//      fix (§9) — the machinery-leading finding still gets an action, built
//      from its title, and the sentence never carries the leak;
//   3. an unverified step is coverage, not a finding: it lands in
//      coverage.unverified with its reason and produces no next action;
//   4. a page discovery named and no step opened is in pages_not_opened.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-review.ts

import type { PrismaClient } from "@/generated/prisma/client";
import { buildReview, loadReview, nextActionFor, type ReviewSource } from "@/lib/review";
import { MACHINERY_TERMS, hasEnvironmentLeak, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://checkmyapp.dev";
const STARTED = new Date("2026-09-06T10:00:00Z");
const COMPLETED = new Date("2026-09-06T10:34:00Z");

const FIXTURE: ReviewSource = {
  publicId: "review-fixture",
  appSlug: "joblander.app",
  status: "completed",
  verdict: "needs_attention",
  bottomLine:
    "Core product works and feels coherent — but mobile signup is broken and the AI coach has no rate limit.",
  anatomy: JSON.stringify({
    pages: ["Home (`/`)", "Sign up (`/signup`)", "Pricing (`/pricing`)", "Settings (`/settings`)"],
    actions: ["Sign up", "Start mock interview"],
    services: [{ name: "Stripe", role: "payments" }],
    tech: { frontend: "Next.js" },
  }),
  deploySha: "a1b2c3d4e5f",
  deployEnv: "production",
  startedAt: STARTED,
  completedAt: COMPLETED,
  journeys: [
    {
      title: "Sign up → first mock interview",
      status: "broken",
      summary: "Signup fails on Safari mobile.",
      steps: [
        {
          order: 0,
          label: "Land on homepage",
          status: "ok",
          attempted: "Open joblander.app",
          observed: "Homepage loaded.",
          unverifiedReason: null,
          networkLog: "GET https://joblander.app/ → 200",
        },
        {
          order: 1,
          label: "Submit the signup form",
          status: "broken",
          attempted: "Fill the signup form and submit it",
          observed: "POST /api/auth/signup → 500 FUNCTION_INVOCATION_TIMEOUT",
          unverifiedReason: null,
          networkLog: "POST https://joblander.app/api/auth/signup → 500 (10003ms)",
        },
        {
          order: 2,
          label: "Record an audio answer",
          status: "skipped",
          attempted: "Record a 60-second answer to the first question",
          observed: "We could not confirm this step this run.",
          unverifiedReason: "our_capability",
          networkLog: null,
        },
      ],
    },
    {
      title: "Free → paid (browse pricing)",
      status: "confusing",
      summary: "Pricing shows 4 tiers but two of them list identical features.",
      steps: [
        {
          order: 0,
          label: "Open /pricing",
          status: "ok",
          attempted: "Open the pricing page",
          observed: "Four tiers are shown on /pricing.",
          unverifiedReason: null,
          networkLog: "GET https://joblander.app/pricing → 200",
        },
        {
          order: 1,
          label: "Compare tiers",
          status: "confusing",
          attempted: "Understand the tier differences",
          observed: "Pro and Team list identical features.",
          unverifiedReason: null,
          networkLog: null,
        },
      ],
    },
  ],
  findings: [
    {
      number: 1,
      title: "Sign up returns 500 on Safari mobile",
      category: "broken",
      severity: "high",
      mark: "none",
      detail: JSON.stringify({
        where: "POST /api/auth/signup → 500",
        browser: "Mobile Safari simulation (iPhone 14)",
        reproduced: 3,
        whatWeTried: ["Open joblander.app on an iPhone", 'Click "Get started"', 'Click "Create account"'],
        whatHappened:
          'Response: 500 — {"error":"FUNCTION_INVOCATION_TIMEOUT"}\nConsole: "Failed to load resource: 500"\nTime-to-fail: 10003ms — looks like a function cold-start',
        whyItMatters:
          "~18% of joblander mobile traffic is iOS Safari. These users can't sign up at all. Acquisition leak.",
      }),
      evidence: [
        { type: "screenshot", storageUrl: "/api/evidence/shots/3f2a.png" },
        { type: "network_har", storageUrl: "https://checkmyapp.dev/api/evidence/har/3f2a.har" },
      ],
    },
    {
      // A stored finding from before the CHE-82 gate: its own words lead with
      // our machinery. The finding is returned as stored; the next action
      // must not carry the leak.
      number: 2,
      title: "Saving insight preferences has no effect",
      category: "broken",
      severity: "medium",
      mark: "none",
      detail: JSON.stringify({
        where: "/settings → Save Changes",
        whatHappened:
          "The Save Changes button did nothing in our test browser (0 requests, 0 mutations). The sliders reset on reload.",
        whyItMatters: "Preferences a user sets are lost; the settings page does not do what it says.",
      }),
      evidence: [],
    },
    {
      number: 3,
      title: "Pro and Team tiers list identical features",
      category: "confusing",
      severity: "low",
      mark: "known",
      detail: JSON.stringify({ where: "/pricing", whyItMatters: "Users can't tell what they'd pay more for." }),
      evidence: [],
    },
    {
      // No detail at all — an older row. The action falls back to the title
      // and the app.
      number: 4,
      title: "404 page has no link back to the dashboard",
      category: "polish",
      severity: "low",
      mark: "none",
      detail: null,
      evidence: [],
    },
  ],
};

// Words a next action must never carry (§9): a file, a cause, a fix.
const HOW_WORDS = /\b(fix|fixed|fixes|patch|refactor|cause[sd]?|because|root cause|src\/|\.tsx?\b|\.js\b|function|handler|config|cold[- ]start|should)\b/i;

function leaks(text: string): string {
  const what: string[] = [];
  if (hasEnvironmentLeak(text)) what.push("environment/homework");
  if (MACHINERY_TERMS.test(text)) what.push(`machinery:${text.match(MACHINERY_TERMS)?.[0]}`);
  if (hasNarration(text)) what.push("narration");
  if (HOW_WORDS.test(text)) what.push(`how:${text.match(HOW_WORDS)?.[0]}`);
  return what.join(",");
}

async function main() {
  // The route's path: a prisma whose one query returns the fixture.
  const calls: unknown[] = [];
  const prisma = {
    run: {
      findUnique: async (args: unknown) => {
        calls.push(args);
        return (args as { where: { publicId: string } }).where.publicId === FIXTURE.publicId ? FIXTURE : null;
      },
    },
  } as unknown as PrismaClient;

  const missing = await loadReview(prisma, "no-such-run", ORIGIN);
  check("loadReview: an unknown id is null (the route answers 404)", missing === null);

  const review = await loadReview(prisma, FIXTURE.publicId, ORIGIN);
  check("loadReview: the fixture id is found by publicId", review !== null && calls.length === 2);
  if (!review) {
    console.log("\n1 FAILED");
    process.exit(1);
  }
  check("loadReview and buildReview agree", JSON.stringify(review) === JSON.stringify(buildReview(FIXTURE, ORIGIN)));

  // 1 — the shape.
  check(
    "run: id/status/verdict/appSlug/startedAt/completedAt",
    review.run.id === "review-fixture" &&
      review.run.status === "completed" &&
      review.run.verdict === "needs_attention" &&
      review.run.appSlug === "joblander.app" &&
      review.run.startedAt === STARTED &&
      review.run.completedAt === COMPLETED,
    JSON.stringify(review.run),
  );
  check(
    "run: deploy identity carried as {sha, env}",
    review.run.deploy?.sha === "a1b2c3d4e5f" && review.run.deploy?.env === "production",
  );
  check(
    "run: deploy is null when the run named no build",
    buildReview({ ...FIXTURE, deploySha: null, deployEnv: null }, ORIGIN).run.deploy === null,
  );
  check("bottom_line is the stored bottom line", review.bottom_line === FIXTURE.bottomLine);
  check("plan_results is reserved and empty", Array.isArray(review.plan_results) && review.plan_results.length === 0);
  check(
    "urls: verdict and live are absolute against the origin",
    review.urls.verdict === `${ORIGIN}/verdict/review-fixture` && review.urls.live === `${ORIGIN}/run/review-fixture`,
  );
  check(
    "urls: a trailing slash on the origin is not doubled",
    buildReview(FIXTURE, `${ORIGIN}/`).urls.verdict === `${ORIGIN}/verdict/review-fixture`,
  );

  check("journeys: both, in order, with title/status/summary", review.journeys.length === 2 &&
    review.journeys[0].title === "Sign up → first mock interview" &&
    review.journeys[0].status === "broken" &&
    review.journeys[1].summary === FIXTURE.journeys[1].summary);
  const step = review.journeys[0].steps[1];
  check(
    "steps: order/label/attempted/observed/status/unverified_reason",
    review.journeys[0].steps.length === 3 &&
      step.order === 1 &&
      step.label === "Submit the signup form" &&
      step.attempted === "Fill the signup form and submit it" &&
      step.observed === "POST /api/auth/signup → 500 FUNCTION_INVOCATION_TIMEOUT" &&
      step.status === "broken" &&
      step.unverified_reason === null &&
      review.journeys[0].steps[2].unverified_reason === "our_capability",
    JSON.stringify(step),
  );

  const f1 = review.findings[0];
  check("findings: all four, numbered in order", review.findings.map((f) => f.number).join(",") === "1,2,3,4");
  check(
    "finding: number/title/category/severity/mark",
    f1.number === 1 &&
      f1.title === "Sign up returns 500 on Safari mobile" &&
      f1.category === "broken" &&
      f1.severity === "high" &&
      f1.mark === "none" &&
      review.findings[2].mark === "known",
  );
  check(
    "finding: where/what_we_tried/what_happened/why_it_matters from detail",
    f1.where === "POST /api/auth/signup → 500" &&
      f1.what_we_tried.length === 3 &&
      f1.what_we_tried[1] === 'Click "Get started"' &&
      f1.what_happened?.startsWith("Response: 500") === true &&
      f1.why_it_matters?.startsWith("~18%") === true,
  );
  check(
    "finding: evidence is {kind, url}, relative paths made absolute, absolute ones untouched",
    f1.evidence.length === 2 &&
      f1.evidence[0].kind === "screenshot" &&
      f1.evidence[0].url === `${ORIGIN}/api/evidence/shots/3f2a.png` &&
      f1.evidence[1].kind === "network_har" &&
      f1.evidence[1].url === "https://checkmyapp.dev/api/evidence/har/3f2a.har",
    JSON.stringify(f1.evidence),
  );
  check(
    "finding: evidence URLs are absolute against whatever origin fetched the review",
    buildReview(FIXTURE, "http://localhost:3000").findings[0].evidence[0].url ===
      "http://localhost:3000/api/evidence/shots/3f2a.png",
  );
  const f4 = review.findings[3];
  check(
    "finding without detail: nulls and an empty list, never undefined",
    f4.where === null && f4.what_we_tried.length === 0 && f4.what_happened === null && f4.why_it_matters === null,
    JSON.stringify(f4),
  );

  // 2 — next actions.
  check(
    "next_actions: one per finding, numbered like the findings",
    review.next_actions.map((a) => a.finding).join(",") === "1,2,3,4",
  );
  const a1 = review.next_actions[0];
  check(
    "next_action #1: symptom is what happened (first line) plus where",
    a1.symptom === 'Response: 500 — {"error":"FUNCTION_INVOCATION_TIMEOUT"} (POST /api/auth/signup → 500)',
    a1.symptom,
  );
  check(
    "next_action #1: how_to_know_it_is_gone names the place, the expectation and the observation",
    a1.how_to_know_it_is_gone ===
      'The next check of POST /api/auth/signup → 500 shows the action going through as a user would expect instead of "Response: 500 — {"error":"FUNCTION_INVOCATION_TIMEOUT"}".',
    a1.how_to_know_it_is_gone,
  );
  check(
    "next_action #1: the diagnosis line of what happened (\"looks like a cold-start\") is not carried",
    !/cold-start|Time-to-fail|Console/.test(a1.symptom + a1.how_to_know_it_is_gone),
  );
  const a2 = review.next_actions[1];
  check(
    "next_action #2: a machinery-leading finding still gets an action, from its title",
    a2.symptom === "Saving insight preferences has no effect (/settings → Save Changes)" &&
      a2.how_to_know_it_is_gone.includes('instead of "Saving insight preferences has no effect"'),
    `${a2.symptom} | ${a2.how_to_know_it_is_gone}`,
  );
  check(
    "next_action #2: the stored finding itself is returned as stored",
    review.findings[1].what_happened?.includes("our test browser") === true,
  );
  const a3 = review.next_actions[2];
  check(
    "next_action #3: no what-happened → the title stands in for the observation",
    a3.symptom === "Pro and Team tiers list identical features (/pricing)" &&
      a3.how_to_know_it_is_gone ===
        'The next check of /pricing shows an outcome a user can read at a glance instead of "Pro and Team tiers list identical features".',
    a3.how_to_know_it_is_gone,
  );
  const a4 = review.next_actions[3];
  check(
    "next_action #4: no where → the app is the place",
    a4.symptom === "404 page has no link back to the dashboard" &&
      a4.how_to_know_it_is_gone.startsWith("The next check of joblander.app shows a finished, consistent state instead of"),
    a4.how_to_know_it_is_gone,
  );
  for (const a of review.next_actions) {
    const text = `${a.symptom} ${a.how_to_know_it_is_gone}`;
    check(`next_action #${a.finding}: §1 — no machinery, no homework, no walker; §9 — no file, cause or fix`, leaks(text) === "", leaks(text));
  }
  check(
    "nextActionFor: an unknown category still yields a sentence",
    nextActionFor({ number: 9, title: "Odd", category: "weird", detail: null }, "x.test").how_to_know_it_is_gone ===
      'The next check of x.test shows what a user would expect instead of "Odd".',
  );
  check(
    "nextActionFor: a what-happened that is only machinery and a title that leaks fall back to a numbered placeholder",
    nextActionFor(
      {
        number: 7,
        title: "Nothing happened in our test browser",
        category: "broken",
        detail: JSON.stringify({ where: "/x", whatHappened: "Headless run saw 0 requests, 0 mutations." }),
      },
      "x.test",
    ).symptom === "Finding #7 (/x)",
  );

  // 3 — coverage.
  check(
    "coverage.unverified: the skipped step, with its journey and reason",
    review.coverage.unverified.length === 1 &&
      review.coverage.unverified[0].journey === "Sign up → first mock interview" &&
      review.coverage.unverified[0].step === "Record an audio answer" &&
      review.coverage.unverified[0].reason === "our_capability",
    JSON.stringify(review.coverage.unverified),
  );
  check(
    "coverage.unverified: the skipped step is not a finding and has no next action",
    !review.findings.some((f) => /audio answer/i.test(f.title)) &&
      !review.next_actions.some((a) => /audio answer/i.test(a.symptom)) &&
      review.next_actions.length === review.findings.length,
  );
  for (const u of review.coverage.unverified) {
    check("coverage.unverified: §1 on journey and step", leaks(`${u.journey} ${u.step}`) === "", leaks(`${u.journey} ${u.step}`));
  }

  // 4 — pages.
  check(
    "coverage.pages_not_opened: the page no step reached, and only it",
    review.coverage.pages_not_opened.join(",") === "/settings",
    review.coverage.pages_not_opened.join(","),
  );
  check(
    "coverage.pages_not_opened: empty when the run has no anatomy",
    buildReview({ ...FIXTURE, anatomy: null }, ORIGIN).coverage.pages_not_opened.length === 0,
  );

  // The whole payload survives JSON (the route's NextResponse.json).
  const json = JSON.parse(JSON.stringify(review));
  check(
    "the payload round-trips through JSON with the top-level keys in place",
    ["run", "bottom_line", "journeys", "findings", "plan_results", "next_actions", "coverage", "urls"].every((k) => k in json),
    Object.keys(json).join(","),
  );

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
