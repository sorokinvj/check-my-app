// Phase 4 — Walking journeys (CF agent). One agent-loop per journey: the model
// acts through browser tools, reports outcomes via report_step (Step + R2
// screenshot evidence), and formalizes the journey via write_e2e_test
// (GeneratedTest in D1 + spec copy in R2 — no Workers filesystem).

import type { Browser } from "@cloudflare/playwright";
import { decryptSecret } from "@/lib/crypto";
import type { StepStatus } from "@/lib/enums";
import { runAgentLoop, type TranscriptEntry } from "./core";
import { prepareAgentPage, type ToolEnv } from "./tools";
import { walkingSystem } from "./instructions";
import { putScreenshot, putText, type AgentEnv } from "./env";
import { originOf, type ProposedJourney, type RunInput } from "./discovery";
import type { LlmConfig } from "./llm";

export interface WalkRun extends RunInput {
  id: string;
  appSlug: string;
}

const SEVERITY_ORDER: StepStatus[] = ["ok", "skipped", "confusing", "risky", "exposed", "broken"];

function worstStatus(statuses: StepStatus[]): StepStatus {
  return statuses.reduce<StepStatus>(
    (worst, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst),
    "ok",
  );
}

async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function walkJourneys(args: {
  env: AgentEnv;
  llm: LlmConfig;
  browser: Browser;
  run: WalkRun;
  journeys: ProposedJourney[];
  onLiveScreenshot?: (url: string) => Promise<void>;
  onProgress?: (note: string) => Promise<void>;
}): Promise<{ transcript: TranscriptEntry[]; costUsd: number }> {
  const { env, llm, browser, run, journeys, onLiveScreenshot, onProgress } = args;
  const transcripts: TranscriptEntry[] = [];
  let costUsd = 0;

  for (const [index, proposed] of journeys.entries()) {
    const context = await browser.newContext();
    const page = await context.newPage();

    const journey = await env.db.journey.create({
      data: { runId: run.id, order: index, title: proposed.title, status: "ok" },
    });

    const stepStatuses: StepStatus[] = [];
    let stepOrder = 0;
    let lastScreenshot: { storageUrl: string; sha256: string } | null = null;

    const toolEnv: ToolEnv = {
      page,
      targetOrigin: originOf(run.targetUrl),
      testEmail: run.testEmail ?? undefined,
      testPassword: run.testPasswordEnc ? decryptSecret(run.testPasswordEnc) : undefined,
      networkLog: [],
      consoleLog: [],
      onScreenshot: async (buffer) => {
        const stored = await putScreenshot(env, buffer);
        lastScreenshot = stored;
        await onLiveScreenshot?.(stored.storageUrl);
        return stored.storageUrl;
      },
      onReportStep: async (step) => {
        stepStatuses.push(step.status as StepStatus);
        await env.db.step.create({
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
        lastScreenshot = null;
      },
      onWriteTest: async (test) => {
        await persistGeneratedTest(env, {
          appSlug: run.appSlug,
          journeyId: journey.id,
          title: test.title,
          content: test.content,
        });
      },
    };
    await prepareAgentPage(toolEnv);

    try {
      const result = await runAgentLoop({
        system: walkingSystem(run, proposed.title, proposed.steps),
        task: `Target app: ${run.targetUrl}\nWalk the journey now. Navigate to the target first.`,
        env: toolEnv,
        llm,
        maxIterations: 50,
        onProgress,
      });
      transcripts.push(...result.transcript);
      costUsd += result.costUsd;

      await env.db.journey.update({
        where: { id: journey.id },
        data: {
          status: stepStatuses.length === 0 ? "skipped" : worstStatus(stepStatuses),
          summary: result.finalText.slice(0, 500) || null,
        },
      });
    } catch (err) {
      // Per-journey isolation: one failure must not abort the rest of the run.
      console.error(`[walk] journey "${proposed.title}" failed:`, err);
      await env.db.journey.update({
        where: { id: journey.id },
        data: {
          status: stepStatuses.length === 0 ? "skipped" : worstStatus(stepStatuses),
          summary: `Walk aborted: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
        },
      });
    } finally {
      await context.close();
    }
  }

  return { transcript: transcripts, costUsd };
}

// Generated specs: versioned in D1 (served by /api/tests/{id}) + a copy in R2
// for direct download. No Workers filesystem, so nothing is written to disk.
async function persistGeneratedTest(
  env: AgentEnv,
  args: { appSlug: string; journeyId: string; title: string; content: string },
): Promise<void> {
  const sha256 = await sha256hex(args.content);
  const existing = await env.db.generatedTest.findFirst({
    where: { appSlug: args.appSlug, title: args.title },
    orderBy: { version: "desc" },
  });
  const version = (existing?.version ?? 0) + 1;

  await env.db.generatedTest.create({
    data: {
      appSlug: args.appSlug,
      journeyId: args.journeyId,
      title: args.title,
      content: args.content,
      sha256,
      version,
    },
  });

  const fileSlug = args.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  await putText(env, `specs/${args.appSlug}/${fileSlug}.v${version}.spec.ts`, args.content);
}
