// The journey catalog (CHE-231) — reads and writes of AppJourney.
//
// A run no longer invents its journeys: it resolves each one to a row that
// belongs to the app and outlives the run, then writes back what the walk
// learned. Everything here is deliberately small and swallow-free at the
// boundaries the caller controls:
//
//   - resolveJourney never throws on a losing race. Two Workflow steps walking
//     two journeys of the same app can create catalog rows at the same time;
//     the unique (appId, key) index decides, and the loser re-reads.
//   - recordWalk / recordCarry are best-effort by contract: the catalog is how
//     we remember, never how a run succeeds. A failure there is logged and the
//     run continues with its own rows intact (see the call sites).
//
// Identity itself lives in src/lib/journey-key.ts (pure, verified against
// production titles by scripts/verify-journey-identity.ts). Nothing in this
// file decides what a journey IS — it only stores the answer.

import { parseJson } from "@/lib/json";
import { journeyKey, matchJourney, normalizeTitle, type JourneyCandidate } from "@/lib/journey-key";
import type { AgentEnv } from "./env";

/** The statuses that mean the journey is in good shape (partial.ts agrees). */
const HEALTHY = new Set(["ok", "partial"]);

/** How many aliases a row keeps. Long enough to audit a merge, bounded so one
 *  app's row cannot grow without limit. Oldest wording is dropped first — the
 *  canonical title is stored separately and never lost. */
const MAX_ALIASES = 40;

export interface ResolvedJourney {
  /** Catalog row id, or null when the run has no App to hang a catalog off. */
  appJourneyId: string | null;
  /** The identity, always present — even for anonymous runs. */
  key: string;
  /** True when this run is the first time we have seen this journey. */
  isNew: boolean;
}

/**
 * The catalog row for a proposed journey title, created if this is a journey we
 * have not seen. Runs without an App (anonymous one-off checks, PR previews)
 * get the key and no row: there is no history for them to accumulate.
 */
export async function resolveJourney(
  env: AgentEnv,
  run: { appId?: string | null },
  title: string,
): Promise<ResolvedJourney> {
  const trimmed = title.trim();
  if (!run.appId) {
    return { appJourneyId: null, key: journeyKey(trimmed), isNew: false };
  }

  const rows = await env.db.appJourney.findMany({
    where: { appId: run.appId },
    orderBy: { createdAt: "asc" },
    select: { id: true, key: true, title: true, aliases: true },
  });
  const candidates: Array<JourneyCandidate & { id: string }> = rows.map((r) => ({
    id: r.id,
    key: r.key,
    title: r.title,
    aliases: parseJson<string[]>(r.aliases) ?? [r.title],
  }));

  const hit = matchJourney(trimmed, candidates) as (JourneyCandidate & { id: string }) | null;
  if (hit) return { appJourneyId: hit.id, key: hit.key, isNew: false };

  const key = journeyKey(trimmed, candidates.map((c) => c.key));
  try {
    const created = await env.db.appJourney.create({
      data: { appId: run.appId, key, title: trimmed, aliases: JSON.stringify([trimmed]) },
    });
    return { appJourneyId: created.id, key, isNew: true };
  } catch {
    // Lost the race against another journey of the same run (or a retry of this
    // one). The unique index already holds the answer — read it back rather
    // than inventing a second identity for the same journey.
    const existing = await env.db.appJourney.findFirst({
      where: { appId: run.appId, key },
      select: { id: true },
    });
    if (existing) return { appJourneyId: existing.id, key, isNew: false };
    return { appJourneyId: null, key, isNew: false };
  }
}

/**
 * What the walk learned about this journey. Called after the per-run Journey row
 * is finished, with the status that landed on it.
 *
 * Two things this must never do, because both would turn the catalog into a
 * claim we cannot back: it never records a walk that did not happen (a carried
 * journey goes through recordCarry), and it never moves lastWalkedAt for a
 * journey that verified nothing (an all-skipped walk).
 */
