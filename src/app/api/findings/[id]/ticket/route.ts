import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { parseJson } from "@/lib/json";
import { buildTicketDraft } from "@/lib/tracker/ticket";
import { LinearTracker } from "@/lib/tracker/linear";
import { decideTicketAction } from "@/lib/tracker/decision";
import type { FindingDetail } from "@/lib/types";

// POST /api/findings/{id}/ticket — file this finding into the owner's tracker
// using the parameters they set at onboarding (TicketPolicy) and their Linear
// OAuth connection (TrackerIntegration). Owner-only; idempotent per finding via
// IssueLink dedup (re-click comments on the open issue instead of refiling).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const user = await getOptionalUser(prisma);
  if (!user) {
    return NextResponse.json({ error: "Sign in to create tickets." }, { status: 401 });
  }

  const finding = await prisma.finding.findUnique({
    where: { id: (await params).id },
    include: { run: true, evidence: true },
  });
  if (!finding) return NextResponse.json({ error: "Finding not found" }, { status: 404 });

  const app = await prisma.app.findUnique({
    where: { ownerId_appSlug: { ownerId: user.id, appSlug: finding.run.appSlug } },
    include: { tracker: true, policy: true },
  });
  if (!app || (finding.run.ownerId && finding.run.ownerId !== user.id)) {
    return NextResponse.json({ error: "Only the app owner can create tickets." }, { status: 403 });
  }
  if (!app.tracker) {
    return NextResponse.json(
      { error: "linear_not_connected", message: "Connect Linear from your dashboard first." },
      { status: 409 },
    );
  }
  if (!app.tracker.teamId) {
    return NextResponse.json(
      { error: "no_team", message: "Pick a Linear team on your dashboard first." },
      { status: 409 },
    );
  }

  const policy = app.policy;
  const detail = parseJson<FindingDetail>(finding.detail) ?? {};
  const urgent = parseJson<{ urgent?: string[] }>(policy?.priorityRule ?? null)?.urgent ?? [];
  const isCritical = urgent.some((j) => finding.title.toLowerCase().includes(j.toLowerCase()));

  const draft = buildTicketDraft(
    {
      journeyTitle: detail.where ?? finding.run.appSlug,
      failingStep: finding.title,
      failureSignature: `${finding.category}/${finding.severity}: ${finding.title}`,
      isCriticalJourney: isCritical,
      baselineDiff: detail.whatHappened ?? "(one-off finding, no baseline diff)",
      repro: (detail.whatWeTried ?? []).join("\n") || "See verdict page evidence.",
      evidenceUrls: finding.evidence.map((e) => e.storageUrl),
    },
    {
      runNumber: finding.run.runNumber,
      runPublicId: finding.run.publicId,
      startedAtIso: finding.run.startedAt.toISOString(),
      appSlug: finding.run.appSlug,
      verdictUrl: `${new URL(_req.url).origin}/verdict/${finding.run.publicId}`,
      pickupLabels: parseJson<string[]>(policy?.pickupLabels ?? null) ?? [],
      repoLabel: policy?.repoLabel ?? null,
      provenanceLabel: policy?.provenanceLabel ?? "checkmyapp",
      state: policy?.state ?? "Backlog",
      titleFormat: policy?.titleFormat ?? "[Monitor] {verdict}",
    },
  );

  const tracker = new LinearTracker(decryptSecret(app.tracker.accessTokenEnc), app.tracker.teamId);
  const dedupKey = `finding:${finding.runId}:${finding.number}`;

  try {
    const existing = await prisma.issueLink.findUnique({
      where: { appId_dedupKey: { appId: app.id, dedupKey } },
    });
    const action = decideTicketAction(
      existing
        ? {
            status: existing.status,
            occurrences: existing.occurrences,
            escalatedAt: existing.escalatedAt,
          }
        : null,
      policy?.escalateAfterRuns ?? 3,
    );

    if (action.kind === "comment" && existing) {
      await tracker.addComment(
        existing.externalIssueId,
        `Re-filed from CheckMyApp — still present in run #${finding.run.runNumber} (${draft.title}).`,
      );
      await prisma.issueLink.update({
        where: { id: existing.id },
        data: { occurrences: { increment: 1 }, lastSeenAt: new Date() },
      });
      return NextResponse.json({ identifier: existing.externalIssueId, commented: true });
    }

    const issue = await tracker.createIssue(draft);
    await prisma.issueLink.upsert({
      where: { appId_dedupKey: { appId: app.id, dedupKey } },
      create: {
        appId: app.id,
        dedupKey,
        externalIssueId: issue.identifier,
        firstSeenRunId: finding.runId,
      },
      update: { externalIssueId: issue.identifier, status: "open", lastSeenAt: new Date() },
    });
    return NextResponse.json({ identifier: issue.identifier, url: issue.url }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Tracker call failed" },
      { status: 502 },
    );
  }
}
