// Anthropic client + model tiering for the agent (CHE-16).
//
// Navigation (the long tool-use loop) runs on Sonnet 4.6 — the bulk of the
// tokens, where Opus is overkill; synthesis (App Lens + findings, one shot)
// runs on Opus 4.8 for quality. M1 measured ~$2.5/run on Opus-everywhere; the
// CHE-20 spike projected ~$0.73/run with Sonnet navigation. Models are
// overridable per-env. Cost is tracked per call and rolled up into Run.costUsd.

import Anthropic from "@anthropic-ai/sdk";
import type { AgentBindings } from "./env";

export interface LlmConfig {
  client: Anthropic;
  navModel: string;
  synthModel: string;
}

export function makeLlm(env: AgentBindings): LlmConfig {
  return {
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
    navModel: env.ANTHROPIC_NAV_MODEL ?? "claude-sonnet-4-6",
    synthModel: env.ANTHROPIC_SYNTH_MODEL ?? "claude-opus-4-8",
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
}

export function costOf(model: string, u: Usage): number {
  const [inP, outP] = PRICING[model] ?? PRICING["claude-sonnet-4-6"];
  return (
    (u.input_tokens * inP +
      (u.cache_creation_input_tokens ?? 0) * inP * 1.25 +
      (u.cache_read_input_tokens ?? 0) * inP * 0.1 +
      u.output_tokens * outP) /
    1e6
  );
}
