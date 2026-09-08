// CHE-214 verification: a control our own hands could not drive never becomes
// a defect of the customer's product.
//
// Run #159 typed into the "Add login & notes" notes field on checkmyapp.dev's
// /check page. Playwright's fill timed out after 8 s; the tool returned the
// bare string "Error: locator.fill: Timeout 8000ms exceeded"; no step was
// reported for the attempt; synthesis wrote "Credential/notes field didn't
// accept input" and the bottom line was built on it. Checked by hand in a real
// Chrome minutes later: the accordion opens, the field takes a programmatic
// value, and typed characters land at the caret. The field was fine.
//
// Three things are proved here, in order of how much they can be argued with:
//   1. a fill that fill() cannot drive is retried by typing, the way a person
//      would — and when that lands, nothing about it reaches the model;
//   2. when typing does not land either, the tool says whose limitation it is
//      and which step to report, instead of a naked error;
//   3. a step reported as a defect after such a failure is coerced to
//      skipped / our_capability, which files a ticket on OUR board — and the
//      finding CHE-215's gate would still have to judge is never reached.
//
// Pure: a stub page, no browser, no network, no model, no database.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-undriven-control.ts

import {
  UNDRIVEN_INSTRUCTION,
  coerceUndrivenControl,
  executeTool,
  type RecordedAction,
  type ReportedStep,
  type ToolEnv,
  type UndrivenControl,
} from "@/agent/tools";
import { GAP_CLASSES, classifyGap } from "@/agent/gap-classes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const TIMEOUT = () => new Error("locator.fill: Timeout 8000ms exceeded");

// The notes field of run #159, in the two states worth telling apart: fill()
// times out, and typing either lands (as it does by hand) or does not.
function stubPage(opts: { fillThrows: boolean; typingWorks: boolean; residual?: string }) {
  let value = opts.residual ?? "";
  const locator = {
    first: () => locator,
    or: () => locator,
    count: async () => 1,
    elementHandle: async () => null,
    click: async () => {},
    fill: async (v: string) => {
      if (opts.fillThrows) throw TIMEOUT();
      value = v;
    },
    focus: async () => {
      if (!opts.typingWorks) throw TIMEOUT();
    },
    pressSequentially: async (v: string) => {
      if (!opts.typingWorks) throw TIMEOUT();
      value += v;
    },
    inputValue: async () => value,
  };
  return {
    url: () => "https://checkmyapp.dev/check",
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => 0,
    getByRole: () => locator,
    getByLabel: () => locator,
    getByPlaceholder: () => locator,
    locator: () => locator,
    typedValue: () => value,
  };
}

function stubEnv(opts: { fillThrows: boolean; typingWorks: boolean; residual?: string }): ToolEnv & {
  page: ReturnType<typeof stubPage>;
} {
  return {
    page: stubPage(opts),
    targetOrigin: "https://checkmyapp.dev",
    networkLog: [],
    consoleLog: [],
    credentials: { rejected: false },
    actionTrail: [],
    undrivenControls: [],
  } as unknown as ToolEnv & { page: ReturnType<typeof stubPage> };
}

const NOTES = { label: "Anything we should know?", value: "test notes" };

