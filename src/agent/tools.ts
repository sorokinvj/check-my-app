// Playwright-backed tools the agent loop exposes to the LLM.
//
// Design notes (CHE-7):
// - read_page returns a digest (title, headings, links, forms, buttons, aria
//   roles), never raw HTML — keeps context small and selectors role-based.
// - fill substitutes {{TEST_EMAIL}} / {{TEST_PASSWORD}} server-side, so real
//   credentials never enter the LLM context or the transcript.
// - report_step / write_e2e_test are the persistence hooks: the loop stays
//   model-driven, the harness owns evidence and artifacts.

import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "@cloudflare/playwright";
import { credentialFingerprint } from "@/lib/crypto";
import {
  hasEnvironmentLeak,
  MACHINERY_TERMS,
  NOT_DEFECT_FALLBACK,
  PROBLEM_FALLBACK,
  productProse,
  splitSentences,
  UNVERIFIABLE_FALLBACK,
} from "@/lib/verdict-language";

export interface ToolEnv {
  page: Page;
  // Origin the agent is allowed to touch. Credential substitution and
  // navigation are hard-refused off this origin (defence vs prompt injection).
  targetOrigin: string;
  testEmail?: string;
  testPassword?: string;
  networkLog: string[]; // rolling window of "METHOD url → status"
  consoleLog: string[]; // rolling window of console messages
  onScreenshot?: (buffer: Buffer) => Promise<string>; // returns storage URL
  onReportStep?: (step: ReportedStep) => Promise<void>;
  onWriteTest?: (test: { title: string; content: string }) => Promise<void>;
  // Vision (CHE-70): when true, the screenshot tool also captures a compressed
  // JPEG and parks it here; the core loop lifts it into the tool_result as an
  // image block so the model SEES what it photographed, then clears the slot.
  // Off for text-only nav models — the image would be rejected.
  visionScreenshots?: boolean;
  pendingScreenshotJpegB64?: string;
  // CHE-169: vision on demand. With this on (and visionScreenshots off) the
  // screenshot tool parks no JPEG by itself; the harness parks one only at a
  // moment of judgment — an inert click or one that needed a fallback, an
  // error response from the target in the last action's requests (or a 429
  // from anywhere), a page with media/WebRTC signals, or the model asking to
  // look (screenshot with look=true). Set only for nav models that can see.
  visionTriggers?: boolean;
  // CRUD lifecycle checking (CHE-90). writeAllowed comes from App.writeMode;
  // marker is the string every created record must carry so cleanup can only
  // ever touch our own rows.
  writeAllowed?: boolean;
  testMarker?: string;
  onResourceCreated?: (r: { kind: string; marker: string; locationUrl?: string; notes?: string }) => Promise<void>;
  onResourceDeleted?: (r: { marker: string; ok: boolean; note?: string }) => Promise<void>;
  // CHE-100: shared across every journey of a run, seeded from Run.credentials-
  // Rejected so it survives a Workflow replay. Once true, the credential we hold
  // is known-bad: no further sign-in attempt is allowed and nothing behind that
  // login may be reported as the product's fault.
  credentials?: { rejected: boolean };
  onCredentialRejected?: (signature: string) => Promise<void>;
  // CHE-129: the machine actions that actually ran since the last report_step.
  // Only navigate/click/fill go here, and only after every refusal gate has let
  // them through and Playwright has done the thing — a refused or errored call
  // never happened, so a replay must not redo it. The step handler drains this
  // into Step.actions.
  actionTrail?: RecordedAction[];
  // CHE-171: every URL this run has actually SEEN published — the target, every
  // href on every page read, every URL a click or navigate landed on, the
  // survey's pages (CHE-132) and the known map's (CHE-133). Filled by the tools
  // themselves, never by the model. A 404 on a URL outside this set is a 404 on
  // an address nobody linked to: run #142's nav model typed
  // https://joblander.app/landing on its own, called the 404 "the documented
  // landing URL", and JOB-929 was filed on the customer's board off it. Keys
  // are knownUrlKey() strings. Optional so scripts still build a bare ToolEnv;
  // absent = the gate is off.
  knownUrls?: Set<string>;
}

