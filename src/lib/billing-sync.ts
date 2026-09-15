// CHE-259 (Teams T6): keeping Stripe's quantity equal to the team's seats.
//
// Called after anything that changes who is on a team — an invitation accepted,
// a scope changed, somebody removed, somebody leaving. It is deliberately
// best-effort and silent: a Stripe outage must never stop a person from joining
// a team or an admin from removing one. Rule 4 says an outage on our side
// publishes nothing to a customer; the same instinct applies here, where the
// worst case of a failed sync is that we bill for a seat a day longer than we
// should, and the worst case of throwing would be a half-joined team.
//
// The quantity is derived from memberships every time rather than incremented,
// so a sync that was missed is corrected by the next one instead of compounding.

import { getStripe, type StripeEnv } from "./stripe";
import { subscriptionQuantity } from "./seats";
import type { TeamScope } from "./scopes";
import type { PrismaClient } from "@/generated/prisma/client";

export type SeatSyncResult =
  | { kind: "synced"; quantity: number }
  | { kind: "skipped"; why: "no subscription" | "billing not configured" | "no change" }
  | { kind: "failed"; why: string };

export async function syncTeamSeats(
  db: PrismaClient,
  env: StripeEnv,
  teamId: string,
): Promise<SeatSyncResult> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { stripeSubscriptionId: true },
  });
  if (!team?.stripeSubscriptionId) return { kind: "skipped", why: "no subscription" };

  const stripe = getStripe(env);
  if (!stripe) return { kind: "skipped", why: "billing not configured" };

  const memberships = await db.membership.findMany({
    where: { teamId },
    select: { scope: true },
  });
  const quantity = subscriptionQuantity(memberships.map((m) => ({ scope: m.scope as TeamScope })));

  try {
    const sub = await stripe.subscriptions.retrieve(team.stripeSubscriptionId);
    const item = sub.items.data[0];
    if (!item) return { kind: "failed", why: "subscription has no item" };
    if (item.quantity === quantity) return { kind: "skipped", why: "no change" };

    await stripe.subscriptionItems.update(item.id, {
      quantity,
      // Stripe's default for a quantity change is to prorate, which is what the
      // invite copy promised the admin. Saying it explicitly means a change to
      // Stripe's defaults cannot silently change what we charge.
      proration_behavior: "create_prorations",
    });
    return { kind: "synced", quantity };
  } catch (err) {
    // Logged, not thrown: see the note at the top. The next membership change
    // re-derives the quantity and puts it right.
    console.log(`[seats] sync failed for team ${teamId}: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: "failed", why: err instanceof Error ? err.message : String(err) };
  }
}
