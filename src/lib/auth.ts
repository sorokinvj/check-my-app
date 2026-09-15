// Server-side auth helper bridging Clerk → the D1 user mirror (CHE-28/30).
//
// requireUser() guarantees a local `User` row for the signed-in Clerk user and
// returns it alongside a db handle. It lazily upserts the mirror so the owner
// experience works before the Clerk webhook is configured (the webhook then
// just keeps it in sync). Call only from protected server contexts.

import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getDbFromContext } from "./db";
import { upsertUserFromClerk } from "./users";
import { resolveApiKeyOwner } from "./apiKeys";
import { activeTeamContext, type TeamRow } from "./teams";
import type { TeamScope } from "./scopes";
import type { PrismaClient } from "@/generated/prisma/client";

// CHE-253: a protected page gets the person, the team they are acting for and
// what they may do in it — all three from one place. A page given only the user
// would have to re-answer "which team is this" from whatever row it happens to
// be rendering, and tenancy inferred from the row on screen is the mistake this
// epic exists to make impossible.
export async function requireUser(): Promise<{
  user: NonNullable<Awaited<ReturnType<PrismaClient["user"]["upsert"]>>>;
  db: PrismaClient;
  team: TeamRow;
  scope: TeamScope;
}> {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const clerkUser = await currentUser();
  const db = await getDbFromContext();
  const email =
    clerkUser?.primaryEmailAddress?.emailAddress ??
    clerkUser?.emailAddresses?.[0]?.emailAddress ??
    "";
  const name =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") || null;

  const user = await upsertUserFromClerk(db, {
    clerkUserId: userId,
    email,
    name,
  });
  // Lazily, like the mirror above: an account created before teams existed, or
  // written straight by a webhook, gets its personal team on first use rather
  // than being refused.
  const { team, scope } = await activeTeamContext(db, user);
  return { user, db, team, scope };
}

// API-route auth: resolve the signed-in user's D1 mirror, or null (no redirect).
// Use in route handlers where anonymous access is valid for some paths.
// Lazily upserts the mirror like requireUser does: without this, a Clerk user
// who never visited a protected page has no D1 row, every optional-auth API
// treats them as anonymous, and flows like Enable Daily Watch 401-loop through
// sign-in with no visible error (the webhook that would create the row is
// inert until CLERK_WEBHOOK_SIGNING_SECRET is configured).
export async function getOptionalUser(db: PrismaClient) {
  const { userId } = await auth();
  if (!userId) return null;
  const existing = await db.user.findUnique({ where: { clerkUserId: userId } });
  if (existing) return existing;
  const clerkUser = await currentUser();
  const email =
    clerkUser?.primaryEmailAddress?.emailAddress ??
    clerkUser?.emailAddresses?.[0]?.emailAddress ??
    "";
  const name =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") || null;
  return upsertUserFromClerk(db, {
    clerkUserId: userId,
    email,
    name,
  });
}

// The team an API-route caller is acting for, and what they may do in it.
// requireUser's counterpart for routes where anonymous access is also valid:
// the caller may be a browser session or an API key (getOwnerFromRequest), and
// both resolve to the same team context so nothing downstream has to ask which
// kind of caller it is looking at.
export async function optionalTeamContext(
  db: PrismaClient,
  user: { id: string; name?: string | null; email: string } | null,
) {
  if (!user) return null;
  return activeTeamContext(db, user);
}

// Request-level owner resolution for API routes (CHE-52): a browser presents a
// Clerk session, a coding agent presents `Authorization: Bearer cma_…`. Tries
// Clerk first, then the API key; either way the caller gets the same D1 User
// row getOptionalUser returns, so everything downstream (quota, attribution)
// is identical. `via` tells the route how the owner authenticated — API-key
// requests are machine-to-machine and are exempt from browser bot checks
// (a valid key is a stronger proof than a Turnstile token).
export async function getOwnerFromRequest(
  db: PrismaClient,
  req: Request,
): Promise<{ user: NonNullable<Awaited<ReturnType<typeof getOptionalUser>>>; via: "clerk" | "api_key" } | null> {
  const clerkUser = await getOptionalUser(db);
  if (clerkUser) return { user: clerkUser, via: "clerk" };
  const keyOwner = await resolveApiKeyOwner(db, req);
  if (keyOwner) return { user: keyOwner, via: "api_key" };
  return null;
}

// Tenant guard for resources that may be owned or anonymous (CHE-33).
// - Owned (ownerId set): only the authenticated owner may mutate.
// - Anonymous (ownerId null): knowledge of the unguessable publicId/slug IS the
//   capability (the public free-run funnel), so it's allowed.
export async function canMutateOwned(
  db: PrismaClient,
  ownerId: string | null,
): Promise<boolean> {
  if (!ownerId) return true;
  const user = await getOptionalUser(db);
  return !!user && user.id === ownerId;
}