// CHE-171: one spelling per address — lower-cased origin, path without a
// trailing slash, query kept, fragment dropped. Only http(s); anything else
// (mailto:, javascript:, an unparsable string) is null and never counts.
export function knownUrlKey(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.origin.toLowerCase()}${path}${u.search}`;
}

export function rememberUrls(env: Pick<ToolEnv, "knownUrls">, urls: Iterable<string>, base?: string): void {
  if (!env.knownUrls) return;
  for (const raw of urls) {
    const key = knownUrlKey(raw, base);
    if (key) env.knownUrls.add(key);
  }
}

// CHE-171: the set a walk or a discovery starts with. `published` may mix
// absolute URLs and bare paths ("/pricing"); paths resolve against the target.
export function knownUrlsFrom(targetUrl: string, published: Iterable<string> = []): Set<string> {
  const set = new Set<string>();
  const env = { knownUrls: set };
  rememberUrls(env, [targetUrl]);
  rememberUrls(env, published, targetUrl);
  return set;
}

function isKnownUrl(env: Pick<ToolEnv, "knownUrls">, url: string, base?: string): boolean {
  const key = knownUrlKey(url, base);
  return key !== null && Boolean(env.knownUrls?.has(key));
}

// CHE-129: what a browser can redo without a model. Inputs are the tool's own
// arguments (the fill value keeps its {{TEST_EMAIL}}/{{TEST_PASSWORD}}
// placeholders — the real value is substituted at execution time and is never
// written down), outcome is what the walk observed so a replay can tell
// whether it landed in the same place.
export type RecordedAction =
  | {
      kind: "navigate";
      url: string;
      outcome: { urlAfter: string; status: number | null };
    }
  | {
      kind: "click";
      role?: string;
      name?: string;
      selector?: string;
      outcome: { urlAfter: string; navigated: boolean; requests: number; mutations: number };
    }
  | {
      kind: "fill";
      label?: string;
      selector?: string;
      value: string;
      outcome: { urlAfter: string };
    };

function recordAction(env: ToolEnv, action: RecordedAction): void {
  env.actionTrail?.push(action);
}

// Strip any occurrence of the real test credentials from text leaving the tool
// layer (network/console logs, tool results). The model only ever needs the
// placeholders — actual secret values must never reach context, transcript, or
// the persisted Step columns, even if the tested app echoes them.
export function scrubSecrets(env: ToolEnv, text: string): string {
  let out = text;
  for (const secret of [env.testPassword, env.testEmail]) {
    if (secret && secret.length >= 3) {
      out = out.split(secret).join("[redacted]");
      out = out.split(encodeURIComponent(secret)).join("[redacted]");
    }
  }
  return out;
}

export interface ReportedStep {
  label: string;
  status: "ok" | "risky" | "confusing" | "broken" | "exposed" | "skipped";
  attempted: string;
  observed: string;
  consoleExcerpt?: string;
  networkExcerpt?: string;
  // CHE-83: only meaningful when status === "skipped".
  unverifiedReason?: "our_capability" | "missing_access" | "not_applicable";
}

export const BROWSER_TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate",
    description:
      "Navigate the browser to a URL. Call this to open pages. Returns final URL and HTTP status.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute or relative URL" } },
      required: ["url"],
    },
  },
  {
    name: "read_page",
    description:
      "Read a structured digest of the current page: title, headings, links, buttons, form fields, landmarks. Call after navigation or any action that changes the page. Prefer this over screenshots for deciding what to do next.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "click",
    description:
      "Click an element. Identify it by role and accessible name (preferred) or CSS selector.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", description: 'ARIA role, e.g. "button", "link"' },
        name: { type: "string", description: "Accessible name (visible text/label)" },
        selector: { type: "string", description: "CSS selector fallback" },
      },
    },
  },
  {
    name: "fill",
    description:
      "Fill an input. Use placeholders {{TEST_EMAIL}} and {{TEST_PASSWORD}} for the provided test credentials — never ask for or invent real credentials.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Field label, placeholder or accessible name" },
        selector: { type: "string", description: "CSS selector fallback" },
        value: { type: "string", description: "Text or {{TEST_EMAIL}} / {{TEST_PASSWORD}}" },
      },
      required: ["value"],
    },
  },
  {
    name: "screenshot",
    description:
      "Capture a screenshot of the current page as evidence. Returns a storage URL. Use at meaningful moments (step completed, something looks broken).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_network_log",
    description:
      "Return the recent network requests (method, URL, status) and console messages observed since the last call. Use to detect failing API calls, external services, and stack signals.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "verify_links",
    description:
      "Verify a batch of outbound links WITHOUT navigating: each URL is fetched " +
      "server-side and reported as OK or BROKEN with its status. YouTube links are " +
      "checked via the oEmbed API, which returns an error for deleted/private/" +
      "unplayable videos — the definitive answer to 'do all these video links work'. " +
      "mailto: links are checked too — the address is validated, which is the only " +
      "thing about one that can be wrong from outside. Use for link-heavy pages and " +
      "for owner concerns about links; up to 60 URLs per call.",
    input_schema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Absolute http(s) or mailto: URLs" },
      },
      required: ["urls"],
    },
  },
  {
    name: "record_created",
    description:
      "Register a record you just created inside the target product (a story, an app, a job posting…). " +
      "Call it IMMEDIATELY after the creation succeeds, before doing anything else — this ledger is what " +
      "guarantees the record gets cleaned up even if the run dies later. Every created record must carry " +
      "the run's test marker in a visible field (name/title), and you must delete it before the journey ends.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", description: 'What it is in the product\'s own words, e.g. "story"' },
        marker: { type: "string", description: "The exact marker text you typed into it" },
        locationUrl: { type: "string", description: "URL where it can be found again" },
        notes: { type: "string", description: "Anything cleanup needs to know" },
      },
      required: ["kind", "marker"],
    },
  },
  {
    name: "record_deleted",
    description:
      "Confirm that a record you created has been removed. Call it after you deleted it AND verified it is " +
      "gone (it left the list, or its URL no longer resolves). If deletion failed or the product offers no " +
      "way to delete, call this with ok=false and say why — that is both a finding about the product and " +
      "something we must clean up.",
    input_schema: {
      type: "object",
      properties: {
        marker: { type: "string", description: "The marker of the record you created" },
        ok: { type: "boolean", description: "true only if you verified it is actually gone" },
        note: { type: "string", description: "How you verified it, or why it could not be removed" },
      },
      required: ["marker", "ok"],
    },
  },
  {
    name: "report_step",
    description:
      "Record one completed journey step with its outcome. Call after each meaningful step while walking a journey. status: ok (works) / risky (works but fragile or abusable) / confusing (user would hesitate) / broken (does not work) / exposed (security issue) / skipped (could not verify). When status is skipped you MUST set unverifiedReason: our_capability if OUR checker could not do it (new-tab links you could not follow, OAuth popups, MFA codes, camera/mic, anything about our own machinery), missing_access if the owner has not given us what is needed (test credentials, a URL), not_applicable if it is deliberately out of scope. our_capability opens a high-priority ticket on OUR board — that is how the checker gets better, so classify honestly.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: 'Short step label, e.g. "Click Get started"' },
        status: {
          type: "string",
          enum: ["ok", "risky", "confusing", "broken", "exposed", "skipped"],
        },
        attempted: { type: "string", description: "What you tried to do" },
        observed: { type: "string", description: "What actually happened" },
        consoleExcerpt: { type: "string" },
        networkExcerpt: { type: "string" },
        unverifiedReason: {
          type: "string",
          enum: ["our_capability", "missing_access", "not_applicable"],
          description: "Required when status is skipped — see the description above.",
        },
      },
      required: ["label", "status", "attempted", "observed"],
    },
  },
  {
    name: "write_e2e_test",
    description:
      "Persist an executable Playwright spec (TypeScript) that formalizes the journey you just walked. Use @playwright/test, role-based locators (getByRole/getByLabel), BASE_URL from process.env.TARGET_URL. The spec must pass against the app in its current state.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: 'Spec title, e.g. "Submit a check"' },
        content: { type: "string", description: "Full TypeScript source of the spec file" },
      },
      required: ["title", "content"],
    },
  },
];

// CHE-169: the same tool list with `look` on the screenshot tool. A separate
// list rather than a flag on BROWSER_TOOLS so that with the harness off the
// request the model receives — tools included, which sit at the head of the
// prompt-cache prefix — is byte for byte what it is today.
const SCREENSHOT_TOOL_VISION_ON_DEMAND: Anthropic.Tool = {
  name: "screenshot",
  description:
    "Capture a screenshot of the current page as evidence. Returns a storage URL. Use at meaningful " +
    "moments (step completed, something looks broken). Set look=true when you need to SEE the page " +
    "to judge a step — costs more, use at judgment moments (an overlay, a media call, something that " +
    "reads wrong in the digest).",
  input_schema: {
    type: "object",
    properties: {
      look: {
        type: "boolean",
        description: "true to have the image shown to you in the result, not just stored",
      },
    },
  },
};

const BROWSER_TOOLS_VISION_ON_DEMAND: Anthropic.Tool[] = BROWSER_TOOLS.map((t) =>
  t.name === "screenshot" ? SCREENSHOT_TOOL_VISION_ON_DEMAND : t,
);

export function browserToolsFor(env: Pick<ToolEnv, "visionTriggers">): Anthropic.Tool[] {
  return env.visionTriggers ? BROWSER_TOOLS_VISION_ON_DEMAND : BROWSER_TOOLS;
}

// ─── Executor ────────────────────────────────────────────────────────────────

export async function executeTool(
  env: ToolEnv,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case "navigate":
        return await navigate(env, String(input.url));
      case "read_page":
        return await readPage(env);
      case "click":
        return await click(env, input);
      case "fill":
        return await fill(env, input);
      case "screenshot":
        return await screenshot(env, input);
      case "get_network_log":
        return scrubSecrets(env, drainLogs(env));
      case "verify_links":
        return await verifyLinks(input);
      case "record_created": {
        if (!env.onResourceCreated) return "No ledger available — do not create records in this run.";
        const marker = String(input.marker ?? "");
        if (env.testMarker && !marker.includes(env.testMarker)) {
          return (
            `Refused: the record must carry this run's marker "${env.testMarker}" in a visible field. ` +
            `Cleanup may only ever remove records carrying it — a record without it cannot be safely removed. ` +
            `Rename the record to include the marker, then call record_created again.`
          );
        }
        await env.onResourceCreated({
          kind: String(input.kind ?? "record"),
          marker,
          locationUrl: input.locationUrl ? String(input.locationUrl) : undefined,
          notes: input.notes ? String(input.notes) : undefined,
        });
        return "Recorded. You MUST delete this record before the journey ends, then call record_deleted.";
      }
      case "record_deleted": {
        if (!env.onResourceDeleted) return "No ledger available.";
        await env.onResourceDeleted({
          marker: String(input.marker ?? ""),
          ok: Boolean(input.ok),
          note: input.note ? String(input.note) : undefined,
        });
        return input.ok
          ? "Cleanup recorded."
          : "Recorded as NOT removed — report this as a finding (a user who creates this cannot remove it).";
      }
      case "report_step": {
        const step = input as unknown as ReportedStep;
        // The model occasionally invents enum values — coerce to the schema.
        const valid = ["ok", "risky", "confusing", "broken", "exposed", "skipped"];
        if (!valid.includes(step.status)) step.status = "confusing";
        // CHE-171 first: a step it rewrites is already skipped/not_applicable
        // by the time classifyUnverified looks, and that one leaves a step
        // with a reason alone.
        coerceUnpublished404(step, env);
        classifyUnverified(step);
        // CHE-180: the step leaves here with the model's words intact — the
        // judge (CHE-169) rules on them. productizeStep runs in the walk's
        // onReportStep, after the judge and before the row is written.
        await env.onReportStep?.(step);
        return "Step recorded.";
      }
      case "write_e2e_test": {
        await env.onWriteTest?.({
          title: String(input.title),
          content: String(input.content),
        });
        return "Spec saved.";
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function navigate(env: ToolEnv, url: string): Promise<string> {
  const target = new URL(url, env.page.url() || undefined);
  // Hard origin guard: the system prompt says "stay on origin", but a malicious
  // page could instruct the model to navigate off-site and exfiltrate creds.
  if (target.origin !== env.targetOrigin) {
    return `Refused: ${target.origin} is outside the target app (${env.targetOrigin}). Stay on the target.`;
  }
  const logBefore = env.networkLog.length;
  const res = await env.page.goto(target.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  // Give client JS a real chance to hydrate: clicking a not-yet-interactive
  // button is the #1 source of false "broken" findings on React/Next targets.
  await waitForHydration(env.page, 3_000);
  const status = res?.status() ?? null;
  // Resolved, not as the model typed it: a relative URL only means something
  // next to the page it was typed on, and a replay starts from a blank one.
  recordAction(env, {
    kind: "navigate",
    url: target.toString(),
    outcome: { urlAfter: env.page.url(), status },
  });
  // CHE-171: a 404/410 on an address nothing has published is not a fact
  // about the product — no user arrives there. Decided against the set, not
  // the model's story about the URL ("the documented landing URL" was the
  // story in run #142). The refusal is the answer; there is nothing on such a
  // page for the CHE-169 look to judge, and the address is NOT remembered,
  // so typing it twice does not make it real.
  if ((status === 404 || status === 410) && env.knownUrls && !isKnownUrl(env, target.toString())) {
    console.warn(`[navigate] ${status} on an unpublished address: ${target.toString()}`);
    return (
      `Navigated to ${env.page.url()} (status ${status}). This address is not linked from any ` +
      `page you have read or from the site's own map — a 404 here says nothing about the ` +
      `product; do not report it as broken. If you meant a real page, find its link in the ` +
      `page digest first.`
    );
  }
  // Where the navigation ended up is published by definition (a redirect target
  // is the product's own choice), unless the product said the address is gone.
  if (status !== 404 && status !== 410) rememberUrls(env, [env.page.url()]);
  // CHE-169: a page that answered with an error, or loaded a media/WebRTC
  // surface, is a place where the digest alone has misled the walk before.
  const looked = await lookIfJudgmentMoment(env, {
    requests: env.networkLog.slice(logBefore),
    status,
  });
  return `Navigated to ${env.page.url()} (status ${status ?? "?"})${looked}`;
}

// ─── CHE-169: vision on demand ───────────────────────────────────────────────
// The JPEG the model sees. One capture, shared by the screenshot tool (CHE-70),
// the on-demand triggers below and the judge (judge.ts): password fields are
// blurred first, the quality matches the CHE-70 setting so the token cost per
// image is the one COSTS.md measured.
export async function captureJpeg(page: Pick<Page, "screenshot" | "evaluate">): Promise<string> {
  await blurPasswordFields(page);
  const jpeg = await page.screenshot({ fullPage: false, type: "jpeg", quality: 55 });
  return Buffer.from(jpeg).toString("base64");
}

// Park a JPEG for the core loop to attach to the current tool's result, and
// say why. Best-effort: a failed capture costs the model its look, never the
// step. The returned suffix tells the model the image is there — a text-only
// walk has no reason to expect one.
async function attachLook(env: ToolEnv, reason: string): Promise<string> {
  if (!env.visionTriggers) return "";
  try {
    env.pendingScreenshotJpegB64 = await captureJpeg(env.page);
    console.log(`[harness] screenshot attached: ${reason}`);
    return " The page as it looks right now is attached to this result — look at it before judging.";
  } catch (err) {
    console.warn(`[harness] screenshot capture failed (${reason}): ${err instanceof Error ? err.message : err}`);
    return "";
  }
}

// An error response in the requests the last action produced: a 429 from
// anywhere (CLAUDE.md rule 3: our own volume, and the recovery UX is what the
// model must judge by eye), or a 4xx/5xx from the target itself. The CHE-100
// credential rejection is excluded — it has its own path and its own text.
export function errorResponseIn(entries: string[], targetOrigin: string): string | null {
  for (const line of entries) {
    const m = line.match(/^([A-Z]+)\s+(\S+)\s+→\s+(\d{3})$/);
    if (!m) continue;
    const [, , url, status] = m;
    const code = Number(status);
    if (code === 429) return line;
    if (code < 400) continue;
    if (credentialRejection([line])) continue;
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch {
      continue;
    }
    if (origin === targetOrigin) return line;
  }
  return null;
}

// Signs of a media or WebRTC surface: a <video>/<audio> element, or inline
// script that reaches for the microphone/camera or a peer connection. Kept as
// a plain string so esbuild cannot inject helpers into it (see
// MUTATION_COUNTER_SCRIPT). Scripts loaded by URL have no text here, so this
// is best-effort by design — the element check carries most real cases.
const MEDIA_SIGNAL_SCRIPT = `(() => {
  try {
    if (document.querySelector('video, audio')) return true;
    for (const s of Array.from(document.scripts)) {
      const t = s.textContent || '';
      if (/getUserMedia|RTCPeerConnection/.test(t)) return true;
    }
  } catch (e) {}
  return false;
})()`;

async function mediaSignals(env: ToolEnv): Promise<boolean> {
  const found = await env.page.evaluate(MEDIA_SIGNAL_SCRIPT).catch(() => false);
  return found === true;
}

// After navigate/click: attach a look when the requests carried an error or
// the page shows media signals. One image at most per action.
async function lookIfJudgmentMoment(
  env: ToolEnv,
  action: { requests: string[]; status?: number | null },
): Promise<string> {
  if (!env.visionTriggers) return "";
  const err =
    errorResponseIn(action.requests, env.targetOrigin) ??
    (action.status != null && action.status >= 400 ? `HTTP ${action.status} on navigate` : null);
  if (err) return attachLook(env, `error response (${err})`);
  if (await mediaSignals(env)) return attachLook(env, "media/WebRTC signals on the page");
  return "";
}

// Hydration gate before interacting: full load, then a double-rAF tick (lets
// the framework flush the effects that attach event listeners), then a capped
// network-idle wait (hydration chunks still in flight). Every wait is
// best-effort — a chatty page must not stall the walk.
async function waitForHydration(page: Page, networkIdleMs: number): Promise<void> {
  await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => {});
  await page
    .evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    .catch(() => {});
  if (networkIdleMs > 0) {
    await page.waitForLoadState("networkidle", { timeout: networkIdleMs }).catch(() => {});
  }
}

interface ReactionSnapshot {
  net: number;
  mut: number;
  url: string;
}

async function snapshotReaction(env: ToolEnv): Promise<ReactionSnapshot> {
  const mut = await env.page.evaluate("window.__cmaMutations || 0").catch(() => 0);
  return { net: env.networkLog.length, mut: Number(mut) || 0, url: env.page.url() };
}

interface Reaction {
  requests: number;
  mutations: number;
  navigated: boolean;
}

// Let the page settle after an interaction, then measure what it did: network
// requests, DOM mutations, navigation. Navigation resets the mutation counter
// (fresh document), so it is reported as its own definitive signal.
async function settleAndMeasure(env: ToolEnv, before: ReactionSnapshot): Promise<Reaction> {
  await env.page.waitForLoadState("domcontentloaded").catch(() => {});
  await env.page.waitForTimeout(1_200);
  const after = await snapshotReaction(env);
  const navigated = after.url !== before.url;
  return {
    requests: Math.max(after.net - before.net, 0),
    mutations: navigated ? after.mut : Math.max(after.mut - before.mut, 0),
    navigated,
  };
}

const isInert = (r: Reaction) => r.requests === 0 && r.mutations === 0 && !r.navigated;

// CHE-100: an auth endpoint answering 401/403 to a credential we submitted is
// the product working CORRECTLY — refusing bad input. Read as a machine fact
// from the request log, never from how the page phrased it: the phrasing is
// precisely what we got wrong before, when "Invalid email or password" was
// reported as a broken login and cost a customer two false tickets.
// Segment-bounded so /api/authors/12 is not mistaken for an auth route, but
// tolerant of the shapes providers actually ship: Clerk posts to
// /v1/client/sign_ins, others to /auth/login, /api/session, /oauth/token.
const AUTH_PATH =
  /(^|[/_-])(auth|log[-_]?in|sign[-_]?in|session|token|oauth|identity)s?([/_-]|$|[?.])/i;
// Narrow on purpose. Once the credential is known-bad the whole run must stop
// trying, but "continue" and "submit" appear all over a product and blocking
// them would quietly cost coverage everywhere else.
const SIGN_IN_LABEL = /\b(log ?in|sign ?in|log-in|sign-in)\b/i;

export function credentialRejection(entries: string[]): string | null {
  for (const line of entries) {
    const m = line.match(/^([A-Z]+)\s+(\S+)\s+→\s+(\d{3})$/);
    if (!m) continue;
    const [, method, url, status] = m;
    // A rejected GET is an unauthenticated page read (a guest hitting a
    // session check), not a sign-in we attempted.
    if (method === "GET" || (status !== "401" && status !== "403")) continue;
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      /* relative or malformed — match against the raw string */
    }
    if (!AUTH_PATH.test(path)) continue;
    return `${method} ${path} → ${status}`;
  }
  return null;
}

