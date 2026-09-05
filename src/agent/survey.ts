// The free page survey (CHE-132).
//
// No model, no browser: a plain fetch of the app's own pages, on workerd, in
// under a minute. It answers one question a full walk used to be scheduled
// for — "did anything about this app change since the last check?" — and it
// answers it from evidence the server hands out for free: the HTML of every
// page a sitemap or the homepage links to, hashed after the noise is stripped,
// plus the list of script bundles and the Next.js build id when there is one.
//
// What the hash keeps and what it drops is the whole point. Since CHE-185 the
// per-page hash is not a hash of the HTML at all but of a structural digest of
// it (pageDigest): title, description, headings, the link set, form fields,
// script and stylesheet URLs, control counts, and the visible text with every
// number and date removed. Dropped, therefore: nonces, CSRF tokens, timestamps,
// inline scripts and state blobs, attribute order, data-ids — and counters.
// Kept: hashed asset filenames and /_next/static/<buildId>/ paths — those are
// the build signal, and a deploy that changed nothing visible still changes
// them, which is exactly when a full walk is worth its cost. The old
// normalised-HTML hash is still computed and stored as rawHash so the next
// "why did this page read as changed" is answerable from the row.
//
// The crawler is GET-only and refuses anything that could be a state change
// (logout, sign-out, delete, unsubscribe): it must never be the thing that
// signed the owner's test account out or emptied a list.
//
// Budget, in order of what gives first: 8 s per request, five in flight, 45 s
// overall after which the walk stops and whatever was collected is kept. The
// daily smoke tick and the verdict email are on the same clock as before —
// this runs ahead of them and never moves them.

import { detectTech } from "@/lib/tech-signals";

// A normal desktop Chrome profile, for the same reason agentContextOptions in
// browser.ts presents one: a UA that says "bot" gets a different app than the
// customer's users see. Nothing else about the request is disguised.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 8_000;
const CONCURRENCY = 5;
const DEADLINE_MS = 45_000;
const PAGE_CAP = 50;
const SITEMAP_URL_CAP = 50;
const SITEMAP_FETCH_CAP = 3;
// A page bigger than this is not a page; hash the head of it and move on
// rather than hold megabytes of somebody's export in memory.
const MAX_BODY_CHARS = 1_500_000;
// The homepage is fetched a second time this long after the first, at the end
// of the crawl (CHE-185): a site whose digest differs between the two is
// volatile at the digest level, and snapshot.ts reads its diff accordingly.
const HOMEPAGE_RECHECK_DELAY_MS = 20_000;

// Bumped whenever what `hash` is computed over changes. Two snapshots with
// different versions are never compared (snapshot.ts): every page would read
// as changed once, and that once is a $0.60 full walk for nothing (CHE-185).
//   1 — sha256 of normalizeHtml(html), until 2026-09-05
//   2 — sha256 of pageDigest(html)
export const DIGEST_VERSION = 2;

export interface SurveyPage {
  /** Final URL after redirects. */
  url: string;
  /** Path + query as seen from the origin, "/" for the homepage. */
  path: string;
  /** HTTP status, or null when the request never got an answer. */
  status: number | null;
  title: string;
  /** sha256 of the structural page digest (pageDigest). */
  hash: string;
  /**
   * sha256 of the normalised HTML — what `hash` was before CHE-185. Never
   * compared; stored so a page that reads as changed can be told apart from
   * one whose HTML merely churned (absent on rows written before 2026-09-05).
   */
  rawHash?: string;
  /**
   * sha256 of the digest's skeleton — headings, links, form fields, assets —
   * the part of a page that per-request content does not move. What the
   * volatile rule in snapshot.ts compares (absent on older rows).
   */
  skeletonHash?: string;
  /** Number of <form> elements. */
  forms: number;
  /** Number of distinct same-origin links. */
  links: number;
}

export interface SurveyResult {
  pages: SurveyPage[];
  bundles: string[];
  buildId: string | null;
  tech: string[];
  sitemapUrls: number;
  blocked: boolean;
  fingerprint: string;
  /** The deadline or the cap stopped the walk with pages still unvisited. */
  truncated: boolean;
  /** The DIGEST_VERSION the page hashes were computed with. */
  digestVersion: number;
  /**
   * The homepage digest differed between the first fetch and one taken at the
   * end of the crawl: this site changes at the digest level between requests,
   * and text-only differences on its pages are not evidence of a change.
   */
  volatile: boolean;
}

