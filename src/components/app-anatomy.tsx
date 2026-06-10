import type { AppAnatomy } from "@/lib/types";

// Verdict §3.3 — "APP ANATOMY". Secondary lens, four collapsible blocks. The
// External Services block is the share-bait ("identified my entire stack").
export function AppAnatomySection({ anatomy }: { anatomy: AppAnatomy | null }) {
  if (!anatomy) return null;
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        App anatomy
      </h2>
      <p className="text-sm text-neutral-500">Under the hood — what we found while mapping.</p>

      <div className="mt-4 space-y-4 text-sm">
        <Block title={`📄 Pages we mapped (${anatomy.pages.length})`}>
          <span className="mono text-neutral-600">{anatomy.pages.join(", ") || "—"}</span>
        </Block>

        <Block title={`🖱 Things users can do (${anatomy.actions.length})`}>
          <span className="text-neutral-600">{anatomy.actions.join(", ") || "—"}</span>
        </Block>

        <Block title={`🔌 External services we detected (${anatomy.services.length})`}>
          <ul className="space-y-1">
            {anatomy.services.map((s) => (
              <li key={s.name} className="text-neutral-600">
                <span className="mono">{s.name}</span> — {s.role}
              </li>
            ))}
            {anatomy.services.length === 0 && <li className="text-neutral-400">—</li>}
          </ul>
        </Block>

        <Block title="🛠 Tech we noticed">
          <ul className="space-y-0.5 text-neutral-600">
            {Object.entries(anatomy.tech).map(([k, v]) =>
              v ? (
                <li key={k}>
                  <span className="capitalize text-neutral-500">{k}:</span> {v}
                </li>
              ) : null,
            )}
          </ul>
        </Block>
      </div>
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-lg border border-neutral-100 p-3" open>
      <summary className="cursor-pointer font-medium text-neutral-800">{title}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
