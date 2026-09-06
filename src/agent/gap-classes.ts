// Capability-gap classes (CHE-198).
//
// CLAUDE.md rule 2: a step our checker could not verify is a ticket on OUR
// board, deduped by capability and counted across every app that trips it.
// Until 2026-09-06 the capability was guessed at filing time from the step's
// stored text — and since CHE-180 that text is the customer's copy, with every
// sentence naming our machinery already cut. The words the classifier keyed on
// ("opens in a new tab, which our browser cannot follow") were exactly the
// words the scrub removes, so run #154's new-tab link and run #153's slider
// both landed on the one bucket nobody learns from (CHE-86, 20 occurrences,
// no capability named).
//
// The class is now decided where the evidence still exists — at report time,
// from the model's own words and the machine trail of the step — and written
// to the row (Step.gapClass). Filing reads the class; it never guesses again.
// The text rules below still run at filing time for rows written before the
// column existed, and as the last resort when a class was never recorded.
//
// The labels are the dedup identity of the tickets on our board: one class =
// one ticket forever. An existing label must never change spelling, or its
// ticket forks. New classes get new labels.

import type { RecordedAction } from "./tools";
import { isTargetHost } from "./tools";

export type GapClass =
  | "new_tab"
  | "oauth"
  | "passwordless"
  | "verification_code"
  | "media_devices"
  | "captcha"
  | "test_records"
  | "file_transfer"
  | "range_input"
  | "third_party_block"
  | "egress_unreachable"
  | "unclassified";

export const GAP_CLASSES: Record<GapClass, { label: string; why: string }> = {
  new_tab: {
    label: "Checker cannot follow links that open in a new tab",
    why: "Outbound links are a large share of what owners worry about. verify_links resolves them server-side — the walker must reach for it automatically instead of leaving the step unverified.",
  },
  oauth: {
    label: "Checker cannot complete third-party OAuth sign-in",
    why: "Any app whose only login is Google/GitHub is unverifiable behind the login wall — a whole class of customers we cannot serve end to end.",
  },
  passwordless: {
    label: "Checker cannot complete passwordless / magic-link sign-in",
    why: "Magic-link products have NO password to hand us — no amount of owner input unblocks it. We need a mailbox the agent can read for test accounts; until then the entire signed-in half of every passwordless app is invisible to us.",
  },
  verification_code: {
    label: "Checker cannot complete an emailed/SMS verification code step",
    why: "MFA-protected accounts stop the walk at the door. Needs a mailbox/code channel the agent can read for test accounts.",
  },
  media_devices: {
    label: "Checker has no camera/microphone for media flows",
    why: "Video/voice products cannot be walked past the device prompt without synthetic media devices.",
  },
  captcha: {
    label: "Checker is blocked by CAPTCHA/bot protection on the target",
    why: "Owners must be able to allowlist us, or we silently lose coverage of their signup/login.",
  },
  test_records: {
    label: "Checker leaves test records behind in the customer's product",
    why: "Cleanup is the whole basis on which owners let us create anything. One orphan and the permission is rightly withdrawn — and the product fills with our junk (our own self-check left a live app plus a daily watch on your-app.com).",
  },
  file_transfer: {
    label: "Checker cannot drive file upload/download flows",
    why: "Upload-centric products (documents, images, CVs) have their core action unverified.",
  },
  range_input: {
    label: "Checker cannot drag a range input (slider)",
    why: "A range input takes a value from fill but the product listens for the drag — the walk set the value and nothing the user would see happened (run #153, joblander.app settings sliders). Every preference, volume, opacity or price-range control is unverified until the walker can drag.",
  },
  third_party_block: {
    label: "Checker is turned away by a bot challenge or 403 on a third-party host",
    why: "A host the product hands the user to (a domain broker, a video site, a share widget) refuses traffic from where we run. The journey stops at their door, not the product's — the step must be verified from a path that host accepts, or from the product's side of the hand-off.",
  },
  egress_unreachable: {
    label: "Checker cannot reach a host from where it runs",
    why: "A fetch that times out or is reset from our network says nothing about the link (CHE-190). Until the check can go out through a path the host answers, every outbound link to it is coverage we do not have.",
  },
  unclassified: {
    label: "Checker could not verify a step for an unclassified reason",
    why: "Unclassified coverage gaps are the ones we learn least from — the step text below should become its own capability entry.",
  },
};

export function isGapClass(value: string | null | undefined): value is GapClass {
  return typeof value === "string" && value in GAP_CLASSES;
}

// ─── Text rules ──────────────────────────────────────────────────────────────
//
// The eight original classes keep their patterns and their order (the first
// match wins, so reordering would move a step that matches two). The three new
// classes come after them, and the machine-trail rules after the text.

