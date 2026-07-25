// CHE-7 — the agent core. A manual tool-use loop (not the SDK tool runner)
// because the harness needs per-iteration hooks: evidence capture, live-state
// updates, transcript audit, and budget enforcement.
//
// The core is a pure function of (instructions, tools, budget) → final text +
// transcript. No BullMQ, no Prisma — portable to Cloudflare Workflows as-is.

import Anthropic from "@anthropic-ai/sdk";
import { addUsage, costOf, emptyUsage, type LlmConfig, type UsageTotals } from "./llm";
import { BROWSER_TOOLS, executeTool, type ToolEnv } from "./tools";

export interface AgentLoopArgs {
  system: string;
  task: string;
  env: ToolEnv;
  llm: LlmConfig;
  maxIterations?: number;
  // Called after each iteration with a short progress note (for the live feed).
  onProgress?: (note: string) => Promise<void>;
}

export interface AgentLoopResult {
  finalText: string;
  iterations: number;
  // Audit artifact: every tool call + (truncated) result, in order.
  transcript: TranscriptEntry[];
  // Full conversation, for a follow-up finalize call if finalText didn't parse.
  messages: Anthropic.MessageParam[];
  // Rolled-up Anthropic cost of this loop (USD) — feeds Run.costUsd (CHE-16).
  costUsd: number;
  // Full token/cost breakdown of the loop — feeds the LlmUsage ledger.
  usage: UsageTotals;
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
  const { system, task, env, llm, maxIterations = 40, onProgress } = args;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const transcript: TranscriptEntry[] = [];
  let iterations = 0;
  let finalText = "";
  let costUsd = 0;
  const usage = emptyUsage();

  while (iterations < maxIterations) {
    iterations += 1;

    // Prompt caching: breakpoint on the system block caches tools+system
    // (stable for the whole loop); the top-level marker auto-caches the last
    // block of the growing conversation, so each iteration re-reads the prior
    // transcript at ~0.1x instead of reprocessing it.
    // Retried on transient API errors so a 20-min run isn't lost to one 529 —
    // the messages array is intact, so resume is just re-issuing the call.
    const response = await createWithRetry(() =>
      llm.client.messages.create({
        // 16k keeps non-streaming under the SDK timeout while leaving room for
        // adaptive thinking + a long final JSON (discovery/synthesis emit the
        // whole app map at once — 8k truncated it and silently lost journeys).
        model: llm.navModel,
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: BROWSER_TOOLS,
        messages,
      }),
    );

    const u = response.usage;
    costUsd += costOf(llm.navModel, u);
    addUsage(usage, llm.navModel, u);
    console.log(
      `[agent] iter ${iterations}: stop=${response.stop_reason} in=${u.input_tokens} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`,
    );
    if (response.stop_reason === "max_tokens") {
      console.warn(`[agent] iter ${iterations} hit max_tokens — output may be truncated`);
    }

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

  return { finalText, iterations, transcript, messages, costUsd, usage };
}

// Append a closing instruction to a conversation in a role-valid way. The agent
// loop exits with the last turn being a `user` tool_result message; appending a
// second `user` message there breaks role alternation (400). Merge the
// instruction into that trailing user turn instead.
function appendInstruction(
  messages: Anthropic.MessageParam[],
  instruction: string,
): Anthropic.MessageParam[] {
  const convo = [...messages];
  const last = convo[convo.length - 1];
  if (last && last.role === "user") {
    const block: Anthropic.TextBlockParam = { type: "text", text: instruction };
    const content: Anthropic.ContentBlockParam[] = Array.isArray(last.content)
      ? [...last.content, block]
      : [{ type: "text", text: String(last.content) }, block];
    convo[convo.length - 1] = { role: "user", content };
  } else {
    convo.push({ role: "user", content: instruction });
  }
  return convo;
}

// One extra non-tool call to coax clean JSON out of a conversation whose final
// turn didn't parse (truncation, trailing prose). Cheap recovery for the
// discovery/synthesis hand-off — the messages already carry all the context.
export async function finalizeJson(
  llm: LlmConfig,
  messages: Anthropic.MessageParam[],
  instruction: string,
  // When provided, this call's tokens/cost are added to the caller's totals —
  // finalizeJson used to be a blind spot in the cost ledger.
  usage?: UsageTotals,
): Promise<string> {
  const response = await createWithRetry(() =>
    llm.client.messages.create({
      model: llm.navModel,
      max_tokens: 16_000,
      messages: appendInstruction(messages, instruction),
    }),
  );
  if (usage) addUsage(usage, llm.navModel, response.usage);
  const text = response.content.find((b) => b.type === "text");
  return text && text.type === "text" ? text.text : "";
}

// Reliable structured extraction: structured outputs force the model to emit
// schema-valid JSON regardless of how the exploration ended, so we never depend
// on the model remembering to emit JSON before its iteration budget runs out
// (the dominant cause of "No journeys mapped"). Thinking is omitted — this is a
// pure extraction over context the model already gathered.
export async function finalizeStructured<T>(
  llm: LlmConfig,
  messages: Anthropic.MessageParam[],
  instruction: string,
  schema: Record<string, unknown>,
): Promise<{ parsed: T | null; costUsd: number; usage: UsageTotals }> {
  const response = await createWithRetry(() =>
    llm.client.messages.create({
      model: llm.navModel,
      max_tokens: 16_000,
      output_config: { format: { type: "json_schema", schema } },
      messages: appendInstruction(messages, instruction),
    }),
  );
  const costUsd = costOf(llm.navModel, response.usage);
  const usage = emptyUsage();
  addUsage(usage, llm.navModel, response.usage);
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") return { parsed: null, costUsd, usage };
  try {
    return { parsed: JSON.parse(text.text) as T, costUsd, usage };
  } catch {
    const m = text.text.match(/\{[\s\S]*\}/);
    if (!m) return { parsed: null, costUsd, usage };
    try {
      return { parsed: JSON.parse(m[0]) as T, costUsd, usage };
    } catch {
      return { parsed: null, costUsd, usage };
    }
  }
}

// Resilient create: the SDK already retries twice, but a sustained overload
// mid-run would still throw and lose the whole journey. Retry transient errors
// (429/500/529) up to 5 times with capped exponential backoff, honoring
// retry-after when present. Non-transient errors (400/401) rethrow immediately.
async function createWithRetry(
  fn: () => Promise<Anthropic.Message>,
  attempts = 5,
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const transient = status === 429 || status === 529 || (status ?? 0) >= 500;
      if (!transient || attempt === attempts - 1) throw err;
      const retryAfter = headerSeconds(err);
      const backoff = retryAfter ?? Math.min(2 ** attempt * 2_000, 30_000);
      console.warn(`[agent] transient API error (${status}); retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function headerSeconds(err: unknown): number | null {
  if (err instanceof Anthropic.APIError) {
    const h = err.headers?.get?.("retry-after");
    const n = h ? Number(h) : NaN;
    if (Number.isFinite(n)) return n * 1_000;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
