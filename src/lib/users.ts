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
}

// CHE-253: the mirror no longer carries a Clerk organization id. Which team a
// person acts for is ours to answer (src/lib/teams.ts) — Clerk's organizations
// give two roles and a third needs a paid add-on, so membership never became
// something we could key access on.
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
    },
    update: {
      email: u.email,
      name: u.name ?? undefined,
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
