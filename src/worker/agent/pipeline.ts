// The 6-phase orchestrator. Each phase advances the Run's status (which the
// /run/{id} page renders as the phase banner) and appends events to the live feed.
//
// Phases 2-4 are real: surface scan is deterministic; discovery and walking run
// on the CHE-7 LLM agent core (claude-opus-4-8 + browser tools). The combined
// agent transcript is persisted as an audit artifact (Run.transcriptUrl).

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendVerdictReady } from "@/lib/email";
import type { RunEvent, RunPhase } from "@/lib/types";
import { discoverApp } from "./discovery";
import { walkJourneys } from "./execution";
import { synthesizeVerdict } from "./synthesis";
import { launchBrowser } from "./browser";
import { surfaceScan } from "./surface-scan";
import { storeText } from "./evidence";
import { hasApiKey } from "./llm";
import type { TranscriptEntry } from "./core";

export async function runPipeline(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`run ${runId} not found`);

  const browser = await launchBrowser();
  const transcript: TranscriptEntry[] = [];

  const onLiveScreenshot = async (url: string) =>
    setLiveState(runId, { liveScreenshotUrl: url });
  const onProgress = async (note: string) => {
    await setLiveState(runId, { currentAction: note });
  };

  try {
    // Phase 1 — Connecting (ownership check skipped for MVP first run).
    await transition(runId, "connecting", { icon: "info", text: "Spinning up agent" });

    // Phase 2 — Surface scan: load homepage, detect stack, first screenshot.
    await transition(runId, "surface_scan", {
      icon: "info",
      text: `Loading ${run.targetUrl}`,
    });
    const scan = await surfaceScan({ browser, targetUrl: run.targetUrl });
    if (scan.screenshotUrl) {
      await setLiveState(runId, { liveScreenshotUrl: scan.screenshotUrl });
    }
    await appendEvent(runId, "surface_scan", {
      icon: "ok",
      text: `Loaded homepage (HTTP ${scan.status ?? "?"})`,
    });
    if (scan.techSignals.length > 0) {
      await appendEvent(runId, "surface_scan", {
        icon: "ok",
        text: `Detected ${scan.techSignals.join(" + ")}`,
      });
    }
    await appendEvent(runId, "surface_scan", {
      icon: "ok",
      text: `Found ${scan.internalLinkCount} internal links`,
    });
    if (!hasApiKey()) {
      await appendEvent(runId, "surface_scan", {
        icon: "warn",
        text: "ANTHROPIC_API_KEY not set — agent phases will be skipped",
      });
    }

    // Phase 3 — Discovery: the LLM maps the app and proposes journeys.
    await transition(runId, "discovery", { icon: "info", text: "Mapping your app" });
    const discovery = await discoverApp({ run, browser, onLiveScreenshot, onProgress });
    transcript.push(...discovery.transcript);
    await appendEvent(runId, "discovery", {
      icon: discovery.journeys.length > 0 ? "ok" : "warn",
      text:
        discovery.journeys.length > 0
          ? `Proposed ${discovery.journeys.length} user journeys`
          : "No journeys mapped — discovery returned nothing usable",
    });

    // Phase 4 — Walking journeys: execute each one, capturing per-step evidence
    // and formalizing each journey as a generated Playwright spec (CHE-8).
    await transition(runId, "walking", {
      icon: "info",
      text: `Walking ${discovery.journeys.length} discovered journeys`,
    });
    const walkTranscript = await walkJourneys({
      run,
      browser,
      journeys: discovery.journeys,
      onLiveScreenshot,
      onProgress,
    });
    transcript.push(...walkTranscript);

    // Phase 5 — Anatomy: merge deterministic scan signals into the LLM's map.
    await transition(runId, "anatomy", { icon: "info", text: "Assembling app anatomy" });
    const tech = { ...discovery.anatomy.tech };
    if (scan.techSignals.length > 0 && !tech.frontend) {
      tech.frontend = scan.techSignals.join(" · ");
    }
    const anatomy = { ...discovery.anatomy, tech };
    await prisma.run.update({
      where: { id: runId },
      data: { anatomy: anatomy as unknown as Prisma.InputJsonValue },
    });

    // Phase 6 — Writing verdict: LLM synthesizes App Lens + bottom-line verdict.
    await transition(runId, "writing", { icon: "info", text: "Writing your verdict" });
    const { appLens, verdict, bottomLine, findings } = await synthesizeVerdict({
      runId,
      discovery: { journeys: discovery.journeys, anatomy },
    });
    await persistFindings(runId, findings);
    if (findings.length > 0) {
      await appendEvent(runId, "writing", {
        icon: "ok",
        text: `Recorded ${findings.length} findings`,
      });
    }

    // Audit artifact: the full agent transcript (secret-free by construction).
    let transcriptUrl: string | null = null;
    if (transcript.length > 0) {
      transcriptUrl = await storeText(
        "transcripts",
        `${run.publicId}.json`,
        JSON.stringify(transcript, null, 2),
      );
    }

    const completed = await prisma.run.update({
      where: { id: runId },
      data: {
        status: "completed",
        verdict,
        bottomLine,
        appLens: appLens as unknown as Prisma.InputJsonValue,
        transcriptUrl,
        currentAction: null,
        completedAt: new Date(),
      },
    });

    await maybeNotify(completed.notifyEmail, completed.appSlug, completed.publicId, false);
  } catch (err) {
    await fail(runId, err);
    throw err;
  } finally {
    await browser.close().catch(() => {});
    // Privacy: clear plaintext-equivalent credentials unless a Watch retains them.
    await clearEphemeralCredentials(runId);
  }
}

