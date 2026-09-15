"use server";

// CHE-258 (Teams T5): managing a team from inside the product.
//
// Every mutation here goes through requireActionScope, so the registry entry
// (src/lib/route-scopes.ts) and the code say the same thing — and through the
// pure rules in src/lib/membership.ts, so the last-admin rule is enforced where
// the change happens rather than in the page that offers the button.

import { revalidatePath } from "next/cache";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireActionScope } from "@/lib/team-auth";
import {
  decideLeave,
  decideRemoval,
  decideScopeChange,
  type MemberRow,
} from "@/lib/membership";
import {
  checkInviteRequest,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteState,
} from "@/lib/invites";
import { sendTeamInvite } from "@/lib/email";
import type { TeamScope } from "@/lib/scopes";
import type { PrismaClient } from "@/generated/prisma/client";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://checkmyapp.dev";

// The team as the rules need to see it: who is on it and with what scope.
async function membersOf(db: PrismaClient, teamId: string): Promise<MemberRow[]> {
  const rows = await db.membership.findMany({
    where: { teamId },
    select: { userId: true, scope: true },
  });
  return rows.map((r) => ({ userId: r.userId, scope: r.scope as TeamScope }));
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const { user, db, team } = await requireActionScope("member.invite");
  const parsed = checkInviteRequest({
    email: String(formData.get("email") ?? ""),
    scope: String(formData.get("scope") ?? "member"),
  });
  if (!parsed.ok) throw new Error(parsed.reason);

  const already = await db.membership.findFirst({
    where: { teamId: team.id, user: { email: parsed.email } },
    select: { id: true },
  });
  if (already) throw new Error("They are already on this team.");

  const token = generateInviteToken();
  await db.teamInvite.create({
    data: {
      teamId: team.id,
      email: parsed.email,
      scope: parsed.scope,
      tokenHash: await hashInviteToken(token),
      invitedByUserId: user.id,
      expiresAt: inviteExpiry(),
    },
  });

  const { env } = getCloudflareContext();
  const bindings = env as Record<string, string | undefined>;
  await sendTeamInvite({
    to: parsed.email,
    teamName: team.name,
    invitedBy: user.name?.trim() || user.email,
    scope: parsed.scope,
    acceptUrl: `${APP_URL}/invite/${token}`,
    apiKey: bindings.EMAIL_API_KEY,
    from: bindings.EMAIL_FROM,
  });
  revalidatePath("/team");
}

export async function revokeInviteAction(inviteId: string): Promise<void> {
  const { db, team } = await requireActionScope("member.invite");
  const invite = await db.teamInvite.findFirst({
    where: { id: inviteId, teamId: team.id },
    select: { id: true, expiresAt: true, acceptedAt: true, revokedAt: true, revokedReason: true, teamId: true, scope: true },
  });
  if (!invite) throw new Error("Invitation not found.");
  if (inviteState(invite) === "pending") {
    await db.teamInvite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date(), revokedReason: "revoked" },
    });
  }
  revalidatePath("/team");
}

export async function changeScopeAction(userId: string, formData: FormData): Promise<void> {
  const scope = String(formData.get("scope") ?? "");
  const { db, team } = await requireActionScope("member.scope.change");
  const members = await membersOf(db, team.id);
  const decision = decideScopeChange(members, userId, scope as TeamScope);
  if (!decision.ok) throw new Error(decision.reason);
  await db.membership.updateMany({
    where: { teamId: team.id, userId },
    data: { scope },
  });
  revalidatePath("/team");
}

export async function removeMemberAction(userId: string): Promise<void> {
  const { user, db, team } = await requireActionScope("member.remove");
  const members = await membersOf(db, team.id);
  const decision = decideRemoval(members, userId, user.id);
  if (!decision.ok) throw new Error(decision.reason);
  // Only the membership goes. Their apps, checks and tickets belong to the
  // team, and ownerId on those rows is attribution — the record of who did it.
  await db.membership.deleteMany({ where: { teamId: team.id, userId } });
  revalidatePath("/team");
}

export async function leaveTeamAction(): Promise<void> {
  // Leaving is not an admin action: any member may do it, so the scope asked
  // for is the one everybody has.
  const { user, db, team } = await requireActionScope("read");
  const members = await membersOf(db, team.id);
  const decision = decideLeave(members, user.id);
  if (!decision.ok) throw new Error(decision.reason);
  await db.membership.deleteMany({ where: { teamId: team.id, userId: user.id } });
  revalidatePath("/team");
}
