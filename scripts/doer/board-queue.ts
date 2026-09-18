// The doer's queue, read from where our own tickets are already recorded.
//
// The tickets themselves live on the board, but we do not go there: every ticket
// we file leaves an `IssueLink` row in our own database — which ticket, for
// which app, and whether it is still open (`src/lib/tracker/file.ts`). That row
// is the queue, and reading it needs nothing we do not already have. The earlier
// plan for this was a Linear key in the repository's secrets; the owner pointed
// out that the part of the product which FILES the tickets already holds
// everything needed, and he was right — this reads D1 with the Cloudflare token
// CI already carries, exactly the way scripts/measure/gate-ready-supply.ts does.
//
// What the row does NOT carry is the ticket's title, and the doer's ruling is
// per capability (scripts/doer/queue.mjs). That is recoverable without asking
// anyone: the filer hashes a fixed shape into `dedupKey`, and the set of things
// it can file is closed — the capabilities in gap-classes.ts and four defect
// classes. So the keys are computed here from the same function the filer uses,
// and a row whose key matches none of them is reported as unknown rather than
// dropped: an unrecognised ticket means this list and the filer's have drifted
// apart, and that is exactly the kind of silence CHE-152 was about.
//
// Since 2026-09-18 the reader also carries the EVIDENCE for each admitted
// ticket: the implementer (Mender, scripts/doer/mender.mjs) is handed the
// ticket as a file, and the board is not reachable from the workflow without a
// Linear credential. Everything the board ticket says was written by us from
// these same rows (src/agent/capability-gaps.ts), so it is read back from them:
// for a gap, the most recent steps that went unverified on that class; for a
// defect, the rejected claims filed under that cause.
//
// Read-only. Nothing here may write to the board or the database.
//
// Usage:
//   npx tsx scripts/doer/board-queue.ts            # human-readable
//   npx tsx scripts/doer/board-queue.ts --json     # for the tick

import { execFileSync } from "node:child_process";
import { dedupKeyForFinding } from "../../src/lib/tracker/file";
import { GAP_CLASSES } from "../../src/agent/gap-classes";
import {
  ADMITTED_CAPABILITIES,
  REFUSED_CAPABILITIES,
  ADMITTED_DEFECTS,
  REFUSED_DEFECTS,
  DEFECT_CLASS_BY_LABEL,
} from "./queue.mjs";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const LOCAL = args.includes("--local");

// Our own app row: the one whose tracker connection files our gaps, and whose
// slug the filer uses as the dedup identity so one capability is one ticket
// across every customer app that trips it.
const OURS = "checkmyapp.dev";

/** How many pieces of evidence a ticket carries to the implementer. */
const EVIDENCE_LIMIT = 5;

/** The exact shape capability-gaps.ts hashes, for one label. */
function keyFor(label: string, where: "CheckMyApp agent capability" | "CheckMyApp checker accuracy"): string {
  return dedupKeyForFinding(
    {
      title: label,
      category: "broken",
      severity: "high",
      // Only `where`, `title` and `whatHappened` reach the signature, and the
      // filer deliberately keeps run-specific facts out of them so every
      // instance of a class hashes to the same ticket. `whatHappened` carries no
      // request signature in either family, so it cannot change the key.
      detail: JSON.stringify({ where }),
    },
    { appSlug: OURS },
  );
}

const labels = new Map<string, { label: string; kind: "gap" | "defect" }>();
for (const label of [...ADMITTED_CAPABILITIES.keys(), ...REFUSED_CAPABILITIES.keys()]) {
  labels.set(keyFor(label, "CheckMyApp agent capability"), { label, kind: "gap" });
}
for (const label of [...ADMITTED_DEFECTS.keys(), ...REFUSED_DEFECTS.keys()]) {
  labels.set(keyFor(label, "CheckMyApp checker accuracy"), { label, kind: "defect" });
}

// The class key behind a gap label, from the one table the filer writes it
// from. A label with no class is a label this list knows and gap-classes.ts
// does not — reported, never guessed.
const GAP_CLASS_BY_LABEL = new Map<string, string>(
  Object.entries(GAP_CLASSES).map(([cls, { label }]) => [label, cls]),
);

