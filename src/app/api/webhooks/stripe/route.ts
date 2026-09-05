// Stripe → User.plan sync (CHE-40 phase 3).
//
// Stripe posts subscription lifecycle events here; we keep `User.plan` and the
// stored customer/subscription ids in step. Inert until STRIPE_SECRET_KEY +
// STRIPE_WEBHOOK_SECRET are set and the endpoint is registered in the Stripe
// dashboard — returns 503 until then. Public route (signature-verified, not
// session; clerkMiddleware only protects page routes, so a cookieless POST
// passes straight through).

import type Stripe from "stripe";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db";
import {
  getStripe,
  getStripeEnv,
  planFromPriceId,
  stripeCryptoProvider,
  type StripeEnv,
} from "@/lib/stripe";
import { isPaidOneCheck, startPaidCheck } from "@/lib/one-check";
import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "@/lib/enums";

function customerIdOf(c: string | { id: string } | null): string | null {
  return typeof c === "string" ? c : (c?.id ?? null);
}

// A subscription no longer in good standing pays for nothing.
const GOOD_STANDING: Stripe.Subscription.Status[] = ["active", "trialing"];

function planFromSubscription(env: StripeEnv, sub: Stripe.Subscription): UserPlan | null {
  if (!GOOD_STANDING.includes(sub.status)) return "free";
  // Quantity-1 single-item subscriptions only (checkout creates exactly that).
  return planFromPriceId(env, sub.items.data[0]?.price?.id);
}

async function findUserForSubscription(db: PrismaClient, sub: Stripe.Subscription) {
  const customerId = customerIdOf(sub.customer);
  if (customerId) {
    const byCustomer = await db.user.findUnique({ where: { stripeCustomerId: customerId } });
    if (byCustomer) return byCustomer;
  }
  return db.user.findFirst({ where: { stripeSubscriptionId: sub.id } });
}

export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const stripeEnv = getStripeEnv(env as Record<string, unknown>);
  const stripe = getStripe(stripeEnv);
  if (!stripe || !stripeEnv.STRIPE_WEBHOOK_SECRET) {
    return new Response("stripe webhook not configured", { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    // workerd: async SubtleCrypto verification — constructEvent (sync) throws.
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      signature,
      stripeEnv.STRIPE_WEBHOOK_SECRET,
      undefined,
      stripeCryptoProvider,
    );
  } catch {
    return new Response("invalid signature", { status: 400 });
  }

  const db = getDb(env as unknown as { DB: D1Database });

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;

      // A paid one-off check (src/lib/one-check.ts): create the run the
      // payment bought. Idempotent — the success page may have started it
      // already, and Stripe retries deliveries.
      if (session.mode === "payment") {
        const pendingCheckId = session.metadata?.pendingCheckId;
        if (pendingCheckId && isPaidOneCheck(session)) {
          await startPaidCheck(db, pendingCheckId, session.id);
        }
        break;
      }

      // A plan subscription: sync User.plan from the price.
      if (session.mode !== "subscription") break;
      const userId = session.client_reference_id ?? session.metadata?.userId;
      if (!userId) break; // not one of ours (checkout we didn't create)
      const user = await db.user.findUnique({ where: { id: userId } });
      if (!user) break;

      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription?.id ?? null);
      // The session payload carries no line items — the subscription holds the
      // price, and the price decides the plan.
      let plan: UserPlan | null = null;
      if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        plan = planFromSubscription(stripeEnv, sub);
      }
      await db.user.update({
        where: { id: user.id },
        data: {
          stripeCustomerId: customerIdOf(session.customer) ?? user.stripeCustomerId,
          stripeSubscriptionId: subscriptionId,
          // Unknown price → leave the plan alone rather than guessing.
          ...(plan ? { plan } : {}),
        },
      });
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object;
      const user = await findUserForSubscription(db, sub);
      if (!user) break;
      const plan = planFromSubscription(stripeEnv, sub);
      await db.user.update({
        where: { id: user.id },
        data: { stripeSubscriptionId: sub.id, ...(plan ? { plan } : {}) },
      });
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const user = await findUserForSubscription(db, sub);
      if (!user) break;
      await db.user.update({
        where: { id: user.id },
        data: { plan: "free", stripeSubscriptionId: null },
      });
      break;
    }

    default:
      // Everything else (invoices, payment intents, …): acknowledged, ignored.
      break;
  }

  return new Response("ok", { status: 200 });
}
