// Clerk → D1 user-mirror sync (CHE-28).
//
// Clerk posts user.* / organization.* events here; we keep the local `User`
// mirror in step. Inert until CLERK_WEBHOOK_SIGNING_SECRET is set and the
// endpoint is registered in the Clerk dashboard — returns 503 until then so the
// rest of auth works without it. Public route (signature-verified, not session).

import type { NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db";
import { upsertUserFromClerk, deleteUserByClerkId } from "@/lib/users";

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext();
  const signingSecret = (env as Record<string, unknown>)
    .CLERK_WEBHOOK_SIGNING_SECRET as string | undefined;
  if (!signingSecret) {
    return new Response("clerk webhook not configured", { status: 503 });
  }

  let evt;
  try {
    evt = await verifyWebhook(req, { signingSecret });
  } catch {
    return new Response("invalid signature", { status: 400 });
  }

  const db = getDb(env as unknown as { DB: D1Database });

  switch (evt.type) {
    case "user.created":
    case "user.updated": {
      const u = evt.data as {
        id: string;
        first_name?: string | null;
        last_name?: string | null;
        email_addresses?: { id: string; email_address: string }[];
        primary_email_address_id?: string | null;
      };
      const primary =
        u.email_addresses?.find((e) => e.id === u.primary_email_address_id) ??
        u.email_addresses?.[0];
      await upsertUserFromClerk(db, {
        clerkUserId: u.id,
        email: primary?.email_address ?? "",
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") || null,
      });
      break;
    }
    case "user.deleted": {
      const id = (evt.data as { id?: string }).id;
      if (id) await deleteUserByClerkId(db, id);
      break;
    }
    default:
      // organization.* and others: no-op for now (orgId is set at onboarding).
      break;
  }

  return new Response("ok", { status: 200 });
}
