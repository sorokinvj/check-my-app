// Retro sweep of stored journey summaries for the walker's voice (CHE-197).
//
// The mechanism in src/lib/verdict-language.ts (stripNarration, run by
// productProse) stops NEW summaries from carrying the model's wrap-up
// envelope ("Journey complete. No records were created; nothing to clean up.
// Summary: …") and its first-person walk narration ("During the walkthrough,
// I signed in …", "… all playable via oEmbed"). It does nothing for the
// summaries already stored, which their owners read under "What we found".
// Same shape as sweep-homework.ts (CHE-191): sentence level, deterministic,
// the record corrected rather than deleted.
//
// Fields read by the customer, and what a walker-only value becomes:
//   Journey.summary          → envelope unwrapped, narration cut; only the
//                              walker → the journey's fixed sentence
//                              (summaryFallback by Journey.status), never NULL
//   Step.label/attempted/    → with --steps only: the same cut; only the
//   observed                   walker → the same fallbacks productizeStep
//                              uses (CHE-180)
//
// Scope: public verdicts (Run.ownerId IS NULL — reachable by anyone with the
// link) by default; --all includes owner-scoped runs, which their owners read.
//
// Data comes from D1 through wrangler, as sweep-homework.ts does:
//   npx tsx --tsconfig tsconfig.json scripts/sweep-summary-voice.ts --dry-run          # prod, list matches
//   npx tsx --tsconfig tsconfig.json scripts/sweep-summary-voice.ts --dry-run --all
//   npx tsx --tsconfig tsconfig.json scripts/sweep-summary-voice.ts --dry-run --all --steps
//   npx tsx --tsconfig tsconfig.json scripts/sweep-summary-voice.ts --apply            # prod, rewrite in place
//   npx tsx --tsconfig tsconfig.json scripts/sweep-summary-voice.ts --dry-run --local  # the local D1
// wrangler needs a session: `wrangler login`, or CLOUDFLARE_API_TOKEN in the
// environment. Without one, export the tables from wherever wrangler is
// logged in and point the script at the directory (--apply then prints the
// SQL instead of running it):
//   npx tsx --tsconfig tsconfig.json scripts/sweep-summary-voice.ts --print-queries
//   npx wrangler d1 execute checkmyapp --remote --json --command "<journey SELECT>" > /tmp/sweep/journey.json
//   npx tsx --tsconfig tsconfig.json scripts/sweep-summary-voice.ts --dry-run --from-json /tmp/sweep

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hasNarration,
  narrationIn,
  NOT_DEFECT_FALLBACK,
  PROBLEM_FALLBACK,
  stripNarration,
  summaryFallback,
  UNVERIFIABLE_FALLBACK,
} from "../src/lib/verdict-language";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DRY = args.includes("--dry-run") || !APPLY;
const ALL = args.includes("--all");
const LOCAL = args.includes("--local");
const STEPS = args.includes("--steps");
const fromJsonAt = args.indexOf("--from-json");
const FROM_JSON = fromJsonAt >= 0 ? args[fromJsonAt + 1] : null;
if (fromJsonAt >= 0 && !FROM_JSON) {
  console.error("--from-json needs a directory holding journey.json (and step.json with --steps)");
  process.exit(2);
}

// The owner filter is the only thing that changes between --all and default,
// and it is a fixed string, never an input.
const SCOPE = ALL ? "" : "r.ownerId IS NULL";
const where = (extra?: string) => {
  const parts = [SCOPE, extra].filter(Boolean);
  return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
};
const QUERIES = {
  journey: `SELECT j.id, r.runNumber, j.status, j.summary FROM Journey j JOIN Run r ON r.id = j.runId${where("j.summary IS NOT NULL")}`,
  step:
    `SELECT s.id, r.runNumber, s.label, s.status, s.attempted, s.observed FROM Step s ` +
    `JOIN Journey j ON j.id = s.journeyId JOIN Run r ON r.id = j.runId${where()}`,
};

interface JourneyRow { id: string; runNumber: number; status: string; summary: string }
interface StepRow { id: string; runNumber: number; label: string; status: string; attempted: string | null; observed: string | null }

// ─── D1 access ───────────────────────────────────────────────────────────────

function d1Json(sql: string): unknown[] {
  const argv = ["wrangler", "d1", "execute", "checkmyapp", LOCAL ? "--local" : "--remote", "--json", "--command", sql];
  let out: string;
  try {
    out = execFileSync("npx", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`wrangler d1 execute failed: ${(e.stdout || "").trim() || (e.stderr || "").trim() || e.message}`);
  }
  return parseWranglerJson(out);
}

// Update nags and warnings can precede the JSON; the payload starts at the
// first bracket.
function parseWranglerJson(out: string): unknown[] {
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`no JSON in wrangler output: ${out.slice(0, 200)}`);
  const parsed = JSON.parse(out.slice(start)) as Array<{ success?: boolean; results?: unknown[] }>;
  const first = parsed[0];
  if (!first || first.success === false) throw new Error(`query failed: ${JSON.stringify(first ?? parsed).slice(0, 300)}`);
  return first.results ?? [];
}

