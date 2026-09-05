// CHE-169 — the second opinion. One model call at the one moment that decides
// what a customer is told: a step the walking model reported broken, exposed
// or confusing, before it is written down.
//
// The walking model is cheap and walks on text; it has been wrong in a known
// direction — reading its own inability as the product's defect (CLAUDE.md
// rule 8: three of six JobLander tickets were ours). The judge sees the one
// step with everything the walk had — the request tail, the excerpts, the
// page as it looks — and answers a narrower question with the rules that were
// broken each time: defect, not a defect, or cannot tell. Its answer can only
// make the walk more careful: a "defect" writes the step exactly as reported;
// anything else softens it; a failed call changes nothing.
//
// No database, no browser launcher, no Workflow — a pure function of the step
// and the page, so the verify script drives the same code the walk runs.

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "@cloudflare/playwright";
import { NOT_DEFECT_FALLBACK, productProse, UNVERIFIABLE_FALLBACK } from "@/lib/verdict-language";
import { createWithRetry, LlmBudgetError } from "./core";
import { addUsage, isVisionModel, type LlmConfig, type UsageTotals } from "./llm";
import { captureJpeg, classifyUnverified, type ReportedStep } from "./tools";

export type JudgeVerdict = "defect" | "not_defect" | "unverifiable";

export interface JudgeAnswer {
  verdict: JudgeVerdict;
  // Product-facing, one or two sentences: what a user of the product meets.
  reason: string;
  userImpact: string;
}

// The statuses that put something negative in front of the customer.
export function needsJudge(status: ReportedStep["status"]): boolean {
  return status === "broken" || status === "exposed" || status === "confusing";
}

export const JUDGE_MAX_TOKENS = 1_500;

// How many request-log lines the judge sees.
export const JUDGE_NETWORK_TAIL = 20;

export const JUDGE_SYSTEM = `You are the second opinion on ONE step of an automated check of a web product.
A first reader walked the product and reported this step as a problem. Decide
whether the evidence supports that, using only the rules below.

Rules:
- "defect" requires POSITIVE evidence a real user would hit: an error response
  (4xx/5xx from the product's own endpoints), a console exception, a crash, a
  broken navigation, wrong or missing data, a security exposure. Something the
  page shows going wrong counts; something that merely did not happen does not.
- Silence is not evidence. A control that produced no reaction, a form that did
  not submit, a click that "did nothing" — none of that proves a defect. It is
  "unverifiable".
- HTTP 429 is caused by the checker's own request volume. It is never a
  defect. Poor recovery from it (controls left disabled, no message shown) is.
- "Start Audio" / "Start Video" / "Unmute" overlays in WebRTC or media apps
  unlock playback under the browser's autoplay policy; they are not failure.
  Signs of life — captions, a transcript growing, participant tiles, a running
  timer, an incoming message — mean the step worked: "not_defect".
- What the page SHOWS outranks what the first reader assumed. Read the
  screenshot when there is one.
- A refused or missing credential is not the product's fault: "unverifiable".
- Confusing is a defect only when a real user would plausibly hesitate or
  misread the product — not when the checker was confused by its own tooling.

Answer with JSON only: {"verdict": "defect" | "not_defect" | "unverifiable",
"reason": "...", "userImpact": "..."}.
"reason" and "userImpact" are read by the product's owner. Describe THEIR
product only: what a user meets, in one or two sentences. Never mention the
checker, the first reader, screenshots, request counts, tooling, or how the
check was performed. Never tell the owner to verify anything themselves.`;

export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason", "userImpact"],
  properties: {
    verdict: { type: "string", enum: ["defect", "not_defect", "unverifiable"] },
    reason: { type: "string" },
    userImpact: { type: "string" },
  },
};

const VERDICTS: JudgeVerdict[] = ["defect", "not_defect", "unverifiable"];

// The judge's reply as JSON, or the first balanced object in its text when the
// provider ignored the schema (the discovery.ts fallback, CHE-70 run #73).
export function parseJudgeAnswer(text: string): JudgeAnswer | null {
  const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], text.match(/\{[\s\S]*\}/)?.[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const raw = JSON.parse(candidate) as Partial<JudgeAnswer>;
      if (typeof raw.verdict === "string" && VERDICTS.includes(raw.verdict as JudgeVerdict)) {
        return {
          verdict: raw.verdict as JudgeVerdict,
          reason: typeof raw.reason === "string" ? raw.reason : "",
          userImpact: typeof raw.userImpact === "string" ? raw.userImpact : "",
        };
      }
    } catch {
      // next candidate
    }
  }
  return null;
}

// The judge is told to describe the product only; the mechanism behind the
// instruction (AGENTS.md) is productProse in verdict-language.ts — the word
// list lived here until CHE-180 made report_step need the same one.

