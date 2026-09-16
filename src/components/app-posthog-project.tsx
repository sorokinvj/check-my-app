// Which PostHog project this app reads, in the app's own row (CHE-237).
//
// The connection is the team's — one OAuth handshake, made once. The PROJECT is
// the app's, because a PostHog account holds several and they map to products
// one to one. On the owner's own account today: checkmyapp.dev → "Check My
// App", meetbashar.com → "Meet Bashar".
//
// This lives in the dashboard row rather than only on the app's settings page
// because that is where the question is asked. The owner connected analytics,
// saw one line saying "Connected", and had no way to tell which project fed
// which app — a setting nobody can find is a setting nobody sets (owner,
// 2026-09-16). Same shape as the Linear row directly above it.
//
// The suggestion, and the reason for it, stay on the settings page: working out
// which project has seen this app's host costs a query per project, and a
// dashboard listing ten apps must not make ten times that many. Here the owner
// picks by name; there they get told why one name is the likely one.

import Link from "next/link";
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

  return (
    <form action={setAppPosthogProject.bind(null, appId)} className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-fg-muted">PostHog project:</span>
      <select
        name="posthogProject"
        defaultValue={chosen && known ? `${chosen.id}:${chosen.name ?? ""}` : ""}
        className="rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-fg"
      >
        <option value="">— none: use our estimate —</option>
        {projects.map((p) => (
          <option key={p.id} value={`${p.id}:${p.name}`}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="submit" className="text-xs text-accent hover:underline">
        Save
      </button>
      {chosen && !known && (
        <span className="text-xs text-status-confusing">
          reading {chosen.name ?? chosen.id}, which is no longer in this account
        </span>
      )}
      {projects.length === 0 && (
        <span className="text-xs text-fg-faint">no projects readable on this connection</span>
      )}
      <Link href={`/dashboard/${appId}`} className="text-xs text-fg-faint hover:text-fg-muted">
        why this one?
      </Link>
    </form>
  );
}
