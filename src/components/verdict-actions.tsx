"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

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

export function RecheckButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await fetch(`/api/runs/${runId}/recheck`, { method: "POST" }).catch(
          () => null,
        );
        if (res?.ok) {
          const { id } = (await res.json()) as { id: string };
          router.push(`/run/${id}`);
        } else {
          setBusy(false);
        }
      }}
    >
      {busy ? "Queuing…" : "Re-check now"}
    </Button>
  );
}
