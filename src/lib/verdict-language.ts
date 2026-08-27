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

// Phrases that name our machinery.
const ENVIRONMENT_TERMS = [
  /\b(our|the|this)\s+test\s+browser\b/i,
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
  /\bverify\s+(this|it|them|that|these)?\s*(manually|yourself)?\s*(in|with|using)\s+(a\s+)?real\s+browser\b/i,
  /\b(check|test|try|confirm|verify)\s+[^.]{0,40}\bin\s+(a\s+)?(real|normal|regular|actual)\s+browser\b/i,
  /\bneeds?\s+(a\s+)?(real|manual|human)[- ]browser\s+check\b/i,
  /\bspot-?check\s+[^.]{0,40}\b(yourself|manually|in\s+a\s+real\s+browser)\b/i,
  /\bbefore\s+treating\s+it\s+as\s+broken\b/i,
  /\bmanual(ly)?\s+verif(y|ication)\s+(is\s+)?(needed|required|recommended)\b/i,
];

const ALL_TERMS = [...ENVIRONMENT_TERMS, ...DELEGATION_TERMS];

export function environmentLeaks(text: string | null | undefined): string[] {
  if (!text) return [];
  return ALL_TERMS.filter((re) => re.test(text)).map((re) => re.source);
}

export function hasEnvironmentLeak(text: string | null | undefined): boolean {
  return environmentLeaks(text).length > 0;
}

// Last-resort scrub: drop the sentences that leak, keep the rest. Returns null
// when nothing survives — the caller then omits the text entirely rather than
// shipping a mangled half-sentence.
export function stripEnvironmentLeak(text: string | null | undefined): string | null {
  if (!text) return null;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !hasEnvironmentLeak(s));
  const out = kept.join(" ").replace(/\s+/g, " ").trim();
  return out.length >= 20 ? out : null;
}

// The instruction block shared by every prompt that produces customer-facing
// prose, so the rule is written once.
export const CUSTOMER_LANGUAGE_RULES = `LANGUAGE OF EVERYTHING THE CUSTOMER READS (absolute):
- NEVER mention our machinery: our test browser, headless, Playwright, our
  agent's environment, request/mutation counts. The customer bought a verdict,
  not a tour of our infrastructure. How we check is our business.
- NEVER hand verification back: no "verify in a real browser", "spot-check this
  yourself", "confirm manually". They pay us to do exactly that. If we could not
  verify something, the honest sentence is "we could not verify X this run" —
  a statement about our coverage, with no homework for them.
- An interaction that produced no effect for US, with no error and no failure
  evidence, is NOT a finding and NOT a problem. It is an unverified step. Say
  so as coverage ("we could not confirm X"), never as a defect, and never with
  an explanation of why our side struggled.
- Asking the owner for INPUTS we genuinely need (test credentials, a staging
  URL) is allowed and welcome — that is not verification work, that is access.`;
