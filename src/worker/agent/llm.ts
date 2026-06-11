// Single Anthropic client for the agent plane. The worker's "reception desk" is
// an LLM: what to check and how arrives as text (user notes, scope hints, the
// standing mission), not as hardcoded crawler logic.

import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// claude-opus-4-8 — most capable for long-horizon agentic browsing. Override
// per-env with ANTHROPIC_MODEL (e.g. claude-sonnet-4-6 to trade depth for cost).
export const AGENT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
