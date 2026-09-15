import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";
import { activeTeamContext } from "@/lib/teams";
import { can, refusal } from "@/lib/scopes";
import {
  BILLING_UNCONFIGURED,
  getStripe,
  getStripeEnv,
  priceIdForPlan,
  type BillablePlan,
  BILLABLE_PLANS,
} from "@/lib/stripe";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";

// Prod build inlines https://checkmyapp.dev (.env.production); local dev lands
// back on localhost. Stripe requires absolute URLs here.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://checkmyapp.dev";

// POST /api/billing/checkout — start a Stripe Checkout session for a paid plan
// (CHE-40 phase 3). Owner feature: requires auth. Env-gated: 503 with
// `billing_unconfigured` until STRIPE_SECRET_KEY + price ids exist, so the
// route ships before the Stripe account does.
export async function POST(req: Request) {
  // CHE-193: our own checker never opens a checkout. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const { env } = getCloudflareContext();
  const stripeEnv = getStripeEnv(env as Record<string, unknown>);
  const stripe = getStripe(stripeEnv);
  if (!stripe) return NextResponse.json(BILLING_UNCONFIGURED, { status: 503 });

  const db = getDb(env as unknown as { DB: D1Database });
  const user = await getOptionalUser(db);
  if (!user) {
    return NextResponse.json({ error: "Sign in to upgrade" }, { status: 401 });
  }
  // CHE-253: the subscription belongs to the team this person is acting for,
  // and only an admin may buy one — `billing.manage` in src/lib/scopes.ts.
  const context = await activeTeamContext(db, user);
  if (!can(context.scope, "billing.manage")) {
    return NextResponse.json({ error: refusal(context.scope, "billing.manage") }, { status: 403 });
  }
  const team = context.team;

  const json = (await req.json().catch(() => null)) as { plan?: unknown } | null;
  const plan = json?.plan;
  if (typeof plan !== "string" || !BILLABLE_PLANS.includes(plan as BillablePlan)) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const priceId = priceIdForPlan(stripeEnv, plan as BillablePlan);
  if (!priceId) return NextResponse.json(BILLING_UNCONFIGURED, { status: 503 });

  // Reuse the Stripe customer across upgrades; create one on first checkout.
  // A stored id can also be stale — customers created in TEST mode don't exist
  // once the account runs LIVE keys (the 2026-08-22 switch broke checkout for
  // every pre-switch user this way) — so a missing customer is recreated, not
  // an error.
  const createCustomer = async () => {
    const customer = await stripe.customers.create({
      email: user.email || undefined,
      name: team.name || user.name || undefined,
      metadata: { teamId: team.id, createdByUserId: user.id },
    });
    await db.team.update({
      where: { id: team.id },
      data: { stripeCustomerId: customer.id },
    });
    return customer.id;
  };
  let customerId = team.stripeCustomerId ?? (await createCustomer());

  const createSession = (customer: string) =>
    stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: priceId, quantity: 1 }],
      // client_reference_id stays the person (it is what PostHog joins on);
      // teamId is what the webhook writes the plan to. userId is kept so a
      // session created before CHE-253 and paid after it still resolves.
      client_reference_id: user.id,
      metadata: { teamId: team.id, userId: user.id },
      success_url: `${APP_URL}/dashboard?upgraded=1`,
      cancel_url: `${APP_URL}/pricing`,
    });

  let session;
  try {
    session = await createSession(customerId);
  } catch (err) {
    const missing =
      typeof err === "object" && err !== null && "code" in err && err.code === "resource_missing";
    if (!missing) throw err;
    customerId = await createCustomer();
    session = await createSession(customerId);
  }

  if (!session.url) {
    return NextResponse.json({ error: "Stripe returned no checkout URL" }, { status: 502 });
  }
  return NextResponse.json({ url: session.url });
}
