"use client";

import { useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { track } from "@/lib/analytics";

// Paid-plan CTA on /pricing (CHE-40 phase 3). Signed-out visitors go to
// /sign-in as before; signed-in owners start a Stripe Checkout session. Until
// billing is configured the API answers 503 `billing_unconfigured` and this
// shows a quiet "launches soon" note instead of an error — the button ships
// before the Stripe account does.
export function UpgradeCta({
  plan,
  label,
  className,
}: {
  plan: "starter" | "growth";
  label: string;
  className: string;
}) {
  const { isLoaded, isSignedIn } = useUser();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!isLoaded || !isSignedIn) {
    return (
      <Link href="/sign-in" className={className}>
        {label}
      </Link>
    );
  }

  async function checkout() {
    track("checkout_opened", { plan });
    setBusy(true);
    setNote(null);
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as
      | { url?: string; code?: string; error?: string }
      | null;
    if (res?.ok && body?.url) {
      window.location.assign(body.url);
      return; // keep the button disabled while the browser navigates
    }
    setBusy(false);
    setNote(
      body?.code === "billing_unconfigured"
        ? "Billing launches soon — you're on the list."
        : (body?.error ?? "Something went wrong — try again."),
    );
  }

  return (
    <div className="space-y-2">
      <button type="button" disabled={busy} onClick={checkout} className={className}>
        {busy ? "Redirecting…" : label}
      </button>
      {note && <p className="text-center font-mono text-xs text-fg-faint">{note}</p>}
    </div>
  );
}
