// Second half of the published-verdict correction (CHE-92).
//
// The strip pass fixed prose; a finding TITLE is a single claim, so stripping
// leaves nothing — those have to be restated. Same rule as everywhere else:
// describe the product, never our machinery, never ask the owner to verify.
// A finding that was only ever about our environment becomes a coverage
// statement ("Sign-in submission could not be confirmed this run") and stays
// marked false_positive, so it reads as what it is.
//
// Usage: OPENROUTER_API_KEY=… npx tsx scripts/rewrite-leaking-findings.ts <rows.json>

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { hasEnvironmentLeak, stripEnvironmentLeak, CUSTOMER_LANGUAGE_RULES } from "../src/lib/verdict-language";

interface Row { id: string; title: string; detail: string | null; category: string }

const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) throw new Error("OPENROUTER_API_KEY not set");
const client = new Anthropic({ apiKey: key, baseURL: "https://openrouter.ai/api" });
const MODEL = "z-ai/glm-5.2";

const rows: Row[] = JSON.parse(readFileSync(process.argv[2], "utf8"))[0].results;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

// Deterministic fallback when the model will not stop echoing: keep the
// subject of the claim, drop everything about us.
function coverageTitle(title: string): string {
  const subject = title
    .replace(/\s*(—|-|:)?\s*(did|does|do)?\s*not\s+(respond|fire|work|react)[^,.]*/gi, "")
    .replace(/\s*(in|for|with)\s+(our|the|this)[^,.]*/gi, "")
    .replace(/\s*produced?\s+no\s+(network\s+)?requests?[^,.]*/gi, "")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[,;:.\s]+$/, "");
  const base = subject.length > 3 ? subject : "This step";
  return `${base}: could not be confirmed this run`.slice(0, 300);
}

async function main() {
  console.error(`-- ${rows.length} findings to restate`);
  for (const f of rows) {
    let title: string | null = null;
    if (hasEnvironmentLeak(f.title)) {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 200,
        system:
          `Restate one finding title from a product check, for the product's owner.\n\n` +
          CUSTOMER_LANGUAGE_RULES +
          `\n\nIf the original was only about the checker failing to do something, restate it ` +
          `as coverage: "<the thing>: could not be confirmed this run". Keep it under 12 words. ` +
          `Reply with the title only.`,
        messages: [{ role: "user", content: f.title }],
      });
      const t = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim()
        .replace(/^["']|["']$/g, "");
      title = t && !hasEnvironmentLeak(t) ? t : coverageTitle(f.title);
    }

    let detail: string | null | undefined;
    if (f.detail && hasEnvironmentLeak(f.detail)) {
      try {
        const d = JSON.parse(f.detail) as Record<string, unknown>;
        for (const k of Object.keys(d)) {
          const v = d[k];
          if (typeof v === "string" && hasEnvironmentLeak(v)) {
            const s = stripEnvironmentLeak(v);
            if (s) d[k] = s;
            else delete d[k];
          } else if (Array.isArray(v)) {
            d[k] = v
              .filter((x): x is string => typeof x === "string")
              .map((x) => (hasEnvironmentLeak(x) ? stripEnvironmentLeak(x) : x))
              .filter(Boolean);
          }
        }
        detail = JSON.stringify(d);
      } catch {
        detail = null;
      }
    }

    const sets: string[] = [];
    if (title) sets.push(`title = ${q(title)}`);
    if (detail !== undefined) sets.push(`detail = ${detail === null ? "NULL" : q(detail)}`);
    if (sets.length) console.log(`UPDATE Finding SET ${sets.join(", ")} WHERE id = ${q(f.id)};`);
  }
}

void main();