export interface SnapshotDiff {
  addedPaths: string[];
  removedPaths: string[];
  changedPaths: string[];
  bundlesChanged: boolean;
  buildIdChanged: boolean;
  /** Pages whose digest moved on a volatile site with the skeleton intact — set aside, not a change (CHE-185). Present only when non-empty. */
  ignoredPaths?: string[];
}

/** The part of a snapshot two of which can be compared. */
export interface Comparable {
  pages: Pick<SurveyPage, "path" | "hash" | "status">[];
  bundles: string[];
  buildId: string | null;
  /** The cap or the deadline stopped this side short (CHE-179): absence from it means nothing. */
  truncated?: boolean;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SurveyOptions {
  /** Injected for tests; defaults to the platform fetch. */
  fetch?: FetchLike;
  deadlineMs?: number;
  pageCap?: number;
  concurrency?: number;
  requestTimeoutMs?: number;
  /** How long after the first homepage fetch the second one is taken (CHE-185). */
  homepageRecheckDelayMs?: number;
}

// ─── Normalisation ───────────────────────────────────────────────────────────

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
// Unix epochs in seconds or milliseconds for roughly 2017–2033: the other
// shape a "rendered at" leaks into inline state.
const EPOCH = /\b1[5-9]\d{8}(?:\d{3})?\b/g;
const NONCE_ATTR = /\s+nonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const DATA_CHURN_ATTR = /\s+data-(?:timestamp|nonce|version)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const CSRF_META = /<meta[^>]*\bname\s*=\s*["']?csrf[^>]*>/gi;
// name="_token" value="…", "csrfToken":"…", csrf_token=… — keep the key, drop
// the value, so a form still counts as the same form tomorrow.
const CSRF_VALUE =
  /((?:csrf|xsrf)[\w-]*|_token|authenticity_token)(["']?\s*[:=]\s*["']?)[^"'&\s<>]*/gi;
const CSRF_INPUT_VALUE =
  /(<input[^>]*\bname\s*=\s*["']?(?:[\w-]*(?:csrf|xsrf)[\w-]*|_token|authenticity_token)["']?[^>]*\bvalue\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const INLINE_SCRIPT = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

export function normalizeHtml(html: string): string {
  let out = html.length > MAX_BODY_CHARS ? html.slice(0, MAX_BODY_CHARS) : html;
  out = out.replace(CSRF_META, "");
  out = out.replace(INLINE_SCRIPT, (whole: string, body: string) => {
    ISO_TIMESTAMP.lastIndex = 0;
    EPOCH.lastIndex = 0;
    const churns = ISO_TIMESTAMP.test(body) || EPOCH.test(body) || /nonce/i.test(body);
    return churns ? whole.replace(body, "") : whole;
  });
  out = out.replace(NONCE_ATTR, "");
  out = out.replace(DATA_CHURN_ATTR, "");
  out = out.replace(CSRF_INPUT_VALUE, "$1\"\"");
  out = out.replace(CSRF_VALUE, "$1$2");
  out = out.replace(ISO_TIMESTAMP, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The pre-CHE-185 hash: the normalised HTML. Stored as SurveyPage.rawHash, never compared. */
export function rawPageHash(html: string): Promise<string> {
  return sha256Hex(normalizeHtml(html));
}

// ─── Structural digest (CHE-185) ─────────────────────────────────────────────
//
// Run #149 (joblander.app, 2026-09-05 16:31 UTC) read 13 pages as changed —
// every localised homepage — and walked the whole app for $0.60 on a day
// nothing was deployed: bundles equal, and the raw HTML of "/" different in
// every one of five stored snapshots. Diagnosed the same evening with the
// survey's own headers: fetches minutes apart are byte-identical (the page is
// a Next.js App Router route served from a per-instance ISR cache —
// cache-control: s-maxage=3600, x-nextjs-cache: HIT — so the survey sees
// whichever render its instance made in the last hour), and two renders 25
// minutes apart (etags zt094t3lma48aj → q1367t6xwx48aj, 197,677 chars both)
// differed in exactly one fragment, inside an inline self.__next_f.push
// flight-data script:
//   "initialCanonicalUrl":"/?_rsc=p18k4"   vs   "/?_rsc=1j6xg"
// — the RSC cache-buster of whichever request triggered that regeneration,
// baked into the HTML for everyone until the next one. Every locale is its own
// ISR entry and regenerates within the day, so all 13 moved together.
// normalizeHtml strips inline scripts only when they carry a timestamp, an
// epoch or a nonce; this one carries none, and no list of such keys will ever
// be complete. The same page also renders a live figure in the hero
// ("<span>169,500</span> insights delivered this month") that will move the
// bytes whenever it changes. A hash of the HTML therefore cannot be stable
// on any site that serialises state or renders a figure, and "a full walk
// only when the app changed" never fires for such a site: every day is a full
// run. Hence a digest of what the page IS rather than of the bytes it came in
// — the two real renders above digest identically (both stored bodies were
// re-hashed with pageHashes: hash equal, rawHash different).

const COMMENT = /<!--[\s\S]*?-->/g;
const DROP_BLOCK = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const ANY_TAG = /<[^>]*>/g;
const HEADING = /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const META_TAG = /<meta\b[^>]*>/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const FIELD_TAG = /<(input|select|textarea)\b[^>]*>/gi;
const BUTTON_TAG = /<button\b/gi;
const INPUT_TAG = /<input\b/gi;
const MAIN_BLOCK = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i;
const ARTICLE_BLOCK = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i;
const BODY_BLOCK = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;

// Dates and times in the shapes copy is written in, then every remaining
// number. Order matters: a month name is only noise when it is part of a
// date, so dates go before the digits they contain.
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const WEEKDAY =
  "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\\.?,?\\s+";
const LOOSE_DATE = new RegExp(
  `\\b(?:${WEEKDAY})?(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:,?\\s+\\d{4})?|${MONTH}\\s+\\d{4})\\b`,
  "gi",
);
const NUMERIC_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g;
const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?\b/gi;
const NUMBER = /\d[\d.,' ]*\d|\d/g;

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = tag.replace(/^<\s*[A-Za-z][\w:-]*/, "").replace(/\/?\s*>$/, "");
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(inner)) !== null) {
    if (!m[1]) continue;
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(ANY_TAG, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Visible text with every date, time and number removed. */
export function stableText(fragment: string): string {
  return textOf(fragment)
    .replace(ISO_TIMESTAMP, " ")
    .replace(NUMERIC_DATE, " ")
    .replace(CLOCK_TIME, " ")
    .replace(LOOSE_DATE, " ")
    .replace(NUMBER, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface DigestParts {
  title: string;
  description: string;
  headings: string[];
  links: string[];
  fields: string[];
  assets: string[];
  buttons: number;
  inputs: number;
  text: string;
}

function digestParts(html: string, pageUrl?: string): DigestParts {
  const src = (html.length > MAX_BODY_CHARS ? html.slice(0, MAX_BODY_CHARS) : html).replace(COMMENT, "");
  const title = extractTitle(src);

  let description = "";
  META_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = META_TAG.exec(src)) !== null) {
    const a = attrsOf(m[0]);
    if ((a.name ?? "").toLowerCase() === "description") {
      description = (a.content ?? "").replace(/\s+/g, " ").trim();
      break;
    }
  }

  const headings: string[] = [];
  HEADING.lastIndex = 0;
  while ((m = HEADING.exec(src)) !== null) headings.push(textOf(m[2]));

  const links = new Set<string>();
  HREF.lastIndex = 0;
  while ((m = HREF.exec(src)) !== null) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (!raw || raw.startsWith("#")) continue;
    let href = raw;
    try {
      const u = new URL(raw, pageUrl);
      u.hash = "";
      href = u.toString();
    } catch {
      href = raw.replace(/#.*$/, "");
    }
    if (href) links.add(href);
  }

  const fields: string[] = [];
  FIELD_TAG.lastIndex = 0;
  while ((m = FIELD_TAG.exec(src)) !== null) {
    const a = attrsOf(m[0]);
    fields.push(`${m[1].toLowerCase()}|${a.name ?? ""}|${(a.type ?? "").toLowerCase()}`);
  }

  const assets = new Set<string>();
  const noQuery = (s: string) => s.trim().replace(/[?#].*$/, "");
  SCRIPT_SRC.lastIndex = 0;
  while ((m = SCRIPT_SRC.exec(src)) !== null) {
    const s = noQuery(decodeEntities(m[1] ?? m[2] ?? m[3] ?? ""));
    if (s) assets.add(s);
  }
  LINK_TAG.lastIndex = 0;
  while ((m = LINK_TAG.exec(src)) !== null) {
    const a = attrsOf(m[0]);
    if (!/\bstylesheet\b/i.test(a.rel ?? "")) continue;
    const s = noQuery(a.href ?? "");
    if (s) assets.add(s);
  }

  BUTTON_TAG.lastIndex = 0;
  INPUT_TAG.lastIndex = 0;
  const buttons = (src.match(BUTTON_TAG) ?? []).length;
  const inputs = (src.match(INPUT_TAG) ?? []).length;

  const stripped = src.replace(DROP_BLOCK, " ");
  const region = MAIN_BLOCK.exec(stripped)?.[1] ?? ARTICLE_BLOCK.exec(stripped)?.[1] ?? BODY_BLOCK.exec(stripped)?.[1] ?? stripped;

  return {
    title,
    description,
    headings,
    links: [...links].sort(),
    fields,
    assets: [...assets].sort(),
    buttons,
    inputs,
    text: stableText(region),
  };
}

// The skeleton is the part of a page per-request content does not move:
// headings, the link set, form fields, and the script/stylesheet URLs. Text,
// counts, title and description are the rest. On a volatile site (see
// SurveyResult.volatile) a page whose skeleton is unchanged did not change.
function skeletonOf(p: DigestParts): string {
  return [
    ...p.headings.map((h) => `h:${h}`),
    ...p.links.map((l) => `a:${l}`),
    ...p.fields.map((f) => `field:${f}`),
    ...p.assets.map((a) => `asset:${a}`),
  ].join("\n");
}

function digestOf(p: DigestParts): string {
  return [
    `title:${p.title}`,
    `description:${p.description}`,
    skeletonOf(p),
    `buttons:${p.buttons}`,
    `inputs:${p.inputs}`,
    `text:${p.text}`,
  ].join("\n");
}

/** The canonical string a page hashes to. `pageUrl` resolves relative links; without it they are kept as written. */
export function pageDigest(html: string, pageUrl?: string): string {
  return digestOf(digestParts(html, pageUrl));
}

export function pageSkeleton(html: string, pageUrl?: string): string {
  return skeletonOf(digestParts(html, pageUrl));
}

export function pageHash(html: string, pageUrl?: string): Promise<string> {
  return sha256Hex(pageDigest(html, pageUrl));
}

/** Every hash a SurveyPage carries, from one parse. */
export async function pageHashes(
  html: string,
  pageUrl?: string,
): Promise<{ hash: string; rawHash: string; skeletonHash: string }> {
  const parts = digestParts(html, pageUrl);
  const [hash, rawHash, skeletonHash] = await Promise.all([
    sha256Hex(digestOf(parts)),
    rawPageHash(html),
    sha256Hex(skeletonOf(parts)),
  ]);
  return { hash, rawHash, skeletonHash };
}

// Equal inputs in any order give the same fingerprint: the survey visits
// pages in whatever order the network answered.
export function fingerprintOf(pages: Pick<SurveyPage, "hash">[], bundles: string[]): Promise<string> {
  const hashes = pages.map((p) => p.hash).sort();
  const scripts = [...new Set(bundles)].sort();
  return sha256Hex(`${hashes.join("\n")}\n--\n${scripts.join("\n")}`);
}

// ─── Link extraction ─────────────────────────────────────────────────────────

const HREF = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const TITLE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const FORM = /<form\b/gi;

const ASSET_EXT =
  /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|mjs|map|json|xml|txt|pdf|zip|gz|tar|rar|7z|mp4|mp3|wav|webm|ogg|mov|woff2?|ttf|otf|eot|csv|xlsx?|docx?|pptx?|rss|atom|ics)$/i;
// Never a crawl target: a GET here can end a session or a record.
const STATE_CHANGE = /(logout|sign-?out|delete|unsubscribe)/i;
// Path prefixes that are machinery, not pages.
const MACHINERY = /^\/(?:api|_next|_vercel|_nuxt|__|cdn-cgi|wp-json|wp-admin|graphql|oauth|auth\/callback)(?:\/|$)/i;
// A query value that looks like a token: long opaque strings, or a key that
// names one. The URL is kept without its query so the page is still surveyed.
const TOKEN_KEY = /^(?:token|key|sig|signature|session|sid|auth|code|state|nonce|hash|ref|utm_[a-z]+|fbclid|gclid)$/i;
const TOKEN_VALUE = /^[A-Za-z0-9_-]{20,}$/;

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    // Numeric entities before &amp;, so "&amp;#x27;" stays the literal it is.
    // React writes apostrophes as &#x27; — left undecoded, the digest's number
    // stripping would turn "I&#x27;m" into "I&#x;m" (CHE-185).
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** "/pricing?plan=pro" — the path a snapshot is keyed by. */
export function pathOf(url: URL): string {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  return `${p}${url.search}`;
}

// A same-origin page URL worth surveying, or null. Query strings that look
// like tokens are dropped rather than followed; the page behind them is the
// same page.
export function crawlableUrl(raw: string, base: string, origins: Set<string>): string | null {
  const trimmed = decodeEntities(raw.trim());
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(?:mailto|tel|sms|javascript|data|blob|ftp):/i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!origins.has(url.origin)) return null;
  if (MACHINERY.test(url.pathname)) return null;
  if (ASSET_EXT.test(url.pathname)) return null;
  if (STATE_CHANGE.test(url.pathname + url.search)) return null;
  url.hash = "";
  for (const [k, v] of [...url.searchParams]) {
    if (TOKEN_KEY.test(k) || TOKEN_VALUE.test(v)) {
      url.search = "";
      break;
    }
  }
  return new URL(pathOf(url), url.origin).toString();
}

export function extractLinks(html: string, pageUrl: string, origins?: Set<string>): string[] {
  const allowed = origins ?? new Set([new URL(pageUrl).origin]);
  const out = new Set<string>();
  HREF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HREF.exec(html)) !== null) {
    const url = crawlableUrl(m[1] ?? m[2] ?? m[3] ?? "", pageUrl, allowed);
    if (url) out.add(url);
  }
  return [...out];
}

// Bundles are the app's own scripts: same origin, a sibling host of the same
// site (cdn.example.com for example.com), or the static hosts apps deploy
// their own build to. Third-party scripts (analytics, payments, chat widgets)
// are left out on purpose — their versions move on their vendors' schedule,
// and a full walk of the customer's app because Intercom shipped is a walk
// nobody asked for.
const OWN_BUILD_HOSTS =
  /(?:\.|^)(?:vercel\.app|netlify\.app|pages\.dev|cloudfront\.net|web\.app|firebaseapp\.com|azureedge\.net|azurestaticapps\.net|amplifyapp\.com|herokuapp\.com|fly\.dev|onrender\.com|githubusercontent\.com)$/i;

function siteOf(host: string): string {
  const parts = host.toLowerCase().split(".");
  return parts.slice(-2).join(".");
}

export function extractBundles(html: string, pageUrl: string, origins?: Set<string>): string[] {
  const base = new URL(pageUrl);
  const allowed = origins ?? new Set([base.origin]);
  const sites = new Set([...allowed].map((o) => siteOf(new URL(o).host)));
  const out = new Set<string>();
  SCRIPT_SRC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_SRC.exec(html)) !== null) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const own = allowed.has(url.origin) || sites.has(siteOf(url.host)) || OWN_BUILD_HOSTS.test(url.host);
    if (!own) continue;
    url.hash = "";
    out.add(url.toString());
  }
  return [...out].sort();
}

// Next.js writes its build id into __NEXT_DATA__ and into the path of the
// build manifest; either is a deploy marker that survives every other kind of
// churn. "chunks", "css", "media" and "development" also live under
// /_next/static/ and are not ids.
export function extractBuildId(html: string): string | null {
  const data = html.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (data) return data[1];
  // The App Router writes it into the flight data instead, as a JSON string
  // inside a JS string: \"buildId\":\"KsTYig8L1zpL2GwSgPCrL\". Run #149's
  // joblander snapshots had "no buildId" for exactly this reason (CHE-185),
  // and it is the one deploy marker that survives every other churn.
  const flight = html.match(/\\"buildId\\"\s*:\s*\\"([^"\\]+)\\"/);
  if (flight) return flight[1];
  const manifest = html.match(/\/_next\/static\/([A-Za-z0-9_-]{6,})\/_(?:build|ssg)Manifest\.js/);
  if (manifest) return manifest[1];
  return null;
}

export function extractTitle(html: string): string {
  const m = html.match(TITLE);
  return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()).slice(0, 200) : "";
}

export function countForms(html: string): number {
  FORM.lastIndex = 0;
  return (html.match(FORM) ?? []).length;
}

// ─── Comparison ──────────────────────────────────────────────────────────────

// Share of paths two surveys have in common, against the larger of the two.
// With the crawl order deterministic, a stable site under the same cap gives
// the same pages every day and this is 1; a page added near the front shifts
// one page off the end and it is 0.98. CHE-179 sets the bar at 0.8.
export function pathOverlap(previous: Pick<SurveyPage, "path">[], current: Pick<SurveyPage, "path">[]): number {
  const before = new Set(previous.map((p) => p.path));
  const after = new Set(current.map((p) => p.path));
  const larger = Math.max(before.size, after.size);
  if (larger === 0) return 1;
  let common = 0;
  for (const path of after) if (before.has(path)) common += 1;
  return common / larger;
}

// Changed = a page both sides saw that hashes or answers differently. Added
// and removed = a page only one side saw — and that means something only when
// the other side saw everything. A previous survey the cap cut short may
// simply not have reached today's "new" page, and a page that fell off the
// cap today was not removed (CHE-179): until 2026-09-04 that pair was never
// compared at all, so every real app sat on the seven-day fuse and the
// change-driven full walk of CHE-132 never happened for any of them.
export function diffSnapshots(previous: Comparable, current: Comparable): SnapshotDiff {
  const before = new Map(previous.pages.map((p) => [p.path, p]));
  const after = new Map(current.pages.map((p) => [p.path, p]));
  const addedPaths: string[] = [];
  const removedPaths: string[] = [];
  const changedPaths: string[] = [];
  for (const [path, page] of after) {
    const old = before.get(path);
    if (!old) {
      if (!previous.truncated) addedPaths.push(path);
    } else if (old.hash !== page.hash || old.status !== page.status) changedPaths.push(path);
  }
  if (!current.truncated) {
    for (const path of before.keys()) if (!after.has(path)) removedPaths.push(path);
  }
  const bundlesChanged =
    JSON.stringify([...new Set(previous.bundles)].sort()) !==
    JSON.stringify([...new Set(current.bundles)].sort());
  return {
    addedPaths: addedPaths.sort(),
    removedPaths: removedPaths.sort(),
    changedPaths: changedPaths.sort(),
    bundlesChanged,
    buildIdChanged: previous.buildId !== current.buildId,
  };
}

export function diffIsChange(diff: SnapshotDiff): boolean {
  return (
    diff.addedPaths.length > 0 ||
    diff.removedPaths.length > 0 ||
    diff.changedPaths.length > 0 ||
    diff.bundlesChanged ||
    diff.buildIdChanged
  );
}

/** "3 pages changed since the last check: /pricing, /login, /docs" */
export function describeDiff(diff: SnapshotDiff): string {
  const paths = [...diff.changedPaths, ...diff.addedPaths, ...diff.removedPaths];
  const n = paths.length;
  if (n > 0) {
    const shown = paths.slice(0, 3).join(", ");
    const rest = n - Math.min(n, 3);
    return (
      `${n} page${n === 1 ? "" : "s"} changed since the last check: ${shown}` +
      (rest > 0 ? ` and ${rest} more` : "")
    );
  }
  if (diff.buildIdChanged) return "a new build is serving since the last check";
  if (diff.bundlesChanged) return "the app's scripts changed since the last check";
  return "nothing changed since the last check";
}

// ─── Blocked detection ───────────────────────────────────────────────────────

const CHALLENGE_STATUS = new Set([403, 429, 503]);

export function looksBlocked(status: number | null, headers: Headers | null, html: string): boolean {
  if (status === null) return true;
  if (CHALLENGE_STATUS.has(status)) return true;
  if (headers?.get("cf-mitigated")) return true;
  if (/<title[^>]*>\s*Just a moment/i.test(html)) return true;
  if (/\/_vercel\/protection|vercel-protection|__cf_chl_|cf-challenge/i.test(html)) return true;
  return false;
}

// ─── The survey ──────────────────────────────────────────────────────────────

interface Fetched {
  finalUrl: string;
  status: number | null;
  headers: Headers | null;
  html: string;
  isHtml: boolean;
}

async function fetchPage(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    const type = res.headers.get("content-type") ?? "";
    const isHtml = /text\/html|application\/xhtml/i.test(type) || type === "";
    let html = "";
    try {
      html = await res.text();
      if (html.length > MAX_BODY_CHARS) html = html.slice(0, MAX_BODY_CHARS);
    } catch {
      /* a body that cannot be read leaves an empty hash, not a failed survey */
    }
    return { finalUrl: res.url || url, status: res.status, headers: res.headers, html, isHtml };
  } catch {
    return { finalUrl: url, status: null, headers: null, html: "", isHtml: false };
  } finally {
    clearTimeout(timer);
  }
}

