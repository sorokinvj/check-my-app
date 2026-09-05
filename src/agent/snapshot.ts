// Snapshots and the full-run gate (CHE-132).
//
// Owner decision, 2026-09-03: a full walk happens when the app changed, not
// when a week has passed. Until this file the ladder in replay.ts and
// partial.ts forced a full run on the calendar (FULL_RUN_MAX_AGE_DAYS) because
// nothing could say whether the app was the same app as last week. The survey
// in survey.ts can, from a plain fetch, so:
//
//   - two comparable snapshots that agree → no forced walk, however old the
//     last one is (the calendar is gone);
//   - two comparable snapshots that differ → a full walk, with the diff as the
//     reason the owner reads;
//   - nothing to compare (first snapshot, a blocked homepage, a survey that
//     errored, two surveys the cap cut short with too little in common) →
//     the old seven-day fuse, exactly as before.
//
// "Previous" is the last unblocked snapshot. A survey the cap or the deadline
// cut short IS compared (CHE-179) — on the pages both sides saw, with a page
// only one side reached read as unknown, not added or removed. Until
// 2026-09-04 a truncated row was never compared, and since every real app has
// more than 50 pages that left every real app on the fuse: `changed` was
// null every day and the change-driven walk this file exists for never fired
// for anyone but the five-page checkmyapp.dev.
//
// CHE-185 (2026-09-05): what a page hashes to changed from its HTML to a
// structural digest (survey.ts), because run #149 walked joblander.app in full
// over a counter in the hero. Two consequences live here: a previous snapshot
// hashed the old way is not comparable — the fuse applies for one day, then
// the next pair compares normally — and a survey whose homepage digest moved
// between two fetches within the same crawl is `volatile`, and is compared
// with text-only differences set aside (applyVolatileRule).
//
// fullRunGate is pure so the rule is checked by scripts/verify-survey.ts and
// not by waiting a week in production.

import { parseJson } from "@/lib/json";
import type { RunEvent } from "@/lib/types";
import type { AgentEnv } from "./env";
import {
  describeDiff,
  diffIsChange,
  diffSnapshots,
  pathOverlap,
  surveyApp,
  type SnapshotDiff,
  type SurveyPage,
} from "./survey";

/** A stored snapshot with its JSON columns parsed. Plain data: it crosses a Workflow step boundary. */
export interface SnapshotRecord {
  id: string;
  appSlug: string;
  runId: string | null;
  takenAt: string;
  fingerprint: string;
  pages: SurveyPage[];
  bundles: string[];
  buildId: string | null;
  tech: string[];
  sitemapUrls: number;
  blocked: boolean;
  truncated: boolean;
  /** survey.ts DIGEST_VERSION the page hashes were computed with; 1 for rows written before 2026-09-05. */
  digestVersion: number;
  /** The homepage digest moved between two fetches within this survey (CHE-185). */
  volatile: boolean;
  previousId: string | null;
  changed: boolean | null;
  diff: SnapshotDiff | null;
}

// The `pages` column, since CHE-185, is either the bare SurveyPage[] every row
// before 2026-09-05 holds (digest version 1, not volatile) or this envelope.
// An envelope rather than a column so no migration was needed and an old row
// still parses; digestVersion lives with the hashes it describes.
interface StoredPages {
  digestVersion: number;
  volatile: boolean;
  pages: SurveyPage[];
}

export function parseStoredPages(raw: string): StoredPages {
  const parsed = parseJson<SurveyPage[] | StoredPages>(raw);
  if (Array.isArray(parsed)) return { digestVersion: 1, volatile: false, pages: parsed };
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.pages)) {
    return {
      digestVersion: typeof parsed.digestVersion === "number" ? parsed.digestVersion : 1,
      volatile: parsed.volatile === true,
      pages: parsed.pages,
    };
  }
  return { digestVersion: 1, volatile: false, pages: [] };
}

export function serializeStoredPages(stored: StoredPages): string {
  return JSON.stringify({ digestVersion: stored.digestVersion, volatile: stored.volatile, pages: stored.pages });
}

export interface SurveyOutcome {
  snapshot: SnapshotRecord | null;
  previous: SnapshotRecord | null;
  /** A comparable previous exists — `snapshot.changed` is an answer, not null. */
  comparable: boolean;
}