async function main() {
  // 1 — fill() cannot drive it, typing can. This is the run #159 field as a
  // real browser found it, and the model never learns anything went wrong.
  {
    const env = stubEnv({ fillThrows: true, typingWorks: true });
    const result = await executeTool(env, "fill", NOTES);
    check("fill() timeout → typed instead → Filled.", result === "Filled.", result);
    check("…the value landed", env.page.typedValue() === NOTES.value, env.page.typedValue());
    const trail = env.actionTrail as RecordedAction[];
    check("…and the action is on the trail like any other fill", trail.length === 1 && trail[0].kind === "fill");
    check("…with nothing recorded as undriven", (env.undrivenControls as UndrivenControl[]).length === 0);
  }

  // 2 — neither works. The tool says whose limitation it is.
  {
    const env = stubEnv({ fillThrows: true, typingWorks: false });
    const result = await executeTool(env, "fill", NOTES);
    check("neither fill nor typing lands → not a bare Error:", !result.startsWith("Error:"), result.slice(0, 60));
    check("…the result names the control and the instruction", result.includes(NOTES.label) && result.includes(UNDRIVEN_INSTRUCTION));
    check(
      "…and tells the model to report skipped / our_capability, never a defect",
      result.includes("our_capability") && /never write that it "did not accept input"/.test(result),
    );
    check("…nothing is recorded on the action trail", (env.actionTrail as RecordedAction[]).length === 0);
    const undriven = env.undrivenControls as UndrivenControl[];
    check(
      "…and the failure is recorded for report_step",
      undriven.length === 1 && undriven[0].hand === "fill" && undriven[0].target === NOTES.label,
      JSON.stringify(undriven[0]),
    );
  }

  // 3 — the machine half. Run #159's own shape: the model reports the product
  // at fault anyway, and the step becomes ours.
  {
    const env = stubEnv({ fillThrows: true, typingWorks: false });
    await executeTool(env, "fill", NOTES);
    const step: ReportedStep = {
      label: "Enter test credentials in 'Add login & notes'",
      status: "risky",
      attempted: "Expanded the accordion and typed test credentials into the notes field",
      observed: "The field is present but the input attempt did not take.",
    };
    await executeTool(env, "report_step", step as unknown as Record<string, unknown>);
    check(
      "a defect reported after an undriven control becomes skipped / our_capability",
      step.status === "skipped" && step.unverifiedReason === "our_capability",
      `${step.status}/${step.unverifiedReason}`,
    );
    check("…and names the capability, so it files on our board", step.gapClass === "undriven_control", step.gapClass);
    check("…and the step says the control was not exercised", /could not be exercised this run/.test(step.observed));
    check("…and the record is drained, so the next step starts clean", (env.undrivenControls as UndrivenControl[]).length === 0);
  }

  // 3b — the field already held something. Typing appends, so the DOM value
  // ends up "Draft.test notes" — it CONTAINS what we typed but does not equal
  // it. Before this was fixed, execution fell through into the pre-existing
  // "verify stuck, retry" block, which called the very fill() just proven
  // undrivable: it failed, recorded the control as undriven, and threw away
  // input that had worked. The whole of CHE-214 undone one block later.
  {
    const env = stubEnv({ fillThrows: true, typingWorks: true, residual: "Draft." });
    const result = await executeTool(env, "fill", NOTES);
    check("a field with residual content still reports Filled. after typing", result === "Filled.", result);
    check("…the typed value is there", env.page.typedValue() === `Draft.${NOTES.value}`, env.page.typedValue());
    check("…the action is on the trail", (env.actionTrail as RecordedAction[]).length === 1);
    check(
      "…and the control is NOT recorded as undriven",
      (env.undrivenControls as UndrivenControl[]).length === 0,
      JSON.stringify(env.undrivenControls),
    );
  }

  // 4 — hard evidence outranks it. A 500 beside the failed fill is the
  // product's own answer and the step is left exactly as written.
  {
    const env = stubEnv({ fillThrows: true, typingWorks: false });
    await executeTool(env, "fill", NOTES);
    const step: ReportedStep = {
      label: "Submit the form",
      status: "broken",
      attempted: "Filled the form and submitted",
      observed: "POST /api/checks returned HTTP 500 and no check was created.",
    };
    await executeTool(env, "report_step", step as unknown as Record<string, unknown>);
    check("a 500 beside the failed fill keeps the step as the model wrote it", step.status === "broken", step.status);
  }

  // 4b — but a NUMBER is not a status code. We walk arbitrary customer forms,
  // and a price in the 400–599 range read as hard evidence would leave the step
  // published as the product's defect — the rule 8 failure this change closes,
  // reappearing as a coincidence of arithmetic.
  {
    for (const observed of [
      "Typed 499.00 into the price field and nothing happened.",
      "Set the quantity to 500 and the total never updated.",
      "Order #412 was already in the list; the new one never appeared.",
    ]) {
      const env = stubEnv({ fillThrows: true, typingWorks: false });
      await executeTool(env, "fill", NOTES);
      const step: ReportedStep = { label: "Set a price", status: "broken", attempted: "Typed a price", observed };
      await executeTool(env, "report_step", step as unknown as Record<string, unknown>);
      check(`a bare number is not hard evidence: ${JSON.stringify(observed.slice(0, 40))}`, step.status === "skipped", step.status);
    }
    // …and the real thing still is, in the shapes a model actually writes.
    for (const observed of [
      "POST /api/price returned HTTP 500 and the price never saved.",
      "The save request answered 422 and the form stayed open.",
      "GET /api/orders 503 — the list never loaded.",
      "A console error (TypeError) fired and the field stayed empty.",
    ]) {
      const env = stubEnv({ fillThrows: true, typingWorks: false });
      await executeTool(env, "fill", NOTES);
      const step: ReportedStep = { label: "Save the price", status: "broken", attempted: "Saved", observed };
      await executeTool(env, "report_step", step as unknown as Record<string, unknown>);
      check(`a real response is still hard evidence: ${JSON.stringify(observed.slice(0, 40))}`, step.status === "broken", step.status);
    }
  }

  // 5 — an ok step is never touched, and neither is a step reported with no
  // failure behind it.
  {
    const env = stubEnv({ fillThrows: true, typingWorks: false });
    await executeTool(env, "fill", NOTES);
    const ok: ReportedStep = { label: "Read the pricing page", status: "ok", attempted: "Opened /pricing", observed: "It rendered." };
    coerceUndrivenControl(ok, env);
    check("an ok step is untouched", ok.status === "ok");
    const clean: ReportedStep = { label: "Open the form", status: "broken", attempted: "Opened it", observed: "It rendered blank." };
    coerceUndrivenControl(clean, { undrivenControls: [] });
    check("with nothing undriven, a broken step stays broken", clean.status === "broken");
  }

  // 6 — the gap class exists, has its own label, and the fallback text rule
  // finds it for a row that carries no class of its own.
  {
    check("the capability has a label of its own", Boolean(GAP_CLASSES.undriven_control?.label));
    check(
      "the text fallback classifies the coerced sentence",
      classifyGap({ text: "Enter test credentials. This control could not be exercised this run." }) ===
        "undriven_control",
    );
    check(
      "a slider still belongs to its own class, not this one",
      classifyGap({ text: "The sliders could not be exercised this run." }) === "range_input",
    );
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main();
