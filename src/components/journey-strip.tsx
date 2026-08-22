"use client";

import { useState } from "react";
import type { Journey, Step } from "@/generated/prisma/client";
import { STEP_STATUS_META } from "@/lib/status";

type JourneyWithSteps = Journey & { steps: Step[] };

// Verdict §3.2 — "WHAT YOUR USERS DO". The centerpiece: one horizontal strip per
// journey, each step a card with screenshot + label + status. Click a step to
// see what the agent tried, what happened, and the evidence. This is the
// screenshot people share — keep it beautiful.
export function JourneyStrips({
  journeys,
  emptyNote,
}: {
  journeys: JourneyWithSteps[];
  // Why there are no strips, when the run knows. A green verdict next to a bare
  // "no journeys" reads as a contradiction — a replay-first smoke pass (CHE-51)
  // says here that it carried the verdict forward without re-walking.
  emptyNote?: string;
}) {
  if (journeys.length === 0) {
    return (
      <section>
        <h2 className="section-label">What your users do</h2>
        <p className="mt-2 text-sm text-fg-faint">
          {emptyNote ?? "No journeys discovered yet."}
        </p>
      </section>
    );
  }
  return (
    <section className="space-y-5">
      <div>
        <h2 className="section-label">What your users do</h2>
        <p className="mt-1 text-sm text-fg-muted">
          We discovered {journeys.length} main user journey{journeys.length > 1 ? "s" : ""}.
          Here&apos;s how each one went.
        </p>
      </div>

      {journeys.map((journey, i) => (
        <JourneyCard key={journey.id} journey={journey} collapsedByDefault={i >= 2} />
      ))}
    </section>
  );
}

function JourneyCard({
  journey,
  collapsedByDefault,
}: {
  journey: JourneyWithSteps;
  collapsedByDefault: boolean;
}) {
  const [open, setOpen] = useState(!collapsedByDefault);
  const [selected, setSelected] = useState<Step | null>(null);
  const meta = STEP_STATUS_META[journey.status];

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-ink-800/50"
      >
        <h3 className="font-medium text-fg">
          <span className={`chevron mr-2 inline-block text-fg-faint ${open ? "rotate-90" : ""}`}>
            ›
          </span>
          {journey.order + 1}. {journey.title}
        </h3>
        <span
          className={`rounded-full border px-2.5 py-1 font-mono text-xs ${meta.className} border-current/30 bg-current/10`}
          style={{ borderColor: "color-mix(in srgb, currentColor 30%, transparent)" }}
        >
          {meta.emoji} {meta.label}
        </span>
      </button>

      {open && (
        <div className="border-t border-ink-700 px-5 py-4">
          {/* Storyboard discipline (NN/g, Playwright trace viewer): equal
              fixed-size cells top-aligned, caption in a fixed-height box below
              the frame, arrows on the thumbnail axis — caption length can
              never make the row ragged. Failed steps get a status ring;
              skipped ones dim. */}
          <div className="strip-scroll flex items-start gap-1 overflow-x-auto pb-2 pt-1">
            {journey.steps.map((step, i) => {
              const s = STEP_STATUS_META[step.status];
              const isSelected = selected?.id === step.id;
              const isFailed = step.status === "broken" || step.status === "exposed";
              const hasShot = Boolean(step.screenshotUrl);
              return (
                <div key={step.id} className="flex items-start">
                  {/* mt-12 ≈ card padding + half of the aspect-[16/10] thumb
                      on a w-40 cell — arrow points frame-to-frame. */}
                  {i > 0 && <span className="mx-1 mt-12 shrink-0 text-fg-faint">→</span>}
                  <button
                    onClick={() => setSelected(isSelected ? null : step)}
                    className={`w-40 shrink-0 rounded-lg border p-2 text-left transition-all ${
                      isSelected
                        ? "border-accent bg-ink-800 shadow-glow"
                        : "border-ink-700 bg-ink-900 hover:border-ink-600 hover:bg-ink-800"
                    } ${step.status === "skipped" ? "opacity-60" : ""}`}
                  >
                    {hasShot ? (
                      <div
                        className={`relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded bg-ink-950 ${
                          isFailed ? "ring-2 ring-status-broken" : ""
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={step.screenshotUrl!}
                          alt={step.label}
                          className={`h-full w-full object-cover object-top ${
                            step.status === "skipped" ? "grayscale" : ""
                          }`}
                        />
                        <span
                          className={`absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-ink-950 ${s.dotClassName}`}
                        >
                          {s.emoji}
                        </span>
                      </div>
                    ) : (
                      // Non-visual step (an assertion / check with no meaningful
                      // screenshot): a status chip on a dashed frame, not a fake
                      // photo box that reads as a broken image.
                      <div
                        className={`flex aspect-[16/10] items-center justify-center gap-1.5 rounded border border-dashed ${
                          isFailed ? "border-status-broken/60" : "border-ink-600"
                        } bg-ink-900`}
                      >
                        <span className={`text-base ${s.className}`}>{s.emoji}</span>
                        <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                          {s.label}
                        </span>
                      </div>
                    )}
                    <p className="mt-1.5 line-clamp-2 h-8 text-[11px] leading-4 text-fg-muted">
                      {step.label}
                    </p>
                  </button>
                </div>
              );
            })}
          </div>

          {selected && <StepDetail step={selected} />}

          {journey.summary && (
            /* Takeaway zone (NN/g "insights"): full-width bar with a left
               accent in the journey's worst status color — a verdict line,
               not another step caption. */
            <p
              className={`mt-3 rounded-r-md border-l-2 border-current/50 bg-ink-800/40 py-2 pl-3 pr-3 text-sm text-fg-muted ${meta.className}`}
            >
              <span className="font-medium">What we found:</span>{" "}
              <span className="text-fg-muted">{journey.summary}</span>
            </p>
          )}

          {journey.videoUrl && (
            <a
              href={journey.videoUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-ink-600 px-3 py-2 font-mono text-xs text-fg-muted transition-colors hover:border-ink-700 hover:text-fg"
            >
              ▶ Watch the agent go through this journey
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// Inline expansion for a clicked step-card: what we tried / what happened /
// console / network excerpts.
function StepDetail({ step }: { step: Step }) {
  const s = STEP_STATUS_META[step.status];
  return (
    <div className="mt-2 animate-fade-up rounded-lg border border-ink-700 bg-ink-900 p-4">
      <p className={`font-mono text-xs ${s.className}`}>
        {s.emoji} {s.label} — {step.label}
      </p>
      <div className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
        {step.attempted && (
          <div>
            <p className="section-label mb-1">What we tried</p>
            <p className="text-fg-muted">{step.attempted}</p>
          </div>
        )}
        {step.observed && (
          <div>
            <p className="section-label mb-1">What happened</p>
            <p className="text-fg-muted">{step.observed}</p>
          </div>
        )}
      </div>
      {step.consoleLog && (
        <pre className="mt-3 overflow-x-auto rounded bg-ink-950 p-3 font-mono text-xs leading-5 text-fg-faint">
          {step.consoleLog}
        </pre>
      )}
      {step.networkLog && (
        <pre className="mt-2 overflow-x-auto rounded bg-ink-950 p-3 font-mono text-xs leading-5 text-fg-faint">
          {step.networkLog}
        </pre>
      )}
    </div>
  );
}
