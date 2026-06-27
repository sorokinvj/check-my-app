"use client";

import { useState, useTransition } from "react";
import { setTrackerTeam } from "@/app/dashboard/actions";

// Dashboard dropdown to choose which tracker team an app's tickets land in.
export function TeamSelect({
  appId,
  teams,
  current,
}: {
  appId: string;
  teams: { id: string; name: string }[];
  current: string | null;
}) {
  const [value, setValue] = useState(current ?? "");
  const [pending, startTransition] = useTransition();

  return (
    <select
      value={value}
      disabled={pending}
      onChange={(e) => {
        const team = teams.find((t) => t.id === e.target.value);
        if (!team) return;
        setValue(team.id);
        startTransition(() => setTrackerTeam(appId, team.id, team.name));
      }}
      className="rounded border border-ink-700 bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-fg-muted outline-none"
    >
      {teams.map((t) => (
        <option key={t.id} value={t.id} className="bg-ink-950">
          {t.name}
        </option>
      ))}
    </select>
  );
}
