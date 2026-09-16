// One-off probe (CHE-238): what does the funnel derivation say about EVERY
// journey production has ever recorded actions for?
//
// The derivation was written against three real walks. Three is enough to catch
// a design error and nowhere near enough to trust a distribution. This runs it
// over the whole corpus and prints what comes out, so the refusal rate is a
// measured number rather than a hope — and so a refusal that turns out to be
// the common case gets noticed here rather than as a flood of gap tickets.
//
// Read-only. Takes a JSON dump on stdin rather than talking to D1 itself, so it
// can be run against a dump taken with wrangler without holding credentials.
//
// Usage:
//   wrangler d1 execute checkmyapp --remote --json --command "<see below>" \
//     | npx tsx --tsconfig tsconfig.json scripts/probe-funnels.ts

import { deriveFunnel, pagesWalked, refusalReason, type FunnelRefusal } from "@/lib/funnel";

interface Row {
  jid: string;
  title: string;
  appSlug: string;
  actions: string;
}

function read(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
}

async function main() {
  const raw = await read();
  const parsed = JSON.parse(raw) as Array<{ results?: Row[] }>;
  const rows = parsed.flatMap((p) => p.results ?? []);

  // Rows arrive one per STEP; a journey's trail is all of its steps in order.
  const byJourney = new Map<string, { title: string; appSlug: string; actions: unknown[] }>();
  for (const r of rows) {
    const entry = byJourney.get(r.jid) ?? { title: r.title, appSlug: r.appSlug, actions: [] };
    try {
      const parsedActions = JSON.parse(r.actions) as unknown[];
      if (Array.isArray(parsedActions)) entry.actions.push(...parsedActions);
    } catch {
      // A trail we cannot parse is not a trail. Counted below as no_pages.
    }
    byJourney.set(r.jid, entry);
  }

  let funnels = 0;
  const refusals: Record<string, number> = {};
  const stageCounts: number[] = [];
  const examples: string[] = [];

  for (const [jid, j] of byJourney) {
    const f = deriveFunnel(j.actions as Array<{ outcome?: { urlAfter?: string | null } }>);
    if (f.ok) {
      funnels++;
      stageCounts.push(f.stages.length);
      if (examples.length < 12) {
        examples.push(`  ✓ ${j.appSlug} · ${j.title.slice(0, 44)}\n      ${f.stages.join(" → ")}`);
      }
    } else {
      refusals[f.refusal] = (refusals[f.refusal] ?? 0) + 1;
      if (examples.length < 12) {
        examples.push(
          `  ✗ ${j.appSlug} · ${j.title.slice(0, 44)}\n      ${f.refusal}: ${pagesWalked(
            j.actions as Array<{ outcome?: { urlAfter?: string | null } }>,
          ).slice(0, 8).join(" → ")}`,
        );
      }
    }
    void jid;
  }

  const total = byJourney.size;
  console.log(`journeys with a recorded trail: ${total}`);
  console.log(`funnels derived:                ${funnels}  (${total ? Math.round((funnels / total) * 100) : 0}%)`);
  if (stageCounts.length) {
    const sorted = [...stageCounts].sort((a, b) => a - b);
    console.log(`stages per funnel:              min ${sorted[0]} · median ${sorted[Math.floor(sorted.length / 2)]} · max ${sorted[sorted.length - 1]}`);
  }
  console.log("refusals:");
  for (const [r, n] of Object.entries(refusals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${r} — ${refusalReason(r as FunnelRefusal)}`);
  }
  console.log("\nexamples:");
  console.log(examples.join("\n"));
}

void main();
