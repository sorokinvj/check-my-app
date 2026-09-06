// CHE-188: a finding that rests only on a skipped step is not written.
//
// Run #153 (joblander.app): the step "Modify Insight Preferences (slider) and
// Save/Reset" was recorded skipped / our_capability — our fill did not move the
// range inputs, which is our incapacity, not their defect. Synthesis wrote the
// finding "Save Changes stays disabled — styling sliders didn't respond"
// anyway, with a stepRef pointing at that very step. It was low/confusing, so
// no ticket went out, but the owner read it on the verdict page. CLAUDE.md
// rule 3: an interaction that produced nothing for us is not evidence. The
// synthesis prompt has said "a skipped step must never become a finding" since
// CHE-82; a prompt is a request, and this is the mechanism.
//
// Pure: no database, no model. The workflow calls it between synthesis and
// persistence, so a dropped finding never reaches a row, a ticket or the page.
// The bottom line is not touched here — the coverage sentence for a skipped
// step is already written by CHE-107, and the integrity check that runs after
// persistence (workflow.ts checkVerdictIntegrity) downgrades a verdict that
// leaned on a finding this gate removed.

import type { SynthesizedFinding } from "./synthesis";

export interface GateStep {
  status: string;
  unverifiedReason: string | null;
  label: string;
  observed: string | null;
}

export interface GateJourney {
  steps: GateStep[];
}

export interface GateResult {
  kept: SynthesizedFinding[];
  dropped: Array<{ finding: SynthesizedFinding; reason: string }>;
}

// The reason string for the one case the ticket asked to be told apart: an
// `exposed` finding is not spared by rule (b) — a security exposure can be
// real even when our step was skipped, but then it must point at the step
// that showed it. Without a stepRef and with only skipped steps to match, it is
// dropped like any other, and the log names it so the pattern can be counted.
export const EXPOSED_NO_EVIDENCE = "exposed dropped — no step evidence";

// Two shared distinctive tokens is the threshold: one is a coincidence ("page"
// is on every step), two names a control ("insight" + "preferences").
const SHARED_TOKENS_MIN = 2;

// Words of five letters or more carry the identity of a control or a page;
// these are the ones of that length that carry none, so they cannot be the
// two tokens that tie a finding to a step.
const STOP_WORDS = new Set([
  "about",
  "above",
  "after",
  "again",
  "against",
  "along",
  "already",
  "although",
  "always",
  "among",
  "another",
  "anything",
  "around",
  "because",
  "before",
  "being",
  "below",
  "between",
  "cannot",
  "could",
  "during",
  "either",
  "every",
  "everything",
  "further",
  "having",
  "however",
  "instead",
  "itself",
  "might",
  "neither",
  "never",
  "nothing",
  "often",
  "other",
  "others",
  "otherwise",
  "rather",
  "should",
  "since",
  "still",
  "their",
  "there",
  "these",
  "those",
  "though",
  "through",
  "toward",
  "towards",
  "under",
  "until",
  "unless",
  "where",
  "whether",
  "which",
  "while",
  "whose",
  "within",
  "without",
  "would",
  "seems",
  "appears",
  "appear",
  "doesn",
  "didn",
  "wasn",
  "isn",
  "aren",
  "weren",
  "hasn",
  "haven",
  "couldn",
  "wouldn",
  "shouldn",
]);

// Lower-cased letter runs of five or more, stop words removed, a plural "s"
// folded so "slider" in a label meets "sliders" in a finding.
export function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (raw.length < 5 || STOP_WORDS.has(raw)) continue;
    const word = raw.length > 5 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    out.add(word);
  }
  return out;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

function findingText(f: SynthesizedFinding): string {
  const d = f.detail ?? {};
  return [f.title, d.whatHappened ?? "", d.where ?? ""].join(" ");
}

function stepText(s: GateStep): string {
  return `${s.label} ${s.observed ?? ""}`;
}

export function gateFindings(findings: SynthesizedFinding[], journeys: GateJourney[]): GateResult {
  const kept: SynthesizedFinding[] = [];
  const dropped: GateResult["dropped"] = [];

  const steps = journeys.flatMap((j) => j.steps);
  const skipped = steps.filter((s) => s.status === "skipped");
  // Nothing was skipped ⇒ nothing here can be about a skipped step.
  if (skipped.length === 0) return { kept: [...findings], dropped };

  const walked = steps.filter((s) => s.status !== "skipped");
  const skippedTokens = skipped.map((s) => ({ step: s, tokens: distinctiveTokens(stepText(s)) }));
  const walkedTokens = walked.map((s) => distinctiveTokens(stepText(s)));

  for (const f of findings) {
    // Rule (a): the finding names its step, and that step was skipped. Any
    // unverifiedReason — our_capability, missing_access, not_applicable — is
    // a step where nothing was observed, and a finding needs an observation.
    // A stepRef to a broken/exposed/risky/confusing step is never dropped;
    // an out-of-range stepRef is no reference at all and falls to rule (b).
    const ref = f.stepRef ? journeys[f.stepRef.journeyIndex]?.steps[f.stepRef.stepIndex] : undefined;
    if (ref) {
      if (ref.status === "skipped") {
        dropped.push({
          finding: f,
          reason: `rests on skipped step "${ref.label}" (${ref.unverifiedReason ?? "no reason recorded"})`,
        });
      } else {
        kept.push(f);
      }
      continue;
    }

    // Rule (b): no step named. The finding is about a skipped step when its
    // words tie it to one and to no step we actually walked — i.e. the only
    // step it can be about is one where nothing was observed.
    const tokens = distinctiveTokens(findingText(f));
    const match = skippedTokens.find((s) => sharedCount(tokens, s.tokens) >= SHARED_TOKENS_MIN);
    const alsoWalked = walkedTokens.some((t) => sharedCount(tokens, t) >= SHARED_TOKENS_MIN);
    if (match && !alsoWalked) {
      dropped.push({
        finding: f,
        reason:
          f.category === "exposed"
            ? `${EXPOSED_NO_EVIDENCE} — matches only skipped step "${match.step.label}"`
            : `no stepRef; matches only skipped step "${match.step.label}" (${match.step.unverifiedReason ?? "no reason recorded"})`,
      });
      continue;
    }
    kept.push(f);
  }

  return { kept, dropped };
}
