import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

// Dogfood: the paid funnel end-to-end (CHE-40). A signed-in owner asks for a
// Starter Checkout Session, walks Stripe's hosted page with the documented test
// card, and lands back on /dashboard?upgraded=1. Requires the Stripe TEST keys
// on the target (skips cleanly when billing is unconfigured, e.g. local dev
// without keys) — the webhook→plan flip is asserted out-of-band, not here.
const BASE = process.env.TARGET_URL ?? "http://localhost:3000";

async function signIn(page: import("@playwright/test").Page) {
  await setupClerkTestingToken({ page });
  await page.goto(`${BASE}/`);
  await clerk.signIn({ page, emailAddress: process.env.E2E_CLERK_USER_EMAIL! });
}

test("signed-in owner gets a Stripe Checkout session for Starter", async ({ page }) => {
  await signIn(page);
  const res = await page.request.post(`${BASE}/api/billing/checkout`, {
    data: { plan: "starter" },
  });
  if (res.status() === 503) test.skip(true, "billing not configured on this target");
  expect(res.ok()).toBe(true);
  const { url } = (await res.json()) as { url: string };
  expect(url).toContain("checkout.stripe.com");
});

test("owner completes Stripe test-card checkout and returns upgraded", async ({ page }) => {
  await signIn(page);
  const res = await page.request.post(`${BASE}/api/billing/checkout`, {
    data: { plan: "starter" },
  });
  if (res.status() === 503) test.skip(true, "billing not configured on this target");
  const { url } = (await res.json()) as { url: string };

  await page.goto(url);
  // Stripe's hosted Checkout. Test card per Stripe docs; nothing real is charged.
  await page.getByPlaceholder("1234 1234 1234 1234").fill("4242 4242 4242 4242");
  await page.getByPlaceholder("MM / YY").fill("12 / 34");
  await page.getByPlaceholder("CVC").fill("123");
  await page.getByPlaceholder(/full name/i).fill("CheckMyApp E2E");
  const postal = page.getByPlaceholder(/zip|postal/i).first();
  if (await postal.isVisible().catch(() => false)) await postal.fill("10001");

  await page.getByTestId("hosted-payment-submit-button").click();
  await page.waitForURL(/dashboard\?upgraded=1/, { timeout: 45_000 });
  await expect(page).toHaveURL(/upgraded=1/);
});
