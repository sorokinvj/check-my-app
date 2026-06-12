// CHE-20 spike — does @cloudflare/playwright on Browser Rendering run the
// primitives our agent core depends on?
//
// The load-bearing worry from M1: the bundler (esbuild, both tsx locally and
// wrangler here) injects `__name(fn, "...")` helper calls into functions.
// Playwright serializes the function source for page.evaluate, so the browser
// throws "ReferenceError: __name is not defined". We fixed it locally with an
// addInitScript shim — this spike proves the same shim works on Workers.

import { launch } from "@cloudflare/playwright";
import Anthropic from "@anthropic-ai/sdk";

interface Env {
  MYBROWSER: Fetcher;
  ANTHROPIC_API_KEY?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const out: Record<string, unknown> = {};

    const browser = await launch(env.MYBROWSER);
    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      // 1. addInitScript — the __name shim (same as our prepareAgentPage).
      await page.addInitScript("window.__name = (fn) => fn;");
      out.addInitScript = "ok";

      // 2. navigate to a public, stable target.
      const target = url.searchParams.get("target") ?? "https://example.com";
      const res = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
      out.navigate = { url: page.url(), status: res?.status() ?? null };

      // 3. page.evaluate with a named arrow fn — this is what esbuild wraps in
      //    __name(...). If the shim didn't apply, this throws in the browser.
      const digest = await page.evaluate(() => {
        const clip = (s: string | null | undefined, n = 60) =>
          (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
        return {
          title: document.title,
          h1: clip(document.querySelector("h1")?.textContent),
          links: document.querySelectorAll("a[href]").length,
          buttons: document.querySelectorAll("button,[role=button]").length,
        };
      });
      out.evaluate = digest;

      // 4. screenshot — returns a Buffer/Uint8Array we can size-check.
      const shot = await page.screenshot({ fullPage: false });
      out.screenshot = { bytes: shot.length };

      // 5. (optional) one Sonnet nav iteration with a tool, to measure cost.
      if (url.searchParams.get("agent") === "1" && env.ANTHROPIC_API_KEY) {
        const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        const resp = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
          system:
            "You are a web QA agent. Decide the single next action on this page. Respond with the tool call only.",
          tools: [
            {
              name: "click",
              description: "Click an element by role and accessible name.",
              input_schema: {
                type: "object",
                properties: { role: { type: "string" }, name: { type: "string" } },
                required: ["role"],
              },
            },
          ],
          messages: [
            {
              role: "user",
              content: `Page digest: ${JSON.stringify(digest)}. What is the next action to explore this app?`,
            },
          ],
        });
        const u = resp.usage;
        const costUsd =
          (u.input_tokens * 3 +
            (u.cache_creation_input_tokens ?? 0) * 3.75 +
            (u.cache_read_input_tokens ?? 0) * 0.3 +
            u.output_tokens * 15) /
          1e6;
        out.agent = {
          stop_reason: resp.stop_reason,
          usage: u,
          oneIterationCostUsd: Number(costUsd.toFixed(5)),
          // very rough: a full run was ~180 iterations in M1
          projectedRunCostUsd: Number((costUsd * 180).toFixed(3)),
        };
      }

      out.verdict = "ALL PRIMITIVES OK";
      return Response.json(out, { headers: { "content-type": "application/json" } });
    } catch (err) {
      out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return Response.json(out, { status: 500 });
    } finally {
      await browser.close();
    }
  },
};
