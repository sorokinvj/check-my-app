"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { enableWatchAction, fullRecheckRunAction, recheckRunAction } from "@/app/verdict/actions";
import { track } from "@/lib/analytics";

// Verdict header/footer actions: enable Daily Watch (Loop B) and re-check now
// (Journey 7). Kept client-side so the report page itself stays a server render.

// CHE-75: same pre-hydration treatment as RecheckButton — a form around a
// server action, so an early click can't be silently swallowed. The action
// redirects: to /watch/{slug} on success, to sign-in for anonymous visitors,
// back here with ?watch_error=… when gated (the verdict page renders it).
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
  if (hasWatch) {
    return (
      <Link
        href={`/watch/${appSlug}`}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-ink-600 bg-ink-850 px-4 py-2.5 text-sm text-fg transition-colors hover:border-ink-700 hover:bg-ink-800"
      >
        Watch settings
      </Link>
    );
  }

  return (
    // Recorded on the submit: the action redirects away, so the click is the
    // last moment this page can speak.
    <form action={enableWatchAction.bind(null, runId)} onSubmit={() => track("watch_enabled", { appSlug })}>
      <EnableWatchSubmit variant={variant} />
    </form>
  );
}

function EnableWatchSubmit({ variant }: { variant: "primary" | "outline" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {pending ? "Enabling…" : "Enable Daily Watch"}
    </Button>
  );
}

// A <form> around a server action, not an onClick (CHE-73): the old handler
// attached only after hydration, so an early click was silently swallowed —
// the exact pre-hydration failure this product flags on other people's apps.
// A native form submit works from the first paint.
//
// CHE-137 (owner, 2026-09-06): this is the product's "re-check after a
// deploy" — it re-walks what changed since the last check and is not limited
// on paid plans. The click is recorded on submit: the action redirects away.
export function RecheckButton({ runId, appSlug }: { runId: string; appSlug: string }) {
  return (
    <form
      action={recheckRunAction.bind(null, runId)}
      onSubmit={() => track("recheck_clicked", { kind: "regular", appSlug })}
    >
      <RecheckSubmit label="Re-check after a deploy" title="Re-walks what changed since the last check" />
    </form>
  );
}

// What the plan allows this month, as src/lib/plans.ts fullRechecksRemaining
// reports it: `limit`/`remaining` null = unlimited. The page computes it for
// the run's owner, who is the only viewer this button is rendered for.
export type FullRecheckAllowance = {
  limit: number | null;
  remaining: number | null;
  resetsOn: string;
};

// CHE-74: walk everything from scratch — carried journeys get re-verified
// instead of riding the partial-run carry forever. CHE-137: metered per plan
// and month; the button says what is left, and when nothing is, it says so
// here instead of refusing on click (a control that fails on click is the
// defect this product flags on other people's apps, CHE-108).
export function FullRecheckButton({
  runId,
  appSlug,
  allowance,
}: {
  runId: string;
  appSlug: string;
  allowance: FullRecheckAllowance | null;
}) {
  const { title, exhausted } = fullRecheckTooltip(allowance);
  return (
    <form
      action={fullRecheckRunAction.bind(null, runId)}
      onSubmit={() => track("recheck_clicked", { kind: "full", appSlug })}
    >
      <RecheckSubmit label="Full re-check" title={title} disabled={exhausted} />
    </form>
  );
}

// Pure, so the wording can be asserted without rendering. The refusal wording
// mirrors fullRecheckGate in src/lib/plans.ts: the limit is on the expensive
// mode, never on re-checking.
export function fullRecheckTooltip(allowance: FullRecheckAllowance | null): {
  title: string;
  exhausted: boolean;
} {
  const walks = "Walks every journey from scratch.";
  if (!allowance || allowance.limit === null || allowance.remaining === null) {
    return { title: `${walks} Unlimited on your plan.`, exhausted: false };
  }
  if (allowance.limit === 0) {
    return {
      title: "Full re-checks aren't included on your plan; a regular re-check is still available",
      exhausted: true,
    };
  }
  if (allowance.remaining <= 0) {
    return {
      title: `Full re-checks used up until ${allowance.resetsOn}; a regular re-check is still available`,
      exhausted: true,
    };
  }
  return {
    title: `${walks} ${allowance.remaining} of ${allowance.limit} left this month.`,
    exhausted: false,
  };
}

function RecheckSubmit({
  label,
  title,
  disabled = false,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  // A disabled <button> receives no pointer events in some browsers, so its
  // own title never shows; the wrapping span carries it too.
  return (
    <span title={title} className="inline-flex">
      <Button type="submit" variant="outline" disabled={pending || disabled} title={title}>
        {pending ? "Queuing…" : label}
      </Button>
    </span>
  );
}
