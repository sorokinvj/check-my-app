import Link from "next/link";
import { requireUser } from "@/lib/auth";

// How often we were right (CHE-99).
//
// Rule §8: "whose defect is this" is a question we make impossible rather than
// one we answer — and the only way to know whether that is working is to count.
// Everything here comes from state the loop already writes: IssueLink.status is
// the customer's own verdict on our ticket (suppressed = they ruled it not-a-bug,
// resolved = we found it, they fixed it, we confirmed from outside), and
// Finding.mark is the owner's hand triage.
//
// Deliberately blunt: the number this page exists for is how often we were WRONG,
// stated first and without softening. A checker that hides its own error rate is
// asking to be trusted on faith, which is exactly what we sell against.

export const dynamic = "force-dynamic";

const CLASS_COPY: Record<string, { label: string; why: string }> = {
  capability: {
    label: "capability",
    why: "we could not perform the action and reported the product",
  },
  configuration: {
    label: "configuration",
    why: "our own inputs were wrong — a stale credential, a bad URL",
  },
  interpretation: {
    label: "interpretation",
    why: "we read the absence of evidence as evidence of a defect",
  },
  bookkeeping: {
    label: "bookkeeping",
    why: "we lost track of what we had filed or been told",
  },
};

export default async function AccuracyPage() {
  const { user, db } = await requireUser();

  const apps = await db.app.findMany({
    where: { ownerId: user.id },
    select: { id: true, appSlug: true },
    orderBy: { appSlug: "asc" },
  });
  const appById = new Map(apps.map((a) => [a.id, a.appSlug]));

  const links = apps.length
    ? await db.issueLink.findMany({
        where: { appId: { in: apps.map((a) => a.id) } },
        select: {
          appId: true,
          externalIssueId: true,
          status: true,
          defectClass: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      })
    : [];

  const filed = links.length;
  const rejected = links.filter((l) => l.status === "suppressed");
  const closed = links.filter((l) => l.status === "resolved");
  const inFlight = filed - rejected.length - closed.length;

  // Findings are counted on runs this owner owns, so the denominator is work we
  // actually did for them — not every run that ever touched the same URL.
  const [findings, falsePositives] = await Promise.all([
    db.finding.count({ where: { run: { ownerId: user.id } } }),
    db.finding.count({ where: { run: { ownerId: user.id }, mark: "false_positive" } }),
  ]);

  const byClass = new Map<string, number>();
  for (const l of rejected) {
    const key = l.defectClass ?? "unclassified";
    byClass.set(key, (byClass.get(key) ?? 0) + 1);
  }

  const perApp = apps
    .map((app) => {
      const mine = links.filter((l) => l.appId === app.id);
      return {
        slug: app.appSlug,
        filed: mine.length,
        rejected: mine.filter((l) => l.status === "suppressed").length,
        closed: mine.filter((l) => l.status === "resolved").length,
      };
    })
    .filter((a) => a.filed > 0)
    .sort((a, b) => b.filed - a.filed);

  const pct = (n: number, of: number) => (of === 0 ? "—" : `${Math.round((n / of) * 100)}%`);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <div className="mb-8">
        <p className="section-label">how often we were right</p>
        <h1 className="text-3xl font-semibold tracking-tight">Accuracy</h1>
        <p className="mt-2 max-w-xl text-sm text-fg-muted">
          Every ticket we file gets a verdict from the person who owns the code. Ruled not-a-bug
          means we were wrong, and that opens a ticket on our own board until the cause is gone.
        </p>
      </div>

      {filed === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-fg-muted">No tickets filed yet — nothing to score.</p>
          <Link href="/dashboard" className="mt-2 inline-block text-accent hover:underline">
            Back to dashboard →
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="card p-6">
            <p className="section-label">tickets we filed</p>
            <p className="mt-2 font-mono text-4xl">
              {rejected.length}
              <span className="text-fg-faint"> / {filed}</span>
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              ruled not-a-bug — {pct(rejected.length, filed)} of everything we filed was our own
              defect, not theirs.
            </p>
            <div className="mt-5 grid grid-cols-3 gap-4 border-t border-ink-700 pt-4">
              <div>
                <p className="font-mono text-xl text-status-ok">{closed.length}</p>
                <p className="text-xs text-fg-faint">
                  loops closed — found, fixed, confirmed from outside
                </p>
              </div>
              <div>
                <p className="font-mono text-xl text-status-broken">{rejected.length}</p>
                <p className="text-xs text-fg-faint">rejected — ours, not theirs</p>
              </div>
              <div>
                <p className="font-mono text-xl text-fg-muted">{inFlight}</p>
                <p className="text-xs text-fg-faint">still open — no verdict yet</p>
              </div>
            </div>
          </div>

          <div className="card p-6">
            <p className="section-label">why we were wrong</p>
            {rejected.length === 0 ? (
              <p className="mt-3 text-sm text-fg-muted">
                Nothing rejected yet. This stays empty only as long as that holds.
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {[...byClass.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([key, count]) => {
                    const copy = CLASS_COPY[key];
                    return (
                      <li key={key} className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-mono text-sm">{copy?.label ?? "unclassified"}</p>
                          <p className="text-xs text-fg-faint">
                            {copy?.why ??
                              "cause not recorded — the ones we learn least from; a person should name it"}
                          </p>
                        </div>
                        <p className="font-mono text-sm text-fg-muted">{count}</p>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>

          <div className="card p-6">
            <p className="section-label">findings</p>
            <p className="mt-2 font-mono text-2xl">
              {falsePositives}
              <span className="text-fg-faint"> / {findings}</span>
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              marked a false positive by hand — {pct(falsePositives, findings)} of everything we
              have ever reported to you.
            </p>
          </div>

          <div className="card p-6">
            <p className="section-label">by app</p>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-ink-700 text-left text-xs text-fg-faint">
                  <th className="pb-2 font-normal">app</th>
                  <th className="pb-2 text-right font-normal">filed</th>
                  <th className="pb-2 text-right font-normal">closed</th>
                  <th className="pb-2 text-right font-normal">rejected</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {perApp.map((a) => (
                  <tr key={a.slug} className="border-b border-ink-700/50 last:border-0">
                    <td className="py-2">{a.slug}</td>
                    <td className="py-2 text-right text-fg-muted">{a.filed}</td>
                    <td className="py-2 text-right text-status-ok">{a.closed}</td>
                    <td className="py-2 text-right text-status-broken">{a.rejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card p-6">
            <p className="section-label">latest verdicts on our tickets</p>
            <ul className="mt-3 space-y-2">
              {links.slice(0, 8).map((l) => (
                <li key={l.externalIssueId} className="flex items-center justify-between gap-4">
                  <span className="font-mono text-sm">{l.externalIssueId}</span>
                  <span className="text-xs text-fg-faint">{appById.get(l.appId)}</span>
                  <span
                    className={
                      l.status === "suppressed"
                        ? "font-mono text-xs text-status-broken"
                        : l.status === "resolved"
                          ? "font-mono text-xs text-status-ok"
                          : "font-mono text-xs text-fg-muted"
                    }
                  >
                    {l.status === "suppressed"
                      ? "not a bug — ours"
                      : l.status === "resolved"
                        ? "fixed, confirmed"
                        : l.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <Link href="/dashboard" className="mt-8 inline-block text-sm text-fg-muted hover:text-fg">
        ← Dashboard
      </Link>
    </main>
  );
}
