// String-literal unions replacing Prisma enums.
//
// D1/SQLite has no native enums and Prisma's sqlite provider doesn't support
// them, so every former enum column is a String in the schema. These unions
// restore type-safety in app code (the DB stores plain strings; we validate /
// coerce at the boundaries — see the agent's report_step and synthesis parsers).

export type RunStatus =
  | "queued"
  | "connecting"
  | "surface_scan"
  | "discovery"
  | "walking"
  | "anatomy"
  | "writing"
  | "completed"
  | "partial"
  | "failed";

export type Verdict = "all_good" | "mostly_ok" | "needs_attention" | "broken";

export type StepStatus =
  | "ok"
  | "risky"
  | "confusing"
  | "broken"
  | "exposed"
  | "skipped";

export type Severity = "high" | "medium" | "low";

export type FindingCategory =
  | "broken"
  | "risky"
  | "confusing"
  | "polish"
  | "exposed";

export type FindingMark = "none" | "known" | "fixed" | "false_positive";

export type EvidenceType =
  | "screenshot"
  | "screencast"
  | "console_log"
  | "network_har"
  | "dom_snapshot";

export type WatchFrequency = "daily" | "every_6h" | "manual";

// Runtime guards for values crossing a boundary (LLM output, request body).
export const STEP_STATUSES: StepStatus[] = [
  "ok",
  "risky",
  "confusing",
  "broken",
  "exposed",
  "skipped",
];
export const FINDING_CATEGORIES: FindingCategory[] = [
  "broken",
  "risky",
  "confusing",
  "polish",
  "exposed",
];
export const SEVERITIES: Severity[] = ["high", "medium", "low"];
export const FINDING_MARKS: FindingMark[] = ["none", "known", "fixed", "false_positive"];
export const WATCH_FREQUENCIES: WatchFrequency[] = ["daily", "every_6h", "manual"];
