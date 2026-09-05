// Product analytics for the launch (owner, 2026-09-05): PostHog on the client,
// one typed `track()` for the product's own events, and a client-side A/B
// bucket so two landing variants can be measured side by side without a
// PostHog experiment (we hold no personal API key, so flags cannot be created
// server-side; the bucket is computed here and stamped on every event).
//
// What this file guarantees, by mechanism rather than by habit:
//
// - Every event name is a member of `AnalyticsEvents`; `track()` refuses any
//   other string and any property shape other than the one declared here.
//   scripts/verify-analytics.ts checks the catalogue has no duplicates.
// - Nothing a customer typed for us — a test password, a test e-mail, the
//   address of their app beyond its hostname — can ride along on an event:
//   `guardEvent` (installed as `before_send`) drops autocapture events that
//   touch a sensitive input and strips property keys that look like secrets.
//   The SDK already skips inputs of type text/email/password/url on its own;
//   the guard is the belt to that pair of braces.
// - The landing variant is a pure function of the browser's device id, so a
//   visitor sees the same variant on every visit and after signing in.
//
// Inputs that must carry `className="ph-no-capture"` once phase 2 touches the
// forms (the SDK ignores such elements for autocapture, rage clicks and dead
// clicks): the test-login e-mail and password in src/components/submit-form.tsx,
// the notify e-mail there, and any credential field a later form adds. The
// guard below is the safety net for the day someone forgets.

import posthog from "posthog-js";
import type { CaptureResult } from "posthog-js";
import { useSyncExternalStore } from "react";

// Public client token for PostHog project 595090 (US cloud). It is a write-only
// key that every visitor's browser receives anyway; keeping it a constant means
// no env plumbing and no build that silently ships without analytics.
export const POSTHOG_TOKEN = "phc_yDqQQgx3vGfFvp97tEWsExEsLPnnGi6jp9XAqfooQTcn";
export const POSTHOG_HOST = "https://us.i.posthog.com";

// ─── Event catalogue ────────────────────────────────────────────────────────
//
// One entry per event the product emits from the browser, with the exact
// property shape. Phase 2 wires the calls; the names are fixed here so that
// PostHog insights built against them survive the wiring.
//
// `appSlug` is the hostname of the customer's app — never the full URL, never
// a path, never a query string.

export type AnalyticsEvents = {
  /** One per client-side navigation, sent to PostHog as `$pageview`. */
  pageview: { path: string };
  /** The check form was submitted and accepted client-side. */
  check_submitted: { appSlug: string; hasCredentials: boolean; hasNotifyEmail: boolean };
  /** The server refused a check; `code` is the API's rejection code. */
  check_rejected: { code: string };
  /** The site-wide daily quota page was shown. */
  quota_site_hit: undefined;
  /** The one-off paid check call to action was clicked. */
  one_check_clicked: undefined;
  /** A Stripe checkout was opened for `plan`. */
  checkout_opened: { plan: string };
  /** A verdict page was viewed. `verdict` is the run's verdict enum value. */
  verdict_viewed: { appSlug: string; verdict: string; isOwner: boolean };
  /** The example verdict link on the landing page was clicked. */
  example_verdict_clicked: undefined;
  /** The "checks run today" list was viewed. */
  today_checks_viewed: undefined;
  /** A sign-in control was clicked; `from` names the surface (header, verdict…). */
  sign_in_clicked: { from: string };
  /** Daily watch was enabled for an app. */
  watch_enabled: { appSlug: string };
};

export type AnalyticsEvent = keyof AnalyticsEvents;

/** The catalogue as data, for verification and for building insights. */
export const ANALYTICS_EVENTS = [
  "pageview",
  "check_submitted",
  "check_rejected",
  "quota_site_hit",
  "one_check_clicked",
  "checkout_opened",
  "verdict_viewed",
  "example_verdict_clicked",
  "today_checks_viewed",
  "sign_in_clicked",
  "watch_enabled",
] as const satisfies readonly AnalyticsEvent[];

