import Link from "next/link";
import { requireUser } from "@/lib/auth";

// Owner home (protected). Lists the apps this owner has under daily QA.
export default async function DashboardPage() {
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

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
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
            return (
              <li key={app.id} className="card flex items-center justify-between p-5">
                <div className="space-y-1">
                  <p className="font-mono text-sm text-fg">{app.appSlug}</p>
                  <p className="text-xs text-fg-faint">
                    {app.watch?.active ? `watching · ${app.watch.frequency}` : "paused"}
                    {labels && ` · labels: ${labels}`}
                  </p>
                  {app.tracker ? (
                    <p className="text-xs text-status-ok">
                      ✓ Linear connected{app.tracker.externalOrg ? ` · ${app.tracker.externalOrg}` : ""}
                    </p>
                  ) : (
                    <a
                      href={`/api/integrations/linear/start?appId=${app.id}`}
                      className="text-xs text-accent hover:underline"
                    >
                      Connect Linear →
                    </a>
                  )}
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
    </main>
  );
}