// Two truncated surveys of the same site share the same first 50 pages
// (survey.ts keeps the crawl order a function of the site); a site that grew
// or shrank a little still shares most of them. Below this share the two
// lists are about different pages and a comparison would be noise.
export const COMPARABLE_OVERLAP = 0.8;

/**
 * Whether this survey can be read against an earlier one at all: neither
 * blocked, hashes of the same digest version (CHE-185), and either both
 * complete or (CHE-179) enough pages in common to compare on.
 */
export function isComparable(
  previous: SnapshotRecord | null,
  current: { blocked: boolean; truncated: boolean; digestVersion: number; pages: Pick<SurveyPage, "path">[] },
): boolean {
  if (!previous || previous.blocked || current.blocked) return false;
  if (previous.digestVersion !== current.digestVersion) return false;
  if (!previous.truncated && !current.truncated) return true;
  return pathOverlap(previous.pages, current.pages) >= COMPARABLE_OVERLAP;
}

/**
 * The volatile rule (CHE-185). When either side's homepage moved between two
 * fetches of the same crawl, a page in `changedPaths` is set aside — recorded
 * in `ignoredPaths`, not counted as a change — exactly when all of these hold:
 * its status is the same on both sides, both sides carry a skeletonHash, and
 * the two skeletonHashes are equal (headings, link set, form fields and asset
 * URLs unchanged — survey.ts pageSkeleton). A page whose skeleton moved, or
 * whose status moved, or that only one side hashed the new way, stays a
 * change. Added and removed paths, bundles and the build id are untouched: a
 * volatile site that deployed still walks.
 */
export function applyVolatileRule(
  previous: { volatile: boolean; pages: Pick<SurveyPage, "path" | "status" | "skeletonHash">[] },
  current: { volatile: boolean; pages: Pick<SurveyPage, "path" | "status" | "skeletonHash">[] },
  diff: SnapshotDiff,
): { diff: SnapshotDiff; ignored: string[] } {
  if (!previous.volatile && !current.volatile) return { diff, ignored: [] };
  const before = new Map(previous.pages.map((p) => [p.path, p]));
  const after = new Map(current.pages.map((p) => [p.path, p]));
  const ignored: string[] = [];
  const kept: string[] = [];
  for (const path of diff.changedPaths) {
    const a = before.get(path);
    const b = after.get(path);
    const textOnly =
      !!a && !!b && a.status === b.status && !!a.skeletonHash && !!b.skeletonHash && a.skeletonHash === b.skeletonHash;
    (textOnly ? ignored : kept).push(path);
  }
  if (ignored.length === 0) return { diff, ignored };
  return { diff: { ...diff, changedPaths: kept, ignoredPaths: ignored }, ignored };
}

export const NO_SURVEY: SurveyOutcome = { snapshot: null, previous: null, comparable: false };

interface SnapshotRow {
  id: string;
  appSlug: string;
  runId: string | null;
  takenAt: Date;
  fingerprint: string;
  pages: string;
  bundles: string;
  buildId: string | null;
  tech: string;
  sitemapUrls: number;
  blocked: boolean;
  truncated: boolean;
  previousId: string | null;
  changed: boolean | null;
  diff: string | null;
}

function toRecord(row: SnapshotRow): SnapshotRecord {
  const stored = parseStoredPages(row.pages);
  return {
    id: row.id,
    appSlug: row.appSlug,
    runId: row.runId,
    takenAt: row.takenAt.toISOString(),
    fingerprint: row.fingerprint,
    pages: stored.pages,
    bundles: parseJson<string[]>(row.bundles) ?? [],
    buildId: row.buildId,
    tech: parseJson<string[]>(row.tech) ?? [],
    sitemapUrls: row.sitemapUrls,
    blocked: row.blocked,
    truncated: row.truncated,
    digestVersion: stored.digestVersion,
    volatile: stored.volatile,
    previousId: row.previousId,
    changed: row.changed,
    diff: parseJson<SnapshotDiff>(row.diff),
  };
}

