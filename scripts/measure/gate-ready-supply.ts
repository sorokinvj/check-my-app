// Ticket supply (CHE-149): how many machine-gateable findings does CheckMyApp
// produce per observed app per week?
//
// scripts/measure/ is for numbers about the business rather than checks on the
// code: each file answers one question that gets recomputed later and compared
// against its own earlier answer, so the question, the criterion and the query
// have to travel together in one file.
//
// The cost of an automatic fix is measured ($0.48 per green PR, CHE-13x). What
// is not measured is where the tickets come from. The M1 report found three
// tickets of the right shape, not thirty — and the open question is whether
// that was a selection artefact or the actual rate at which an app produces
// work a machine can pick up. If an app yields two a week, the constraint on
// the product is raw material, not price and not model quality.
//
// Reads production through the wrangler CLI and writes nothing — not to D1, not
// anywhere else; d1() below refuses any statement that is not a SELECT.
//
// Credentials come from wrangler's own resolution, which in this repo means
// CLOUDFLARE_API_TOKEN out of the untracked .env. A git worktree does not have
// that file, so run it from a checkout that does, or export the token first:
// there is deliberately no credential path of this script's own.
//
// Usage:
//   npm run supply                          # Markdown to stdout, last 30 days
//   npm run supply -- --since 2026-08-04 --until 2026-09-04
//   npm run supply -- --list                # every finding that cleared G1, with its verdict
//   npm run supply -- --list all            # every finding in the window
//   npm run supply -- --local               # the local D1 replica instead of prod
//   npx tsx --tsconfig tsconfig.json scripts/measure/gate-ready-supply.ts --json
//
// ─── Recounting this, and what makes a recount comparable ────────────────────
//
// The number is meant to be recomputed and compared, and the fragile part is
// not the SQL — it is the criterion below. Two people counting "tickets a
// machine could take to a decision" will count different things unless the
// definition is one artefact with the query. That is why it lives in this file
// and not in a report: a later recount that quietly used a different rule would
// show a difference and it would be attributed to the business.
//
// So: recount by running the command, not by rewriting the rule. If the rule
// has to change, change it here, say so in the commit, and re-run the OLD
// window too — a rule change and a business change must never arrive as one
// number.
//
//   npm run supply -- --since <same start> --until <new end>
//
// BASELINE, measured 2026-09-04 over the window 2026-08-04 → 2026-09-04:
//
//   customer apps under continuous observation:   2 (joblander.app, meetbashar.com)
//   app-weeks of observation:                     3.9
//   gate-ready tickets (G1 ∧ G2 ∧ G3):            3   → 0.78 per app per week
//   evidence tier (G2 ∧ G3, label ignored):       4   → 1.04 per app per week
//   our own product (checkmyapp.dev, separate):   1 gate-ready over 2.6 app-weeks
//   raw customer findings that window:            178 → 3 distinct tickets (1.7%)
//
// Both observed apps belong to the owner; there is no external customer in that
// sample. The number is an observation of two apps, not an estimate of a fleet,
// and a recount that adds a third app changes what it is measuring.
//
// ─── What counts as gate-ready ───────────────────────────────────────────────
//
// A gate-ready finding is one whose outcome a machine can settle on its own:
// a symptom, a reproduction, and an unambiguous sign that it is gone. Three
// conditions, each read off a column rather than judged:
//
//   G1 symptom — the finding qualifies for a ticket at all: category broken or
//      exposed, or severity high. This is `qualifies()` from src/agent/autofile.ts
//      verbatim; reusing it keeps this number consistent with what a customer
//      actually receives. "confusing" and "polish" are judgements with no
//      machine pass/fail, which is exactly why autofile never files them.
//
//   G2 not ours, not disproved — mark is not false_positive, and the finding's
//      dedup signature has not been settled as suppressed (owner ruled
//      not-a-bug, CLAUDE.md §8). Checker gaps and checker defects never appear
//      here at all: they are filed straight to the tracker from
//      capability-gaps.ts and have no Finding row.
//
//   G3 machine-checkable disappearance — requestSignature() (src/lib/dedup.ts)
//      finds a METHOD /path plus a 4xx/5xx status in the finding's own text.
//      That is the whole condition: when the identity of the problem is a
//      machine fact, "fixed" means that request no longer returns that status,
//      and a gate can decide it without a model and without a person.
//
// Findings passing G1 ∧ G2 but not G3 are counted separately as "prose-only":
// a real problem with a described reproduction, but one whose disappearance
// still needs a walk or a person to judge.
//
// Not used as a condition: Step.actions, the replayable action list (CHE-129).
// It is populated on a handful of steps so far, so requiring it would measure
// how recently we started recording actions, not how much raw material exists.
// The report prints its coverage so the omission stays visible.
//
// Counting is by DISTINCT dedup key, using dedupKeyForFinding() — the same
// identity autofile uses. One endpoint failing on ten consecutive daily runs is
// one ticket, not ten, and the supply question is about tickets.

