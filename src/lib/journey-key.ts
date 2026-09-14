// Journey identity (CHE-231).
//
// A UX journey is the unit of a run, and a unit needs a name that survives the
// model's vocabulary. It does not have one today: the walker writes a free-text
// title every run, so joblander.app's 228 journey rows carry 167 distinct
// titles for roughly a dozen actual journeys — "Sign up for a new account",
// "Sign Up / Create Account", "Account Registration" and 23 other spellings all
// mean "someone signs up".
//
// This module decides, deterministically, whether two titles are the same
// journey. It is pure (no DB, no Next, no workerd APIs) so
// scripts/verify-journey-identity.ts can drive it from Node against the real
// production titles.
//
// Three stages, cheapest and most certain first:
//
//   1. The same normalised title is the same journey. Always right, no rules.
//   2. An ANCHOR — the first recognisable intent in the title ("sign up",
//      "log in", "install the extension", "pricing"). One anchor, one journey
//      per app: an app has a sign-up journey, not four of them. This is a
//      deliberate choice, and the alias list on the catalog row is its audit
//      trail: every wording we merged stays visible.
//   3. Anchorless titles ("Practice an interview with the AI coach") are
//      matched on the overlap of their content tokens — at least two shared
//      tokens, and at least half of the shorter title's tokens. One shared word
//      never merges two journeys.
//
// Everything here is crude on purpose: a 40-line stemmer and a table of
// intents beat an LLM at this because it gives the same answer every run,
// which is the entire point.

/** The intents we recognise, in table order (used only to break a positional tie). */
const ANCHORS: Array<{ key: string; pattern: RegExp }> = [
  // Before signup/login: "reset your password" contains neither, but "forgot
  // password? sign in" contains both and is the reset journey.
  { key: "password-reset", pattern: /\b(reset|forgot|forgotten|recover)\b[^.]{0,20}\bpassword\b/ },
  { key: "delete-account", pattern: /\b(delete|close|remove)\b[^.]{0,15}\baccount\b/ },
  {
    key: "signup",
    pattern:
      /\b(sign ?up|signup|signs up|register|registration|registering|create (an? )?(new )?account|account creation|creating an account|open an account)\b/,
  },
  { key: "login", pattern: /\b(log ?in|login|logs in|sign ?in|signs in|authenticate|authentication)\b/ },
  { key: "logout", pattern: /\b(log ?out|logout|sign ?out|signout)\b/ },
  {
    key: "install-extension",
    pattern: /\b(install|installing|installation|add)\b[^.]{0,25}\b(extension|add-?on|plugin)\b/,
  },
  {
    key: "billing",
    pattern:
      /\b(pricing|plans?|purchase|purchasing|buy|checkout|payment|pay|upgrade|subscribe|subscription|billing|invoice|minute packs?|credits?)\b/,
  },
  {
    key: "settings",
    pattern:
      /\b(settings|preferences|configure|configuring|configuration|personalis[ae]|personaliz[ae]|personalisation|personalization)\b/,
  },
  {
    key: "tutorials",
    pattern:
      /\b(tutorials?|guides?|getting started|documentation|docs|help cent(er|re)|onboarding|onboard|walkthrough|how to use)\b/,
  },
  { key: "localization", pattern: /\b(localis|localiz|i18n|languages?|translat)/ },
  { key: "support", pattern: /\b(support|contact|report (an? )?(issue|bug|problem)|feedback)\b/ },
  { key: "invite", pattern: /\b(invite|invitation|referral|refer a)\b/ },
  { key: "export", pattern: /\b(export|download)\b/ },
  { key: "notifications", pattern: /\b(notifications?|alerts?|emails? preferences)\b/ },
  { key: "dashboard", pattern: /\b(dashboard)\b/ },
];

// Words that carry no journey meaning. "user", "visitor" and friends are here
// because every second title opens with them: "New user signs up", "Visitor
// learns the product", "Authenticated user starts practice".
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "with", "without", "via", "in", "on", "at",
  "as", "by", "from", "into", "then", "after", "before", "while", "that", "this", "it", "its",
  "my", "your", "our", "their", "his", "her", "them", "you", "we",
  "new", "existing", "first", "time", "again", "still", "just", "only", "also", "more", "most",
  "user", "users", "visitor", "visitors", "customer", "customers", "someone", "somebody",
  "people", "person", "member", "account holder",
  "journey", "flow", "path", "step", "steps", "scenario", "case",
  "app", "application", "product", "site", "website", "page", "pages", "platform", "service",
  "core", "primary", "secondary", "main", "key", "value", "action", "actions",
  "try", "trying", "attempt", "attempts", "attempting", "test", "testing", "check", "checking",
  "verify", "verifying", "ensure", "make", "sure", "able", "can", "could", "should", "would",
  "real", "live", "full", "complete", "successful", "successfully", "properly", "correctly",
  "up", "out", "down", "off", "over", "through", "across", "back",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "has", "have", "had",
  "authenticated", "unauthenticated", "logged", "signed",
]);

