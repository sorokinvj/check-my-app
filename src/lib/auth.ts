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
import type { PrismaClient } from "@/generated/prisma/client";

export async function requireUser(): Promise<{
  user: NonNullable<Awaited<ReturnType<PrismaClient["user"]["upsert"]>>>;
  db: PrismaClient;
}> {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");

  const clerkUser = await currentUser();
  const db = await getDbFromContext();
  const email =
    clerkUser?.primaryEmailAddress?.emailAddress ??
    clerkUser?.emailAddresses?.[0]?.emailAddress ??
    "";
  const name =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") || null;

  // Capture the active Clerk organization so domain rows can org-scope (the
  // user picks/creates an org in the Clerk <OrganizationSwitcher>); null = personal.
  const user = await upsertUserFromClerk(db, {
    clerkUserId: userId,
    email,
    name,
    clerkOrgId: orgId ?? null,
  });
  return { user, db };
}

// API-route auth: resolve the signed-in user's D1 mirror, or null (no redirect).
// Use in route handlers where anonymous access is valid for some paths.
// Lazily upserts the mirror like requireUser does: without this, a Clerk user
// who never visited a protected page has no D1 row, every optional-auth API
// treats them as anonymous, and flows like Enable Daily Watch 401-loop through
// sign-in with no visible error (the webhook that would create the row is
// inert until CLERK_WEBHOOK_SIGNING_SECRET is configured).
export async function getOptionalUser(db: PrismaClient) {
  const { userId, orgId } = await auth();
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
    clerkOrgId: orgId ?? null,
  });
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