export async function recordWalk(
  env: AgentEnv,
  args: {
    appJourneyId: string | null;
    runId: string;
    runNumber: number;
    title: string;
    status: string;
    /** Step labels this walk produced, in order. Empty = keep the stored plan. */
    plan: string[];
    at?: Date;
  },
): Promise<void> {
  if (!args.appJourneyId) return;
  const row = await env.db.appJourney.findUnique({
    where: { id: args.appJourneyId },
    select: { aliases: true, consecutiveBad: true, failingSince: true },
  });
  if (!row) return;

  const at = args.at ?? new Date();
  const walked = args.status !== "skipped";
  const healthy = HEALTHY.has(args.status);
  const consecutiveBad = !walked ? row.consecutiveBad : healthy ? 0 : row.consecutiveBad + 1;

  await env.db.appJourney.update({
    where: { id: args.appJourneyId },
    data: {
      title: args.title.trim(),
      aliases: JSON.stringify(withAlias(parseJson<string[]>(row.aliases) ?? [], args.title)),
      status: args.status,
      lastRunId: args.runId,
      lastRunNumber: args.runNumber,
      ...(walked
        ? { lastWalkedAt: at, lastWalkedRunId: args.runId, walkCount: { increment: 1 } }
        : {}),
      ...(args.plan.length ? { plan: JSON.stringify(args.plan) } : {}),
      consecutiveBad,
      failingSince: consecutiveBad === 0 ? null : (row.failingSince ?? at),
      // A journey that walked again is a journey the product still has.
      ...(walked ? { retiredAt: null, retiredReason: null } : {}),
    },
  });
}

/**
 * A journey this run carried forward instead of walking (partial.ts). It says
 * "this run had this journey", and deliberately nothing about verification:
 * lastWalkedAt, walkCount and the failure streak all stay where the real walk
 * left them.
 */
export async function recordCarry(
  env: AgentEnv,
  args: { appJourneyId: string | null; runId: string; runNumber: number },
): Promise<void> {
  if (!args.appJourneyId) return;
  await env.db.appJourney.update({
    where: { id: args.appJourneyId },
    data: { lastRunId: args.runId, lastRunNumber: args.runNumber },
  });
}

/**
 * What this check cost, on the check and on the journey's running total. Split
 * from recordWalk because the walk's cost is final only after its Workflow step
 * returns (the judge's tokens land last), and the journey — not the run — is
 * the unit we want that number against.
 */
export async function recordJourneyCost(
  env: AgentEnv,
  args: { journeyId: string; appJourneyId: string | null; costUsd: number },
): Promise<void> {
  const cost = round6(Math.max(0, args.costUsd));
  await env.db.journey.update({ where: { id: args.journeyId }, data: { costUsd: cost } });
  if (!args.appJourneyId || cost === 0) return;
  await env.db.appJourney.update({
    where: { id: args.appJourneyId },
    data: { costUsd: { increment: cost } },
  });
}

/** The app's live journeys, oldest first — the shape planning reads (CHE-232). */
export async function listJourneys(env: AgentEnv, appId: string) {
  return env.db.appJourney.findMany({
    where: { appId, retiredAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      key: true,
      title: true,
      plan: true,
      status: true,
      lastWalkedAt: true,
      lastWalkedRunId: true,
      walkCount: true,
      consecutiveBad: true,
      failingSince: true,
    },
  });
}

/** Aliases, newest wording last, deduped on the normalised form, bounded. */
export function withAlias(existing: string[], title: string): string[] {
  const trimmed = title.trim();
  if (!trimmed) return existing;
  const normalized = normalizeTitle(trimmed);
  const kept = existing.filter((a) => normalizeTitle(a) !== normalized);
  kept.push(trimmed);
  return kept.slice(-MAX_ALIASES);
}

/** USD, six decimals — enough for a $0.0004 judge call, short of float noise. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
