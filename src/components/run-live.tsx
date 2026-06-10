"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PHASE_LABELS, PHASE_ORDER, type RunEvent, type RunPhase } from "@/lib/types";

interface Snapshot {
  status: string;
  events: RunEvent[] | null;
  verdict: string | null;
  errorMessage: string | null;
}

const ICON: Record<RunEvent["icon"], string> = {
  ok: "✓",
  info: "•",
  notable: "⚡",
  working: "⏳",
  warn: "⚠",
};

// Screen 2 — In-progress. Subscribes to the SSE feed and renders the phase banner
// + live activity feed. Redirects to the verdict when the run completes.
export function RunLive({ publicId, appSlug }: { publicId: string; appSlug: string }) {
  const router = useRouter();
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${publicId}/stream`);
    es.addEventListener("snapshot", (e) => setSnap(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("done", (e) => {
      es.close();
      const status = (e as MessageEvent).data;
      if (status === "completed" || status === "partial") {
        router.push(`/verdict/${publicId}`);
      }
    });
    es.addEventListener("error", () => es.close());
    return () => es.close();
  }, [publicId, router]);

  const phase = (snap?.status ?? "connecting") as RunPhase;
  const phaseIndex = Math.max(0, PHASE_ORDER.indexOf(phase));
  const pct = Math.round(((phaseIndex + 1) / PHASE_ORDER.length) * 100);
  const events = snap?.events ?? [];

  if (snap?.status === "failed") {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        <p className="font-medium">Something broke on our side. We&apos;re looking at it.</p>
        {snap.errorMessage && (
          <p className="mono mt-2 text-neutral-500">{snap.errorMessage}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between text-sm text-neutral-500">
        <span className="mono">{appSlug}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
        <div className="h-full bg-blue-600 transition-all" style={{ width: `${pct}%` }} />
      </div>

      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
        <p className="font-medium">{PHASE_LABELS[phase] ?? "Starting up"}</p>
        <p className="text-sm text-neutral-500">
          Phase {phaseIndex + 1} of {PHASE_ORDER.length}
        </p>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-4">
        <p className="mb-2 text-sm font-medium text-neutral-700">What we&apos;re doing</p>
        <ul className="space-y-1">
          {events.length === 0 && <li className="text-sm text-neutral-400">Starting up…</li>}
          {events.map((ev, i) => (
            <li key={i} className="mono text-neutral-700">
              <span className="text-neutral-400">
                {new Date(ev.at).toLocaleTimeString()}
              </span>{" "}
              {ICON[ev.icon]} {ev.text}
            </li>
          ))}
        </ul>
      </div>

      <p className="text-center text-sm text-neutral-500">
        Close this tab — we&apos;ll email you when it&apos;s done.
      </p>
    </div>
  );
}
