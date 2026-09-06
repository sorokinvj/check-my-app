// Retro sweep of published verdicts for homework (CHE-191).
//
// The gate in src/lib/verdict-language.ts stops NEW verdicts from handing the
// customer a soft imperative ("worth confirming both share flows open a
// working dialog", run #147). It does nothing for the verdicts already
// published under the old gate, which are live on customers' pages saying
// exactly that. Same shape as clean-published-verdicts.ts (CHE-92): sentence
// level, deterministic, the record corrected rather than deleted.
//
// Fields read by the customer, and what a homework-only value becomes:
//   Run.bottomLine          → the sentence cut; only homework → the bottom-line fallback
//   Finding.title           → only ever one sentence; homework → coverage title,
//                             and mark = false_positive when unmarked (CHE-92 convention:
//                             the claim itself was an ask, not a fact about the product)
//   Finding.detail (JSON)   → whatHappened / whyItMatters: sentence cut, only
//                             homework → coverage sentence; where: cut or removed;
//                             whatWeTried[]: an entry that is an ask is removed
//   Journey.summary         → sentence cut; only homework → NULL
//   Step.attempted/observed → sentence cut; only homework → the same fallbacks
//                             productizeStep uses (CHE-180)
//
// Scope: public verdicts (Run.ownerId IS NULL — reachable by anyone with the
// link) by default; --all includes owner-scoped runs, which their owners read.
//
// Data comes from D1 through wrangler, as cost-trend.mjs does:
//   npx tsx --tsconfig tsconfig.json scripts/sweep-homework.ts --dry-run          # prod, list matches
//   npx tsx --tsconfig tsconfig.json scripts/sweep-homework.ts --dry-run --all
//   npx tsx --tsconfig tsconfig.json scripts/sweep-homework.ts --apply            # prod, rewrite in place
//   npx tsx --tsconfig tsconfig.json scripts/sweep-homework.ts --dry-run --local  # the local D1
// wrangler needs a session: `wrangler login`, or CLOUDFLARE_API_TOKEN in the
// environment. Without one, export the four tables from wherever wrangler is
// logged in and point the script at the directory (--apply then prints the
// SQL instead of running it):
//   npx tsx --tsconfig tsconfig.json scripts/sweep-homework.ts --print-queries   # the four SELECTs
//   npx wrangler d1 execute checkmyapp --remote --json --command "<run SELECT>"     > /tmp/sweep/run.json
//   … likewise finding.json, journey.json, step.json …
//   npx tsx --tsconfig tsconfig.json scripts/sweep-homework.ts --dry-run --from-json /tmp/sweep

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BOTTOM_LINE_FALLBACK } from "../src/agent/synthesis";
import {
  HOMEWORK_FALLBACK,
  isHomework,
  NOT_DEFECT_FALLBACK,
  PROBLEM_FALLBACK,
  splitSentences,
  stripHomework,
  UNVERIFIABLE_FALLBACK,
} from "../src/lib/verdict-language";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DRY = args.includes("--dry-run") || !APPLY;
const ALL = args.includes("--all");
const LOCAL = args.includes("--local");
const fromJsonAt = args.indexOf("--from-json");
const FROM_JSON = fromJsonAt >= 0 ? args[fromJsonAt + 1] : null;
if (fromJsonAt >= 0 && !FROM_JSON) {
  console.error("--from-json needs a directory holding run.json, finding.json, journey.json, step.json");
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
  run: `SELECT r.id, r.runNumber, r.appSlug, r.bottomLine FROM Run r${where("r.bottomLine IS NOT NULL")}`,
  finding: `SELECT f.id, r.runNumber, f.title, f.detail, f.mark FROM Finding f JOIN Run r ON r.id = f.runId${where()}`,
  journey: `SELECT j.id, r.runNumber, j.summary FROM Journey j JOIN Run r ON r.id = j.runId${where("j.summary IS NOT NULL")}`,
  step:
    `SELECT s.id, r.runNumber, s.label, s.status, s.attempted, s.observed FROM Step s ` +
    `JOIN Journey j ON j.id = s.journeyId JOIN Run r ON r.id = j.runId${where()}`,
};

interface RunRow { id: string; runNumber: number; appSlug: string; bottomLine: string }
interface FindingRow { id: string; runNumber: number; title: string; detail: string | null; mark: string }
interface JourneyRow { id: string; runNumber: number; summary: string }
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
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-homework-"));
  const file = path.join(dir, "apply.sql");
  writeFileSync(file, sql);
  const argv = ["wrangler", "d1", "execute", "checkmyapp", LOCAL ? "--local" : "--remote", "--json", "--file", file];
  const out = execFileSync("npx", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  parseWranglerJson(out);
}

// ─── The sweep ───────────────────────────────────────────────────────────────

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const homeworkSentences = (text: string) => splitSentences(text).filter(isHomework);

interface Match { table: string; id: string; runNumber: number; field: string; sentences: string[]; before: string; after: string | null }
const matches: Match[] = [];
const sql: string[] = [];

