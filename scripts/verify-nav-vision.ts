// CHE-168 verification: the nav model's vision mode and the structured-
// extraction model are decided by secrets, not by a deploy.
//
// A production spike of a candidate nav model (DeepSeek V4 Flash, vision and
// text) has to flip between "screenshots in context" and "text only" and pick
// the structured-extraction sibling without a code change per attempt — every
// deploy mid-spike is a chance to land on top of a scheduled watch run. So the
// decision lives in makeLlm behind ANTHROPIC_NAV_VISION / ANTHROPIC_STRUCT_MODEL
// and is read from LlmConfig.navVision everywhere, never re-derived.
//
// Pure: no browser, no network, no model, no database — the heuristic, both
// override directions, and struct routing for each candidate.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-nav-vision.ts

import { isVisionModel, makeLlm, navVisionFor, structModelFor } from "@/agent/llm";
import type { AgentBindings } from "@/agent/env";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// (1) The heuristic: who can see images without being told.
const vision = ["claude-sonnet-4-6", "claude-opus-4-8", "z-ai/glm-5v-turbo", "z-ai/glm-4.6v", "deepseek/deepseek-v4-flash-vision-exp"];
const text = ["z-ai/glm-5.2", "deepseek/deepseek-v4-flash", "moonshotai/kimi-k3"];
for (const m of vision) check(`heuristic: ${m} is vision`, isVisionModel(m));
for (const m of text) check(`heuristic: ${m} is text`, !isVisionModel(m));

// (2) The override, both directions, and the fall-through.
check("override on → vision for a text model", navVisionFor("deepseek/deepseek-v4-flash", "on"));
check("override off → text for a vision model", !navVisionFor("deepseek/deepseek-v4-flash-vision-exp", "off"));
check("override ' ON ' is case/space-insensitive", navVisionFor("z-ai/glm-5.2", " ON "));
check("unset → heuristic (vision model)", navVisionFor("z-ai/glm-5v-turbo", undefined));
check("unset → heuristic (text model)", !navVisionFor("z-ai/glm-5.2", undefined));
check("a typo falls to the heuristic, not to vision", !navVisionFor("deepseek/deepseek-v4-flash", "yes"));
check("empty string falls to the heuristic", navVisionFor("claude-sonnet-4-6", ""));

// (3) Struct routing: a vision nav model extracts on its text sibling.
check("glm-5v → glm-5.2", structModelFor("z-ai/glm-5v-turbo", undefined) === "z-ai/glm-5.2");
check("glm-4.6v → glm-5.2", structModelFor("z-ai/glm-4.6v", undefined) === "z-ai/glm-5.2");
check(
  "deepseek vision → deepseek text",
  structModelFor("deepseek/deepseek-v4-flash-vision-exp", undefined) === "deepseek/deepseek-v4-flash",
);
check("deepseek text → itself", structModelFor("deepseek/deepseek-v4-flash", undefined) === "deepseek/deepseek-v4-flash");
check("glm-5.2 → itself", structModelFor("z-ai/glm-5.2", undefined) === "z-ai/glm-5.2");
check("claude → itself", structModelFor("claude-sonnet-4-6", undefined) === "claude-sonnet-4-6");
check(
  "ANTHROPIC_STRUCT_MODEL wins over the sibling table",
  structModelFor("z-ai/glm-5v-turbo", "deepseek/deepseek-v4-flash") === "deepseek/deepseek-v4-flash",
);
check("a blank ANTHROPIC_STRUCT_MODEL is unset", structModelFor("z-ai/glm-5v-turbo", "  ") === "z-ai/glm-5.2");

// (4) makeLlm threads all of it into LlmConfig — the only object the loop reads.
const base = { OPENROUTER_API_KEY: "or-test", ANTHROPIC_API_KEY: "an-test" } as unknown as AgentBindings;
const llm = (extra: Partial<AgentBindings>) => makeLlm({ ...base, ...extra });

{
  const c = llm({ ANTHROPIC_NAV_MODEL: "deepseek/deepseek-v4-flash-vision-exp", ANTHROPIC_NAV_VISION: "on" });
  check("candidate 1: deepseek vision, vision on", c.navVision && c.structModel === "deepseek/deepseek-v4-flash");
}
{
  const c = llm({ ANTHROPIC_NAV_MODEL: "deepseek/deepseek-v4-flash", ANTHROPIC_NAV_VISION: "off" });
  check("candidate 2: deepseek text, vision off", !c.navVision && c.structModel === "deepseek/deepseek-v4-flash");
}
{
  const c = llm({ ANTHROPIC_NAV_MODEL: "z-ai/glm-5.3-flash", ANTHROPIC_NAV_VISION: "on" });
  check("candidate 3: glm-5.3-flash forced vision, struct on itself", c.navVision && c.structModel === "z-ai/glm-5.3-flash");
}
{
  const c = llm({ ANTHROPIC_NAV_MODEL: "z-ai/glm-5v-turbo" });
  check("today's production: glm-5v-turbo, nothing set", c.navVision && c.structModel === "z-ai/glm-5.2");
}
{
  const c = llm({ ANTHROPIC_NAV_MODEL: "z-ai/glm-5v-turbo", ANTHROPIC_STRUCT_MODEL: "deepseek/deepseek-v4-flash" });
  check("struct override reaches LlmConfig", c.structModel === "deepseek/deepseek-v4-flash");
}
{
  const c = llm({});
  check("defaults: claude nav is vision, struct on itself", c.navVision && c.structModel === c.navModel);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
