// Phase 4 — Walking journeys (CF agent). One agent-loop per journey: the model
// acts through browser tools, reports outcomes via report_step (Step + R2
// screenshot evidence), and formalizes the journey via write_e2e_test
// (GeneratedTest in D1 + spec copy in R2 — no Workers filesystem).

import type { Browser } from "@cloudflare/playwright";
import { decryptSecret } from "@/lib/crypto";
import type { StepStatus } from "@/lib/enums";
import { LlmBudgetError, runAgentLoop, finalizeJson, type TranscriptEntry } from "./core";
import { prepareAgentPage, type RecordedAction, type ToolEnv } from "./tools";
import { agentContextOptions } from "./browser";
import { walkingSystem } from "./instructions";
import { putScreenshot, putText, walkImageWindow, type AgentEnv } from "./env";
import { originOf, type ProposedJourney, type RunInput } from "./discovery";
import { emptyUsage, isVisionModel, mergeUsage, type LlmConfig, type UsageTotals } from "./llm";
import { credentialsAlreadyRejected, recordCredentialRejection } from "./credentials";
import { WALK_WRAP_UP_ITERATIONS, walkingIterationCap } from "./limits";

export interface WalkRun extends RunInput {
  id: string;
  appSlug: string;
  appId?: string | null;
}

const SEVERITY_ORDER: StepStatus[] = ["ok", "skipped", "confusing", "risky", "exposed", "broken"];

function worstStatus(statuses: StepStatus[]): StepStatus {
  return statuses.reduce<StepStatus>(
    (worst, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst),
    "ok",
  );
}

// Journey roll-up. Skipped steps must not drag a working journey down to
// "Skipped": ok + skipped mixes become "partial" (the flow works, part of it
// went unverified). All-skipped stays "skipped"; any real problem still wins.
function journeyStatus(statuses: StepStatus[]): string {
  const attempted = statuses.filter((s) => s !== "skipped");
  if (attempted.length === 0) return "skipped";
  const worst = worstStatus(attempted);
  return worst === "ok" && attempted.length < statuses.length ? "partial" : worst;
}