// CHE-37: on Browser Rendering, clicks that work in every real browser come
// back inert (0 requests). Strategy ladder, escalating only while the page
// shows ZERO reaction (no requests, no DOM mutations, no navigation):
//   1. locator.click — trusted pointer sequence with full actionability checks
//      (scroll into view, visible, stable, receives events). Always first.
//   2. form.requestSubmit(button) — when the target is a submit button whose
//      trusted click was inert: fires a real cancelable `submit` event, so
//      framework onSubmit handlers run exactly as if the user submitted.
//   3. synthetic pointer/mouse event sequence via dispatchEvent — untrusted
//      events, labeled as such; last resort for listeners that ignore the
//      trusted click in this environment.
// The result text records WHICH strategy produced a reaction, so transcripts
// (and the synthesis pass) can see when only a fallback worked.
// Buttons that leave state behind. Deterministic refusal beats instruction:
// run #108 created a real app during discovery, where the prompt had already
// said read-only — and never ledgered it, so cleanup could not see it either.
const CREATE_VERBS =
  /\b(create|register|sign ?up|save|add|publish|post|submit|send|order|buy|subscribe|book|invite|start watching|place order)\b/i;
// Submits that only read: never blocked.
const SAFE_SUBMITS = /\b(search|filter|apply filter|log ?in|sign ?in|continue|next|show|find|preview|refresh)\b/i;