/** Names PostHog treats specially. Everything else is sent verbatim. */
export const POSTHOG_EVENT_NAME: Partial<Record<AnalyticsEvent, string>> = {
  pageview: "$pageview",
};

export function posthogEventName(event: AnalyticsEvent): string {
  return POSTHOG_EVENT_NAME[event] ?? event;
}

type TrackArgs<E extends AnalyticsEvent> = AnalyticsEvents[E] extends undefined
  ? []
  : [props: AnalyticsEvents[E]];

/**
 * Capture a product event. Typed so an unknown event or a wrong property shape
 * is a compile error, not a stray row in PostHog. Safe to call before the
 * provider has initialised PostHog and safe on the server: both are no-ops.
 */
export function track<E extends AnalyticsEvent>(event: E, ...args: TrackArgs<E>): void {
  if (typeof window === "undefined" || !posthog.__loaded) return;
  const props = args[0] as Record<string, unknown> | undefined;
  posthog.capture(posthogEventName(event), props ?? undefined);
}

// ─── Guard: nothing the customer typed for us leaves the browser ────────────

/** Input types the SDK itself treats as sensitive (it never captures their events). */
export const SENSITIVE_INPUT_TYPES = ["password", "email", "text", "search", "url", "tel", "number"];

/**
 * Property keys that may never carry a value on an event, whatever the caller
 * meant. A boolean under such a key (`hasCredentials`) is a fact about the
 * form, not a secret, and is kept.
 */
export const SECRET_PROPERTY_KEY = /password|passwd|secret|credential|token|api[_-]?key|authorization/i;

type ElementSnapshot = Record<string, unknown> & { tag_name?: string; $el_text?: string };

function touchesSensitiveInput(elements: unknown): boolean {
  if (!Array.isArray(elements)) return false;
  return elements.some((el: ElementSnapshot) => {
    if (!el || typeof el !== "object") return false;
    const cls = String(el.attr__class ?? "");
    if (cls.split(/\s+/).includes("ph-no-capture")) return true;
    if (el.tag_name === "input" || el.tag_name === "textarea") {
      const type = String(el.attr__type ?? "text").toLowerCase();
      if (SENSITIVE_INPUT_TYPES.includes(type)) return true;
      if ("attr__value" in el) return true;
    }
    return false;
  });
}

/**
 * `before_send` hook. Returns the event to send, or null to drop it.
 * Pure, so scripts/verify-analytics.ts can exercise it without a browser.
 */
export function guardEvent(cr: CaptureResult | null): CaptureResult | null {
  if (!cr) return cr;
  if (cr.event === "$autocapture" || cr.event === "$rageclick" || cr.event === "$dead_click") {
    if (touchesSensitiveInput(cr.properties?.$elements)) return null;
  }
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cr.properties ?? {})) {
    if (isSecretProperty(key, value)) continue;
    properties[key] = value;
  }
  return { ...cr, properties };
}

/**
 * The SDK's own properties are `$`-prefixed and stay. `token` is the one
 * SDK-owned key without the prefix: it carries the public project token on
 * every event and ingestion refuses an event without it — so `token` stays
 * exactly when it holds that token, and goes when it holds anything else.
 */
export function isSecretProperty(key: string, value: unknown): boolean {
  if (key.startsWith("$")) return false;
  if (key === "token") return value !== POSTHOG_TOKEN;
  return SECRET_PROPERTY_KEY.test(key) && typeof value !== "boolean";
}

