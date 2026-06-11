// CHE-7 — the agent core. A manual tool-use loop (not the SDK tool runner)
// because the harness needs per-iteration hooks: evidence capture, live-state
// updates, transcript audit, and budget enforcement.
//
// The core is a pure function of (instructions, tools, budget) → final text +
// transcript. No BullMQ, no Prisma — portable to Cloudflare Workflows as-is.

import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, AGENT_MODEL } from "./llm";
import { BROWSER_TOOLS, executeTool, type ToolEnv } from "./tools";

export interface AgentLoopArgs {
  system: string;
  task: string;
  env: ToolEnv;
  maxIterations?: number;
  // Called after each iteration with a short progress note (for the live feed).
  onProgress?: (note: string) => Promise<void>;
}

export interface AgentLoopResult {
  finalText: string;
  iterations: number;
  // Audit artifact: every tool call + (truncated) result, in order.
  transcript: TranscriptEntry[];
}

export interface TranscriptEntry {
  at: string;
  kind: "tool_call" | "tool_result" | "text";
  name?: string;
  // Inputs are recorded as the model sent them — credential placeholders
  // ({{TEST_PASSWORD}}) stay placeholders, so transcripts are secret-free.
  detail: string;
}

const MAX_TOOL_RESULT_CHARS = 6_000;

export async function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
  const { system, task, env, maxIterations = 40, onProgress } = args;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const transcript: TranscriptEntry[] = [];
  let iterations = 0;
  let finalText = "";

  while (iterations < maxIterations) {
    iterations += 1;

    // Prompt caching: breakpoint on the system block caches tools+system
    // (stable for the whole loop); the top-level marker auto-caches the last
    // block of the growing conversation, so each iteration re-reads the prior
    // transcript at ~0.1x instead of reprocessing it.
    const response = await anthropic.messages.create({
      model: AGENT_MODEL,
      max_tokens: 8_000,
      thinking: { type: "adaptive" },
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: BROWSER_TOOLS,
      messages,
    });

    const u = response.usage;
    console.log(
      `[agent] iter ${iterations}: in=${u.input_tokens} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`,
    );

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        finalText = block.text;
        transcript.push({ at: now(), kind: "text", detail: block.text.slice(0, 2_000) });
      }
    }

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      const input = tool.input as Record<string, unknown>;
      transcript.push({
        at: now(),
        kind: "tool_call",
        name: tool.name,
        detail: JSON.stringify(redactForAudit(tool.name, input)).slice(0, 1_500),
      });

      const result = await executeTool(env, tool.name, input);
      transcript.push({
        at: now(),
        kind: "tool_result",
        name: tool.name,
        detail: result.slice(0, 800),
      });

      results.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content: result.slice(0, MAX_TOOL_RESULT_CHARS),
      });

      if (tool.name === "report_step" && onProgress) {
        await onProgress(`${input.status}: ${input.label}`);
      }
    }

    messages.push({ role: "user", content: results });
  }

  return { finalText, iterations, transcript };
}

function now(): string {
  return new Date().toISOString();
}

// Transcripts are audit artifacts — keep them free of anything that even looks
// like a secret. fill values containing placeholders are already safe; raw fill
// values are masked anyway, defence in depth.
function redactForAudit(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== "fill") return input;
  const value = String(input.value ?? "");
  const isPlaceholder = /\{\{TEST_(EMAIL|PASSWORD)\}\}/.test(value);
  return { ...input, value: isPlaceholder ? value : "[masked]" };
}
