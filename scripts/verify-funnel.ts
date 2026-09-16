// CHE-238 verification: the funnel we derive from a walk.
//
// Everything downstream of `deriveFunnel` is a claim about the customer's
// product — "of 100 who start this, 12 finish". A funnel derived badly does not
// look wrong on screen; it looks like the customer converting badly. That is
// rule 8's failure exactly, so most of these checks are about REFUSING.
//
// The three headline cases are real walks of joblander.app, read out of
// production D1 on 2026-09-16 (journey ids in each case). They are here rather
// than invented inputs because two of the three would have been got wrong by a
// derivation reasoned out at a desk.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-funnel.ts

import {
  MAX_FUNNEL_STAGES,
  deriveFunnel,
  funnelDrifted,
  pagesWalked,
  refusalReason,
} from "@/lib/funnel";
import { normalizePath, requestSignature } from "@/lib/dedup";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

/** The shape `Step.actions` actually stores — only `outcome.urlAfter` matters here. */
const walk = (...urls: string[]) => urls.map((u) => ({ outcome: { urlAfter: u } }));

// ── Real trails, exactly as production recorded them ────────────────────────

// Journey cmu052gch000fvl0na86nvs7a — "Try the AI interview coach demo"
const REAL_DEMO = walk(
  "https://joblander.app/", "https://joblander.app/", "https://joblander.app/", "https://joblander.app/",
  "https://joblander.app/practice", "https://joblander.app/practice", "https://joblander.app/practice",
  "https://joblander.app/login?back=%2Fpractice", "https://joblander.app/login?back=%2Fpractice",
  "https://joblander.app/login?back=%2Fpractice", "https://joblander.app/login?back=%2Fpractice",
);

// Journey cmu30dsuf00281q0nvcpiwfg3 — "Tutorial onboarding for new users"
const REAL_TUTORIALS = walk(
  "https://joblander.app/",
  ...Array(10).fill("https://joblander.app/login"),
  "https://joblander.app/dashboard",
  "https://joblander.app/first-time",
  "https://joblander.app/tutorials",
  "https://joblander.app/tutorials/101-getting-live-insights",
  "https://joblander.app/tutorials/mirror-mode",
  "https://joblander.app/tutorials/102-personalize-ai-responses",
  "https://joblander.app/tutorials/my-stories",
  "https://joblander.app/tutorials/103-safe-practice-mock-interviews",
  "https://joblander.app/tutorials/104-reviewing-performance",
);

// Journey cmtudg58a0023zu0ntthgsyin — "Explore the app in different languages"
const REAL_I18N = walk(
  "https://joblander.app/",
  "https://joblander.app/de", "https://joblander.app/de/about", "https://joblander.app/de/login",
  "https://joblander.app/es", "https://joblander.app/es/about", "https://joblander.app/es/tutorials",
  "https://joblander.app/es/terms",
  ...Array(8).fill("https://joblander.app/es/login"),
);

