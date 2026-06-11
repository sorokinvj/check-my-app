// Phase 6 — Synthesis.
//
// Turns the observed run (pages, actions, services, journey outcomes) into the
// App Lens (PM-voice product description) + a one-sentence bottom line. Uses the
// Anthropic Messages API. The model is configurable via ANTHROPIC_MODEL.

import { prisma } from "@/lib/db";
import type { AppLens, AppAnatomy } from "@/lib/types";
import type { Verdict, StepStatus } from "@prisma/client";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, AGENT_MODEL, hasApiKey } from "./llm";
import type { ProposedJourney } from "./discovery";

// Prompt straight from the Mockups spec (Section 3.1).
const APP_LENS_SYSTEM = `You just observed a web app for a while. Generate an "App Lens" describing:
(1) what this app does in one sentence, (2) who it's for, (3) core value,
(4) business model, (5) tech surface, (6) critical paths to protect, plus
(7) a one-sentence bottom-line verdict on its current state.
Write it like a product manager describing the product, not like a QA report.
Use language the founder would use themselves.
Respond with ONLY JSON:
{"oneLiner":"...","whoFor":"...","coreValue":"...","businessModel":"...",
 "techSurface":"...","criticalPaths":["..."],"ifItBreaks":"...","bottomLine":"..."}`;

export async function synthesizeVerdict(args: {
  runId: string;
  discovery: { journeys: ProposedJourney[]; anatomy: AppAnatomy };
}): Promise<{ appLens: AppLens; verdict: Verdict; bottomLine: string | null }> {
  const { runId, discovery } = args;

  // Roll the worst journey status into a bottom-line verdict.
  const journeys = await prisma.journey.findMany({
    where: { runId },
    select: { status: true, title: true, summary: true },
  });
  const verdict = rollUpVerdict(journeys.map((j) => j.status));

  if (!hasApiKey()) {
    return { appLens: placeholderLens(), verdict, bottomLine: null };
  }

  const observation = JSON.stringify({
    pages: discovery.anatomy.pages,
    actions: discovery.anatomy.actions,
    services: discovery.anatomy.services,
    tech: discovery.anatomy.tech,
    journeys: journeys.map((j) => ({ title: j.title, status: j.status, summary: j.summary })),
  });

  const message = await anthropic.messages.create({
    model: AGENT_MODEL,
    max_tokens: 2_000,
    thinking: { type: "adaptive" },
    system: APP_LENS_SYSTEM,
    messages: [{ role: "user", content: observation }],
  });

  return { ...parseAppLens(message), verdict };
}

function rollUpVerdict(statuses: StepStatus[]): Verdict {
  if (statuses.some((s) => s === "broken" || s === "exposed")) return "broken";
  if (statuses.some((s) => s === "risky")) return "needs_attention";
  if (statuses.some((s) => s === "confusing")) return "mostly_ok";
  return "all_good";
}

function parseAppLens(message: Anthropic.Message): {
  appLens: AppLens;
  bottomLine: string | null;
} {
  const text = message.content.find((b) => b.type === "text");
  if (text && text.type === "text") {
    const match = text.text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const raw = JSON.parse(match[0]) as AppLens & { bottomLine?: string };
        const { bottomLine, ...lens } = raw;
        return { appLens: { ...placeholderLens(), ...lens }, bottomLine: bottomLine ?? null };
      } catch {
        // fall through
      }
    }
  }
  return { appLens: placeholderLens(), bottomLine: null };
}

function placeholderLens(): AppLens {
  return {
    oneLiner: "Synthesis pending — run with ANTHROPIC_API_KEY for the App Lens.",
    whoFor: "",
    coreValue: "",
    businessModel: "",
    techSurface: "",
    criticalPaths: [],
    ifItBreaks: "",
  };
}
