import Link from "next/link";
import { PaidCheckStart } from "@/components/paid-check-start";

export const dynamic = "force-dynamic";

// Stripe's success page for the $1 one-off check · /check/paid?session_id=…
// The run starts once Stripe reports the payment settled — usually by the time
// the visitor lands here. The client component polls and moves them to the
// live run; this page only needs to survive a missing session id.
export default async function PaidCheckPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id: sessionId } = await searchParams;
  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center px-4 py-16">
      {sessionId ? (
        <PaidCheckStart sessionId={sessionId} />
      ) : (
        <div className="card mx-auto max-w-xl space-y-3 p-8 text-center">
          <p className="text-lg font-medium text-fg">This link is missing its payment reference.</p>
          <p className="text-sm text-fg-muted">
            If you just paid, your check will still start, and the verdict lands in your inbox if
            you gave an email.
          </p>
          <Link
            href="/check"
            className="inline-block font-mono text-[13px] text-accent transition-colors hover:underline"
          >
            Back to the form →
          </Link>
        </div>
      )}
    </main>
  );
}
