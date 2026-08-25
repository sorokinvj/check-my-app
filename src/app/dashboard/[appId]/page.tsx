import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { setIntegrationEndpoints, updateAppSettings } from "../actions";

// Per-app settings (CHE-64). Edit everything onboarding captures — test creds,
// scope, notes, ticket params, cadence, notify email — after the app exists.
// The stored test password is never rendered: the field is write-only and blank
// keeps the current secret (mirrors the webhook signing-secret pattern).
export default async function AppSettingsPage({
  params,
}: {
  params: Promise<{ appId: string }>;
}) {
  const { appId } = await params;
  const { user, db } = await requireUser();

  const app = await db.app.findFirst({
    where: { id: appId, ownerId: user.id },
    include: { watch: true, policy: true, tracker: true, repo: true },
  });
  if (!app) notFound();

  // Tracker token health (CHE-68/72): a pre-refresh-flow connection has no
  // refresh token, so its 24h access token dies and only a reconnect heals it.
  const tracker = app.tracker;
  const trackerHealth = !tracker
    ? null
    : tracker.refreshTokenEnc
      ? { tone: "ok" as const, text: "connected · token auto-renews" }
      : tracker.tokenExpiresAt && tracker.tokenExpiresAt <= new Date()
        ? { tone: "bad" as const, text: "token expired — reconnect to restore ticket filing" }
        : tracker.tokenExpiresAt
          ? {
              tone: "warn" as const,
              text: `token expires ${tracker.tokenExpiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC — reconnect to enable auto-renew`,
            }
          : { tone: "ok" as const, text: "connected" };

  const pickupLabels = (JSON.parse(app.policy?.pickupLabels ?? "[]") as string[]).join(", ");
  const repoLabel = app.policy?.repoLabel ?? "";
  const urgentJourneys = (() => {
    try {
      const rule = JSON.parse(app.policy?.priorityRule ?? "{}") as { urgent?: string[] };
      return (rule.urgent ?? []).join(", ");
    } catch {
      return "";
    }
  })();
  const frequency = app.watch?.frequency ?? "daily";

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <div className="mb-8">
        <Link href="/dashboard" className="text-xs text-fg-faint hover:underline">
          ← Dashboard
        </Link>
        <p className="section-label mt-3">app settings</p>
        <h1 className="text-3xl font-semibold tracking-tight">{app.appSlug}</h1>
        <p className="text-sm text-fg-muted">{app.targetUrl}</p>
      </div>

      <form action={updateAppSettings.bind(null, app.id)} className="space-y-8">
        {/* Test login */}
        <section className="card space-y-3 p-5">
          <p className="text-sm font-medium text-fg">
            Test login <span className="font-normal text-fg-faint">(recommended)</span>
          </p>
          <Input
            name="testEmail"
            type="email"
            placeholder="test@your-app.com"
            defaultValue={app.testEmail ?? ""}
            autoComplete="off"
          />
          <Input
            name="testPassword"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
          />
          <p className="text-xs text-fg-faint">
            Encrypted at rest, never logged, never in evidence. Password is write-only — leave it
            blank to keep the current one. Google-OAuth logins aren&apos;t auto-walkable yet — use an
            email/password test user.
          </p>
        </section>

        {/* Ticket parameters */}
        <section className="card space-y-3 p-5">
          <p className="text-sm font-medium text-fg">Ticket parameters</p>
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">Pickup labels (comma-separated)</span>
            <Input name="pickupLabels" placeholder="monitor" defaultValue={pickupLabels} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">Repo label</span>
            <Input name="repoLabel" placeholder="repo: your-app" defaultValue={repoLabel} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">
              Critical journeys → Urgent (comma-separated)
            </span>
            <Input
              name="urgentJourneys"
              placeholder="login, dashboard, checkout"
              defaultValue={urgentJourneys}
            />
          </label>
          <p className="text-xs text-fg-faint">
            These are the labels that make <em>your</em> automation pick up the ticket. We never
            guess them.
          </p>
        </section>

        {/* Scope & notes */}
        <section className="card space-y-3 p-5">
          <p className="text-sm font-medium text-fg">Scope &amp; notes</p>
          <Input
            name="scopeHints"
            placeholder="Don't touch /admin"
            defaultValue={app.scopeHints ?? ""}
          />
          <Input
            name="userNotes"
            placeholder="Don't delete the test account. OK to create sessions."
            defaultValue={app.userNotes ?? ""}
          />
        </section>

        {/* Cadence & notifications */}
        <section className="card space-y-3 p-5">
          <p className="text-sm font-medium text-fg">Cadence &amp; notifications</p>
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">Frequency</span>
            <select
              name="frequency"
              defaultValue={frequency}
              className="w-full rounded-md border border-ink-700 bg-transparent px-3 py-2 font-mono text-sm text-fg outline-none"
            >
              <option value="daily">Daily</option>
              <option value="every_6h">Every 6 hours</option>
              <option value="manual">Manual only</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-fg-muted">Escalation email</span>
            <Input
              name="notifyEmail"
              type="email"
              placeholder="you@email.com"
              defaultValue={app.watch?.notifyEmail ?? ""}
            />
          </label>
        </section>

        <Button type="submit" className="w-full py-3.5 text-[15px]">
          Save settings
        </Button>
      </form>

      {/* Integrations (CHE-72). Outside the settings <form> — the webhooks row
          carries its own form, and forms must not nest. One row per external
          connection, each with live health and its own connect/repair action. */}
      <section className="card mt-8 space-y-3 p-5">
        <p className="text-sm font-medium text-fg">Integrations</p>

        {/* Linear — issue tracker (CHE-31/50/68) */}
        <div className="flex items-start justify-between gap-4 rounded-lg border border-ink-700 p-4">
          <div className="space-y-1">
            <p className="text-sm text-fg">
              Linear <span className="text-xs text-fg-faint">· issue tracker</span>
            </p>
            {trackerHealth ? (
              <p
                className={`text-xs ${
                  trackerHealth.tone === "ok"
                    ? "text-status-ok"
                    : trackerHealth.tone === "warn"
                      ? "text-status-confusing"
                      : "text-status-broken"
                }`}
              >
                {trackerHealth.tone === "ok" ? "✓" : "⚠"} {trackerHealth.text}
                {tracker?.externalOrg && ` · team: ${tracker.externalOrg}`}
              </p>
            ) : (
              <p className="text-xs text-fg-faint">
                Not connected — regressions found by the Daily Watch stay on the verdict page
                instead of becoming tickets.
              </p>
            )}
          </div>
          <a
            href={`/api/integrations/linear/start?appId=${app.id}`}
            className="shrink-0 rounded-lg border border-ink-600 px-3 py-1.5 font-mono text-xs text-fg-muted transition-colors hover:border-ink-500 hover:text-fg"
          >
            {tracker ? "Reconnect →" : "Connect →"}
          </a>
        </div>

        {/* GitHub — spec export target (RepoIntegration) */}
        <div className="flex items-start justify-between gap-4 rounded-lg border border-ink-700 p-4">
          <div className="space-y-1">
            <p className="text-sm text-fg">
              GitHub <span className="text-xs text-fg-faint">· e2e spec export</span>
            </p>
            {app.repo ? (
              <p className="text-xs text-status-ok">
                ✓ {app.repo.repoFullName} · base branch {app.repo.defaultBranch}
              </p>
            ) : (
              <p className="text-xs text-fg-faint">
                Not connected — use “Export to GitHub” on any verdict page to link a repo with a
                fine-grained PAT.
              </p>
            )}
          </div>
        </div>

        {/* Outbound webhooks + Slack (CHE-53) */}
        <details className="rounded-lg border border-ink-700 p-4" open={false}>
          <summary className="cursor-pointer text-sm text-fg">
            Webhooks{" "}
            <span
              className={`text-xs ${app.webhookUrl || app.slackWebhookUrl ? "text-status-ok" : "text-fg-faint"}`}
            >
              {app.webhookUrl || app.slackWebhookUrl
                ? "· ✓ configured"
                : "· plug run results into your monitoring"}
            </span>
          </summary>
          <form
            action={setIntegrationEndpoints.bind(null, app.id)}
            className="mt-3 max-w-md space-y-2"
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
      </section>
    </main>
  );
}
