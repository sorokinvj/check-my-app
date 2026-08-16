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

// Journey.status roll-up adds "partial": all attempted steps ok, some skipped.
export type JourneyStatus = StepStatus | "partial";

export type Severity = "high" | "medium" | "low";

export type FindingCategory =
  | "broken"
  | "risky"
  | "confusing"
  | "polish"
  | "exposed";

export type FindingMark = "none" | "known" | "fixed" | "false_positive" | "watch";

export type EvidenceType =
  | "screenshot"
  | "screencast"
  | "console_log"
  | "network_har"
  | "dom_snapshot";

export type WatchFrequency = "daily" | "every_6h" | "manual";

// ─── M3: owner accounts & per-owner QA→tracker loop (CHE-27) ──────────────────

// Mirror of Clerk identity; absorbs the brief's future marketplace roles.
export type UserRole = "requester" | "provider_human" | "agent_operator" | "admin";

// Subscription tier (gates Watch limits); billing wires later.
export type UserPlan = "free" | "starter" | "growth" | "business" | "enterprise";

// Connected issue tracker. Only "linear" is implemented; abstraction for later.
export type TrackerType = "linear" | "jira" | "github";

// Lifecycle of a deduped regression we've already filed a ticket for.
export type IssueLinkStatus = "open" | "resolved";

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
export const FINDING_MARKS: FindingMark[] = ["none", "known", "fixed", "false_positive", "watch"];
export const WATCH_FREQUENCIES: WatchFrequency[] = ["daily", "every_6h", "manual"];
export const USER_ROLES: UserRole[] = [
  "requester",
  "provider_human",
  "agent_operator",
  "admin",
];
export const USER_PLANS: UserPlan[] = [
  "free",
  "starter",
  "growth",
  "business",
  "enterprise",
];
export const TRACKER_TYPES: TrackerType[] = ["linear", "jira", "github"];
export const ISSUE_LINK_STATUSES: IssueLinkStatus[] = ["open", "resolved"];