// Controls that flip the state of something that ALREADY exists — someone
// else's record, not ours. Refused in every mode, including runs allowed to
// create: permission to add a test record was never permission to resume a
// paused subscription, cancel a plan or re-enable a watch. Our own self-check
// re-enabled a watch its owner had paused (CHE-98) and quietly spent $1.26
// re-checking a domain nobody wanted checked.
const STATE_TOGGLE_VERBS =
  /\b(enable|disable|resume|reactivate|activate|deactivate|pause|unpause|cancel|upgrade|downgrade|subscribe|unsubscribe|renew|restore|archive|revoke|start watching|turn (on|off))\b/i;

async function click(env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  const label = [input.name, input.selector].filter(Boolean).map(String).join(" ");
  // CHE-100: five attempts with a stale password locked a customer's account
  // and refused a real user. One rejection is the whole answer for the run.
  if (env.credentials?.rejected && label && SIGN_IN_LABEL.test(label)) {
    console.warn(`[click] refused repeat sign-in after credential rejection: ${label}`);
    return (
      `Refused: the credential we hold was already rejected by this product's auth endpoint ` +
      `earlier in this run. Trying again cannot succeed and repeated failures lock real ` +
      `accounts. Report this step "skipped" with unverifiedReason "missing_access" and move ` +
      `on to what can be checked signed out. Nothing behind this login is verifiable this run, ` +
      `and none of it may be described as failing.`
    );
  }
  if (label && STATE_TOGGLE_VERBS.test(label) && !SAFE_SUBMITS.test(label)) {
    console.warn(`[click] refused state-toggling click: ${label}`);
    return (
      `Refused: "${label}" would change the state of something that already exists in this ` +
      `product — a subscription, a schedule, a setting someone deliberately set. That is never ` +
      `ours to touch, whatever this run is allowed to create. Confirm the control is present ` +
      `and reachable, report the step "skipped" with unverifiedReason "not_applicable", and ` +
      `say in the step that acting on it would have changed the owner's own state.`
    );
  }
  if (!env.writeAllowed && label && CREATE_VERBS.test(label) && !SAFE_SUBMITS.test(label)) {
    console.warn(`[click] refused create-shaped click in read-only run: ${label}`);
    return (
      `Refused: "${label}" looks like it would create or send something, and this run is read-only ` +
      `(the owner has not enabled record creation). You have confirmed the form accepts input — ` +
      `that is the whole check here. Report this step "skipped" with unverifiedReason ` +
      `"not_applicable" and move on. If you believe this button only reads data, click it by CSS ` +
      `selector instead and say why in the step.`
    );
  }
  const target = (await resolveClickTarget(env.page, input)).first();
  // Never interact before hydration: a click landing before listeners attach
  // is indistinguishable from a dead button.
  await waitForHydration(env.page, 1_500);
  const before = await snapshotReaction(env);

  await target.click({ timeout: 8_000 });
  let reaction = await settleAndMeasure(env, before);
  let strategy = "trusted click";
  const tried = [strategy];

  if (isInert(reaction)) {
    // Re-querying could hit a different node than the visually-labeled one —
    // both fallbacks reuse the SAME locator's element.
    const handle = await target.elementHandle({ timeout: 2_000 }).catch(() => null);
    if (handle) {
      const submitted = await handle
        .evaluate((el: Element) => {
          const btn = (el.closest('button, input[type="submit"]') ?? el) as HTMLElement;
          const form = btn.closest("form");
          if (!form) return false;
          const isSubmit =
            (btn instanceof HTMLButtonElement && btn.type === "submit") ||
            (btn instanceof HTMLInputElement && btn.type === "submit");
          if (!isSubmit) return false;
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit(btn as HTMLButtonElement);
          } else {
            (form as HTMLFormElement).submit();
          }
          return true;
        })
        .catch(() => false);
      if (submitted) {
        tried.push("form.requestSubmit()");
        reaction = await settleAndMeasure(env, before);
        if (!isInert(reaction)) strategy = "form.requestSubmit() fallback (trusted click was inert)";
      }
      if (isInert(reaction)) {
        const dispatched = await handle
          .evaluate((el: Element) => {
            const r = el.getBoundingClientRect();
            const opts = {
              bubbles: true,
              cancelable: true,
              composed: true,
              button: 0,
              clientX: r.x + r.width / 2,
              clientY: r.y + r.height / 2,
            };
            for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
              el.dispatchEvent(
                type.startsWith("pointer")
                  ? new PointerEvent(type, opts)
                  : new MouseEvent(type, opts),
              );
            }
            return true;
          })
          .catch(() => false);
        if (dispatched) {
          tried.push("synthetic event dispatch");
          reaction = await settleAndMeasure(env, before);
          if (!isInert(reaction))
            strategy = "synthetic event dispatch fallback (untrusted events; trusted click was inert)";
        }
      }
    }
  }

  // CHE-129: the click happened (whatever the page made of it), so it is part
  // of the path. Recorded before the rejection/inert returns below because
  // those are readings of the outcome, not reasons the action did not run.
  recordAction(env, {
    kind: "click",
    ...(input.role ? { role: String(input.role) } : {}),
    ...(input.name ? { name: String(input.name) } : {}),
    ...(input.selector ? { selector: String(input.selector) } : {}),
    outcome: {
      urlAfter: env.page.url(),
      navigated: reaction.navigated,
      requests: reaction.requests,
      mutations: reaction.mutations,
    },
  });
  // CHE-171: wherever a click lands, the product itself took the user there.
  rememberUrls(env, [env.page.url()]);

  // CHE-100: before anything is said about the product, check whether what just
  // happened was our own credential being turned away. Sliced from the tail so
  // the rolling window's trim can never shift the range.
  // CHE-172: this reading is trusted because fill() strips the whitespace the
  // model puts around a placeholder before the secret is substituted — the
  // only credential that can reach an auth endpoint from here is the clean
  // one, so a 401 to it is about the credential, not about our typing.
  const fresh = reaction.requests > 0 ? env.networkLog.slice(-reaction.requests) : [];
  const rejection = credentialRejection(fresh);
  if (rejection) {
    if (env.credentials && !env.credentials.rejected) {
      env.credentials.rejected = true;
      await env.onCredentialRejected?.(rejection);
    }
    return (
      `The credential we hold was REJECTED (${rejection}). An auth endpoint answering that to a ` +
      `submitted password is the product working correctly — it is refusing bad input, which is ` +
      `what it should do. This is our access problem, not a defect of theirs.\n` +
      `Do NOT try again: repeated failures lock real accounts. Do NOT report the login, or ` +
      `anything behind it, as broken or confusing. Report this step "skipped" with ` +
      `unverifiedReason "missing_access", say plainly that the sign-in details we were given no ` +
      `longer work, and spend the rest of this run on what a signed-out visitor can reach.`
    );
  }

  const observed = `${reaction.requests} network request${reaction.requests === 1 ? "" : "s"}, ${reaction.mutations} DOM mutation${reaction.mutations === 1 ? "" : "s"}${reaction.navigated ? ", navigated" : ""}`;
  if (isInert(reaction)) {
    // CHE-169: an inert click is the judgment moment vision was turned on for
    // (CHE-70) — an overlay, a consent layer, a media control that only looks
    // dead. The model gets the page in front of it exactly here.
    const looked = await attachLook(env, "inert click");
    // Honest zero-reaction signal (CHE-37): the model must see "the page did
    // nothing at all" instead of silence, and must not translate it straight
    // into "broken" — this environment is known to be ignored by some apps.
    return (
      `Clicked, but the page did not react AT ALL: 0 network requests and 0 DOM mutations ` +
      `(strategies tried: ${tried.join(", ")}). Current URL: ${env.page.url()}. ` +
      `This is either a genuinely dead control or this test browser being ignored ` +
      `(overlay/consent layer, bot gating). Check for overlays with read_page/screenshot; ` +
      `if it stays inert while other JS on the page works, report it as unresponsive ` +
      `IN THIS TEST BROWSER — not as broken for real users.${looked}`
    );
  }
  const note =
    reaction.requests === 0 && !reaction.navigated
      ? " No network request followed, but the DOM changed — likely an in-page reaction (validation message, menu, state change); re-read the page to see what happened."
      : "";
  const ledgerNudge =
    env.writeAllowed && label && CREATE_VERBS.test(label) && !SAFE_SUBMITS.test(label)
      ? ` If that created something, call record_created NOW (marker "${env.testMarker}") — before anything else.`
      : "";
  // CHE-169: a click that only a fallback strategy could land, an error in
  // what it requested, or a media surface — each is a place the digest has
  // misread before, so the model looks before it judges.
  const looked =
    strategy !== "trusted click"
      ? await attachLook(env, `click needed a fallback (${strategy})`)
      : await lookIfJudgmentMoment(env, { requests: fresh });
  return `Clicked (strategy: ${strategy}). Current URL: ${env.page.url()} (${observed}).${note}${ledgerNudge}${looked}`;
}

