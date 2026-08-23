import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { fetchTeams } from "@/lib/tracker/linear-oauth";
import { TeamSelect } from "@/components/team-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { setIntegrationEndpoints } from "./actions";
import { ApiKeys } from "@/components/api-keys";
import { watchTrialState, PLAN_LIMITS } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";

// Owner home (protected). Lists the apps this owner has under daily QA.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ integration?: string }>;
}) {
  const { integration } = await searchParams;
  const { user, db } = await requireUser();
  const apps = await db.app.findMany({
    where: { ownerId: user.id },
    include: {
      watch: true,
      policy: true,
      tracker: true,
      runs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });
  const apiKeys = await db.apiKey.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, lastUsedAt: true, createdAt: true },
  });
  // API key creation is a Business+ feature (CHE-62); mirrors the pricing page.
  const apiAccess = PLAN_LIMITS[user.plan as UserPlan].apiAccess;

  // For connected apps, pull the workspace teams so the owner can pick which one
  // tickets land in (best-effort — a transient Linear error just hides the picker).
  const teamsByApp: Record<string, { id: string; name: string }[]> = {};
  await Promise.all(
    apps.map(async (app) => {
      if (!app.tracker) return;
      try {
        teamsByApp[app.id] = await fetchTeams(decryptSecret(app.tracker.accessTokenEnc));
      } catch {
        teamsByApp[app.id] = [];
      }
    }),
  );

  // CHE-67: the Connect Linear flow bounces back here with a hint when the
  // integration isn't set up yet or the OAuth handshake failed — surface it as
  // a small inline notice instead of the old raw JSON error page.
  const integrationNotice =
    integration === "linear_unconfigured"
      ? "Linear isn't connected yet — the integration is being set up."
      : integration === "linear_failed"
        ? "Couldn't connect Linear — please try again."
        : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      {integrationNotice && (
        <div className="card mb-6 flex items-start justify-between gap-4 p-4">
          <div>
            <p className="section-label">integration</p>
            <p className="text-sm text-status-confusing">{integrationNotice}</p>
          </div>
          <Link href="/dashboard" className="text-xs text-fg-muted hover:text-fg" aria-label="Dismiss">
            Dismiss ✕
          </Link>
        </div>
      )}

      <div className="mb-8 flex items-center justify-between">
        <div>
          <p className="section-label">your apps</p>
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        </div>
        <Link
          href="/onboarding"
          className="rounded-md bg-accent px-4 py-2 font-mono text-[13px] font-semibold text-ink-950 transition-opacity hover:opacity-90"
        >
          + Add app
        </Link>
      </div>

      {apps.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-fg-muted">No apps yet.</p>
          <Link href="/onboarding" className="mt-2 inline-block text-accent hover:underline">
            Add your first app →
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {apps.map((app) => {
            const latest = app.runs[0];
            const labels = (JSON.parse(app.policy?.pickupLabels ?? "[]") as string[]).join(", ");
            // CHE-54: a free-plan watch runs on a 7-day trial. The scheduler
            // stops running an expired one, so the card must not keep claiming
            // it's watching.
            const trial = watchTrialState(app.watch, user.plan as UserPlan);
            return (
              <li key={app.id} className="card flex items-start justify-between p-5">
                <div className="space-y-1">
                  <p className="font-mono text-sm text-fg">{app.appSlug}</p>
                  <p className="text-xs text-fg-faint">
                    {!app.watch?.active
                      ? "paused"
                      : trial.kind === "ended"
                        ? "paused"
                        : `watching · ${app.watch.frequency}`}
                    {labels && ` · labels: ${labels}`}
                  </p>
                  {trial.kind === "ended" ? (
                    <p className="text-xs text-status-confusing">
                      trial ended — daily watch paused ·{" "}
                      <Link href="/pricing" className="text-accent hover:underline">
                        Upgrade to resume →
                      </Link>
                    </p>
                  ) : trial.kind === "active" ? (
                    <p className="text-xs text-fg-faint">
                      free trial · {trial.daysLeft} day{trial.daysLeft === 1 ? "" : "s"} left ·{" "}
                      <Link href="/pricing" className="text-accent hover:underline">
                        Upgrade
                      </Link>
                    </p>
                  ) : null}
                  {app.tracker ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-status-ok">✓ Linear · team:</span>
                      {teamsByApp[app.id]?.length ? (
                        <TeamSelect
                          appId={app.id}
                          teams={teamsByApp[app.id]}
                          current={app.tracker.teamId}
                        />
                      ) : (
                        <span className="text-xs text-fg-faint">
                          {app.tracker.externalOrg ?? "—"}
                        </span>
                      )}
                    </div>
                  ) : (
                    <a
                      href={`/api/integrations/linear/start?appId=${app.id}`}
                      className="text-xs text-accent hover:underline"
                    >
                      Connect Linear →
                    </a>
                  )}
                  {/* Outbound webhooks (CHE-53): generic endpoint + Slack preset,
                      POSTed after every completed watch run. */}
                  <details className="pt-1">
                    <summary className="cursor-pointer text-xs text-fg-faint hover:text-fg-muted">
                      {app.webhookUrl || app.slackWebhookUrl ? "✓ Webhooks" : "Webhooks"} — plug
                      into your monitoring
                    </summary>
                    <form
                      action={setIntegrationEndpoints.bind(null, app.id)}
                      className="mt-2 max-w-md space-y-2"
                    >
                      <label className="block space-y-1">
                        <span className="text-xs text-fg-muted">Webhook URL</span>
                        <Input
                          name="webhookUrl"
                          type="url"
                          placeholder="https://your-stack.example.com/hooks/checkmyapp"
                          defaultValue={app.webhookUrl ?? ""}
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-xs text-fg-muted">
                          Signing secret (optional, write-only — blank keeps the current one)
                        </span>
                        <Input
                          name="webhookSecret"
                          type="password"
                          placeholder="••••••••"
                          autoComplete="new-password"
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-xs text-fg-muted">Slack incoming webhook URL</span>
                        <Input
                          name="slackWebhookUrl"
                          type="url"
                          placeholder="https://hooks.slack.com/services/…"
                          defaultValue={app.slackWebhookUrl ?? ""}
                        />
                      </label>
                      <Button type="submit" variant="outline" className="px-3 py-1.5 text-xs">
                        Save webhooks
                      </Button>
                    </form>
                  </details>
                </div>
                {latest ? (
                  <Link
                    href={`/${latest.status === "completed" ? "verdict" : "run"}/${latest.publicId}`}
                    className="font-mono text-[13px] text-accent hover:underline"
                  >
                    latest run →
                  </Link>
                ) : (
                  <span className="font-mono text-[13px] text-fg-faint">no runs yet</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ApiKeys
        apiAccess={apiAccess}
        keys={apiKeys.map((k) => ({
          id: k.id,
          name: k.name,
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          createdAt: k.createdAt.toISOString(),
        }))}
      />
    </main>
  );
}
