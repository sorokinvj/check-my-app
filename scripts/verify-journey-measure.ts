// CHE-239 verification: measuring a journey against the customer's analytics.
//
// Three things here can produce a wrong number that looks exactly like a right
// one, and all three would be read as a fact about the customer's product:
//
//   1. a stage pattern that matches nothing — every funnel reports 0%, and we
//      tell a customer their product converts nobody;
//   2. a stage pattern that matches too much — /orders/:id swallowing
//      /orders/12/refund counts two pages as one stage;
//   3. a percentage printed over a sample too small to mean anything.
//
// The shapes below are the real ones. `REAL_RESULT` is what the live PostHog
// API returned for project 595090 on 2026-09-16 — 25 people reached /check, 3
// reached a verdict page — and the query that produced it is the query this
// file builds.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-journey-measure.ts

import {
  MIN_SAMPLE,
  WINDOW_DAYS,
  funnelQuery,
  measureFunnel,
  readFunnelResult,
  stagePattern,
} from "@/lib/posthog/measure";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

/** Exactly what the live API returned, fields trimmed to what we read. */
const REAL_RESULT = [
  { order: 0, name: "$pageview", count: 25, average_conversion_time: null },
  { order: 1, name: "$pageview", count: 3, average_conversion_time: 29302.42 },
];

