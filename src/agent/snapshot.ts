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
//   - nothing to compare (first snapshot, a blocked homepage, a survey the
//     cap or the deadline cut short, a survey that errored) → the old
//     seven-day fuse, exactly as before.
//
// "Previous" is the last snapshot that CAN be compared against — blocked and
// truncated rows are skipped, not compared: a page the survey never reached
// is unknown, not removed, and reading it as removed would force a full walk
// on every slow or large app every day, which is the calendar back under
// another name.
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
  previousId: string | null;
  changed: boolean | null;
  diff: SnapshotDiff | null;
}

export interface SurveyOutcome {
  snapshot: SnapshotRecord | null;
  previous: SnapshotRecord | null;
  /** A comparable previous exists and this survey saw everything — `snapshot.changed` is an answer, not null. */
  comparable: boolean;
}

/** Whether this survey can be read against an earlier one at all. */
export function isComparable(
  previous: SnapshotRecord | null,
  current: { blocked: boolean; truncated: boolean },
): boolean {
  return Boolean(previous && !previous.blocked && !previous.truncated && !current.blocked && !current.truncated);
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
  return {
    id: row.id,
    appSlug: row.appSlug,
    runId: row.runId,
    takenAt: row.takenAt.toISOString(),
    fingerprint: row.fingerprint,
    pages: parseJson<SurveyPage[]>(row.pages) ?? [],
    bundles: parseJson<string[]>(row.bundles) ?? [],
    buildId: row.buildId,
    tech: parseJson<string[]>(row.tech) ?? [],
    sitemapUrls: row.sitemapUrls,
    blocked: row.blocked,
    truncated: row.truncated,
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
  const previousRow = await env.db.appSnapshot.findFirst({
    where: {
      ...(run.appId ? { appId: run.appId } : { appSlug: run.appSlug, appId: null }),
      blocked: false,
      truncated: false,
    },
    orderBy: { takenAt: "desc" },
  });
  const previous = previousRow ? toRecord(previousRow) : null;

  const comparable = isComparable(previous, survey);
  const diff = comparable && previous ? diffSnapshots(previous, survey) : null;
  const changed = diff ? diffIsChange(diff) : null;

  const row = await env.db.appSnapshot.create({
    data: {
      appSlug: run.appSlug,
      appId: run.appId,
      runId: run.id,
      fingerprint: survey.fingerprint,
      pages: JSON.stringify(survey.pages),
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
// whether it moved. Nothing about how it was seen.
export function surveyEvent(outcome: SurveyOutcome): Omit<RunEvent, "at" | "phase"> {
  const s = outcome.snapshot;
  if (!s || s.blocked) return { icon: "info", text: "Could not survey the pages this run" };
  const n = s.pages.length;
  const seen = `Surveyed ${n} page${n === 1 ? "" : "s"}`;
  if (s.truncated) return { icon: "info", text: `${seen} — more pages than could be compared this run` };
  if (!outcome.previous) return { icon: "ok", text: `${seen} — first snapshot of this app` };
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
