import Link from "next/link";

// Landing page — a visitor who gives nothing can see what a real check looks like.
// CHE-108: the demo verdict is a real check of joblander.app, not a mock-up.
export default function Home() {
  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4 py-16">
      <div className="mx-auto max-w-lg space-y-8 text-center">
        <div className="space-y-4">
          <h1 className="text-4xl font-bold tracking-tight text-fg">
            See what your visitors see
          </h1>
          <p className="text-lg leading-relaxed text-fg-muted">
            Paste a link and we check your app the way a person would — then tell you
            what a visitor hits.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/check"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-[15px] font-semibold text-ink-950 transition-colors hover:bg-accent-hover"
          >
            Check your app
          </Link>
          <Link
            href="/verdict/demo-verdict"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-ink-600 bg-ink-850 px-6 py-3 text-[15px] text-fg transition-colors hover:border-ink-700 hover:bg-ink-800"
          >
            See a sample verdict
          </Link>
        </div>

        <p className="font-mono text-[13px] leading-6 text-fg-faint">
          No signup. Free first run. Takes ~2 hours.
        </p>
      </div>
    </main>
  );
}
