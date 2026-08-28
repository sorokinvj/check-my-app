import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { setIntegrationEndpoints, updateAppSettings } from "../actions";

// Per-app settings (CHE-64, redesigned CHE-81). Three meaning-first sections —
// the page will keep growing, so hierarchy comes from sections, not from a pile
// of identical cards:
//   1. What we check   — the agent's brief: priority concerns (the owner's
//                        voice, most prominent), test login, scope & notes.
//   2. Schedule & alerts — when it runs, who hears about it.
//   3. Where results go  — integrations: tracker (with its ticket contract),
//                        code host, webhooks.
// One form ("app-settings") spans sections 1–2 and the ticket-contract fields
// nested inside the Linear card (via the HTML form= attribute — forms can't
// nest); integrations keep their own actions.
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

  // Tracker token health (CHE-68/72): a pre-refresh-flow connection has no
  // refresh token, so its 24h access token dies and only a reconnect heals it.
  const tracker = app.tracker;
  const trackerHealth = !tracker
    ? null
    : tracker.refreshTokenEnc
      ? { tone: "ok" as const, text: "connected · token auto-renews" }
      : tracker.tokenExpiresAt && tracker.tokenExpiresAt <= new Date()
        ? { tone: "bad" as const, text: "token expired — reconnect to restore ticket filing" }
        : { tone: "warn" as const, text: "reconnect to enable token auto-renew" };

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <div className="mb-10">
        <Link href="/dashboard" className="text-xs text-fg-faint hover:underline">
          ← Dashboard
        </Link>
        <p className="section-label mt-3">app settings</p>
        <h1 className="text-3xl font-semibold tracking-tight">{app.appSlug}</h1>
        <p className="text-sm text-fg-muted">{app.targetUrl}</p>
      </div>

      <form id="app-settings" action={updateAppSettings.bind(null, app.id)} className="space-y-12">
        {/* ── 1 · What we check ────────────────────────────────────────── */}
        <section className="space-y-4">
          <div>
            <p className="section-label">1 · What we check</p>
            <p className="mt-1 text-sm text-fg-muted">
              The agent&apos;s brief: what you care about, how it signs in, where it may not go.
            </p>
          </div>

          {/* The owner's voice — visually the loudest thing on the page. */}
          <div className="rounded-xl border border-accent/40 bg-accent/5 p-5">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-fg">What worries you most?</span>
              <span className="block text-xs text-fg-muted">
                In your own words. The agent verifies each concern on every run and reports the
                outcome — working or not — in the verdict&apos;s bottom line.
              </span>
              <Textarea
                name="focusAreas"
                rows={3}
                placeholder={
                  "e.g. All YouTube links and embeds must actually play.\nCheckout must never break."
                }
                defaultValue={app.focusAreas ?? ""}
              />
            </label>
          </div>

          <div className="card space-y-3 p-5">
            <div>
              <p className="text-sm font-medium text-fg">Test login</p>
              <p className="text-xs text-fg-faint">
                Unlocks the signed-in half of your app. Encrypted at rest, never logged, never in
                evidence. Password is write-only — blank keeps the current one. Google-OAuth logins
                aren&apos;t auto-walkable yet; use an email/password test user.
              </p>
            </div>
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
          </div>

          <div className="card space-y-3 p-5">
            <div>
              <p className="text-sm font-medium text-fg">May we create test records?</p>
              <p className="text-xs text-fg-faint">
                We check the full lifecycle — create, see it appear, edit, delete — signed in as
                the test account above and inside its own space only. Everything we create is
                named &ldquo;CheckMyApp test&rdquo; and removed again. Never invites, publishing,
                messages or payments. Requires the test login; without it we stay read-only.
              </p>
            </div>
            <label className="flex items-start gap-2.5 text-sm text-fg">
              <input
                type="checkbox"
                name="writeMode"
                value="create_cleanup"
                defaultChecked={app.writeMode === "create_cleanup"}
                className="mt-0.5 h-4 w-4 rounded border-ink-600 bg-ink-900"
              />
              <span>Yes — create and clean up test records as my test account</span>
            </label>
          </div>

          <div className="card space-y-3 p-5">
            <div>
              <p className="text-sm font-medium text-fg">Scope &amp; notes</p>
              <p className="text-xs text-fg-faint">
                Hard limits and context. The agent follows these to the letter.
              </p>
            </div>
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
          </div>
        </section>

        {/* ── 2 · Schedule & alerts ───────────────────────────────────── */}
        <section className="space-y-4">
          <div>
            <p className="section-label">2 · Schedule &amp; alerts</p>
            <p className="mt-1 text-sm text-fg-muted">When we check, and who hears about it.</p>
          </div>
          <div className="card grid gap-4 p-5 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">Frequency</span>
              <select
                name="frequency"
                defaultValue={frequency}
                className="w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2.5 font-mono text-sm text-fg outline-none"
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
          </div>
        </section>
      </form>

      {/* ── 3 · Where results go ──────────────────────────────────────── */}
      <section className="mt-12 space-y-4">
        <div>
          <p className="section-label">3 · Where results go</p>
          <p className="mt-1 text-sm text-fg-muted">
            Verdicts stay on your dashboard either way; these push regressions into your own
            tools.
          </p>
        </div>

        {/* Linear + its ticket contract (they are one concern). */}
        <div className="card space-y-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-fg">
                Linear <span className="font-normal text-xs text-fg-faint">· issue tracker</span>
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
                  Not connected — regressions stay on the verdict page instead of becoming
                  tickets.
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

          {/* Ticket contract fields — part of the main settings form via the
              form= attribute (forms can't nest inside the webhook form below). */}
          <div className="space-y-3 border-t border-ink-700 pt-4">
            <p className="text-xs text-fg-faint">
              The ticket contract: these labels are what makes <em>your</em> automation pick up a
              filed ticket. We never guess them.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs text-fg-muted">Pickup labels (comma-separated)</span>
                <Input
                  name="pickupLabels"
                  form="app-settings"
                  placeholder="monitor"
                  defaultValue={pickupLabels}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-fg-muted">Repo label</span>
                <Input
                  name="repoLabel"
                  form="app-settings"
                  placeholder="repo: your-app"
                  defaultValue={repoLabel}
                />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">
                Critical journeys → ticket priority Urgent (comma-separated)
              </span>
              <Input
                name="urgentJourneys"
                form="app-settings"
                placeholder="login, dashboard, checkout"
                defaultValue={urgentJourneys}
              />
            </label>
          </div>
        </div>

        {/* GitHub — spec export target */}
        <div className="card flex items-start justify-between gap-4 p-5">
          <div className="space-y-1">
            <p className="text-sm font-medium text-fg">
              GitHub <span className="font-normal text-xs text-fg-faint">· e2e spec export</span>
            </p>
            {app.repo ? (
              <p className="text-xs text-status-ok">
                ✓ {app.repo.repoFullName} · base branch {app.repo.defaultBranch}
              </p>
            ) : (
              <p className="text-xs text-fg-faint">
                Not connected — use &ldquo;Export to GitHub&rdquo; on any verdict page to link a
                repo with a fine-grained PAT.
              </p>
            )}
          </div>
        </div>

        {/* Outbound webhooks + Slack (CHE-53) — separate form on purpose. */}
        <details className="card p-5">
          <summary className="cursor-pointer text-sm font-medium text-fg">
            Webhooks{" "}
            <span
              className={`text-xs font-normal ${app.webhookUrl || app.slackWebhookUrl ? "text-status-ok" : "text-fg-faint"}`}
            >
              {app.webhookUrl || app.slackWebhookUrl
                ? "· ✓ configured"
                : "· plug run results into your monitoring"}
            </span>
          </summary>
          <form
            action={setIntegrationEndpoints.bind(null, app.id)}
            className="mt-4 max-w-md space-y-2"
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

      {/* One Save for sections 1–2 + the ticket contract (form= association). */}
      <div className="sticky bottom-0 mt-10 border-t border-ink-700 bg-ink-950/90 py-4 backdrop-blur">
        <Button type="submit" form="app-settings" className="w-full py-3.5 text-[15px]">
          Save settings
        </Button>
        <p className="mt-2 text-center text-xs text-fg-faint">
          Saves sections 1–2 and the ticket contract. Integrations apply instantly on their own.
        </p>
      </div>
    </main>
  );
}