function main() {
  console.log("A stage must match the pathnames PostHog actually stores");
  {
    // This is the one that would report every funnel as dead. Our stages are
    // normalised (/verdict/:id); PostHog stores /verdict/cmtnf9n670003wh1rc9o2rild.
    const p = stagePattern("/verdict/:id");
    check("a :id stage becomes a pattern, not a literal", p === "^/verdict/[^/]+$", p);
    check("…and it matches the raw pathname production actually has",
      new RegExp(p).test("/verdict/cmtnf9n670003wh1rc9o2rild"));
    check("…and does NOT match a deeper path — :id is one segment, never a slash",
      !new RegExp(p).test("/verdict/cmtnf9n670003wh1rc9o2rild/share"));
    check("…nor the bare parent", !new RegExp(p).test("/verdict"));

    const plain = stagePattern("/check");
    check("a plain stage is anchored at both ends", plain === "^/check$", plain);
    check("…so /check does not match /checkout", !new RegExp(plain).test("/checkout"));
    check("…and does not match /checks/today", !new RegExp(plain).test("/checks/today"));

    // Regex metacharacters in a real path must not become regex.
    const dotted = stagePattern("/pricing.html");
    check("a dot in a path is a dot, not 'any character'",
      new RegExp(dotted).test("/pricing.html") && !new RegExp(dotted).test("/pricingxhtml"), dotted);
    const plus = stagePattern("/a+b");
    check("a plus in a path is a plus", new RegExp(plus).test("/a+b") && !new RegExp(plus).test("/aab"), plus);

    const multi = stagePattern("/orders/:id/items/:id");
    check("two ids both become patterns", multi === "^/orders/[^/]+/items/[^/]+$", multi);
  }

  console.log("\nThe query we send is the query that was verified against the live API");
  {
    const q = funnelQuery(["/check", "/verdict/:id"]) as {
      kind: string;
      dateRange: { date_from: string };
      series: Array<{ kind: string; event: string; properties: Array<{ key: string; operator: string; value: string }> }>;
    };
    check("it is a FunnelsQuery", q.kind === "FunnelsQuery");
    check("one series entry per stage, in order", q.series.length === 2);
    check("each step is a pageview filtered by pathname",
      q.series.every((s) => s.event === "$pageview" && s.properties[0].key === "$pathname"));
    check("…matched by regex, which is what makes :id work",
      q.series.every((s) => s.properties[0].operator === "regex"));
    check("…and the second step carries the id pattern",
      q.series[1].properties[0].value === "^/verdict/[^/]+$", q.series[1].properties[0].value);
    check("the window is 14 days, as the ticket says", q.dateRange.date_from === "-14d", q.dateRange.date_from);
    check("WINDOW_DAYS and the query agree", funnelQuery(["/a", "/b"], WINDOW_DAYS) !== null && WINDOW_DAYS === 14);
  }

  console.log("\nBelow the floor there is no measurement, only a sample size");
  {
    // The real result IS a below-floor case: 3 of 25 is "12%", and 25 people is
    // not a measurement of anything.
    const real = readFunnelResult(["/check", "/verdict/:id"], REAL_RESULT, 14);
    check("the live 25→3 result is refused as a percentage",
      real.ok && real.measurement === null, JSON.stringify(real));
    check("…but still reports the sample it saw",
      real.ok && real.measurement === null && real.sample === 25, JSON.stringify(real));
    check("…and says why", real.ok && real.measurement === null && real.reason === "below_floor");

    const justUnder = readFunnelResult(["/a", "/b"], [{ count: MIN_SAMPLE - 1 }, { count: 5 }], 14);
    check("one below the floor is still refused", justUnder.ok && justUnder.measurement === null);
    const atFloor = readFunnelResult(["/a", "/b"], [{ count: MIN_SAMPLE }, { count: 5 }], 14);
    check("exactly at the floor is measured", atFloor.ok && atFloor.measurement !== null);
    check("the floor is a stated number, not a magic one", MIN_SAMPLE >= 20, String(MIN_SAMPLE));
  }

  console.log("\nThe arithmetic, where a wrong number is indistinguishable from a right one");
  {
    const m = readFunnelResult(["/a", "/b", "/c"], [{ count: 200 }, { count: 80 }, { count: 50 }], 14);
    check("conversion is finishers over starters", m.ok && m.measurement?.conversion === 25, JSON.stringify(m));
    check("sample is the FIRST stage, not the last", m.ok && m.measurement?.sample === 200);
    check("every stage keeps its own count, so drop-off is readable",
      m.ok && JSON.stringify(m.measurement?.steps) ===
        JSON.stringify([{ stage: "/a", count: 200 }, { stage: "/b", count: 80 }, { stage: "/c", count: 50 }]),
      JSON.stringify(m.ok ? m.measurement?.steps : null));
    check("the window travels with the number", m.ok && m.measurement?.windowDays === 14);

    const none = readFunnelResult(["/a", "/b"], [{ count: 500 }, { count: 0 }], 14);
    check("nobody finishing is 0%, a real answer with a real sample",
      none.ok && none.measurement?.conversion === 0 && none.measurement.sample === 500);

    // A mismatched step count means we are reading someone else's funnel.
    const wrong = readFunnelResult(["/a", "/b", "/c"], [{ count: 10 }, { count: 5 }], 14);
    check("fewer steps back than stages sent is a failure, never a partial number",
      !wrong.ok, JSON.stringify(wrong));
  }

  console.log("\nA failure costs the measurement and nothing else");
  {
    const dead = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const ok = (body: unknown, status = 200) =>
      (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const args = { token: "t", baseUrl: "https://us.posthog.com", projectId: "595090", stages: ["/a", "/b"] };

    void (async () => {
      check("a network failure is reported, never thrown",
        !(await measureFunnel({ ...args, fetchImpl: dead })).ok);
      check("an HTTP error is reported, never thrown",
        !(await measureFunnel({ ...args, fetchImpl: ok({}, 500) })).ok);
      check("a response with no steps is reported, not read as zero",
        !(await measureFunnel({ ...args, fetchImpl: ok({}) })).ok);
      check("a one-stage funnel is refused before any request is made",
        !(await measureFunnel({ ...args, stages: ["/only"], fetchImpl: dead })).ok);

      // And the happy path, against the live response shape.
      const live = await measureFunnel({
        ...args,
        stages: ["/check", "/verdict/:id"],
        fetchImpl: ok({ results: REAL_RESULT }),
      });
      check("the live response shape parses end to end",
        live.ok && live.measurement === null && live.sample === 25, JSON.stringify(live));

      const big = await measureFunnel({
        ...args,
        fetchImpl: ok({ results: [{ count: 400 }, { count: 44 }] }),
      });
      check("a real sample gives a real number", big.ok && big.measurement?.conversion === 11, JSON.stringify(big));

      console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
      process.exit(failures === 0 ? 0 : 1);
    })();
  }
}

main();
