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
import { EnableWatchButton, FullRecheckButton, RecheckButton } from "@/components/verdict-actions";
import { ExportSpecs } from "@/components/export-specs";
import { canMutateOwned, getOptionalUser } from "@/lib/auth";
import { viewerCapabilities } from "@/lib/viewer-capabilities";
import type { AppLens, RunEvent } from "@/lib/types";
import { OG_IMAGE } from "@/lib/site-metadata";

export const dynamic = "force-dynamic";

function formatDuration(start: Date, end: Date | null): string | null {
  if (!end) return null;
  const mins = Math.round((end.getTime() - start.getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// CHE-108: a verdict link is the one people paste — into a post, a message, a
// thread with their team — and it used to arrive as a grey card carrying the
// site's generic tagline. It should say whose product was checked and how it
// came out.
//
// Named after the customer's product, never ours (rule §1): the only figure
// here is how many problems we found on it, and nothing about how we looked.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const run = await prisma.run.findUnique({
    where: { publicId: (await params).id },
    select: { appSlug: true, verdict: true, _count: { select: { findings: true } } },
  });
  if (!run) return {};

  const label = run.verdict ? (VERDICT_META[run.verdict]?.label ?? null) : null;
  const n = run._count.findings;
  const found =
    n === 0
      ? "Nothing to fix was found."
      : `${n} thing${n === 1 ? "" : "s"} to fix ${n === 1 ? "was" : "were"} found.`;

  const title = label ? `${run.appSlug} — ${label}` : run.appSlug;
  const description = `${found} Open the check to see what a visitor to ${run.appSlug} runs into, and where.`;
  // The image travels with the page: Next replaces the layout's openGraph
  // object wholesale, so leaving `images` out here meant no og:image at all.
  return {
    title,
    description,
    openGraph: { title, description, type: "article", images: [OG_IMAGE] },
    twitter: { card: "summary_large_image" as const, title, description, images: [OG_IMAGE.url] },
  };
}

