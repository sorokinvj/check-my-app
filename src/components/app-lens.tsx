import type { AppLens } from "@/lib/types";

// Verdict §3.1 — "HOW WE SAW YOUR APP". The "they got it" moment, rendered first.
export function AppLensSection({ lens }: { lens: AppLens | null }) {
  if (!lens) return null;
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        How we saw your app
      </h2>
      <p className="mt-3 text-lg">{lens.oneLiner}</p>
      <ul className="mt-4 space-y-1.5 text-sm text-neutral-700">
        {lens.whoFor && <li>• Who it&apos;s for: {lens.whoFor}</li>}
        {lens.coreValue && <li>• Core value: {lens.coreValue}</li>}
        {lens.businessModel && <li>• How it makes money: {lens.businessModel}</li>}
        {lens.techSurface && <li>• Tech surface: {lens.techSurface}</li>}
        {lens.criticalPaths.length > 0 && (
          <li>
            • Critical paths to protect:
            <ol className="ml-5 list-decimal">
              {lens.criticalPaths.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
          </li>
        )}
        {lens.ifItBreaks && <li>• If something breaks: {lens.ifItBreaks}</li>}
      </ul>
      {/* TODO: [Looks right ✓] / [Something's off] feedback + inline edit (✏). */}
    </section>
  );
}
