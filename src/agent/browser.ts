// Browser Rendering helpers (CHE-14). Wraps @cloudflare/playwright on the
// MYBROWSER binding. The __name shim is required — esbuild injects __name(...)
// into functions Playwright serializes for page.evaluate (proven in spike
// CHE-20). Surface scan is deterministic (no LLM): load, detect stack, count
// links, first screenshot for the live screen.

import { launch } from "@cloudflare/playwright";
import type { Browser, Page } from "@cloudflare/playwright";
import { detectTech } from "@/lib/tech-signals";
import { putScreenshot, type AgentEnv } from "./env";

export async function launchAgentBrowser(env: AgentEnv): Promise<Browser> {
  return launch(env.bindings.MYBROWSER);
}

// Context options for testing customers' OWN apps (they consented to the run).
// Browser Rendering's defaults advertise "HeadlessChrome/…" in the UA and an
// 800x600 viewport — enough for frameworks, consent gates and analytics
// wrappers to silently no-op handlers, which is our #1 false-positive source
// (CHE-37: inert clicks/submits that work in every real browser). We present a
// normal desktop Chrome profile instead; the UA is derived from the actual
// engine version, so it stays truthful (Chrome's UA-reduction freezes the
// platform/minor tokens anyway). Deliberately NOT touched: navigator.webdriver
// and other fingerprint surfaces — defeating third-party bot protection is out
// of scope and prohibited.
export function agentContextOptions(browser: Browser): NonNullable<Parameters<Browser["newContext"]>[0]> {
  const major = browser.version().split(".")[0] || "126";
  return {
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  };
}

export async function applyNameShim(page: Page): Promise<void> {
  await page.addInitScript("window.__name = (fn) => fn;");
}

export interface SurfaceScanResult {
  status: number | null;
  techSignals: string[];
  internalLinkCount: number;
  screenshotUrl: string | null;
}

export async function surfaceScan(
  env: AgentEnv,
  browser: Browser,
  targetUrl: string,
): Promise<SurfaceScanResult> {
  const context = await browser.newContext(agentContextOptions(browser));
  const page = await context.newPage();
  await applyNameShim(page);
  try {
    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // The signal tables live in lib/tech-signals (CHE-132) so the free page
    // survey reads the same stack off a plain fetch that this scan reads off
    // the browser response.
    const signals = detectTech(response?.headers() ?? {}, await page.content());

    const origin = new URL(targetUrl).origin;
    const internalLinkCount = await page
      .evaluate((o: string) => {
        const hrefs = Array.from(document.querySelectorAll("a[href]"))
          .map((a) => {
            try {
              return new URL(a.getAttribute("href") ?? "", location.href).href;
            } catch {
              return null;
            }
          })
          .filter((h): h is string => Boolean(h && h.startsWith(o)));
        return new Set(hrefs).size;
      }, origin)
      .catch(() => 0);

    let screenshotUrl: string | null = null;
    try {
      const shot = await page.screenshot({ fullPage: false });
      screenshotUrl = (await putScreenshot(env, shot)).storageUrl;
    } catch {
      /* screenshot failure must not fail the scan */
    }

    return {
      status: response?.status() ?? null,
      techSignals: signals,
      internalLinkCount,
      screenshotUrl,
    };
  } finally {
    await context.close();
  }
}