import { execFileSync } from "node:child_process";
import { requestSignature } from "../../src/lib/dedup";
import { dedupKeyForFinding } from "../../src/lib/tracker/file";
import { parseJson } from "../../src/lib/json";
import type { FindingDetail } from "../../src/lib/types";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const LOCAL = args.includes("--local");
const JSON_OUT = args.includes("--json");
// Every finding that cleared the symptom gate, with the verdict on each
// condition. The number is only as good as this list is inspectable.
// `--list` shows the findings that cleared G1; `--list all` shows every
// finding in the window, which is how a disputed exclusion gets checked.
const LIST = args.includes("--list");
const LIST_ALL = flag("--list") === "all";

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const SINCE = flag("--since") ?? daysAgo(30);
const UNTIL = flag("--until") ?? today;

// SINCE/UNTIL are interpolated into SQL (wrangler's d1 execute takes no
// parameters), so their shape is checked before they get there.
for (const [name, value] of [["--since", SINCE], ["--until", UNTIL]] as const) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    console.error(`${name} must be YYYY-MM-DD, got "${value}"`);
    process.exit(2);
  }
}

// Self-check placeholders (CLAUDE.md §6): targets the self-check registers and
// the janitor removes. They are not apps anyone observes.
const PLACEHOLDER = /^(example\.com|your-app\.com|.*\.example\.com|test-app-.*)$/;
// Our own product. Findings here are real, but they are findings about
// CheckMyApp by CheckMyApp and must never be averaged in with customer supply.
const OURS = "checkmyapp.dev";

// ─── D1 access (read-only) ───────────────────────────────────────────────────

function d1<T = Record<string, unknown>>(sql: string): T[] {
  if (!/^\s*select\b/i.test(sql)) throw new Error("this script only reads");
  const argv = [
    "wrangler",
    "d1",
    "execute",
    "checkmyapp",
    LOCAL ? "--local" : "--remote",
    "--json",
    "--command",
    sql,
  ];
  let out: string;
  try {
    out = execFileSync("npx", argv, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const text = (e.stdout ?? "").trim() || (e.stderr ?? "").trim() || e.message || String(err);
    throw new Error(`wrangler d1 execute failed: ${text}`);
  }
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`no JSON in wrangler output: ${out.slice(0, 200)}`);
  const first = JSON.parse(out.slice(start))[0];
  if (!first || first.success === false) {
    throw new Error(`query failed: ${JSON.stringify(first).slice(0, 300)}`);
  }
  return first.results as T[];
}

// createdAt is TEXT in D1 in two spellings (Prisma ISO "2026-09-03T21:47:26.000+00:00"
// and a plain SQL "2026-09-03 21:47:26"); both compare correctly as strings
// against a YYYY-MM-DD prefix. The 'Z' on the upper bound makes UNTIL include
// its whole day: every timestamp within it starts "UNTIL" followed by 'T' or a
// space, and both sort below 'Z'.
const WINDOW = (t = "") => `${t}createdAt >= '${SINCE}' AND ${t}createdAt < '${UNTIL}Z'`;

interface RunRow {
  id: string;
  runNumber: number;
  appSlug: string;
  status: string;
  ownerId: string | null;
  watchId: string | null;
  createdAt: string;
}
interface FindingRow {
  id: string;
  runId: string;
  title: string;
  category: string;
  severity: string;
  mark: string;
  detail: string | null;
  appSlug: string;
  ownerId: string | null;
  runCreatedAt: string;
}
interface UserRow {
  id: string;
  email: string;
  isTestAccount: number;
}

