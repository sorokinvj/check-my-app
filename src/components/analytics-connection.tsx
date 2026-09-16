// The analytics connection, as the team sees it (CHE-236).
//
// Three states and no fourth: not connected, connected as a named organisation,
// or connected and expired. The third exists because it is the one that decides
// whether this integration is honest — a connection whose token has expired and
// cannot be renewed still looks perfect if the screen only knows "a row exists"
// (CHE-269, where the dashboard said Connected for weeks while nothing was
// being filed). So the row's own expiry is read here and said out loud.
//
// Connect is a link, not a form: it leaves for PostHog's consent screen.
// Disconnect is a form, because it changes something of ours.

import { Button } from "@/components/ui/button";
import { disconnectPostHog } from "@/app/dashboard/actions";

export interface AnalyticsConnectionProps {
  connection: {
    organizationName: string | null;
    region: string | null;
    /**
     * Expired AND unrenewable — the only state worth alarming about, since an
     * expired token with a refresh token renews itself on the next read.
     * Decided by the page that read the row: "has it expired" depends on now,
     * and a component that asks the clock while rendering is not a function of
     * its props.
     */
    stranded: boolean;
  } | null;
}

export function AnalyticsConnection({ connection }: AnalyticsConnectionProps) {
  const stranded = connection?.stranded ?? false;

  return (
    <section className="card mt-8 p-5">
      <p className="section-label">analytics</p>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          {connection ? (
            <>
              <p className="text-sm text-fg">
                <span className={stranded ? "text-status-confusing" : "text-status-ok"}>
                  {stranded ? "!" : "✓"}
                </span>{" "}
                Connected as{" "}
                <span className="font-mono">{connection.organizationName ?? "—"}</span>
                {connection.region && (
                  <span className="text-fg-faint"> · {connection.region.toUpperCase()}</span>
                )}
              </p>
              <p className="text-xs text-fg-faint">
                {stranded
                  ? "This connection has expired — reconnect to keep reading your funnels."
                  : "Read-only. We read your funnels; we never write to your analytics."}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-fg">PostHog is not connected.</p>
              <p className="text-xs text-fg-faint">
                Connect it and a check can say what a journey costs you in real users, not just
                whether it works.
              </p>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {connection ? (
            <>
              {stranded && (
                <a
                  href="/api/integrations/posthog/start"
                  className="text-xs text-accent hover:underline"
                >
                  Reconnect →
                </a>
              )}
              <form action={disconnectPostHog}>
                <Button type="submit" variant="outline" className="px-3 py-1.5 text-xs">
                  Disconnect
                </Button>
              </form>
            </>
          ) : (
            <a
              href="/api/integrations/posthog/start"
              className="text-xs text-accent hover:underline"
            >
              Connect PostHog →
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
