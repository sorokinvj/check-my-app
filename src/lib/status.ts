// Canonical status → label/color/emoji mappings. Keep these in one place so the
// live feed, journey strips, and findings list never drift from the brand palette.

import type { RunStatus, StepStatus, Verdict, Severity } from "@prisma/client";

export const STEP_STATUS_META: Record<
  StepStatus,
  { emoji: string; label: string; className: string }
> = {
  ok: { emoji: "✅", label: "Works", className: "text-status-ok" },
  risky: { emoji: "⚠", label: "Risky", className: "text-status-risky" },
  confusing: { emoji: "🟡", label: "Confusing", className: "text-status-confusing" },
  broken: { emoji: "🔴", label: "Broken", className: "text-status-broken" },
  exposed: { emoji: "⚠", label: "Exposed", className: "text-status-exposed" },
  skipped: { emoji: "—", label: "Skipped", className: "text-neutral-400" },
};

export const VERDICT_META: Record<Verdict, { emoji: string; label: string }> = {
  all_good: { emoji: "✅", label: "All good" },
  mostly_ok: { emoji: "🟡", label: "Mostly OK" },
  needs_attention: { emoji: "⚠", label: "Needs attention" },
  broken: { emoji: "🔴", label: "Broken" },
};

export const SEVERITY_META: Record<Severity, { label: string }> = {
  high: { label: "HIGH" },
  medium: { label: "MED" },
  low: { label: "LOW" },
};

// Maps the persisted run status to the in-progress phase banner index (1–6).
export const RUN_STATUS_PHASE: Partial<Record<RunStatus, number>> = {
  connecting: 1,
  surface_scan: 2,
  discovery: 3,
  walking: 4,
  anatomy: 5,
  writing: 6,
};

export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "partial" || status === "failed";
}
