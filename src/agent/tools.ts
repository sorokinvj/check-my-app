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
  // CRUD lifecycle checking (CHE-90). writeAllowed comes from App.writeMode;
  // marker is the string every created record must carry so cleanup can only
  // ever touch our own rows.
  writeAllowed?: boolean;
  testMarker?: string;
  onResourceCreated?: (r: { kind: string; marker: string; locationUrl?: string; notes?: string }) => Promise<void>;
  onResourceDeleted?: (r: { marker: string; ok: boolean; note?: string }) => Promise<void>;
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
      "Use for link-heavy pages and for owner concerns about links; up to 60 URLs per call.",
    input_schema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Absolute http(s) URLs" },
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
        return await readPage(env.page);
      case "click":
        return await click(env, input);
      case "fill":
        return await fill(env, input);
      case "screenshot":
        return await screenshot(env);
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
        classifyUnverified(step);
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
  const res = await env.page.goto(target.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  // Give client JS a real chance to hydrate: clicking a not-yet-interactive
  // button is the #1 source of false "broken" findings on React/Next targets.
  await waitForHydration(env.page, 3_000);
  return `Navigated to ${env.page.url()} (status ${res?.status() ?? "?"})`;
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
// re-enabled a watch its owner had paused (CHE-99) and quietly spent $1.26
// re-checking a domain nobody wanted checked.
const STATE_TOGGLE_VERBS =
  /\b(enable|disable|resume|reactivate|activate|deactivate|pause|unpause|cancel|upgrade|downgrade|subscribe|unsubscribe|renew|restore|archive|revoke|start watching|turn (on|off))\b/i;

async function click(env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  const label = [input.name, input.selector].filter(Boolean).map(String).join(" ");
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

  const observed = `${reaction.requests} network request${reaction.requests === 1 ? "" : "s"}, ${reaction.mutations} DOM mutation${reaction.mutations === 1 ? "" : "s"}${reaction.navigated ? ", navigated" : ""}`;
  if (isInert(reaction)) {
    // Honest zero-reaction signal (CHE-37): the model must see "the page did
    // nothing at all" instead of silence, and must not translate it straight
    // into "broken" — this environment is known to be ignored by some apps.
    return (
      `Clicked, but the page did not react AT ALL: 0 network requests and 0 DOM mutations ` +
      `(strategies tried: ${tried.join(", ")}). Current URL: ${env.page.url()}. ` +
      `This is either a genuinely dead control or this test browser being ignored ` +
      `(overlay/consent layer, bot gating). Check for overlays with read_page/screenshot; ` +
      `if it stays inert while other JS on the page works, report it as unresponsive ` +
      `IN THIS TEST BROWSER — not as broken for real users.`
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
  return `Clicked (strategy: ${strategy}). Current URL: ${env.page.url()} (${observed}).${note}${ledgerNudge}`;
}

async function fill(env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  let value = String(input.value);
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

function classifyUnverified(step: ReportedStep): void {
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

// Bulk outbound-link verification (CHE-81 follow-up). Run #92 inventoried 200+
// YouTube links on meetbashar.com but could not "open" any (target=_blank in a
// headless page) and had to punt to "spot-check in a real browser". Links are a
// server-side fact: fetch each one. YouTube gets the oEmbed endpoint — it 4xxes
// for deleted/private/unplayable videos, which is exactly the owner's question.
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch|shorts|embed|live)|youtu\.be\/)/i;

function youtubeOembedUrl(url: string): string {
  return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
}

async function verifyLinks(input: Record<string, unknown>): Promise<string> {
  const raw = Array.isArray(input.urls) ? input.urls.map(String) : [];
  const urls = [...new Set(raw)].filter((u) => /^https?:\/\//i.test(u)).slice(0, 60);
  if (!urls.length) return "No valid http(s) URLs given.";

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

async function screenshot(env: ToolEnv): Promise<string> {
  await blurPasswordFields(env.page);
  const buffer = await env.page.screenshot({ fullPage: false });
  const url = env.onScreenshot ? await env.onScreenshot(buffer) : null;
  if (env.visionScreenshots) {
    // Second capture as compressed JPEG for the model's own eyes (CHE-70):
    // evidence stays full-quality PNG, context gets ~10x smaller bytes.
    const jpeg = await env.page.screenshot({ fullPage: false, type: "jpeg", quality: 55 });
    env.pendingScreenshotJpegB64 = Buffer.from(jpeg).toString("base64");
    return url
      ? `Screenshot saved: ${url} — the image follows in this result; look at it before judging the step.`
      : "Screenshot captured (not persisted) — the image follows in this result.";
  }
  return url ? `Screenshot saved: ${url}` : "Screenshot captured (not persisted).";
}

// Privacy §5: blur password fields before any screenshot. Covers native
// type=password plus "show password" toggles that flip it to type=text.
async function blurPasswordFields(page: Page): Promise<void> {
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
async function readPage(page: Page): Promise<string> {
  const digest = await page.evaluate(() => {
    const clip = (s: string | null | undefined, n = 80) =>
      (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .slice(0, 20)
      .map((h) => `${h.tagName.toLowerCase()}: ${clip(h.textContent)}`);

    const links = Array.from(document.querySelectorAll("a[href]"))
      .slice(0, 40)
      .map((a) => `"${clip(a.textContent, 50)}" → ${a.getAttribute("href")}`);

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
      buttons,
      fields,
    };
  });

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
