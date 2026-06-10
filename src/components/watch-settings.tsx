"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Frequency = "daily" | "every_6h" | "manual";

const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: "Daily",
  every_6h: "Every 6h",
  manual: "Manual",
};

// Screen 4 — Watch settings body. Set-and-forget: frequency, notify rule,
// pause/resume, cancel. Most users land here once and never come back.
export function WatchSettings({
  slug,
  initial,
}: {
  slug: string;
  initial: { frequency: Frequency; notifyOnChangeOnly: boolean; active: boolean };
}) {
  const router = useRouter();
  const [frequency, setFrequency] = useState<Frequency>(initial.frequency);
  const [notifyOnChangeOnly, setNotifyOnChangeOnly] = useState(initial.notifyOnChangeOnly);
  const [active, setActive] = useState(initial.active);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    const res = await fetch(`/api/watch/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) router.refresh();
    return res?.ok ?? false;
  }

  return (
    <section className="card space-y-5 p-6">
      <h2 className="section-label">Settings</h2>

      <div className="flex items-center gap-4">
        <span className="w-24 shrink-0 text-sm text-fg-muted">Frequency</span>
        <div className="flex gap-1.5">
          {(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((f) => (
            <button
              key={f}
              disabled={busy}
              onClick={async () => {
                const prev = frequency;
                setFrequency(f);
                if (!(await patch({ frequency: f }))) setFrequency(prev);
              }}
              className={`rounded-md border px-3 py-1.5 font-mono text-xs transition-colors ${
                frequency === f
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-ink-600 text-fg-muted hover:border-ink-700 hover:text-fg"
              }`}
            >
              {FREQUENCY_LABEL[f]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-4">
        <span className="w-24 shrink-0 pt-0.5 text-sm text-fg-muted">Email me</span>
        <div className="space-y-2">
          {(
            [
              [true, "Only when something changed"],
              [false, "After every run"],
            ] as const
          ).map(([value, label]) => (
            <label key={String(value)} className="flex cursor-pointer items-center gap-2.5 text-sm">
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full border transition-colors ${
                  notifyOnChangeOnly === value ? "border-accent" : "border-ink-600"
                }`}
              >
                {notifyOnChangeOnly === value && (
                  <span className="h-2 w-2 rounded-full bg-accent" />
                )}
              </span>
              <input
                type="radio"
                className="sr-only"
                name="notify"
                checked={notifyOnChangeOnly === value}
                disabled={busy}
                onChange={async () => {
                  const prev = notifyOnChangeOnly;
                  setNotifyOnChangeOnly(value);
                  if (!(await patch({ notifyOnChangeOnly: value }))) setNotifyOnChangeOnly(prev);
                }}
              />
              <span className={notifyOnChangeOnly === value ? "text-fg" : "text-fg-muted"}>
                {label}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-ink-700 pt-4">
        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            const prev = active;
            setActive(!prev);
            if (!(await patch({ active: !prev }))) setActive(prev);
          }}
        >
          {active ? "Pause" : "Resume"}
        </Button>
        {confirmCancel ? (
          <>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const res = await fetch(`/api/watch/${slug}`, { method: "DELETE" }).catch(
                  () => null,
                );
                if (res?.ok) router.push("/check");
                else setBusy(false);
              }}
            >
              Yes, cancel the watch
            </Button>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmCancel(true)}>
            Cancel watch
          </Button>
        )}
      </div>
      <p className="text-xs text-fg-faint">
        Cancelling deletes the watch and the retained test credentials. Past verdicts stay.
      </p>
    </section>
  );
}
