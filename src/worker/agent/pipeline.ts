// The 6-phase orchestrator. Each phase advances the Run's status (which the
// /run/{id} page renders as the phase banner) and appends events to the live feed.
//
// This is the skeleton: phase ordering, status transitions, evidence wiring, and
// error/partial handling are real; the heavy lifting inside discovery / execution
// / synthesis is stubbed with clearly-marked TODOs.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendVerdictReady } from "@/lib/email";
import type { RunEvent, RunPhase } from "@/lib/types";
import { discoverApp } from "./discovery";
import { walkJourneys } from "./execution";
import { synthesizeVerdict } from "./synthesis";
import { launchBrowser } from "./browser";

export async function runPipeline(runId: string): Promise<void> {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`run ${runId} not found`);

  const browser = await launchBrowser();

  try {
    // Phase 1 — Connecting (ownership check skipped for MVP first run).
    await transition(runId, "connecting", { icon: "info", text: "Spinning up agent" });

    // Phase 2 — Surface scan: load homepage, detect stack.
    await transition(runId, "surface_scan", {
      icon: "ok",
      text: `Loading ${run.targetUrl}`,
    });

    // Phase 3 — Discovery: log in, map nav, find up-to-5 journeys.
    await transition(runId, "discovery", { icon: "info", text: "Mapping your app" });
    const discovery = await discoverApp({ run, browser });

    // Phase 4 — Walking journeys: execute each one, capturing per-step evidence.
    await transition(runId, "walking", {
      icon: "info",
      text: `Walking ${discovery.journeys.length} discovered journeys`,
    });
    await walkJourneys({ runId, browser, journeys: discovery.journeys });

    // Phase 5 — Anatomy: assemble pages/actions/services/tech.
    await transition(runId, "anatomy", { icon: "info", text: "Assembling app anatomy" });
    await prisma.run.update({
      where: { id: runId },
      data: { anatomy: discovery.anatomy as unknown as Prisma.InputJsonValue },
    });

    // Phase 6 — Writing verdict: LLM synthesizes App Lens + bottom-line verdict.
    await transition(runId, "writing", { icon: "info", text: "Writing your verdict" });
    const { appLens, verdict } = await synthesizeVerdict({ runId, discovery });

    const completed = await prisma.run.update({
      where: { id: runId },
      data: {
        status: "completed",
        verdict,
        appLens: appLens as unknown as Prisma.InputJsonValue,
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
    select: { watchId: true },
  });
  if (run?.watchId) return; // Watch keeps credentials for recurring runs
  await prisma.run.update({
    where: { id: runId },
    data: { testPasswordEnc: null },
  });
}
