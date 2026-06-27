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
