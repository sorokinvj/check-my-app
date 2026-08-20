import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Pricing — CheckMyApp",
  description: "Free first check. Daily Watch from $29/mo per app.",
};

// Pricing · /pricing (CHE-40 phase 2a) — static page, no checkout yet.
// Paid CTAs land on /sign-in; Stripe arrives in a later phase.

type Plan = {
  name: string;
  price: string;
  priceNote?: string;
  blurb: string;
  features: string[];
  cta: { label: string; href: string };
  recommended?: boolean;
};

const PLANS: Plan[] = [
  {
    name: "Free",
    price: "$0",
    blurb: "See what the agent sees. No card, no signup.",
    features: [
      "1 check/day without signup",
      "3 checks total with a free account",
      "Evidence on every verdict — screenshots, network logs",
      "Agent-written Playwright specs",
    ],
    cta: { label: "Check your app", href: "/check" },
  },
  {
    name: "Starter",
    price: "$29",
    priceNote: "/mo per app",
    blurb: "Your app, watched every day.",
    features: [
      "Daily Watch — a fresh check every 24h",
      "Regression alerts by email",
      "90-day evidence history",
      "Export Playwright specs to GitHub as a PR",
    ],
    cta: { label: "Start free", href: "/sign-in" },
    recommended: true,
  },
  {
    name: "Growth",
    price: "$99",
    priceNote: "/mo",
    blurb: "For teams shipping more than one thing.",
    features: [
      "Up to 5 apps",
      "Checks every 6h",
      "Findings auto-filed to your tracker — Linear now, GitHub next — with dedup & escalation",
      "Team access",
    ],
    cta: { label: "Start free", href: "/sign-in" },
  },
  {
    name: "Business",
    price: "from $499",
    priceNote: "/mo",
    blurb: "Compliance-grade checking, on your terms.",
    features: [
      "Custom check frequency",
      "SSO",
      "SLA",
      "Premium agent models",
      "API access",
    ],
    cta: { label: "Talk to us", href: "mailto:sorokinvj@gmail.com" },
  },
];

// Link styled like Button's primary / outline variants — CTAs here are
// navigations, not actions, so <a> is the right element.
const CTA_BASE =
  "inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm transition-colors";
const CTA_PRIMARY = "bg-accent font-semibold text-ink-950 hover:bg-accent-hover";
const CTA_OUTLINE = "border border-ink-600 bg-ink-850 text-fg hover:border-ink-700 hover:bg-ink-800";

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-16">
      <div className="stagger space-y-10">
        <div className="space-y-3 text-center">
          <p className="section-label">pricing · launch</p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-[2.75rem] sm:leading-[1.1]">
            First check is free.
            <br />
            Staying certain is <span className="text-accent">$29</span>.
          </h1>
          <p className="mx-auto max-w-xl text-sm text-fg-muted">
            An agent explores your app like a first-time user and returns an evidence-backed
            verdict. Daily Watch re-checks every day and alerts you the moment something breaks.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={`card relative flex flex-col p-5 ${plan.recommended ? "border-accent/50" : ""}`}
            >
              {plan.recommended && (
                <span className="absolute -top-2.5 left-5 rounded-full border border-accent/50 bg-ink-850 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
                  recommended
                </span>
              )}
              <p className="section-label">{plan.name}</p>
              <p className="mt-3 text-2xl font-semibold tracking-tight text-fg">
                {plan.price}
                {plan.priceNote && (
                  <span className="ml-1 font-mono text-xs font-normal text-fg-faint">
                    {plan.priceNote}
                  </span>
                )}
              </p>
              <p className="mt-2 text-sm text-fg-muted">{plan.blurb}</p>
              <ul className="mt-4 flex-1 space-y-2.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2 text-sm leading-5 text-fg-muted">
                    <span className="font-mono text-fg-faint">→</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-5">
                <Link
                  href={plan.cta.href}
                  className={`${CTA_BASE} ${plan.recommended ? CTA_PRIMARY : CTA_OUTLINE}`}
                >
                  {plan.cta.label}
                </Link>
              </div>
            </div>
          ))}
        </div>

        <p className="mx-auto max-w-2xl text-center font-mono text-[13px] leading-6 text-fg-faint">
          Launch pricing. A full first check of a typical app runs ~$0.50 of agent compute — we
          keep the free tier honest, not infinite.
        </p>
      </div>
    </main>
  );
}
