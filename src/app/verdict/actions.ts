"use server";

// Verdict page actions. Server actions on purpose (CHE-73): a <form action>
// submits natively even before React hydrates, so an early click on
// "Re-check now" can't be silently swallowed the way an onClick was.

import { redirect } from "next/navigation";
import { getDbFromContext } from "@/lib/db";
import { createRecheckRun } from "@/lib/recheck";

export async function recheckRunAction(publicId: string): Promise<void> {
  const prisma = await getDbFromContext();
  const result = await createRecheckRun(prisma, publicId);
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
