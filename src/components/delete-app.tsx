"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { deleteApp } from "@/app/dashboard/actions";
import { Input } from "@/components/ui/input";

// Removing an app (CHE-95). Confirmation is typing the app's own name rather
// than a modal: nothing here can fire from a stray click, and the server
// re-checks the typed value, so the UI is not the only thing standing between
// an owner and losing their watch.
export function DeleteAppSection({ appId, appSlug }: { appId: string; appSlug: string }) {
  const [state, formAction] = useActionState(deleteApp.bind(null, appId), null);

  return (
    <section className="mt-12">
      <p className="section-label">stop watching</p>
      <details className="card mt-3 p-5">
        <summary className="cursor-pointer text-sm text-fg">Remove this app</summary>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-fg-muted">
            The daily check stops and the app stops counting against your plan. Verdicts already
            published stay reachable at their links — they are the record of what your app looked
            like on those days, and deleting them would break anything you shared.
          </p>
          <form action={formAction} className="flex flex-wrap items-center gap-2">
            <Input
              name="confirmSlug"
              placeholder={appSlug}
              aria-label={`Type ${appSlug} to confirm`}
              className="max-w-xs"
            />
            <RemoveButton />
          </form>
          {state?.error && <p className="text-sm text-status-broken">{state.error}</p>}
        </div>
      </details>
    </section>
  );
}

function RemoveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg border border-status-broken/50 px-3 py-2 text-sm text-status-broken transition-colors hover:bg-status-broken/10 disabled:opacity-60"
    >
      {pending ? "Removing…" : "Remove app"}
    </button>
  );
}
