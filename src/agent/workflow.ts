// CheckRunWorkflow (CHE-14/15) — the durable 6-phase orchestrator on Cloudflare
// Workflows, replacing the BullMQ worker loop. Each phase is a step.do(): the
// run survives retries and restarts; step outputs are persisted.
//
// connecting → surface_scan (deterministic) → discovery (LLM) → walking (LLM,
// per journey) → anatomy → writing (LLM synthesis + findings). Browser sessions
// are per-phase. Transcript (secret-free) → R2; cost rolled into Run.costUsd.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AppAnatomy } from "@/lib/types";
import type { RunEvent, RunPhase } from "@/lib/types";
import { makeAgentEnv, putText, type AgentBindings, type AgentEnv } from "./env";
import { makeLlm } from "./llm";
import { launchAgentBrowser, surfaceScan } from "./browser";
import { discoverApp, type RunInput } from "./discovery";
import { walkJourneys, type WalkRun } from "./execution";
import { synthesizeVerdict, type SynthesizedFinding } from "./synthesis";
import type { TranscriptEntry } from "./core";

export interface CheckRunParams {
  runId: string;
}

export class CheckRunWorkflow extends WorkflowEntrypoint<AgentBindings, CheckRunParams> {
  async run(event: WorkflowEvent<CheckRunParams>, step: WorkflowStep): Promise<void> {
    const { runId } = event.payload;
    const env = makeAgentEnv(this.env);
    const llm = makeLlm(this.env);

    const run = await step.do("load-run", async () => {
      const r = await env.db.run.findUnique({
        where: { id: runId },
        select: {
          id: true,
          targetUrl: true,
          appSlug: true,
          testEmail: true,
          testPasswordEnc: true,
          scopeHints: true,
          userNotes: true,
          notifyEmail: true,
          watchId: true,
        },
      });
      if (!r) throw new Error(`run ${runId} not found`);
      return r;
    });

    const walkRun: WalkRun = {
      id: run.id,
      appSlug: run.appSlug,
      targetUrl: run.targetUrl,
      testEmail: run.testEmail,
      testPasswordEnc: run.testPasswordEnc,
      scopeHints: run.scopeHints,
      userNotes: run.userNotes,
    };

    try {
      await step.do("connecting", async () => {
        await transition(env, runId, "connecting", { icon: "info", text: "Spinning up agent" });
      });

      // Phase 2 — Surface scan (deterministic).
      const scan = await step.do("surface_scan", async () => {
        await transition(env, runId, "surface_scan", { icon: "info", text: `Loading ${run.targetUrl}` });
        const browser = await launchAgentBrowser(env);
        try {
          const r = await surfaceScan(env, browser, run.targetUrl);
          if (r.screenshotUrl) {
            await env.db.run.update({ where: { id: runId }, data: { liveScreenshotUrl: r.screenshotUrl } });
          }
          await appendEvent(env, runId, "surface_scan", {
            icon: "ok",
            text: `Loaded homepage (HTTP ${r.status ?? "?"})`,
          });
          if (r.techSignals.length) {
            await appendEvent(env, runId, "surface_scan", {
              icon: "ok",
              text: `Detected ${r.techSignals.join(" + ")}`,
            });
          }
          await appendEvent(env, runId, "surface_scan", {
            icon: "ok",
            text: `Found ${r.internalLinkCount} internal links`,
          });
          return r;
        } finally {
          await browser.close();
        }
      });

      // Phase 3 — Discovery (LLM).
      const discovery = await step.do("discovery", async () => {
        await transition(env, runId, "discovery", { icon: "info", text: "Mapping your app" });
        const browser = await launchAgentBrowser(env);
        try {
          const d = await discoverApp({
            env,
            llm,
            browser,
            run: run as RunInput,
            onLiveScreenshot: (url) => setLive(env, runId, { liveScreenshotUrl: url }),
            onProgress: (note) => setLive(env, runId, { currentAction: note }),
          });
          await appendEvent(env, runId, "discovery", {
            icon: d.journeys.length ? "ok" : "warn",
            text: d.journeys.length
              ? `Proposed ${d.journeys.length} user journeys`
              : "No journeys mapped",
          });
          return d;
        } finally {
          await browser.close();
        }
      });

      // Phase 4 — Walking journeys (LLM).
      const walk = await step.do("walking", async () => {
        await transition(env, runId, "walking", {
          icon: "info",
          text: `Walking ${discovery.journeys.length} discovered journeys`,
        });
        const browser = await launchAgentBrowser(env);
        try {
          return await walkJourneys({
            env,
            llm,
            browser,
            run: walkRun,
            journeys: discovery.journeys,
            onLiveScreenshot: (url) => setLive(env, runId, { liveScreenshotUrl: url }),
            onProgress: (note) => setLive(env, runId, { currentAction: note }),
          });
        } finally {
          await browser.close();
        }
      });

      // Phase 5 — Anatomy (merge deterministic scan signals into the LLM map).
      const anatomy: AppAnatomy = await step.do("anatomy", async () => {
        await transition(env, runId, "anatomy", { icon: "info", text: "Assembling app anatomy" });
        const tech = { ...discovery.anatomy.tech };
        if (scan.techSignals.length && !tech.frontend) tech.frontend = scan.techSignals.join(" · ");
        const merged: AppAnatomy = { ...discovery.anatomy, tech };
        await env.db.run.update({ where: { id: runId }, data: { anatomy: JSON.stringify(merged) } });
        return merged;
      });

      // Phase 6 — Writing (LLM synthesis + findings + verdict).
      await step.do("writing", async () => {
        await transition(env, runId, "writing", { icon: "info", text: "Writing your verdict" });
        const synth = await synthesizeVerdict({ env, llm, runId, anatomy });
        await persistFindings(env, runId, synth.findings);
        if (synth.findings.length) {
          await appendEvent(env, runId, "writing", {
            icon: "ok",
            text: `Recorded ${synth.findings.length} findings`,
          });
        }

        const transcript: TranscriptEntry[] = [...discovery.transcript, ...walk.transcript];
        let transcriptUrl: string | null = null;
        if (transcript.length) {
          transcriptUrl = await putText(
            env,
            `transcripts/${runId}.json`,
            JSON.stringify(transcript, null, 2),
          );
        }

        const costUsd = discovery.costUsd + walk.costUsd + synth.costUsd;
        await env.db.run.update({
          where: { id: runId },
          data: {
            status: "completed",
            verdict: synth.verdict,
            bottomLine: synth.bottomLine,
            appLens: JSON.stringify(synth.appLens),
            transcriptUrl,
            costUsd,
            currentAction: null,
            completedAt: new Date(),
          },
        });
      });

      // Privacy: clear test credentials after a terminal completion, unless a
      // Watch retains them for recurring runs.
      await step.do("cleanup", async () => {
        if (!run.watchId) {
          await env.db.run.update({ where: { id: runId }, data: { testPasswordEnc: null } });
        }
      });
    } catch (err) {
      await step.do("fail", async () => {
        await env.db.run.update({
          where: { id: runId },
          data: { status: "failed", errorMessage: err instanceof Error ? err.message : String(err) },
        });
      });
      throw err;
    }
  }
}