// The journey summary is meant to be a 1-2 sentence "what we found" line, but
// the model often dumps a full markdown report (headings, a step table). That
// leaks raw markdown into the verdict UI. Strip markdown structure and keep the
// first bit of prose so the strip caption reads cleanly.
function cleanSummary(text: string): string | null {
  const prose = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("---"))
    .join(" ")
    .replace(/\*\*|`|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // The UI prints its own "What we found:" lead-in; a model-written
    // "Summary:" after it reads as stuttering boilerplate.
    .replace(/^summary\s*[:—-]\s*/i, "");
  if (prose.length <= 400) return prose || null;
  // Cut at a sentence boundary instead of mid-word: a caption that ends in
  // "the /en/login route 307-redi" reads as a bug of ours, not the app's.
  const window = prose.slice(0, 400);
  const lastStop = window.lastIndexOf(". ");
  return lastStop > 150 ? window.slice(0, lastStop + 1) : `${window.trimEnd()}…`;
}

// The forced-extraction path asks for raw code, but models still wrap it in a
// ```ts fence about half the time. Strip a single leading/trailing fence.
function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:[a-zA-Z]+)?\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Walk ONE journey. Called per-journey from its own Workflow step (CHE-24) so a
// CPU-limit/retry only re-does that journey, never the whole walk. Idempotent:
// any pre-existing journey for (runId, order) is deleted first (cascades steps/
// evidence), so a step retry can't accumulate duplicate journey rows.
export async function walkOneJourney(args: {
  env: AgentEnv;
  llm: LlmConfig;
  browser: Browser;
  run: WalkRun;
  proposed: ProposedJourney;
  index: number;
  onLiveScreenshot?: (url: string) => Promise<void>;
  onProgress?: (note: string) => Promise<void>;
}): Promise<{ transcript: TranscriptEntry[]; costUsd: number; usage: UsageTotals }> {
  const { env, llm, browser, run, proposed, index, onLiveScreenshot, onProgress } = args;
  const transcripts: TranscriptEntry[] = [];
  let costUsd = 0;
  const usage = emptyUsage();

  await env.db.journey.deleteMany({ where: { runId: run.id, order: index } });

  {
    const context = await browser.newContext(agentContextOptions(browser));
    const page = await context.newPage();

    const journey = await env.db.journey.create({
      data: { runId: run.id, order: index, title: proposed.title, status: "ok" },
    });

    const stepStatuses: StepStatus[] = [];
    let stepOrder = 0;
    let testWritten = false;
    let lastScreenshot: { storageUrl: string; sha256: string } | null = null;
    // CHE-129: navigate/click/fill accumulate here between report_step calls;
    // each report drains what ran since the last one into that step's row.
    const actionTrail: RecordedAction[] = [];

    const toolEnv: ToolEnv = {
      page,
      targetOrigin: originOf(run.targetUrl),
      visionScreenshots: isVisionModel(llm.navModel),
      // CHE-90: creation is allowed only when the owner enabled it, and every
      // created record lands in the ledger the moment it exists.
      writeAllowed: run.writeAllowed ?? false,
      testMarker: run.testMarker,
      onResourceCreated: async (r) => {
        await env.db.createdResource.create({
          data: {
            runId: run.id,
            appId: run.appId ?? null,
            kind: r.kind.slice(0, 100),
            marker: r.marker.slice(0, 200),
            locationUrl: r.locationUrl?.slice(0, 500) ?? null,
            notes: r.notes?.slice(0, 500) ?? null,
          },
        });
      },
      onResourceDeleted: async (r) => {
        await env.db.createdResource.updateMany({
          where: { runId: run.id, marker: r.marker },
          data: r.ok
            ? { deletedAt: new Date(), cleanupNote: r.note?.slice(0, 500) ?? null }
            : { cleanupNote: (r.note ?? "deletion failed").slice(0, 500) },
        });
      },
      testEmail: run.testEmail ?? undefined,
      testPassword: run.testPasswordEnc ? decryptSecret(run.testPasswordEnc) : undefined,
      networkLog: [],
      consoleLog: [],
      // CHE-100: read fresh per journey, because that is what makes the rule
      // hold across journeys — an earlier one may already have been told no.
      credentials: { rejected: await credentialsAlreadyRejected(env, run.id) },
      onCredentialRejected: (signature) => recordCredentialRejection(env, run.id, signature),
      actionTrail,
      onScreenshot: async (buffer) => {
        const stored = await putScreenshot(env, buffer);
        lastScreenshot = stored;
        await onLiveScreenshot?.(stored.storageUrl);
        return stored.storageUrl;
      },
      onReportStep: async (step) => {
        stepStatuses.push(step.status as StepStatus);
        const trail = actionTrail.splice(0);
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
            unverifiedReason: step.unverifiedReason ?? null,
            actions: trail.length ? JSON.stringify(trail) : null,
            screenshotUrl: lastScreenshot?.storageUrl ?? null,
            evidence: lastScreenshot
              ? { create: [{ type: "screenshot", ...lastScreenshot }] }
              : undefined,
          },
        });
        lastScreenshot = null;
      },
      onWriteTest: async (test) => {
        testWritten = true;
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
        // CHE-134: sized to the journey. The cap was a flat 50 whatever the
        // journey's length, and walks ran 25–40 calls each, output-token
        // dominated (COSTS.md). A 3-step journey gets 27, an 8-step one 50.
        maxIterations: walkingIterationCap(proposed.steps.length),
        // CHE-134: the spec is the last artefact a journey produces; after it
        // the walk got no further evidence, only the bill. Three more turns
        // cover cleanup (a create_cleanup walk must delete its record and
        // call record_deleted before finishing, CHE-90) and the summary.
        // Model-facing only: report_step is untouched, so nothing here can
        // reach Step.attempted/observed or any other customer-facing text.
        wrapUpAfter: {
          tool: "write_e2e_test",
          extraIterations: WALK_WRAP_UP_ITERATIONS,
          note:
            "The journey is recorded. Wrap up now: if you created anything, delete it " +
            "and call record_deleted; then reply with the 1-2 sentence summary and make " +
            "no further tool calls.",
        },
        // E3 (CHE-58): walking is act/observe, not deep reasoning — drop
        // adaptive thinking to cut output tokens/call. Verdict calibration
        // still happens in synthesis (Opus, thinking on).
        thinking: "off",
        onProgress,
        // CHE-130: screenshots accumulated in the walking context and were
        // re-read every iteration — a full joblander walk went $0.91 → $2.31
        // when vision nav landed. Keep only the last few in view.
        imageWindow: walkImageWindow(env.bindings),
      });
      transcripts.push(...result.transcript);
      costUsd += result.costUsd;
      mergeUsage(usage, result.usage);

      // The walk authors a Playwright spec via write_e2e_test, but the model
      // often exhausts its iteration budget acting/observing and never reaches
      // that closing call (same failure mode as discovery's journey JSON). If
      // it walked real steps but wrote no test, reuse the journey context to
      // force the spec out — the "worker authors its own e2e tests" guarantee
      // must hold per run, not depend on the model remembering to wrap up.
      if (!testWritten && stepStatuses.length > 0) {
        const spec = await finalizeJson(
          llm,
          result.messages,
          "You did not call write_e2e_test. Output ONLY a complete Playwright spec " +
            "(TypeScript, @playwright/test) replaying this journey's happy path with " +
            "role-based locators and process.env.TARGET_URL as base URL. Assert only on " +
            "what you actually observed working. No prose — just the code.",
          usage,
        );
        const content = stripCodeFence(spec);
        if (content.includes("@playwright/test")) {
          await persistGeneratedTest(env, {
            appSlug: run.appSlug,
            journeyId: journey.id,
            title: proposed.title,
            content,
          });
        }
      }

      await env.db.journey.update({
        where: { id: journey.id },
        data: {
          status: journeyStatus(stepStatuses),
          summary: cleanSummary(result.finalText),
        },
      });
    } catch (err) {
      // Per-journey isolation: one failure must not abort the rest of the run.
      // Our own LLM budget died (CHE-76) — not a fact about this journey or the
      // app. Propagate so the workflow aborts the whole run unpublished instead
      // of burning through the remaining journeys and shipping a verdict.
      if (err instanceof LlmBudgetError) throw err;
      console.error(`[walk] journey "${proposed.title}" failed:`, err);
      await env.db.journey.update({
        where: { id: journey.id },
        data: {
          status: journeyStatus(stepStatuses),
          summary: `Walk aborted: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
        },
      });
    } finally {
      await context.close();
    }
  }

  return { transcript: transcripts, costUsd, usage };
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