function main() {
  console.log("Real walk A — the AI interview coach demo (a funnel, and a good one)");
  {
    const f = deriveFunnel(REAL_DEMO);
    check("it is a funnel", f.ok, JSON.stringify(f.stages));
    check("three stages: landing, the thing, the login wall",
      f.stages.join(" → ") === "/ → /practice → /login", f.stages.join(" → "));
    check("the query string is gone — ?back=%2Fpractice is not a different page",
      !f.stages.some((s) => s.includes("?")), f.stages.join(","));
    check("the four repeats of / collapsed to one stage",
      f.stages.filter((s) => s === "/").length === 1);
  }

  console.log("\nReal walk B — tutorial onboarding (six siblings must not become six stages)");
  {
    const raw = pagesWalked(REAL_TUTORIALS);
    check("the raw walk really does contain six sibling tutorial pages",
      new Set(raw.filter((p) => p.startsWith("/tutorials/"))).size === 6,
      String(new Set(raw.filter((p) => p.startsWith("/tutorials/"))).size));

    const f = deriveFunnel(REAL_TUTORIALS);
    check("it is a funnel", f.ok, JSON.stringify(f.stages));
    check("the six tutorials collapse into the one stage that means 'reached the tutorials'",
      f.stages.join(" → ") === "/ → /login → /dashboard → /first-time → /tutorials",
      f.stages.join(" → "));
    check("…so no individual tutorial page survives as a stage",
      !f.stages.some((s) => s.startsWith("/tutorials/")), f.stages.join(","));
    check("ten consecutive /login records are one stage",
      f.stages.filter((s) => s === "/login").length === 1);
  }

  console.log("\nReal walk C — i18n exploration (a wander, not a funnel)");
  {
    const f = deriveFunnel(REAL_I18N);
    check("it is refused", !f.ok, f.ok ? "accepted" : f.refusal);
    check("…because the walk doubled back", !f.ok && f.refusal === "revisits");
    check("…and the refusal is about US, not the customer",
      /\bours\b|\bwe\b|the walk/.test(refusalReason("revisits")), refusalReason("revisits"));
    check("the stages we did see are still reported, so the gap ticket can say what we saw",
      f.stages.length > 0, JSON.stringify(f.stages));
    // The locale prefix is why it doubles back: /de/about and /es/about are one page.
    check("the locale prefix is what makes them the same page",
      normalizePath("https://joblander.app/de/about") === normalizePath("https://joblander.app/es/about"),
      normalizePath("https://joblander.app/de/about"));
  }

  console.log("\nRefusing is the point");
  {
    check("one page is arrival, not conversion",
      deriveFunnel(walk("https://x.dev/pricing")).ok === false);
    check("…and says which refusal it is",
      (deriveFunnel(walk("https://x.dev/pricing")) as { refusal: string }).refusal === "single_stage");
    check("the same page twice is still one page",
      (deriveFunnel(walk("https://x.dev/a", "https://x.dev/a")) as { refusal: string }).refusal === "single_stage");
    check("a walk with no pages refuses rather than returning an empty funnel",
      (deriveFunnel([]) as { refusal: string }).refusal === "no_pages");
    check("actions with no urlAfter are not pages",
      (deriveFunnel([{ outcome: null }, { outcome: { urlAfter: "" } }]) as { refusal: string }).refusal === "no_pages");

    const long = walk(...Array.from({ length: MAX_FUNNEL_STAGES + 1 }, (_, i) => `https://x.dev/p${i}`));
    check("an itinerary is not a funnel",
      (deriveFunnel(long) as { refusal: string }).refusal === "wandering",
      String(pagesWalked(long).length));
    const atCap = walk(...Array.from({ length: MAX_FUNNEL_STAGES }, (_, i) => `https://x.dev/p${i}`));
    check("…but exactly the cap is still a funnel", deriveFunnel(atCap).ok);

    // Every refusal must have a sentence, or a gap ticket would say nothing.
    for (const r of ["no_pages", "single_stage", "revisits", "wandering"] as const) {
      check(`"${r}" has a reason a human can read`, refusalReason(r).length > 20);
    }
  }

  console.log("\nA funnel that changes shape silently makes every comparison meaningless");
  {
    check("same shape is no drift", !funnelDrifted(["/", "/a"], ["/", "/a"]));
    check("an added stage is drift", funnelDrifted(["/", "/a"], ["/", "/a", "/b"]));
    check("a reordered funnel is drift", funnelDrifted(["/", "/a", "/b"], ["/", "/b", "/a"]));
    check("a renamed stage is drift", funnelDrifted(["/", "/a"], ["/", "/aa"]));
  }

  console.log("\nThe shared normaliser did not change under the tickets keyed on it");
  {
    // requestSignature now calls normalizePath. Every OPEN ticket's dedup key
    // was computed with the old inline version, so its output must be
    // unchanged — including the trailing slash it deliberately does not strip.
    check("a path with ids collapses as before",
      requestSignature(["GET https://joblander.app/api/users/12345/profile returned 500"]) ===
        "GET /api/users/:id/profile 500",
      String(requestSignature(["GET https://joblander.app/api/users/12345/profile returned 500"])));
    check("a locale prefix drops as before",
      requestSignature(["GET /de/api/thing 404"]) === "GET /api/thing 404",
      String(requestSignature(["GET /de/api/thing 404"])));
    check("a trailing slash is still NOT stripped, so open tickets do not refile",
      requestSignature(["POST /api/checks/ 502"]) === "POST /api/checks/ 502",
      String(requestSignature(["POST /api/checks/ 502"])));
    // …while the funnel does strip it, which is why it lives on the funnel side.
    check("the funnel treats /pricing and /pricing/ as one page",
      (deriveFunnel(walk("https://x.dev/", "https://x.dev/pricing", "https://x.dev/pricing/")) as { stages: string[] })
        .stages.join(" → ") === "/ → /pricing",
      JSON.stringify(deriveFunnel(walk("https://x.dev/", "https://x.dev/pricing", "https://x.dev/pricing/")).stages));
  }

  console.log("\nThe derivation is a function of the walk and nothing else");
  {
    const once = deriveFunnel(REAL_TUTORIALS);
    const twice = deriveFunnel(REAL_TUTORIALS);
    check("the same walk gives the same funnel — the ticket's 'identical on two consecutive runs'",
      JSON.stringify(once) === JSON.stringify(twice));
    check("ids in a path collapse, so /orders/991 and /orders/992 are one stage",
      (deriveFunnel(walk("https://x.dev/", "https://x.dev/orders/991", "https://x.dev/orders/992")) as { stages: string[] })
        .stages.join(" → ") === "/ → /orders/:id",
      JSON.stringify(deriveFunnel(walk("https://x.dev/", "https://x.dev/orders/991", "https://x.dev/orders/992")).stages));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