export async function takeSnapshot(
  env: AgentEnv,
  run: { id: string; appSlug: string; appId: string | null; targetUrl: string },
): Promise<SurveyOutcome> {
  const survey = await surveyApp(run.targetUrl);
  if (survey.truncated) {
    console.warn(
      `[survey] ${run.appSlug}: stopped at ${survey.pages.length} pages with more still queued`,
    );
  }

  // A Workflow step retry must not compare this run against its own earlier
  // attempt, nor leave two rows for one run.
  await env.db.appSnapshot.deleteMany({ where: { runId: run.id } });
  // Scoped by owner, not by hostname: appSlug is unique only per owner. A
  // re-registered app, or another owner's app on the same host, must never
  // inherit a stale snapshot as its baseline — "nothing changed" would then
  // be a claim about somebody else's history. An anonymous one-off run has no
  // App row, so it compares only against other anonymous runs of that host.
  // Truncated rows are candidates (CHE-179); isComparable decides whether the
  // two have enough in common.
  const previousRow = await env.db.appSnapshot.findFirst({
    where: {
      ...(run.appId ? { appId: run.appId } : { appSlug: run.appSlug, appId: null }),
      blocked: false,
    },
    orderBy: { takenAt: "desc" },
  });
  const previous = previousRow ? toRecord(previousRow) : null;

  if (previous && previous.digestVersion !== survey.digestVersion) {
    console.warn(
      `[survey] ${run.appSlug}: last snapshot hashed with digest v${previous.digestVersion}, this one v${survey.digestVersion} — not compared`,
    );
  }
  if (survey.volatile) {
    console.warn(`[survey] ${run.appSlug}: homepage digest moved between two fetches of this survey — volatile`);
  }

  const comparable = isComparable(previous, survey);
  let diff = comparable && previous ? diffSnapshots(previous, survey) : null;
  if (diff && previous) {
    const ruled = applyVolatileRule(previous, survey, diff);
    if (ruled.ignored.length > 0) {
      console.warn(
        `[survey] ${run.appSlug}: volatile — set aside ${ruled.ignored.length} text-only change(s): ${ruled.ignored.join(", ")}`,
      );
    }
    diff = ruled.diff;
  }
  const changed = diff ? diffIsChange(diff) : null;

  const row = await env.db.appSnapshot.create({
    data: {
      appSlug: run.appSlug,
      appId: run.appId,
      runId: run.id,
      fingerprint: survey.fingerprint,
      pages: serializeStoredPages({ digestVersion: survey.digestVersion, volatile: survey.volatile, pages: survey.pages }),
      bundles: JSON.stringify(survey.bundles),
      buildId: survey.buildId,
      tech: JSON.stringify(survey.tech),
      sitemapUrls: survey.sitemapUrls,
      blocked: survey.blocked,
      truncated: survey.truncated,
      previousId: previous?.id ?? null,
      changed,
      diff: diff ? JSON.stringify(diff) : null,
    },
  });
  await env.db.run.update({ where: { id: run.id }, data: { snapshotId: row.id } });

  return { snapshot: toRecord(row), previous, comparable };
}

// ─── The gate ────────────────────────────────────────────────────────────────

export interface GateInput {
  comparable: boolean;
  changed: boolean | null;
  /** Days since the last run that actually walked; null when there is none. */
  lastWalkAgeDays: number | null;
  maxAgeDays: number;
  /** The comparison, for the reason the owner reads. */
  diff?: SnapshotDiff | null;
}

export type GateDecision =
  | { force: false }
  | { force: true; reason: string; cause: "changed" | "stale" };

export function fullRunGate(input: GateInput): GateDecision {
  if (input.comparable && input.changed === false) return { force: false };
  if (input.comparable && input.changed === true) {
    return {
      force: true,
      cause: "changed",
      reason: input.diff ? describeDiff(input.diff) : "the app changed since the last check",
    };
  }
  // Not comparable: the fuse. The wording is the one the feed has always shown.
  if (input.lastWalkAgeDays !== null && input.lastWalkAgeDays >= input.maxAgeDays) {
    return {
      force: true,
      cause: "stale",
      reason: `last full check was ${Math.floor(input.lastWalkAgeDays)} days ago — time for another one`,
    };
  }
  return { force: false };
}

