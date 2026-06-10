import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { VERDICT_META } from "@/lib/status";
import { AppLensSection } from "@/components/app-lens";
import { JourneyStrips } from "@/components/journey-strip";
import { AppAnatomySection } from "@/components/app-anatomy";
import { FindingsList } from "@/components/findings-list";
import type { AppAnatomy, AppLens } from "@/lib/types";

// Screen 3 — Verdict · /verdict/{id} — the main artifact. Private permalink.
export default async function VerdictPage({ params }: { params: { id: string } }) {
  const run = await prisma.run.findUnique({
    where: { publicId: params.id },
    include: {
      journeys: { include: { steps: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
      findings: { orderBy: { number: "asc" } },
    },
  });
  if (!run) notFound();

  const verdictMeta = run.verdict ? VERDICT_META[run.verdict] : null;

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-12">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="mono text-lg">{run.appSlug}</h1>
          <p className="text-sm text-neutral-500">
            Checked {run.completedAt?.toLocaleString() ?? "—"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {verdictMeta && (
            <span className="text-sm font-medium">
              {verdictMeta.emoji} {verdictMeta.label}
            </span>
          )}
          <Link
            href={`/watch/${run.appSlug}`}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
          >
            Watch this daily
          </Link>
        </div>
      </header>

      <AppLensSection lens={run.appLens as AppLens | null} />
      <JourneyStrips journeys={run.journeys} />
      <AppAnatomySection anatomy={run.anatomy as AppAnatomy | null} />
      <FindingsList findings={run.findings} />

      <footer className="border-t border-neutral-200 pt-4 text-sm text-neutral-500">
        Want us to keep watching {run.appSlug}? Daily Watch re-runs every 24h and alerts on
        regressions. · Privacy: Private
      </footer>
    </main>
  );
}
