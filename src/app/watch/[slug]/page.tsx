import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { VERDICT_META } from "@/lib/status";
import { WatchSettings } from "@/components/watch-settings";

export const dynamic = "force-dynamic";

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

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
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="stagger space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Daily Watch — <span className="mono text-lg">{watch.appSlug}</span>
            </h1>
            <p className="mt-1.5 font-mono text-xs text-fg-faint">
              <span className={watch.active ? "text-status-ok" : "text-fg-faint"}>
                {watch.active ? "● Active" : "○ Paused"}
              </span>
              {" · "}Last checked{" "}
              {watch.lastRunAt?.toLocaleString([], DATE_FMT) ?? "never"}
              {" · "}Next {watch.nextRunAt?.toLocaleString([], DATE_FMT) ?? "—"}
            </p>
          </div>
        </header>

        <section>
          <h2 className="section-label mb-2.5">Recent runs</h2>
          <ul className="card divide-y divide-ink-700 overflow-hidden">
            {watch.runs.map((run) => {
              const meta = run.verdict ? VERDICT_META[run.verdict] : null;
              return (
                <li
                  key={run.id}
                  className="flex items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-ink-800/50"
                >
                  <span className="w-16 shrink-0 font-mono text-xs text-fg-faint">
                    {run.startedAt.toLocaleDateString([], { month: "short", day: "numeric" })}
                  </span>
                  <span className="flex-1">
                    {meta ? (
                      <span className={`font-mono text-xs ${meta.pillClassName.split(" ").pop()}`}>
                        {meta.emoji} {meta.label}
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-fg-faint">{run.status}</span>
                    )}
                  </span>
                  <Link
                    href={`/verdict/${run.publicId}`}
                    className="font-mono text-xs text-accent underline-offset-2 hover:underline"
                  >
                    view verdict
                  </Link>
                </li>
              );
            })}
            {watch.runs.length === 0 && (
              <li className="px-4 py-3 text-sm text-fg-faint">No runs yet.</li>
            )}
          </ul>
        </section>

        <WatchSettings
          slug={watch.appSlug}
          initial={{
            frequency: watch.frequency,
            notifyOnChangeOnly: watch.notifyOnChangeOnly,
            active: watch.active,
          }}
        />
      </div>
    </main>
  );
}