// Apply the judge's answer to the step. Pure. "defect" → the step as reported.
// "not_defect" → ok, with the judge's product-facing reason as what was
// observed. "unverifiable" → skipped, with an unverifiedReason by the
// classifyUnverified rules and our_capability as the default (CLAUDE.md rule
// 2: a step we could not verify is a ticket on our board, never a caveat).
export function applyJudgeAnswer(step: ReportedStep, answer: JudgeAnswer): ReportedStep {
  if (answer.verdict === "defect") return step;
  const prose = productProse([answer.reason, answer.userImpact].filter(Boolean).join(" "));
  if (answer.verdict === "not_defect") {
    return { ...step, status: "ok", observed: prose ?? NOT_DEFECT_FALLBACK, unverifiedReason: undefined };
  }
  const skipped: ReportedStep = {
    ...step,
    status: "skipped",
    observed: prose ?? UNVERIFIABLE_FALLBACK,
    unverifiedReason: undefined,
  };
  classifyUnverified(skipped);
  // classifyUnverified has no positive pattern for not_applicable — it is its
  // fallback, and here the fallback is ours.
  if (skipped.unverifiedReason === "not_applicable") skipped.unverifiedReason = "our_capability";
  return skipped;
}

export interface AdjudicateArgs {
  llm: LlmConfig;
  enabled: boolean;
  step: ReportedStep;
  // The page as it is at report time; the judge is shown it when the judge
  // model can see. Absent (or a failed capture) → text only.
  page?: Pick<Page, "screenshot" | "evaluate"> | null;
  // The rolling request log; the judge gets its tail, scrubbed.
  networkLog: string[];
  scrub: (text: string) => string;
  // The judge's tokens/cost accumulate here — its own LlmUsage phase.
  usage: UsageTotals;
}

// The step as it should be written. Never throws for a judge problem: a
// timeout, a provider error, an unparseable reply all log a warning and
// return the step exactly as the walking model reported it. The one exception
// is our own budget dying (LlmBudgetError, CLAUDE.md rule 4): that propagates,
// because a run that publishes nothing is more careful than one that goes on
// without the second opinion the owner configured.
export async function adjudicateStep(args: AdjudicateArgs): Promise<ReportedStep> {
  const { llm, enabled, step, page, networkLog, scrub, usage } = args;
  if (!enabled || !needsJudge(step.status)) return step;
  const client = llm.judgeClient ?? llm.navClient;
  const model = llm.judgeModel ?? llm.navModel;

  let jpeg: string | null = null;
  if (page && isVisionModel(model)) {
    jpeg = await captureJpeg(page).catch((err) => {
      console.warn(`[judge] screenshot capture failed: ${err instanceof Error ? err.message : err}`);
      return null;
    });
  }

  const tail = networkLog.slice(-JUDGE_NETWORK_TAIL).map(scrub);
  const brief = [
    `Step: ${step.label}`,
    `Reported status: ${step.status}`,
    `Attempted: ${step.attempted}`,
    `Observed: ${step.observed}`,
    step.consoleExcerpt ? `Console excerpt:\n${step.consoleExcerpt}` : null,
    step.networkExcerpt ? `Network excerpt:\n${step.networkExcerpt}` : null,
    `Last ${tail.length} requests:\n${tail.length ? tail.join("\n") : "(none)"}`,
  ]
    .filter((line): line is string => line !== null)
    .map(scrub)
    .join("\n\n");

  const content: Anthropic.ContentBlockParam[] = jpeg
    ? [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg } },
        { type: "text", text: brief },
      ]
    : [{ type: "text", text: brief }];

  let answer: JudgeAnswer | null = null;
  try {
    // Two attempts, not five: a judge that stalls a walk for minutes on a
    // sustained overload costs more than the opinion is worth. The 45s
    // timeout is per attempt (SDK timeouts are in milliseconds).
    const response = await createWithRetry(
      () =>
        client.messages.create(
          {
            model,
            max_tokens: JUDGE_MAX_TOKENS,
            thinking: { type: "adaptive" },
            output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA } },
            system: JUDGE_SYSTEM,
            messages: [{ role: "user", content }],
          },
          { timeout: 45_000 },
        ),
      2,
    );
    addUsage(usage, model, response.usage);
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    answer = parseJudgeAnswer(text);
    if (!answer) console.warn(`[judge] unparseable reply for "${step.label}": ${text.slice(0, 200)}`);
  } catch (err) {
    if (err instanceof LlmBudgetError) throw err;
    console.warn(`[judge] call failed for "${step.label}": ${err instanceof Error ? err.message : err}`);
  }
  if (!answer) return step;

  const written = applyJudgeAnswer(step, answer);
  console.log(
    `[judge] "${step.label}": ${step.status} → ${answer.verdict}` +
      (written.status !== step.status ? ` (written as ${written.status})` : ""),
  );
  return written;
}