const runs = d1<RunRow>(
  `SELECT id, runNumber, appSlug, status, ownerId, watchId, createdAt FROM Run WHERE ${WINDOW()}`,
);
const findings = d1<FindingRow>(
  `SELECT f.id, f.runId, f.title, f.category, f.severity, f.mark, f.detail, ` +
    `r.appSlug AS appSlug, r.ownerId AS ownerId, r.createdAt AS runCreatedAt ` +
    `FROM Finding f JOIN Run r ON r.id = f.runId WHERE ${WINDOW("r.")}`,
);
const users = d1<UserRow>(`SELECT id, email, isTestAccount FROM User`);
const links = d1<{
  appSlug: string;
  externalIssueId: string;
  dedupKey: string;
  status: string;
  defectClass: string | null;
  occurrences: number;
  createdAt: string;
}>(
  `SELECT a.appSlug AS appSlug, il.externalIssueId, il.dedupKey, il.status, il.defectClass, ` +
    `il.occurrences, il.createdAt FROM IssueLink il JOIN App a ON a.id = il.appId`,
);
const settled = d1<{ appSlug: string; dedupKey: string; outcome: string }>(
  `SELECT appSlug, dedupKey, outcome FROM SettledSignature`,
);
// Replay coverage, printed as context for the G3 note above.
const actionCoverage = d1<{ steps: number; withActions: number }>(
  `SELECT COUNT(*) AS steps, SUM(CASE WHEN s.actions IS NOT NULL AND s.actions <> '' THEN 1 ELSE 0 END) AS withActions ` +
    `FROM Step s JOIN Journey j ON j.id = s.journeyId JOIN Run r ON r.id = j.runId WHERE ${WINDOW("r.")}`,
)[0];

const testAccounts = new Set(users.filter((u) => u.isTestAccount).map((u) => u.id));
const suppressed = new Set<string>([
  ...links.filter((l) => l.status === "suppressed").map((l) => `${l.appSlug}|${l.dedupKey}`),
  ...settled.filter((s) => s.outcome === "suppressed").map((s) => `${s.appSlug}|${s.dedupKey}`),
]);

// ─── Classification ──────────────────────────────────────────────────────────

type Bucket = "customer" | "ours" | "excluded";

function bucket(appSlug: string, ownerId: string | null): Bucket {
  if (appSlug === OURS) return "ours";
  if (PLACEHOLDER.test(appSlug)) return "excluded";
  if (ownerId && testAccounts.has(ownerId)) return "excluded";
  return "customer";
}

/** G1: autofile's own gate — src/agent/autofile.ts qualifies(). */
function qualifies(f: { category: string; severity: string }): boolean {
  return f.category === "broken" || f.category === "exposed" || f.severity === "high";
}

interface Judged {
  appSlug: string;
  bucket: Bucket;
  key: string;
  title: string;
  cat: string;
  sev: string;
  mark: string;
  g1: boolean;
  g2: boolean;
  g3: boolean;
  gateReady: boolean;
  evidenceOnly: boolean;
  proseOnly: boolean;
  runCreatedAt: string;
}

const judged: Judged[] = findings.map((f) => {
  const detail = parseJson<FindingDetail>(f.detail) ?? {};
  const key = dedupKeyForFinding(
    { title: f.title, category: f.category, severity: f.severity, detail: f.detail },
    { appSlug: f.appSlug },
  );
  // Exactly the three texts dedupKeyForFinding hashes, so G3 is not a second
  // opinion about the finding — it is the statement "this ticket's identity IS
  // a machine fact", and therefore so is its disappearance.
  const sig = requestSignature([detail.where, f.title, detail.whatHappened]);
  const g1 = qualifies(f);
  const g2 =
    f.mark !== "false_positive" &&
    !suppressed.has(`${f.appSlug}|${key}`) &&
    // CLAUDE.md §3: a 429 is our own request volume, never a finding. It is the
    // one status that passes every other test here and is ours by rule — the
    // "Try it now returned 429" family on joblander.app is exactly that.
    !(sig ?? "").endsWith(" 429");
  const g3 = sig !== null;
  return {
    appSlug: f.appSlug,
    bucket: bucket(f.appSlug, f.ownerId),
    key,
    title: f.title,
    cat: f.category,
    sev: f.severity,
    mark: f.mark,
    g1,
    g2,
    g3,
    gateReady: g1 && g2 && g3,
    // JOB-906 is why this second tier exists: "verify-session 401 on every
    // anonymous page load" is as machine-checkable as a finding gets, and the
    // model labelled it polish/low every time it saw it. The owner filed it by
    // hand and JobLander fixed it. Dropping G1 keeps the label out of the
    // measurement and asks only what the evidence supports.
    evidenceOnly: g2 && g3,
    proseOnly: g1 && g2 && !g3,
    runCreatedAt: f.runCreatedAt,
  };
});