// Sitemap: lines from robots.txt, then the sitemaps themselves (one level of
// index). Every URL still has to pass crawlableUrl — a sitemap is the app's
// own list, and it lists /logout as readily as anything else.
async function sitemapUrls(
  fetchImpl: FetchLike,
  origin: string,
  origins: Set<string>,
  timeoutMs: number,
  expired: () => boolean,
): Promise<string[]> {
  const out = new Set<string>();
  const robots = await fetchPage(fetchImpl, `${origin}/robots.txt`, timeoutMs);
  const listed: string[] = [];
  if (robots.status && robots.status < 400) {
    for (const line of robots.html.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (m) listed.push(m[1]);
    }
  }
  if (listed.length === 0) listed.push(`${origin}/sitemap.xml`);

  const locs = (xml: string) =>
    [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));

  let fetched = 0;
  const queue = listed.slice(0, SITEMAP_FETCH_CAP);
  while (queue.length && fetched < SITEMAP_FETCH_CAP * 2 && !expired()) {
    const url = queue.shift()!;
    if (!/^https?:/i.test(url) || /\.gz$/i.test(url)) continue;
    fetched += 1;
    const res = await fetchPage(fetchImpl, url, timeoutMs);
    if (!res.status || res.status >= 400 || !res.html) continue;
    if (/<sitemapindex/i.test(res.html)) {
      // One level down, and only while the top-level budget allows.
      for (const child of locs(res.html).slice(0, SITEMAP_FETCH_CAP)) queue.push(child);
      continue;
    }
    for (const loc of locs(res.html)) {
      const url = crawlableUrl(loc, origin, origins);
      if (url) out.add(url);
      if (out.size >= SITEMAP_URL_CAP) break;
    }
    if (out.size >= SITEMAP_URL_CAP) break;
  }
  return [...out];
}

