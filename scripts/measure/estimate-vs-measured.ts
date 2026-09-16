// CHE-244: how far is our opinion from their measurement?
//
// The question the project stands or falls on. We tell owners a journey
// converts 45 of 100. Their analytics say 12%. If we are consistently thirty
// points optimistic, that is not a rubric — it is a bias, and the guide
// (.claude/skills/journey-metrics) should get its anchors corrected from this
// data rather than from taste.
//
// Reads a D1 dump on stdin so it holds no credentials and can be pointed at any
// environment:
//
//   wrangler d1 execute checkmyapp --remote --json --command "
//     SELECT aj.title AS title, a.appSlug AS appSlug,
//            aj.conversion AS ours, aj.funnelStages AS stages, aj.funnelRefusal AS refusal,
//            p.conversion AS measured, p.sampleSize AS sample, p.windowDays AS windowDays
//     FROM AppJourney aj
//     JOIN App a ON aj.appId = a.id
//     LEFT JOIN JourneyMetricPoint p ON p.id = (
//       SELECT id FROM JourneyMetricPoint WHERE appJourneyId = aj.id
//       ORDER BY measuredAt DESC LIMIT 1)
//     WHERE aj.retiredAt IS NULL" \
//   | npx tsx --tsconfig tsconfig.json scripts/measure/estimate-vs-measured.ts
//
// Two directions matter differently, and the report separates them:
//
//   we said LOW, they measured HIGH  — we are pessimistic about flows real
//                                       users are used to. Cheap to be wrong.
//   we said FINE, nobody finishes    — the expensive direction: we told an
//                                       owner a flow was healthy and it is not.

interface Row {
  title: string;
  appSlug: string;
  ours: number | null;
  stages: string | null;
  refusal: string | null;
  measured: number | null;
  sample: number | null;
  windowDays: number | null;
}

function read(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

async function main() {
  const raw = await read();
  const rows = (JSON.parse(raw) as Array<{ results?: Row[] }>).flatMap((p) => p.results ?? []);
  if (rows.length === 0) {
    console.log("no journeys found");
    return;
  }

  const comparable = rows.filter((r) => r.ours !== null && r.measured !== null);

  console.log(`journeys: ${rows.length}`);
  console.log(`  with our estimate:      ${rows.filter((r) => r.ours !== null).length}`);
  console.log(`  with a measurement:     ${rows.filter((r) => r.measured !== null).length}`);
  console.log(`  comparable (both):      ${comparable.length}`);

  // The coverage question the ticket asks: how many could be measured at all,
  // and why the rest could not. Every "could not" is a ticket on our board.
  const byRefusal = new Map<string, number>();
  for (const r of rows.filter((x) => x.measured === null)) {
    const why = r.refusal ?? (r.stages ? "no point measured yet" : "no funnel derived");
    byRefusal.set(why, (byRefusal.get(why) ?? 0) + 1);
  }
  if (byRefusal.size) {
    console.log("\nwhy the rest could not be measured — each of these is ours, not a caveat:");
    for (const [why, n] of [...byRefusal].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${why}`);
    }
  }

  if (comparable.length === 0) {
    console.log("\nNothing comparable yet — connect analytics and let a check run.");
    return;
  }

  console.log(`\n${pad("journey", 44)} ${pad("app", 18)}  ours  measured  sample   gap`);
  const gaps: number[] = [];
  for (const r of comparable.sort((a, b) => a.measured! - a.ours! - (b.measured! - b.ours!))) {
    const gap = r.measured! - r.ours!;
    gaps.push(gap);
    const flag = r.ours! >= 50 && r.measured! < 20 ? "  ← we called this fine" : "";
    console.log(
      `${pad(r.title, 44)} ${pad(r.appSlug, 18)}  ${String(r.ours).padStart(4)}  ` +
        `${String(r.measured).padStart(8)}  ${String(r.sample ?? "-").padStart(6)}  ` +
        `${(gap > 0 ? "+" : "") + gap.toFixed(0)}${flag}`,
    );
  }

  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const optimistic = gaps.filter((g) => g < 0).length;

  console.log(`\nmean gap (measured − ours):   ${mean > 0 ? "+" : ""}${mean.toFixed(1)} points`);
  console.log(`median gap:                    ${median > 0 ? "+" : ""}${median.toFixed(1)} points`);
  console.log(`we were optimistic on:         ${optimistic}/${gaps.length}`);

  // The verdict the ticket asks for, stated rather than left to the reader.
  console.log("");
  if (comparable.length < 5) {
    console.log(`VERDICT: not enough comparable journeys (${comparable.length}) to call the rubric biased.`);
    console.log("         A direction from three journeys is a direction from three journeys.");
  } else if (Math.abs(mean) < 10) {
    console.log(`VERDICT: no systematic bias — mean gap ${mean.toFixed(1)} points. The rubric stands.`);
  } else if (mean < 0) {
    console.log(`VERDICT: the rubric is OPTIMISTIC by ${Math.abs(mean).toFixed(0)} points on average.`);
    console.log("         This is the expensive direction: we tell owners flows are healthier than");
    console.log("         they are. Correct the anchors in .claude/skills/journey-metrics downward.");
  } else {
    console.log(`VERDICT: the rubric is PESSIMISTIC by ${mean.toFixed(0)} points on average.`);
    console.log("         Cheaper to be wrong this way, but still wrong — real users are more used");
    console.log("         to these flows than we assume. Correct the anchors upward.");
  }
}

void main();
