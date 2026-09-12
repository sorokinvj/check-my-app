"use client";

import { useActionState } from "react";
import { runSavedApp } from "@/app/dashboard/actions";
import { Button } from "./ui/button";

export function RunSavedApp({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState(runSavedApp.bind(null, appId), null);
  return <form action={action} className="space-y-2">
    <Button type="submit" variant="outline" disabled={pending} className="text-xs">
      {pending ? "Starting…" : "Run check"}
    </Button>
    {state?.error && <p role="alert" className="max-w-xs text-xs text-status-broken">{state.error}</p>}
  </form>;
}
