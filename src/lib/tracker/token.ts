// Fresh Linear access token for a TrackerIntegration (CHE-68).
//
// Linear issues 24-hour access tokens with rotating refresh tokens; every
// consumer must come through here instead of decrypting accessTokenEnc
// directly, or the integration dies a day after connect. Free of Next imports
// on purpose — this compiles into the agent worker as well as the web app.
//
// Known race: refresh tokens rotate, so two concurrent refreshes can consume
// each other's token. The 10-minute margin makes overlap rare, and the loser
// falls back to the (still briefly valid) stale access token; the next caller
// refreshes cleanly. Accepted until it shows up in practice.

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { PrismaClient } from "@/generated/prisma/client";

const TOKEN_URL = "https://api.linear.app/oauth/token";
// Refresh ahead of the wall so an in-flight run doesn't straddle expiry.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface LinearOAuthCreds {
  clientId?: string;
  clientSecret?: string;
}

export interface TrackerTokenRow {
  id: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
}

export async function freshLinearToken(
  db: PrismaClient,
  tracker: TrackerTokenRow,
  creds: LinearOAuthCreds,
): Promise<string> {
  const current = decryptSecret(tracker.accessTokenEnc);
  const expiresAt = tracker.tokenExpiresAt?.getTime();
  if (!expiresAt || expiresAt - Date.now() > REFRESH_MARGIN_MS) return current;

  if (!tracker.refreshTokenEnc || !creds.clientId || !creds.clientSecret) {
    // Pre-CHE-68 integrations have no stored refresh token — the only cure is
    // a reconnect, which the dashboard surfaces once API calls start failing.
    console.warn(
      `[linear-token] integration ${tracker.id}: token ${
        expiresAt <= Date.now() ? "expired" : "expiring"
      }, no refresh path (refreshToken=${Boolean(tracker.refreshTokenEnc)}, ` +
        `oauthCreds=${Boolean(creds.clientId && creds.clientSecret)}) — reconnect Linear to heal`,
    );
    return current;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: decryptSecret(tracker.refreshTokenEnc),
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    console.warn(`[linear-token] refresh failed for ${tracker.id}: ${res.status} ${await res.text()}`);
    return current;
  }

  const token = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  await db.trackerIntegration.update({
    where: { id: tracker.id },
    data: {
      accessTokenEnc: encryptSecret(token.access_token),
      // Rotation: Linear may hand back a new refresh token; keep the old one
      // only when none arrives.
      ...(token.refresh_token ? { refreshTokenEnc: encryptSecret(token.refresh_token) } : {}),
      tokenExpiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
    },
  });
  return token.access_token;
}
