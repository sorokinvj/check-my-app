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
import {
  journeyKey,
  matchJourney,
  normalizeSurface,
  normalizeTitle,
  type JourneyCandidate,
} from "@/lib/journey-key";
import type { AgentEnv } from "./env";
import { decideMetric, type JourneyMetric, type RawMetric } from "./journey-metrics";

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
  surface?: string | null,
): Promise<ResolvedJourney> {
  const trimmed = title.trim();
  const where = normalizeSurface(surface);
  if (!run.appId) {
    return { appJourneyId: null, key: journeyKey(trimmed, [], where), isNew: false };
  }

  const rows = await env.db.appJourney.findMany({
    where: { appId: run.appId },
    orderBy: { createdAt: "asc" },
    select: { id: true, key: true, title: true, aliases: true, surface: true },
  });
  const candidates: Array<JourneyCandidate & { id: string }> = rows.map((r) => ({
    id: r.id,
    key: r.key,
    title: r.title,
    aliases: parseJson<string[]>(r.aliases) ?? [r.title],
    surface: r.surface,
  }));

  const hit = matchJourney(trimmed, candidates, where) as (JourneyCandidate & { id: string }) | null;
  if (hit) return { appJourneyId: hit.id, key: hit.key, isNew: false };

  const key = journeyKey(trimmed, candidates.map((c) => c.key), where);
  try {
    const created = await env.db.appJourney.create({
      data: {
        appId: run.appId,
        key,
        title: trimmed,
        aliases: JSON.stringify([trimmed]),
        ...(where ? { surface: where } : {}),
      },
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
    /** CHE-235: where the journey lives, when this run was told. */
    surface?: string | null;
    /** CHE-235: the price this run may record — already judged by journeyMetric. */
    metric?: JourneyMetric | null;
    at?: Date;
  },
): Promise<void> {
  if (!args.appJourneyId) return;
  const row = await env.db.appJourney.findUnique({
    where: { id: args.appJourneyId },
    select: {
      aliases: true,
      consecutiveBad: true,
      failingSince: true,
      surface: true,
      price: true,
      conversion: true,
    },
  });
  if (!row) return;

  const at = args.at ?? new Date();
  const walked = args.status !== "skipped";
  const healthy = HEALTHY.has(args.status);
  const consecutiveBad = !walked ? row.consecutiveBad : healthy ? 0 : row.consecutiveBad + 1;
  const metric = metricUpdate(row, args, at);

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
      // A surface we have been told sticks; one we have not been told never
      // overwrites what we know.
      ...(normalizeSurface(args.surface) && !row.surface
        ? { surface: normalizeSurface(args.surface) }
        : {}),
      consecutiveBad,
      failingSince: consecutiveBad === 0 ? null : (row.failingSince ?? at),
      // A journey that walked again is a journey the product still has.
      ...(walked ? { retiredAt: null, retiredReason: null } : {}),
      ...metric,
    },
  });
}

/**
 * CHE-235 — what this run may say a journey costs its user.
 *
 * The one place the rule is applied: what the model offered, judged against
 * what the catalog holds (journey-metrics.ts `decideMetric`). A changed number
 * whose note names no change is refused here, so the per-run row and the
 * catalog can never disagree about it — they both take this answer.
 *
 * Returns null when nothing should be written at all: a run with no numbers to
 * offer (every partial run, every model that skipped the field) leaves the
 * journey's price exactly as it was.
 */
export async function journeyMetric(
  env: AgentEnv,
  appJourneyId: string | null,
  raw: RawMetric | null | undefined,
): Promise<JourneyMetric | null> {
  if (!raw) return null;
  const previous = appJourneyId ? await storedMetric(env, appJourneyId) : null;
  const decision = decideMetric(raw, previous);
  console.log(`[journey] metric ${decision.kept ? "kept" : "taken"}: ${decision.reason}`);
  // A kept decision means "the stored value stands" — there is nothing new to
  // write, and writing the old value again would stamp it with today's run.
  return decision.kept ? null : decision.value;
}

async function storedMetric(env: AgentEnv, appJourneyId: string): Promise<JourneyMetric | null> {
  const row = await env.db.appJourney.findUnique({
    where: { id: appJourneyId },
    select: { price: true, conversion: true, metricNote: true },
  });
  if (!row || row.price === null || row.conversion === null) return null;
  return { price: row.price, conversion: row.conversion, note: row.metricNote ?? "" };
}

/**
 * The price/conversion half of a catalog update, from an answer `journeyMetric`
 * has already accepted. It never overwrites prevPrice/prevConversion when the
 * number did not actually move — so "6 → 8" survives a later run that merely
 * confirmed 8.
 */
