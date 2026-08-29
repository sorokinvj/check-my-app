import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { watchCapReason } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";

// Onboarding (protected by proxy.ts). requireUser() also lazily creates the D1
// mirror row on first visit. Prefilled with ?url= when arriving from a verdict.
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const { user, db } = await requireUser();
  const { url } = await searchParams;
  // CHE-95 (found by our own check): the plan cap used to announce itself only
  // after the owner had filled the whole form and pressed Save. Say it first.
  const activeWatches = await db.watch.count({ where: { ownerId: user.id, active: true } });
  const capReason = watchCapReason(user.plan as UserPlan, activeWatches);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12">
      {capReason && (
        <div className="card mb-6 border-status-confusing/40 bg-status-confusing/5 p-4">
          <p className="text-sm text-status-confusing">{capReason}</p>
          <p className="mt-1 text-xs text-fg-muted">
            You can still fill this in, but saving will be refused until you{" "}
            <Link href="/pricing" className="text-accent hover:underline">
              upgrade
            </Link>{" "}
            or remove an app you no longer watch.
          </p>
        </div>
      )}
      <OnboardingWizard prefillUrl={url ?? ""} defaultEmail={user.email ?? ""} />
    </main>
  );
}
