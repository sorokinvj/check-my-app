"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createApp } from "@/app/onboarding/actions";

// Owner onboarding. One sectioned form (resumable multi-step is a later refinement)
// that captures everything the agent needs for recurring QA + the ticket contract,
// then persists an App + Watch + TicketPolicy via the createApp server action.
export function OnboardingWizard({ prefillUrl }: { prefillUrl: string }) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      action={async (fd) => {
        setSubmitting(true);
        await createApp(fd);
      }}
      className="space-y-8"
    >
      <div className="space-y-2">
        <p className="section-label">set up daily QA</p>
        <h1 className="text-3xl font-semibold tracking-tight">Add your app</h1>
        <p className="text-sm text-fg-muted">
          We&apos;ll check it every day and file one ticket per new regression into your tracker.
        </p>
      </div>

      {/* 1 — Site */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">1 · Site</p>
        <Input
          name="targetUrl"
          type="url"
          placeholder="https://your-app.com"
          defaultValue={prefillUrl}
          required
        />
      </section>

      {/* 2 — Test login */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">
          2 · Test login <span className="font-normal text-fg-faint">(recommended)</span>
        </p>
        <Input name="testEmail" type="email" placeholder="test@your-app.com" autoComplete="off" />
        <Input
          name="testPassword"
          type="password"
          placeholder="••••••••"
          autoComplete="new-password"
        />
        <p className="text-xs text-fg-faint">
          Encrypted at rest, never logged, never in evidence. Google-OAuth logins aren&apos;t
          auto-walkable yet — use an email/password test user.
        </p>
      </section>

      {/* 3 — Tracker (Linear) */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">3 · Connect your tracker</p>
        <p className="text-xs text-fg-faint">
          After you save, connect Linear from your dashboard (one-click OAuth) — we&apos;ll file
          tickets into the team you authorize. Set the pickup parameters below so your self-healing
          automation picks them up.
        </p>
      </section>

      {/* 4 — Ticket parameters */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">4 · Ticket parameters</p>
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">Pickup labels (comma-separated)</span>
          <Input name="pickupLabels" placeholder="monitor" defaultValue="monitor" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">Repo label</span>
          <Input name="repoLabel" placeholder="repo: your-app" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">
            Critical journeys → Urgent (comma-separated)
          </span>
          <Input name="urgentJourneys" placeholder="login, dashboard, checkout" />
        </label>
        <p className="text-xs text-fg-faint">
          These are the labels that make <em>your</em> automation pick up the ticket. We never guess
          them.
        </p>
      </section>

      {/* 5 — Scope & notes */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">5 · Scope &amp; notes</p>
        <Input name="scopeHints" placeholder="Don't touch /admin" />
        <Input name="userNotes" placeholder="Don't delete the test account. OK to create sessions." />
      </section>

      {/* 6 — Cadence & notifications */}
      <section className="card space-y-3 p-5">
        <p className="text-sm font-medium text-fg">6 · Cadence &amp; notifications</p>
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">Frequency</span>
          <select
            name="frequency"
            defaultValue="daily"
            className="w-full rounded-md border border-ink-700 bg-transparent px-3 py-2 font-mono text-sm text-fg outline-none"
          >
            <option value="daily">Daily</option>
            <option value="every_6h">Every 6 hours</option>
            <option value="manual">Manual only</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">Escalation email</span>
          <Input name="notifyEmail" type="email" placeholder="you@email.com" />
        </label>
      </section>

      <Button type="submit" disabled={submitting} className="w-full py-3.5 text-[15px]">
        {submitting ? "Saving…" : "Save & start watching"}
      </Button>
    </form>
  );
}
