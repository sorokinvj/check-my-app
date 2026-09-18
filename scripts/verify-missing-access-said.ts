// CHE-283, second half: what we could not finish is said, and the ask is made.
//
// The database has known this all along. In recent production runs 25 skipped
// steps are recorded `missing_access` and 18 `our_capability`, each with an
// `observed` sentence naming exactly what stopped us —
//
//   "Without a valid session the integrations section is not reachable"
//   "Because no test credentials were provided, the form was not submitted"
//
// — and **none of it reached a single customer-facing surface.** A grep of
// src/lib, src/components and src/app for `missing_access` returned nothing.
// The owner saw page counts, no completion rate, and nothing to explain the
// difference or act on.
//
// The two reasons are not interchangeable and the distinction is the point:
//
//   missing_access   theirs to grant. CLAUDE.md rule 2 calls it "the one thing
//                    we may ask the owner for — that is access, not
//                    verification work". So we name what would change it.
//   our_capability   OURS. Already a ticket on our own board via
//                    capability-gaps.ts. The customer is told the consequence
//                    and never handed the problem.
//
// Rule 1's hardest line is the reason this file exists: "homework for the
// customer" is a hard failure. Asking for a credential is NOT homework —
// verdict-language.ts allows it explicitly — but the sentence has to prove it
// rather than assume it, so every string here goes through the same leak
// detector that guards verdicts.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-missing-access-said.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unfinishedLine, type UnfinishedReason } from "@/lib/journey-numbers";
import { hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const REASONS: UnfinishedReason[] = ["missing_access", "our_capability"];

console.log("\n— the two reasons are different sentences, and only one asks —\n");

{
  const access = unfinishedLine("missing_access");
  const ours = unfinishedLine("our_capability");

  check("they are different sentences", access !== ours);

  check("the access one names what would change it",
    /test credentials/i.test(access), access);
  check("…and says what we would then do, so the ask has a purpose",
    /measure/i.test(access), access);
  check("…and does not blame the customer for the gap",
    !/you (did not|failed|forgot)/i.test(access), access);

  check("our own gap asks the customer for nothing",
    !/add |provide |give us|please/i.test(ours), ours);
  check("…and does not apologise or explain our machinery",
    !/sorry|our (checker|browser|agent)/i.test(ours), ours);
  check("…but does say the consequence plainly",
    /no completion rate/i.test(ours), ours);
}

console.log("\n— rule 1: an ask for access is not homework —\n");

{
  for (const r of REASONS) {
    const s = unfinishedLine(r);
    check(`no homework in "${r}"`, !hasHomework(s), s);
    check(`no narration in "${r}"`, !hasNarration(s), s);
    check(`no machinery word in "${r}"`,
      !/\b(browser|headless|playwright|crawl|selector|viewport|our test)\b/i.test(s), s);
    // The worst version of the leak: telling them to go and check it themselves.
    check(`"${r}" never asks them to verify anything`,
      !/\b(verify|confirm|check) (this|it|that) (yourself|manually|in a real)/i.test(s), s);
  }
}

console.log("\n— it is actually wired to a customer-facing surface —\n");

{
  // The defect was never the wording. It was that the reason existed in the
  // database and nowhere a customer could see, so a source check is the one
  // that would have caught it.
  const block = readFileSync(
    join(import.meta.dirname, "..", "src/components/journey-numbers-block.tsx"),
    "utf8",
  );
  const load = readFileSync(
    join(import.meta.dirname, "..", "src/lib/journey-numbers-load.ts"),
    "utf8",
  );

  check("the loader reads the reason off the step", /unverifiedReason: true/.test(load));
  check("…and carries it out", /unfinished: unfinished\.get\(j\.id\) \?\? null/.test(load));
  check("the block renders it", /unfinishedLine\(unfinished\)/.test(block));
  check("…only when the journey was not finished",
    /!walkFinished && unfinished/.test(block), "a finished journey needs no excuse");
  check("…and not alongside a comparison, which already answers the question",
    /!comparison && pages && !walkFinished/.test(block));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