// ─── Per-app roll-up ─────────────────────────────────────────────────────────

const day = (s: string) => s.slice(0, 10);
const spanDays = (first: string, last: string) =>
  Math.max(1, Math.round((Date.parse(`${day(last)}T00:00:00Z`) - Date.parse(`${day(first)}T00:00:00Z`)) / 86400000) + 1);

interface AppStat {
  appSlug: string;
  bucket: Bucket;
  runs: number;
  runDays: number;
  firstRun: string;
  lastRun: string;
  observedDays: number;
  findings: number;
  qualifying: number;
  gateReadyKeys: Set<string>;
  evidenceKeys: Set<string>;
  proseOnlyKeys: Set<string>;
  ticketsFiled: number;
}

const byApp = new Map<string, AppStat>();
for (const r of runs) {
  const b = bucket(r.appSlug, r.ownerId);
  const s =
    byApp.get(r.appSlug) ??
    ({
      appSlug: r.appSlug,
      bucket: b,
      runs: 0,
      runDays: 0,
      firstRun: r.createdAt,
      lastRun: r.createdAt,
      observedDays: 0,
      findings: 0,
      qualifying: 0,
      gateReadyKeys: new Set<string>(),
      evidenceKeys: new Set<string>(),
      proseOnlyKeys: new Set<string>(),
      ticketsFiled: 0,
    } as AppStat);
  s.runs += 1;
  if (day(r.createdAt) < day(s.firstRun)) s.firstRun = r.createdAt;
  if (day(r.createdAt) > day(s.lastRun)) s.lastRun = r.createdAt;
  byApp.set(r.appSlug, s);
}
for (const [slug, s] of byApp) {
  s.runDays = new Set(runs.filter((r) => r.appSlug === slug).map((r) => day(r.createdAt))).size;
  s.observedDays = spanDays(s.firstRun, s.lastRun);
  s.ticketsFiled = links.filter((l) => l.appSlug === slug).length;
}
for (const j of judged) {
  const s = byApp.get(j.appSlug);
  if (!s) continue;
  s.findings += 1;
  if (j.g1 && j.g2) s.qualifying += 1;
  if (j.gateReady) s.gateReadyKeys.add(j.key);
  if (j.evidenceOnly) s.evidenceKeys.add(j.key);
  if (j.proseOnly) s.proseOnlyKeys.add(j.key);
}

const perWeek = (n: number, days: number) => (days >= 7 ? (n * 7) / days : null);

// ─── Output ──────────────────────────────────────────────────────────────────

