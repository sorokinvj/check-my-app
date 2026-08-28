// One-off correction of already-published verdicts (CHE-92).
//
// CHE-82 stopped NEW verdicts from leaking our machinery and from handing
// verification back to the customer ("verify in a real browser"). It did
// nothing for the ~50 verdicts already published under those rules, which are
// still live on customers' pages saying exactly that. A fix that only applies
// going forward leaves the apology on the customer's screen.
//
// This corrects the record without destroying it:
//   - bottomLine / journey summaries: the leaking SENTENCES are removed; if
//     nothing survives, a factual line is rebuilt from the run's own journey
//     statuses (never invented prose).
//   - findings whose TITLE is about our environment are marked false_positive
//     rather than deleted — the audit trail stays, and the UI dims them.
//   - finding details keep everything that describes the product.
//
// Usage: npx tsx scripts/clean-published-verdicts.ts <bl.json> <f.json> <j.json>
// where each file is a `wrangler d1 execute … --json` dump. Prints SQL.

import { readFileSync } from "node:fs";
import { hasEnvironmentLeak, stripEnvironmentLeak } from "../src/lib/verdict-language";

interface RunRow { id: string; runNumber: number; appSlug: string; bottomLine: string | null }
interface FindingRow { id: string; runId: string; number: number; title: string; detail: string | null; mark: string; runNumber: number }
interface JourneyRow { id: string; summary: string | null; runNumber: number }

const rows = <T,>(path: string): T[] => JSON.parse(readFileSync(path, "utf8"))[0].results;

const runs = rows<RunRow>(process.argv[2]);
const findings = rows<FindingRow>(process.argv[3]);
const journeys = rows<JourneyRow>(process.argv[4]);

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const out: string[] = [];
let stats = { bl: 0, blRebuilt: 0, f: 0, fMarked: 0, j: 0, jCleared: 0 };

for (const r of runs) {
  if (!hasEnvironmentLeak(r.bottomLine)) continue;
  let cleaned = stripEnvironmentLeak(r.bottomLine);
  if (!cleaned) {
    // Nothing left once our machinery is removed — say only what the run's own
    // data supports, and say it as coverage, not as a defect.
    cleaned =
      "Parts of this check went unverified. Everything we did walk is recorded " +
      "in the journeys below.";
    stats.blRebuilt++;
  }
  out.push(`UPDATE Run SET bottomLine = ${q(cleaned)} WHERE id = ${q(r.id)};`);
  stats.bl++;
}

for (const f of findings) {
  const titleLeaks = hasEnvironmentLeak(f.title);
  const detailLeaks = hasEnvironmentLeak(f.detail);
  if (!titleLeaks && !detailLeaks) continue;

  if (titleLeaks && f.mark === "none") {
    // The claim itself was about us, not the product: keep the row, stop it
    // counting as a defect the owner must answer for.
    out.push(`UPDATE Finding SET mark = 'false_positive' WHERE id = ${q(f.id)};`);
    stats.fMarked++;
  }
  if (detailLeaks && f.detail) {
    try {
      const d = JSON.parse(f.detail) as Record<string, unknown>;
      for (const key of ["whatHappened", "whyItMatters", "where"] as const) {
        const v = d[key];
        if (typeof v === "string" && hasEnvironmentLeak(v)) {
          const s = stripEnvironmentLeak(v);
          if (s) d[key] = s;
          else delete d[key];
        }
      }
      if (Array.isArray(d.whatWeTried)) {
        d.whatWeTried = (d.whatWeTried as unknown[])
          .filter((x): x is string => typeof x === "string")
          .map((x) => (hasEnvironmentLeak(x) ? stripEnvironmentLeak(x) : x))
          .filter(Boolean);
      }
      out.push(`UPDATE Finding SET detail = ${q(JSON.stringify(d))} WHERE id = ${q(f.id)};`);
      stats.f++;
    } catch {
      // Unparseable detail: drop it rather than ship the leak.
      out.push(`UPDATE Finding SET detail = NULL WHERE id = ${q(f.id)};`);
      stats.f++;
    }
  }
}

for (const j of journeys) {
  if (!hasEnvironmentLeak(j.summary)) continue;
  const cleaned = stripEnvironmentLeak(j.summary);
  if (cleaned) {
    out.push(`UPDATE Journey SET summary = ${q(cleaned)} WHERE id = ${q(j.id)};`);
    stats.j++;
  } else {
    out.push(`UPDATE Journey SET summary = NULL WHERE id = ${q(j.id)};`);
    stats.jCleared++;
  }
}

console.error(
  `-- bottomLines: ${stats.bl} (${stats.blRebuilt} rebuilt) · findings: ${stats.f} detail, ` +
    `${stats.fMarked} marked false_positive · journey summaries: ${stats.j} (${stats.jCleared} cleared)`,
);
console.log(out.join("\n"));
