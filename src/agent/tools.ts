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
    name: "report_step",
    description:
      "Record one completed journey step with its outcome. Call after each meaningful step while walking a journey. status: ok (works) / risky (works but fragile or abusable) / confusing (user would hesitate) / broken (does not work) / exposed (security issue) / skipped (unreachable).",
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
      case "report_step": {
        const step = input as unknown as ReportedStep;
        // The model occasionally invents enum values — coerce to the schema.
        const valid = ["ok", "risky", "confusing", "broken", "exposed", "skipped"];
        if (!valid.includes(step.status)) step.status = "confusing";
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
async function click(env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  const target = resolveLocator(env.page, input).first();
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
  return `Clicked (strategy: ${strategy}). Current URL: ${env.page.url()} (${observed}).${note}`;
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
  value = value
    .replaceAll("{{TEST_EMAIL}}", env.testEmail ?? "")
    .replaceAll("{{TEST_PASSWORD}}", env.testPassword ?? "");

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
