// CHE-188 verification: a finding that rests only on a skipped step is not
// written.
//
// Run #153 (joblander.app) recorded the step "Modify Insight Preferences
// (slider) and Save/Reset" as skipped / our_capability and then wrote the
// finding "Save Changes stays disabled — styling sliders didn't respond" off
// it. The synthesis prompt already forbade that; this script proves the gate
// that now sits between synthesis and persistence does what the prompt only
// asked for.
//
// Pure: no browser, no network, no model, no database. Every case below is the
// exact shape the workflow hands the gate — synthesized findings plus the
// run's journeys with their steps — so what passes here is what runs.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-findings-gate.ts

import { EXPOSED_NO_EVIDENCE, distinctiveTokens, gateFindings, type GateJourney } from "@/agent/findings-gate";
import type { SynthesizedFinding } from "@/agent/synthesis";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const titles = (fs: Array<{ title: string }>) => fs.map((f) => f.title).join(" | ") || "(none)";

// ─── Run #153, as recorded ────────────────────────────────────────────────────

const SKIPPED_SLIDER = {
  label: "Modify Insight Preferences (slider) and Save/Reset",
  status: "skipped",
  unverifiedReason: "our_capability",
  observed:
    "The Insight Preferences sliders were not moved; Save Changes stayed disabled and nothing was sent.",
};

const SLIDER_FINDING: SynthesizedFinding = {
  title: "Save Changes stays disabled — styling sliders didn't respond",
  category: "confusing",
  severity: "low",
  detail: {
    where: "/settings — Insight Preferences",
    whatWeTried: ["Tried to move the Insight Preferences sliders to enable Save Changes"],
    whatHappened: "The sliders did not move and Save Changes stayed disabled.",
    whyItMatters: "An owner who cannot change a preference will assume the setting is broken.",
  },
  stepRef: { journeyIndex: 1, stepIndex: 2 },
};

// Two journeys around it so indices are exercised, not just the first slot.
const RUN_153: GateJourney[] = [
  {
    steps: [
      { label: "Open the landing page", status: "ok", unverifiedReason: null, observed: "Landing rendered." },
      { label: "Sign in with the test account", status: "ok", unverifiedReason: null, observed: "Dashboard loaded." },
    ],
  },
  {
    steps: [
      { label: "Open Settings", status: "ok", unverifiedReason: null, observed: "Settings page rendered." },
      {
        label: "Toggle email notifications",
        status: "ok",
        unverifiedReason: null,
        observed: "Toggle flipped and Save Changes enabled.",
      },
      SKIPPED_SLIDER,
    ],
  },
];

