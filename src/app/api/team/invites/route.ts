// CHE-257 (Teams T4): invite somebody to the team.
//
// An admin picks the address and the scope; we mint a token, keep only its
// hash, and email the link. The scope is decided here, at invite time, and
// travels with the invitation — accepting never picks a default.

import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDbFromContext } from "@/lib/db";
import { requireScope } from "@/lib/team-auth";
import {
  checkInviteRequest,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
} from "@/lib/invites";
import { sendTeamInvite } from "@/lib/email";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://checkmyapp.dev";

export async function POST(req: Request) {
  // CHE-193: our own checker never invites anyone. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();

  const db = await getDbFromContext();
  const decision = await requireScope(db, req, "member.invite", "Sign in to invite someone");
  if (!decision.ok) return decision.response;
  const { user, team } = decision.grant;

  const json = (await req.json().catch(() => null)) as { email?: unknown; scope?: unknown } | null;
  const parsed = checkInviteRequest({
    email: typeof json?.email === "string" ? json.email : "",
    scope: typeof json?.scope === "string" ? json.scope : "",
  });
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 400 });

  // Already on the team: say so rather than sending a link that would answer
  // "you are already in" after they click it.
  const existingMember = await db.membership.findFirst({
    where: { teamId: team.id, user: { email: parsed.email } },
    select: { id: true },
  });
  if (existingMember) {
    return NextResponse.json({ error: "They are already on this team." }, { status: 409 });
  }

  const token = generateInviteToken();
  const invite = await db.teamInvite.create({
    data: {
      teamId: team.id,
      email: parsed.email,
      scope: parsed.scope,
      tokenHash: await hashInviteToken(token),
      invitedByUserId: user.id,
      expiresAt: inviteExpiry(),
    },
    select: { id: true, email: true, scope: true, expiresAt: true },
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

  return NextResponse.json({ invite }, { status: 201 });
}
