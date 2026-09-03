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
  run: { watchId: string | null },
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

  const rows = await env.db.journey.findMany({
    where: { runId: walked.id },
    orderBy: { order: "asc" },
    select: {
      title: true,
      status: true,
      steps: { orderBy: { order: "asc" }, select: { label: true } },
    },
  });
  const journeys: ProposedJourney[] = rows
    // A skipped journey verified nothing last time; its plan is not a map of
    // anything we know works, so it is not offered as one to keep.
    .filter((j) => j.status !== "skipped")
    .map((j) => ({
      title: j.title,
      // An empty plan would give the model a title and nothing to confirm;
      // the title is a worse plan than real steps but a better one than none.
      steps: j.steps.length ? j.steps.map((s) => s.label).slice(0, MAX_KNOWN_STEPS) : [j.title],
    }));

  return {
    runNumber: walked.runNumber,
    walkedAt: walked.completedAt.toISOString(),
    anatomy,
    journeys,
  };
}
