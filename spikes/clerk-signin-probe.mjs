// Spike (CHE-79 triage): does checkmyapp.dev's Clerk sign-in modal bounce an
// email/password attempt to Google OAuth? Dummy credentials on purpose — we're
// observing the FLOW, not authenticating.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const nav = [];
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) nav.push(f.url());
});
const net = [];
page.on("response", (r) => {
  if (/clerk|accounts\.google/.test(r.url())) net.push(`${r.status()} ${new URL(r.url()).host}${new URL(r.url()).pathname}`);
});

await page.goto("https://checkmyapp.dev/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.getByRole("button", { name: /sign in/i }).or(page.getByText(/^sign in$/i)).first().click({ timeout: 8000 });
await page.waitForTimeout(2500);

const email = page.locator('input[name="identifier"], input[type="email"]').first();
await email.fill("probe-does-not-exist@example.com", { timeout: 8000 });
// Password field may appear only after Continue (identifier-first flow).
const pwdVisibleBefore = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
console.log("password field visible before Continue:", pwdVisibleBefore);
if (pwdVisibleBefore) {
  await page.locator('input[type="password"]').first().fill("not-a-real-password-123");
}
await page.getByRole("button", { name: /^continue$/i }).first().click({ timeout: 8000 });
await page.waitForTimeout(4000);

const pwdVisibleAfter = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
const errText = await page.locator("text=/couldn't find|incorrect|invalid|error/i").first().textContent({ timeout: 2000 }).catch(() => null);
console.log("password field visible after Continue:", pwdVisibleAfter);
console.log("error text:", JSON.stringify(errText));
console.log("current URL:", page.url());
console.log("navigations:", nav.slice(-5));
console.log("clerk/google responses:", net.slice(-12));
await browser.close();
