// CHE-239 verification: what the measurement step promises the RUN.
//
// `scripts/verify-journey-measure.ts` holds the query and the arithmetic to
// account. This holds the orchestration around them, which is where the
// promises that are easy to state and easy to break live:
//
//   1. **A failure costs the measurement, never the run.** Nothing in here may
//      throw into the workflow. An outage at a third party is not a fact about
//      the customer's product, and a verdict that fails to publish because
//      PostHog was down would be our billing showing through their results
//      (rule 4's instinct, one step out).
//
//   2. **One query per funnel per run.** Two journeys that reduce to the same
//      funnel are the same question, and asking it twice costs the customer's
//      rate limit for nothing. Stated in the ticket as "cheap"; nothing checked
//      it until this file.
//
//   3. **Silence and "not enough" are different facts.** A journey we could not
//      measure writes NO row. A journey we measured and found too small writes a
//      row with a sample size and no percentage. Collapsing the two would make
//      "no data" unreadable, and the sentence the customer reads is chosen from
//      exactly this distinction (CHE-240's `below_floor` vs `not_measured_yet`).
//
//   4. **An app without analytics is never nagged and never costs a request.**
//
// Everything is exercised through the real `measureRunJourneys` with a stubbed
// `fetch` and a stubbed database — the contracts above are about what that
// function does, so asserting them against a reimplementation would prove
// nothing.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-journey-measurement.ts

// Set before importing anything that reaches src/lib/crypto: the token row is
// built here with encryptSecret, so this value never leaves this process and is
// never a real secret.
process.env.CREDENTIALS_SECRET ??= "verify-journey-measurement-local-only";

import { encryptSecret } from "@/lib/crypto";
import { measureRunJourneys, measurementNote } from "@/agent/journey-measurement";
import { MIN_SAMPLE } from "@/lib/posthog/measure";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

interface JourneySpec {
  id: string;
  title: string;
  stages: string[] | null;
}

interface Built {
  env: unknown;
  created: Array<Record<string, unknown>>;
  fetches: string[];
}

/** A run with these journeys, an integration, and a project — unless told otherwise. */
function build(
  journeys: JourneySpec[],
  opts: {
    projectId?: string | null;
    counts?: number[];
    failFetch?: boolean;
    failCreate?: boolean;
  } = {},
): Built {
  const created: Array<Record<string, unknown>> = [];
  const fetches: string[] = [];

  const db = {
    run: {
      findUnique: async () => ({
        id: "run_1",
        appId: "app_1",
        app: {
          teamId: "team_1",
          posthogProjectId: opts.projectId === undefined ? "123" : opts.projectId,
        },
      }),
    },
    postHogIntegration: {
      findFirst: async () => ({
        id: "int_1",
        teamId: "team_1",
        accessTokenEnc: encryptSecret("phx_test_token"),
        refreshTokenEnc: null,
        // Far future: freshPostHogToken returns the stored token with no network.
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        region: "us",
      }),
      update: async () => ({}),
    },
    journey: {
      findMany: async () =>
        journeys.map((j) => ({
          appJourneyId: j.id,
          appJourney: {
            id: j.id,
            title: j.title,
            funnelStages: j.stages ? JSON.stringify(j.stages) : null,
          },
        })),
    },
    journeyMetricPoint: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.failCreate) throw new Error("D1 write failed");
        created.push(data);
        return data;
      },
    },
  };

  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    fetches.push(String(url));
    if (opts.failFetch) throw new Error("network unreachable");
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
    const stages = (body?.query?.series ?? []) as unknown[];
    const counts = opts.counts ?? stages.map((_, i) => (i === 0 ? 400 : 100));
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: counts.slice(0, stages.length).map((c) => ({ count: c })) }),
    };
  }) as unknown as typeof fetch;

  return { env: { db, bindings: { APP_URL: "https://checkmyapp.dev" } }, created, fetches };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (b: Built) => measureRunJourneys(b.env as any, "run_1");

