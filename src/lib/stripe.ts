// Stripe on workerd (CHE-40 phase 3). Everything here is env-gated: no Stripe
// account exists yet, so getStripe() returns null until STRIPE_SECRET_KEY is
// set and billing endpoints answer 503 `billing_unconfigured` (the UI shows a
// quiet "launches soon" note, not an error).
//
// workerd has no Node http — the client must use fetch, and webhook signature
// verification must go through SubtleCrypto (constructEventAsync, never the
// sync constructEvent).

import Stripe from "stripe";
import type { UserPlan } from "./enums";

export const BILLING_UNCONFIGURED = {
  error: "Billing isn't live yet",
  code: "billing_unconfigured",
} as const;

// Stripe-billable plans. Business/enterprise stay manual (mailto) for now.
export type BillablePlan = "starter" | "growth";
export const BILLABLE_PLANS: BillablePlan[] = ["starter", "growth"];

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_GROWTH?: string;
}

export function getStripeEnv(env: Record<string, unknown>): StripeEnv {
  return {
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY as string | undefined,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET as string | undefined,
    STRIPE_PRICE_STARTER: env.STRIPE_PRICE_STARTER as string | undefined,
    STRIPE_PRICE_GROWTH: env.STRIPE_PRICE_GROWTH as string | undefined,
  };
}

// Null until the owner adds keys — callers turn that into the 503 above.
export function getStripe(env: StripeEnv): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

// Required for constructEventAsync on workerd (no Node crypto).
export const stripeCryptoProvider = Stripe.createSubtleCryptoProvider();

export function priceIdForPlan(env: StripeEnv, plan: BillablePlan): string | null {
  const id = plan === "starter" ? env.STRIPE_PRICE_STARTER : env.STRIPE_PRICE_GROWTH;
  return id || null;
}

// Reverse map: Stripe price id → User.plan. Unknown price → null (caller
// decides; the webhook leaves the plan alone rather than guessing).
export function planFromPriceId(env: StripeEnv, priceId: string | null | undefined): UserPlan | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_STARTER) return "starter";
  if (priceId === env.STRIPE_PRICE_GROWTH) return "growth";
  return null;
}
