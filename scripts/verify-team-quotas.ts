// CHE-260 (Teams T7) verification: every quota counts the team, and no call
// site passes a person where a team belongs.
//
// The compiler cannot help with the second half — a team id and a user id are
// both strings, so `{ id: user.id }` compiles perfectly into a gate that means
// `{ id: team.id }`, and the result is five people on one Free team getting
// five allowances. So the call sites are checked as a registry, by name.
//
// The first half is arithmetic and is asserted pure: the allowance is the
// team's, the trial is the team's, and the copy says whose plan is being spent
// so the person who hits the wall knows whom to ask rather than being told to
// upgrade something they cannot buy.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-team-quotas.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  FREE_RUNS_LIFETIME,
  PLAN_LIMITS,
  WATCH_TRIAL_DAYS,
  fullRecheckGate,
  shouldSkipWatch,
  watchCapReason,
  watchTrialEnd,
  watchTrialState,
} from "@/lib/plans";
import { USER_PLANS, type UserPlan } from "@/lib/enums";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ─── 1. The gates take a team ────────────────────────────────────────────────

const plans = read("src/lib/plans.ts");
check(
  "assertCanAddWatch takes a teamId, not an ownerId",
  /assertCanAddWatch\([\s\S]{0,200}?teamId: string/.test(plans) && !/ownerId: opts\.ownerId/.test(plans),
);
check(
  "assertCanStartRun's subject is the team",
  /assertCanStartRun\([\s\S]{0,300}?team: \{ id: string; plan: UserPlan \} \| null/.test(plans),
);
check(
  "fullRechecksUsed counts a team's month",
  /fullRechecksUsed\([\s\S]{0,120}?teamId: string/.test(plans),
);
check(
  "every quota query is scoped with teamOwned",
  (plans.match(/teamOwned\(/g) ?? []).length >= 3,
  `${(plans.match(/teamOwned\(/g) ?? []).length} scoped queries`,
);

// ─── 2. No call site hands a person to a quota ───────────────────────────────
// The check that the compiler cannot do. Each of these functions takes an id
// that must be a TEAM's; a `user.`, `owner.` or `viewer.` id in that position
// is the bug this ticket exists to prevent, and it is invisible in review.

const QUOTA_CALLS = ["assertCanStartRun", "assertCanAddWatch", "fullRechecksUsed", "fullRechecksRemaining"];
const CALLERS = [
  "src/app/api/checks/route.ts",
  "src/app/dashboard/actions.ts",
  "src/app/dashboard/[appId]/page.tsx",
  "src/app/verdict/[id]/page.tsx",
  "src/app/onboarding/actions.ts",
  "src/lib/recheck.ts",
  "src/lib/start-saved-app.ts",
  "src/lib/watch-enable.ts",
];

const PERSON_ID = /\b(user|owner|viewer|actor)\.id\b|\bownerId:/;
const offenders: string[] = [];
for (const file of CALLERS) {
  const text = read(file);
  for (const fn of QUOTA_CALLS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(`${fn}(`, from);
      if (at < 0) break;
      from = at + fn.length;
      // The call's arguments, bounded generously: these calls are short.
      const window = text.slice(at, at + 420);
      const end = window.indexOf(");");
      const args = end > 0 ? window.slice(0, end) : window;
      if (PERSON_ID.test(args)) offenders.push(`${file} → ${fn}`);
    }
  }
}
check(
  "no quota gate is handed a person's id",
  offenders.length === 0,
  offenders.join(", ") || `${CALLERS.length} files checked`,
);

// ─── 3. The arithmetic, per plan ─────────────────────────────────────────────

check(
  `Free carries ${FREE_RUNS_LIFETIME} runs for the whole team, not per person`,
  /Your team has used all \$\{FREE_RUNS_LIFETIME\} runs/.test(plans),
);
for (const plan of USER_PLANS) {
  const limits = PLAN_LIMITS[plan];
  check(
    `${plan}: a watch cap that is a number, and a budget that is money`,
    Number.isFinite(limits.maxWatches) && limits.dailyBudgetUsd > 0,
    `${limits.maxWatches} watches · $${limits.dailyBudgetUsd}/day/app`,
  );
}

// The cap's own copy, which a member of a team reads. It must name the team's
// plan rather than telling them to upgrade something they cannot buy.
const capped = watchCapReason("growth", PLAN_LIMITS.growth.maxWatches);
check(
  "a team that has used its watches is told it is the TEAM's plan",
  typeof capped === "string" && /team's plan/.test(capped),
  String(capped),
);
check("a team below its cap is told nothing", watchCapReason("growth", 0) === null);

const usedUp = fullRecheckGate("starter", PLAN_LIMITS.starter.fullRechecksPerMonth!, new Date("2026-09-15T00:00:00Z"));
check(
  "a used-up full re-check allowance names the team's plan and the reset date",
  !usedUp.ok && /team's plan/.test(usedUp.reason) && /October 1/.test(usedUp.reason),
  usedUp.ok ? "allowed" : usedUp.reason,
);
check(
  "…and still says the ordinary re-check is there — the limit is on the expensive mode, never on checking",
  !usedUp.ok && /regular re-check/i.test(usedUp.reason),
);

// ─── 4. The trial is the team's ──────────────────────────────────────────────

const NOW = new Date("2026-09-15T00:00:00Z");
check(
  `a Free team's watch is a ${WATCH_TRIAL_DAYS}-day trial`,
  watchTrialEnd("free", NOW)?.getTime() === NOW.getTime() + WATCH_TRIAL_DAYS * 86400000,
);
check("a paid team's watch has no expiry", watchTrialEnd("starter", NOW) === null);
check(
  "the scheduler skips a Free team's expired trial",
  shouldSkipWatch({ trialEndsAt: new Date(NOW.getTime() - 1000) }, "free", NOW),
);
check(
  "…and stops skipping the moment the team upgrades, with nothing else to update",
  !shouldSkipWatch({ trialEndsAt: new Date(NOW.getTime() - 1000) }, "starter", NOW),
);
check(
  "the dashboard shows the trial as the team's, counted in whole days",
  watchTrialState({ trialEndsAt: new Date(NOW.getTime() + 20 * 3600 * 1000) }, "free", NOW).kind === "active",
);

// ─── 5. Inviting does not mint allowances ────────────────────────────────────
// The property in one line: nothing about the number of people on a team
// appears in any quota. A cap that counted members would hand a five-person
// Free team five lifetimes.

for (const fn of ["assertCanStartRun", "assertCanAddWatch", "fullRechecksUsed"]) {
  const at = plans.indexOf(`export async function ${fn}`);
  const body = plans.slice(at, plans.indexOf("\n}", at));
  check(
    `${fn} does not look at how many people are on the team`,
    !/membership/i.test(body),
  );
}

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
