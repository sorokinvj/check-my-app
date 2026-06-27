// Clerk auth middleware. Uses the classic `middleware.ts` (Edge runtime) rather
// than Next 16's `proxy.ts`, because proxy.ts is Node-runtime-only and the
// OpenNext Cloudflare adapter rejects Node middleware. clerkMiddleware +
// @clerk/backend run on Edge/V8.
//
// Only owner-facing areas require a session. The entire anonymous free-run
// funnel — `/`, `/check`, `/run/*`, `/verdict/*`, sign-in/up — stays public.
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
