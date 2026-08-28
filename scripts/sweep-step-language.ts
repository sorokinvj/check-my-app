// Final sweep of published step text (CHE-92).
//
// Step.attempted / Step.observed are customer-visible the moment a step is
// expanded on the verdict page, and historical runs are full of "produced zero
// requests in our test browser". Sentence-level strip, deterministic: whatever
// describes the product survives, whatever describes our machinery goes.
//
// "Playwright" is deliberately NOT swept: CheckMyApp generates Playwright specs
// as a product feature, so on our own verdicts the word is legitimate product
// vocabulary rather than a leak.
//
// Usage: npx tsx scripts/sweep-step-language.ts <steps.json>

import { readFileSync } from "node:fs";

interface Row { id: string; attempted: string | null; observed: string | null }

const LEAK = /(test browser|headless|real browsers?|our (browser|environment|harness|automation)|browser rendering|spot-?check|before treating it as broken)/i;

function strip(text: string | null): string | null | undefined {
  if (!text || !LEAK.test(text)) return undefined; // untouched
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !LEAK.test(s))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return kept.length >= 15 ? kept : null;
}

const rows: Row[] = JSON.parse(readFileSync(process.argv[2], "utf8"))[0].results;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
let touched = 0;

for (const r of rows) {
  const a = strip(r.attempted);
  const o = strip(r.observed);
  const sets: string[] = [];
  if (a !== undefined) sets.push(`attempted = ${a === null ? "NULL" : q(a)}`);
  if (o !== undefined) {
    // A step whose whole observation was about us keeps an honest stub rather
    // than an empty panel.
    sets.push(`observed = ${o === null ? q("Could not be confirmed this run.") : q(o)}`);
  }
  if (sets.length) {
    console.log(`UPDATE Step SET ${sets.join(", ")} WHERE id = ${q(r.id)};`);
    touched++;
  }
}
console.error(`-- ${touched} steps rewritten of ${rows.length} scanned`);