// ─── A/B bucket for the landing page ────────────────────────────────────────
//
// No PostHog experiment (see top of file), so the bucket is computed here from
// the browser's PostHog device id, which persists in localStorage+cookie for
// a year and survives `identify()` and `reset()`. FNV-1a over the id, folded
// to one bit: even → A, odd → B. Registered as the super property
// `landing_variant` so every event — pageview, check_submitted, checkout — can
// be broken down by variant in an insight.
//
// Limits, stated plainly:
// - Per browser, not per person: the same person on two devices may see both.
// - Server-rendered HTML does not know the variant. A component that renders
//   a variant must render A on the server and may switch to B after mount;
//   `useLandingVariant()` returns "A" until PostHog is ready. That is a flash
//   for half of B's visitors, accepted for launch.
// - Do Not Track / Global Privacy Control: PostHog never initialises for such
//   visitors, so they always see A and are never counted. Neither bias is
//   measured; both are small and known.

export type LandingVariant = "A" | "B";

/** 32-bit FNV-1a. Exported for the verification script's known-answer test. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic bucket for a device id. */
export function variantForId(id: string): LandingVariant {
  const h = fnv1a32(id);
  // Fold the word onto itself so the decision bit depends on every input byte,
  // not only on their parity (the multiply by an odd prime keeps bit 0 weak).
  const folded = h ^ (h >>> 16) ^ (h >>> 8);
  return (folded & 1) === 0 ? "A" : "B";
}

// Ready state as a tiny external store so React can subscribe without a
// context provider (and so `getLandingVariant()` works outside React).
let ready = false;
const readyListeners = new Set<() => void>();

function subscribeReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

function deviceId(): string | null {
  const id = posthog.get_property("$device_id") ?? posthog.get_distinct_id();
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** "A" until PostHog is ready on the client, then the device's bucket. */
export function getLandingVariant(): LandingVariant {
  if (typeof window === "undefined" || !ready) return "A";
  const id = deviceId();
  return id ? variantForId(id) : "A";
}

const serverVariant = (): LandingVariant => "A";

/** React hook form of `getLandingVariant()`; re-renders once PostHog is ready. */
export function useLandingVariant(): LandingVariant {
  return useSyncExternalStore(subscribeReady, getLandingVariant, serverVariant);
}

// ─── Initialisation ─────────────────────────────────────────────────────────

/**
 * Initialise PostHog once. Idempotent; a no-op on the server. Called by
 * AnalyticsProvider and by anything that may run before it (child effects run
 * before parent effects in React).
 */
export function initAnalytics(): void {
  if (typeof window === "undefined" || posthog.__loaded) return;
  posthog.init(POSTHOG_TOKEN, {
    api_host: POSTHOG_HOST,
    // Dated defaults (SDK 1.427): scripts injected into <head>, localhost
    // visitors flagged as internal/test users, storage writes debounced,
    // URL hashes not captured, cookie wins on conflict. Everything we care
    // about is set explicitly below regardless.
    defaults: "2026-08-30",
    // Pageviews are captured by AnalyticsPageView on every App Router
    // navigation; the SDK's own history hook would double-count.
    capture_pageview: false,
    capture_pageleave: true,
    persistence: "localStorage+cookie",
    autocapture: true,
    // Session replay would record the customer's app URL and test credentials
    // as they are typed. Off until there is a reason and a masking review.
    disable_session_recording: true,
    respect_dnt: true,
    // Masks e-mail addresses and the like inside captured URLs.
    mask_personal_data_properties: true,
    before_send: guardEvent,
    loaded: (client) => {
      const id = deviceId();
      if (id) client.register({ landing_variant: variantForId(id) });
      ready = true;
      for (const listener of readyListeners) listener();
    },
  });
}

/** Tie the browser's events to a signed-in user. Idempotent for the same id. */
export function identifyUser(userId: string, email: string | null | undefined): void {
  if (typeof window === "undefined" || !posthog.__loaded) return;
  if (posthog.get_distinct_id() === userId) return;
  posthog.identify(userId, email ? { email } : undefined);
}

/** Forget the signed-in user on sign-out. Keeps the device id, so the A/B bucket holds. */
export function resetUser(): void {
  if (typeof window === "undefined" || !posthog.__loaded) return;
  if (!posthog._isIdentified()) return;
  posthog.reset();
}

export { posthog };
