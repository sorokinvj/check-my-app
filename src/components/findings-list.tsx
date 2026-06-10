import type { Finding } from "@prisma/client";
import type { FindingDetail } from "@/lib/types";
import { SEVERITY_META } from "@/lib/status";

const CATEGORY_META: Record<Finding["category"], { emoji: string; label: string }> = {
  broken: { emoji: "🔴", label: "Broken" },
  risky: { emoji: "🟠", label: "Risky" },
  confusing: { emoji: "🟡", label: "Confusing" },
  polish: { emoji: "🔵", label: "Polish" },
  exposed: { emoji: "⚠", label: "Exposed" },
};

const CATEGORY_ORDER: Finding["category"][] = [
  "broken",
  "risky",
  "confusing",
  "polish",
  "exposed",
];

// Verdict §3.4 — "WHAT WE FOUND". Third on purpose: lead with the mirror, not the
// bug list. Grouped by category, each finding expandable with its evidence.
export function FindingsList({ findings }: { findings: Finding[] }) {
  const counts = CATEGORY_ORDER.map(
    (c) => `${findings.filter((f) => f.category === c).length} ${c}`,
  ).join(" · ");

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        What we found
      </h2>
      <p className="mb-4 text-sm text-neutral-500">{counts}</p>

      <div className="space-y-3">
        {CATEGORY_ORDER.map((category) => {
          const group = findings.filter((f) => f.category === category);
          if (group.length === 0) return null;
          const meta = CATEGORY_META[category];
          return (
            <div key={category} className="rounded-xl border border-neutral-200 bg-white p-4">
              <p className="font-medium">
                {meta.emoji} {meta.label} ({group.length})
              </p>
              <ul className="mt-2 space-y-2">
                {group.map((f) => {
                  const detail = (f.detail as FindingDetail | null) ?? {};
                  return (
                    <li key={f.id}>
                      <details className="rounded-lg border border-neutral-100 p-3">
                        <summary className="cursor-pointer text-sm">
                          #{String(f.number).padStart(3, "0")} {f.title}{" "}
                          <span className="text-neutral-400">
                            [{SEVERITY_META[f.severity].label}]
                          </span>
                        </summary>
                        <div className="mono mt-2 space-y-1 text-neutral-600">
                          {detail.where && <p>Where: {detail.where}</p>}
                          {detail.browser && <p>Browser: {detail.browser}</p>}
                          {detail.whatHappened && <p>What happened: {detail.whatHappened}</p>}
                          {detail.whyItMatters && (
                            <p className="text-neutral-700">
                              Why this matters: {detail.whyItMatters}
                            </p>
                          )}
                        </div>
                        {/* TODO: evidence (video/screenshot/HAR) + mark/dispute actions. */}
                      </details>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
        {findings.length === 0 && (
          <p className="text-sm text-neutral-400">No findings recorded yet.</p>
        )}
      </div>
    </section>
  );
}
