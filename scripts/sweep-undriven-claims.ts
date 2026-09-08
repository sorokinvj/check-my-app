// Retro sweep of stored verdict text for claims about interactions we never
// performed (CHE-215, CHE-219, CHE-214).
//
// The mechanisms shipped in #74 stop NEW text from carrying them: a finding is
// dropped by the gate, a sentence is cut from a journey summary and from the
// bottom line, and a step's own observation loses the clause when the control
// turned out to be one our hands could not drive. None of that touches what is
// already stored, which is what the owner reads today. Run #159's verdict page
// still says the credential/notes field on /check would not accept input; it
// accepts input perfectly well in a browser.
//
// Same shape as sweep-summary-voice.ts (CHE-197) and sweep-homework.ts
// (CHE-191): sentence level, deterministic, the record corrected rather than
// deleted. What decides is the same evidence the live gate uses — the machine
// action trail (Step.actions, CHE-129), written by the tools and never by the
// model — through the same two exported functions, not copies of them:
//
//   cutUndrivenClaims   decides, against the trail, whether a sentence claims
//                       one of our interactions produced nothing at a control
//                       the run never drove;
//   cutNullEffectClauses recovers what we DID see from a sentence that carries
//                       both halves ("The field is present but the input
//                       attempt did not take" keeps its first clause).
//
// Fields read by the customer, and what an unsupported claim becomes:
//   Journey.summary  → the sentence cut, judged against THAT journey's steps;
//                      nothing left → the journey's fixed sentence
//                      (summaryFallback by Journey.status), never NULL
//   Run.bottomLine   → the same, judged against the whole run's steps; nothing
//                      left → BOTTOM_LINE_FALLBACK
//   Step.observed    → with --steps only: the same, judged against its own
//                      journey's steps; nothing left → the fallbacks
//                      productizeStep uses (CHE-180)
//
// Fail-open, exactly as in the live gate: a run whose steps carry no machine
// trail is left alone. Everything before CHE-129 falls in that bucket, which is
// why the judgeable population is small and the sweep is quiet.
//
// The sweep corrects TEXT only. A step whose claim it removes keeps its stored
// status: re-adjudicating a status from outside the run would be a second
// verdict written months later, on less evidence than the run had.
//
// Scope: public verdicts (Run.ownerId IS NULL — reachable by anyone with the
// link) by default; --all includes owner-scoped runs, which their owners read.
//
// Data comes from D1 through wrangler, as sweep-summary-voice.ts does:
//   npx tsx --tsconfig tsconfig.json scripts/sweep-undriven-claims.ts --dry-run
//   npx tsx --tsconfig tsconfig.json scripts/sweep-undriven-claims.ts --dry-run --all
//   npx tsx --tsconfig tsconfig.json scripts/sweep-undriven-claims.ts --dry-run --all --steps
//   npx tsx --tsconfig tsconfig.json scripts/sweep-undriven-claims.ts --apply --all --steps
//   npx tsx --tsconfig tsconfig.json scripts/sweep-undriven-claims.ts --dry-run --local
// wrangler needs a session: `wrangler login`, or CLOUDFLARE_API_TOKEN in the
// environment. Without one, export the tables from wherever wrangler is logged
// in and point the script at the directory (--apply then prints the SQL):
//   npx tsx --tsconfig tsconfig.json scripts/sweep-undriven-claims.ts --print-queries
//   npx wrangler d1 execute checkmyapp --remote --json --command "<step SELECT>" > /tmp/sweep/step.json
//   npx tsx --tsconfig tsconfig.json scripts/sweep-undriven-claims.ts --dry-run --from-json /tmp/sweep

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cutNullEffectClauses,
  cutUndrivenClaims,
  type GateJourney,
  type GateStep,
} from "../src/agent/findings-gate";
import { BOTTOM_LINE_FALLBACK } from "../src/agent/synthesis";
import {
  NOT_DEFECT_FALLBACK,
  PROBLEM_FALLBACK,
  splitSentences,
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
  console.error("--from-json needs a directory holding run.json, journey.json and step.json");
  process.exit(2);
}

// The owner filter is the only thing that changes between --all and default,
// and it is a fixed string, never an input.
const SCOPE = ALL ? "" : "r.ownerId IS NULL";
const where = (extra?: string) => {
  const parts = [SCOPE, extra].filter(Boolean);
  return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
};
// Step rows are loaded whatever the flags: they ARE the trail every judgement
// below rests on. --steps only decides whether their own observed text is
// swept too.
const QUERIES = {
  run: `SELECT r.id, r.runNumber, r.bottomLine FROM Run r${where("r.bottomLine IS NOT NULL")}`,
  journey: `SELECT j.id, j.runId, r.runNumber, j.status, j.summary FROM Journey j JOIN Run r ON r.id = j.runId${where("j.summary IS NOT NULL")}`,
  step:
    `SELECT s.id, j.id AS journeyId, j.runId, r.runNumber, s.status, s.unverifiedReason, s.label, s.observed, s.attempted, s.actions ` +
    `FROM Step s JOIN Journey j ON j.id = s.journeyId JOIN Run r ON r.id = j.runId${where()}`,
};

interface RunRow { id: string; runNumber: number; bottomLine: string }
interface JourneyRow { id: string; runId: string; runNumber: number; status: string; summary: string }
interface StepRow {
  id: string;
  journeyId: string;
  runId: string;
  runNumber: number;
  status: string;
  unverifiedReason: string | null;
  label: string;
  observed: string | null;
  attempted: string | null;
  actions: string | null;
}

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
  const dir = mkdtempSync(path.join(tmpdir(), "sweep-undriven-claims-"));
  const file = path.join(dir, "apply.sql");
  writeFileSync(file, sql);
  const argv = ["wrangler", "d1", "execute", "checkmyapp", LOCAL ? "--local" : "--remote", "--json", "--file", file];
  const out = execFileSync("npx", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  parseWranglerJson(out);
}

