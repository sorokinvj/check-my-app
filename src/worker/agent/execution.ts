// Phase 4 — Walking journeys (CHE-4 on the CHE-7 core).
//
// One agent-loop per journey. The model acts through browser tools and reports
// outcomes via report_step (we persist Step + screenshot evidence per report)
// and formalizes the journey via write_e2e_test (CHE-8: GeneratedTest + file).

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright";
import { prisma } from "@/lib/db";
import type { Run, StepStatus } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";
import { fsSafeSlug } from "@/lib/utils";
import { hasApiKey } from "./llm";
import { runAgentLoop, type TranscriptEntry } from "./core";
import { prepareAgentPage, type ToolEnv } from "./tools";
import { walkingSystem } from "./instructions";
import { storeScreenshot } from "./evidence";
import type { ProposedJourney } from "./discovery";

const SEVERITY_ORDER: StepStatus[] = [
  "ok",
  "skipped",
  "confusing",
  "risky",
  "exposed",
  "broken",
];

function worstStatus(statuses: StepStatus[]): StepStatus {
  return statuses.reduce<StepStatus>(
    (worst, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst),
    "ok",
  );
}

export async function walkJourneys(args: {
  run: Run;
  browser: Browser;
  journeys: ProposedJourney[];
  onLiveScreenshot?: (url: string) => Promise<void>;
  onProgress?: (note: string) => Promise<void>;
}): Promise<TranscriptEntry[]> {
  const { run, browser, journeys, onLiveScreenshot, onProgress } = args;
  if (!hasApiKey()) return [];

  const transcripts: TranscriptEntry[] = [];

  for (const [index, proposed] of journeys.entries()) {
    const context = await browser.newContext();
    const page = await context.newPage();

    const journey = await prisma.journey.create({
      data: { runId: run.id, order: index, title: proposed.title, status: "ok" },
    });

    const stepStatuses: StepStatus[] = [];
    let stepOrder = 0;
    let lastScreenshot: { storageUrl: string; sha256: string } | null = null;

    const env: ToolEnv = {
      page,
      testEmail: run.testEmail ?? undefined,
      testPassword: run.testPasswordEnc ? decryptSecret(run.testPasswordEnc) : undefined,
      networkLog: [],
      consoleLog: [],
      onScreenshot: async (buffer) => {
        const stored = await storeScreenshot(buffer);
        lastScreenshot = stored;
        await onLiveScreenshot?.(stored.storageUrl);
        return stored.storageUrl;
      },
      onReportStep: async (step) => {
        stepStatuses.push(step.status);
        await prisma.step.create({
          data: {
            journeyId: journey.id,
            order: stepOrder++,
            label: step.label,
            status: step.status,
            attempted: step.attempted,
            observed: step.observed,
            consoleLog: step.consoleExcerpt ?? null,
            networkLog: step.networkExcerpt ?? null,
            screenshotUrl: lastScreenshot?.storageUrl ?? null,
            evidence: lastScreenshot
              ? { create: [{ type: "screenshot", ...lastScreenshot }] }
              : undefined,
          },
        });
        lastScreenshot = null; // each screenshot backs at most one step
      },
      onWriteTest: async (test) => {
        await persistGeneratedTest({
          appSlug: run.appSlug,
          journeyId: journey.id,
          title: test.title,
          content: test.content,
        });
      },
    };
    await prepareAgentPage(env);

    try {
      const result = await runAgentLoop({
        system: walkingSystem(run, proposed.title, proposed.steps),
        task: `Target app: ${run.targetUrl}\nWalk the journey now. Navigate to the target first.`,
        env,
        maxIterations: 50,
        onProgress,
      });
      transcripts.push(...result.transcript);

      await prisma.journey.update({
        where: { id: journey.id },
        data: {
          status: worstStatus(stepStatuses),
          summary: result.finalText.slice(0, 500) || null,
        },
      });
    } finally {
      await context.close();
    }
  }

  return transcripts;
}

// CHE-8: generated specs live both in the DB (versioned, sha256) and on disk so
// `npx playwright test generated-tests/{appSlug}` just works.
async function persistGeneratedTest(args: {
  appSlug: string;
  journeyId: string;
  title: string;
  content: string;
}): Promise<void> {
  const sha256 = crypto.createHash("sha256").update(args.content).digest("hex");
  const existing = await prisma.generatedTest.findFirst({
    where: { appSlug: args.appSlug, title: args.title },
    orderBy: { version: "desc" },
  });

  await prisma.generatedTest.create({
    data: {
      appSlug: args.appSlug,
      journeyId: args.journeyId,
      title: args.title,
      content: args.content,
      sha256,
      version: (existing?.version ?? 0) + 1,
    },
  });

  const fileSlug = args.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dir = path.join(process.cwd(), "generated-tests", fsSafeSlug(args.appSlug));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${fileSlug}.spec.ts`), args.content, "utf8");
}
