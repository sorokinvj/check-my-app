import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";

// GET /api/runs/{publicId}/verdict — structured verdict for automation (the
// MCP server, CI hooks). Same visibility as the verdict page: knowledge of the
// unguessable publicId is the capability.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const prisma = await getDbFromContext();
  const run = await prisma.run.findUnique({
    where: { publicId: (await params).id },
    include: {
      journeys: { orderBy: { order: "asc" }, select: { title: true, status: true, summary: true } },
      findings: {
        orderBy: { number: "asc" },
        select: { number: true, title: true, category: true, severity: true, mark: true },
      },
      llmUsage: true,
    },
  });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const totalTokens = run.llmUsage.reduce(
    (s, u) => s + u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens + u.outputTokens,
    0,
  );

  return NextResponse.json({
    run_number: run.runNumber,
    app: run.appSlug,
    status: run.status,
    verdict: run.verdict,
    bottom_line: run.bottomLine,
    journeys: run.journeys,
    findings: run.findings,
    cost_usd: run.costUsd,
    total_tokens: totalTokens || null,
    completed_at: run.completedAt,
  });
}
