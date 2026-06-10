import type { Journey, Step } from "@prisma/client";
import { STEP_STATUS_META } from "@/lib/status";

type JourneyWithSteps = Journey & { steps: Step[] };

// Verdict §3.2 — "WHAT YOUR USERS DO". The centerpiece: one horizontal strip per
// journey, each step a card with screenshot + label + status. This is the share
// moment — make it beautiful when it graduates from skeleton.
export function JourneyStrips({ journeys }: { journeys: JourneyWithSteps[] }) {
  if (journeys.length === 0) {
    return <p className="text-sm text-neutral-400">No journeys discovered yet.</p>;
  }
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          What your users do
        </h2>
        <p className="text-sm text-neutral-500">
          We discovered {journeys.length} main user journeys. Here&apos;s how each went.
        </p>
      </div>

      {journeys.map((journey) => {
        const meta = STEP_STATUS_META[journey.status];
        return (
          <div key={journey.id} className="rounded-xl border border-neutral-200 bg-white p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-medium">
                {journey.order + 1}. {journey.title}
              </h3>
              <span className={`text-sm font-medium ${meta.className}`}>
                {meta.emoji} {meta.label}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              {journey.steps.map((step) => {
                const s = STEP_STATUS_META[step.status];
                return (
                  <div
                    key={step.id}
                    className="w-28 shrink-0 rounded-lg border border-neutral-200 p-2"
                    title={step.observed ?? undefined}
                  >
                    <div className="flex h-16 items-center justify-center rounded bg-neutral-100 text-lg">
                      {s.emoji}
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-xs text-neutral-600">
                      {step.label}
                    </p>
                  </div>
                );
              })}
            </div>

            {journey.summary && (
              <p className="mt-3 text-sm text-neutral-600">
                What we found: {journey.summary}
              </p>
            )}
            {/* TODO: [▶ Watch the agent go through this journey] video player. */}
          </div>
        );
      })}
    </section>
  );
}
