import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { VERDICT_META } from "@/lib/status";

// Screen 4 — Watch settings · /watch/{slug}. Set-and-forget: status, recent runs,
// minimal settings. Only meaningful once a Watch exists for the app.
export default async function WatchPage({ params }: { params: { slug: string } }) {
  const watch = await prisma.watch.findUnique({
    where: { appSlug: params.slug },
    include: {
      runs: { orderBy: { startedAt: "desc" }, take: 10 },
    },
  });
  if (!watch) notFound();

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-12">
      <header>
        <h1 className="text-xl font-semibold">Daily Watch — {watch.appSlug}</h1>
        <p className="text-sm text-neutral-500">
          {watch.active ? "● Active" : "○ Paused"} · Last checked{" "}
          {watch.lastRunAt?.toLocaleString() ?? "never"} · Next{" "}
          {watch.nextRunAt?.toLocaleString() ?? "—"}
        </p>
      </header>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Recent runs
        </h2>
        <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 bg-white">
          {watch.runs.map((run) => {
            const meta = run.verdict ? VERDICT_META[run.verdict] : null;
            return (
              <li key={run.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <span>{run.startedAt.toLocaleDateString()}</span>
                <span>{meta ? `${meta.emoji} ${meta.label}` : run.status}</span>
                <a href={`/verdict/${run.publicId}`} className="text-blue-600 hover:underline">
                  view verdict
                </a>
              </li>
            );
          })}
          {watch.runs.length === 0 && (
            <li className="px-4 py-3 text-sm text-neutral-400">No runs yet.</li>
          )}
        </ul>
      </section>

      {/* TODO: frequency selector, notify toggles, edit credentials, pause/cancel. */}
    </main>
  );
}
