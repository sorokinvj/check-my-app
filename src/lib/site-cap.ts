// The site-wide free-check cap as the running web worker has it. Read from the
// Cloudflare runtime env (bindings, vars and secrets — the same place the
// Stripe keys come from), so `wrangler secret put ANON_RUNS_PER_DAY_SITE` on
// checkmyapp-web changes it without a deploy. The parsing rule and the default
// live in src/lib/plans.ts; this file only knows where the web app's env is.
//
// Web-only: plans.ts is shared with the agent worker and must not import
// OpenNext, which is why the context read is here and not there.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { siteCapFromEnv } from "@/lib/plans";

export function effectiveSiteCap(): number {
  const { env } = getCloudflareContext();
  return siteCapFromEnv(env as Record<string, unknown>);
}
