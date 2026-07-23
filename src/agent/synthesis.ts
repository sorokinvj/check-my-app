// Phase 6 — Synthesis (CF agent). Turns the observed run into the App Lens
// (PM-voice) + categorized findings + a one-sentence bottom line. Runs on the
// synthesis model (Opus 4.8) — one shot, quality over cost (CHE-16).

import type { AppLens, AppAnatomy } from "@/lib/types";
import type { Verdict, StepStatus } from "@/lib/enums";
import type Anthropic from "@anthropic-ai/sdk";
import { costOf, type LlmConfig } from "./llm";
import type { AgentEnv } from "./env";
import type { ProposedJourney } from "./discovery";

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

If the journeys array is empty, or a step was skipped, nothing was verified for
it: do NOT claim it fails. When coverage is incomplete, say so in bottomLine
("we couldn't verify X this run") instead of inventing failures. Steps skipped
as untestable-in-headless (OAuth popups) are not evidence of breakage.

Steps that were merely INERT in the test browser (an interaction produced no
request/effect, with no error response or console exception) are uncertain, not
proof of breakage — the test browser differs from real ones. Never extrapolate
them into claims like "no user can log in"; describe them as "did not respond
in our test browser — verify in a real browser" and weigh them as confusing,
not broken.

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
  detail: { where?: string; whatWeTried?: string[]; whatHappened?: string; whyItMatters?: string };
  stepRef?: { journeyIndex: number; stepIndex: number };
}

export async function synthesizeVerdict(args: {
  env: AgentEnv;
  llm: LlmConfig;
  runId: string;
  anatomy: AppAnatomy;
}): Promise<{
  appLens: AppLens;
  verdict: Verdict;
  bottomLine: string | null;
  findings: SynthesizedFinding[];
  costUsd: number;
}> {
  const { env, llm, runId, anatomy } = args;

  const journeys = await env.db.journey.findMany({
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
  const observation = JSON.stringify({
    pages: anatomy.pages,
    actions: anatomy.actions,
    services: anatomy.services,
    tech: anatomy.tech,
    journeys: journeys.map((j) => ({
      title: j.title,
      status: j.status,
      summary: j.summary,
      steps: j.steps,
    })),
  });

  const message = await llm.client.messages.create({
    model: llm.synthModel,
    max_tokens: 8_000,
    thinking: { type: "adaptive" },
    system: APP_LENS_SYSTEM,
    messages: [{ role: "user", content: observation }],
  });

  const costUsd = costOf(llm.synthModel, message.usage);
  const parsed = parseAppLens(message);
  // Verdict rolls up BOTH observed journey-step outcomes AND synthesized
  // findings. Earlier it ignored findings, so a run with 0 journeys but several
  // high-severity findings reported "all_good" — a contradiction.
  let verdict = rollUpVerdict(
    journeys.map((j) => j.status as StepStatus),
    parsed.findings,
  );
  // Nothing walked ⇒ nothing verified end-to-end: a "broken" verdict would be
  // speculation (Run #10 fabricated a broken login exactly this way). Cap at
  // needs_attention unless a security exposure was directly observed.
  if (
    journeys.length === 0 &&
    verdict === "broken" &&
    !parsed.findings.some((f) => f.category === "exposed")
  ) {
    verdict = "needs_attention";
  }
  return { ...parsed, verdict, costUsd };
}

const VERDICT_RANK: Verdict[] = ["all_good", "mostly_ok", "needs_attention", "broken"];
function worseVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK.indexOf(a) >= VERDICT_RANK.indexOf(b) ? a : b;
}

// A synthesized finding (derived from exploration, not an observed runtime
// failure) maps conservatively: a product gap categorized "broken/high" is
// "needs_attention", not a fully broken app. Only observed broken/exposed
// journey steps, or any "exposed" (security) finding, escalate to "broken".
function findingVerdict(f: SynthesizedFinding): Verdict {
  if (f.category === "exposed") return "broken";
  if (f.category === "broken") return "needs_attention";
  if (f.category === "risky") return f.severity === "high" ? "needs_attention" : "mostly_ok";
  if (f.category === "confusing") return "mostly_ok";
  return "all_good"; // polish
}

function rollUpVerdict(statuses: StepStatus[], findings: SynthesizedFinding[]): Verdict {
  let verdict: Verdict = "all_good";
  if (statuses.some((s) => s === "broken" || s === "exposed")) verdict = "broken";
  else if (statuses.some((s) => s === "risky")) verdict = worseVerdict(verdict, "needs_attention");
  else if (statuses.some((s) => s === "confusing")) verdict = worseVerdict(verdict, "mostly_ok");
  for (const f of findings) verdict = worseVerdict(verdict, findingVerdict(f));
  return verdict;
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
    oneLiner: "Synthesis produced no lens.",
    whoFor: "",
    coreValue: "",
    businessModel: "",
    techSurface: "",
    criticalPaths: [],
    ifItBreaks: "",
  };
}
