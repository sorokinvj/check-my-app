import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { VERDICT_META } from "@/lib/status";
import { AppLensSection } from "@/components/app-lens";
import { JourneyStrips } from "@/components/journey-strip";
import { AppAnatomySection } from "@/components/app-anatomy";
import { FindingsList } from "@/components/findings-list";
import { EnableWatchButton, RecheckButton } from "@/components/verdict-actions";
import type { AppAnatomy, AppLens } from "@/lib/types";

export const dynamic = "force-dynamic";

function formatDuration(start: Date, end: Date | null): string | null {
  if (!end) return null;
  const mins = Math.round((end.getTime() - start.getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Screen 3 — Verdict · /verdict/{id} — the main artifact. Private permalink.
// Order is deliberate: Lens (mirror) → Journeys (centerpiece) → Anatomy →
// Findings (QA fallout) → Daily Watch footer.
export default async function VerdictPage({ params }: { params: { id: string } }) {
  const run = await prisma.run.findUnique({
    where: { publicId: params.id },
    include: {
      journeys: { include: { steps: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
      findings: { include: { evidence: true }, orderBy: { number: "asc" } },
      watch: { select: { active: true } },
    },
  });
  if (!run) notFound();

  const verdictMeta = run.verdict ? VERDICT_META[run.verdict] : null;
  const duration = formatDuration(run.startedAt, run.completedAt);
  const hasWatch = Boolean(run.watch?.active);
  const newerRun = await prisma.run.findFirst({
    where: { baselineRunId: run.id, status: { in: ["completed", "partial"] } },
    orderBy: { createdAt: "desc" },
    select: { publicId: true, completedAt: true },
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      {run.status === "partial" && (
        <p className="mb-4 rounded-lg border border-status-confusing/40 bg-status-confusing/10 px-4 py-2.5 text-sm text-status-confusing">
          The agent got partway through and paused — this is a partial verdict.
        </p>
      )}
      {newerRun && (
        <p className="mb-4 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2.5 text-sm text-accent">
          A newer run of this app exists —{" "}
          <Link href={`/verdict/${newerRun.publicId}`} className="underline underline-offset-2">
            view the latest verdict
          </Link>
        </p>
      )}

      <div className="stagger space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="mono text-xl text-fg">{run.appSlug}</h1>
            <p className="mt-1 font-mono text-xs text-fg-faint">
              Checked{" "}
              {run.completedAt?.toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }) ?? "—"}
              {duration && ` · ${duration}`} · Run #{run.runNumber}
            </p>
            {run.bottomLine && <p className="mt-2 text-sm text-fg-muted">{run.bottomLine}</p>}
          </div>
          <div className="flex items-center gap-2.5">
            {verdictMeta && (
              <span
                className={`rounded-full border px-3 py-1.5 font-mono text-sm font-medium ${verdictMeta.pillClassName}`}
              >
                {verdictMeta.emoji} {verdictMeta.label}
              </span>
            )}
            <RecheckButton runId={run.publicId} />
            <EnableWatchButton
              runId={run.publicId}
              hasWatch={hasWatch}
              appSlug={run.appSlug}
              variant="outline"
            />
          </div>
        </header>

        <AppLensSection
          runId={run.publicId}
          appSlug={run.appSlug}
          lens={run.appLens as AppLens | null}
          feedback={run.lensFeedback}
        />
        <JourneyStrips journeys={run.journeys} />
        <AppAnatomySection anatomy={run.anatomy as AppAnatomy | null} />
        <FindingsList findings={run.findings} />

        <footer className="card flex flex-wrap items-center justify-between gap-4 p-6">
          <div>
            <p className="font-medium text-fg">
              Want us to keep watching {run.appSlug}?
            </p>
            <p className="mt-0.5 text-sm text-fg-muted">
              Daily Watch — we re-run this every 24h, alert on regressions.
            </p>
          </div>
          <EnableWatchButton runId={run.publicId} hasWatch={hasWatch} appSlug={run.appSlug} />
        </footer>

        <p className="text-center font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint">
          run #{run.runNumber} · permalink · privacy: private
        </p>
      </div>
    </main>
  );
}
