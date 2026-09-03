// CHE-135 verification: discovery runs lean — thinking off, no screenshots in
// the model's context — behind DISCOVERY_LEAN.
//
// Discovery is exploration, not reasoning-critical, and its output is validated
// by the structured extraction whatever the exploration looked like. It still
// ran with adaptive thinking on every call and a JPEG of every screenshot in
// context, the way walking did before E3 (CHE-58) and CHE-130. E5 in COSTS.md
// queued this experiment; the A/B result is read off `npm run cost:trend` on
// the next full watch runs, not here.
//
// Pure: no browser, no network, no model, no database. Everything below
// exercises the deterministic pieces — the DISCOVERY_LEAN parser, both
// branches of discoveryLoopMode, and runAgentLoop driven by a scripted model
// with the lean mode's ToolEnv and loop options — exactly as discoverApp wires
// them.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-discovery-lean.ts

import type Anthropic from "@anthropic-ai/sdk";
import { runAgentLoop } from "@/agent/core";
import { discoveryLoopMode } from "@/agent/discovery-mode";
import { discoveryLeanEnabled } from "@/agent/env";
import type { LlmConfig } from "@/agent/llm";
import type { ToolEnv } from "@/agent/tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// Every image block's payload still present, in conversation order (top-level
// and nested inside tool_result content).
function imageTags(msgs: Anthropic.MessageParam[]): string[] {
  const tags: string[] = [];
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "image" && b.source.type === "base64") tags.push(b.source.data);
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        for (const c of b.content) {
          if (c.type === "image" && c.source.type === "base64") tags.push(c.source.data);
        }
      }
    }
  }
  return tags;
}

// A scripted model: every turn asks for a screenshot, then the last turn ends
// the loop. It also records how many image blocks the conversation carried at
// the moment of EACH call — that is what the provider would bill and what a
// text-only nav model would reject, so it is the number that matters, not the
// state of the messages after the loop returns.
function scriptedLlm(turns: number, imagesSeen: number[]): LlmConfig {
  let call = 0;
  const create = async (params: Anthropic.MessageCreateParams): Promise<Anthropic.Message> => {
    call += 1;
    imagesSeen.push(imageTags(params.messages).length);
    const done = call > turns;
    return {
      id: `msg_${call}`,
      type: "message",
      role: "assistant",
      model: "scripted",
      stop_reason: done ? "end_turn" : "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content: done
        ? [{ type: "text", text: "Explored.", citations: null }]
        : [{ type: "tool_use", id: `tu_${call}`, name: "screenshot", input: {} }],
    } as Anthropic.Message;
  };
  const client = { messages: { create } } as unknown as Anthropic;
  return {
    navClient: client,
    synthClient: client,
    structClient: client,
    navModel: "scripted",
    synthModel: "scripted",
    structModel: "scripted",
  };
}

// Enough of a page for the screenshot tool: it blurs password fields (errors
// are swallowed) and asks for a PNG, and for a JPEG when visionScreenshots is
// on. No persistence callback, so nothing leaves the process.
function stubPage(visionScreenshots: boolean): ToolEnv {
  return {
    page: {
      url: () => "https://target.test/",
      evaluate: async () => undefined,
      screenshot: async () => Buffer.from("not-really-an-image"),
    },
    targetOrigin: "https://target.test",
    visionScreenshots,
    networkLog: [],
    consoleLog: [],
    credentials: { rejected: false },
  } as unknown as ToolEnv;
}

async function main() {
  // 1 — DISCOVERY_LEAN parsing. "off" is the only way back to the heavier
  // discovery; a typo must not silently restore thinking and screenshots.
  const parse = (v: string | undefined) => discoveryLeanEnabled({ DISCOVERY_LEAN: v });
  check("env unset → lean", parse(undefined) === true);
  check('env "" → lean', parse("") === true);
  check('env "on" → lean', parse("on") === true);
  check('env "garbage" → lean', parse("garbage") === true);
  check('env "off" → not lean', parse("off") === false);
  check('env " OFF " → not lean', parse(" OFF ") === false);

  // 2 — the mode, both branches, exactly.
  const lean = discoveryLoopMode(true, true);
  check(
    "lean, vision nav: thinking off, no screenshots, window 0",
    JSON.stringify(lean) === JSON.stringify({ thinking: "off", visionScreenshots: false, imageWindow: 0 }),
    JSON.stringify(lean),
  );
  const leanText = discoveryLoopMode(true, false);
  check(
    "lean, text nav: identical",
    JSON.stringify(leanText) === JSON.stringify(lean),
    JSON.stringify(leanText),
  );
  const fullVision = discoveryLoopMode(false, true);
  check(
    "not lean, vision nav: adaptive, screenshots on, no window",
    fullVision.thinking === "adaptive" &&
      fullVision.visionScreenshots === true &&
      fullVision.imageWindow === undefined,
    JSON.stringify(fullVision),
  );
  const fullText = discoveryLoopMode(false, false);
  check(
    "not lean, text nav: adaptive, screenshots off, no window",
    fullText.thinking === "adaptive" &&
      fullText.visionScreenshots === false &&
      fullText.imageWindow === undefined,
    JSON.stringify(fullText),
  );

  // 3 — through the loop with the lean ToolEnv: the screenshot tool must park
  // no JPEG, so no image block ever enters the conversation — at any call, or
  // after the loop.
  const seenLean: number[] = [];
  const leanRun = await runAgentLoop({
    system: "test",
    task: "explore",
    env: stubPage(lean.visionScreenshots),
    llm: scriptedLlm(4, seenLean),
    thinking: lean.thinking,
    imageWindow: lean.imageWindow,
  });
  check("lean loop: four screenshots taken", leanRun.iterations === 5, String(leanRun.iterations));
  check(
    "lean loop: no image block at any call",
    seenLean.length === 5 && seenLean.every((n) => n === 0),
    seenLean.join(","),
  );
  check(
    "lean loop: no image block in the returned conversation",
    imageTags(leanRun.messages).length === 0,
    String(imageTags(leanRun.messages).length),
  );

  // 4 — belt and braces: force the JPEG to be parked (visionScreenshots on,
  // as if a tool bypassed the mode) and keep only imageWindow: 0. The image
  // lands in the tool_result and must be replaced before the next call.
  const seenForced: number[] = [];
  const forcedRun = await runAgentLoop({
    system: "test",
    task: "explore",
    env: stubPage(true),
    llm: scriptedLlm(4, seenForced),
    thinking: lean.thinking,
    imageWindow: lean.imageWindow,
  });
  check(
    "window 0, JPEG forced: no image block reaches any call",
    seenForced.length === 5 && seenForced.every((n) => n === 0),
    seenForced.join(","),
  );
  check(
    "window 0, JPEG forced: none left after the loop",
    imageTags(forcedRun.messages).length === 0,
    String(imageTags(forcedRun.messages).length),
  );

  // 5 — the control: the not-lean mode with a vision nav model keeps every
  // screenshot in context, today's discovery byte for byte.
  const seenFull: number[] = [];
  const fullRun = await runAgentLoop({
    system: "test",
    task: "explore",
    env: stubPage(fullVision.visionScreenshots),
    llm: scriptedLlm(4, seenFull),
    thinking: fullVision.thinking,
    imageWindow: fullVision.imageWindow,
  });
  check(
    "not lean: every screenshot stays in context (0,1,2,3,4 at successive calls)",
    seenFull.join(",") === "0,1,2,3,4",
    seenFull.join(","),
  );
  check(
    "not lean: four images in the returned conversation",
    imageTags(fullRun.messages).length === 4,
    String(imageTags(fullRun.messages).length),
  );

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
