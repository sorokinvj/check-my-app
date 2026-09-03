// CHE-130 verification: the walking context keeps only the last N screenshots.
//
// Every screenshot used to stay in the conversation as an image block for the
// whole walk and was re-read on every iteration — a full joblander walk cost
// $2.31 with vision nav against $0.91 text-only (COSTS.md, runs #74 vs #67).
// The fix is a window: once a screenshot is older than the last N, its image
// block is replaced with a text placeholder, in place, so the prompt-cache
// prefix changes once per screenshot rather than once per iteration.
//
// Pure: no browser, no network, no model. Everything below exercises the two
// deterministic pieces — trimImageBlocks and the WALK_IMAGE_WINDOW parser —
// exactly as the walking loop calls them.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-image-window.ts

import type Anthropic from "@anthropic-ai/sdk";
import { runAgentLoop, trimImageBlocks } from "@/agent/core";
import { walkImageWindow } from "@/agent/env";
import type { LlmConfig } from "@/agent/llm";
import type { ToolEnv } from "@/agent/tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

function image(tag: string): Anthropic.ImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: tag } };
}

// A tool_result shaped exactly as runAgentLoop builds it for a screenshot:
// image first, then the tool's text (which carries the evidence URL).
function screenshotResult(n: number): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: `tu_${n}`,
    content: [image(`jpeg-${n}`), { type: "text", text: `Screenshot saved: https://ev/${n}.png` }],
  };
}

// Five screenshot results interleaved with plain text results and assistant
// turns — the shape of a real walk, not a list of images.
function conversation(): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [{ role: "user", content: "Walk the journey now." }];
  for (let n = 1; n <= 5; n++) {
    msgs.push({ role: "assistant", content: [{ type: "text", text: `step ${n}` }] });
    msgs.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `nav_${n}`, content: `navigated to /page-${n}` },
        screenshotResult(n),
      ],
    });
  }
  return msgs;
}

// Every image tag still present, in conversation order.
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

// Every text block's text, in conversation order (top-level and nested).
function textBlocks(msgs: Anthropic.MessageParam[]): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (typeof m.content === "string") {
      out.push(m.content);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") out.push(b.text);
      if (b.type === "tool_result") {
        if (typeof b.content === "string") out.push(b.content);
        else for (const c of b.content ?? []) if (c.type === "text") out.push(c.text);
      }
    }
  }
  return out;
}

const PLACEHOLDER = "[screenshot omitted — an earlier step; its evidence URL is in this result's text]";

