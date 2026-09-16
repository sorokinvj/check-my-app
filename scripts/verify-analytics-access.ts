// CHE-243 verification: read-only, revocable, and honest about what we read.
//
// We are asking a founder to hand us a window into their users' behaviour, and
// then telling them on a page what that costs. **A page that promises what the
// code does not do is worse than no page** — it converts an honest gap into a
// broken promise, and the person who finds out is the customer.
//
// So every claim on /analytics-access is tied to the code that keeps it:
//
//   "read-only"          → the scope list, and the ceiling PostHog enforces
//   "counts, never people" → the query asks for pathname counts and nothing else
//   "disconnect deletes"  → the action deletes the row, not a flag
//   "never in a log"      → no token value reaches console/evidence/transcript
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-analytics-access.ts

import { readFileSync } from "node:fs";
import { POSTHOG_SCOPES, clientMetadata } from "@/lib/posthog/oauth";
import { funnelQuery } from "@/lib/posthog/measure";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const read = (p: string) => readFileSync(p, "utf8");
const PAGE = "src/app/analytics-access/page.tsx";

function main() {
  console.log("The page exists, and is linked from the thing it explains");
  {
    const page = read(PAGE);
    check("the page exists and says what it is", /what we read from your analytics/i.test(page));
    const card = read("src/components/analytics-connection.tsx");
    check("the connect card links to it", card.includes("/analytics-access"), "no link from the card");
    check("…and lists the scopes next to the button that agrees to them",
      card.includes("POSTHOG_SCOPES"), "scopes not shown on the connect card");
  }

  console.log("\n“Read-only” — and not because we say so");
  {
    check("every scope requested ends in :read",
      POSTHOG_SCOPES.every((s) => s.endsWith(":read")), POSTHOG_SCOPES.join(" "));
    check("…and there are only four of them", POSTHOG_SCOPES.length === 4, String(POSTHOG_SCOPES.length));

    // The part that is not a promise: PostHog caps what any token issued to us
    // can carry, from a document we publish.
    const doc = clientMetadata("https://checkmyapp.dev") as Record<string, unknown>;
    const ceiling = (doc["com.posthog"] ?? {}) as { scopes?: string[] };
    check("the published ceiling matches exactly what we ask for",
      JSON.stringify(ceiling.scopes) === JSON.stringify([...POSTHOG_SCOPES]), JSON.stringify(ceiling.scopes));
    check("…and contains no :write", !(ceiling.scopes ?? []).some((s) => s.endsWith(":write")));

    // The page must list the real scopes, not a hand-typed copy that drifts.
    const page = read(PAGE);
    check("the page renders the scope list from the code, not from memory",
      page.includes("POSTHOG_SCOPES"), "page hardcodes its scope list");
  }

  console.log("\n“Counts, never people”");
  {
    const q = JSON.stringify(funnelQuery(["/check", "/verdict/:id"]));
    check("the query filters on the page path and nothing else",
      q.includes("$pathname") && !/\$email|distinct_id|person|\$ip|\$user/i.test(q), q.slice(0, 160));
    check("…and asks for pageviews, not recordings",
      q.includes("$pageview") && !/recording|replay/i.test(q));

    // Nothing in the measurement path may read a person-shaped field.
    for (const f of ["src/lib/posthog/measure.ts", "src/agent/journey-measurement.ts"]) {
      const code = read(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      check(`${f} never reads a person, an email or a distinct id`,
        !/distinct_id|\$email|person_id|personProperties|session_recording/i.test(code), f);
    }
  }

  console.log("\n“Disconnect means gone”");
  {
    const actions = read("src/app/dashboard/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function disconnectPostHog"));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    check("disconnect DELETES the row", /postHogIntegration\.deleteMany/.test(body), "no delete found");
    check("…and does not merely flag it",
      !/active:\s*false|revokedAt|disabled:\s*true/.test(body), "a flag is being set instead");
    check("…and tells PostHog to revoke, so we vanish from their own app list",
      /revokeToken/.test(body), "no revocation call");
  }

  console.log("\n“Encrypted, and never written down”");
  {
    // A token must be encrypted before it is stored, everywhere it is stored.
    const callback = read("src/app/api/integrations/posthog/callback/route.ts");
    check("the callback encrypts both tokens before storing",
      (callback.match(/encryptSecret\(/g) ?? []).length >= 2, "tokens stored unencrypted");

    // And must never be logged. This is the check that would have caught the
    // mistake, not the comment asking people not to make it.
    for (const f of [
      "src/lib/posthog/oauth.ts",
      "src/lib/posthog/token.ts",
      "src/lib/posthog/measure.ts",
      "src/agent/journey-measurement.ts",
      "src/app/api/integrations/posthog/callback/route.ts",
      "src/app/api/integrations/posthog/start/route.ts",
      "src/app/dashboard/actions.ts",
    ]) {
      const code = read(f);
      const logs = [...code.matchAll(/console\.(log|warn|error)\(([^\n]*)/g)].map((m) => m[2]);
      const leaky = logs.filter((l) =>
        /\btoken\b(?!s\b)|accessToken|refreshToken|verifier|\bpha_|\bphr_/i.test(l) &&
        // naming the CONCEPT is fine; interpolating the VALUE is not
        /\$\{[^}]*(token|verifier)[^}]*\}/i.test(l));
      check(`${f}: no log line interpolates a token or a verifier`, leaky.length === 0, leaky.join(" | "));
    }

    // Nor may a token reach the customer-visible record of a check.
    for (const f of ["src/agent/journey-measurement.ts", "src/agent/metric-alerts.ts"]) {
      const code = read(f);
      check(`${f}: nothing from the analytics path is written to evidence`,
        !/putText\(|putScreenshot\(|evidence\.create/.test(code), f);
    }
  }

  console.log("\nThe page promises nothing the code does not do");
  {
    const page = read(PAGE);
    // Each of these sentences is a commitment checked above. If someone softens
    // the code, the claim must not stay on the page unchallenged.
    check("it claims we cannot write, and the ceiling backs that",
      /cannot create, change or delete/i.test(page));
    check("it claims deletion on disconnect, and the action does that",
      /deleted — not flagged/i.test(page));
    check("it claims encryption, and the callback does that",
      /encrypted before they are stored/i.test(page));
    check("it claims no identities, and the query asks for none",
      /no email addresses, no user ids/i.test(page));
    // The one thing the page must NOT do: promise the points are deleted, when
    // they are kept. It says they are kept, and says why.
    check("it is honest that measured counts are KEPT after disconnect",
      /already measured stay/i.test(page), "the page's disconnect claim does not match the code");
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
