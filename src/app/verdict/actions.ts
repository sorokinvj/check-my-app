"use server";

// Verdict page actions. Server actions on purpose (CHE-73): a <form action>
// submits natively even before React hydrates, so an early click on
// "Re-check now" can't be silently swallowed the way an onClick was.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDbFromContext } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";
import { hashClientKey } from "@/lib/crypto";
import { createRecheckRun } from "@/lib/recheck";
import { enableWatchForRun } from "@/lib/watch-enable";

export async function recheckRunAction(publicId: string): Promise<void> {
  return doRecheck(publicId, false);
}

// CHE-74: walk everything from scratch — partial/smoke skip themselves.
export async function fullRecheckRunAction(publicId: string): Promise<void> {
  return doRecheck(publicId, true);
}

// CHE-75: Enable Daily Watch, hydration-proof. Same defaults the API route's
// schema applies (daily, notify on change only).
export async function enableWatchAction(publicId: string): Promise<void> {
  const prisma = await getDbFromContext();
  const user = await getOptionalUser(prisma);
  const result = await enableWatchForRun(prisma, user, {
    runPublicId: publicId,
    frequency: "daily",
    notifyOnChangeOnly: true,
  });
  switch (result.kind) {
    case "unauthenticated":
      redirect(`/sign-in?redirect_url=${encodeURIComponent(`/verdict/${publicId}`)}`);
      break;
    case "not_found":
      redirect(`/verdict/${publicId}?watch_error=${encodeURIComponent("Run not found.")}`);
      break;
    case "forbidden":
      redirect(`/verdict/${publicId}?watch_error=${encodeURIComponent("This run belongs to another owner.")}`);
      break;
    case "gated":
      redirect(`/verdict/${publicId}?watch_error=${encodeURIComponent(result.reason)}`);
      break;
    case "ok":
      redirect(`/watch/${result.slug}`);
  }
}

async function doRecheck(publicId: string, full: boolean): Promise<void> {
  const prisma = await getDbFromContext();
  const anonKeyHash = await hashClientKey((await headers()).get("cf-connecting-ip"));
  const result = await createRecheckRun(prisma, publicId, { full, anonKeyHash });
  if (result.kind === "unauthorized") {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(`/verdict/${publicId}`)}`);
  }
  if (result.kind === "not_found") {
    redirect(`/verdict/${publicId}?recheck=notfound`);
  }
  // CHE-94: anonymous callers get the fresh verdict they already have, or a
  // plain explanation for the owner-only full walk — never a silent no-op.
  if (result.kind === "reused") {
    redirect(`/verdict/${result.publicId}?recheck=reused`);
  }
  if (result.kind === "quota") {
    redirect(`/verdict/${publicId}?recheck=${encodeURIComponent(result.reason)}`);
  }
  if (result.kind === "ok") {
    redirect(`/run/${result.publicId}`);
  }
}
