"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { recheckRunAction } from "@/app/verdict/actions";

// Verdict header/footer actions: enable Daily Watch (Loop B) and re-check now
// (Journey 7). Kept client-side so the report page itself stays a server render.

export function EnableWatchButton({
  runId,
  hasWatch,
  appSlug,
  variant = "primary",
}: {
  runId: string;
  hasWatch: boolean;
  appSlug: string;
  variant?: "primary" | "outline";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (hasWatch) {
    return (
      <Button variant="outline" onClick={() => router.push(`/watch/${appSlug}`)}>
        Watch settings
      </Button>
    );
  }

  return (
    <div className="space-y-1.5">
      <Button
        variant={variant}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          const res = await fetch("/api/watch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId }),
          }).catch(() => null);
          if (res?.ok) {
            const { slug } = (await res.json()) as { slug: string };
            router.push(`/watch/${slug}`);
            return;
          }
          // Daily Watch is an owner feature — send anonymous visitors to sign in
          // and bring them back here to enable it.
          if (res?.status === 401) {
            const back = encodeURIComponent(window.location.pathname);
            router.push(`/sign-in?redirect_url=${back}`);
            return;
          }
          const body = ((await res?.json().catch(() => null)) ?? {}) as { error?: string };
          setErr(body.error ?? "Couldn't enable Daily Watch.");
          setBusy(false);
        }}
      >
        {busy ? "Enabling…" : "Enable Daily Watch"}
      </Button>
      {err && <p className="text-xs text-status-broken">{err}</p>}
    </div>
  );
}

// A <form> around a server action, not an onClick (CHE-73): the old handler
// attached only after hydration, so an early click was silently swallowed —
// the exact pre-hydration failure this product flags on other people's apps.
// A native form submit works from the first paint.
export function RecheckButton({ runId }: { runId: string }) {
  return (
    <form action={recheckRunAction.bind(null, runId)}>
      <RecheckSubmit />
    </form>
  );
}

function RecheckSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" disabled={pending}>
      {pending ? "Queuing…" : "Re-check now"}
    </Button>
  );
}
