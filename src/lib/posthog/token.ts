// A usable PostHog access token for a team (CHE-236).
//
// Every reader comes through here rather than decrypting `accessTokenEnc`
// directly, or the connection dies at its first expiry — CHE-68 is that lesson,
// already paid for once with Linear.
//
// What is different here, deliberately: this does NOT return a bare string.
// `freshLinearToken` returns the stale token when refresh is impossible and logs
// a warning nobody reads, so the owner's experience is that tickets quietly stop
// being filed while the dashboard still says "Connected" (CHE-269). A new
// integration should not inherit that. The caller gets a result it has to look
// at: either a token, or the fact that this connection needs reconnecting and
// why — so the thing that could not be answered can be said out loud (rule 2)
// instead of being discovered weeks later.
//
// Free of Next imports on purpose: this compiles into the agent worker too.

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { discoverPostHog, refreshTokens, type PostHogEndpoints } from "./oauth";

/** Refresh ahead of the wall, so an in-flight read does not straddle expiry. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface PostHogTokenRow {
  id: string;
  teamId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  expiresAt: Date | null;
}

export type PostHogToken =
  | { ok: true; token: string; refreshed: boolean }
  | { ok: false; reason: string };

/**
 * Has this connection died where nothing can revive it?
 *
 * Expired AND holding no refresh token. An expired token with a refresh token
 * renews itself on the next read and is not worth alarming anyone about; this
 * one needs a person. The dashboard states it, so "Connected" never outlives
 * the connection — which is exactly what CHE-269 did for weeks.
 */
export function isStranded(
  row: Pick<PostHogTokenRow, "refreshTokenEnc" | "expiresAt">,
  now: Date,
): boolean {
  if (row.refreshTokenEnc) return false;
  if (!row.expiresAt) return false;
  return row.expiresAt.getTime() <= now.getTime();
}

/**
 * A token good for the next few minutes, or a statement of why there is none.
 *
 * The `ok: false` branch is not an error to swallow. It means this team's
 * analytics cannot be read until somebody reconnects, and whoever called this
 * is the one place that knows what it was trying to do — so it is the one place
 * that can say it usefully.
 */
export async function freshPostHogToken(
  db: PrismaClient,
  row: PostHogTokenRow,
  args: { clientId: string; endpoints?: PostHogEndpoints; now?: Date; fetchImpl?: typeof fetch } ,
): Promise<PostHogToken> {
  const now = args.now ?? new Date();
  const current = decryptSecret(row.accessTokenEnc);
  const expiresAt = row.expiresAt?.getTime();

  // No expiry recorded: the provider did not give one, so we cannot know. Use
  // it and let the caller find out from the API, rather than refreshing on
  // every read and burning a rotating refresh token for nothing.
  if (!expiresAt) return { ok: true, token: current, refreshed: false };
  if (expiresAt - now.getTime() > REFRESH_MARGIN_MS) return { ok: true, token: current, refreshed: false };

  if (!row.refreshTokenEnc) {
    return {
      ok: false,
      reason: "the analytics connection expired and has no refresh token — it needs reconnecting",
    };
  }

  try {
    const endpoints = args.endpoints ?? (await discoverPostHog(undefined, args.fetchImpl));
    const tokens = await refreshTokens({
      endpoints,
      clientId: args.clientId,
      refreshToken: decryptSecret(row.refreshTokenEnc),
      now,
      fetchImpl: args.fetchImpl,
    });
    await db.postHogIntegration.update({
      where: { id: row.id },
      data: {
        accessTokenEnc: encryptSecret(tokens.accessToken),
        // PostHog may rotate the refresh token; keeping the old one after a
        // rotation is how a connection dies on its second refresh instead of
        // its first.
        ...(tokens.refreshToken ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) } : {}),
        expiresAt: tokens.expiresAt,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
    });
    return { ok: true, token: tokens.accessToken, refreshed: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Expired and unrefreshable is a different fact from expiring and
    // unrefreshable, and the caller may reasonably treat them differently.
    const expired = expiresAt <= now.getTime();
    return {
      ok: false,
      reason: expired
        ? `the analytics connection expired and could not be renewed (${detail}) — it needs reconnecting`
        : `the analytics connection could not be renewed (${detail}) — it will expire shortly`,
    };
  }
}
