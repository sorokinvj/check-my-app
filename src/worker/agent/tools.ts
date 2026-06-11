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
import type { Page } from "playwright";

export interface ToolEnv {
  page: Page;
  testEmail?: string;
  testPassword?: string;
  networkLog: string[]; // rolling window of "METHOD url → status"
  consoleLog: string[]; // rolling window of console messages
  onScreenshot?: (buffer: Buffer) => Promise<string>; // returns storage URL
  onReportStep?: (step: ReportedStep) => Promise<void>;
  onWriteTest?: (test: { title: string; content: string }) => Promise<void>;
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
        return drainLogs(env);
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
  const target = new URL(url, env.page.url() || undefined).toString();
  const res = await env.page.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
  return `Navigated to ${env.page.url()} (status ${res?.status() ?? "?"})`;
}

async function click(env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  const locator = resolveLocator(env.page, input);
  await locator.first().click({ timeout: 8_000 });
  await env.page.waitForLoadState("domcontentloaded").catch(() => {});
  return `Clicked. Current URL: ${env.page.url()}`;
}

async function fill(env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  let value = String(input.value);
  const usedSecret = /\{\{TEST_(EMAIL|PASSWORD)\}\}/.test(value);
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

  await locator.first().fill(value, { timeout: 8_000 });
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
  const buffer = await env.page.screenshot({ fullPage: false });
  const url = env.onScreenshot ? await env.onScreenshot(buffer) : null;
  return url ? `Screenshot saved: ${url}` : "Screenshot captured (not persisted).";
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

// Prepare a fresh page for agent use: the __name shim works around esbuild
// (tsx) injecting `__name(...)` helper calls into functions that Playwright
// serializes for page.evaluate — without it every evaluate throws
// "ReferenceError: __name is not defined" in the browser.
export async function prepareAgentPage(env: ToolEnv): Promise<void> {
  await env.page.addInitScript("window.__name = (fn) => fn;");
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