function note(table: string, id: string, runNumber: number, field: string, before: string, after: string | null) {
  matches.push({ table, id, runNumber, field, sentences: homeworkSentences(before), before, after });
}

function sweepRuns(rows: RunRow[]) {
  for (const r of rows) {
    const hw = homeworkSentences(r.bottomLine);
    if (hw.length === 0) continue;
    const after = stripHomework(r.bottomLine, BOTTOM_LINE_FALLBACK);
    note("Run", r.id, r.runNumber, "bottomLine", r.bottomLine, after);
    sql.push(`UPDATE Run SET bottomLine = ${q(after)} WHERE id = ${q(r.id)};`);
  }
}

// A title is one sentence; when it is the ask, the CHE-92 coverage title
// replaces it and the row stops counting as a defect the owner must answer for.
const COVERAGE_TITLE = "Could not be confirmed this run";

function sweepFindings(rows: FindingRow[]) {
  for (const f of rows) {
    const sets: string[] = [];
    if (homeworkSentences(f.title).length) {
      const after = stripHomework(f.title, COVERAGE_TITLE);
      note("Finding", f.id, f.runNumber, "title", f.title, after);
      sets.push(`title = ${q(after)}`);
      if (f.mark === "none") sets.push(`mark = 'false_positive'`);
    }
    if (f.detail) {
      let d: Record<string, unknown> | null = null;
      try {
        d = JSON.parse(f.detail) as Record<string, unknown>;
      } catch {
        d = null;
      }
      if (d) {
        let touched = false;
        for (const key of ["whatHappened", "whyItMatters"] as const) {
          const v = d[key];
          if (typeof v === "string" && homeworkSentences(v).length) {
            const after = stripHomework(v, HOMEWORK_FALLBACK);
            note("Finding", f.id, f.runNumber, `detail.${key}`, v, after);
            d[key] = after;
            touched = true;
          }
        }
        if (typeof d.where === "string" && homeworkSentences(d.where).length) {
          const after = stripHomework(d.where, "");
          note("Finding", f.id, f.runNumber, "detail.where", d.where, after || null);
          if (after) d.where = after;
          else delete d.where;
          touched = true;
        }
        if (Array.isArray(d.whatWeTried)) {
          const entries = (d.whatWeTried as unknown[]).filter((x): x is string => typeof x === "string");
          const kept = entries.map((x) => (homeworkSentences(x).length ? stripHomework(x, "") : x)).filter(Boolean);
          if (kept.length !== entries.length || kept.some((x, i) => x !== entries[i])) {
            note("Finding", f.id, f.runNumber, "detail.whatWeTried", entries.join(" | "), kept.join(" | ") || null);
            d.whatWeTried = kept;
            touched = true;
          }
        }
        if (touched) sets.push(`detail = ${q(JSON.stringify(d))}`);
      }
    }
    if (sets.length) sql.push(`UPDATE Finding SET ${sets.join(", ")} WHERE id = ${q(f.id)};`);
  }
}

function sweepJourneys(rows: JourneyRow[]) {
  for (const j of rows) {
    if (!homeworkSentences(j.summary).length) continue;
    const after = stripHomework(j.summary, "");
    note("Journey", j.id, j.runNumber, "summary", j.summary, after || null);
    sql.push(`UPDATE Journey SET summary = ${after ? q(after) : "NULL"} WHERE id = ${q(j.id)};`);
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
    if (s.attempted && homeworkSentences(s.attempted).length) {
      const after = stripHomework(s.attempted, s.label);
      note("Step", s.id, s.runNumber, "attempted", s.attempted, after);
      sets.push(`attempted = ${q(after)}`);
    }
    if (s.observed && homeworkSentences(s.observed).length) {
      const after = stripHomework(s.observed, observedFallback(s.status));
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
  const runs = load<RunRow>("run");
  const findings = load<FindingRow>("finding");
  const journeys = load<JourneyRow>("journey");
  const steps = load<StepRow>("step");
  console.error(
    `-- scanned ${runs.length} bottom lines, ${findings.length} findings, ${journeys.length} journey summaries, ` +
      `${steps.length} steps (${ALL ? "all runs" : "public runs only"}${FROM_JSON ? `, from ${FROM_JSON}` : LOCAL ? ", local D1" : ", prod D1"})`,
  );

  sweepRuns(runs);
  sweepFindings(findings);
  sweepJourneys(journeys);
  sweepSteps(steps);

  for (const m of matches) {
    console.log(`\n${m.table} ${m.id} (run #${m.runNumber}) ${m.field}`);
    for (const s of m.sentences) console.log(`  homework: ${s}`);
    console.log(`  after:    ${m.after ?? "(removed)"}`);
  }
  const byTable = matches.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.table]: (acc[m.table] ?? 0) + 1 }), {});
  console.log(
    `\n-- ${matches.length} field(s) carry homework across ${new Set(matches.map((m) => `${m.table}:${m.id}`)).size} row(s)` +
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
