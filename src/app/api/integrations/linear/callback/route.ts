// Linear OAuth callback (CHE-31). Verifies CSRF state, exchanges the code for an
// access token, and stores it (encrypted) as the App's TrackerIntegration.
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { exchangeCode, fetchFirstTeam } from "@/lib/tracker/linear-oauth";
import { encryptSecret } from "@/lib/crypto";

function back(req: NextRequest, status: string) {
  return NextResponse.redirect(new URL(`/dashboard?linear=${status}`, req.nextUrl.origin));
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return back(req, "error");

  let appId: string;
  let nonce: string;
  try {
    ({ appId, nonce } = JSON.parse(Buffer.from(state, "base64url").toString()));
  } catch {
    return back(req, "error");
  }

  const jar = await cookies();
  if (jar.get("linear_oauth_nonce")?.value !== nonce) return back(req, "csrf");
  jar.delete("linear_oauth_nonce");

  const { user, db } = await requireUser();
  const app = await db.app.findFirst({ where: { id: appId, ownerId: user.id } });
  if (!app) return back(req, "error");

  const { env } = getCloudflareContext();
  const e = env as Record<string, string | undefined>;
  if (!e.LINEAR_CLIENT_ID || !e.LINEAR_CLIENT_SECRET) return back(req, "error");

  let token;
  try {
    token = await exchangeCode({
      code,
      redirectUri: `${req.nextUrl.origin}/api/integrations/linear/callback`,
      clientId: e.LINEAR_CLIENT_ID,
      clientSecret: e.LINEAR_CLIENT_SECRET,
    });
  } catch {
    return back(req, "exchange_failed");
  }

  const team = await fetchFirstTeam(token.access_token);
  const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;
  const accessTokenEnc = encryptSecret(token.access_token);

  await db.trackerIntegration.upsert({
    where: { appId },
    create: {
      appId,
      type: "linear",
      accessTokenEnc,
      teamId: team?.id ?? null,
      externalOrg: team?.name ?? null,
      tokenExpiresAt: expiresAt,
    },
    update: {
      accessTokenEnc,
      teamId: team?.id ?? null,
      externalOrg: team?.name ?? null,
      tokenExpiresAt: expiresAt,
    },
  });

  return back(req, "connected");
}
