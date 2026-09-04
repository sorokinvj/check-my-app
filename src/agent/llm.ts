// LLM clients + model tiering for the agent (CHE-16, cheap-model epic).
//
// Navigation (the long tool-use loop) and synthesis (one shot) are separately
// tiered. Model routing by id: an id containing "/" (e.g. "z-ai/glm-5.2",
// "moonshotai/kimi-k3") goes through OpenRouter's Anthropic-compatible
// /v1/messages endpoint (spike-verified: tool_use, thinking, cache_control all
// work) — the agent loop code is provider-agnostic. Plain "claude-*" ids hit
// Anthropic directly. Cost per call: OpenRouter returns the exact billed cost
// in usage; Anthropic is priced from the table below.

import Anthropic from "@anthropic-ai/sdk";
import type { AgentBindings } from "./env";

export interface LlmConfig {
  navClient: Anthropic;
  synthClient: Anthropic;
  navModel: string;
  synthModel: string;
  // Structured extraction (finalizeStructured). The GLM vision variants ignore
  // output_config json_schema (run #73: discovery extraction came back as
  // prose), so structured calls route to the text sibling instead.
  structClient: Anthropic;
  structModel: string;
  // CHE-168: whether the nav model is sent screenshots. Decided once in makeLlm
  // — the ANTHROPIC_NAV_VISION override, else the isVisionModel heuristic — so
  // a spike can flip a candidate between vision and text with a secret change
  // instead of a deploy. Every reader of "does nav see images" uses this field.
  navVision: boolean;
  // CHE-169: the second opinion. The judge sees one step — its evidence, the
  // request tail, a screenshot — and answers defect / not defect / cannot
  // tell, so the expensive model is paid for at the moment of judgment and
  // nowhere else. Unset → the nav model itself, on the nav client: a second
  // look from the same model with a focused prompt, no new provider. Optional
  // in the type so every LlmConfig built before this field existed still
  // type-checks; makeLlm always fills both.
  judgeClient?: Anthropic;
  judgeModel?: string;
}

function clientFor(model: string, env: AgentBindings): Anthropic {
  if (model.includes("/")) {
    if (!env.OPENROUTER_API_KEY) {
      throw new Error(`Model ${model} needs OPENROUTER_API_KEY (not set on this worker)`);
    }
    return new Anthropic({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api",
    });
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

// Which models can accept image blocks (CHE-70). Claude models all can; on
// OpenRouter the GLM vision variants (glm-5v-*, glm-4.6v, glm-4.5v) and the
// DeepSeek V4 Flash vision variant (deepseek-v4-flash-vision*, CHE-168) do —
// sending an image to a text-only model errors the request.
export function isVisionModel(model: string): boolean {
  return model.startsWith("claude") || /glm-5v|glm-4\.[56]v|deepseek-v4-flash-vision/.test(model);
}

// CHE-168: the nav vision decision. "on"/"off" override the heuristic in either
// direction — a spike can run a vision-capable candidate text-only to price the
// two modes against each other, or force images onto a model the heuristic does
// not know yet. Anything else (unset, a typo) falls to the heuristic, so a
// misspelt secret cannot silently send images to a text-only model.
export function navVisionFor(navModel: string, override: string | undefined): boolean {
  const raw = override?.trim().toLowerCase();
  if (raw === "on") return true;
  if (raw === "off") return false;
  return isVisionModel(navModel);
}

// Structured extraction routing (finalizeStructured). The GLM vision variants
// ignore output_config json_schema (run #73), so a vision nav model routes
// structured calls to its text sibling; the DeepSeek vision variant is routed
// the same way on the same assumption until a run shows otherwise (CHE-168).
// ANTHROPIC_STRUCT_MODEL names the sibling explicitly and wins when set.
export function structModelFor(navModel: string, override: string | undefined): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  if (/glm-5v|glm-4\.[56]v/.test(navModel)) return "z-ai/glm-5.2";
  if (/deepseek-v4-flash-vision/.test(navModel)) return "deepseek/deepseek-v4-flash";
  return navModel;
}

// The GLM vision variants ignore output_config json_schema (run #73). Any call
// that needs schema-valid JSON must not be routed to one of them.
export function ignoresJsonSchema(model: string): boolean {
  return /glm-5v|glm-4\.[56]v/.test(model);
}

export function makeLlm(env: AgentBindings): LlmConfig {
  const navModel = env.ANTHROPIC_NAV_MODEL ?? "claude-sonnet-4-6";
  const synthModel = env.ANTHROPIC_SYNTH_MODEL ?? "claude-opus-4-8";
  const structModel = structModelFor(navModel, env.ANTHROPIC_STRUCT_MODEL);
  const navClient = clientFor(navModel, env);
  // CHE-169: the judge defaults to the nav model on the nav client, so with
  // ANTHROPIC_JUDGE_MODEL unset no second provider or key is involved.
  const judgeModel = env.ANTHROPIC_JUDGE_MODEL?.trim() || navModel;
  return {
    navClient,
    synthClient: clientFor(synthModel, env),
    navModel,
    synthModel,
    structClient: clientFor(structModel, env),
    structModel,
    navVision: navVisionFor(navModel, env.ANTHROPIC_NAV_VISION),
    judgeClient: judgeModel === navModel ? navClient : clientFor(judgeModel, env),
    judgeModel,
  };
}

// Per-1M-token prices (USD): [input, output]. cache write ×1.25, read ×0.1.
const PRICING: Record<string, [number, number]> = {
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  // OpenRouter reports the exact billed USD in the response — always prefer it.
  cost?: number | null;
}

// Accumulated tokens+cost for one unit of work (a loop, a phase). Feeds the
// LlmUsage ledger — tokens-model-money is the primary product metric.
export interface UsageTotals {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  iterations: number;
  costUsd: number;
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    iterations: 0,
    costUsd: 0,
  };
}

export function addUsage(t: UsageTotals, model: string, u: Usage): void {
  t.inputTokens += u.input_tokens;
  t.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
  t.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  t.outputTokens += u.output_tokens;
  t.iterations += 1;
  t.costUsd += costOf(model, u);
}

export function mergeUsage(into: UsageTotals, from: UsageTotals): void {
  into.inputTokens += from.inputTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.outputTokens += from.outputTokens;
  into.iterations += from.iterations;
  into.costUsd += from.costUsd;
}

export function costOf(model: string, u: Usage): number {
  if (typeof u.cost === "number") return u.cost;
  const [inP, outP] = PRICING[model] ?? PRICING["claude-sonnet-4-6"];
  return (
    (u.input_tokens * inP +
      (u.cache_creation_input_tokens ?? 0) * inP * 1.25 +
      (u.cache_read_input_tokens ?? 0) * inP * 0.1 +
      u.output_tokens * outP) /
    1e6
  );
}