async function main() {
  console.log("\n— one query per funnel per run —\n");
  {
    const b = build([
      { id: "a", title: "Sign in", stages: ["/", "/login"] },
      { id: "b", title: "Sign in again, differently named", stages: ["/", "/login"] },
    ]);
    const s = await run(b);
    check("two journeys sharing a funnel cost ONE request", b.fetches.length === 1, `${b.fetches.length} requests`);
    check("…and both still get a point", b.created.length === 2, `${b.created.length} rows`);
    check("…counted as measured", s.measured === 2, JSON.stringify(s));
  }
  {
    const b = build([
      { id: "a", title: "Sign in", stages: ["/", "/login"] },
      { id: "b", title: "Check out", stages: ["/cart", "/thanks"] },
    ]);
    await run(b);
    check("two different funnels cost two requests", b.fetches.length === 2, `${b.fetches.length} requests`);
  }

  console.log("\n— a failure costs the measurement, never the run —\n");
  {
    const b = build([{ id: "a", title: "Sign in", stages: ["/", "/login"] }], { failFetch: true });
    let threw = false;
    let summary;
    try {
      summary = await run(b);
    } catch {
      threw = true;
    }
    check("an analytics outage does not throw into the workflow", !threw);
    check("…and writes no row — silence is not a measurement", b.created.length === 0, `${b.created.length} rows`);
    check("…and is counted as failed, not as below-floor", summary?.failed === 1 && summary?.belowFloor === 0,
      JSON.stringify(summary));
  }
  {
    // The database failing is our problem too, and equally not the run's.
    const b = build([{ id: "a", title: "Sign in", stages: ["/", "/login"] }], { failCreate: true });
    let threw = false;
    try {
      await run(b);
    } catch {
      threw = true;
    }
    check("a failed write does not throw into the workflow either", !threw);
  }

  console.log("\n— silence and 'not enough' are different facts —\n");
  {
    const b = build([{ id: "a", title: "Sign in", stages: ["/", "/login"] }], {
      counts: [MIN_SAMPLE - 1, 3],
    });
    const s = await run(b);
    check("below the floor still writes a row", b.created.length === 1, `${b.created.length} rows`);
    check("…with no percentage", b.created[0]?.conversion === null, JSON.stringify(b.created[0]?.conversion));
    check("…but with the sample size, so it is a fact with a number",
      b.created[0]?.sampleSize === MIN_SAMPLE - 1, String(b.created[0]?.sampleSize));
    check("…counted as belowFloor, not measured", s.belowFloor === 1 && s.measured === 0, JSON.stringify(s));
  }
  {
    const b = build([{ id: "a", title: "Sign in", stages: ["/", "/login"] }], {
      counts: [MIN_SAMPLE, 15],
    });
    await run(b);
    check("at the floor exactly, a percentage is written", typeof b.created[0]?.conversion === "number",
      String(b.created[0]?.conversion));
    check("…and the per-step counts are kept", typeof b.created[0]?.steps === "string", String(b.created[0]?.steps));
  }

  console.log("\n— an app without analytics is never nagged —\n");
  {
    const b = build([{ id: "a", title: "Sign in", stages: ["/", "/login"] }], { projectId: null });
    const s = await run(b);
    check("no project chosen costs no request", b.fetches.length === 0, `${b.fetches.length} requests`);
    check("…and writes nothing", b.created.length === 0);
    check("…and says nothing in the feed", measurementNote(s) === null, String(measurementNote(s)));
  }
  {
    const b = build([{ id: "a", title: "Wandered", stages: null }]);
    const s = await run(b);
    check("a journey with no funnel costs no request", b.fetches.length === 0, `${b.fetches.length} requests`);
    check("…and is counted as skipped", s.skipped === 1, JSON.stringify(s));
    check("…and says nothing in the feed either", measurementNote(s) === null, String(measurementNote(s)));
  }

  console.log("\n— the feed line names each state separately —\n");
  {
    check("measured only", measurementNote({ measured: 3, belowFloor: 0, failed: 0, skipped: 0 })
      === "Product metrics: 3 measured.");
    check("below floor only", measurementNote({ measured: 0, belowFloor: 2, failed: 0, skipped: 0 })
      === "Product metrics: 2 without enough traffic to measure.");
    const mixed = measurementNote({ measured: 1, belowFloor: 1, failed: 1, skipped: 0 }) ?? "";
    check("a mixed run names all three", /1 measured/.test(mixed) && /1 without enough traffic/.test(mixed)
      && /1 we could not ask about/.test(mixed), mixed);
    check("'could not ask' is never phrased as the customer's traffic",
      !/traffic/.test("1 we could not ask about"));
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
