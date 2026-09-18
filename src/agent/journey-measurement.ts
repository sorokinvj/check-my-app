// Measure this run's journeys against the customer's own analytics (CHE-239).
//
// CHE-235 says what WE think a journey costs its user, judged by walking it.
// This says what their traffic actually did, counted from their own PostHog.
// The two live in different places on purpose (AppJourney.conversion vs
// JourneyMetricPoint) because a number whose provenance is ambiguous is worse
// than either: nobody can tell whether "12%" is something we decided or
// something that happened, and that changes what you do about it.
//
// Three contracts this file keeps, all of them load-bearing:
//
//   1. **A failure costs the measurement, never the run.** An outage at a third
//      party is not a fact about the customer's product. Nothing in here may
//      throw into the workflow; the verdict publishes exactly as it would have
//      (rule 4's instinct, one step out).
//
//   2. **Counts only.** No person, no property value, no identifier belonging
//      to one of the customer's users is read or stored. The query asks how
//      many, never who.
//
//   3. **Silence and "not enough" are different facts.** A journey we could not
//      measure writes no row. A journey we measured and found too small writes
//      a row with a sample size and no percentage. Collapsing those two would
//      make "no data" unreadable.

import type { AgentEnv } from "./env";
import { freshPostHogToken } from "@/lib/posthog/token";
import { baseUrlForRegion } from "@/lib/posthog/choices";
import { measureFunnel } from "@/lib/posthog/measure";
import { parseJson } from "@/lib/json";

export interface MeasurementSummary {
  measured: number;
  belowFloor: number;
  failed: number;
  skipped: number;
}

/**
 * Ask the customer's analytics about every journey this run walked that has a
 * funnel, and write one point each.
 *
 * Returns a summary for the run feed. Never throws.
 */
export async function measureRunJourneys(
  env: AgentEnv,
  runId: string,
  opts: { appUrl?: string; now?: Date } = {},
): Promise<MeasurementSummary> {
  const empty: MeasurementSummary = { measured: 0, belowFloor: 0, failed: 0, skipped: 0 };
  try {
    const run = await env.db.run.findUnique({
      where: { id: runId },
      select: { id: true, appId: true, app: { select: { teamId: true, posthogProjectId: true } } },
    });
    // No app row, no team, or no project chosen: nothing to measure and nothing
    // wrong. An app without analytics connected keeps our own estimate and is
    // never nagged (CHE-237).
    const projectId = run?.app?.posthogProjectId;
    const teamId = run?.app?.teamId;
    if (!run?.appId || !teamId || !projectId) return empty;

    const integration = await env.db.postHogIntegration.findFirst({ where: { teamId } });
    if (!integration) return empty;

    const appUrl = (opts.appUrl ?? "https://checkmyapp.dev").replace(/\/+$/, "");
    const access = await freshPostHogToken(env.db, integration, {
      clientId: `${appUrl}/.well-known/posthog-client.json`,
    });
    if (!access.ok) {
      // The connection needs a person. Say it in the log; it is not a fact
      // about the customer's product and must not reach their verdict.
      // `access` rather than `token` so no log line in this file can contain the
      // word next to an interpolation — the guard in verify-analytics-access.ts
      // is deliberately blunt, and a blunt guard is worth a rename (CHE-243).
      console.warn(`[measure] analytics unavailable: ${access.reason}`);
      return empty;
    }

    // Journeys this run actually walked, that have a funnel to measure along.
    const journeys = await env.db.journey.findMany({
      where: { runId, carriedFromRunId: null, appJourneyId: { not: null } },
      select: { appJourneyId: true, appJourney: { select: { id: true, title: true, funnelStages: true } } },
    });

    const baseUrl = baseUrlForRegion(integration.region);
    const summary = { ...empty };
    // One query per journey per run, and each funnel asked once: two journeys
    // that reduced to the same funnel are the same question.
    const asked = new Map<string, Awaited<ReturnType<typeof measureFunnel>>>();

    for (const j of journeys) {
      const aj = j.appJourney;
      const stages = parseJson<string[]>(aj?.funnelStages ?? null);
      if (!aj || !stages?.length) {
        summary.skipped++;
        continue;
      }
      const key = stages.join(">");
      let result = asked.get(key);
      if (!result) {
        result = await measureFunnel({ token: access.token, baseUrl, projectId, stages });
        asked.set(key, result);
      }

      if (!result.ok) {
        // We could not ask. No row: an absent point and a measured-but-small
        // point are different things and must not look the same.
        console.warn(`[measure] "${aj.title}": ${result.reason}`);
        summary.failed++;
        continue;
      }

      // Both branches write a row, and they differ only in whether there is a
      // percentage: "we counted and it is 12%" and "we counted and there were
      // only 25 people" are both answers. Only "we could not ask" writes none.
      const point = result.measurement
        ? {
            windowDays: result.measurement.windowDays,
            conversion: result.measurement.conversion,
            sampleSize: result.measurement.sample,
            steps: JSON.stringify(result.measurement.steps),
          }
        : {
            windowDays: result.windowDays,
            conversion: null,
            sampleSize: result.sample,
            // Counts are kept below the floor too: they need no denominator and
            // no minimum to be true, and they are what the page reports (CHE-287).
            steps: JSON.stringify(result.steps),
          };

      await env.db.journeyMetricPoint.create({
        data: { appJourneyId: aj.id, runId, measuredAt: opts.now ?? new Date(), source: "posthog", ...point },
      });
      if (result.measurement) summary.measured++;
      else summary.belowFloor++;
    }
    return summary;
  } catch (err) {
    // The swallow contract. A measurement is worth having and never worth a run.
    console.warn(`[measure] journey measurement failed: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}

/** One line for the run feed, or null when there was nothing to say. */
export function measurementNote(s: MeasurementSummary): string | null {
  if (s.measured === 0 && s.belowFloor === 0 && s.failed === 0) return null;
  const parts: string[] = [];
  if (s.measured) parts.push(`${s.measured} measured`);
  if (s.belowFloor) parts.push(`${s.belowFloor} without enough traffic to measure`);
  if (s.failed) parts.push(`${s.failed} we could not ask about`);
  return `Product metrics: ${parts.join(", ")}.`;
}
