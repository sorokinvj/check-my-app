// Spike: does joblander.app's login submit fire in headless Playwright?
// Mirrors the agent's interaction pattern (fill → click → observe network).
import { chromium } from "playwright";

const run = async (headless) => {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (r) => {
    if (r.url().includes("joblander.app/api")) requests.push(`${r.method()} ${r.url()}`);
  });
  await page.goto("https://joblander.app/login", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByPlaceholder(/email/i).or(page.locator('input[type="email"]')).first().fill("probe@example.com");
  await page.locator('input[type="password"]').first().fill("not-a-real-password-123");
  const before = requests.length;
  await page.getByRole("button", { name: /sign in/i }).first().click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  const after = requests.filter((r) => r.includes("email-signin"));
  console.log(`headless=${headless}: api requests after click:`, requests.slice(before));
  console.log(`  email-signin fired: ${after.length > 0}`);
  const errText = await page.locator("text=/invalid|error/i").first().textContent({ timeout: 2000 }).catch(() => null);
  console.log(`  ui feedback: ${JSON.stringify(errText)}`);
  await browser.close();
};

await run(true);
