import { notFound } from "next/navigation";
import Link from "next/link";
import { getDbFromContext } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { normalizeAnatomy } from "@/lib/anatomy";
import { VERDICT_META } from "@/lib/status";
import { AppLensSection } from "@/components/app-lens";
import { JourneyStrips } from "@/components/journey-strip";
import { AppAnatomySection } from "@/components/app-anatomy";
import { FindingsList } from "@/components/findings-list";
import { EnableWatchButton, RecheckButton } from "@/components/verdict-actions";
import { ExportSpecs } from "@/components/export-specs";
import { getOptionalUser } from "@/lib/auth";
import type { AppLens } from "@/lib/types";

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
export default async function VerdictPage({ params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const run = await prisma.run.findUnique({
    where: { publicId: (await params).id },
    include: {
      journeys: { include: { steps: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
      findings: { include: { evidence: true }, orderBy: { number: "asc" } },
      watch: { select: { active: true } },
      llmUsage: true,
    },
  });
  if (!run) notFound();

  const verdictMeta = run.verdict ? VERDICT_META[run.verdict] : null;
  const duration = formatDuration(run.startedAt, run.completedAt);
  // Tokens-model-money — the primary metric. Ledger rows when present (new
  // runs), Run.costUsd alone for runs that predate the LlmUsage table.
  const totalTokens = run.llmUsage.reduce(
    (s, u) => s + u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens + u.outputTokens,
    0,
  );
  const byModel = [...new Set(run.llmUsage.map((u) => u.model))].map((model) => ({
    model: model.replace(/^claude-/, "").replace(/-[\d-]+$/, ""),
    costUsd: run.llmUsage.filter((u) => u.model === model).reduce((s, u) => s + u.costUsd, 0),
  }));
  const fmtTok = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;
  const hasWatch = Boolean(run.watch?.active);
  const generatedTests = await prisma.generatedTest.findMany({
    where: { appSlug: run.appSlug },
    orderBy: [{ title: "asc" }, { version: "desc" }],
    distinct: ["title"],
  });
  // If the signed-in viewer owns this target, surface their GitHub connection
  // so "Export to GitHub" renders in its connected state. Anonymous viewers get
  // the connect path (the export API redirects them to sign-in).
  const viewer = await getOptionalUser(prisma);
  const viewerApp = viewer
    ? await prisma.app.findUnique({
        where: { ownerId_appSlug: { ownerId: viewer.id, appSlug: run.appSlug } },
        include: { repo: { select: { repoFullName: true } } },
      })
    : null;
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
              {run.costUsd != null && ` · $${run.costUsd.toFixed(2)}`}
            </p>
            {totalTokens > 0 && (
              <p className="mt-0.5 font-mono text-xs text-fg-faint">
                {fmtTok(totalTokens)} tokens
                {byModel.map((m) => ` · ${m.model} $${m.costUsd.toFixed(2)}`).join("")}
              </p>
            )}
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
          lens={parseJson<AppLens>(run.appLens)}
          feedback={run.lensFeedback}
        />
        <JourneyStrips journeys={run.journeys} />
        <AppAnatomySection anatomy={normalizeAnatomy(parseJson<unknown>(run.anatomy))} />
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

        {(generatedTests.length > 0 || run.transcriptUrl) && (
          <section className="card p-6">
            <h2 className="section-label">Run artifacts</h2>
            <p className="mt-1 text-sm text-fg-muted">
              The agent formalized this check as executable tests — take them into your own CI.
            </p>
            <ul className="mt-3 space-y-2">
              {generatedTests.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <span
                    className={`font-mono text-xs ${
                      t.lastRunStatus === "passed"
                        ? "text-status-ok"
                        : t.lastRunStatus === "failed"
                          ? "text-status-broken"
                          : "text-fg-faint"
                    }`}
                  >
                    {t.lastRunStatus === "passed" ? "✓" : t.lastRunStatus === "failed" ? "✕" : "—"}{" "}
                    {t.lastRunStatus.replace("_", " ")}
                  </span>
                  <a
                    href={`/api/tests/${t.id}`}
                    className="font-mono text-xs text-accent underline-offset-2 hover:underline"
                  >
                    {t.title} · v{t.version} (.spec.ts)
                  </a>
                  <span className="font-mono text-[10px] text-fg-faint">
                    sha256 {t.sha256.slice(0, 12)}…
                  </span>
                </li>
              ))}
              {run.transcriptUrl && (
                <li className="text-sm">
                  <a
                    href={run.transcriptUrl}
                    className="font-mono text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                  >
                    📋 agent transcript (audit log, .json)
                  </a>
                </li>
              )}
            </ul>
            {generatedTests.length > 0 && (
              <ExportSpecs
                runId={run.publicId}
                connectedRepo={viewerApp?.repo?.repoFullName ?? null}
              />
            )}
          </section>
        )}

        <p className="text-center font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint">
          run #{run.runNumber} · permalink · privacy: private
        </p>
      </div>
    </main>
  );
}
