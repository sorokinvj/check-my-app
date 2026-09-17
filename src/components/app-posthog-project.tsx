"use client";

// Which PostHog project this app reads, in the app's own row (CHE-237).
//
// The connection is the team's — one OAuth handshake, made once. The PROJECT is
// the app's, because a PostHog account holds several and they map to products
// one to one: checkmyapp.dev → "Check My App", meetbashar.com → "Meet Bashar".
//
// **It saves on change, and there is no Save button.** The first version had
// one, and the owner picked a project in all four rows, saw four correct-looking
// dropdowns, and reasonably concluded he was done — nothing had been saved. A
// control that displays a value it has not stored is lying, and it lies in the
// worst way: quietly, with the screen agreeing with you. The Linear picker in
// the row above already worked this way; matching it was the answer.
//
// **This row is a control, not an explanation.** Two things were taken out of
// it after the owner read them here (2026-09-17):
//
//   - the option said "— none: use our estimate —". A dropdown is not where
//     anyone learns what an estimate is, and "our" read as the reader's own.
//     It is "— none —" now, and what happens without a project is explained on
//     the app's own settings page and on /analytics-access.
//   - a "why this one?" link pointed at the suggestion and its reasoning. But
//     the suggestion is not SHOWN here — working out which project has seen
//     this app's host costs a query per project, and a dashboard listing ten
//     apps must not pay that ten times over. So the link asked "why this one?"
//     about a recommendation the reader could not see: an orphaned pointer,
//     the same defect in prose as a code comment naming the wrong ticket.

import { useState, useTransition } from "react";
import { setAppPosthogProject } from "@/app/dashboard/actions";
import type { PostHogProject } from "@/lib/posthog/projects";

export function AppPostHogProject({
  appId,
  chosen,
  projects,
}: {
  appId: string;
  chosen: { id: string; name: string | null } | null;
  /** Every project the team's connection can see. Empty = we could not list. */
  projects: readonly PostHogProject[];
}) {
  // A stored project that is no longer in the account: say what we are reading
  // rather than silently showing "none" and losing the fact.
  const known = chosen ? projects.some((p) => p.id === chosen.id) : true;
  const [value, setValue] = useState(chosen && known ? chosen.id : "");
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-fg-muted">PostHog project:</span>
      <select
        value={value}
        disabled={pending || projects.length === 0}
        onChange={(e) => {
          const id = e.target.value;
          const name = projects.find((p) => p.id === id)?.name ?? "";
          setValue(id);
          setSaved(false);
          // The action takes a FormData because it is also reachable from the
          // app's settings page, where there is a real form.
          const form = new FormData();
          form.set("posthogProject", id ? `${id}:${name}` : "");
          startTransition(async () => {
            await setAppPosthogProject(appId, form);
            setSaved(true);
          });
        }}
        className="rounded border border-ink-700 bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-fg-muted outline-none"
      >
        <option value="" className="bg-ink-950">
          — none —
        </option>
        {projects.map((p) => (
          <option key={p.id} value={p.id} className="bg-ink-950">
            {p.name}
          </option>
        ))}
      </select>

      {/* Two different facts, and the first version conflated them.
          "saved" is an acknowledgement of an ACTION and dies on reload; a
          stored project is a STATE and does not. Showing only the
          acknowledgement meant that after a reload three rows the owner had
          just changed said "saved" and the fourth — stored days earlier, and
          perfectly fine — said nothing. Absence of the badge read as "not
          saved" while the database held the value.
          So the tick is the state and stays; "saving…" is the action. The
          absence of a tick now means exactly what it looks like. */}
      {pending ? (
        <span className="text-xs text-fg-faint">saving…</span>
      ) : value ? (
        <span className="text-xs text-status-ok">{saved ? "✓ saved" : "✓"}</span>
      ) : null}

      {chosen && !known && (
        <span className="text-xs text-status-confusing">
          reading {chosen.name ?? chosen.id}, which is no longer in this account
        </span>
      )}
      {projects.length === 0 && (
        <span className="text-xs text-fg-faint">no projects readable on this connection</span>
      )}
    </div>
  );
}
