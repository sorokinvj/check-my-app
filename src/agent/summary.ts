// CHE-180 — the journey summary is what we found, never what the model was
// about to do.
//
// Run #144 published, as "What we found" on two journeys: "The Settings page
// has the 'Insight Preferences' section … Let me interact with these controls"
// and "Let me try the Reset to Defaults button". The walking cap (CHE-134)
// ended those loops while the model was still acting, and the walk wrote its
// last text as the summary. The loop now says how it ended (AgentLoopResult
// .endedBy), and a text that reads as intent is recognised deterministically;
// either way the walk asks once more, with the conversation it already has,
// for the summary and nothing else. A reply that is still a plan is not
// written: no summary is more honest than a wrong one.
//
// Pure apart from the one model call, which is the same finalizeJson the
// forced spec uses — so the verify script drives this exact function with a
// scripted model.

import { productProse, splitSentences } from "@/lib/verdict-language";
import { finalizeJson, type AgentLoopResult } from "./core";
import type { LlmConfig, UsageTotals } from "./llm";

// A summary that starts with one of these is a plan. Kept as one list so the
// rule is readable in one place and the verify script walks the same list.
export const INTENT_OPENERS = [
  "Let me",
  "I'll",
  "I will",
  "Now I",
  "Next",
  "Now let",
  "Let's",
  "I need to",
  "I should",
] as const;

const OPENER = new RegExp(
  `^(?:${INTENT_OPENERS.map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

// Text that carries a tool call, or names one of the walk's tools, was written
// for the loop, not for the owner.
export const TOOL_CALL_FRAGMENT =
  /\b(?:navigate|read_page|click|fill|screenshot|get_network_log|verify_links|record_created|record_deleted|report_step|write_e2e_test)\s*\(|<\/?(?:tool_use|function_calls|invoke)\b|\b(?:read_page|get_network_log|verify_links|record_created|record_deleted|report_step|write_e2e_test)\b/i;

// Ends like a sentence: terminal punctuation, an ellipsis (cleanSummary's own
// cut), optionally followed by a closing quote or bracket.
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

export function looksLikeIntent(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/[’‘]/g, "'").trim();
  if (!t) return true;
  if (OPENER.test(t)) return true;
  // "The Settings page has the Insight Preferences section. Let me interact
  // with these controls." — the plan is the last sentence, not the first.
  const sentences = splitSentences(t);
  const last = (sentences[sentences.length - 1] ?? "").trim();
  if (OPENER.test(last)) return true;
  if (!SENTENCE_END.test(t)) return true;
  return TOOL_CALL_FRAGMENT.test(t);
}

// The journey summary is meant to be a 1-2 sentence "what we found" line, but
// the model often dumps a full markdown report (headings, a step table). That
// leaks raw markdown into the verdict UI. Strip markdown structure and keep the
// first bit of prose so the strip caption reads cleanly.
export function cleanSummary(text: string): string | null {
  const prose = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("---"))
    .join(" ")
    .replace(/\*\*|`|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // The UI prints its own "What we found:" lead-in; a model-written
    // "Summary:" after it reads as stuttering boilerplate.
    .replace(/^summary\s*[:—-]\s*/i, "");
  if (prose.length <= 400) return prose || null;
  // Cut at a sentence boundary instead of mid-word: a caption that ends in
  // "the /en/login route 307-redi" reads as a bug of ours, not the app's.
  const window = prose.slice(0, 400);
  const lastStop = window.lastIndexOf(". ");
  return lastStop > 150 ? window.slice(0, lastStop + 1) : `${window.trimEnd()}…`;
}

export const SUMMARY_INSTRUCTION =
  "The walk is over. Reply with ONLY a 1-2 sentence summary of what you found about the " +
  "product — the problem first if there was one, never a plan or a next step.";

// What Journey.summary gets. The model's own closing text when it stopped by
// itself and the text is a finished statement; otherwise one more call for the
// summary alone, whose cost lands in the walk's usage like the forced spec's.
// Null when even that reply is a plan — and always product prose (CHE-82).
export async function summarizeWalk(
  llm: LlmConfig,
  result: Pick<AgentLoopResult, "finalText" | "messages" | "endedBy">,
  usage: UsageTotals,
): Promise<string | null> {
  let text = cleanSummary(result.finalText) ?? "";
  if (result.endedBy === "cap" || looksLikeIntent(text)) {
    console.log(
      `[walk] summary requested: loop ended by ${result.endedBy}` +
        (result.endedBy === "model" ? `, last text reads as intent: ${JSON.stringify(text.slice(0, 80))}` : ""),
    );
    const reply = await finalizeJson(llm, result.messages, SUMMARY_INSTRUCTION, usage);
    text = cleanSummary(reply) ?? "";
    if (looksLikeIntent(text)) {
      console.warn(`[walk] summary reply is still a plan, writing none: ${JSON.stringify(text.slice(0, 80))}`);
      return null;
    }
  }
  return productProse(text);
}
