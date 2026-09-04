// CHE-134 verification: a walk wraps up after the spec is written, its
// iteration cap is sized to the journey, and focus-area journeys walk first.
//
// Walking is 69% of run cost at 25–40 model calls per journey (COSTS.md,
// CHE-58 / CHE-131). Two mechanical wastes: the model kept exploring or
// re-reading pages after write_e2e_test until the cap, and the cap was a flat
// 50 whatever the journey's size. A third, cheaper lever: when the owner named
// priority concerns, the journeys that cover them walk first, so a budget cut
// never lands on them.
//
// Pure: no browser, no network, no model. A scripted model drives runAgentLoop
// itself against a stub page, exactly as the walking loop calls it; the two
// limit functions are exercised directly.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-walk-limits.ts

import type Anthropic from "@anthropic-ai/sdk";
import { runAgentLoop } from "@/agent/core";
import type { ProposedJourney } from "@/agent/discovery";
import {
  WALK_ITERATIONS_MAX,
  WALK_ITERATIONS_MIN,
  WALK_WRAP_UP_ITERATIONS,
  focusKeywords,
  orderByFocus,
  walkingIterationCap,
} from "@/agent/limits";
import type { LlmConfig } from "@/agent/llm";
import type { ToolEnv } from "@/agent/tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const NOTE =
  "The journey is recorded. Wrap up now: if you created anything, delete it and call " +
  "record_deleted; then reply with the 1-2 sentence summary and make no further tool calls.";

// A scripted model that never finishes on its own: it reads the page every
// turn, writes the spec on turn 4, asks for cleanup on turn 5, and then goes
// back to reading the page forever — the exact shape of the waste CHE-134
// removes. `seen` records what each call received as the previous tool result,
// so the test can look at the note exactly as the model would.
function scriptedLlm(opts: { writeOn: number; deleteOn: number }) {
  let call = 0;
  const seen: Anthropic.MessageParam[][] = [];
  const create = async (params: { messages: Anthropic.MessageParam[] }): Promise<Anthropic.Message> => {
    call += 1;
    seen.push(params.messages.map((m) => ({ ...m })));
    const tool =
      call === opts.writeOn
        ? { name: "write_e2e_test", input: { title: "Journey", content: "import { test } from '@playwright/test';" } }
        : call === opts.deleteOn
          ? { name: "record_deleted", input: { marker: "CheckMyApp test r1", ok: true } }
          : { name: "read_page", input: {} };
    return {
      id: `msg_${call}`,
      type: "message",
      role: "assistant",
      model: "scripted",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content: [{ type: "tool_use", id: `tu_${call}`, name: tool.name, input: tool.input }],
    } as Anthropic.Message;
  };
  const client = { messages: { create } } as unknown as Anthropic;
  const llm: LlmConfig = {
    navClient: client,
    synthClient: client,
    structClient: client,
    navModel: "scripted",
    synthModel: "scripted",
    structModel: "scripted",
    navVision: false,
  };
  return { llm, seen, calls: () => call };
}

// Enough of a page for read_page (one evaluate returning a digest) plus the
// two ledger callbacks the wrap-up turns must still be able to reach.
function stubEnv() {
  const deleted: Array<{ marker: string; ok: boolean }> = [];
  const written: string[] = [];
  const env = {
    page: {
      url: () => "https://target.test/",
      evaluate: async () => ({
        url: "https://target.test/",
        title: "Target",
        headings: ["h1: Target"],
        links: [],
        buttons: [],
        fields: [],
      }),
    },
    targetOrigin: "https://target.test",
    visionScreenshots: false,
    networkLog: [],
    consoleLog: [],
    credentials: { rejected: false },
    onResourceDeleted: async (r: { marker: string; ok: boolean }) => {
      deleted.push({ marker: r.marker, ok: r.ok });
    },
    onWriteTest: async (t: { title: string }) => {
      written.push(t.title);
    },
  } as unknown as ToolEnv;
  return { env, deleted, written };
}

// The tool_result text the model received for a given tool_use id, wherever it
// sits in the conversation (string content or a content array).
function resultTextFor(messages: Anthropic.MessageParam[], toolUseId: string): string | null {
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || b.tool_use_id !== toolUseId) continue;
      if (typeof b.content === "string") return b.content;
      return (b.content ?? [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
    }
  }
  return null;
}