// CHE-172: a placeholder the model padded with whitespace — " {{TEST_EMAIL}}",
// "{{TEST_PASSWORD}} ", "\t{{TEST_EMAIL}}\n". Run #142's nav model wrote both
// with a leading space; the substitution kept it, the product answered 401 to
// a password that began with a space, and the CHE-100 one-attempt rule then
// did exactly what it should with a rejection — except the rejection was ours.
// The placeholder IS the value in every such case, so it is collapsed to the
// bare placeholder before anything reads it. A placeholder next to other text
// ("{{TEST_EMAIL}}x") is left alone: odd, but it is what the model meant.
const PADDED_PLACEHOLDER = /^\s*(\{\{TEST_(?:EMAIL|PASSWORD)\}\})\s*$/;

export function normalizeFillValue(raw: string): string {
  const m = raw.match(PADDED_PLACEHOLDER);
  return m ? m[1] : raw;
}

async function fill(env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  // CHE-172: before any gate, any record, any substitution.
  let value = normalizeFillValue(String(input.value));
  // CHE-129: what gets recorded is the value as the model wrote it, placeholders
  // intact, scrubbed once more in case the model pasted a real value it had
  // seen echoed by the page. The substituted value below is never written down.
  const recordedValue = scrubSecrets(env, value);
  const usedSecret = /\{\{TEST_(EMAIL|PASSWORD)\}\}/.test(value);
  // Never type real credentials into an off-origin form (prompt-injection
  // exfiltration): the substituted value would be the decrypted password.
  if (usedSecret) {
    try {
      if (new URL(env.page.url()).origin !== env.targetOrigin) {
        return `Refused: will not enter test credentials on ${env.page.url()} (outside the target app).`;
      }
    } catch {
      return "Refused: cannot determine the current origin for credential entry.";
    }
  }
  // No test credentials provided → the placeholders resolve to empty, which
  // used to fill the field with "" and let the model click submit on an
  // effectively empty form. Validation then (correctly) blocks the submit, and
  // the model misread that no-op as "Sign in doesn't respond" — the #1
  // false-positive on credential journeys (CHE-37; e.g. JOB-904). Refuse
  // instead, and tell the model to skip, not submit.
  // CHE-100: the strongest half of the one-attempt rule. Refusing the click is
  // easy to route around (a different button, a keyboard Enter); refusing to put
  // the known-bad password into a field again is not.
  if (usedSecret && env.credentials?.rejected) {
    return (
      "Refused: this product's auth endpoint already rejected the credential we hold, earlier " +
      "in this run. Filling it again cannot succeed and repeated failures lock real accounts. " +
      'Report this step "skipped" with unverifiedReason "missing_access" and continue with what ' +
      "a signed-out visitor can reach."
    );
  }
  if (usedSecret) {
    const haveEmail = value.includes("{{TEST_EMAIL}}") ? Boolean(env.testEmail) : true;
    const havePwd = value.includes("{{TEST_PASSWORD}}") ? Boolean(env.testPassword) : true;
    if (!haveEmail || !havePwd) {
      return "No test credentials were provided for this run, so this field cannot be filled. Do NOT click the login/submit button on an empty form — a form that refuses empty input is working correctly. Report this step as \"skipped\" (no test credentials), never \"broken\" or \"confusing\".";
    }
  }
  value = value
    .replaceAll("{{TEST_EMAIL}}", env.testEmail ?? "")
    .replaceAll("{{TEST_PASSWORD}}", env.testPassword ?? "");
  // Fingerprint only (sha256 prefix + length), never the value: lets a cred
  // mismatch be localized to save vs store vs fill without exposing anything.
  if (usedSecret && env.testPassword) {
    console.log(`[fill] substituting test password: ${credentialFingerprint(env.testPassword)}`);
  }

  const page = env.page;
  const label = input.label ? String(input.label) : undefined;
  const locator = input.selector
    ? page.locator(String(input.selector))
    : label
      ? page
          .getByLabel(label)
          .or(page.getByPlaceholder(label))
          .or(page.getByRole("textbox", { name: label }))
      : page.locator("input:visible");

  const field = locator.first();
  // Same hydration gate as click: values typed before listeners attach are
  // silently dropped by controlled inputs.
  await waitForHydration(page, 1_000);
  await field.fill(value, { timeout: 8_000 });
  // React controlled inputs silently drop values typed before hydration —
  // verify the value stuck and retry once if not.
  const stuck = await field.inputValue().catch(() => null);
  if (stuck !== null && stuck !== value) {
    await env.page.waitForTimeout(600);
    await field.fill(value, { timeout: 8_000 });
  }
  recordAction(env, {
    kind: "fill",
    ...(label ? { label } : {}),
    ...(input.selector ? { selector: String(input.selector) } : {}),
    value: recordedValue,
    outcome: { urlAfter: env.page.url() },
  });
  return usedSecret ? "Filled (credential substituted server-side)." : "Filled.";
}

