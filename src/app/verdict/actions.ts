"use server";

// Verdict page actions. Server actions on purpose (CHE-73): a <form action>
// submits natively even before React hydrates, so an early click on
// "Re-check now" can't be silently swallowed the way an onClick was.

import { redirect } from "next/navigation";
import { getDbFromContext } from "@/lib/db";
import { createRecheckRun } from "@/lib/recheck";

export async function recheckRunAction(publicId: string): Promise<void> {
  return doRecheck(publicId, false);
}

// CHE-74: walk everything from scratch — partial/smoke skip themselves.
export async function fullRecheckRunAction(publicId: string): Promise<void> {
  return doRecheck(publicId, true);
}

async function doRecheck(publicId: string, full: boolean): Promise<void> {
  const prisma = await getDbFromContext();
  const result = await createRecheckRun(prisma, publicId, { full });
  if (result.kind === "unauthorized") {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(`/verdict/${publicId}`)}`);
  }
  if (result.kind === "not_found") {
    redirect(`/verdict/${publicId}?recheck=notfound`);
  }
  if (result.kind === "ok") {
    redirect(`/run/${result.publicId}`);
  }
}
