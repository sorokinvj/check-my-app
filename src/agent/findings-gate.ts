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

// CHE-215 extends the same gate with the harder version of the same failure: a
// finding that rests on no step at all.
//
// Run #159 (checkmyapp.dev) published "Credential/notes field in 'Add login &
// notes' didn't accept input", whatWeTried ["Expanded the accordion",
// "Attempted to type test credentials into the notes field"]. None of the run's
// 35 steps mentions an accordion, an expansion or a failed fill; the /check
// step that exists says the URL field accepted input and the page reacted. The
// finding had a stepRef — it carries a screenshot copied from the step it named
// — so demanding a reference would not have stopped it, and its words overlap
// the walked steps heavily enough that no bag-of-words rule tells it from a
// true one ("field", "input", "accept" are the vocabulary of both).
//
// What tells them apart is the machine record. `Step.actions` (CHE-129) is
// written by the tools, never by the model, and only after Playwright has done
// the thing: a refused or errored call leaves no entry. Run #159's whole trail
// is two fills — "Email address" and the URL box — and eight link clicks. No
// control called notes, credentials or accordion was ever driven. So the rule
// is narrow and machine-anchored: when a finding's evidence is that OUR
// interaction produced nothing, the run must show that we drove that control.
// This is CLAUDE.md rule 3 ("a step that produced no effect for us proves
// nothing") given the one record that cannot be contaminated by our own prose,
// and rule 8's demand that a claim rest on evidence uncontaminated by our state.

import type { SynthesizedFinding } from "./synthesis";