function load<T>(table: keyof typeof QUERIES): T[] {
  if (FROM_JSON) return parseWranglerJson(readFileSync(path.join(FROM_JSON, `${table}.json`), "utf8")) as T[];
  return d1Json(QUERIES[table]) as T[];
}

function d1Apply(sql: string): void {
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-summary-voice-"));
  const file = path.join(dir, "apply.sql");
  writeFileSync(file, sql);
  const argv = ["wrangler", "d1", "execute", "checkmyapp", LOCAL ? "--local" : "--remote", "--json", "--file", file];
  const out = execFileSync("npx", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  parseWranglerJson(out);
}

// ─── The sweep ───────────────────────────────────────────────────────────────

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface Match { table: string; id: string; runNumber: number; field: string; sentences: string[]; before: string; after: string }
const matches: Match[] = [];
const sql: string[] = [];

function note(table: string, id: string, runNumber: number, field: string, before: string, after: string) {
  matches.push({ table, id, runNumber, field, sentences: narrationIn(before), before, after });
}

function sweepJourneys(rows: JourneyRow[]) {
  for (const j of rows) {
    if (!hasNarration(j.summary)) continue;
    const after = stripNarration(j.summary, summaryFallback(j.status));
    note("Journey", j.id, j.runNumber, "summary", j.summary, after);
    sql.push(`UPDATE Journey SET summary = ${q(after)} WHERE id = ${q(j.id)};`);
  }
}

// The same stand-ins productizeStep writes for a step whose words were all
// about us (CHE-180): the label for attempted; for observed, coverage when
// skipped, the judge's sentence when ok, the problem sentence otherwise.
function observedFallback(status: string): string {
  if (status === "skipped") return UNVERIFIABLE_FALLBACK;
  if (status === "ok") return NOT_DEFECT_FALLBACK;
  return PROBLEM_FALLBACK;
}

function sweepSteps(rows: StepRow[]) {
  for (const s of rows) {
    const sets: string[] = [];
    if (hasNarration(s.label)) {
      const after = stripNarration(s.label, s.label);
      note("Step", s.id, s.runNumber, "label", s.label, after);
      sets.push(`label = ${q(after)}`);
    }
    if (s.attempted && hasNarration(s.attempted)) {
      const after = stripNarration(s.attempted, s.label);
      note("Step", s.id, s.runNumber, "attempted", s.attempted, after);
      sets.push(`attempted = ${q(after)}`);
    }
    if (s.observed && hasNarration(s.observed)) {
      const after = stripNarration(s.observed, observedFallback(s.status));
      note("Step", s.id, s.runNumber, "observed", s.observed, after);
      sets.push(`observed = ${q(after)}`);
    }
    if (sets.length) sql.push(`UPDATE Step SET ${sets.join(", ")} WHERE id = ${q(s.id)};`);
  }
}

function main() {
  if (args.includes("--print-queries")) {
    for (const [table, select] of Object.entries(QUERIES)) console.log(`${table}.json:\n  ${select}\n`);
    return;
  }
  const journeys = load<JourneyRow>("journey");
  const steps = STEPS ? load<StepRow>("step") : [];
  console.error(
    `-- scanned ${journeys.length} journey summaries${STEPS ? `, ${steps.length} steps` : ""} ` +
      `(${ALL ? "all runs" : "public runs only"}${FROM_JSON ? `, from ${FROM_JSON}` : LOCAL ? ", local D1" : ", prod D1"})`,
  );

  sweepJourneys(journeys);
  if (STEPS) sweepSteps(steps);

  for (const m of matches) {
    console.log(`\n${m.table} ${m.id} (run #${m.runNumber}) ${m.field}`);
    for (const s of m.sentences) console.log(`  walker: ${s}`);
    console.log(`  after:  ${m.after}`);
  }
  const byTable = matches.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.table]: (acc[m.table] ?? 0) + 1 }), {});
  console.log(
    `\n-- ${matches.length} field(s) carry the walker's voice across ${new Set(matches.map((m) => `${m.table}:${m.id}`)).size} row(s)` +
      ` — ${Object.entries(byTable).map(([t, n]) => `${t}: ${n}`).join(", ") || "none"}; ${sql.length} UPDATE statement(s)`,
  );

  if (DRY || sql.length === 0) {
    if (!DRY) console.log("-- nothing to apply");
    return;
  }
  if (FROM_JSON) {
    console.log("\n-- --apply with --from-json: no connection, SQL follows\n");
    console.log(sql.join("\n"));
    return;
  }
  d1Apply(sql.join("\n"));
  console.log(`-- applied ${sql.length} statement(s) to ${LOCAL ? "local" : "prod"} D1`);
}

main();
