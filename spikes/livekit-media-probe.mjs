// Spike (CHE-70): can a headless browser drive JobLander's LiveKit "Start
// Video" once fake media devices exist? Run A = plain headless (mirrors
// Cloudflare Browser Rendering today), run B = fake-media launch flags.
// Password arrives via env (never printed).
import { chromium } from "playwright";

const pw = process.env.PW;
if (!pw) throw new Error("PW env not set");

async function probe(label, launchArgs) {
  const browser = await chromium.launch({ headless: true, args: launchArgs });
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  const log = [];
  page.on("response", (r) => {
    if (/connection-details|email-signin/.test(r.url())) log.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });

  await page.goto("https://joblander.app/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator('input[type="email"]').first().fill("test@joblander.app");
  await page.locator('input[type="password"]').first().fill(pw);
  await page.getByRole("button", { name: /sign in/i }).first().click();
  await page.waitForURL(/dashboard/, { timeout: 15000 }).catch(() => {});

  const devices = await page.evaluate(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.map((d) => d.kind);
  });

  await page.goto("https://joblander.app/practice", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /start call/i }).first().click({ timeout: 10000 }).catch((e) => log.push("start-call click failed: " + e.message.split("\n")[0]));
  await page.waitForTimeout(4000);

  const startVideo = page.locator(".lk-start-audio-button, button:has-text('Start Video')").first();
  const visible = await startVideo.isVisible().catch(() => false);
  let clicked = "n/a";
  if (visible) {
    try {
      await startVideo.click({ timeout: 5000 });
      clicked = "yes";
    } catch (e) { clicked = "failed: " + e.message.split("\n")[0]; }
  }
  await page.waitForTimeout(4000);
  // Did a live session actually start? Look for LiveKit signs of an active room.
  const state = await page.evaluate(() => {
    const txt = document.body.innerText.slice(0, 4000);
    return {
      hasConversation: /conversation/i.test(txt),
      hasDisconnect: /disconnect|end call|leave/i.test(txt),
      micButtons: document.querySelectorAll("[class*=lk-]").length,
    };
  });
  console.log(`--- ${label} ---`);
  console.log("devices:", JSON.stringify(devices));
  console.log("network:", JSON.stringify(log));
  console.log("startVideo visible:", visible, "| clicked:", clicked);
  console.log("state:", JSON.stringify(state));
  await browser.close();
}

await probe("A: plain headless", []);
await probe("B: fake media flags", [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
]);