// Verbs that mean the same thing for our purposes. Applied after stemming, so
// the left-hand sides are stems.
const SYNONYMS: Record<string, string> = {
  // Looking at something.
  explor: "view", brows: "view", read: "view", see: "view", look: "view", visit: "view",
  discov: "view", review: "view", inspect: "view", navigat: "view", open: "view",
  // Making something.
  creat: "build", add: "build", writ: "build", compos: "build", author: "build", draft: "build",
  lock: "build", sav: "build", submit: "build",
  // Changing something.
  edit: "manag", updat: "manag", modify: "manag", chang: "manag", management: "manag",
  // Starting something.
  start: "start", begin: "start", launch: "start", initiat: "start", run: "start", tak: "start",
  // Domain-neutral near-synonyms that show up everywhere.
  learn: "tutorial", tutorial: "tutorial", guid: "tutorial",
  demo: "demo", showcas: "demo", preview: "demo", trial: "demo",
  practic: "practic", rehears: "practic", mock: "practic",
  histori: "histori", past: "histori", previou: "histori", record: "histori",
};

/** Lower-case, drop decorations, and split into stemmed content tokens. */
export function tokenize(title: string): string[] {
  const base = normalizeTitle(title);
  const out: string[] = [];
  for (const raw of base.split(" ")) {
    if (!raw) continue;
    if (STOPWORDS.has(raw)) continue;
    const stemmed = stem(raw);
    if (!stemmed || stemmed.length < 2) continue;
    if (STOPWORDS.has(stemmed)) continue;
    const token = SYNONYMS[stemmed] ?? stemmed;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * The title with its decoration removed: lower case, parentheticals dropped
 * ("(primary value action)", "(no login)"), separators flattened. This is what
 * anchors are matched against and what exact-match comparison uses.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[–—→>|/&:;,.!?"'`]+/g, " ")
    .replace(/[^a-z0-9+\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The journey's headline intent, or null when the title names none. Chosen by
 * position in the title — "Install the extension and sign up" is the install
 * journey, "Sign up and install the extension" is the sign-up one — with the
 * table order breaking a tie.
 */
export function anchorOf(title: string): string | null {
  const text = normalizeTitle(title);
  let best: { key: string; at: number; rank: number } | null = null;
  ANCHORS.forEach((anchor, rank) => {
    const at = text.search(anchor.pattern);
    if (at < 0) return;
    if (!best || at < best.at || (at === best.at && rank < best.rank)) {
      best = { key: anchor.key, at, rank };
    }
  });
  return best ? (best as { key: string }).key : null;
}

/** Everything identity is decided from. Computed once per title. */
export interface JourneySignature {
  /** Decorated title as written. */
  title: string;
  /** Lower-cased, decoration-free form — the exact-match comparison. */
  normalized: string;
  /** Headline intent, or null. */
  anchor: string | null;
  /** Stemmed content tokens, order preserved, deduped. */
  tokens: string[];
}

export function signatureOf(title: string): JourneySignature {
  return {
    title,
    normalized: normalizeTitle(title),
    anchor: anchorOf(title),
    tokens: tokenize(title),
  };
}

/** A candidate already in the app's catalog. */
export interface JourneyCandidate {
  key: string;
  title: string;
  /** Every title ever seen for this journey, the canonical one included. */
  aliases?: string[];
}

/**
 * Is `a` the same journey as `b`? The rule, in one place:
 *   - same normalised title → yes;
 *   - two different anchors → no, whatever else they share;
 *   - same anchor → yes;
 *   - neither anchored → yes when they share at least two content tokens AND
 *     at least half of the shorter title's tokens.
 * An anchored title never matches an anchorless one: an anchor is a stronger
 * statement about what the journey is than a word count.
 */
export function sameJourney(a: JourneySignature, b: JourneySignature): boolean {
  if (a.normalized && a.normalized === b.normalized) return true;
  if (a.anchor || b.anchor) return a.anchor !== null && a.anchor === b.anchor;
  const shared = a.tokens.filter((t) => b.tokens.includes(t));
  if (shared.length < 2) return false;
  const smaller = Math.min(a.tokens.length, b.tokens.length);
  return smaller > 0 && shared.length / smaller >= 0.5;
}

/**
 * The catalog entry this title belongs to, or null when it is a journey we
 * have not seen. Deterministic on ties: the earliest candidate wins, and
 * candidates are always read in catalog order (oldest first).
 */
export function matchJourney(
  title: string,
  candidates: JourneyCandidate[],
): JourneyCandidate | null {
  const sig = signatureOf(title);
  // An alias is a title we have already resolved to this entry; trust it over
  // any rule below, so a merge (or a correction) never silently reverses.
  const normalized = sig.normalized;
  for (const c of candidates) {
    const aliases = c.aliases ?? [c.title];
    if (aliases.some((a) => normalizeTitle(a) === normalized)) return c;
  }
  for (const c of candidates) {
    if (sameJourney(sig, signatureOf(c.title))) return c;
  }
  return null;
}

/**
 * A short, stable, readable key for a new catalog entry: the anchor when there
 * is one, otherwise the first three content tokens. `taken` keeps it unique
 * within the app — a suffix is the honest way to say "same shape, different
 * journey", and it only ever happens for anchorless titles.
 */
export function journeyKey(title: string, taken: Iterable<string> = []): string {
  const sig = signatureOf(title);
  const base =
    sig.anchor ??
    (sig.tokens.length ? sig.tokens.slice(0, 3).join("-") : slugFallback(sig.normalized));
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function slugFallback(normalized: string): string {
  const slug = normalized.replace(/\s+/g, "-").slice(0, 40).replace(/^-|-$/g, "");
  return slug || "journey";
}

// A deliberately crude stemmer. It exists to make "stories"/"story",
// "practicing"/"practice" and "management"/"manage" land on the same token —
// not to be linguistically correct. Rules are applied in order, at most one
// suffix each, and never below a length that would turn a word into noise.
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  if (w.length > 6 && w.endsWith("ment")) w = w.slice(0, -4);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}
