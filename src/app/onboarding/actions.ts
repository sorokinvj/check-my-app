"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { appSlugFromUrl } from "@/lib/utils";

// Persist an onboarded App + its Watch + TicketPolicy in one nested write.
// D1 has no transactions, but the spike (CHE-21) proved nested create works and
// these rows are created together once per app, so partial state is unlikely.
export async function createApp(formData: FormData) {
  const { user, db } = await requireUser();

  const targetUrl = String(formData.get("targetUrl") ?? "").trim();
  if (!/^https?:\/\/.+\..+/.test(targetUrl)) {
    throw new Error("Enter a valid app URL (https://…)");
  }
  const appSlug = appSlugFromUrl(targetUrl);

  const testEmail = (String(formData.get("testEmail") ?? "").trim() || null) as string | null;
  const testPassword = String(formData.get("testPassword") ?? "");
  const testPasswordEnc = testPassword ? encryptSecret(testPassword) : null;
  const scopeHints = (String(formData.get("scopeHints") ?? "").trim() || null) as string | null;
  const userNotes = (String(formData.get("userNotes") ?? "").trim() || null) as string | null;
  const notifyEmail = (String(formData.get("notifyEmail") ?? "").trim() || null) as string | null;
  const frequency = String(formData.get("frequency") ?? "daily");

  // Ticket policy — the pickup contract with the owner's own automation.
  const pickupLabels = String(formData.get("pickupLabels") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const repoLabel = (String(formData.get("repoLabel") ?? "").trim() || null) as string | null;
  const urgentJourneys = String(formData.get("urgentJourneys") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await db.app.create({
    data: {
      ownerId: user.id,
      orgId: user.clerkOrgId ?? null,
      targetUrl,
      appSlug,
      testEmail,
      testPasswordEnc,
      scopeHints,
      userNotes,
      watch: {
        create: {
          appSlug,
          targetUrl,
          frequency,
          notifyEmail,
          ownerId: user.id,
          testEmail,
          testPasswordEnc,
        },
      },
      policy: {
        create: {
          pickupLabels: JSON.stringify(pickupLabels),
          repoLabel,
          priorityRule: JSON.stringify({ urgent: urgentJourneys }),
        },
      },
    },
  });

  redirect("/dashboard");
}