// Screen 3 — Verdict · /verdict/{id} — the main artifact. Private permalink.
// Order is deliberate: Findings first (the owner opens a verdict to learn what's
// wrong — 2026-08-23) → Lens (mirror) → Journeys (centerpiece) → Anatomy →
// Daily Watch footer.
export default async function VerdictPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ watch_error?: string; recheck?: string }>;
}) {
  // CHE-75/94: the verdict actions bounce their outcomes back here as text —
  // a refusal the visitor can read beats a button that quietly does nothing.
  const { watch_error: watchError, recheck } = await searchParams;
  const recheckNotice =
    recheck === "reused"
      ? "This is the current verdict for this app — it was checked recently, so we're showing that result instead of spending a new check."
      : recheck === "notfound"
        ? "That run no longer exists."
        : (recheck ?? null);
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
  // CHE-108: a verdict link is public, and the owner's controls used to render
  // for whoever opened it — the server refused the click, which is a button
  // that does nothing, on our own page. Each control now appears only when the
  // server would honour it, computed with the same helpers the routes use
  // (rules in src/lib/viewer-capabilities.ts).
  const caps = viewerCapabilities({
    run: { ownerId: run.ownerId, hasWatch },
    viewer,
    viewerApp,
    canMutate: await canMutateOwned(prisma, run.ownerId),
  });
  // CHE-108: what a run cost us, which models produced it and which deploy it
  // ran against are OUR operating figures, and they belong to nobody outside
  // this business — not a stranger who opened a shared link, and not the
  // customer either. Owner rule, 2026-09-02: "зачем нашу кухню показывать
  // вообще кому либо кроме админам?" A customer paying $29 reading that their
  // check cost us $0.47 on opus is rule §1 in its purest form — our machinery,
  // arguing with their invoice on the next tab.
  const isAdmin = viewer?.role === "admin";
  // A replay-first smoke pass (CHE-51) finishes inside the "replay" phase and
  // never walks a journey — so the run's last event is a replay one. Any run
  // that fell through to the full check has later phases after it.
  const events = parseJson<RunEvent[]>(run.events) ?? [];
  const smokePass =
    run.journeys.length === 0 && events[events.length - 1]?.phase === "replay";
  // Carried journeys (CHE-57) name the run that actually walked them by id; the
  // chip shows its number. One query for the handful of distinct source runs —
  // usually exactly one, and none at all on a full run.
  const carriedRunIds = [
    ...new Set(run.journeys.map((j) => j.carriedFromRunId).filter((id): id is string => Boolean(id))),
  ];
  const carriedRunNumbers = Object.fromEntries(
    carriedRunIds.length
      ? (
          await prisma.run.findMany({
            where: { id: { in: carriedRunIds } },
            select: { id: true, runNumber: true },
          })
        ).map((r) => [r.id, r.runNumber])
      : [],
  );
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
        <header className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
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
                {/* CHE-108: what a run cost us, which models produced it and
                    which deploy it ran against are OUR machinery — rule §1, and
                    the worst of it is the model names arguing with $29 on the
                    next tab. The language gate only ever saw the verdict's text,
                    so the page chrome walked straight past it. Owner only. */}
                {isAdmin && run.costUsd != null && ` · $${run.costUsd.toFixed(2)}`}
                {isAdmin && run.deploySha &&
                  ` · deploy ${run.deploySha.slice(0, 7)}${run.deployEnv ? ` (${run.deployEnv})` : ""}`}
              </p>
              {isAdmin && totalTokens > 0 && (
                <p className="mt-0.5 font-mono text-xs text-fg-faint">
                  {fmtTok(totalTokens)} tokens
                  {byModel.map((m) => ` · ${m.model} $${m.costUsd.toFixed(2)}`).join("")}
                </p>
              )}
            </div>
            {(caps.recheck || caps.fullRecheck || caps.enableWatch || caps.watchSettings) && (
              <div className="flex shrink-0 items-center gap-2.5">
                {caps.recheck && <RecheckButton runId={run.publicId} />}
                {caps.fullRecheck && <FullRecheckButton runId={run.publicId} />}
                {(caps.enableWatch || caps.watchSettings) && (
                  <EnableWatchButton
                    runId={run.publicId}
                    hasWatch={hasWatch}
                    appSlug={run.appSlug}
                    variant="outline"
                  />
                )}
              </div>
            )}
          </div>

          {recheckNotice && (
            <p className="rounded-md border border-ink-600 bg-ink-800/60 px-3 py-2 text-sm text-fg-muted">
              {recheckNotice}
            </p>
          )}

          {watchError && (
            <p className="rounded-md border border-status-broken/40 bg-status-broken/10 px-3 py-2 text-sm text-status-broken">
              Couldn&apos;t enable Daily Watch: {watchError}
            </p>
          )}

          {/* The verdict and its reason are ONE unit: pill first, and the
              bottom line hangs off it as the labeled explanation (same visual
              language as the journey "why" callout). An unlabeled grey
              paragraph floating above the pill read as "о чем это описание?"
              — owner, 2026-08-23. */}
          {(verdictMeta || run.bottomLine) && (
            <div>
              {verdictMeta && (
                <span
                  className={`inline-block rounded-full border px-3 py-1.5 font-mono text-sm font-medium ${verdictMeta.pillClassName}`}
                >
                  {verdictMeta.emoji} {verdictMeta.label}
                </span>
              )}
              {run.bottomLine && (
                <p
                  className={`mt-2.5 rounded-r-md border-l-2 border-current/50 bg-ink-800/40 py-2 pl-3 pr-3 text-sm ${verdictMeta?.textClassName ?? "text-fg-muted"}`}
                >
                  <span className="font-medium">Bottom line:</span>{" "}
                  <span className="text-fg-muted">{run.bottomLine}</span>
                </p>
              )}
            </div>
          )}
        </header>

        <FindingsList
          findings={run.findings}
          canMark={caps.markFindings}
          canCreateTicket={caps.createTicket}
        />
        <AppLensSection
          runId={run.publicId}
          appSlug={run.appSlug}
          lens={parseJson<AppLens>(run.appLens)}
          feedback={run.lensFeedback}
        />
        <JourneyStrips
          journeys={run.journeys}
          carriedRunNumbers={carriedRunNumbers}
          emptyNote={
            smokePass
              ? "Not re-walked this run — the smoke check confirmed your known pages still load, " +
                "so we carried the previous verdict forward. The next full check walks them again."
              : undefined
          }
        />
        <AppAnatomySection anatomy={normalizeAnatomy(parseJson<unknown>(run.anatomy))} />

        {(caps.enableWatch || caps.watchSettings) && (
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
        )}

        {(generatedTests.length > 0 || run.transcriptUrl) && (
          <section className="card p-6">
            <h2 className="section-label">Run artifacts</h2>
            <p className="mt-1 text-sm text-fg-muted">
              The agent formalized this check as executable tests — take them into your own CI.
            </p>
            {/* Dozens of specs accumulate across runs; a flat list of them was
                the longest thing on the page (70+ rows on joblander.app by run
                #50) — collapsed by default, the count tells the story. */}
            {generatedTests.length > 0 && (
            <details className="mt-3">
              <summary className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-fg">
                <span className="chevron inline-block text-fg-faint">›</span>
                {generatedTests.length} Playwright spec{generatedTests.length === 1 ? "" : "s"}
              </summary>
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
            </ul>
            </details>
            )}
            {run.transcriptUrl && (
              <p className="mt-3 text-sm">
                <a
                  href={run.transcriptUrl}
                  className="font-mono text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  📋 agent transcript (audit log, .json)
                </a>
              </p>
            )}
            {generatedTests.length > 0 && caps.exportSpecs && (
              <ExportSpecs
                runId={run.publicId}
                connectedRepo={viewerApp?.repo?.repoFullName ?? null}
              />
            )}
          </section>
        )}

        <p className="text-center font-mono text-[11px] uppercase tracking-[0.18em] text-fg-faint">
          {/* CHE-108: "private" was false on every verdict — the route is not
              login-gated, anonymous verdicts are public by owner decision, and
              an owned one loads for anyone holding the link. Say which. */}
          run #{run.runNumber} · permalink · privacy:{" "}
          {run.ownerId ? "unlisted link" : "public"}
        </p>
      </div>
    </main>
  );
}
