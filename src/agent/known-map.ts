// Discovery with memory (CHE-133).
//
// Every full run used to start discovery from zero — up to 55 iterations,
// ~9% of a run's cost — although the app was mapped on its last full check.
// Partial runs already skip discovery outright (partial.ts reuses the map and
// the journey titles by name); a full run on a watched app should CONFIRM the
// known map, not redraw it. This module loads that map: the last walked run's
// anatomy plus its journeys with their step labels, in the shape the
// discovery prompt renders (instructions.ts, knownMapBlock).
//
// Memory applies to every full run of a watch, forceFull included. A full
// re-check means walk everything; it does not mean forget everything — the
// owner asking for a full walk wants every journey exercised today, and a map
// to confirm gets there sooner than a map to rediscover.
//
// Bias on every uncertainty, as in replay.ts and partial.ts: return null and
// let discovery map from scratch. A wrong map costs more than no map.

import { normalizeAnatomy } from "@/lib/anatomy";
import { parseJson } from "@/lib/json";
import type { KnownMap, ProposedJourney } from "./discovery";
import type { AgentEnv } from "./env";
import { findLastWalkedRun } from "./replay";
import { journeysForMap } from "./journey-catalog";

// Older than this and the map is more likely to mislead than to help: a
// product that has not been walked in a month has usually moved. Deliberately
// wider than FULL_RUN_MAX_AGE_DAYS — that bound governs what we may carry
// forward as evidence; this one only governs what we hand the model as a
// starting point it is told to confirm.
export const KNOWN_MAP_MAX_AGE_DAYS = 30;

// Same clip as partial.ts: a journey's step labels are a plan, not a
// transcript.
const MAX_KNOWN_STEPS = 12;

export async function loadKnownMap(
  env: AgentEnv,
  run: { watchId: string | null; appId?: string | null },
  now: Date = new Date(),
): Promise<KnownMap | null> {
  if (!run.watchId) return null;

  const walked = await findLastWalkedRun(env, run.watchId);
  // Undated evidence is unusable evidence (partial.ts says the same): without
  // a date we cannot tell the model — or ourselves — what "known" means.
  if (!walked?.completedAt) return null;
  const ageDays = (now.getTime() - walked.completedAt.getTime()) / 86_400_000;
  if (ageDays >= KNOWN_MAP_MAX_AGE_DAYS) return null;

  const anatomy = normalizeAnatomy(parseJson<unknown>(walked.anatomy));
  if (!anatomy) return null;

  // CHE-232: the app's journeys, not the last run's rows. The difference is
  // the whole point of the catalog — the last run walked whichever five
  // journeys it happened to propose, under whatever wording it reached for;
  // the catalog knows which journeys this app HAS. Best-established first
  // (most walks, then most recently walked), because the prompt shows five and
  // a journey walked twenty times is the one the model should keep calling by
  // its own name. Falls back to the old read for a run with no App row.
  const journeys =
    (run.appId ? await journeysForMap(env, run.appId, MAX_KNOWN_STEPS) : null) ??
    (await runJourneys(env, walked.id));

  return {
    runNumber: walked.runNumber,
    walkedAt: walked.completedAt.toISOString(),
    anatomy,
    journeys,
  };
}

// The pre-catalog read: the last walked run's rows, in the order it walked
// them. Still the answer for a run whose target has no App row.
async function runJourneys(env: AgentEnv, runId: string): Promise<ProposedJourney[]> {
  const rows = await env.db.journey.findMany({
    where: { runId },
    orderBy: { order: "asc" },
    select: {
      title: true,
      status: true,
      steps: { orderBy: { order: "asc" }, select: { label: true } },
    },
  });
  return rows
    // A skipped journey verified nothing last time; its plan is not a map of
    // anything we know works, so it is not offered as one to keep.
    .filter((j) => j.status !== "skipped")
    .map((j) => ({
      title: j.title,
      // An empty plan would give the model a title and nothing to confirm;
      // the title is a worse plan than real steps but a better one than none.
      steps: j.steps.length ? j.steps.map((s) => s.label).slice(0, MAX_KNOWN_STEPS) : [j.title],
    }));
}
