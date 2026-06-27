// D1 mirror of Clerk identity (CHE-28).
//
// Clerk is the identity provider of record; this thin mirror lets domain rows
// (App/Run/Watch/...) tenant-scope by a stable local `User.id` without calling
// Clerk on every request. Kept in sync by the Clerk webhook (user.* events).

import type { PrismaClient } from "@/generated/prisma/client";

export interface ClerkUserMirror {
  clerkUserId: string;
  email: string;
  name?: string | null;
  clerkOrgId?: string | null;
}

export async function upsertUserFromClerk(
  db: PrismaClient,
  u: ClerkUserMirror,
) {
  return db.user.upsert({
    where: { clerkUserId: u.clerkUserId },
    create: {
      clerkUserId: u.clerkUserId,
      email: u.email,
      name: u.name ?? undefined,
      clerkOrgId: u.clerkOrgId ?? undefined,
    },
    update: {
      email: u.email,
      name: u.name ?? undefined,
      clerkOrgId: u.clerkOrgId ?? undefined,
    },
  });
}

export async function deleteUserByClerkId(db: PrismaClient, clerkUserId: string) {
  // deleteMany (not delete) so a webhook replay for an already-removed user is a
  // no-op rather than a thrown "record not found" — D1 has no transactions.
  await db.user.deleteMany({ where: { clerkUserId } });
}

// Resolve the local mirror row for the currently-authenticated Clerk user.
export async function getLocalUser(db: PrismaClient, clerkUserId: string) {
  return db.user.findUnique({ where: { clerkUserId } });
}
