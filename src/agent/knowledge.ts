// AppKnowledge (CHE-136) — the one small thing every prompt reads about an app.
//
// What we know about an app already lives in the tables — owner marks on
// findings (CHE-78), tracker settlements (CHE-61 / CHE-101), the page survey
// and its diff (CHE-132), the last walked run's journeys — but each run read
// only the baseline. The cost showed up three ways: the walker spent
// iterations proving a known not-a-bug again; synthesis re-wrote findings the
// owner had already settled (a "by design" signature suppressed the TICKET in
// autofile, never the finding, and the inherited mark landed only after the
// finding was written anyway); and a page that changed since the last check
// got no more attention than one that did not.
//
// This is NOT a graph and NOT a new table: a read-model over existing rows,
// composed once per run and rendered into the three prompts by
// instructions.ts (knowledgeBlock). No schema change.
//
// Two halves, deliberately split:
//   composeKnowledge — pure. Takes rows already shaped, returns the object or
//     null. scripts/verify-knowledge.ts asserts on it from Node.
//   loadAppKnowledge — the reads. Every one is wrapped: a failure yields null
//     with a warning, because knowledge is a hint and never a reason a run
//     fails (same swallow contract as the other pre-flight rungs).

import type { AgentEnv } from "./env";
import type { SurveyOutcome } from "./snapshot";

export interface AppKnowledge {
  /** Findings that need no re-proving: the owner marked them, the tracker canceled them, or a fix was confirmed. */
  settled: Array<{
    title: string;
    category: string | null;
    why: "owner_marked" | "tracker_canceled" | "resolved";
  }>;
  /** Paths whose content changed or appeared since the last comparable snapshot. */
  changedPaths: string[];
  /** Pages the current survey saw; null when no survey ran. */
  lastSnapshotPages: number | null;
  /** The last walked run's journeys and how they ended. */
  journeys: Array<{ title: string; status: string; walkedAt: string }>;
}

// Fifteen settled lines is the most a prompt can carry without the block
// becoming the inventory it is meant to replace.
export const SETTLED_CAP = 15;

export interface ComposeInput {
  marks: Array<{ title: string; category: string; mark: string }>;
  /** Tracker settlements already resolved to a human title (never invented). */
  settledLinks: Array<{ title: string; category: string | null; outcome: string }>;
  snapshot: { pages: number; changedPaths: string[] } | null;
  journeys: Array<{ title: string; status: string; walkedAt: string }>;
}

// Pure. Owner marks first, then tracker settlements, deduped by lower-cased
// title so a re-worded finding the owner marked does not reappear under its
// tracker identity — and the owner's own word wins over the tracker's.
export function composeKnowledge(input: ComposeInput): AppKnowledge | null {
  const settled: AppKnowledge["settled"] = [];
  const seen = new Set<string>();
  const push = (entry: AppKnowledge["settled"][number]) => {
    const key = entry.title.trim().toLowerCase();
    if (!key || seen.has(key) || settled.length >= SETTLED_CAP) return;
    seen.add(key);
    settled.push(entry);
  };

  for (const m of input.marks) {
    if (m.mark !== "known" && m.mark !== "false_positive") continue;
    push({ title: m.title, category: m.category || null, why: "owner_marked" });
  }
  for (const s of input.settledLinks) {
    if (s.outcome === "suppressed") {
      push({ title: s.title, category: s.category, why: "tracker_canceled" });
    } else if (s.outcome === "resolved") {
      push({ title: s.title, category: s.category, why: "resolved" });
    }
  }

  const changedPaths = [...new Set(input.snapshot?.changedPaths ?? [])];
  const journeys = input.journeys.filter((j) => j.title.trim().length > 0);

  // A page count alone tells the prompts nothing; without a settled line, a
  // changed page or a past journey there is nothing to say.
  if (settled.length === 0 && changedPaths.length === 0 && journeys.length === 0) return null;

  return {
    settled,
    changedPaths,
    lastSnapshotPages: input.snapshot?.pages ?? null,
    journeys,
  };
}

// Pure. What the survey contributes: the page count, and the paths that
// changed or appeared — only when two snapshots were actually compared and
// differed. A first snapshot, a blocked homepage or a truncated survey with
// too little in common with the last one has no "changed" answer
// (snapshot.ts), so it contributes no paths rather than
// every path.
export function snapshotInput(
  survey: SurveyOutcome | null | undefined,
): ComposeInput["snapshot"] {
  const s = survey?.snapshot;
  if (!s) return null;
  const diff = survey?.comparable && s.changed === true ? s.diff : null;
  return {
    pages: s.pages.length,
    changedPaths: diff ? [...diff.changedPaths, ...diff.addedPaths] : [],
  };
}

