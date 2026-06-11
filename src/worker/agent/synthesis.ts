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

// Prompt straight from the Mockups spec (Section 3.1) + Findings (Section 3.4).
const APP_LENS_SYSTEM = `You just observed a web app for a while. Produce two things.

1. An "App Lens": (1) what this app does in one sentence, (2) who it's for,
(3) core value, (4) business model, (5) tech surface, (6) critical paths to
protect, plus a one-sentence bottom-line verdict on its current state.
Write it like a product manager describing the product, not like a QA report.
Use language the founder would use themselves.

2. "Findings": 3-12 concrete, actionable findings from the walked journeys.
Categories: broken (does not work) / risky (works but fragile or abusable) /
confusing (user would hesitate) / polish (cosmetic) / exposed (security).
Severity: high / medium / low. Every finding must trace back to something
actually observed in the steps — no speculation. Where possible reference the
step it came from via stepRef (journeyIndex and stepIndex are 0-based).

Respond with ONLY JSON:
{"oneLiner":"...","whoFor":"...","coreValue":"...","businessModel":"...",
 "techSurface":"...","criticalPaths":["..."],"ifItBreaks":"...","bottomLine":"...",
 "findings":[{"title":"...","category":"broken|risky|confusing|polish|exposed",
  "severity":"high|medium|low",
  "detail":{"where":"...","whatWeTried":["..."],"whatHappened":"...","whyItMatters":"..."},
  "stepRef":{"journeyIndex":0,"stepIndex":0}}]}`;

export interface SynthesizedFinding {
  title: string;
  category: "broken" | "risky" | "confusing" | "polish" | "exposed";
  severity: "high" | "medium" | "low";
  detail: {
    where?: string;
    whatWeTried?: string[];
    whatHappened?: string;
    whyItMatters?: string;
  };
  stepRef?: { journeyIndex: number; stepIndex: number };
}

export async function synthesizeVerdict(args: {
  runId: string;
  discovery: { journeys: ProposedJourney[]; anatomy: AppAnatomy };
}): Promise<{
  appLens: AppLens;
  verdict: Verdict;
  bottomLine: string | null;
  findings: SynthesizedFinding[];
}> {
  const { runId, discovery } = args;

  // Roll the worst journey status into a bottom-line verdict.
  const journeys = await prisma.journey.findMany({
    where: { runId },
    include: {
      steps: {
        orderBy: { order: "asc" },
        select: {
          label: true,
          status: true,
          attempted: true,
          observed: true,
          consoleLog: true,
          networkLog: true,
        },
      },
    },
    orderBy: { order: "asc" },
  });
  const verdict = rollUpVerdict(journeys.map((j) => j.status));

  if (!hasApiKey()) {
    return { appLens: placeholderLens(), verdict, bottomLine: null, findings: [] };
  }

  const observation = JSON.stringify({
    pages: discovery.anatomy.pages,
    actions: discovery.anatomy.actions,
    services: discovery.anatomy.services,
    tech: discovery.anatomy.tech,
    journeys: journeys.map((j) => ({
      title: j.title,
      status: j.status,
      summary: j.summary,
      steps: j.steps,
    })),
  });

  const message = await anthropic.messages.create({
    model: AGENT_MODEL,
    max_tokens: 8_000,
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

const VALID_CATEGORIES = ["broken", "risky", "confusing", "polish", "exposed"] as const;
const VALID_SEVERITIES = ["high", "medium", "low"] as const;

function parseAppLens(message: Anthropic.Message): {
  appLens: AppLens;
  bottomLine: string | null;
  findings: SynthesizedFinding[];
} {
  const text = message.content.find((b) => b.type === "text");
  if (text && text.type === "text") {
    const match = text.text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const raw = JSON.parse(match[0]) as AppLens & {
          bottomLine?: string;
          findings?: SynthesizedFinding[];
        };
        const { bottomLine, findings, ...lens } = raw;
        return {
          appLens: { ...placeholderLens(), ...lens },
          bottomLine: bottomLine ?? null,
          findings: (findings ?? [])
            .filter((f) => f.title)
            .slice(0, 20)
            .map((f) => ({
              ...f,
              category: VALID_CATEGORIES.includes(f.category) ? f.category : "confusing",
              severity: VALID_SEVERITIES.includes(f.severity) ? f.severity : "low",
              detail: f.detail ?? {},
            })),
        };
      } catch {
        // fall through
      }
    }
  }
  return { appLens: placeholderLens(), bottomLine: null, findings: [] };
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
