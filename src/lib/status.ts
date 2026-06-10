// Canonical status → label/color/emoji mappings. Keep these in one place so the
// live feed, journey strips, and findings list never drift from the brand palette.

import type { RunStatus, StepStatus, Verdict, Severity, FindingCategory } from "@prisma/client";

export const STEP_STATUS_META: Record<
  StepStatus,
  { emoji: string; label: string; className: string; dotClassName: string }
> = {
  ok: { emoji: "✓", label: "Works", className: "text-status-ok", dotClassName: "bg-status-ok" },
  risky: {
    emoji: "⚠",
    label: "Risky",
    className: "text-status-risky",
    dotClassName: "bg-status-risky",
  },
  confusing: {
    emoji: "?",
    label: "Confusing",
    className: "text-status-confusing",
    dotClassName: "bg-status-confusing",
  },
  broken: {
    emoji: "✕",
    label: "Broken",
    className: "text-status-broken",
    dotClassName: "bg-status-broken",
  },
  exposed: {
    emoji: "⚠",
    label: "Exposed",
    className: "text-status-exposed",
    dotClassName: "bg-status-exposed",
  },
  skipped: { emoji: "—", label: "Skipped", className: "text-fg-faint", dotClassName: "bg-ink-600" },
};

export const VERDICT_META: Record<
  Verdict,
  { emoji: string; label: string; pillClassName: string }
> = {
  all_good: {
    emoji: "🟢",
    label: "All good",
    pillClassName: "border-status-ok/40 bg-status-ok/10 text-status-ok",
  },
  mostly_ok: {
    emoji: "🟡",
    label: "Mostly OK",
    pillClassName: "border-status-confusing/40 bg-status-confusing/10 text-status-confusing",
  },
  needs_attention: {
    emoji: "🟠",
    label: "Needs attention",
    pillClassName: "border-status-risky/40 bg-status-risky/10 text-status-risky",
  },
  broken: {
    emoji: "🔴",
    label: "Broken",
    pillClassName: "border-status-broken/40 bg-status-broken/10 text-status-broken",
  },
};

export const SEVERITY_META: Record<Severity, { label: string; className: string }> = {
  high: { label: "HIGH", className: "text-status-broken" },
  medium: { label: "MED", className: "text-status-risky" },
  low: { label: "LOW", className: "text-fg-faint" },
};

export const CATEGORY_META: Record<
  FindingCategory,
  { emoji: string; label: string; className: string }
> = {
  broken: { emoji: "🔴", label: "Broken", className: "text-status-broken" },
  risky: { emoji: "🟠", label: "Risky", className: "text-status-risky" },
  confusing: { emoji: "🟡", label: "Confusing", className: "text-status-confusing" },
  polish: { emoji: "🔵", label: "Polish", className: "text-accent" },
  exposed: { emoji: "⚠", label: "Exposed", className: "text-status-exposed" },
};

export const CATEGORY_ORDER: FindingCategory[] = [
  "broken",
  "risky",
  "confusing",
  "polish",
  "exposed",
];

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