// Exact accessible name first (CHE-79): getByRole's `name` matches SUBSTRINGS,
// so clicking "Continue" on a Clerk modal picked "Continue with Google" (it
// sits above the form in DOM order) and bounced the agent into OAuth — a false
// broken/high on our own sign-in. When an exact-name match exists it wins;
// the substring behavior stays as the fallback for the model's loose labels.
async function resolveClickTarget(page: Page, input: Record<string, unknown>) {
  if (input.role && input.name) {
    const exact = page.getByRole(String(input.role) as Parameters<Page["getByRole"]>[0], {
      name: String(input.name),
      exact: true,
    });
    if ((await exact.count().catch(() => 0)) > 0) return exact;
  }
  return resolveLocator(page, input);
}

// CHE-82/83. An interaction that produced nothing for US is not a product
// defect — it is an unverified step and a gap in our own checker. Coerce it
// (the model still slips into "confusing: the button did nothing") and make
// sure every skipped step carries a reason, so the capability filer can open a
// ticket against us instead of the customer reading an excuse.
const CAPABILITY_PATTERNS =
  /(target=_?"?_blank|new tab|popup|pop-up|oauth|headless|our (test )?browser|verification code|2fa|mfa|camera|microphone|media device|could not follow|cannot follow|no (network )?requests?|0 requests|magic link|passwordless|email link|sign-?in link)/i;

export function classifyUnverified(step: ReportedStep): void {
  const text = `${step.observed ?? ""} ${step.attempted ?? ""}`;
  const environmental = CAPABILITY_PATTERNS.test(text);
  const hardEvidence = /\b(4\d{2}|5\d{2})\b|console error|exception|stack|crash/i.test(
    step.observed ?? "",
  );
  // "broken/confusing" justified only by our own inability → unverified.
  if ((step.status === "broken" || step.status === "confusing") && environmental && !hardEvidence) {
    step.status = "skipped";
    step.unverifiedReason = "our_capability";
    return;
  }
  if (step.status !== "skipped") {
    step.unverifiedReason = undefined;
    return;
  }
  if (!step.unverifiedReason) {
    // Passwordless flows are OUR gap, not the owner's: there is no password to
    // give us, so "add test credentials" would be a lie. Checked before the
    // credentials wording, which such steps almost always also mention.
    const passwordless = /magic link|passwordless|email link|sign-?in link|login link/i.test(text);
    step.unverifiedReason = passwordless
      ? "our_capability"
      : /credential|password|test account|sign-?in details/i.test(text)
        ? "missing_access"
        : environmental
          ? "our_capability"
          : "not_applicable";
  }
}

// CHE-180. Step.attempted / Step.observed are read on the verdict page, and
// verdict-language.ts guarded only findings and the bottom line: run #144
// wrote "requires camera/mic access unavailable in our test environment" into
// a step. Pure helper; the walk (execution.ts onReportStep) calls it LAST —
// after coerceUnpublished404 and classifyUnverified, which read the machinery
// phrases to classify a skipped step honestly, and after the judge (CHE-169),
// whose ruling rests on exactly those words — and before the row is written.
// Status and unverifiedReason are untouched; only the words change. When
// nothing product-facing survives, a fixed sentence stands in: coverage for a
// skipped step, the judge's sentence for an ok one, and for a problem the
// first sentence with its machinery clause cut, so the evidence that made it
// a problem is not thrown away together with the excuse. The label has no
// product-facing substitute, so a label made only of machinery words (never
// seen in a run) stays as written.
export function productizeStep(step: ReportedStep): void {
  step.label = productProse(step.label, 0) ?? step.label;
  step.attempted = productProse(step.attempted) ?? step.label;
  step.observed = productProse(step.observed) ?? observedFallback(step);
}

const CLAUSE_BREAK = /\s+[—–]+\s+|\s+-\s+|;\s+|,\s+(?=(?:it|which|because|since|as|so|but|and|though|although|while)\b)/i;

function observedFallback(step: ReportedStep): string {
  if (step.status === "skipped") return UNVERIFIABLE_FALLBACK;
  if (step.status === "ok") return NOT_DEFECT_FALLBACK;
  const first = splitSentences((step.observed ?? "").trim())[0] ?? "";
  const clauses = first
    .split(CLAUSE_BREAK)
    .map((c) => c.trim())
    .filter((c) => c && !hasEnvironmentLeak(c) && !MACHINERY_TERMS.test(c));
  if (clauses.length === 0) return PROBLEM_FALLBACK;
  const out = clauses.join(", ").replace(/[,;:\s]+$/, "");
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

// CHE-171. The navigate refusal tells the model; this makes sure the step
// cannot say otherwise. A broken/confusing step whose evidence is a 404/410 on
// an address the run never saw published becomes skipped/not_applicable: not
// our capability gap (we reached it fine), not the product's defect (nobody is
// sent there) — a path no user takes. The addresses come from two machine
// sources: the navigate actions recorded since the last report_step (CHE-129)
// and the URLs/paths the step text cites. One known address among them keeps
// the step as written — a 404 on a page the product links to is a real
// dead-end. And when the trail is there and holds no typed-in 404, the step is
// left alone whatever the text says: that 404 came from something the product
// did (a click's own request to /api/…), which is exactly the evidence a real
// user hits.
const CITED_URL = /https?:\/\/[^\s"'<>)\]]+/gi;
const CITED_PATH = /(?:^|[\s"'`(])(\/[a-z0-9][a-z0-9_\-./]*)/gi;
const NOT_FOUND = /\b(404|410)\b|\bnot found\b/i;
const TRAILING_PUNCT = /[.,;:]+$/;

function citedAddresses(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITED_URL)) out.push(m[0].replace(TRAILING_PUNCT, ""));
  for (const m of text.matchAll(CITED_PATH)) out.push(m[1].replace(TRAILING_PUNCT, ""));
  return out;
}

function isGoneNavigate(a: RecordedAction): a is Extract<RecordedAction, { kind: "navigate" }> {
  return a.kind === "navigate" && (a.outcome.status === 404 || a.outcome.status === 410);
}

export function coerceUnpublished404(
  step: ReportedStep,
  env: Pick<ToolEnv, "knownUrls" | "targetOrigin" | "actionTrail">,
): void {
  if (!env.knownUrls) return;
  if (step.status !== "broken" && step.status !== "confusing") return;
  const text = `${step.observed ?? ""} ${step.attempted ?? ""}`;
  if (!NOT_FOUND.test(text)) return;
  // A server error is the product's own word; a 404 next to it is not the story.
  if (/\b5\d{2}\b/.test(step.observed ?? "")) return;
  const typed = env.actionTrail?.filter(isGoneNavigate).map((a) => a.url);
  if (typed && typed.length === 0) return;
  const addresses = [...(typed ?? []), ...citedAddresses(text)];
  if (addresses.length === 0) return;
  if (addresses.some((url) => isKnownUrl(env, url, env.targetOrigin))) return;
  console.warn(`[report_step] "${step.label}": ${step.status} on an unpublished 404 → skipped`);
  step.status = "skipped";
  step.unverifiedReason = "not_applicable";
  const observed = (step.observed ?? "").trim();
  step.observed = `${observed}${observed && !/[.!?]$/.test(observed) ? "." : ""} This address is not part of the product's navigation.`.trim();
}

// Bulk outbound-link verification (CHE-81 follow-up). Run #92 inventoried 200+
// YouTube links on meetbashar.com but could not "open" any (target=_blank in a
// headless page) and had to punt to "spot-check in a real browser". Links are a
// server-side fact: fetch each one. YouTube gets the oEmbed endpoint — it 4xxes
// for deleted/private/unplayable videos, which is exactly the owner's question.
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch|shorts|embed|live)|youtu\.be\/)/i;

function youtubeOembedUrl(url: string): string {
  return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
}

// CHE-104: a mailto: link cannot be fetched, but it is not unverifiable either
// — the thing that can be wrong with one is the address, and that is readable.
// Whether mail actually arrives is invisible from outside the product and is
// not a gap of ours to file. Left unhandled, run #126 reported a plain mailto:
// contact link as an unverified step, which the gap classifier then filed
// against us as "cannot complete magic-link sign-in" — a capability we do lack,
// but not the one that was in front of it.
const MAILTO_ADDRESS = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

function checkMailto(url: string): string {
  const address = url.slice("mailto:".length).split("?")[0].trim();
  if (!address) return `BROKEN empty-address ${url}`;
  const bad = address.split(",").map((a) => a.trim()).filter((a) => !MAILTO_ADDRESS.test(a));
  return bad.length ? `BROKEN malformed-address (${bad.join(", ")}) ${url}` : `OK mailto ${url}`;
}

async function verifyLinks(input: Record<string, unknown>): Promise<string> {
  const raw = Array.isArray(input.urls) ? input.urls.map(String) : [];
  const mailtos = [...new Set(raw)].filter((u) => /^mailto:/i.test(u)).slice(0, 60);
  const urls = [...new Set(raw)].filter((u) => /^https?:\/\//i.test(u)).slice(0, 60);
  if (!urls.length && mailtos.length) {
    const results = mailtos.map(checkMailto);
    const broken = results.filter((r) => r.startsWith("BROKEN")).length;
    return `Checked ${results.length} mailto links — ${broken} malformed.\n${results.join("\n")}`;
  }
  if (!urls.length) return "No valid http(s) or mailto: URLs given.";

  const checkOne = async (url: string): Promise<string> => {
    const isYt = YOUTUBE_RE.test(url);
    const target = isYt ? youtubeOembedUrl(url) : url;
    try {
      const res = await fetch(target, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CheckMyApp link check)" },
      });
      const ok = res.status >= 200 && res.status < 400;
      const via = isYt ? " (via YouTube oEmbed)" : "";
      return `${ok ? "OK" : "BROKEN"} ${res.status}${via} ${url}`;
    } catch (err) {
      return `BROKEN fetch-error (${err instanceof Error ? err.message.slice(0, 60) : "?"}) ${url}`;
    }
  };

  // Small batches: workerd caps concurrent outbound connections.
  const results: string[] = [];
  for (let i = 0; i < urls.length; i += 5) {
    results.push(...(await Promise.all(urls.slice(i, i + 5).map(checkOne))));
  }
  results.push(...mailtos.map(checkMailto));
  const broken = results.filter((r) => r.startsWith("BROKEN")).length;
  return `Checked ${results.length} links — ${broken} broken.\n${results.join("\n")}`;
}

