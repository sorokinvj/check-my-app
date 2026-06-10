// Phase 6 — Synthesis.
//
// Turns the observed run (pages, actions, services, journey outcomes) into the
// App Lens (PM-voice product description) and a bottom-line verdict. Uses the
// Anthropic Messages API. The model is configurable via ANTHROPIC_MODEL.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import type { AppLens } from "@/lib/types";
import type { Verdict, StepStatus } from "@prisma/client";
import type { DiscoveryResult } from "./discovery";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

// Prompt straight from the Mockups spec (Section 3.1).
const APP_LENS_SYSTEM = `You just observed a web app for ~2 hours. Generate a 6-bullet "App Lens" describing:
(1) what this app does in one sentence, (2) who it's for, (3) core value,
(4) business model, (5) tech surface, (6) critical paths.
Write it like a product manager describing the product, not like a QA report.
Use language the founder would use themselves. Respond as JSON matching the AppLens shape.`;

export async function synthesizeVerdict(args: {
  runId: string;
  discovery: DiscoveryResult;
}): Promise<{ appLens: AppLens; verdict: Verdict }> {
  const { runId, discovery } = args;

  // Roll the worst journey status into a bottom-line verdict.
  const journeys = await prisma.journey.findMany({
    where: { runId },
    select: { status: true },
  });
  const verdict = rollUpVerdict(journeys.map((j) => j.status));

  let appLens: AppLens;
  if (process.env.ANTHROPIC_API_KEY) {
    const observation = JSON.stringify({
      pages: discovery.anatomy.pages,
      actions: discovery.anatomy.actions,
      services: discovery.anatomy.services,
      tech: discovery.anatomy.tech,
      journeys: discovery.journeys.map((j) => j.title),
    });

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: APP_LENS_SYSTEM,
      messages: [{ role: "user", content: observation }],
    });

    appLens = parseAppLens(message);
  } else {
    // Offline/dev fallback so the pipeline completes without an API key.
    appLens = placeholderLens();
  }

  return { appLens, verdict };
}

function rollUpVerdict(statuses: StepStatus[]): Verdict {
  if (statuses.some((s) => s === "broken" || s === "exposed")) return "broken";
  if (statuses.some((s) => s === "risky")) return "needs_attention";
  if (statuses.some((s) => s === "confusing")) return "mostly_ok";
  return "all_good";
}

function parseAppLens(message: Anthropic.Message): AppLens {
  const text = message.content.find((b) => b.type === "text");
  if (text && text.type === "text") {
    try {
      return JSON.parse(text.text) as AppLens;
    } catch {
      // fall through to placeholder if the model didn't return clean JSON
    }
  }
  return placeholderLens();
}

function placeholderLens(): AppLens {
  return {
    oneLiner: "TODO: synthesized product description",
    whoFor: "",
    coreValue: "",
    businessModel: "",
    techSurface: "",
    criticalPaths: [],
    ifItBreaks: "",
  };
}
