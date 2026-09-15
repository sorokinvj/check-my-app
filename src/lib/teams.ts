// CHE-253 (Teams T0): resolving the team a person is acting for.
//
// A team owns the apps, pays the bill and grants the access. A personal account
// IS a team of one, created the moment a user exists, so nothing in the product
// branches on "team or not" — there is one billing subject and one access
// subject, and the single-seat case is exercised by every request we serve
// rather than by a test nobody runs.
//
// The personal team's id is derived from the user's (`team_<userId>`), the same
// value migration 0032 backfilled. That is not decoration: it makes creating it
// idempotent without a transaction, which is the only kind of idempotent D1
// offers.

import type { PrismaClient } from "@/generated/prisma/client";
import type { TeamScope } from "./scopes";

export type TeamRow = {
  id: string;
  name: string;
  isPersonal: boolean;
  plan: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

export type TeamContext = {
  team: TeamRow;
  scope: TeamScope;
};

export function personalTeamId(userId: string): string {
  return `team_${userId}`;
}

export function personalMembershipId(userId: string): string {
  return `mem_${userId}`;
}

// A name a person recognises as theirs. Their own name if we have one, their
// email otherwise — never "Personal team", which reads like a system row.
export function personalTeamName(user: { name?: string | null; email: string }): string {
  return user.name?.trim() || user.email;
}

// The personal team for a user, created if it is missing. Missing happens for
// every account created after this migration and for any row a webhook wrote
// directly, so this is the lazy half of the same guarantee the backfill gave
// existing accounts — the pattern the user mirror itself already uses.
export async function ensurePersonalTeam(
  db: PrismaClient,
  user: { id: string; name?: string | null; email: string },
): Promise<TeamRow> {
  const id = personalTeamId(user.id);
  const team = await db.team.upsert({
    where: { id },
    create: { id, name: personalTeamName(user), isPersonal: true },
    update: {},
  });
  await db.membership.upsert({
    where: { id: personalMembershipId(user.id) },
    create: {
      id: personalMembershipId(user.id),
      teamId: id,
      userId: user.id,
      scope: "admin",
    },
    update: {},
  });
  return team as TeamRow;
}

// Which team this person is acting for, and what they may do in it.
//
// Today every account has exactly one membership, so "active team" has one
// answer and no state is needed to find it. When a person can belong to several
// (T4/T5) the active team becomes an explicit choice carried in the session
// (T8) — this function is where that choice will be read, so that every page
// and route keeps taking its team from one place instead of inferring one from
// the row it happens to be showing.
export async function activeTeamContext(
  db: PrismaClient,
  user: { id: string; name?: string | null; email: string },
): Promise<TeamContext> {
  const memberships = await db.membership.findMany({
    where: { userId: user.id },
    include: { team: true },
    orderBy: { createdAt: "asc" },
  });
  const personal = memberships.find((m) => m.teamId === personalTeamId(user.id));
  const chosen = personal ?? memberships[0];
  if (!chosen) {
    // No membership at all: an account that predates the backfill or was
    // written straight by a webhook. Give it its team rather than refusing the
    // request — the same reason getOptionalUser upserts the mirror lazily.
    const team = await ensurePersonalTeam(db, user);
    return { team, scope: "admin" };
  }
  return { team: chosen.team as TeamRow, scope: chosen.scope as TeamScope };
}
