// Phase 2 — Surface scan (CHE-1). Deterministic, no LLM: load the homepage,
// detect stack signals from headers + bundle markers, count internal links,
// capture the first screenshot for the live screen.

import type { Browser } from "playwright";
import { storeScreenshot } from "./evidence";

export interface SurfaceScanResult {
  status: number | null;
  techSignals: string[]; // ["Next.js", "Vercel", ...]
  internalLinkCount: number;
  screenshotUrl: string | null;
}

const HEADER_SIGNALS: Array<[header: string, test: RegExp, label: string]> = [
  ["x-powered-by", /next\.js/i, "Next.js"],
  ["x-powered-by", /express/i, "Express"],
  ["server", /vercel/i, "Vercel"],
  ["server", /cloudflare/i, "Cloudflare"],
  ["x-vercel-id", /.+/, "Vercel"],
  ["cf-ray", /.+/, "Cloudflare"],
  ["x-served-by", /fastly/i, "Fastly"],
  ["x-amz-cf-id", /.+/, "CloudFront"],
];

const HTML_SIGNALS: Array<[test: RegExp, label: string]> = [
  [/__NEXT_DATA__|\/_next\//, "Next.js"],
  [/data-reactroot|react-dom/i, "React"],
  [/__NUXT__/, "Nuxt"],
  [/_sveltekit|svelte/i, "Svelte"],
  [/ng-version/, "Angular"],
  [/wp-content|wp-includes/, "WordPress"],
  [/cdn\.tailwindcss|tailwind/i, "Tailwind"],
  [/supabase/i, "Supabase"],
  [/firebaseapp|firebaseio/i, "Firebase"],
  [/js\.stripe\.com/i, "Stripe"],
  [/posthog/i, "Posthog"],
];

export async function surfaceScan(args: {
  browser: Browser;
  targetUrl: string;
}): Promise<SurfaceScanResult> {
  const { browser, targetUrl } = args;
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const signals = new Set<string>();
    const headers = response?.headers() ?? {};
    for (const [header, test, label] of HEADER_SIGNALS) {
      if (headers[header] && test.test(headers[header])) signals.add(label);
    }

    const html = await page.content();
    for (const [test, label] of HTML_SIGNALS) {
      if (test.test(html)) signals.add(label);
    }

    const origin = new URL(targetUrl).origin;
    const internalLinkCount = await page
      .evaluate(
        (o: string) =>
          new Set(
            Array.from(document.querySelectorAll("a[href]"))
              .map((a) => {
                try {
                  return new URL(a.getAttribute("href") ?? "", location.href).href;
                } catch {
                  return null;
                }
              })
              .filter((href): href is string => Boolean(href && href.startsWith(o))),
          ).size,
        origin,
      )
      .catch(() => 0);

    let screenshotUrl: string | null = null;
    try {
      const buffer = await page.screenshot({ fullPage: false });
      screenshotUrl = (await storeScreenshot(buffer)).storageUrl;
    } catch {
      // screenshot failure should not fail the scan
    }

    return {
      status: response?.status() ?? null,
      techSignals: Array.from(signals),
      internalLinkCount,
      screenshotUrl,
    };
  } finally {
    await context.close();
  }
}