export async function surveyApp(targetUrl: string, opts: SurveyOptions = {}): Promise<SurveyResult> {
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  const pageCap = opts.pageCap ?? PAGE_CAP;
  const concurrency = opts.concurrency ?? CONCURRENCY;
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const recheckDelayMs = opts.homepageRecheckDelayMs ?? HOMEPAGE_RECHECK_DELAY_MS;
  const startedAt = Date.now();
  const expired = () => Date.now() - startedAt >= deadlineMs;

  const target = new URL(targetUrl);
  const origins = new Set([target.origin]);
  const home = new URL(pathOf(target), target.origin).toString();

  const empty = (blocked: boolean): SurveyResult => ({
    pages: [],
    bundles: [],
    buildId: null,
    tech: [],
    sitemapUrls: 0,
    blocked,
    fingerprint: "",
    truncated: false,
    digestVersion: DIGEST_VERSION,
    volatile: false,
  });

  // The homepage first, alone: it decides whether there is anything to survey
  // at all, and its final origin (www vs apex) is where the rest lives.
  const first = await fetchPage(fetchImpl, home, timeoutMs);
  if (looksBlocked(first.status, first.headers, first.html)) {
    const r = empty(true);
    r.fingerprint = await fingerprintOf([], []);
    return r;
  }
  let homeUrl = home;
  try {
    const finalHome = new URL(first.finalUrl);
    if (finalHome.protocol === "http:" || finalHome.protocol === "https:") {
      origins.add(finalHome.origin);
      homeUrl = new URL(pathOf(finalHome), finalHome.origin).toString();
    }
  } catch {
    /* an unparsable final URL keeps the target as the home */
  }

  const pages: SurveyPage[] = [];
  const bundles = new Set<string>();
  const tech = new Set<string>();
  let buildId: string | null = null;
  const seen = new Set<string>([home, homeUrl]);
  const queue: string[] = [];

  const record = (requested: string, res: Fetched) => {
    let url = res.finalUrl;
    let path: string;
    try {
      const u = new URL(url);
      path = origins.has(u.origin) ? pathOf(u) : url;
      url = u.toString();
    } catch {
      path = requested;
    }
    const html = res.isHtml ? res.html : "";
    const links = html ? extractLinks(html, url, origins) : [];
    for (const b of html ? extractBundles(html, url, origins) : []) bundles.add(b);
    if (html) {
      for (const t of detectFromResponse(res)) tech.add(t);
      buildId = buildId ?? extractBuildId(html);
    }
    return { page: { url, path, status: res.status, title: extractTitle(html), forms: countForms(html), links: links.length }, links, html: res.html };
  };

  // Homepage bookkeeping, then the seeds: sitemap URLs first (the app's own
  // list of what matters, in sitemap order), then what the homepage links to
  // in DOM order. From here on the order is a function of the site alone —
  // nothing below depends on which request answered first — so two surveys of
  // a stable site under the same cap visit the same pages, and two truncated
  // snapshots can be compared on the pages they share (CHE-179).
  const homeRecord = record(home, first);
  const homeHashes = await pageHashes(homeRecord.html, homeRecord.page.url);
  pages.push({ ...homeRecord.page, ...homeHashes });
  seen.add(homeRecord.page.url);

  const fromSitemap = await sitemapUrls(fetchImpl, target.origin, origins, timeoutMs, expired);
  for (const url of fromSitemap) {
    if (!seen.has(url)) {
      seen.add(url);
      queue.push(url);
    }
  }
  for (const url of homeRecord.links) {
    if (!seen.has(url)) {
      seen.add(url);
      queue.push(url);
    }
  }

  // Breadth-first in batches of `concurrency`; each batch's links join the
  // back of the queue in the batch's own order (Promise.all keeps it, whatever
  // the network did), so discovery order — and with it the 50 pages under the
  // cap — is the same on every visit of the same app.
  let truncated = false;
  while (queue.length > 0) {
    if (pages.length >= pageCap || expired()) {
      truncated = true;
      break;
    }
    const batch = queue.splice(0, Math.min(concurrency, pageCap - pages.length));
    const results = await Promise.all(batch.map((url) => fetchPage(fetchImpl, url, timeoutMs)));
    for (let i = 0; i < batch.length; i++) {
      const r = record(batch[i], results[i]);
      pages.push({ ...r.page, ...(await pageHashes(r.html, r.page.url)) });
      seen.add(r.page.url);
      for (const url of r.links) {
        if (!seen.has(url)) {
          seen.add(url);
          queue.push(url);
        }
      }
    }
  }

  // Self-calibration (CHE-185): the homepage once more, at least
  // recheckDelayMs after the first fetch, while the deadline allows. Two
  // digests of the same page minutes apart that differ mean the site moves
  // between requests in a way the digest does not absorb — and then a page
  // whose text differs from yesterday's is not evidence of a change either.
  // The second fetch's bytes are not kept: the snapshot stays what the crawl
  // saw first, only the verdict on its stability is added.
  let volatile = false;
  const dueAt = startedAt + recheckDelayMs;
  const wait = Math.max(0, dueAt - Date.now());
  if (Date.now() + wait + timeoutMs <= startedAt + deadlineMs) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const second = await fetchPage(fetchImpl, homeUrl, timeoutMs);
    if (second.isHtml && second.status === first.status && second.html) {
      const again = await pageHashes(second.html, homeRecord.page.url);
      volatile = again.hash !== homeHashes.hash;
    }
  }

  const bundleList = [...bundles].sort();
  return {
    pages,
    bundles: bundleList,
    buildId,
    tech: [...tech],
    sitemapUrls: fromSitemap.length,
    blocked: false,
    fingerprint: await fingerprintOf(pages, bundleList),
    truncated,
    digestVersion: DIGEST_VERSION,
    volatile,
  };
}

function detectFromResponse(res: Fetched): string[] {
  const headers: Record<string, string> = {};
  res.headers?.forEach((v, k) => {
    headers[k] = v;
  });
  return detectTech(headers, res.html);
}