// How many rows each read may return before composeKnowledge dedupes and caps.
// Bounded so an app with a long history costs a bounded read, not a table scan.
const MARK_ROWS = 40;
const SETTLED_ROWS = 40;
const JOURNEY_ROWS = 10;

export async function loadAppKnowledge(
  env: AgentEnv,
  run: { id: string; appSlug: string; appId: string | null; ownerId: string | null; watchId: string | null },
  survey?: SurveyOutcome | null,
): Promise<AppKnowledge | null> {
  const warn = (what: string, err: unknown) => {
    console.warn(`[knowledge] ${what} unavailable: ${err instanceof Error ? err.message : String(err)}`);
  };

  // Owner marks on earlier runs of this app — the same query shape
  // persistFindings uses to inherit them (CHE-78), so the two never disagree
  // about which findings the owner has spoken on.
  let marks: ComposeInput["marks"] = [];
  try {
    marks = await env.db.finding.findMany({
      where: {
        mark: { in: ["known", "false_positive"] },
        run: { appSlug: run.appSlug, id: { not: run.id } },
      },
      orderBy: { createdAt: "desc" },
      take: MARK_ROWS,
      select: { title: true, category: true, mark: true },
    });
  } catch (err) {
    warn("owner marks", err);
  }

  // Tracker settlements (CHE-61), kept per owner (CHE-101). A signature is a
  // one-way hash, so the human title comes back through the IssueLink pointer
  // (CHE-103) to the Finding it was filed from; a settlement whose finding is
  // gone is skipped — a title is never invented. Anonymous runs have no owner
  // to have settled anything, and another owner's settlements on the same
  // host are theirs, not this run's.
  let settledLinks: ComposeInput["settledLinks"] = [];
  if (run.ownerId) {
    try {
      const settled = await env.db.settledSignature.findMany({
        where: { ownerId: run.ownerId, appSlug: run.appSlug, outcome: { in: ["suppressed", "resolved"] } },
        orderBy: { settledAt: "desc" },
        take: SETTLED_ROWS,
        select: { externalIssueId: true, outcome: true },
      });
      if (settled.length) {
        const links = await env.db.issueLink.findMany({
          where: {
            externalIssueId: { in: settled.map((s) => s.externalIssueId) },
            findingId: { not: null },
          },
          select: { externalIssueId: true, findingId: true },
        });
        const findingIds = links.map((l) => l.findingId).filter((id): id is string => Boolean(id));
        const findings = findingIds.length
          ? await env.db.finding.findMany({
              where: { id: { in: findingIds } },
              select: { id: true, title: true, category: true },
            })
          : [];
        const byId = new Map(findings.map((f) => [f.id, f]));
        const byIssue = new Map(links.map((l) => [l.externalIssueId, l.findingId]));
        for (const s of settled) {
          const finding = byId.get(byIssue.get(s.externalIssueId) ?? "");
          if (!finding) continue;
          settledLinks.push({ title: finding.title, category: finding.category, outcome: s.outcome });
        }
      }
    } catch (err) {
      warn("tracker settlements", err);
    }
  }

  // The last walked run's journeys and how they ended — the same run the
  // known map (CHE-133) and the partial plan (CHE-57) read.
  let journeys: ComposeInput["journeys"] = [];
  if (run.watchId) {
    try {
      // Loaded lazily: replay.ts reaches `cloudflare:workers` through the
      // browser launcher, and a static import would make this module — and
      // composeKnowledge with it — unloadable by scripts/verify-knowledge.ts
      // from Node. The worker bundle inlines it as a lazy init, no separate
      // chunk (checked with a wrangler dry-run build).
      const { findLastWalkedRun } = await import("./replay");
      const walked = await findLastWalkedRun(env, run.watchId);
      if (walked?.completedAt) {
        const walkedAt = walked.completedAt.toISOString();
        const rows = await env.db.journey.findMany({
          where: { runId: walked.id },
          orderBy: { order: "asc" },
          take: JOURNEY_ROWS,
          select: { title: true, status: true },
        });
        journeys = rows.map((j) => ({ title: j.title, status: j.status, walkedAt }));
      }
    } catch (err) {
      warn("last journeys", err);
    }
  }

  return composeKnowledge({ marks, settledLinks, snapshot: snapshotInput(survey), journeys });
}
