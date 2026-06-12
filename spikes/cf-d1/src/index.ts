// CHE-21 spike — Prisma + @prisma/adapter-d1 against a real D1, proving:
//  - enums-as-String + Json-as-String round-trip
//  - the nested create chain (Run → journeys → steps → evidence) works
//  - what D1's lack of transactions actually does to a nested create
import { PrismaClient } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";

interface Env {
  DB: D1Database;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const adapter = new PrismaD1(env.DB);
    const prisma = new PrismaClient({ adapter });
    const out: Record<string, unknown> = {};

    try {
      // Assign runNumber app-side (SQLite autoincrement is PK-only — see schema).
      const last = await prisma.run.findFirst({ orderBy: { runNumber: "desc" } });
      const runNumber = (last?.runNumber ?? 0) + 1;

      // Nested create: Run → 2 journeys → steps → evidence, plus a finding.
      // On Postgres this is one transaction; on D1 it runs as individual
      // statements (no atomicity) — we observe whether it completes.
      const run = await prisma.run.create({
        data: {
          runNumber,
          targetUrl: "https://example.com",
          appSlug: "example.com",
          status: "completed",
          verdict: "broken",
          appLens: JSON.stringify({ oneLiner: "a spike app", criticalPaths: ["a", "b"] }),
          anatomy: JSON.stringify({ pages: ["/"], services: [{ name: "CF", role: "edge" }] }),
          events: JSON.stringify([{ at: "t", phase: "writing", icon: "ok", text: "done" }]),
          costUsd: 0.73,
          journeys: {
            create: [
              {
                order: 0,
                title: "Submit a check",
                status: "ok",
                steps: {
                  create: [
                    { order: 0, label: "open /check", status: "ok", observed: "loaded" },
                    {
                      order: 1,
                      label: "type url",
                      status: "confusing",
                      observed: "no inline hint",
                      evidence: {
                        create: [{ type: "screenshot", storageUrl: "/api/evidence/a.png", sha256: "abc" }],
                      },
                    },
                  ],
                },
              },
              { order: 1, title: "Watch", status: "broken" },
            ],
          },
          findings: {
            create: [
              {
                number: 1,
                title: "watch unreachable",
                category: "broken",
                severity: "high",
                detail: JSON.stringify({ where: "/watch", whyItMatters: "no entry" }),
                evidence: { create: [{ type: "screenshot", storageUrl: "/api/evidence/b.png" }] },
              },
            ],
          },
        },
        include: { journeys: { include: { steps: { include: { evidence: true } } } }, findings: true },
      });

      // Read it back with a deep join — proves relations + cascade graph.
      const readBack = await prisma.run.findUnique({
        where: { id: run.id },
        include: {
          journeys: {
            orderBy: { order: "asc" },
            include: { steps: { orderBy: { order: "asc" }, include: { evidence: true } } },
          },
          findings: { include: { evidence: true } },
        },
      });

      // Round-trip the JSON-as-TEXT columns.
      const lens = JSON.parse(readBack!.appLens!);

      out.runNumber = run.runNumber;
      out.journeys = readBack!.journeys.length;
      out.steps = readBack!.journeys.flatMap((j) => j.steps).length;
      out.stepEvidence = readBack!.journeys.flatMap((j) => j.steps).flatMap((s) => s.evidence).length;
      out.findings = readBack!.findings.length;
      out.findingEvidence = readBack!.findings.flatMap((f) => f.evidence).length;
      out.jsonRoundTrip = { oneLiner: lens.oneLiner, criticalPaths: lens.criticalPaths };
      out.enumAsString = { status: readBack!.status, verdict: readBack!.verdict };

      // No-transaction probe: a $transaction with a deliberate failure. On D1,
      // Prisma can't roll back — observe whether the first write persists.
      let txBehavior: string;
      const before = await prisma.finding.count();
      try {
        await prisma.$transaction([
          prisma.finding.create({
            data: { runId: run.id, number: 2, title: "tx probe", category: "polish", severity: "low" },
          }),
          // duplicate runNumber violates @unique → second op fails
          prisma.run.create({ data: { runNumber, targetUrl: "x", appSlug: "x" } }),
        ]);
        txBehavior = "transaction succeeded (unexpected)";
      } catch {
        const after = await prisma.finding.count();
        txBehavior =
          after > before
            ? `NO ROLLBACK: first write persisted (count ${before}→${after}) — D1 has no transactions`
            : `rolled back (count stayed ${before}) — transactions honored`;
      }
      out.transactionProbe = txBehavior;

      out.verdict = "D1 + PRISMA SCHEMA OK";
      return Response.json(out);
    } catch (err) {
      out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return Response.json(out, { status: 500 });
    }
  },
};