// A scripted model: every turn asks for a screenshot, then the last turn ends
// the loop. Each screenshot lands in the conversation the way the real loop
// attaches it (image block first inside the tool_result), so this drives
// runAgentLoop itself, not just the trimming function.
function scriptedLlm(turns: number): LlmConfig {
  let call = 0;
  const create = async (): Promise<Anthropic.Message> => {
    call += 1;
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
        ? [{ type: "text", text: "Journey walked.", citations: null }]
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
// are swallowed) and asks for a PNG and a JPEG. No persistence callback, so
// nothing leaves the process.
function stubPage(): ToolEnv {
  return {
    page: {
      url: () => "https://target.test/",
      evaluate: async () => undefined,
      screenshot: async () => Buffer.from("not-really-an-image"),
    },
    targetOrigin: "https://target.test",
    visionScreenshots: true,
    networkLog: [],
    consoleLog: [],
    credentials: { rejected: false },
  } as unknown as ToolEnv;
}

async function main() {
  // 0 — through the loop itself: six screenshot turns with a window of 3 must
  // leave exactly the last three images in the returned conversation, and a
  // loop without a window must leave all six (discovery's behaviour, CHE-135).
  const walked = await runAgentLoop({
    system: "test",
    task: "walk",
    env: stubPage(),
    llm: scriptedLlm(6),
    thinking: "off",
    imageWindow: 3,
  });
  const walkedImages = imageTags(walked.messages);
  check("loop, window=3: six screenshots taken", walked.iterations === 7, String(walked.iterations));
  check("loop, window=3: three images remain in context", walkedImages.length === 3, String(walkedImages.length));
  check(
    "loop, window=3: three placeholders in context",
    textBlocks(walked.messages).filter((t) => t === PLACEHOLDER).length === 3,
  );
  const untrimmed = await runAgentLoop({
    system: "test",
    task: "walk",
    env: stubPage(),
    llm: scriptedLlm(6),
    thinking: "off",
  });
  check("loop, no window: all six images stay", imageTags(untrimmed.messages).length === 6, String(imageTags(untrimmed.messages).length));

  // 1 — window of 3 over 5 screenshots: the 2 oldest go, the 3 newest stay.
  const msgs = conversation();
  const before = textBlocks(msgs);
  const replaced = trimImageBlocks(msgs, 3);
  check("window=3 over 5: returns 2", replaced === 2, String(replaced));
  const left = imageTags(msgs);
  check(
    "window=3 over 5: the 3 newest survive, in order",
    left.join(",") === "jpeg-3,jpeg-4,jpeg-5",
    left.join(","),
  );
  const after = textBlocks(msgs);
  const placeholders = after.filter((t) => t === PLACEHOLDER);
  check("window=3 over 5: exactly 2 placeholders written", placeholders.length === 2, String(placeholders.length));
  check(
    "window=3 over 5: every pre-existing text block untouched",
    JSON.stringify(after.filter((t) => t !== PLACEHOLDER)) === JSON.stringify(before),
  );
  check(
    "placeholder sits where the image was (before the URL text)",
    (() => {
      const r = (msgs[2].content as Anthropic.ToolResultBlockParam[])[1];
      const c = r.content as Anthropic.TextBlockParam[];
      return c[0].type === "text" && c[0].text === PLACEHOLDER && c[1].text.startsWith("Screenshot saved:");
    })(),
  );

  // 2 — idempotent: a second pass finds nothing to do and changes nothing.
  const snapshot = JSON.stringify(msgs);
  const again = trimImageBlocks(msgs, 3);
  check("second pass returns 0", again === 0, String(again));
  check("second pass changes nothing", JSON.stringify(msgs) === snapshot);

  // 3 — as the window slides: one more screenshot arrives, exactly one more
  // falls out. This is what the walking loop does after every iteration.
  msgs.push({ role: "assistant", content: [{ type: "text", text: "step 6" }] });
  msgs.push({ role: "user", content: [screenshotResult(6)] });
  const slid = trimImageBlocks(msgs, 3);
  check("sliding: one new screenshot evicts exactly one", slid === 1, String(slid));
  check("sliding: window now holds 4,5,6", imageTags(msgs).join(",") === "jpeg-4,jpeg-5,jpeg-6", imageTags(msgs).join(","));

  // 4 — the edges: 0 keeps nothing, Infinity keeps everything.
  const all = conversation();
  check("keep=0 replaces all 5", trimImageBlocks(all, 0) === 5 && imageTags(all).length === 0);
  const none = conversation();
  check(
    "keep=Infinity replaces none",
    trimImageBlocks(none, Number.POSITIVE_INFINITY) === 0 && imageTags(none).length === 5,
  );
  const exact = conversation();
  check("keep=5 over 5 replaces none", trimImageBlocks(exact, 5) === 0 && imageTags(exact).length === 5);

  // 5 — top-level image blocks and nested tool_result images are one sequence.
  const mixed: Anthropic.MessageParam[] = [
    { role: "user", content: [image("top-1"), { type: "text", text: "look" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [screenshotResult(2)] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [image("top-3")] },
  ];
  const mixedReplaced = trimImageBlocks(mixed, 1);
  check("mixed: top-level and nested counted together", mixedReplaced === 2, String(mixedReplaced));
  check("mixed: the newest (top-level) survives", imageTags(mixed).join(",") === "top-3", imageTags(mixed).join(","));
  check(
    "mixed: top-level image became the placeholder text",
    (mixed[0].content as Anthropic.TextBlockParam[])[0].type === "text" &&
      (mixed[0].content as Anthropic.TextBlockParam[])[0].text === PLACEHOLDER,
  );
  check(
    "mixed: 'look' text block untouched",
    (mixed[0].content as Anthropic.TextBlockParam[])[1].text === "look",
  );

  // 6 — string-content messages and string tool_results are left alone.
  const plain: Anthropic.MessageParam[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "done" }] },
  ];
  const plainSnap = JSON.stringify(plain);
  check("no images: returns 0 and changes nothing", trimImageBlocks(plain, 0) === 0 && JSON.stringify(plain) === plainSnap);

  // 7 — WALK_IMAGE_WINDOW parsing. "off" is the only way to disable trimming;
  // a typo falls to the default rather than silently restoring the $2.31 walk.
  const parse = (v: string | undefined) => walkImageWindow({ WALK_IMAGE_WINDOW: v });
  check("env unset → 3", parse(undefined) === 3, String(parse(undefined)));
  check('env "" → 3', parse("") === 3, String(parse("")));
  check('env "off" → undefined (unlimited)', parse("off") === undefined, String(parse("off")));
  check('env "OFF" → undefined (unlimited)', parse("OFF") === undefined, String(parse("OFF")));
  check('env "5" → 5', parse("5") === 5, String(parse("5")));
  check('env "garbage" → 3', parse("garbage") === 3, String(parse("garbage")));
  check('env "-1" → 3', parse("-1") === 3, String(parse("-1")));
  check('env "0" → 3', parse("0") === 3, String(parse("0")));
  check('env "2.5" → 3', parse("2.5") === 3, String(parse("2.5")));

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
