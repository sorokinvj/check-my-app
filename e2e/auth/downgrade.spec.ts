import { test, expect } from "@playwright/test";
import Stripe from "stripe";

// Dogfood: the downgrade half of the billing cycle (CHE-55). The billing spec
// upgrades the test user to Starter via hosted Checkout; this spec cancels that
// subscription through the Stripe TEST API, which makes Stripe fire
// `customer.subscription.deleted` at our webhook and flip the user back to
// plan=free in D1.
//
// What is asserted HERE is only the Stripe side (cancellation succeeded) — the
// webhook→D1 plan flip is asserted out-of-band (the orchestrator checks D1),
// because no public surface renders the plan and polling one would be flaky.
// Leaving the user on free is deliberate: it makes the quota_free branch of the
// quotas spec deterministic for future runs.
//
// Ordering matters: Playwright runs spec files alphabetically with workers=1,
// so billing → downgrade → quotas → sign-in. Downgrade must precede quotas.
//
// Requires STRIPE_SECRET_KEY (TEST key, same one the server uses) in the env;
// skips cleanly when it's absent.

test("cancel the test user's Stripe subscription (downgrade to free)", async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  test.skip(!key, "STRIPE_SECRET_KEY not set — skipping downgrade");
  const email = process.env.E2E_CLERK_USER_EMAIL;
  test.skip(!email, "E2E_CLERK_USER_EMAIL not set — skipping downgrade");

  const stripe = new Stripe(key!);

  // The checkout route reuses one Stripe customer per user, but search by email
  // and sweep every match + every active/trialing subscription so repeated E2E
  // runs can never accumulate live test subscriptions.
  const customers = await stripe.customers.list({ email: email!, limit: 100 });
  test.skip(customers.data.length === 0, "no Stripe customer for the test user — nothing to cancel");

  const cancelled: Stripe.Subscription[] = [];
  for (const customer of customers.data) {
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 100,
    });
    for (const sub of subs.data) {
      if (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due") {
        cancelled.push(await stripe.subscriptions.cancel(sub.id));
      }
    }
  }

  test.skip(cancelled.length === 0, "no active subscription for the test user — nothing to cancel");

  // Stripe confirms the cancellation synchronously; the webhook it emits is
  // what downgrades the plan in D1 (asserted out-of-band, see header).
  for (const sub of cancelled) {
    expect(sub.status).toBe("canceled");
  }
});
