// CHE-242 verification: what changed in the flow, next to the number.
//
// This is the half PostHog cannot have, and the discipline is the whole design.
// Everything must read as **what changed**, never **why the number moved**.
// Rule 9: take them over the water, do not build them the bridge.
//
// The failure this file exists to make impossible is the plausible one. It is
// very easy to write "the extra email step is causing your drop" — it reads
// well, it is often right, and it is a diagnosis we are not entitled to. Being
// right about it occasionally is worse than never saying it, because it teaches
// people to trust a guess.
//
// So the checks are, in order of how much they matter:
//   1. no causal language, anywhere, in any combination of inputs;
//   2. no file, no cause, no fix — the ticket says "no message ever names" them;
//   3. nothing changed produces the honest sentence, not an empty list dressed
//      up as an explanation;
//   4. the internal note the ticket asked for is NOT rendered (rule 1).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-flow-changes.ts

import { flowChanges, pairedSentence, type FlowSnapshot } from "@/lib/flow-changes";
import { hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const base: FlowSnapshot = {
  price: null,
  prevPrice: null,
  plan: [],
  prevPlan: [],
  status: null,
  prevStatus: null,
  newFindings: [],
  pageChanged: false,
};

const MOVEMENT = "“Sign up” is finishing for fewer people: 28% of 1,800, against 40% before — 12 points down.";

/** Every sentence this module can produce, across the input space. */
function everySentence(): string[] {
  const out: string[] = [];
  for (const price of [null, 6] as Array<number | null>) {
    for (const prevPrice of [null, 8] as Array<number | null>) {
      for (const plan of [[], ["Open the form"], ["Open the form", "Enter the code from your email"]]) {
        for (const prevPlan of [[], ["Open the form"]]) {
          for (const status of [null, "confusing"]) {
            for (const pageChanged of [false, true]) {
              const s: FlowSnapshot = {
                ...base, price, prevPrice, plan, prevPlan, status,
                prevStatus: status ? "ok" : null,
                newFindings: status ? ["the form rejects a valid address"] : [],
                pageChanged,
              };
              out.push(pairedSentence(MOVEMENT, flowChanges(s)));
            }
          }
        }
      }
    }
  }
  return out;
}

function main() {
  console.log("The pairing — the reason this project is worth building");
  {
    // The ticket's own example: the form grew a step and got more expensive.
    const s: FlowSnapshot = {
      ...base,
      price: 8,
      prevPrice: 6,
      plan: ["Open the form", "Fill in your details", "Enter the code from your email"],
      prevPlan: ["Open the form", "Fill in your details"],
    };
    const changes = flowChanges(s);
    const sentence = pairedSentence(MOVEMENT, changes);
    check("the new step is named", sentence.includes("Enter the code from your email"), sentence);
    check("…and the price movement is stated as a fact", sentence.includes("6 → 8 actions"), sentence);
    check("…both in one message, which is the product", changes.length >= 2, String(changes.length));
    check("…and the movement itself is still there", sentence.includes("12 points down"));
  }

  console.log("\nNothing changed is an answer, not an empty list");
  {
    const sentence = pairedSentence(MOVEMENT, flowChanges(base));
    check("it says so outright", /nothing changed in this flow/i.test(sentence), sentence);
    check("…and still carries the movement", sentence.includes("12 points down"), sentence);
    check("…and does not reach for something vague to fill the space",
      !/perhaps|maybe|possibly|might have|could be/i.test(sentence), sentence);
  }

  console.log("\nWhat changed, never why — the discipline that is the design");
  {
    const sentences = everySentence();
    check("there are sentences to check", sentences.length > 20, String(sentences.length));

    // The failure this whole file exists to prevent.
    const causal = sentences.filter((s) =>
      /\bbecause\b|\bcaused?\b|\bcausing\b|\bdue to\b|\bblame|\bresponsible for\b|\bexplains?\b|\bwhy\b|\bleads? to\b|\bresult(ed|ing)? (in|from)\b/i.test(s));
    check("not one sentence claims a cause", causal.length === 0, causal.slice(0, 2).join(" | "));

    const prescriptive = sentences.filter((s) =>
      /\bshould\b|\btry\b|\bfix\b(?!e[sd])|\bremove the\b|\brevert\b|\brecommend|\bconsider \w+ing\b|\byou need to\b/i.test(s));
    check("not one sentence prescribes a fix", prescriptive.length === 0, prescriptive.slice(0, 2).join(" | "));

    const files = sentences.filter((s) => /\.tsx?\b|\.jsx?\b|\bsrc\/|\bcomponent\b|\bendpoint\b|\bAPI\b|\bdatabase\b/i.test(s));
    check("not one sentence names a file, a component or an endpoint",
      files.length === 0, files.slice(0, 2).join(" | "));

    const ranked = sentences.filter((s) => /\bmost likely\b|\bprobably\b|\bthe main\b|\blikely cause\b/i.test(s));
    check("nothing is presented as the likeliest explanation", ranked.length === 0, ranked.slice(0, 2).join(" | "));
  }

  console.log("\nRule 1 over the same input space");
  {
    const sentences = everySentence();
    check("none asks the customer to verify anything",
      !sentences.some(hasHomework), sentences.filter(hasHomework).slice(0, 2).join(" | "));
    check("none narrates how we check",
      !sentences.some(hasNarration), sentences.filter(hasNarration).slice(0, 2).join(" | "));
    check("none mentions our machinery",
      !sentences.some((s) => /\b(browser|headless|playwright|our walk|the agent|crawler|selector)\b/i.test(s)),
      sentences.filter((s) => /\b(browser|headless|playwright|our walk|the agent|crawler|selector)\b/i.test(s))[0] ?? "");

    // "the last check" is the customer's word for the thing they bought. It is
    // not machinery — but "our test run" would be, and this keeps them apart.
    check("it says 'the last check', which is the thing they bought",
      sentences.some((s) => /since the last check|between the two checks/i.test(s)));
  }

  console.log("\nThe internal note the ticket asked for is deliberately absent");
  {
    // AppJourney.metricNote is the model's sentence about its own judgement —
    // our machinery. The schema says: never rendered into a verdict or an email
    // as written. The price MOVEMENT is a fact and is reported; the note is not.
    const src = require("node:fs").readFileSync("src/lib/flow-changes.ts", "utf8") as string;
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    check("metricNote is not read anywhere in the code", !/metricNote/.test(code), "metricNote appears in code");
    check("…and the snapshot the module takes has no field for it",
      !/note/i.test(code.split("export type FlowChange")[0] ?? ""), "a note field exists on the snapshot");
  }

  console.log("\nA list nobody reads is a list that failed");
  {
    const everything: FlowSnapshot = {
      price: 14,
      prevPrice: 3,
      plan: ["a", "b", "c", "d", "e", "f"],
      prevPlan: ["z", "y", "x"],
      status: "broken",
      prevStatus: "ok",
      newFindings: ["one", "two", "three", "four"],
      pageChanged: true,
    };
    const changes = flowChanges(everything);
    check("the list is capped", changes.length <= 5, String(changes.length));
    check("…and a concrete change survives the cap ahead of the vaguest one",
      changes.some((c) => c.kind === "step_added") && !changes.some((c) => c.kind === "page"),
      changes.map((c) => c.kind).join(","));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