const TEXT_RULES: { match: RegExp; cls: GapClass }[] = [
  { match: /new tab|target=_?"?_blank|could not follow|cannot follow|opens? in a new/i, cls: "new_tab" },
  { match: /oauth|continue with google|social login|sign in with (google|github|apple)/i, cls: "oauth" },
  // CHE-104: "email link" alone used to land here, so an ordinary mailto:
  // contact link on nkem.dev was filed as a missing sign-in capability. The
  // match needs sign-in context; mailto: is handled by verify_links and is not
  // a gap at all.
  {
    match: /magic link|passwordless|(email|sign-?in|login)[ -]link (sign|log)[ -]?in|sign-?in (by|via) email/i,
    cls: "passwordless",
  },
  { match: /verification code|2fa|mfa|one-?time (code|password)|otp/i, cls: "verification_code" },
  { match: /camera|microphone|media device|getusermedia|webrtc/i, cls: "media_devices" },
  { match: /captcha|turnstile|recaptcha|bot (check|protection)/i, cls: "captcha" },
  { match: /leaves its test records|records still present|cleanup audit/i, cls: "test_records" },
  { match: /file (upload|picker)|download/i, cls: "file_transfer" },
  {
    match: /\bsliders?\b|range (input|control|slider)|input\[type=["']?range|type="range"|\bdrag(ged|ging)?\b(?![ -]and[ -]drop)/i,
    cls: "range_input",
  },
];

// A host turning us away: a challenge page, or the statuses a host uses for
// traffic it does not like (CHE-190). With a host other than the target named
// it is the third party's door; on the target itself it is the CAPTCHA class.
// 429 is deliberately not here: it is our own request volume (CLAUDE.md rule
// 3), not that host's policy — a foreign-host 429 is "we could not reach it
// from here" (egress_unreachable), and the ticket must say so.
const CHALLENGE =
  /captcha|turnstile|recaptcha|hcaptcha|bot (?:check|protection|challenge|detection)|cloudflare|security (?:verification|challenge|check)|challenge page|blocking automated|automated (?:access|traffic)|access denied|just a moment|verify you are human|refuses automated/i;
const GATE_STATUS = /\b(?:403|503)\b/;
// A host we could not reach at all: verify_links' own word, a timeout, a reset,
// and the sentence coerceUnreachable appends — the one that survives the
// customer-copy scrub.
const EGRESS =
  /\bUNREACHABLE\b|\bcould not be reached\b|\bunreachable\b|\btimed?[\s-]?out\b|\bconnection (?:reset|refused|failed|error|closed)\b|\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH)\b|\bcould not confirm (?:[a-z0-9-]+\.)+[a-z]{2,}\b[^.]*\bthis run\b/i;

const CITED_HOST = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi;
const NOT_A_HOST = /\.(?:php|html?|x?html|js|mjs|ts|tsx|css|json|xml|png|jpe?g|gif|svg|webp|ico|txt|pdf|aspx?|jsp|map|woff2?)$/i;

function foreignHosts(text: string, targetOrigin: string | undefined): string[] {
  if (!targetOrigin) return [];
  const out: string[] = [];
  for (const m of text.matchAll(CITED_HOST)) {
    const host = m[1].toLowerCase();
    if (NOT_A_HOST.test(host) || out.includes(host) || isTargetHost(host, targetOrigin)) continue;
    out.push(host);
  }
  return out;
}

// ─── Machine-trail rules ─────────────────────────────────────────────────────
//
// What the walk executed for the step (CHE-129), read when the words say
// nothing. A click on a slider role or a fill into a range input is the
// range-input class. A link click that neither navigated nor produced a
// request nor changed the page is a link the page opened somewhere we are not
// looking — the new-tab class (run #154: role "link", 0 requests, 0 mutations,
// same URL after).

function trailClass(actions: RecordedAction[]): GapClass | null {
  for (const a of actions) {
    if (a.kind === "click" && a.role?.toLowerCase() === "slider") return "range_input";
    if (a.kind === "fill" && /type=["']?range/i.test(a.selector ?? "")) return "range_input";
  }
  for (const a of actions) {
    if (
      a.kind === "click" &&
      a.role?.toLowerCase() === "link" &&
      !a.outcome.navigated &&
      a.outcome.requests === 0 &&
      a.outcome.mutations === 0
    ) {
      return "new_tab";
    }
  }
  return null;
}

export interface GapEvidence {
  /** The step's words: label, attempted, observed — the model's own where available. */
  text: string;
  /** The machine trail recorded for the step (CHE-129). */
  actions?: RecordedAction[] | null;
  /** The product's origin, so a host named in the text can be told from a third party's. */
  targetOrigin?: string;
}

// Never null: "unclassified" is the last resort, and it still files.
export function classifyGap(evidence: GapEvidence): GapClass {
  const text = evidence.text;
  const textHit = TEXT_RULES.find((r) => r.match.test(text))?.cls;
  // A challenge or gate status naming a host other than the target is that
  // host's door, whatever else the words say — checked before the captcha
  // rule above would claim it for the target.
  if ((CHALLENGE.test(text) || GATE_STATUS.test(text)) && foreignHosts(text, evidence.targetOrigin).length > 0) {
    return "third_party_block";
  }
  if (textHit) return textHit;
  if (CHALLENGE.test(text)) return "captcha";
  if (EGRESS.test(text)) return "egress_unreachable";
  return trailClass(evidence.actions ?? []) ?? "unclassified";
}

// The words a step carries, in one string, for the rules above. Every field
// the step has; the caller decides whether they are the model's or the
// customer's copy.
export function gapEvidenceText(
  ...parts: Array<string | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
