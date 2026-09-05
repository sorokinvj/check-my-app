"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const POLL_MS = 2_000;
// Past this, stop promising "a moment" and say what actually happens next.
const SLOW_AFTER_MS = 90_000;

type State = { state: "pending" } | { state: "started"; runPublicId: string };

// Waits for the paid check's run to exist, then moves the visitor onto it.
// The run is created when Stripe reports the payment settled — by the webhook
// or by the poll itself — so this is normally one or two rounds.
export function PaidCheckStart({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/billing/one-check?session_id=${encodeURIComponent(sessionId)}`);
        if (res.ok) {
          const body = (await res.json()) as State;
          if (body.state === "started") {
            router.push(`/run/${body.runPublicId}`);
            return;
          }
        }
      } catch {
        // A failed poll is retried on the next tick.
      }
      if (Date.now() - startedAt > SLOW_AFTER_MS) setSlow(true);
      timer = setTimeout(tick, POLL_MS);
    };

    let timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, router]);

  return (
    <div className="card mx-auto w-full max-w-xl space-y-4 p-8 text-center">
      <p className="section-label">payment received</p>
      <p className="text-2xl font-semibold tracking-tight text-fg">
        {slow ? "Taking longer than usual." : "Starting your check…"}
      </p>
      {slow ? (
        <>
          <p className="text-sm text-fg-muted">
            Your check will start, and the verdict lands in your inbox if you gave an email.
          </p>
          <Link
            href="/checks/today"
            className="inline-block font-mono text-[13px] text-accent transition-colors hover:underline"
          >
            See today&apos;s checks →
          </Link>
        </>
      ) : (
        <p className="flex items-center justify-center gap-2 font-mono text-[13px] text-fg-faint">
          <span className="inline-block h-2 w-2 animate-pulse-dot rounded-full bg-accent" />
          This takes a moment.
        </p>
      )}
    </div>
  );
}
