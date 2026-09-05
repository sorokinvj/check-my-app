"use client";

// Mounts PostHog for the whole app (see src/lib/analytics.ts for what is and
// is not captured). Three jobs:
//
// 1. Initialise the SDK once on the client.
// 2. Capture a `$pageview` on every App Router navigation. The SDK's own
//    history hook is off; this component is the one source of pageviews.
//    `useSearchParams` forces a Suspense boundary during static rendering,
//    hence the wrapper.
// 3. Mirror Clerk's session into PostHog: identify on sign-in, reset on
//    sign-out, so a person's anonymous landing-page events and their signed-in
//    checkout end up on one profile.
//
// Renders nothing. Must sit inside ClerkProvider (it uses useUser).

import { Suspense, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { identifyUser, initAnalytics, resetUser, track, whenVariantResolved } from "@/lib/analytics";

function AnalyticsPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;
    // Child effects run before the parent's; make sure the SDK is up.
    initAnalytics();
    const query = searchParams?.toString();
    const path = query ? `${pathname}?${query}` : pathname;
    // Not cancelled on cleanup: a navigation within the flags round trip
    // must not lose the pageview that preceded it.
    whenVariantResolved(() => track("pageview", { path }));
  }, [pathname, searchParams]);

  return null;
}

function AnalyticsIdentity() {
  const { isLoaded, isSignedIn, user } = useUser();
  const identified = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    initAnalytics();
    if (isSignedIn && user) {
      if (identified.current === user.id) return;
      identifyUser(user.id, user.primaryEmailAddress?.emailAddress ?? null);
      identified.current = user.id;
      return;
    }
    // Signed out. Only reset when a user was identified in this browser —
    // resetUser() checks the SDK's own record, so a fresh anonymous visitor
    // keeps their device id and with it their A/B bucket.
    resetUser();
    identified.current = null;
  }, [isLoaded, isSignedIn, user]);

  return null;
}

export function AnalyticsProvider() {
  useEffect(() => {
    initAnalytics();
  }, []);

  return (
    <>
      <Suspense fallback={null}>
        <AnalyticsPageView />
      </Suspense>
      <AnalyticsIdentity />
    </>
  );
}