function d1<T = Record<string, unknown>>(sql: string): T[] {
  if (!/^\s*select\b/i.test(sql)) throw new Error("this script only reads");
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "checkmyapp", LOCAL ? "--local" : "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`no JSON in wrangler output: ${out.slice(0, 200)}`);
  const first = JSON.parse(out.slice(start))[0];
  if (!first || first.success === false) throw new Error(`query failed: ${JSON.stringify(first).slice(0, 300)}`);
  return (first.results ?? []) as T[];
}

// The class keys are our own identifiers (gap-classes.ts, capability-gaps.ts),
// never free text, but a query is still built from them and this is the one
// place that must stay true.
function literal(value: string): string {
  if (!/^[a-z_]+$/.test(value)) throw new Error(`refusing to query with ${JSON.stringify(value)}`);
  return `'${value}'`;
}

type Row = {
  externalIssueId: string;
  dedupKey: string;
  status: string;
  occurrences: number;
  createdAt: string;
};

type StepEvidence = {
  runId: string;
  appSlug: string;
  createdAt: string;
  journey: string;
  label: string;
  attempted: string | null;
  observed: string | null;
};

type SignatureEvidence = { externalIssueId: string; appSlug: string; settledAt: string };

function evidenceFor(label: string, kind: "gap" | "defect") {
  if (kind === "gap") {
    const cls = GAP_CLASS_BY_LABEL.get(label);
    if (!cls) return { why: null, steps: [], note: "no class in gap-classes.ts carries this label" };
    const steps = d1<StepEvidence>(
      `select r.id as runId, r.appSlug, r.createdAt, j.title as journey, s.label, s.attempted, s.observed
         from Step s join Journey j on j.id = s.journeyId join Run r on r.id = j.runId
        where s.unverifiedReason = 'our_capability' and s.gapClass = ${literal(cls)}
        order by r.createdAt desc limit ${EVIDENCE_LIMIT}`,
    );
    return { why: GAP_CLASSES[cls as keyof typeof GAP_CLASSES].why, steps };
  }
  const cls = DEFECT_CLASS_BY_LABEL.get(label);
  if (!cls) return { why: null, signatures: [], note: "no defect class carries this label" };
  const signatures = d1<SignatureEvidence>(
    `select externalIssueId, appSlug, settledAt from SettledSignature
      where outcome = 'suppressed' and defectClass = ${literal(cls)}
      order by settledAt desc limit ${EVIDENCE_LIMIT}`,
  );
  return { why: null, signatures };
}

// "open" only: `fixed` is waiting for an outside re-verify, `resolved` is done,
// and `suppressed` was ruled not-a-bug and must never be refiled (CHE-99).
const rows = d1<Row>(
  `select il.externalIssueId, il.dedupKey, il.status, il.occurrences, il.createdAt
     from IssueLink il join App a on a.id = il.appId
    where a.appSlug = '${OURS}' and il.status = 'open'
    order by il.createdAt asc`,
);

const known = [];
const unknown = [];
for (const r of rows) {
  const match = labels.get(r.dedupKey);
  if (match) {
    known.push({
      ...match,
      ticket: r.externalIssueId,
      occurrences: r.occurrences,
      createdAt: r.createdAt,
      evidence: evidenceFor(match.label, match.kind),
    });
  } else {
    unknown.push({ ticket: r.externalIssueId, dedupKey: r.dedupKey, createdAt: r.createdAt });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ known, unknown }, null, 2));
} else {
  console.log(`${rows.length} open ticket(s) of ours in the database\n`);
  for (const k of known) {
    const n = (k.evidence.steps ?? k.evidence.signatures ?? []).length;
    console.log(`  ${k.ticket}  ${k.kind.padEnd(6)}  ×${k.occurrences}  ${k.label}  (${n} piece(s) of evidence)`);
  }
  if (unknown.length) {
    console.log(`\n${unknown.length} row(s) whose key matches no capability this repository knows about.`);
    console.log("That means the filer's list and scripts/doer/queue.mjs have drifted apart:");
    for (const u of unknown) console.log(`  ${u.ticket}  ${u.dedupKey}`);
  }
}
