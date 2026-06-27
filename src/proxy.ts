// Clerk auth middleware (Next 16 uses `proxy.ts`, the renamed `middleware.ts`).
//
// Only owner-facing areas require a session. The entire anonymous free-run
// funnel — `/`, `/check`, `/run/*`, `/verdict/*`, `/watch/*` and their APIs,
// plus Clerk's own sign-in/up — stays public, per the M3 PRD ("no signup to
// start"). The multi-tenant layer is strictly additive.
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/onboarding(.*)", "/watch(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
});

export const config = {
  matcher: [
    // Skip Next internals and static files unless referenced in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes (so auth() is available where needed).
    "/(api|trpc)(.*)",
  ],
};