const journeys: ProposedJourney[] = [
  { title: "Sign in", steps: ["Open /login", "Fill the credentials", "Submit"] },
  { title: "Browse tutorial videos", steps: ["Open /learn", "Play the first YouTube embed"] },
  { title: "Edit profile", steps: ["Open /settings", "Change the display name", "Save"] },
  { title: "Buy a plan", steps: ["Open /pricing", "Pick Pro", "Proceed to checkout"] },
  { title: "Sign out", steps: ["Open the account menu", "Click Sign out"] },
];

async function main() {
  // (a) — with wrapUpAfter: spec on turn 4, then the loop allows exactly 3 more
  // iterations; the note reaches the model on the spec's result; a
  // record_deleted requested in one of those extra iterations still executes.
  {
    const model = scriptedLlm({ writeOn: 4, deleteOn: 5 });
    const stub = stubEnv();
    const r = await runAgentLoop({
      system: "test",
      task: "walk",
      env: stub.env,
      llm: model.llm,
      thinking: "off",
      maxIterations: 50,
      wrapUpAfter: { tool: "write_e2e_test", extraIterations: WALK_WRAP_UP_ITERATIONS, note: NOTE },
    });
    check("wrap-up: loop stops at 4 + 3 = 7 iterations", r.iterations === 7, String(r.iterations));
    check("wrap-up: the model was called exactly 7 times", model.calls() === 7, String(model.calls()));
    const specResult = resultTextFor(r.messages, "tu_4");
    check(
      "wrap-up: the note is appended to the write_e2e_test result",
      specResult !== null && specResult.startsWith("Spec saved.") && specResult.endsWith(`\n\n${NOTE}`),
      JSON.stringify(specResult),
    );
    // What the model saw on its 5th call is what it will act on — check that
    // side too, not just the returned conversation.
    const fifth = model.seen[4];
    const seenByModel = fifth ? resultTextFor(fifth, "tu_4") : null;
    check("wrap-up: the model's next call carries the note", seenByModel !== null && seenByModel.includes(NOTE));
    check("wrap-up: the spec callback ran once", stub.written.length === 1, String(stub.written.length));
    check(
      "wrap-up: record_deleted in an extra iteration IS executed",
      stub.deleted.length === 1 && stub.deleted[0].ok === true && stub.deleted[0].marker === "CheckMyApp test r1",
      JSON.stringify(stub.deleted),
    );
    const readResult = resultTextFor(r.messages, "tu_6");
    check(
      "wrap-up: a read_page in an extra iteration still executes, without the note",
      readResult !== null && readResult.startsWith("URL: https://target.test/") && !readResult.includes(NOTE),
      JSON.stringify(readResult)?.slice(0, 80),
    );
    check(
      "wrap-up: results of other tools never carry the note",
      r.transcript.filter((t) => t.kind === "tool_result" && t.detail.includes(NOTE)).length === 0,
    );
  }

  // (b) — the same model without wrapUpAfter runs to maxIterations.
  {
    const model = scriptedLlm({ writeOn: 4, deleteOn: 5 });
    const stub = stubEnv();
    const r = await runAgentLoop({
      system: "test",
      task: "walk",
      env: stub.env,
      llm: model.llm,
      thinking: "off",
      maxIterations: 12,
    });
    check("no wrapUpAfter: runs to maxIterations", r.iterations === 12, String(r.iterations));
    check("no wrapUpAfter: no note anywhere", resultTextFor(r.messages, "tu_4") === "Spec saved.");
  }

  // (b') — the wrap-up never lifts the cap: spec on turn 4 with maxIterations
  // 5 ends at 5, not 7; a second spec call late in a walk cannot add turns.
  {
    const model = scriptedLlm({ writeOn: 4, deleteOn: 5 });
    const r = await runAgentLoop({
      system: "test",
      task: "walk",
      env: stubEnv().env,
      llm: model.llm,
      thinking: "off",
      maxIterations: 5,
      wrapUpAfter: { tool: "write_e2e_test", extraIterations: WALK_WRAP_UP_ITERATIONS, note: NOTE },
    });
    check("wrap-up never exceeds maxIterations", r.iterations === 5, String(r.iterations));
  }
  {
    // Spec written twice: on turn 2 (cap → 5) and again on turn 4. The second
    // must not push the cap to 7.
    let call = 0;
    const create = async (): Promise<Anthropic.Message> => {
      call += 1;
      const name = call === 2 || call === 4 ? "write_e2e_test" : "read_page";
      return {
        id: `msg_${call}`,
        type: "message",
        role: "assistant",
        model: "scripted",
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
        content: [{ type: "tool_use", id: `tu_${call}`, name, input: { title: "J", content: "x" } }],
      } as Anthropic.Message;
    };
    const client = { messages: { create } } as unknown as Anthropic;
    const r = await runAgentLoop({
      system: "test",
      task: "walk",
      env: stubEnv().env,
      llm: {
        navClient: client,
        synthClient: client,
        structClient: client,
        navModel: "scripted",
        synthModel: "scripted",
        structModel: "scripted",
        navVision: false,
      },
      thinking: "off",
      maxIterations: 50,
      wrapUpAfter: { tool: "write_e2e_test", extraIterations: 3, note: NOTE },
    });
    check("a second spec call does not extend the cap", r.iterations === 5, String(r.iterations));
  }

  // (c) — the cap is sized to the journey and clamped.
  const caps: Array<[number, number]> = [
    [1, 24],
    [3, 27],
    [5, 37],
    [8, 50],
    [20, 50],
  ];
  for (const [steps, expected] of caps) {
    const got = walkingIterationCap(steps);
    check(`walkingIterationCap(${steps}) = ${expected}`, got === expected, String(got));
  }
  check("walkingIterationCap(0) = floor", walkingIterationCap(0) === WALK_ITERATIONS_MIN, String(walkingIterationCap(0)));
  check("walkingIterationCap(NaN) = floor", walkingIterationCap(Number.NaN) === WALK_ITERATIONS_MIN);
  check("ceiling is the pre-CHE-134 flat cap", WALK_ITERATIONS_MAX === 50);
  check("wrap-up allowance is 3", WALK_WRAP_UP_ITERATIONS === 3);

  // (d) — focus ordering.
  {
    const kw = focusKeywords("YouTube links must work; checkout");
    check(
      "focus keywords: stop-words 'must' and 'work' ignored",
      !kw.includes("must") && !kw.includes("work"),
      kw.join(","),
    );
    check("focus keywords: youtube, links, checkout kept", ["youtube", "links", "checkout"].every((k) => kw.includes(k)), kw.join(","));
    check("focus keywords: words under 4 letters dropped", focusKeywords("the app is ok").length === 0);

    const ordered = orderByFocus(journeys, "YouTube links must work; checkout");
    const titles = ordered.map((j) => j.title);
    check(
      "orderByFocus: focus journeys first, in their original relative order",
      titles.join(" | ") === "Browse tutorial videos | Buy a plan | Sign in | Edit profile | Sign out",
      titles.join(" | "),
    );
    check("orderByFocus: same journeys, none lost or duplicated", ordered.length === journeys.length && new Set(ordered).size === journeys.length);
    check("orderByFocus: input array not mutated", journeys[0].title === "Sign in" && journeys[1].title === "Browse tutorial videos");

    check("orderByFocus(null) returns the identical array", orderByFocus(journeys, null) === journeys);
    check("orderByFocus(undefined) returns the identical array", orderByFocus(journeys, undefined) === journeys);
    check('orderByFocus("") returns the identical array', orderByFocus(journeys, "") === journeys);
    check('orderByFocus("   ") returns the identical array', orderByFocus(journeys, "   ") === journeys);
    check(
      "orderByFocus: a focus made only of stop-words changes nothing",
      orderByFocus(journeys, "must work well") === journeys,
    );
    check(
      "orderByFocus: a focus nothing covers changes nothing",
      orderByFocus(journeys, "invoices").map((j) => j.title).join("|") === journeys.map((j) => j.title).join("|"),
    );
    check(
      "orderByFocus: case-insensitive against title and steps",
      orderByFocus(journeys, "CHECKOUT")[0].title === "Buy a plan" &&
        orderByFocus(journeys, "profile")[0].title === "Edit profile",
    );
    check("orderByFocus: empty list stays empty", orderByFocus([], "checkout").length === 0);
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