function resolveLocator(page: Page, input: Record<string, unknown>) {
  if (input.selector) return page.locator(String(input.selector));
  if (input.role) {
    return page.getByRole(String(input.role) as Parameters<Page["getByRole"]>[0], {
      name: input.name ? String(input.name) : undefined,
    });
  }
  if (input.name) return page.getByText(String(input.name), { exact: false });
  throw new Error("click needs role+name, name, or selector");
}

async function screenshot(env: ToolEnv, input: Record<string, unknown> = {}): Promise<string> {
  await blurPasswordFields(env.page);
  const buffer = await env.page.screenshot({ fullPage: false });
  const url = env.onScreenshot ? await env.onScreenshot(buffer) : null;
  // CHE-169: under vision on demand the model gets the image only when it asks
  // for it — the tool's `look` flag is the model's own judgment moment.
  const wanted = env.visionScreenshots || (env.visionTriggers && input.look === true);
  if (wanted) {
    // Second capture as compressed JPEG for the model's own eyes (CHE-70):
    // evidence stays full-quality PNG, context gets ~10x smaller bytes.
    env.pendingScreenshotJpegB64 = await captureJpeg(env.page);
    if (env.visionTriggers) console.log("[harness] screenshot attached: model asked (look=true)");
    return url
      ? `Screenshot saved: ${url} — the image follows in this result; look at it before judging the step.`
      : "Screenshot captured (not persisted) — the image follows in this result.";
  }
  return url ? `Screenshot saved: ${url}` : "Screenshot captured (not persisted).";
}

