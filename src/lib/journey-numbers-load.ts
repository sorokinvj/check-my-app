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
import { parseJson } from "./json";
import { journeyPages } from "./journey-numbers";
import type { JourneyPages, NoMeasurement, OurJudgement, WalkedStage } from "./journey-numbers";

export interface JourneyNumbers {
  ours: OurJudgement;
  /** The pages of this journey and how many people were on them. */
  pages: (JourneyPages & { windowDays: number }) | null;
  /**
   * Did this walk actually finish the journey? (CHE-283)
   *
   * Only then may anything here speak about completion. A walk whose last step
   * was skipped never performed the finishing action, so its trail cannot hold
   * the completion page and its last stage is merely where we stopped. Eight of
   * sixteen journeys in production are in that state, on purpose: without test
   * credentials we check read-only rather than create records in someone's
   * product.
   */
  walkFinished: boolean;
  /** Why there is nothing measured. Null when `pages` is present. */
  absent: NoMeasurement | null;
  /** Sample seen, when we counted and it was too small to report. */
  sample?: number;
}

/**
 * The path our walk enters this app through, in the shape the stored stages use.
 *
 * Only the pathname, trailing slash trimmed, "/" preserved — the same normal
 * form `pagesWalked` produces. A mismatch here is harmless in one direction
 * (the entry page stays in the list and the reader sees one extra, true line)
 * and never invents a number in the other.
 */
function entryPathOf(targetUrl: string | null): string {
  if (!targetUrl) return "/";
  try {
    const p = new URL(targetUrl).pathname;
    const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
    return trimmed || "/";
  } catch {
    return "/";
  }
}

export async function numbersForJourneys(
  db: PrismaClient,
  journeys: ReadonlyArray<{ id: string; appJourneyId: string | null }>,
): Promise<Record<string, JourneyNumbers>> {
  const ids = journeys.map((j) => j.appJourneyId).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return {};

  // CHE-283: did each of these walks reach the end of its journey? The last
  // step tells us — skipped means the finishing action was never performed, so
  // nothing downstream may speak about completion. Read here, once, rather than
  // per journey: one query for the whole page.
  const lastSteps = await db.step.findMany({
    where: { journeyId: { in: journeys.map((j) => j.id) } },
    select: { journeyId: true, order: true, status: true },
    orderBy: { order: "desc" },
  });
  const finished = new Map<string, boolean>();
  for (const s of lastSteps) {
    // Rows arrive highest-order first, so the first one seen per journey is its
    // last step.
    if (!finished.has(s.journeyId)) finished.set(s.journeyId, s.status !== "skipped");
  }

  const catalog = await db.appJourney.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      price: true,
      conversion: true,
      funnelStages: true,
      app: {
        select: {
          posthogProjectId: true,
          // The address the walk starts from, so the entry page can be told
          // apart from the journey's own pages (CHE-287).
          targetUrl: true,
          team: { select: { posthog: { select: { id: true } } } },
        },
      },
      metricPoints: {
        orderBy: { measuredAt: "desc" },
        take: 1,
        // `steps` carries the stages as they were when the point was written,
        // which is the only honest source for the two ends of the counted path
        // (CHE-279): the journey's funnel may have been re-derived since, and
        // labelling an old count with today's stages would describe a path
        // nobody was counted along.
        select: { conversion: true, sampleSize: true, windowDays: true, steps: true },
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

    // What we show is the stages themselves, not a rate across them (CHE-287).
    // `steps` is the only honest source: it holds the stages as they were when
    // the count was taken, and a funnel re-derived since would describe a path
    // nobody was counted along. A point we cannot read the stages of says
    // nothing, rather than a number we cannot label.
    const stages = parseJson<WalkedStage[]>(point?.steps ?? null);
    const usable =
      Array.isArray(stages) &&
      stages.length > 0 &&
      stages.every((s) => typeof s?.stage === "string" && typeof s?.count === "number");
    if (point && usable) {
      const split = journeyPages(stages, entryPathOf(c.app?.targetUrl ?? null));
      // Every stage was the entry page: nothing of this journey's own was
      // counted, which is an absence rather than a number.
      if (split.own.length > 0) {
        out[j.id] = {
          ours,
          pages: { ...split, windowDays: point.windowDays },
          walkFinished: finished.get(j.id) ?? false,
          absent: null,
        };
        continue;
      }
    }

    // No usable number. WHICH absence it is decides the sentence, and the three
    // are different facts: nothing connected, nothing to measure along, or
    // counted and too few. An empty cell would read as a zero for all three.
    const connected = Boolean(c.app?.team?.posthog && c.app?.posthogProjectId);
    const absent: NoMeasurement = !connected
      ? "not_connected"
      : point && point.conversion === null
        ? // We counted and there were too few people. A real answer.
          // Keyed on the missing percentage rather than on the row existing: a
          // row whose percentage we hold but whose path we cannot name is a
          // different fact, and calling it "not enough traffic" would state
          // something about the customer's users that is not true (CHE-279).
          "below_floor"
        : !c.funnelStages
          ? // Connected, but this journey has no measurable path (CHE-238).
            "no_funnel"
          : // Connected and measurable, but no point exists yet: no run has
            // asked, or the one that tried could not. Deliberately its own
            // sentence — calling this "not enough traffic" would state a fact
            // about the customer's users that we have not established.
            "not_measured_yet";
    out[j.id] = {
      ours,
      pages: null,
      walkFinished: finished.get(j.id) ?? false,
      absent,
      sample: point?.sampleSize,
    };
  }
  return out;
}
