// CHE-258 (Teams T5): the rules about who may be on a team and with what scope.
//
// One rule has teeth and the rest follow from it:
//
//   **A team always has at least one admin.**
//
// The last admin cannot be demoted, removed, or leave. Enforced in the same
// functions that perform the change rather than in the page that offers it —
// a page is copy, and copy is what the server is supposed to be able to
// contradict. The personal team (CHE-253) is this rule's simplest case: one
// admin, who cannot demote themselves, so nobody can lock themselves out of
// their own apps.
//
// Everything here is pure, so scripts/verify-membership-rules.ts can exercise
// the cases that matter — the last admin, the two-admin team where either may
// leave, a member removing themselves — without a database.

import type { TeamScope } from "./scopes";

export type MemberRow = {
  userId: string;
  scope: TeamScope;
};

export type MembershipDecision = { ok: true } | { ok: false; reason: string };

const LAST_ADMIN =
  "This team would have no admin left. Make someone else an admin first — " +
  "a team nobody can administer is a team nobody can pay for or add people to.";

const NOT_A_MEMBER = "They are not on this team.";

function admins(members: MemberRow[]): MemberRow[] {
  return members.filter((m) => m.scope === "admin");
}

// Changing somebody's scope, including your own.
export function decideScopeChange(
  members: MemberRow[],
  targetUserId: string,
  newScope: TeamScope,
): MembershipDecision {
  const target = members.find((m) => m.userId === targetUserId);
  if (!target) return { ok: false, reason: NOT_A_MEMBER };
  if (target.scope === newScope) return { ok: true }; // no-op, not an error
  const losingAnAdmin = target.scope === "admin" && newScope !== "admin";
  if (losingAnAdmin && admins(members).length === 1) return { ok: false, reason: LAST_ADMIN };
  return { ok: true };
}

// Removing somebody else.
export function decideRemoval(
  members: MemberRow[],
  targetUserId: string,
  actorUserId: string,
): MembershipDecision {
  const target = members.find((m) => m.userId === targetUserId);
  if (!target) return { ok: false, reason: NOT_A_MEMBER };
  if (target.userId === actorUserId) {
    // Removing yourself is leaving, and leaving has its own rule. Saying so is
    // kinder than a generic refusal — the person is trying to do a thing the
    // product supports, by the wrong door.
    return { ok: false, reason: "To remove yourself, leave the team instead." };
  }
  if (target.scope === "admin" && admins(members).length === 1) {
    return { ok: false, reason: LAST_ADMIN };
  }
  return { ok: true };
}

// Leaving a team you are on.
export function decideLeave(members: MemberRow[], actorUserId: string): MembershipDecision {
  const me = members.find((m) => m.userId === actorUserId);
  if (!me) return { ok: false, reason: "You are not on this team." };
  if (me.scope === "admin" && admins(members).length === 1) {
    return {
      ok: false,
      reason:
        "You are this team's only admin. Make someone else an admin first, or delete the team " +
        "if it has served its purpose.",
    };
  }
  return { ok: true };
}

// What removing somebody does NOT do, stated as a function so the page and the
// action agree: nothing they touched goes with them. Their apps, watches, runs
// and tickets belong to the team, and `ownerId` on those rows is attribution —
// the record of who did it. Rewriting history to tidy a departure is how a
// run's provenance stops meaning anything (and how the self-check silence rule
// would lose the half it reads — CHE-253).
export const REMOVAL_KEEPS_EVERYTHING =
  "Their apps, checks and tickets stay with the team. Only their access is removed.";