/** What the gate needs, taken off a survey outcome (or its absence). */
export function gateInputFrom(
  survey: SurveyOutcome | null | undefined,
  lastWalkAgeDays: number | null,
  maxAgeDays: number,
): GateInput {
  return {
    comparable: survey?.comparable ?? false,
    changed: survey?.snapshot?.changed ?? null,
    diff: survey?.snapshot?.diff ?? null,
    lastWalkAgeDays,
    maxAgeDays,
  };
}

// ─── Smoke targets ───────────────────────────────────────────────────────────

// Every page the survey saw serve, minus the homepage (the smoke pass loads it
// first regardless). Pages that answered 4xx/5xx or nothing are left out: a
// smoke pass re-visits pages that were fine, and a 404 that was 404 yesterday
// is not trouble.
export function smokeTargetsFromSnapshot(
  snapshot: Pick<SnapshotRecord, "pages"> | null | undefined,
  targetUrl: string,
): string[] {
  if (!snapshot) return [];
  let home: string;
  try {
    const t = new URL(targetUrl);
    home = new URL(t.pathname.replace(/\/+$/, "") || "/", t.origin).toString();
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const page of snapshot.pages) {
    if (page.status === null || page.status >= 400) continue;
    if (page.path === "/") continue;
    let url: string;
    try {
      const u = new URL(page.url);
      url = new URL((u.pathname.replace(/\/+$/, "") || "/") + u.search, u.origin).toString();
    } catch {
      continue;
    }
    if (url === home) continue;
    out.add(url);
  }
  return [...out];
}

// ─── Feed line ───────────────────────────────────────────────────────────────

// One line for the owner, about their pages only (rule §1): what was seen and
// whether it moved. Nothing about how it was seen. A survey the cap cut short
// says so in the count ("the first 50 of a larger site") and still answers
// whether those pages changed (CHE-179).
export function surveyEvent(outcome: SurveyOutcome): Omit<RunEvent, "at" | "phase"> {
  const s = outcome.snapshot;
  if (!s || s.blocked) return { icon: "info", text: "Could not survey the pages this run" };
  const n = s.pages.length;
  const seen =
    `Surveyed ${n} page${n === 1 ? "" : "s"}` + (s.truncated ? ` (the first ${n} of a larger site)` : "");
  if (!outcome.previous) return { icon: "ok", text: `${seen} — first snapshot of this app` };
  // The last snapshot hashed pages the old way (CHE-185): nothing to compare
  // this once, and the pages are the baseline from here on. Said in terms of
  // their pages, not of what changed on our side.
  if (outcome.previous.digestVersion !== s.digestVersion) {
    return { icon: "ok", text: `${seen} — a new baseline for this app; changes are reported from the next check` };
  }
  if (s.changed === null) return { icon: "info", text: `${seen} — more pages than could be compared this run` };
  if (s.changed === false || !s.diff) {
    return { icon: "ok", text: `${seen} — nothing changed since the last check` };
  }
  return { icon: "notable", text: `${seen} — ${describeDiff(s.diff)}` };
}

// ─── Surveyed pages into the anatomy (CHE-132) ───────────────────────────────
// Labels take the shape coverage.ts reads — "Pricing (`/pricing`)" or just
// "`/pricing`" — and a page is skipped when the map already mentions its path
// in any spelling. Only pages that served (< 400), never the homepage (the
// coverage count excludes it anyway), and the list is capped so a 50-page
// sitemap does not bury the map discovery drew.

const ANATOMY_PAGE_CAP = 40;

export function mergeSurveyedPages(pages: string[], survey: SurveyOutcome | null): string[] {
  const snapshot = survey?.snapshot;
  if (!snapshot || snapshot.blocked) return pages;
  const out = [...pages];
  const known = pages.map((p) => p.toLowerCase());
  const mentioned = (path: string) => known.some((p) => p.includes(path));
  for (const page of snapshot.pages) {
    if (out.length >= ANATOMY_PAGE_CAP) break;
    if (page.status === null || page.status >= 400) continue;
    const path = page.path.split("?")[0].toLowerCase().replace(/\/+$/, "");
    if (!path || path === "/") continue;
    if (mentioned(path)) continue;
    const title = page.title.replace(/[`()]/g, "").trim().slice(0, 60);
    out.push(title ? `${title} (\`${path}\`)` : `\`${path}\``);
    known.push(path);
  }
  return out;
}
