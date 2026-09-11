import Link from "next/link";
import { getDbFromContext } from "@/lib/db";
import { VERDICT_META } from "@/lib/status";

export const dynamic = "force-dynamic";

// CHE-108: the home page used to redirect straight into the submit form — a
// visitor who wasn't ready to type in their own URL got nothing to look at.
// Now it shows the latest real self-check (checkmyapp.dev) and links to its
// verdict, so someone can read what a check produces before committing theirs.
export default async function Home() {
  let sample: {
    publicId: string;
    verdict: string | null;
    bottomLine: string | null;
    appSlug: string;
  } | null = null;

  try {
    const prisma = await getDbFromContext();
    sample = await prisma.run.findFirst({
      where: { appSlug: "checkmyapp.dev", status: "completed" },
      orderBy: { completedAt: "desc" },
      select: { publicId: true, verdict: true, bottomLine: true, appSlug: true },
    });
  } catch {
    // If the DB binding is unavailable the page still renders — just without
    // the sample card.
  }

  const meta = sample?.verdict ? VERDICT_META[sample.verdict] : null;

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-3xl flex-col items-center justify-center px-4 py-16 text-center">
      <p className="section-label">check an app</p>
      <h1 className="mt-3 text-balance text-5xl font-semibold tracking-tight">
        What would a first-time visitor find?
      </h1>
      <p className="mt-4 max-w-xl text-[15px] leading-7 text-fg-muted">
        Paste a link. An AI agent walks your app the way a new user would — signs
        up, tries the core journey, pokes at the edges — then shows you what&apos;s
        broken, confusing, missing or exposing you.
      </p>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
        <Link
          href="/check"
          className="rounded-lg bg-accent px-6 py-3 font-mono text-sm font-semibold text-ink-950 transition hover:bg-accent/90"
        >
          Check your app
        </Link>
        {sample && (
          <Link
            href={`/verdict/${sample.publicId}`}
            className="rounded-lg border border-ink-700 px-6 py-3 font-mono text-sm text-fg transition hover:bg-ink-800"
          >
            See a real check
          </Link>
        )}
      </div>

      {sample && (
        <div className="mt-10 w-full max-w-xl rounded-lg border border-ink-800 p-5 text-left">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-fg-muted">
            Latest real check — {sample.appSlug}
          </p>
          {meta && (
            <p className={`mt-2 font-mono text-sm font-medium ${meta.textClassName}`}>
              {meta.emoji} {meta.label}
            </p>
          )}
          {sample.bottomLine && (
            <p className="mt-2 text-sm text-fg-muted">{sample.bottomLine}</p>
          )}
          <Link
            href={`/verdict/${sample.publicId}`}
            className="mt-3 inline-block font-mono text-xs uppercase tracking-[0.18em] text-accent hover:underline"
          >
            Read the full check →
          </Link>
        </div>
      )}
    </main>
  );
}