function metricUpdate(
  row: { price: number | null; conversion: number | null },
  args: { metric?: JourneyMetric | null; runId: string },
  at: Date,
): Record<string, unknown> {
  const metric = args.metric;
  if (!metric) return {};
  const moved = row.price !== metric.price || row.conversion !== metric.conversion;
  return {
    price: metric.price,
    conversion: metric.conversion,
    metricNote: metric.note.slice(0, 300),
    metricRunId: args.runId,
    metricAt: at,
    ...(moved && row.price !== null && row.conversion !== null
      ? { prevPrice: row.price, prevConversion: row.conversion }
      : {}),
  };
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

/**
 * CHE-232 — every live journey of the app with the state a plan is made from.
 *
 * This is the catalog's answer to "what should tonight's run walk?", and it
 * replaces reading one baseline run's rows. The difference that matters is the
 * clock: a run's rows carry ONE date for every journey on them, so a journey
 * walked eleven days ago and one walked last night were indistinguishable.
 * Here each journey carries its own `lastWalkedAt`, which is what makes a
 * rotation possible at all.
 */
export interface CatalogJourneyState {
  appJourneyId: string;
  title: string;
  /** Ordered step labels from the last walk that produced any; may be empty. */
  plan: string[];
  /** The roll-up of the last walk, or null for a journey nothing has walked. */
  status: string | null;
  lastWalkedAt: Date | null;
  /** The run that actually walked it — where a carried copy's evidence comes from. */
  lastWalkedRunId: string | null;
  consecutiveBad: number;
}

/**
 * Whether this app's live catalog says the same thing once.
 *
 * Two rows with the same title are two rows for one journey — the identity
 * rules did not fold a rewording back into the journey it belongs to (CHE-247).
 * While that is true of an app, the number of journeys in its catalog is not
 * the number of journeys it has, and nothing may be claimed from that count:
 * "we could not cover this app" would be a statement about our own bookkeeping
 * wearing the shape of a coverage fact (rule 8).
 *
 * Deliberately the crudest possible test — exact title equality. It is the one
 * form of duplication we can be certain about without re-deciding identity
 * here, and CHE-247's own "how to know it is gone" is that no app's live
 * catalog holds two rows with the same title.
 */
export async function catalogIsDeduplicated(env: AgentEnv, appId: string): Promise<boolean> {
  const rows = await env.db.appJourney.findMany({
    where: { appId, retiredAt: null },
    select: { title: true },
  });
  const seen = new Set<string>();
  for (const r of rows) {
    const key = r.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export async function journeysForPlanning(env: AgentEnv, appId: string): Promise<CatalogJourneyState[]> {
  const rows = await env.db.appJourney.findMany({
    where: { appId, retiredAt: null },
    select: {
      id: true,
      title: true,
      plan: true,
      status: true,
      lastWalkedAt: true,
      lastWalkedRunId: true,
      consecutiveBad: true,
    },
  });
  return rows.map((r) => ({
    appJourneyId: r.id,
    title: r.title,
    plan: (parseJson<string[]>(r.plan) ?? []).filter((s) => typeof s === "string" && s.trim()),
    status: r.status,
    lastWalkedAt: r.lastWalkedAt ? new Date(r.lastWalkedAt) : null,
    lastWalkedRunId: r.lastWalkedRunId,
    consecutiveBad: r.consecutiveBad,
  }));
}

/**
 * CHE-232 — the app's journeys as a map to confirm (known-map.ts). Best
 * established first: a journey walked twenty times is the one discovery should
 * keep calling by its own name, and the prompt only shows the first few.
 * Null when the app has no usable journeys yet, so the caller falls back to
 * reading the last walked run instead of handing the model an empty map.
 *
 * A journey whose last walk verified nothing (status "skipped") is left out for
 * the same reason the run-row version leaves it out: its plan is not a map of
 * anything we know works.
 */
export async function journeysForMap(
  env: AgentEnv,
  appId: string,
  maxSteps: number,
): Promise<Array<{
  title: string;
  steps: string[];
  surface: string | null;
  metric: JourneyMetric | null;
}> | null> {
  const rows = await env.db.appJourney.findMany({
    where: { appId, retiredAt: null },
    orderBy: [{ walkCount: "desc" }, { lastWalkedAt: "desc" }],
    select: {
      title: true,
      status: true,
      plan: true,
      surface: true,
      price: true,
      conversion: true,
      metricNote: true,
    },
  });
  const journeys = rows
    .filter((j) => j.status !== "skipped")
    .map((j) => {
      const plan = (parseJson<string[]>(j.plan) ?? []).filter((s) => typeof s === "string" && s.trim());
      return {
        title: j.title,
        // A title is a worse plan than real steps and a much better one than none.
        steps: plan.length ? plan.slice(0, maxSteps) : [j.title],
        surface: j.surface,
        // CHE-235: what it cost last time, so the model answers "did this
        // change?" instead of inventing a number from scratch every run.
        metric:
          j.price !== null && j.conversion !== null
            ? { price: j.price, conversion: j.conversion, note: j.metricNote ?? "" }
            : null,
      };
    });
  return journeys.length ? journeys : null;
}

/**
 * CHE-232 — the app's journeys and how each one last ended, for the prompts'
 * knowledge block. Only journeys that were really walked: "how it ended" has no
 * answer for a journey nothing has ever walked.
 */
export async function journeysForKnowledge(
  env: AgentEnv,
  appId: string,
  take: number,
): Promise<Array<{ title: string; status: string; walkedAt: string }>> {
  const rows = await env.db.appJourney.findMany({
    where: { appId, retiredAt: null, lastWalkedAt: { not: null } },
    orderBy: [{ walkCount: "desc" }, { lastWalkedAt: "desc" }],
    take,
    select: { title: true, status: true, lastWalkedAt: true },
  });
  return rows
    .filter((j) => j.lastWalkedAt)
    .map((j) => ({
      title: j.title,
      status: j.status ?? "unknown",
      walkedAt: new Date(j.lastWalkedAt as Date).toISOString(),
    }));
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
