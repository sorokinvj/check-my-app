// Rewrite published bottom lines that were entirely about our machinery (CHE-92).
//
// The deterministic strip in clean-published-verdicts.ts removes leaking
// sentences, but ~26 old bottom lines leak in EVERY sentence — stripping them
// leaves a stub. Those deserve a real correction, not a placeholder: this
// rewrites each one from the run's own journey outcomes, in customer language,
// keeping every fact about the product and dropping every word about us.
//
// Usage: ANTHROPIC_API_KEY from .env; npx tsx scripts/rewrite-leaking-bottomlines.ts <ctx.json>
// Prints SQL.

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { hasEnvironmentLeak, stripEnvironmentLeak, CUSTOMER_LANGUAGE_RULES } from "../src/lib/verdict-language";

interface Row {
  id: string;
  runNumber: number;
  appSlug: string;
  verdict: string | null;
  bottomLine: string;
  journeys: string | null;
}

// OpenRouter, same route the agent worker uses for its models (the local
// .env Anthropic key is stale; the worker holds the live one as a secret).
const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) throw new Error("OPENROUTER_API_KEY not set");
const client = new Anthropic({ apiKey: key, baseURL: "https://openrouter.ai/api" });
const MODEL = "z-ai/glm-5.2";

const rows: Row[] = JSON.parse(readFileSync(process.argv[2], "utf8"))[0].results;
// Only the ones a plain strip cannot save.
const targets = rows.filter((r) => hasEnvironmentLeak(r.bottomLine) && !stripEnvironmentLeak(r.bottomLine));

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function main() {
console.error(`-- rewriting ${targets.length} bottom lines`);

for (const r of targets) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system:
      `You are correcting a published verdict line for a product-checking service.\n\n` +
      CUSTOMER_LANGUAGE_RULES +
      `\n\nRewrite the line so it keeps every fact about the CUSTOMER'S product and ` +
      `drops every word about how the check was performed. Anything that was only ` +
      `unverified becomes a plain coverage clause ("we could not confirm X this run"). ` +
      `1-2 sentences. Reply with the rewritten line only.`,
    messages: [
      {
        role: "user",
        content:
          `App: ${r.appSlug}\nVerdict: ${r.verdict}\nJourney outcomes: ${r.journeys ?? "(none)"}\n\n` +
          `Original line:\n${r.bottomLine}`,
      },
    ],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();

  let finalText = text;
  if (!finalText || hasEnvironmentLeak(finalText)) {
    // The model echoed the original's wording. Second pass: never show it the
    // original — compose the line from the run's own outcomes alone, so there
    // is nothing about us to echo.
    const blind = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system:
        `Write the one-line bottom line of a product check report, for the product's owner.\n\n` +
        CUSTOMER_LANGUAGE_RULES +
        `\n\nYou are given only the outcomes of the journeys that were walked. State what ` +
        `worked and what did not, leading with the problem if there is one. Journeys marked ` +
        `skipped were not verified — mention them only as "we could not confirm X this run". ` +
        `1-2 sentences, no preamble.`,
      messages: [
        {
          role: "user",
          content: `App: ${r.appSlug}\nVerdict: ${r.verdict}\nJourney outcomes: ${r.journeys ?? "(none)"}`,
        },
      ],
    });
    finalText = blind.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (!finalText || hasEnvironmentLeak(finalText)) {
      console.error(`-- run #${r.runNumber}: both passes leaked, leaving to the strip pass`);
      continue;
    }
    console.error(`-- run #${r.runNumber} ok (from outcomes only)`);
    console.log(`UPDATE Run SET bottomLine = ${q(finalText)} WHERE id = ${q(r.id)};`);
    continue;
  }
  console.log(`UPDATE Run SET bottomLine = ${q(finalText)} WHERE id = ${q(r.id)};`);
  console.error(`-- run #${r.runNumber} ok`);
}
}

void main();
