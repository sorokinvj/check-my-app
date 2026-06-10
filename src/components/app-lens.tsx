"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AppLens } from "@/lib/types";

// Verdict §3.1 — "HOW WE SAW YOUR APP". The "they got it" moment, rendered first.
// Loop C: one-click confirm, "something's off" note, and full inline edit (✏).
export function AppLensSection({
  runId,
  appSlug,
  lens: initialLens,
  feedback: initialFeedback,
}: {
  runId: string;
  appSlug: string;
  lens: AppLens | null;
  feedback: string | null;
}) {
  const router = useRouter();
  const [lens, setLens] = useState(initialLens);
  const [feedback, setFeedback] = useState(initialFeedback);
  const [editing, setEditing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  if (!lens) return null;

  async function patch(body: { lens?: AppLens; feedback?: string }) {
    setSaving(true);
    try {
      const res = await fetch(`/api/runs/${runId}/lens`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (body.lens) setLens(body.lens);
        if (body.feedback !== undefined) setFeedback(body.feedback);
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between">
        <h2 className="section-label">How we saw your app</h2>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="font-mono text-xs text-fg-faint transition-colors hover:text-fg"
          >
            edit ✏
          </button>
        )}
      </div>

      {editing ? (
        <LensEditor
          lens={lens}
          saving={saving}
          onCancel={() => setEditing(false)}
          onSave={async (next) => {
            await patch({ lens: next });
            setEditing(false);
          }}
        />
      ) : (
        <>
          <p className="mt-4 text-lg leading-relaxed text-fg">{lens.oneLiner}</p>
          <ul className="mt-4 space-y-2 text-sm leading-relaxed text-fg-muted">
            <Bullet label="Who it's for" value={lens.whoFor} />
            <Bullet label="Core value" value={lens.coreValue} />
            <Bullet label="How it makes money" value={lens.businessModel} />
            <Bullet label="Tech surface" value={lens.techSurface} />
            {lens.criticalPaths.length > 0 && (
              <li>
                <span className="text-fg">Critical paths to protect:</span>
                <ol className="ml-1 mt-1 space-y-1">
                  {lens.criticalPaths.map((p, i) => (
                    <li key={i} className="font-mono text-[13px]">
                      <span className="text-fg-faint">{i + 1}.</span> {p}
                    </li>
                  ))}
                </ol>
              </li>
            )}
            <Bullet label="If something breaks" value={lens.ifItBreaks} />
          </ul>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-ink-700 pt-4">
            {feedback === "confirmed" ? (
              <p className="font-mono text-[13px] text-status-ok">
                ✓ You confirmed this reading of {appSlug}
              </p>
            ) : feedback ? (
              <p className="font-mono text-[13px] text-status-confusing">
                Noted — the agent re-reads your correction on the next run.
              </p>
            ) : noteOpen ? (
              <div className="flex w-full gap-2">
                <Input
                  placeholder="What's off? e.g. we're B2B, not B2C — revenue is per-seat"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  autoFocus
                />
                <Button
                  variant="outline"
                  disabled={!note.trim() || saving}
                  onClick={() => patch({ feedback: note.trim() })}
                >
                  Send
                </Button>
              </div>
            ) : (
              <>
                <Button variant="outline" disabled={saving} onClick={() => patch({ feedback: "confirmed" })}>
                  Looks right ✓
                </Button>
                <Button variant="ghost" onClick={() => setNoteOpen(true)}>
                  Something&apos;s off — tell us what
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Bullet({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <li>
      <span className="text-fg">{label}:</span> {value}
    </li>
  );
}

function LensEditor({
  lens,
  saving,
  onSave,
  onCancel,
}: {
  lens: AppLens;
  saving: boolean;
  onSave: (next: AppLens) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AppLens>({ ...lens });
  const set = (k: keyof AppLens) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <div className="mt-4 space-y-3">
      <Field label="One-liner">
        <Input value={draft.oneLiner} onChange={set("oneLiner")} />
      </Field>
      <Field label="Who it's for">
        <Input value={draft.whoFor} onChange={set("whoFor")} />
      </Field>
      <Field label="Core value">
        <Input value={draft.coreValue} onChange={set("coreValue")} />
      </Field>
      <Field label="How it makes money">
        <Input value={draft.businessModel} onChange={set("businessModel")} />
      </Field>
      <Field label="Tech surface">
        <Input value={draft.techSurface} onChange={set("techSurface")} />
      </Field>
      <Field label="Critical paths (one per line)">
        <textarea
          className="w-full rounded-lg border border-ink-600 bg-ink-900 px-3.5 py-2.5 font-mono text-[13px] text-fg outline-none focus:border-accent"
          rows={3}
          value={draft.criticalPaths.join("\n")}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              criticalPaths: e.target.value.split("\n").filter((s) => s.trim()),
            }))
          }
        />
      </Field>
      <Field label="If something breaks">
        <Input value={draft.ifItBreaks} onChange={set("ifItBreaks")} />
      </Field>
      <div className="flex gap-2 pt-1">
        <Button disabled={saving} onClick={() => onSave(draft)}>
          {saving ? "Saving…" : "Save lens"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-fg-faint">
        The agent uses your corrected lens to re-evaluate journeys on the next run.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-fg-faint">
        {label}
      </span>
      {children}
    </label>
  );
}
