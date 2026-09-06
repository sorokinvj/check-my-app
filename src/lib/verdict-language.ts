// Customer-facing language guard (CHE-82).
//
// The verdict is a product deliverable. Our own machinery — the headless
// browser, its quirks, our tooling — is OUR problem and must never appear in
// it. Two failures kept shipping:
//   1. leaking the environment: "didn't fire in our test browser (0 requests)";
//   2. worse, handing the job back: "verify in a real browser before treating
//      it as broken" — the customer pays us precisely so they don't have to.
// Prompt rules alone failed three times (CHE-37, CHE-70, and again here), so
// this is a deterministic gate on every customer-facing string, applied after
// the model has spoken.
//
// The honest alternative is coverage language: "we could not verify X this
// run" — a fact about our coverage, with no instruction for the owner.
//
// CHE-191 added the soft imperative ("worth confirming …") — the same
// hand-off without any of the words the first gate keyed on.

// Phrases that name our machinery.
const ENVIRONMENT_TERMS = [
  // Deliberately broad: any mention at all. A narrower rule ("in a real
  // browser") missed "with a real browser" / "works in real browsers" and left
  // 40 published findings leaking after the first cleanup pass.
  /\btest browser\b/i,
  /\breal browsers?\b/i,
  /\bheadless\b/i,
  /\bplaywright\b/i,
  /\bbrowser\s+rendering\b/i,
  /\bour\s+(browser|environment|harness|agent'?s?\s+browser|crawler|tooling|automation)\b/i,
  /\bin\s+our\s+environment\b/i,
  /\bautomation\s+(context|environment)\b/i,
  /\b0\s+(network\s+)?requests?,\s*0\s+(dom\s+)?mutations?\b/i,
];

// Phrases that hand the verification back to the customer.
const DELEGATION_TERMS = [
  /\b(check|test|try|confirm|verify)\s+[^.]{0,60}\b(real|normal|regular|actual)\s+browsers?\b/i,
  /\bneeds?\s+(a\s+)?(real|manual|human)[- ]browser\s+check\b/i,
  /\bspot-?check\s+[^.]{0,40}\b(yourself|manually|in\s+a\s+real\s+browser)\b/i,
  /\bbefore\s+treating\s+it\s+as\s+broken\b/i,
  /\bmanual(ly)?\s+verif(y|ication)\s+(is\s+)?(needed|required|recommended)\b/i,
];

const ALL_TERMS = [...ENVIRONMENT_TERMS, ...DELEGATION_TERMS];

// ─── Homework (CHE-191) ──────────────────────────────────────────────────────
//
// The delegation terms above key on the words of the first leak: "verify in a
// real browser", "spot-check yourself", "confirm manually". Run #147
// (theins.ru, 2026-09-05) published, in a finding's whyItMatters: "Worth
// confirming both share flows open a working dialog and, if they're
// regionally unreliable, considering their placement." Same hand-off, none of
// those words. The family is the soft imperative — worth / consider / you may
// want to / make sure / double-check / please / we recommend / it would be
// worth — followed by a verification verb, plus the bare imperative aimed at
// the reader ("test this yourself", "try it in another browser").
//
// Two things must keep passing, or the gate eats evidence:
//   - what WE did, in the past tense: "we confirmed the link resolves",
//     "we checked both flows" — every pattern below asks for the base or -ing
//     form after a hand-off opener, and \b keeps "check" from matching
//     "checked";
//   - the product's own words: "users must confirm their email", the page
//     that says "please confirm your email", copy quoted from the site
//     ("worth $29") — see isReportedSpeech below.
const VERIFY_VERBS =
  "(?:confirm(?:ing)?|check(?:ing)?|verify(?:ing)?|test(?:ing)?|validat(?:e|ing)|" +
  "double[- ]check(?:ing)?|re-?check(?:ing)?|re-?test(?:ing)?|re-?verify(?:ing)?|" +
  "spot-?check(?:ing)?|mak(?:e|ing)\\s+sure|ensur(?:e|ing))";
// The adverbs the model puts between the opener and the verb.
const HEDGE = "(?:\\s+(?:also|quickly|briefly|just|manually|independently|separately|periodically|regularly|still))*\\s+";
// "check it yourself", "verify on your end", "try it in another browser".
const READER_SIDE =
  "(?:yourself|yourselves|manually|by\\s+hand|in\\s+person|on\\s+your\\s+(?:side|end|own)|from\\s+your\\s+(?:side|end)|" +
  "in\\s+(?:your\\s+own|another|a\\s+different|a\\s+(?:real|normal|regular|actual))\\s+browsers?|" +
  "on\\s+(?:your\\s+own|a\\s+real|a\\s+physical|an\\s+actual|another)\\s+(?:device|phone|machine|computer))";

export const HOMEWORK_PATTERNS: RegExp[] = [
  // "worth confirming …", "it's worth a quick check", "would be worth testing".
  new RegExp(`\\bworth${HEDGE}(?:a\\s+(?:quick\\s+)?(?:check|look|test|try)\\b|(?:a\\s+)?(?:quick\\s+)?${VERIFY_VERBS})`, "i"),
  // "consider verifying …" (not "considering their placement").
  new RegExp(`\\bconsider${HEDGE}${VERIFY_VERBS}`, "i"),
  // "you may want to check …", "you should verify …", "you'll want to confirm …".
  new RegExp(
    `\\byou(?:\\s+(?:may|might|could|should|will|would|can|ought\\s+to|need\\s+to|want\\s+to)|['’](?:ll|d))` +
      `(?:\\s+(?:also|probably|still|then))?(?:\\s+want\\s+to)?${HEDGE}${VERIFY_VERBS}`,
    "i",
  ),
  // "be sure to check …", "remember to verify …", "don't forget to test …".
  new RegExp(`\\b(?:be\\s+sure|remember|don['’]?t\\s+forget)\\s+to${HEDGE}${VERIFY_VERBS}`, "i"),
  // "double-check that …" on its own; "double-checked" stays (past tense).
  /\bdouble[- ]check(?:ing)?\b/i,
  // "make sure the dialog opens" / "ensure the flow works": verification of an
  // outcome. "Make sure the copy is translated" is a fix, and passes.
  new RegExp(
    `\\b(?:make\\s+sure|be\\s+sure|ensure)\\b(?:\\s+that)?(?:\\s+[\\w'’-]+){0,8}?\\s+` +
      `(?:opens?|works?|loads?|renders?|responds?|resolves?|succeeds?|behaves?|functions?|fires?|completes?|` +
      `goes\\s+through|(?:is|are|stays?|remains?)\\s+(?:working|reachable|visible|clickable|responsive|functional|up))\\b`,
    "i",
  ),
  // "we recommend verifying …", "recommend that you confirm …", "Recommended: check …".
  new RegExp(`\\brecommend(?:ed|s|ation)?:?(?:\\s+that)?(?:\\s+you)?${HEDGE}${VERIFY_VERBS}`, "i"),
  // "please confirm …", "please verify …", "please try it in …". Not "please
  // try again": that is what an error banner says, and it is quoted as evidence.
  new RegExp(`\\bplease${HEDGE}(?:${VERIFY_VERBS}|try\\s+(?:it|this|that|them|these)\\b)`, "i"),
  // "it would be worth / wise / a good idea to check …", "it's worthwhile to test …".
  new RegExp(
    `\\bit\\s+(?:would|might|may|could|is|'s|’s)\\s+(?:be\\s+)?(?:worth|wise|prudent|advisable|sensible|a\\s+good\\s+idea|worthwhile)(?:\\s+to)?${HEDGE}${VERIFY_VERBS}`,
    "i",
  ),
  // The bare imperative aimed at the reader: "test this yourself", "check it
  // manually", "verify on your end", "try it in another browser".
  new RegExp(`\\b(?:check|verify|confirm|test|validate|try|re-?check|re-?test|spot-?check)\\b(?:\\s+[\\w'’-]+){0,5}?\\s+${READER_SIDE}\\b`, "i"),
];

// The words of the product's users, not ours. A sentence that hands something
// to "users", "the user", "customers", "visitors", "readers" ("customers should
// double-check their order before paying") describes the product's UI, and a
// sentence that quotes or reports the page ("the page says please confirm your
// email") is evidence. Both must survive the gate. Preceded-by is judged inside
// the clause: "Readers can share; worth confirming the dialog opens" is still
// homework — the audience is in the other clause.
const AUDIENCE = /\b(?:users?|customers?|visitors?|readers?|subscribers?|members?|shoppers?|applicants?|the\s+user|a\s+user)\b/i;
// The one ask we may make (CLAUDE.md rule 2): inputs we need. Run #62 wrote
// "please confirm the credentials are active, or supply working ones" — that
// is access, not verification work, and it stays. Narrow on purpose: the
// sentence must ask for the input or ask whether it is still good. "Needs a
// real-browser check to confirm credentials work" (run #63) is not an access
// request and stays caught.
const ACCESS_INPUT = "(?:credentials?|passwords?|test\\s+account|login\\s+details|sign-?in\\s+details|staging\\s+url|api\\s+key|invite(?:\\s+link)?)";
const ACCESS_REQUEST = new RegExp(
  `\\b(?:supply|provide|share|send|give\\s+us|we\\s+need|we\\s+would\\s+need|we'?d\\s+need)\\b[^.]{0,40}\\b${ACCESS_INPUT}\\b` +
    `|\\b${ACCESS_INPUT}\\b[^.]{0,30}\\b(?:is|are|remains?|still)\\s+(?:active|valid|current|correct|up\\s+to\\s+date|expired|stale|revoked)\\b`,
  "i",
);
const REPORTING_VERB = /\b(?:says?|said|reads?|tells?|told|asks?|asked|prompts?|prompted|states?|stated|instructs?|instructed|warns?|warned|labell?ed|titled|reading)\b(?:\s+[\w'’-]+){0,4}\s*[:,]?\s*$/i;
const CLAUSE_BREAK_BEFORE = /.*[;—–]\s*/s;

function isReportedSpeech(sentence: string, matchIndex: number): boolean {
  const before = sentence.slice(0, matchIndex);
  if (insideQuotes(before)) return true;
  const clause = before.replace(CLAUSE_BREAK_BEFORE, "");
  return AUDIENCE.test(clause) || REPORTING_VERB.test(clause) || ACCESS_REQUEST.test(sentence);
}

// Inside an open quotation? Double quotes count by parity; single quotes are
// apostrophes unless they open a word (start or after space/bracket) or close
// one (before space/punctuation).
function insideQuotes(before: string): boolean {
  const dq = (before.match(/"/g) ?? []).length;
  if (dq % 2 === 1) return true;
  const curlyOpen = (before.match(/[“«]/g) ?? []).length;
  const curlyClose = (before.match(/[”»]/g) ?? []).length;
  if (curlyOpen > curlyClose) return true;
  const singleOpen = (before.match(/(?:^|[\s(\[])[‘']/g) ?? []).length;
  const singleClose = (before.match(/[’'](?=[\s.,;:!?)\]]|$)/g) ?? []).length;
  return singleOpen > singleClose;
}

// The earliest homework in one sentence, if any — the pattern and where it
// starts — skipping matches that are the product's own words.
export function homeworkIn(sentence: string): { pattern: RegExp; index: number } | null {
  let best: { pattern: RegExp; index: number } | null = null;
  for (const re of HOMEWORK_PATTERNS) {
    const m = re.exec(sentence);
    if (!m || isReportedSpeech(sentence, m.index)) continue;
    if (!best || m.index < best.index) best = { pattern: re, index: m.index };
  }
  return best;
}

export function isHomework(sentence: string): boolean {
  return homeworkIn(sentence) !== null;
}

export function hasHomework(text: string | null | undefined): boolean {
  if (!text) return false;
  return splitSentences(text).some(isHomework);
}

// What stands in when a text was nothing but homework. Coverage, not an
// instruction: the same shape as the step fallback (CHE-180).
export const HOMEWORK_FALLBACK = "We could not confirm this in this run.";

// The ask usually arrives as the tail of a sentence about the product: "…
// repeated 401s add noise to monitoring — worth confirming you're not losing
// top-of-funnel analytics" (run #12), "… may find buttons unresponsive; worth
// confirming the header doesn't shadow the CTA" (run #15). Cutting the whole
// sentence there throws the consequence away with the ask. So: when the
// homework opens a clause after a dash, semicolon, colon or comma (with or
// without a connector), the clause goes and the sentence before it stays,
// closed with a full stop; when the homework IS the sentence, the sentence
// goes. Never a fragment: a prefix under 20 characters is not kept.
const TAIL_BREAK = /(?:\s+[—–-]+\s+|;\s+|:\s+|,\s+)(?:(?:so|and|but|then|hence|thus|therefore|which\s+is\s+why)\s+)?$/i;

function cutHomework(sentences: string[]): { sentences: string[]; changed: boolean } {
  let changed = false;
  const out: string[] = [];
  for (const s of sentences) {
    const hw = homeworkIn(s);
    if (!hw) {
      out.push(s);
      continue;
    }
    changed = true;
    const prefix = s.slice(0, hw.index);
    if (!TAIL_BREAK.test(prefix)) continue;
    const head = prefix.replace(TAIL_BREAK, "").trim();
    if (head.length < 20 || isHomework(head)) continue;
    out.push(/[.!?]$/.test(head) ? head : `${head}.`);
  }
  return { sentences: out, changed };
}

// The homework goes, the rest stays as written. Text that never asked
// anything of the reader comes back unchanged; text that was only the ask
// becomes the fallback — never an empty string, never a mangled fragment.
// Machinery is stripEnvironmentLeak's job and productProse runs both; this
// exists for the two fields synthesis handles on its own (a finding's
// whyItMatters, the bottom line) and for the retro sweep.
export function stripHomework(text: string, fallback = HOMEWORK_FALLBACK): string {
  const cut = cutHomework(splitSentences(text));
  if (!cut.changed) return text;
  const out = cut.sentences.join(" ").replace(/\s+/g, " ").trim();
  return out.length > 0 ? out : fallback;
}

// A sentence that names our machinery (the CHE-82 tables). Homework is judged
// separately, because it is cut at the clause rather than the sentence.
function leaksMachinery(sentence: string): boolean {
  return ALL_TERMS.some((re) => re.test(sentence));
}

// The phrase table plus the homework family (CHE-191): "environment leak" has
// meant both halves of CLAUDE.md rule 1 since CHE-82, and every caller that
// drops or strips on it — synthesis, productizeStep's clause filter, the
// retro scripts — wants the homework caught the same way.
export function environmentLeaks(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = ALL_TERMS.filter((re) => re.test(text)).map((re) => re.source);
  for (const s of splitSentences(text)) {
    const hw = homeworkIn(s);
    if (hw && !found.includes(hw.pattern.source)) found.push(hw.pattern.source);
  }
  return found;
}

export function hasEnvironmentLeak(text: string | null | undefined): boolean {
  return environmentLeaks(text).length > 0;
}

// Last-resort scrub: drop the sentences that name our machinery, cut the
// homework (CHE-191), keep the rest. Returns null when nothing survives — the
// caller then omits the text entirely rather than shipping a mangled
// half-sentence.
export function stripEnvironmentLeak(text: string | null | undefined): string | null {
  if (!text) return null;
  const kept = splitSentences(text).filter((s) => !leaksMachinery(s));
  const out = cutHomework(kept).sentences.join(" ").replace(/\s+/g, " ").trim();
  return out.length >= 20 ? out : null;
}

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

// Words that name our side, on top of the phrase gate above. Written for the
// judge (CHE-169) and shared since CHE-180: run #144 wrote "requires
// camera/mic access unavailable in our test environment" into Step.observed,
// which the phrase gate did not catch and which the customer read on the
// verdict page. One list, used by every producer of customer-facing prose
// (judge, step text, journey summary, the live progress note).
export const MACHINERY_TERMS =
  /\b(browsers?|headless|environments?|models?|harness(es)?|playwright|screenshots?|checkers?|first reader|tooling|automation|agents?|test environment|our test)\b/i;

// Product-facing prose: the CHE-82 phrase gate and the words above, sentence
// by sentence, then the homework cut (CHE-191) — so a step, a journey summary
// or the judge's sentence ending in "worth checking …" loses that clause
// here, whichever producer wrote it. Null when nothing survives, so the
// caller falls back to a fixed product sentence rather than a mangled
// half-line.
//
// The floor (20 characters) applies only when something was actually
// dropped: a short step text that never mentioned us ("Clicked Sign in.") is
// intact and must stay as written — the floor exists to catch fragments left
// by the strip, not to reject brevity. A step label is a few words by design,
// so its caller sets the floor to 0.
export function productProse(text: string | null | undefined, floor = 20): string | null {
  if (!text) return null;
  const sentences = splitSentences(text);
  const kept = sentences.filter((s) => !leaksMachinery(s) && !MACHINERY_TERMS.test(s));
  const cut = cutHomework(kept);
  const out = cut.sentences.join(" ").replace(/\s+/g, " ").trim();
  if (!out) return null;
  if (kept.length === sentences.length && !cut.changed) return out;
  return out.length >= floor ? out : null;
}

// What is written when the model's own words did not survive the scrub. Used
// by the judge (CHE-169) and by report_step (CHE-180) alike, so the customer
// meets one sentence for one situation.
export const NOT_DEFECT_FALLBACK = "This step behaved as a user would expect; nothing failed.";
export const UNVERIFIABLE_FALLBACK = "We could not confirm this step this run.";
// A step reported as a problem whose every word was about us (CHE-180). The
// status still stands — classifyUnverified already turned a problem justified
// only by our inability into a skipped step, so what reaches here carries
// hard evidence the model phrased badly.
export const PROBLEM_FALLBACK = "This step did not behave as a user would expect.";

// The instruction block shared by every prompt that produces customer-facing
// prose, so the rule is written once.
export const CUSTOMER_LANGUAGE_RULES = `LANGUAGE OF EVERYTHING THE CUSTOMER READS (absolute):
- NEVER mention our machinery: our test browser, headless, Playwright, our
  agent's environment, request/mutation counts. The customer bought a verdict,
  not a tour of our infrastructure. How we check is our business.
- NEVER hand verification back: no "verify in a real browser", "spot-check this
  yourself", "confirm manually" — and no soft version of it either: "worth
  confirming …", "consider checking …", "you may want to verify …", "make sure
  X opens", "we recommend testing …". They pay us to do exactly that. If we
  could not verify something, the honest sentence is "we could not verify X
  this run" — a statement about our coverage, with no homework for them.
- An interaction that produced no effect for US, with no error and no failure
  evidence, is NOT a finding and NOT a problem. It is an unverified step. Say
  so as coverage ("we could not confirm X"), never as a defect, and never with
  an explanation of why our side struggled.
- Asking the owner for INPUTS we genuinely need (test credentials, a staging
  URL) is allowed and welcome — that is not verification work, that is access.`;
