"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { appSlugFromUrl } from "@/lib/utils";
import { assertCanAddWatch } from "@/lib/plans";
import type { UserPlan, WatchFrequency } from "@/lib/enums";

// Persist an onboarded App + its Watch + TicketPolicy in one nested write.
// D1 has no transactions, but the spike (CHE-21) proved nested create works and
// these rows are created together once per app, so partial state is unlikely.
//
// CHE-84: business outcomes (plan cap, duplicate app, bad URL) are RETURNED,
// never thrown. A thrown error in a server action becomes an HTTP 500 and the
// generic "a server error occurred" page — our own self-check hit the free-plan
// watch cap and saw exactly that, with the app silently not created. A refusal
// the owner can act on must always arrive as text next to the button.
export type CreateAppResult = { error: string } | null;

// useActionState signature (prevState, formData): the form works as a plain
// HTML POST before hydration, so an early click is never swallowed (CHE-73/75
// class — the same bug we fixed on the verdict page).
export async function createApp(
  _prevState: CreateAppResult,
  formData: FormData,
): Promise<CreateAppResult> {
  const { user, db } = await requireUser();

  const targetUrl = String(formData.get("targetUrl") ?? "").trim();
  if (!/^https?:\/\/.+\..+/.test(targetUrl)) {
    return { error: "Enter a valid app URL (https://…)" };
  }
  const appSlug = appSlugFromUrl(targetUrl);

  const testEmail = (String(formData.get("testEmail") ?? "").trim() || null) as string | null;
  const testPassword = String(formData.get("testPassword") ?? "");
  const testPasswordEnc = testPassword ? encryptSecret(testPassword) : null;
  const focusAreas = (String(formData.get("focusAreas") ?? "").trim() || null) as string | null;
  const scopeHints = (String(formData.get("scopeHints") ?? "").trim() || null) as string | null;
  const userNotes = (String(formData.get("userNotes") ?? "").trim() || null) as string | null;
  const notifyEmail = (String(formData.get("notifyEmail") ?? "").trim() || null) as string | null;
  const frequency = String(formData.get("frequency") ?? "daily") as WatchFrequency;

  // Tier gate (CHE-34): Daily Watch availability + cadence + count per plan.
  const gate = await assertCanAddWatch(db, {
    ownerId: user.id,
    plan: user.plan as UserPlan,
    frequency,
  });
  if (!gate.ok) return { error: gate.reason };

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

  // One App per (owner, slug). Pre-check for a clear message, and catch the
  // unique-constraint race (D1 has no transactions, so a double-submit can slip
  // past the check) rather than surfacing a raw 500.
  const dupe = await db.app.findUnique({
    where: { ownerId_appSlug: { ownerId: user.id, appSlug } },
    select: { id: true },
  });
  if (dupe) {
    return { error: "You already have this app — manage it from your dashboard." };
  }

  try {
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
        focusAreas,
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
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return { error: "You already have this app — manage it from your dashboard." };
    }
    throw err;
  }

  redirect("/dashboard");
}
