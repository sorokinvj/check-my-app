// CHE-259 (Teams T6): what the team pays for.
//
// A **billable seat** is an admin or a member — the two scopes that can spend
// the team's plan. **Readers are free**, deliberately: a team should be able to
// give its designer, its support person and its investor a way to read what
// broke without anyone counting heads. It is also the shape that makes the
// product spread inside a company, which is the only way this product ever
// reaches the person who signs the invoice.
//
// (That is a pricing decision, not a technical one. It lives in one function so
// the owner can change it in one place — nothing else in the codebase knows how
// a seat is counted.)
//
// Everything here is pure. The Stripe half — pushing the quantity — is in
// src/lib/billing-sync.ts, so this file can be exercised without a network.

import { PLAN_LIMITS } from "./plans";
import type { UserPlan } from "./enums";
import type { TeamScope } from "./scopes";

// The scopes that cost money.
export const BILLABLE_SCOPES: TeamScope[] = ["admin", "member"];

export function isBillable(scope: TeamScope): boolean {
  return BILLABLE_SCOPES.includes(scope);
}

export function billableSeats(members: { scope: TeamScope }[]): number {
  return members.filter((m) => isBillable(m.scope)).length;
}

// Stripe's quantity for this team. Never below 1: a subscription for zero seats
// is not a subscription, and a team always has at least one admin (CHE-258).
export function subscriptionQuantity(members: { scope: TeamScope }[]): number {
  return Math.max(1, billableSeats(members));
}

export type SeatDecision =
  | { ok: true; seatsAfter: number; extraSeats: number }
  | { ok: false; reason: string };

// May this team add one more person with this scope?
//
// Two different answers, and they are different on purpose:
//
//   - a paying team GROWS. Adding a member past the plan's included seats is
//     allowed and the subscription's quantity goes up — being told "no" by
//     software you are paying for is how a team starts looking for a different
//     product. The copy says what it will cost before the click.
//   - a team on FREE does not, because there is nothing to meter. It is told
//     the plan's own number and what to do about it.
export function seatGate(
  plan: UserPlan,
  members: { scope: TeamScope }[],
  addingScope: TeamScope,
  hasSubscription: boolean,
): SeatDecision {
  const included = PLAN_LIMITS[plan].includedSeats;
  const current = billableSeats(members);
  const after = current + (isBillable(addingScope) ? 1 : 0);

  // A reader costs nothing, so no plan can refuse one.
  if (!isBillable(addingScope)) return { ok: true, seatsAfter: current, extraSeats: 0 };

  if (included === null) return { ok: true, seatsAfter: after, extraSeats: 0 };
  if (after <= included) return { ok: true, seatsAfter: after, extraSeats: 0 };

  if (!hasSubscription) {
    return {
      ok: false,
      reason:
        plan === "free"
          ? `Free covers ${included} ${included === 1 ? "person" : "people"} who can run checks. ` +
            `Readers are free and unlimited — invite them as a reader, or upgrade to add someone who can run checks.`
          : `Your plan covers ${included} people who can run checks, and there is no active subscription to add a seat to. ` +
            `Upgrade, or invite them as a reader.`,
    };
  }
  return { ok: true, seatsAfter: after, extraSeats: after - included };
}

// What an admin is told before they press Send, when the invitation will add a
// paid seat. Naming the number beforehand is the whole point: a charge nobody
// was warned about is the charge that gets disputed.
export function seatNotice(plan: UserPlan, decision: SeatDecision): string | null {
  if (!decision.ok || decision.extraSeats === 0) return null;
  const included = PLAN_LIMITS[plan].includedSeats;
  return (
    `This adds a seat: your plan includes ${included}, and this team will have ${decision.seatsAfter} people ` +
    `who can run checks. Your subscription is billed for the extra ${decision.extraSeats === 1 ? "seat" : `${decision.extraSeats} seats`}, prorated from today.`
  );
}

// What the team sees about its own seats, in one sentence. Readers are counted
// separately because "you have 7 people and pay for 3" is the thing a team
// wants to see rather than work out.
export function seatSummary(plan: UserPlan, members: { scope: TeamScope }[]): string {
  const billable = billableSeats(members);
  const readers = members.length - billable;
  const included = PLAN_LIMITS[plan].includedSeats;
  const head =
    included === null
      ? `${billable} ${billable === 1 ? "person" : "people"} can run checks.`
      : billable > included
        ? `${billable} of ${included} included seats used, ${billable - included} extra billed.`
        : `${billable} of ${included} included ${included === 1 ? "seat" : "seats"} used.`;
  return readers > 0
    ? `${head} ${readers} ${readers === 1 ? "reader" : "readers"}, free.`
    : head;
}
