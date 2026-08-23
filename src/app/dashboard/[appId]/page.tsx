import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { updateAppSettings } from "../actions";

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
    include: { watch: true, policy: true },
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
    </main>
  );
}
