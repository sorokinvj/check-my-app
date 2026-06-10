import type { AppAnatomy } from "@/lib/types";

// Verdict §3.3 — "APP ANATOMY". Secondary lens, four collapsible blocks. The
// External Services block is the share-bait ("identified my entire stack").
export function AppAnatomySection({ anatomy }: { anatomy: AppAnatomy | null }) {
  if (!anatomy) return null;
  return (
    <section className="card p-6">
      <h2 className="section-label">App anatomy</h2>
      <p className="mt-1 text-sm text-fg-muted">Under the hood — what we found while mapping.</p>

      <div className="mt-4 space-y-2.5">
        <Block title={`📄 Pages we mapped (${anatomy.pages.length})`}>
          <div className="flex flex-wrap gap-1.5">
            {anatomy.pages.map((p) => (
              <span
                key={p}
                className="rounded-md border border-ink-700 bg-ink-900 px-2 py-0.5 font-mono text-xs text-fg-muted"
              >
                {p}
              </span>
            ))}
            {anatomy.pages.length === 0 && <span className="text-sm text-fg-faint">—</span>}
          </div>
        </Block>

        <Block title={`🖱 Things users can do (${anatomy.actions.length})`}>
          <p className="text-sm leading-relaxed text-fg-muted">
            {anatomy.actions.join(" · ") || "—"}
          </p>
        </Block>

        <Block title={`🔌 External services we detected (${anatomy.services.length})`} open>
          <div className="overflow-hidden rounded-lg border border-ink-700">
            {anatomy.services.map((s, i) => (
              <div
                key={s.name}
                className={`flex items-center gap-4 px-4 py-2.5 ${
                  i % 2 === 0 ? "bg-ink-900" : "bg-ink-850"
                }`}
              >
                <span className="w-36 shrink-0 font-mono text-sm font-medium text-fg">
                  {s.name}
                </span>
                <span className="text-sm text-fg-muted">{s.role}</span>
              </div>
            ))}
            {anatomy.services.length === 0 && (
              <p className="px-4 py-2.5 text-sm text-fg-faint">None detected.</p>
            )}
          </div>
        </Block>

        <Block title="🛠 Tech we noticed">
          <dl className="space-y-1.5">
            {Object.entries(anatomy.tech).map(([k, v]) =>
              v ? (
                <div key={k} className="flex gap-3 text-sm">
                  <dt className="w-24 shrink-0 font-mono text-xs uppercase tracking-wider text-fg-faint">
                    {k}
                  </dt>
                  <dd className="text-fg-muted">{v}</dd>
                </div>
              ) : null,
            )}
          </dl>
        </Block>
      </div>
    </section>
  );
}

function Block({
  title,
  children,
  open,
}: {
  title: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details className="group rounded-lg border border-ink-700 bg-ink-900/50" open={open}>
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-fg transition-colors hover:bg-ink-800/50">
        <span className="chevron mr-2 inline-block text-fg-faint">›</span>
        {title}
      </summary>
      <div className="px-4 pb-4 pt-1">{children}</div>
    </details>
  );
}