// ─── The sweep ───────────────────────────────────────────────────────────────

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const toGateStep = (s: StepRow): GateStep => ({
  status: s.status,
  unverifiedReason: s.unverifiedReason,
  label: s.label,
  observed: s.observed,
  attempted: s.attempted,
  actions: s.actions,
});

// One field, judged sentence by sentence against the steps it belongs to.
//
// Both live functions do the work and neither is reimplemented:
// cutUndrivenClaims answers "is this sentence unsupported by the trail", and
// where it is, cutNullEffectClauses recovers the half of it that was an
// observation. Feeding one sentence at a time is what lets the second run only
// on sentences the first condemned — a sentence whose claim the trail DOES
// support keeps its wording untouched.
function sweepText(text: string, steps: GateStep[], fallback: string): { after: string; cut: string[] } | null {
  const journeys: GateJourney[] = [{ steps }];
  const kept: string[] = [];
  const cut: string[] = [];
  for (const sentence of splitSentences(text)) {
    const verdict = cutUndrivenClaims(sentence, journeys);
    if (verdict.cut.length === 0) {
      kept.push(sentence.trim());
      continue;
    }
    cut.push(...verdict.cut);
    // What we actually saw, where the sentence carried both halves.
    const salvaged = cutNullEffectClauses(sentence).text;
    if (salvaged) kept.push(salvaged.trim());
  }
  if (cut.length === 0) return null;
  const after = kept.join(" ").replace(/\s+/g, " ").trim();
  return { after: after.length > 0 ? after : fallback, cut };
}

interface Match { table: string; id: string; runNumber: number; field: string; cut: string[]; before: string; after: string }
const matches: Match[] = [];
const sql: string[] = [];

function note(table: string, id: string, runNumber: number, field: string, before: string, after: string, cut: string[]) {
  matches.push({ table, id, runNumber, field, cut, before, after });
}

// The same stand-ins productizeStep writes for a step whose words were all
// about us (CHE-180): coverage when skipped, the judge's sentence when ok, the
// problem sentence otherwise.
function observedFallback(status: string): string {
  if (status === "skipped") return UNVERIFIABLE_FALLBACK;
  if (status === "ok") return NOT_DEFECT_FALLBACK;
  return PROBLEM_FALLBACK;
}

function main() {
  if (args.includes("--print-queries")) {
    for (const [table, select] of Object.entries(QUERIES)) console.log(`${table}.json:\n  ${select}\n`);
    return;
  }
  const runs = load<RunRow>("run");
  const journeys = load<JourneyRow>("journey");
  const steps = load<StepRow>("step");

  const byRun = new Map<string, GateStep[]>();
  const byJourney = new Map<string, GateStep[]>();
  for (const s of steps) {
    const gate = toGateStep(s);
    if (!byRun.has(s.runId)) byRun.set(s.runId, []);
    if (!byJourney.has(s.journeyId)) byJourney.set(s.journeyId, []);
    byRun.get(s.runId)!.push(gate);
    byJourney.get(s.journeyId)!.push(gate);
  }

  console.error(
    `-- scanned ${runs.length} bottom line(s), ${journeys.length} journey summaries` +
      `${STEPS ? `, ${steps.length} step observations` : ""} over ${steps.length} step row(s) of trail ` +
      `(${ALL ? "all runs" : "public runs only"}${FROM_JSON ? `, from ${FROM_JSON}` : LOCAL ? ", local D1" : ", prod D1"})`,
  );

  for (const r of runs) {
    const swept = sweepText(r.bottomLine, byRun.get(r.id) ?? [], BOTTOM_LINE_FALLBACK);
    if (!swept) continue;
    note("Run", r.id, r.runNumber, "bottomLine", r.bottomLine, swept.after, swept.cut);
    sql.push(`UPDATE Run SET bottomLine = ${q(swept.after)} WHERE id = ${q(r.id)};`);
  }

  for (const j of journeys) {
    const swept = sweepText(j.summary, byJourney.get(j.id) ?? [], summaryFallback(j.status));
    if (!swept) continue;
    note("Journey", j.id, j.runNumber, "summary", j.summary, swept.after, swept.cut);
    sql.push(`UPDATE Journey SET summary = ${q(swept.after)} WHERE id = ${q(j.id)};`);
  }

  if (STEPS) {
    for (const s of steps) {
      if (!s.observed) continue;
      const swept = sweepText(s.observed, byJourney.get(s.journeyId) ?? [], observedFallback(s.status));
      if (!swept) continue;
      note("Step", s.id, s.runNumber, "observed", s.observed, swept.after, swept.cut);
      sql.push(`UPDATE Step SET observed = ${q(swept.after)} WHERE id = ${q(s.id)};`);
    }
  }

  for (const m of matches) {
    console.log(`\n${m.table} ${m.id} (run #${m.runNumber}) ${m.field}`);
    for (const c of m.cut) console.log(`  claim:  ${c}`);
    console.log(`  after:  ${m.after}`);
  }
  const byTable = matches.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.table]: (acc[m.table] ?? 0) + 1 }), {});
  console.log(
    `\n-- ${matches.length} field(s) claim an interaction the run never performed across ` +
      `${new Set(matches.map((m) => `${m.table}:${m.id}`)).size} row(s)` +
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