export interface GateStep {
  status: string;
  unverifiedReason: string | null;
  label: string;
  observed: string | null;
  // CHE-215. Optional so the older callers and the verify scripts that build a
  // step by hand keep compiling; absent means the rule below cannot speak and
  // the finding is kept.
  attempted?: string | null;
  // JSON RecordedAction[] — what the browser actually executed for this step.
  actions?: string | null;
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

// CHE-215: the reason string for a finding whose evidence is that one of our
// interactions produced nothing, in a run whose action trail shows we never
// drove that control.
export const NO_INTERACTION_RECORDED = "no interaction recorded";

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

// ─── CHE-215: the interaction anchor ─────────────────────────────────────────

// A finding says "our interaction produced nothing" in a handful of shapes, and
// they are listed here for the same reason the leak phrasings live in
// verdict-language.ts rather than in a prompt: a new phrasing is a line added
// here, not a paragraph asked of a model. Matched against the finding's title,
// whatHappened and whatWeTried, on text with curly apostrophes folded.
export const NULL_EFFECT_PHRASES: RegExp[] = [
  /\b(?:did|does|do|would|will)\s+not\s+(?:accept|take|register|respond|react|work|open|expand|submit|fire|trigger|change|update|save|apply|appear|load)\b/,
  /\b(?:didn|doesn|don|wouldn|won|couldn|can)'?t\s+(?:accept|take|register|respond|react|work|open|expand|submit|fire|trigger|change|update|save|apply|appear|load)\b/,
  /\b(?:could|can)\s?not\s+(?:enter|type|input|fill|click|press|expand|collapse|toggle|select|drag|upload|interact|reach|scroll)\b/,
  /\b(?:couldn|can)'?t\s+(?:enter|type|input|fill|click|press|expand|collapse|toggle|select|drag|upload|interact|reach|scroll)\b/,
  /\b(?:no|without\s+any?)\s+(?:visible\s+|apparent\s+)?(?:effect|reaction|response|change|feedback)\b/,
  /\bnothing\s+(?:happened|happens|occurred|changed|was\s+sent)\b/,
  /\b(?:stayed|stays|stayed|remained|remains|stay)\s+(?:disabled|empty|blank|unchanged|greyed|grayed|inert|closed)\b/,
  /\b(?:not|never|un)\s?(?:clickable|reachable|interactable|editable|typeable|selectable)\b/,
  /\b(?:aren|isn|weren|wasn)'?t\s+(?:clickable|reachable|interactable|editable|selectable)\b/,
  /\b(?:input|fill|click|typing)\s+(?:attempt\s+)?(?:did\s+not|didn'?t)\b/,
  /\bhad\s+no\s+(?:effect|result)\b/,
];

// Which hand did the finding claim to use. Kept apart because the trail is
// kept apart: run #159's words tie it to a "check" the run really did click
// ("Check your app →", a link on the way to the page), while the fill it
// actually claims — typing into a credentials field — has a trail of its own
// with one entry, "Email address". Matching a fill claim against clicks is how
// a navigation link ends up vouching for a form control.
export type ClaimedHand = "fill" | "click";

const FILL_WORDS =
  /\b(?:type|typed|typing|enter|entered|entering|input|inputs|inputted|fill|filled|filling|paste|pasted|text|credential|credentials|password|keystroke)\b/;
const CLICK_WORDS =
  /\b(?:click|clicked|clicking|press|pressed|pressing|tap|tapped|button|expand|expanded|collapse|collapsed|toggle|toggled|select|selected|accordion|dropdown|checkbox|slider|drag|dragged)\b/;

// Does this finding's evidence amount to "we acted and nothing came back", and
// with which hand? Empty means no such claim — a finding about a wrong price, a
// 500, a console exception or a dead outbound link says nothing about our own
// hands and is never touched here.
export function claimedHands(f: SynthesizedFinding): ClaimedHand[] {
  const d = f.detail ?? {};
  const text = [f.title, d.whatHappened ?? "", ...(Array.isArray(d.whatWeTried) ? d.whatWeTried : [])]
    .join(" · ")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'");
  if (!NULL_EFFECT_PHRASES.some((re) => re.test(text))) return [];
  const hands: ClaimedHand[] = [];
  if (FILL_WORDS.test(text)) hands.push("fill");
  if (CLICK_WORDS.test(text)) hands.push("click");
  return hands;
}

// One entry of Step.actions. Only the human-readable identity of a control is
// read: `label` (a fill's field label) and `name` (a click's accessible name).
// A CSS selector is our machinery — matching on it lets "input[type=text]"
// vouch for any finding that says "input" — and a URL is a place, not a
// control.
interface TrailEntry {
  kind?: unknown;
  label?: unknown;
  name?: unknown;
}

// The controls this run actually drove, as tokens, one set per hand.
// `recorded` is false when no step carried a parseable trail at all — runs from
// before CHE-129, and any run whose steps recorded nothing executable. A hand
// whose set is empty says nothing either: a control named "Save" or "Buy" has
// no token of its own, so an empty set is silence, never a denial. In both
// cases the finding is kept.
export function drivenControls(steps: GateStep[]): {
  recorded: boolean;
  fill: Set<string>;
  click: Set<string>;
} {
  const fill = new Set<string>();
  const click = new Set<string>();
  let recorded = false;
  for (const s of steps) {
    if (!s.actions) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(s.actions);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    recorded = true;
    for (const raw of parsed as TrailEntry[]) {
      if (!raw || typeof raw !== "object") continue;
      const into = raw.kind === "fill" ? fill : raw.kind === "click" ? click : null;
      if (!into) continue;
      for (const field of [raw.label, raw.name]) {
        if (typeof field !== "string") continue;
        for (const t of distinctiveTokens(field)) into.add(t);
      }
    }
  }
  return { recorded, fill, click };
}

export function gateFindings(findings: SynthesizedFinding[], journeys: GateJourney[]): GateResult {
  const kept: SynthesizedFinding[] = [];
  const dropped: GateResult["dropped"] = [];

  const steps = journeys.flatMap((j) => j.steps);
  const skipped = steps.filter((s) => s.status === "skipped");
  const walked = steps.filter((s) => s.status !== "skipped");

  // CHE-215's anchor runs whether or not anything was skipped: run #159 had
  // skipped steps, but a run with none can publish the same unsupported claim.
  const trail = drivenControls(walked);
  const anchored = (f: SynthesizedFinding): { ok: true } | { ok: false; reason: string } => {
    const hands = claimedHands(f);
    if (hands.length === 0) return { ok: true };
    // No machine trail in this run ⇒ we cannot tell what we drove, so we do not
    // pretend to. Logged by the caller as a kept finding, nothing more.
    if (!trail.recorded) return { ok: true };
    const locus = distinctiveTokens(`${f.title} ${f.detail?.where ?? ""}`);
    for (const hand of hands) {
      const drove = trail[hand];
      // Nothing nameable of that hand ⇒ silence, not a denial.
      if (drove.size === 0) continue;
      if (sharedCount(locus, drove) > 0) continue;
      return {
        ok: false,
        reason:
          `${NO_INTERACTION_RECORDED} — the finding says a ${hand} of ours produced nothing at ` +
          `"${[...locus].join(" ")}", but every ${hand} this run performed was elsewhere ` +
          `(${[...drove].join(" ")})`,
      };
    }
    return { ok: true };
  };

  // Nothing was skipped ⇒ CHE-188 has nothing to match, but the anchor still
  // does.
  if (skipped.length === 0) {
    for (const f of findings) {
      const a = anchored(f);
      if (a.ok) kept.push(f);
      else dropped.push({ finding: f, reason: a.reason });
    }
    return { kept, dropped };
  }

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
        // CHE-215: naming a walked step is not the same as that step showing
        // the interaction the finding claims failed. Run #159 named one.
        const a = anchored(f);
        if (a.ok) kept.push(f);
        else dropped.push({ finding: f, reason: a.reason });
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
    const a = anchored(f);
    if (a.ok) kept.push(f);
    else dropped.push({ finding: f, reason: a.reason });
  }

  return { kept, dropped };
}
