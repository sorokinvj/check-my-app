// Loading the two numbers for a run's journeys (CHE-240).
//
// Kept apart from src/lib/journey-numbers.ts, which is pure and holds the
// language rules. This file only answers "what do we know about these
// journeys", so the page stays a rendering of facts and the sentences stay
// testable without a database.
//
// The measured number is the LATEST point for the journey, not the point from
// this run: a verdict page read a week later should show the most recent thing
// the customer's analytics said, and a run that could not ask (CHE-239 writes
// no row in that case) must not make an older, perfectly good measurement
// disappear from the page.

import type { PrismaClient } from "@/generated/prisma/client";
import type { NoMeasurement, OurJudgement, TheirMeasurement } from "./journey-numbers";

export interface JourneyNumbers {
  ours: OurJudgement;
  theirs: TheirMeasurement | null;
  /** Why there is no measured number. Null when `theirs` is present. */
  absent: NoMeasurement | null;
  /** Sample seen, when we counted and it was too small to report. */
  sample?: number;
}

export async function numbersForJourneys(
  db: PrismaClient,
  journeys: ReadonlyArray<{ id: string; appJourneyId: string | null }>,
): Promise<Record<string, JourneyNumbers>> {
  const ids = journeys.map((j) => j.appJourneyId).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return {};

  const catalog = await db.appJourney.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      price: true,
      conversion: true,
      funnelStages: true,
      app: { select: { posthogProjectId: true, team: { select: { posthog: { select: { id: true } } } } } },
      metricPoints: {
        orderBy: { measuredAt: "desc" },
        take: 1,
        select: { conversion: true, sampleSize: true, windowDays: true },
      },
    },
  });
  const byId = new Map(catalog.map((c) => [c.id, c]));

  const out: Record<string, JourneyNumbers> = {};
  for (const j of journeys) {
    const c = j.appJourneyId ? byId.get(j.appJourneyId) : undefined;
    if (!c) continue;

    const ours: OurJudgement = { price: c.price, conversion: c.conversion };
    const point = c.metricPoints[0];

    if (point?.conversion !== null && point !== undefined) {
      out[j.id] = {
        ours,
        theirs: { conversion: point.conversion, sample: point.sampleSize, windowDays: point.windowDays },
        absent: null,
      };
      continue;
    }

    // No usable number. WHICH absence it is decides the sentence, and the three
    // are different facts: nothing connected, nothing to measure along, or
    // counted and too few. An empty cell would read as a zero for all three.
    const connected = Boolean(c.app?.team?.posthog && c.app?.posthogProjectId);
    const absent: NoMeasurement = !connected
      ? "not_connected"
      : point
        ? // We counted and there were too few people. A real answer.
          "below_floor"
        : !c.funnelStages
          ? // Connected, but this journey has no measurable path (CHE-238).
            "no_funnel"
          : // Connected and measurable, but no point exists yet: no run has
            // asked, or the one that tried could not. Deliberately its own
            // sentence — calling this "not enough traffic" would state a fact
            // about the customer's users that we have not established.
            "not_measured_yet";
    out[j.id] = { ours, theirs: null, absent, sample: point?.sampleSize };
  }
  return out;
}