function main() {
  // 1 — the #153 shape: stepRef → skipped/our_capability → dropped.
  {
    const r = gateFindings([SLIDER_FINDING], RUN_153);
    check("#153: finding with stepRef to a skipped step is dropped", r.kept.length === 0 && r.dropped.length === 1);
    check(
      "#153: the reason names the skipped step and its unverifiedReason",
      r.dropped[0]?.reason.includes(SKIPPED_SLIDER.label) && r.dropped[0]?.reason.includes("our_capability"),
      r.dropped[0]?.reason,
    );
  }

  // 2 — the same finding, stepRef pointing at a confusing step → kept. The
  // gate is about the step's status, not the finding's wording.
  {
    const journeys: GateJourney[] = [
      RUN_153[0],
      {
        steps: [
          ...RUN_153[1].steps.slice(0, 2),
          { ...SKIPPED_SLIDER, status: "confusing", unverifiedReason: null },
        ],
      },
    ];
    const r = gateFindings([SLIDER_FINDING], journeys);
    check("same finding on a confusing step is kept", r.kept.length === 1 && r.dropped.length === 0);
  }

  // 3 — every unverifiedReason counts; a stepRef to a skipped step is enough.
  for (const reason of ["missing_access", "not_applicable", null]) {
    const journeys: GateJourney[] = [
      RUN_153[0],
      { steps: [...RUN_153[1].steps.slice(0, 2), { ...SKIPPED_SLIDER, unverifiedReason: reason }] },
    ];
    const r = gateFindings([SLIDER_FINDING], journeys);
    check(`stepRef to a skipped step is dropped with unverifiedReason=${reason ?? "null"}`, r.dropped.length === 1);
  }

  // 4 — no stepRef; the words tie the finding to the skipped step and to no
  // walked step → dropped.
  {
    const { stepRef: _ref, ...noRef } = SLIDER_FINDING;
    const r = gateFindings([noRef], RUN_153);
    check("no stepRef, text matches only the skipped step → dropped", r.kept.length === 0 && r.dropped.length === 1);
    check(
      "the reason says it was matched by text",
      r.dropped[0]?.reason.includes("no stepRef") && r.dropped[0]?.reason.includes(SKIPPED_SLIDER.label),
      r.dropped[0]?.reason,
    );
  }

  // 5 — no stepRef; the words also match a broken step → kept. The finding
  // has a step where something was observed, so it is not about the skipped
  // one alone.
  {
    const { stepRef: _ref, ...noRef } = SLIDER_FINDING;
    const journeys: GateJourney[] = [
      ...RUN_153,
      {
        steps: [
          {
            label: "Save Insight Preferences after moving a slider",
            status: "broken",
            unverifiedReason: null,
            observed: "Moving a slider enabled Save Changes; clicking it returned HTTP 500.",
          },
        ],
      },
    ];
    const r = gateFindings([noRef], journeys);
    check("no stepRef, text also matches a broken step → kept", r.kept.length === 1 && r.dropped.length === 0);
  }

  // 6 — an exposed finding without stepRef that matches only a skipped step is
  // dropped too, and the log says so in the words the ticket asked for.
  {
    const exposed: SynthesizedFinding = {
      title: "Insight Preferences endpoint accepts writes without a session",
      category: "exposed",
      severity: "high",
      detail: {
        where: "/settings — Insight Preferences",
        whatHappened: "The preferences request looked like it would be accepted without authentication.",
      },
    };
    const r = gateFindings([exposed], RUN_153);
    check("exposed without stepRef matching only a skipped step → dropped", r.kept.length === 0 && r.dropped.length === 1);
    check(
      "…with the specific reason",
      r.dropped[0]?.reason.startsWith(EXPOSED_NO_EVIDENCE) === true,
      r.dropped[0]?.reason,
    );
  }

  // 7 — an exposed finding WITH a stepRef to an exposed step is never dropped,
  // whatever else was skipped in the run.
  {
    const exposed: SynthesizedFinding = {
      title: "Settings page leaks another user's email in the response",
      category: "exposed",
      severity: "high",
      detail: { where: "/settings", whatHappened: "Response body contained a different account's email." },
      stepRef: { journeyIndex: 1, stepIndex: 0 },
    };
    const journeys: GateJourney[] = [
      RUN_153[0],
      { steps: [{ ...RUN_153[1].steps[0], status: "exposed" }, ...RUN_153[1].steps.slice(1)] },
    ];
    const r = gateFindings([exposed], journeys);
    check("exposed with stepRef to an exposed step → kept", r.kept.length === 1);
  }

  // 8 — findings on ok/broken/risky/confusing steps pass through untouched, in
  // order, alongside one that is dropped.
  {
    const onOk: SynthesizedFinding = {
      title: "Email toggle label is ambiguous",
      category: "polish",
      severity: "low",
      detail: { where: "/settings", whatHappened: "The toggle reads 'Notifications' with no hint of what it sends." },
      stepRef: { journeyIndex: 1, stepIndex: 1 },
    };
    const unrelated: SynthesizedFinding = {
      title: "Landing hero image is 4 MB",
      category: "polish",
      severity: "low",
      detail: { where: "/", whatHappened: "The hero loads a 4 MB PNG." },
    };
    const r = gateFindings([onOk, SLIDER_FINDING, unrelated], RUN_153);
    check(
      "findings on walked steps and unrelated findings are untouched, order preserved",
      r.kept.length === 2 && r.kept[0] === onOk && r.kept[1] === unrelated && r.dropped.length === 1,
      titles(r.kept),
    );
    for (const status of ["broken", "risky", "confusing", "exposed"]) {
      const journeys: GateJourney[] = [
        RUN_153[0],
        { steps: [RUN_153[1].steps[0], { ...RUN_153[1].steps[1], status }, SKIPPED_SLIDER] },
      ];
      const rr = gateFindings([onOk], journeys);
      check(`a finding with stepRef to a ${status} step is never dropped`, rr.kept.length === 1);
    }
  }

  // 9 — an out-of-range stepRef is no reference; the text rule decides.
  {
    const dangling = { ...SLIDER_FINDING, stepRef: { journeyIndex: 7, stepIndex: 0 } };
    const r = gateFindings([dangling], RUN_153);
    check("out-of-range stepRef falls through to the text rule (dropped here)", r.dropped.length === 1);
  }

  // 10 — no skipped step in the run ⇒ nothing is dropped, whatever the text.
  {
    const journeys: GateJourney[] = [RUN_153[0], { steps: RUN_153[1].steps.slice(0, 2) }];
    const { stepRef: _ref, ...noRef } = SLIDER_FINDING;
    const r = gateFindings([noRef, SLIDER_FINDING], journeys);
    check("no skipped step in the run → every finding kept", r.kept.length === 2 && r.dropped.length === 0);
  }

  // 11 — empty inputs.
  {
    check("no findings → empty", gateFindings([], RUN_153).kept.length === 0);
    check("no journeys → findings pass through", gateFindings([SLIDER_FINDING], []).kept.length === 1);
    const r = gateFindings([], []);
    check("nothing in → nothing out", r.kept.length === 0 && r.dropped.length === 0);
  }

  // 12 — the tokenizer: short words and stop words are not evidence, plurals
  // fold, casing is irrelevant.
  {
    const t = distinctiveTokens("The Sliders would NOT respond; Save stayed disabled — which is Insight");
    check(
      "tokens: ≥5 letters, stop words out, plural folded, lower-cased",
      t.has("slider") && t.has("respond") && t.has("stayed") && t.has("disabled") && t.has("insight"),
      [...t].join(","),
    );
    check("tokens: 'would' and 'which' are stop words, 'save' and 'the' too short", !t.has("would") && !t.has("which") && !t.has("save"));
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main();