const ordered = [...byApp.values()].sort(
  (a, b) => a.bucket.localeCompare(b.bucket) || b.runs - a.runs,
);

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        window: { since: SINCE, until: UNTIL },
        apps: ordered.map((s) => ({
          ...s,
          gateReady: s.gateReadyKeys.size,
          proseOnly: s.proseOnlyKeys.size,
          gateReadyPerWeek: perWeek(s.gateReadyKeys.size, s.observedDays),
          gateReadyKeys: [...s.gateReadyKeys],
          proseOnlyKeys: [...s.proseOnlyKeys],
        })),
      },
      null,
      2,
    ),
  );
} else {
  const rate = (n: number | null) => (n === null ? "—" : n.toFixed(2));
  const section = (b: Bucket, heading: string) => {
    const rows = ordered.filter((s) => s.bucket === b);
    if (rows.length === 0) return;
    console.log(`\n### ${heading}\n`);
    console.log(
      "| app | runs | run-days | observed | findings | qualifying | gate-ready | evidence-tier | prose-only | gate-ready/wk | evidence/wk | tickets filed |",
    );
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const s of rows) {
      console.log(
        `| ${s.appSlug} | ${s.runs} | ${s.runDays} | ${day(s.firstRun)}→${day(s.lastRun)} (${s.observedDays}d) | ` +
          `${s.findings} | ${s.qualifying} | ${s.gateReadyKeys.size} | ${s.evidenceKeys.size} | ${s.proseOnlyKeys.size} | ` +
          `${rate(perWeek(s.gateReadyKeys.size, s.observedDays))} | ${rate(perWeek(s.evidenceKeys.size, s.observedDays))} | ${s.ticketsFiled} |`,
      );
    }
    const totals = rows.reduce(
      (acc, s) => {
        acc.runs += s.runs;
        acc.findings += s.findings;
        acc.qualifying += s.qualifying;
        acc.gate += s.gateReadyKeys.size;
        acc.evidence += s.evidenceKeys.size;
        acc.prose += s.proseOnlyKeys.size;
        return acc;
      },
      { runs: 0, findings: 0, qualifying: 0, gate: 0, evidence: 0, prose: 0 },
    );
    console.log(
      `\n${heading}: ${rows.length} app(s), ${totals.runs} runs, ${totals.findings} findings, ` +
        `${totals.qualifying} qualifying, **${totals.gate} gate-ready** ` +
        `(evidence tier ${totals.evidence}, prose-only ${totals.prose}).`,
    );
  };

  console.log(`## Ticket supply, ${SINCE} → ${UNTIL}\n`);
  console.log(
    `Gate-ready = G1 symptom (broken/exposed or high) ∧ G2 not-ours/not-disproved ∧ ` +
      `G3 machine-checkable disappearance (a METHOD /path + 4xx/5xx in the finding's own text). ` +
      `Counted by distinct dedup key, so a problem recurring across daily runs is one ticket.`,
  );
  section("customer", "Customer apps");
  section("ours", "Our own product (self-check — never mixed into the number above)");
  console.log(
    `\n"tickets filed" on our own row is not comparable with a customer's: the CheckMyApp app is ` +
      `also the board [Checker gap] and [Checker defect] tickets land on (capability-gaps.ts), and ` +
      `those have no Finding row behind them at all.`,
  );
  section("excluded", "Excluded: placeholders and test-account targets");

  const cust = ordered.filter((s) => s.bucket === "customer");
  // "Observed" has to mean watched, not visited. An app checked twice a
  // fortnight apart spans two weeks of calendar and no weeks of observation;
  // pooling it in only dilutes the denominator. The line is runs on 5+ distinct
  // days across a span of a week or more — a watch that actually ran.
  const recurring = cust.filter((s) => s.runDays >= 5 && s.observedDays >= 7);
  const occasional = cust.filter((s) => !recurring.includes(s) && s.runs >= 2);
  const gate = recurring.reduce((n, s) => n + s.gateReadyKeys.size, 0);
  const weeks = recurring.reduce((n, s) => n + s.observedDays / 7, 0);
  console.log(`\n### The number\n`);
  if (recurring.length === 0) {
    console.log(
      "No customer app was under continuous observation in this window (runs on 5+ days across " +
        "a week or more) — there is no per-week rate to report, only spot checks.",
    );
  } else {
    const evid = recurring.reduce((n, s) => n + s.evidenceKeys.size, 0);
    console.log(
      `Across ${recurring.length} recurringly observed customer app(s) — ` +
        `${recurring.map((s) => `${s.appSlug} (${s.runs} runs / ${s.observedDays}d)`).join(", ")} — ` +
        `**${gate} gate-ready ticket(s) over ${weeks.toFixed(1)} app-weeks = ` +
        `${(gate / weeks).toFixed(2)} per app per week.**`,
    );
    console.log(
      `\nOn the evidence tier (G2 ∧ G3, the model's category/severity label ignored): ` +
        `**${evid} over the same ${weeks.toFixed(1)} app-weeks = ${(evid / weeks).toFixed(2)} per app per week.** ` +
        `The two numbers bracket the answer: the first is what today's filing gate would emit, ` +
        `the second is what the evidence in the database would support if the label were not in the way.`,
    );
    const oneOff = cust.filter((s) => s.runs === 1);
    const pooledWeeks = weeks + occasional.reduce((n, s) => n + s.observedDays / 7, 0);
    const pooledGate = gate + occasional.reduce((n, s) => n + s.gateReadyKeys.size, 0);
    console.log(
      `\nPooling the occasionally-checked apps in as well ` +
        `(${occasional.map((s) => `${s.appSlug} ${s.runDays}d`).join(", ") || "none"}) gives ` +
        `${pooledGate} over ${pooledWeeks.toFixed(1)} app-weeks = ${(pooledGate / pooledWeeks).toFixed(2)} ` +
        `per app per week. It is the wrong denominator — those apps were visited, not watched — ` +
        `and it is printed only so the choice of denominator is visible rather than hidden.`,
    );
    console.log(
      `\nSingle-run customer checks in the same window (no rate is definable): ` +
        `${oneOff.map((s) => `${s.appSlug} (${s.gateReadyKeys.size} gate-ready)`).join(", ") || "none"}.`,
    );
  }
  console.log(
    `\nReplayable actions recorded on ${actionCoverage.withActions ?? 0} of ${actionCoverage.steps} steps ` +
      `in this window — why G3 reads the finding's text rather than requiring a recorded replay.`,
  );

  // The criterion is only worth anything if it lands on the same set the world
  // already agreed about. Every ticket opened on a customer board inside the
  // window, and whether our judgement of its finding matches.
  console.log(`\n### Cross-check against tickets that actually exist\n`);
  const inWindow = links.filter(
    (l) => l.createdAt >= SINCE && l.createdAt < `${UNTIL}Z` && bucket(l.appSlug, null) === "customer",
  );
  if (inWindow.length === 0) console.log("No customer tickets were opened in this window.");
  for (const l of inWindow) {
    // A key is judged across every finding that carries it: the same problem is
    // described broken/high on one run and polish/low on the next, and one
    // qualifying description is enough for the gate to have fired.
    const hits = judged.filter((j) => j.appSlug === l.appSlug && j.key === l.dedupKey);
    const verdict = hits.length === 0
      ? `no finding in this window carries that key (${hits.length === 0 && l.status === "suppressed" ? "settled and rekeyed" : "rekeyed by CHE-59, or filed from an earlier run"})`
      : hits.some((h) => h.gateReady)
        ? `gate-ready (${hits.length} finding(s) share the key)`
        : hits.some((h) => h.evidenceOnly)
          ? `evidence tier only — the model never labelled it broken/exposed/high on any of its ${hits.length} appearance(s)`
          : `not counted (best of ${hits.length}: G1 ${hits.some((h) => h.g1) ? "✓" : "✗"}, G2 ${hits.some((h) => h.g2) ? "✓" : "✗"}, G3 ${hits.some((h) => h.g3) ? "✓" : "✗"})`;
    console.log(`- ${l.externalIssueId} (${l.appSlug}, ${l.status}) → ${verdict}`);
  }

  if (LIST) {
    console.log(
      `\n### ${LIST_ALL ? "Every finding in the window" : "Every finding that cleared G1"}, and why it did or did not clear the rest\n`,
    );
    console.log("| app | date | cat/sev | mark | G1 | G2 | G3 | key | title |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const j of judged.filter((x) => LIST_ALL || x.g1).sort((a, b) => a.appSlug.localeCompare(b.appSlug) || a.runCreatedAt.localeCompare(b.runCreatedAt))) {
      console.log(
        `| ${j.appSlug} | ${day(j.runCreatedAt)} | ${j.cat}/${j.sev} | ${j.mark} | ${j.g1 ? "✓" : "✗"} | ${j.g2 ? "✓" : "✗"} | ${j.g3 ? "✓" : "✗"} | ${j.key.slice(0, 8)} | ${j.title.replace(/\|/g, "/").slice(0, 80)} |`,
      );
    }
  }
}
