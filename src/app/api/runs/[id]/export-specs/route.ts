import { NextResponse, type NextRequest } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";
import { decryptSecret } from "@/lib/crypto";
import { GitHubError, openSpecsPr, specFileSlug } from "@/lib/github";

// POST /api/runs/{id}/export-specs — put this run's generated Playwright specs
// into the owner's repo as a PR (never a direct push to the default branch).
// Branch: checkmyapp/specs-run-{runNumber}; files: e2e/checkmyapp/{slug}.spec.ts
// — Playwright's own scaffold uses tests/ (or e2e/ when tests/ is taken), and
// e2e/ is the collision-free choice for a repo that already has unit tests; the
// checkmyapp/ subfolder keeps generated specs apart from hand-written ones.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const db = await getDbFromContext();
  const user = await getOptionalUser(db);
  if (!user) {
    return NextResponse.json({ error: "Sign in to export specs" }, { status: 401 });
  }

  const run = await db.run.findUnique({
    where: { publicId: (await params).id },
    select: { id: true, publicId: true, runNumber: true, appSlug: true, ownerId: true },
  });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.ownerId && run.ownerId !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const app = await db.app.findUnique({
    where: { ownerId_appSlug: { ownerId: user.id, appSlug: run.appSlug } },
    include: { repo: true },
  });
  if (!app?.repo) {
    // Distinguished error: the verdict UI opens the connect form on this.
    return NextResponse.json(
      { error: "GitHub isn't connected for this app", code: "github_not_connected" },
      { status: 409 },
    );
  }

  // Latest version of each spec for this app — same set the verdict lists.
  const tests = await db.generatedTest.findMany({
    where: { appSlug: run.appSlug },
    orderBy: [{ title: "asc" }, { version: "desc" }],
    distinct: ["title"],
  });
  if (tests.length === 0) {
    return NextResponse.json({ error: "No generated specs for this run" }, { status: 404 });
  }

  const files = tests.map((t) => ({
    path: `e2e/checkmyapp/${specFileSlug(t.title)}.spec.ts`,
    content: t.content.endsWith("\n") ? t.content : `${t.content}\n`,
  }));
  const verdictUrl = `${req.nextUrl.origin}/verdict/${run.publicId}`;
  const body = [
    `CheckMyApp walked ${run.appSlug} and formalized each user journey as an executable Playwright spec (run #${run.runNumber}).`,
    "",
    `Verdict: ${verdictUrl}`,
    "",
    "| Spec | Version | sha256 |",
    "| --- | --- | --- |",
    ...tests.map(
      (t) =>
        `| \`e2e/checkmyapp/${specFileSlug(t.title)}.spec.ts\` | v${t.version} | \`${t.sha256.slice(0, 12)}…\` |`,
    ),
    "",
    "Review and merge to run them in your own CI. Re-exports of newer runs update this branch in place.",
  ].join("\n");

  try {
    const { prUrl } = await openSpecsPr({
      token: decryptSecret(app.repo.tokenEnc),
      repoFullName: app.repo.repoFullName,
      baseBranch: app.repo.defaultBranch,
      branch: `checkmyapp/specs-run-${run.runNumber}`,
      files,
      title: `[CheckMyApp] e2e specs from run #${run.runNumber} (${run.appSlug})`,
      body,
    });
    return NextResponse.json({ prUrl });
  } catch (e) {
    // Surface GitHub failures verbatim (expired PAT, branch protection, …) —
    // swallowing them here would leave the owner staring at a dead button.
    if (e instanceof GitHubError) {
      return NextResponse.json(
        { error: `GitHub: ${e.message} (${e.status})` },
        { status: 502 },
      );
    }
    throw e;
  }
}