// ─── findings persistence (port of pipeline.persistFindings) ─────────────────

async function persistFindings(env: AgentEnv, runId: string, findings: SynthesizedFinding[]) {
  if (!findings.length) return;
  const journeys = await env.db.journey.findMany({
    where: { runId },
    include: { steps: { orderBy: { order: "asc" }, include: { evidence: true } } },
    orderBy: { order: "asc" },
  });
  let number = 1;
  for (const f of findings) {
    const step = f.stepRef ? journeys[f.stepRef.journeyIndex]?.steps[f.stepRef.stepIndex] : undefined;
    const shot = step?.evidence.find((e) => e.type === "screenshot");
    await env.db.finding.create({
      data: {
        runId,
        number: number++,
        title: f.title.slice(0, 300),
        category: f.category,
        severity: f.severity,
        detail: JSON.stringify(f.detail),
        evidence: shot
          ? { create: [{ type: "screenshot", storageUrl: shot.storageUrl, sha256: shot.sha256 }] }
          : undefined,
      },
    });
  }
}

// ─── D1 event helpers (single-instance serial — no transaction needed) ───────

async function setLive(
  env: AgentEnv,
  runId: string,
  data: { currentAction?: string; liveScreenshotUrl?: string },
) {
  await env.db.run.update({ where: { id: runId }, data });
}

async function transition(
  env: AgentEnv,
  runId: string,
  phase: RunPhase,
  event: Omit<RunEvent, "at" | "phase">,
) {
  const events = await readEvents(env, runId);
  events.push({ at: new Date().toISOString(), phase, ...event });
  await env.db.run.update({ where: { id: runId }, data: { status: phase, events: JSON.stringify(events) } });
}

async function appendEvent(
  env: AgentEnv,
  runId: string,
  phase: RunPhase,
  event: Omit<RunEvent, "at" | "phase">,
) {
  const events = await readEvents(env, runId);
  events.push({ at: new Date().toISOString(), phase, ...event });
  await env.db.run.update({ where: { id: runId }, data: { events: JSON.stringify(events) } });
}

async function readEvents(env: AgentEnv, runId: string): Promise<RunEvent[]> {
  const r = await env.db.run.findUnique({ where: { id: runId }, select: { events: true } });
  if (!r?.events) return [];
  try {
    return JSON.parse(r.events) as RunEvent[];
  } catch {
    return [];
  }
}
