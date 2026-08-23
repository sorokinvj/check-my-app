import { requireUser } from "@/lib/auth";
import { OnboardingWizard } from "@/components/onboarding-wizard";

// Onboarding (protected by proxy.ts). requireUser() also lazily creates the D1
// mirror row on first visit. Prefilled with ?url= when arriving from a verdict.
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const { user } = await requireUser();
  const { url } = await searchParams;
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12">
      <OnboardingWizard prefillUrl={url ?? ""} defaultEmail={user.email ?? ""} />
    </main>
  );
}