// Privacy §5: blur password fields before any screenshot. Covers native
// type=password plus "show password" toggles that flip it to type=text.
async function blurPasswordFields(page: Pick<Page, "evaluate">): Promise<void> {
  await page
    .evaluate(() => {
      document
        .querySelectorAll<HTMLInputElement>(
          'input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[name*="pass" i]',
        )
        .forEach((el) => {
          el.style.filter = "blur(6px)";
        });
    })
    .catch(() => {});
}

function drainLogs(env: ToolEnv): string {
  const net = env.networkLog.splice(0).slice(-60);
  const cons = env.consoleLog.splice(0).slice(-30);
  return [
    "NETWORK (recent):",
    net.length ? net.join("\n") : "(none)",
    "",
    "CONSOLE (recent):",
    cons.length ? cons.join("\n") : "(none)",
  ].join("\n");
}

// Structured page digest — the agent's primary "eyes".
async function readPage(env: ToolEnv): Promise<string> {
  const digest = await env.page.evaluate(() => {
    const clip = (s: string | null | undefined, n = 80) =>
      (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .slice(0, 20)
      .map((h) => `${h.tagName.toLowerCase()}: ${clip(h.textContent)}`);

    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const links = anchors
      .slice(0, 40)
      .map((a) => `"${clip(a.textContent, 50)}" → ${a.getAttribute("href")}`);
    // CHE-171: every href on the page, resolved by the browser, not only the
    // 40 the digest prints — a page the site links to from its footer or its
    // 200th anchor is still published.
    const hrefs = Array.from(new Set(anchors.map((a) => (a as HTMLAnchorElement).href)));

    const buttons = Array.from(
      document.querySelectorAll('button,[role="button"],input[type="submit"]'),
    )
      .slice(0, 25)
      .map((b) => `"${clip(b.textContent || (b as HTMLInputElement).value, 50)}"${(b as HTMLButtonElement).disabled ? " (disabled)" : ""}`);

    const fields = Array.from(document.querySelectorAll("input,textarea,select"))
      .slice(0, 25)
      .map((i) => {
        const el = i as HTMLInputElement;
        const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const label = clip(labelEl?.textContent ?? el.getAttribute("aria-label"), 50);
        const placeholder = clip(el.placeholder, 50);
        // Distinguish label vs placeholder — generated specs must target
        // placeholder-only fields with getByPlaceholder, not getByLabel.
        return `${el.tagName.toLowerCase()}[type=${el.type ?? "text"}]${
          label ? ` label="${label}"` : ""
        }${placeholder ? ` placeholder="${placeholder}"` : ""}${
          !label && !placeholder ? " (unlabeled)" : ""
        }`;
      });

    return {
      url: location.href,
      title: document.title,
      headings,
      links,
      hrefs,
      buttons,
      fields,
    };
  });
  // CHE-171: the page read is published (it rendered), and so is everything
  // it links to. Relative hrefs the stub or an old digest may carry resolve
  // against the page itself.
  rememberUrls(env, [digest.url, ...(digest.hrefs ?? [])], digest.url);

  return [
    `URL: ${digest.url}`,
    `TITLE: ${digest.title}`,
    `HEADINGS:\n${digest.headings.join("\n") || "(none)"}`,
    `LINKS:\n${digest.links.join("\n") || "(none)"}`,
    `BUTTONS:\n${digest.buttons.join("\n") || "(none)"}`,
    `FORM FIELDS:\n${digest.fields.join("\n") || "(none)"}`,
  ].join("\n\n");
}

// Counts every DOM mutation from document creation onward. Gives interactions
// a second honest reaction signal besides the network log: "0 requests AND 0
// mutations" means the page truly ignored us (CHE-37), while "0 requests but
// N mutations" is client-side validation / in-page state change — a real
// difference the model previously could not see. Kept as a plain string so
// esbuild cannot inject helpers into it.
const MUTATION_COUNTER_SCRIPT = `(() => {
  window.__cmaMutations = 0;
  try {
    new MutationObserver((records) => { window.__cmaMutations += records.length; })
      .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch (e) {}
})();`;

// Prepare a fresh page for agent use: the __name shim works around esbuild
// (tsx) injecting `__name(...)` helper calls into functions that Playwright
// serializes for page.evaluate — without it every evaluate throws
// "ReferenceError: __name is not defined" in the browser.
export async function prepareAgentPage(env: ToolEnv): Promise<void> {
  await env.page.addInitScript("window.__name = (fn) => fn;");
  await env.page.addInitScript(MUTATION_COUNTER_SCRIPT);
  attachLogCapture(env);
}

// Wire rolling network/console capture into a page. Call once per context.
export function attachLogCapture(env: ToolEnv): void {
  env.page.on("response", (res) => {
    env.networkLog.push(`${res.request().method()} ${res.url()} → ${res.status()}`);
    if (env.networkLog.length > 200) env.networkLog.splice(0, 100);
  });
  env.page.on("console", (msg) => {
    env.consoleLog.push(`[${msg.type()}] ${msg.text().slice(0, 300)}`);
    if (env.consoleLog.length > 100) env.consoleLog.splice(0, 50);
  });
}
