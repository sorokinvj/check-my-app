// What moved, for the notification the Watch already sends (CHE-241).
//
// Not a second product. The same email, the same webhook, the same tracker
// path — a metric alert that arrives in its own channel is a channel nobody
// subscribes to, and the whole value of this is that it lands where the owner
// is already looking every morning.
//
// The judgement itself lives in src/lib/metric-movement.ts, which is pure and
// knows nothing about runs, verdicts or emails. That separation is the
// mechanism behind the ticket's last requirement: "a verdict of all good with a
// conversion that fell is not a contradiction and must not be smoothed into
// one." Nothing here consults the verdict, so nothing here can be overruled by
// it. The app works AND fewer people finish; both sentences stand.

import type { AgentEnv } from "./env";
import { isAlertable, movementOf, movementSentence, type MetricPoint } from "@/lib/metric-movement";
import { flowChanges, pairedSentence } from "@/lib/flow-changes";
import { pathEndsOf as measuredPath } from "@/lib/posthog/measure";
import { parseJson } from "@/lib/json";

/** How much history to read. Enough for a baseline, not enough to be slow. */
const POINTS_TO_READ = 12;

export interface MetricAlert {
  journeyTitle: string;
  /** The sentence the owner reads. Already rule-1 clean. */
  sentence: string;
}

/**
 * Journeys of this run whose measured conversion moved enough to say so.
 *
 * Returns only falls: a rise is good news and good news does not need a siren
 * (the sentence for it still exists, and belongs on the page rather than in
 * someone's inbox).
 *
 * Never throws. A movement we could not compute is one the owner does not hear
 * about — it is not a reason for a verdict email to fail.
 */
export async function metricAlertsForRun(env: AgentEnv, runId: string): Promise<MetricAlert[]> {
  try {
    const journeys = await env.db.journey.findMany({
      where: { runId, appJourneyId: { not: null } },
      select: {
        // CHE-242: this run's own view of the flow, for the half PostHog
        // cannot have. Read beside the numbers rather than in a second query,
        // because the two belong in one message.
        order: true,
        status: true,
        steps: { orderBy: { order: "asc" }, select: { label: true } },
        appJourney: {
          select: {
            title: true,
            price: true,
            prevPrice: true,
            plan: true,
            status: true,
            metricPoints: {
              orderBy: { measuredAt: "desc" },
              take: POINTS_TO_READ,
              // `steps` names the two pages the newest count was taken between.
              // The alert sentence says what moved along that path rather than
              // that fewer people finished, so it cannot be written without
              // them (CHE-279).
              select: { conversion: true, sampleSize: true, measuredAt: true, steps: true },
            },
          },
        },
      },
    });

    // A finding belongs to the run and points at its journey through `anchor`
    // — our own internal record of what it was allowed to rest on (CHE-215).
    // Only the finding's TITLE crosses into the message; the anchor never does.
    const findings = await env.db.finding.findMany({
      where: { runId, mark: { not: "false_positive" } },
      select: { title: true, anchor: true },
    });
    const titlesByJourneyIndex = new Map<number, string[]>();
    for (const f of findings) {
      const ref = parseJson<{ stepRef?: { journeyIndex?: number } }>(f.anchor)?.stepRef;
      if (typeof ref?.journeyIndex !== "number" || !f.title) continue;
      const list = titlesByJourneyIndex.get(ref.journeyIndex) ?? [];
      list.push(f.title);
      titlesByJourneyIndex.set(ref.journeyIndex, list);
    }

    const alerts: MetricAlert[] = [];
    const seen = new Set<string>();
    for (const j of journeys) {
      const aj = j.appJourney;
      if (!aj || seen.has(aj.title)) continue;
      seen.add(aj.title);

      const movement = movementOf(aj.metricPoints as MetricPoint[]);
      if (!isAlertable(movement)) continue;
      // No path, no alert. The movement may well be real, but a sentence that
      // cannot say which two pages it counted between gets read as "fewer
      // people finish this journey" — which is not what was counted (CHE-279).
      const path = measuredPath(aj.metricPoints[0]?.steps ?? null);
      if (!path) continue;
      const sentence = movementSentence(aj.title, movement, path);
      if (!sentence) continue;

      // CHE-242: the pairing. The number moved AND this is what changed in the
      // flow — or, said outright, that nothing did. The stored plan is what the
      // journey looked like before this walk; this run's step labels are what
      // it looks like now.
      const changes = flowChanges({
        price: aj.price,
        prevPrice: aj.prevPrice,
        plan: j.steps.map((s) => s.label).filter(Boolean),
        prevPlan: parseJson<string[]>(aj.plan) ?? [],
        status: j.status,
        prevStatus: aj.status,
        newFindings: (titlesByJourneyIndex.get(j.order) ?? []).slice(0, 2),
        // The survey's snapshot diff (CHE-132) is per-run and not joined here;
        // claiming "the page changed" without having compared the snapshots
        // would be asserting something we have not checked.
        pageChanged: false,
      });
      alerts.push({ journeyTitle: aj.title, sentence: pairedSentence(sentence, changes) });
    }
    return alerts;
  } catch (err) {
    console.warn(`[metric-alert] could not compute movements: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
