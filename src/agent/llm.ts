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
// OpenRouter only the GLM vision variants (glm-5v-*, glm-4.6v, glm-4.5v) do —
// sending an image to a text-only model errors the request.
export function isVisionModel(model: string): boolean {
  return model.startsWith("claude") || /glm-5v|glm-4\.[56]v/.test(model);
}

export function makeLlm(env: AgentBindings): LlmConfig {
  const navModel = env.ANTHROPIC_NAV_MODEL ?? "claude-sonnet-4-6";
  const synthModel = env.ANTHROPIC_SYNTH_MODEL ?? "claude-opus-4-8";
  return {
    navClient: clientFor(navModel, env),
    synthClient: clientFor(synthModel, env),
    navModel,
    synthModel,
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
