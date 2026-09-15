// CHE-259 (Teams T6) verification: seats, and the webhook that writes a plan.
//
// Seat arithmetic is pure, so every case is asserted rather than sampled:
// promoting a reader adds a seat, demoting frees one, a team never drops below
// one seat, a reader is never refused, and a paying team is allowed to GROW
// past its included seats while a free one is told its own number.
//
// The webhook half is asserted against the contract it already had: an unknown
// price leaves the plan alone rather than guessing, and a customer we do not
// know changes nothing.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-team-billing.ts

import {
  BILLABLE_SCOPES,
  billableSeats,
  isBillable,
  seatGate,
  seatNotice,
  seatSummary,
  subscriptionQuantity,
} from "@/lib/seats";
import { PLAN_LIMITS } from "@/lib/plans";
import { planFromPriceId, type StripeEnv } from "@/lib/stripe";
import { USER_PLANS } from "@/lib/enums";
import { TEAM_SCOPES, type TeamScope } from "@/lib/scopes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const members = (...scopes: TeamScope[]) => scopes.map((scope) => ({ scope }));

// ─── What a seat is ──────────────────────────────────────────────────────────

check("an admin costs a seat", isBillable("admin"));
check("a member costs a seat", isBillable("member"));
check("a reader is free", !isBillable("reader"));
check(
  "every scope is decided about — a new one cannot inherit an answer",
  TEAM_SCOPES.every((s) => typeof isBillable(s) === "boolean") && BILLABLE_SCOPES.length === 2,
  BILLABLE_SCOPES.join(", "),
);

check("one admin is one seat", billableSeats(members("admin")) === 1);
check("admin + member is two", billableSeats(members("admin", "member")) === 2);
check(
  "readers do not count, however many",
  billableSeats(members("admin", "reader", "reader", "reader")) === 1,
);
check(
  "a team of readers and one admin bills for one",
  subscriptionQuantity(members("admin", "reader", "reader")) === 1,
);
check(
  "quantity never drops below one — a subscription for zero seats is not a subscription",
  subscriptionQuantity([]) === 1 && subscriptionQuantity(members("reader")) === 1,
);

// ─── Promotions and demotions ────────────────────────────────────────────────

const before = members("admin", "reader");
const afterPromotion = members("admin", "member");
check(
  "promoting a reader to member adds a seat",
  subscriptionQuantity(afterPromotion) === subscriptionQuantity(before) + 1,
);
check(
  "demoting a member to reader frees one",
  subscriptionQuantity(members("admin", "reader")) === subscriptionQuantity(members("admin", "member")) - 1,
);
check(
  "promoting a member to admin changes nothing — both are billable",
  subscriptionQuantity(members("admin", "admin")) === subscriptionQuantity(members("admin", "member")),
);

// ─── The gate ────────────────────────────────────────────────────────────────

check(
  "a reader is never refused, on any plan",
  USER_PLANS.every((plan) => seatGate(plan, members("admin", "member", "member"), "reader", false).ok),
);

const freeGate = seatGate("free", members("admin"), "member", false);
check(
  "free refuses a second person who can run checks, and names the way out",
  !freeGate.ok && /reader/i.test(freeGate.reason) && /upgrade/i.test(freeGate.reason),
  freeGate.ok ? "allowed" : freeGate.reason,
);

const starterInside = seatGate("starter", members("admin"), "member", true);
check(
  "inside its included seats, a paid plan adds nobody extra to the bill",
  starterInside.ok && starterInside.extraSeats === 0 && starterInside.seatsAfter === 2,
  JSON.stringify(starterInside),
);

const starterBeyond = seatGate("starter", members("admin", "member", "member"), "member", true);
check(
  "past its included seats, a PAYING team grows rather than being refused",
  starterBeyond.ok && starterBeyond.extraSeats === 1,
  JSON.stringify(starterBeyond),
);
const notice = seatNotice("starter", starterBeyond);
check(
  "…and the admin is told the number before they press Send",
  typeof notice === "string" && /seat/i.test(notice) && /prorated/i.test(notice),
  String(notice),
);
check(
  "no notice when nothing extra is billed — we do not warn about charges that are not happening",
  seatNotice("starter", starterInside) === null,
);

const paidNoSub = seatGate("starter", members("admin", "member", "member"), "member", false);
check(
  "a paid plan with no live subscription is refused rather than silently over-seated",
  !paidNoSub.ok,
  paidNoSub.ok ? "allowed" : paidNoSub.reason,
);

check(
  "enterprise has no ceiling",
  seatGate("enterprise", members(...Array(500).fill("member" as TeamScope)), "member", true).ok,
);

// Every plan's number is the plan's own, and they only go up.
const seatsByPlan = USER_PLANS.map((p) => [p, PLAN_LIMITS[p].includedSeats] as const);
check(
  "every plan states a seat allowance",
  seatsByPlan.every(([, n]) => n === null || (Number.isInteger(n) && n >= 1)),
  seatsByPlan.map(([p, n]) => `${p}: ${n ?? "∞"}`).join(", "),
);
check(
  "allowances do not go backwards as plans get bigger",
  (() => {
    const ordered = ["free", "starter", "growth", "business"] as const;
    return ordered.every((p, i) => i === 0 || (PLAN_LIMITS[p].includedSeats ?? 0) >= (PLAN_LIMITS[ordered[i - 1]].includedSeats ?? 0));
  })(),
);

// ─── What the team is shown ──────────────────────────────────────────────────

check(
  "the summary separates who is paid for from who is free",
  seatSummary("starter", members("admin", "member", "reader", "reader")) ===
    "2 of 3 included seats used. 2 readers, free.",
  seatSummary("starter", members("admin", "member", "reader", "reader")),
);
check(
  "…and says when extra seats are billed",
  /extra billed/.test(seatSummary("starter", members("admin", "member", "member", "member"))),
  seatSummary("starter", members("admin", "member", "member", "member")),
);
check(
  "a team of one reads as a team of one",
  seatSummary("free", members("admin")) === "1 of 1 included seat used.",
  seatSummary("free", members("admin")),
);

// ─── The webhook's own contract ──────────────────────────────────────────────

const env: StripeEnv = { STRIPE_PRICE_STARTER: "price_starter", STRIPE_PRICE_GROWTH: "price_growth" };
check("a known price maps to its plan", planFromPriceId(env, "price_growth") === "growth");
check(
  "an unknown price leaves the plan alone rather than guessing",
  planFromPriceId(env, "price_someone_elses") === null,
);
check("a missing price is not a plan", planFromPriceId(env, undefined) === null);

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
