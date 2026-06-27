// Begin Linear OAuth for an App (CHE-31). Authed; verifies the App belongs to
// the caller, then redirects to Linear's consent screen with a CSRF state.
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { buildAuthorizeUrl } from "@/lib/tracker/linear-oauth";

export async function GET(req: NextRequest) {
  const appId = req.nextUrl.searchParams.get("appId");
  if (!appId) return NextResponse.json({ error: "appId required" }, { status: 400 });

  const { user, db } = await requireUser();
  const app = await db.app.findFirst({ where: { id: appId, ownerId: user.id } });
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });

  const { env } = getCloudflareContext();
  const clientId = (env as Record<string, string | undefined>).LINEAR_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "Linear OAuth not configured" }, { status: 503 });
  }

  // CSRF: random nonce in an httpOnly cookie; appId travels in the signed-ish state.
  const nonce = crypto.randomUUID();
  const state = Buffer.from(JSON.stringify({ appId, nonce })).toString("base64url");
  const jar = await cookies();
  jar.set("linear_oauth_nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 600,
  });

  const redirectUri = `${req.nextUrl.origin}/api/integrations/linear/callback`;
  return NextResponse.redirect(buildAuthorizeUrl({ clientId, redirectUri, state }));
}