// Update the /run/{id} live-theatre fields: what the agent is doing right now
// (plain English) and the latest screenshot of its browser. Call freely from
// discovery/execution — the SSE stream picks both up on the next tick.
export async function setLiveState(
  runId: string,
  state: { currentAction?: string; liveScreenshotUrl?: string },
) {
  await prisma.run.update({ where: { id: runId }, data: state });
}

// Advance status and append one feed event in a single update.
async function transition(runId: string, phase: RunPhase, event: Omit<RunEvent, "at" | "phase">) {
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { events: true } });
  const events = (run?.events as RunEvent[] | null) ?? [];
  events.push({ at: new Date().toISOString(), phase, ...event });
  await prisma.run.update({
    where: { id: runId },
    data: { status: phase, events: events as unknown as Prisma.InputJsonValue },
  });
}

// Append a feed event without changing the phase.
async function appendEvent(
  runId: string,
  phase: RunPhase,
  event: Omit<RunEvent, "at" | "phase">,
) {
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { events: true } });
  const events = (run?.events as RunEvent[] | null) ?? [];
  events.push({ at: new Date().toISOString(), phase, ...event });
  await prisma.run.update({
    where: { id: runId },
    data: { events: events as unknown as Prisma.InputJsonValue },
  });
}

// Persist synthesized findings (CHE-5). Each finding that references a walked
// step inherits that step's screenshot as evidence — findings without evidence
// aren't trusted (Project Brief).
async function persistFindings(
  runId: string,
  findings: import("./synthesis").SynthesizedFinding[],
) {
  if (findings.length === 0) return;

  const journeys = await prisma.journey.findMany({
    where: { runId },
    include: {
      steps: { orderBy: { order: "asc" }, include: { evidence: true } },
    },
    orderBy: { order: "asc" },
  });

  let number = 1;
  for (const f of findings) {
    const step = f.stepRef
      ? journeys[f.stepRef.journeyIndex]?.steps[f.stepRef.stepIndex]
      : undefined;
    const screenshot = step?.evidence.find((e) => e.type === "screenshot");

    await prisma.finding.create({
      data: {
        runId,
        number: number++,
        title: f.title.slice(0, 300),
        category: f.category,
        severity: f.severity,
        detail: f.detail as unknown as Prisma.InputJsonValue,
        evidence: screenshot
          ? {
              create: [
                {
                  type: "screenshot",
                  storageUrl: screenshot.storageUrl,
                  sha256: screenshot.sha256,
                },
              ],
            }
          : undefined,
      },
    });
  }
}

async function fail(runId: string, err: unknown) {
  await prisma.run.update({
    where: { id: runId },
    data: {
      status: "failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    },
  });
}

async function maybeNotify(
  email: string | null,
  appSlug: string,
  publicId: string,
  partial: boolean,
) {
  if (!email) return;
  await sendVerdictReady({ to: email, appSlug, publicId, partial }).catch((e) =>
    console.error("[pipeline] notify failed:", e),
  );
}

async function clearEphemeralCredentials(runId: string) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { watchId: true, status: true },
  });
  if (!run) return;
  if (run.watchId) return; // Watch keeps credentials for recurring runs
  // Only clear after a terminal completion. A failed run may be retried, and a
  // retry without the password would run auth journeys credential-less and
  // report false "broken login" findings.
  if (run.status !== "completed" && run.status !== "partial") return;
  await prisma.run.update({
    where: { id: runId },
    data: { testPasswordEnc: null },
  });
}
