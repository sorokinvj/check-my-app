// Our Client ID Metadata Document (CHE-236).
//
// This endpoint IS our OAuth identity. PostHog does not have us registered: our
// `client_id` is this URL, and PostHog fetches the document mid-flow to learn
// our name, our logo and — the part that matters — which redirect URIs may
// receive an authorization code issued in our name. Listing a URI here grants
// it that right; PostHog refuses anything else.
//
// The document itself is built by `clientMetadata` in src/lib/posthog/oauth.ts,
// which is pure and verified: the origin comes from configuration and never
// from the request, because a Host header is attacker-controlled and would
// otherwise let a caller nominate their own callback.
//
// Served from src/app rather than public/ because it has to be computed from
// the deployment's own origin, and a static file cannot be.

import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { clientMetadata } from "@/lib/posthog/oauth";

export const dynamic = "force-dynamic";

export function GET() {
  const { env } = getCloudflareContext();
  const origin = (env as Record<string, string | undefined>).APP_URL ?? "https://checkmyapp.dev";

  try {
    return NextResponse.json(clientMetadata(origin), {
      headers: {
        "content-type": "application/json",
        // PostHog refetches this during flows; a stale copy at their edge would
        // outlive a redirect URI we removed, so keep the window short.
        "cache-control": "public, max-age=300",
      },
    });
  } catch (err) {
    // An http or empty APP_URL. Serving a document we cannot vouch for would
    // publish a redirect list that could be rewritten in transit.
    console.warn(`[posthog-oauth] refusing to serve client metadata: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "client metadata unavailable" }, { status: 503 });
  }
}
