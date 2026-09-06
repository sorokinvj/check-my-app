// CHE-191 verification: the soft imperative is homework, and it is cut from
// everything the customer reads.
//
// Run #147 (theins.ru, 2026-09-05) published, in a finding's whyItMatters:
// "Worth confirming both share flows open a working dialog and, if they're
// regionally unreliable, considering their placement." CLAUDE.md rule 1 calls
// homework for the customer the worst version of the leak and a hard failure;
// the CHE-82 gate keyed on "verify in a real browser" / "spot-check yourself"
// / "confirm manually" and let this through because none of those words is
// in it.
//
// Pure: no browser, no network, no model, no database. The finding cases run
// the exact function synthesis runs (cleanFindingLanguage); the bottom line,
// step and summary cases run the same helpers their producers call.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-homework-gate.ts

import { BOTTOM_LINE_FALLBACK, cleanFindingLanguage, type SynthesizedFinding } from "@/agent/synthesis";
import {
  hasEnvironmentLeak,
  hasHomework,
  HOMEWORK_FALLBACK,
  isHomework,
  productProse,
  stripHomework,
} from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ─── The family ───────────────────────────────────────────────────────────────
// Each is a full sentence the model has written, or could, after a sentence
// about the product. Detection is sentence-level: the product sentence stays.
const PRODUCT = "The share bar lists five networks under every article.";
const HOMEWORK = [
  "Worth confirming both share flows open a working dialog and, if they're regionally unreliable, considering their placement.",
  "Worth checking the VK button on mobile.",
  "It's worth a quick check of the share dialog.",
  "It would be worth verifying the redirect lands on the article.",
  "It would be wise to check the redirect.",
  "Consider verifying the flow on a phone.",
  "Consider testing the checkout with a real card.",
  "You may want to check that the dialog opens.",
  "You might want to verify the email arrives.",
  "You'll want to confirm the email arrives.",
  "You should verify the redirect target.",
  "You'd want to double-check the coupon field.",
  "Double-check that the coupon field accepts codes.",
  "Make sure the share dialog opens for readers.",
  "Make sure that the checkout flow works end to end.",
  "Ensure the checkout flow works end to end.",
  "We recommend verifying the flow with a real account.",
  "We'd recommend that you confirm the webhook fires.",
  "Recommended: check the mobile layout before launch.",
  "Please confirm the share dialog opens.",
  "Please verify this on your side.",
  "Please try it in another browser.",
  "Try it in another browser to be safe.",
  "Try this on your end with a fresh session.",
  "Test this yourself before launch.",
  "Test it manually on a real device.",
  "Check it manually on your end.",
  "Verify on your side that the link resolves.",
  "Confirm the dialog opens in your own browser.",
  "Be sure to check the mobile layout.",
  "Remember to verify the redirect after deploying.",
  "Don't forget to test the share dialog on mobile.",
  "Spot-check the VK share yourself.",
  // PR #57 review: the audience word in the clause BEFORE the comma does not
  // exempt the ask, and an access request in a LATER clause does not exempt
  // an unrelated ask in front of it.
  "Readers can share, worth confirming the dialog opens.",
  "You should verify the redirect target, and please share a working test account.",
];

// ─── What must pass ───────────────────────────────────────────────────────────
// What WE did (past tense), the product's own copy, the product's own users.
const NOT_HOMEWORK = [
  // past tense: a statement of what our check did
  "We confirmed the link resolves.",
  "We checked both share flows and the dialog opened.",
  "We verified all five share URLs from the article share bar.",
  "We double-checked the redirect and it lands on the article.",
  "We tested the checkout with a card and the receipt page loaded.",
  "Verified all 5 social share URLs from the article share bar",
  "Fetched Facebook, Twitter/X, Telegram, VK and OK share endpoints",
  "VK (vk.com/share.php) and OK (connect.ok.ru/offer) both timed out and could not be confirmed.",
  "The verification email never arrived within five minutes.",
  // product copy with "worth"
  "The plan is priced at $29, worth every penny according to the copy.",
  "The hero reads 'Worth $29 a month' next to the sign-up button.",
  // the product's users, reported
  "Users must confirm their email before posting.",
  "Customers should double-check their order before paying.",
  "The user is asked to verify their phone number on the second step.",
  "Visitors can share an article without confirming anything.",
  "The page prompts visitors to verify they are human.",
  "On mobile, customers should double-check their order before paying.",
  // the reporting verb introduces the quote across the comma
  "The page says, please confirm your email address.",
  // the product's own words, quoted or reported
  "The form showed 'Something went wrong. Please try again.'",
  "The banner reads \"Please confirm your email address\".",
  "The page says you need to confirm your email.",
  "The label 'Verify your account' is shown twice.",
  "The button is labelled “Make sure it works” and does nothing.",
  // access requests (CLAUDE.md rule 2: the one ask we may make) — run #62 as published
  "Note this may be an invalid test account rather than a defect in the endpoint; please confirm the credentials are active, or supply working ones so we can verify the flow end to end.",
  "Please confirm the test account password is current, or share a working one.",
  // near misses
  "Considering their placement, the share bar is easy to miss.",
  "Sign-in works; the dashboard opens.",
  "The checkout page lists the plan and the price before payment.",
  "The share endpoint timed out.",
  "A spot check of the sitemap found 12 dead links.",
];

// ─── Run #147, as published ───────────────────────────────────────────────────
const RUN_147: SynthesizedFinding = {
  title: "VK and Odnoklassniki share links did not resolve",
  category: "broken",
  severity: "medium",
  detail: {
    where: "Article page social share sidebar (/confession/296457)",
    whatWeTried: [
      "Verified all 5 social share URLs from the article share bar",
      "Fetched Facebook, Twitter/X, Telegram, VK and OK share endpoints",
    ],
    whatHappened:
      "Facebook, Twitter/X and Telegram share URLs resolved (HTTP 200). VK (vk.com/share.php) and OK (connect.ok.ru/offer) both timed out and could not be confirmed.",
    whyItMatters:
      "VK and OK are among the most-used networks for a Russian-speaking audience, so if these buttons fail to open for readers you lose meaningful organic distribution. " +
      "Worth confirming both share flows open a working dialog and, if they're regionally unreliable, considering their placement.",
  },
};

function main() {
  // 1 — every phrasing is detected, and stripped at the sentence.
  for (const s of HOMEWORK) {
    check(`homework: "${s}"`, isHomework(s));
    const out = stripHomework(`${PRODUCT} ${s}`);
    check(`  … cut at the sentence, the product sentence stays`, out === PRODUCT, out);
    check(`  … hasEnvironmentLeak sees it (the CHE-82 callers drop on this)`, hasEnvironmentLeak(s));
  }

  // 2 — what must pass, passes untouched.
  for (const s of NOT_HOMEWORK) {
    check(`not homework: "${s}"`, !isHomework(s));
    check(`  … stripHomework returns it unchanged`, stripHomework(s) === s);
  }

  // 3 — run #147: the finding is kept, the ask is gone, the evidence intact.
  {
    const f = cleanFindingLanguage(RUN_147);
    check("#147: the finding is kept (whatHappened still has content)", f !== null);
    check(
      "#147: whyItMatters loses the 'Worth confirming …' sentence and keeps the consequence",
      f?.detail.whyItMatters ===
        "VK and OK are among the most-used networks for a Russian-speaking audience, so if these buttons fail to open for readers you lose meaningful organic distribution.",
      f?.detail.whyItMatters,
    );
    check("#147: whatHappened untouched", f?.detail.whatHappened === RUN_147.detail.whatHappened, f?.detail.whatHappened);
    check(
      "#147: whatWeTried untouched ('Verified all 5 …' is what we did)",
      JSON.stringify(f?.detail.whatWeTried) === JSON.stringify(RUN_147.detail.whatWeTried),
      JSON.stringify(f?.detail.whatWeTried),
    );
    check("#147: title and where untouched", f?.title === RUN_147.title && f?.detail.where === RUN_147.detail.where);
    check("#147: nothing the customer reads is homework", !hasHomework(f?.detail.whyItMatters) && !hasHomework(f?.detail.whatHappened));
  }

  // 4 — whyItMatters that was only homework → the coverage sentence, finding kept.
  {
    const f = cleanFindingLanguage({
      ...RUN_147,
      detail: { ...RUN_147.detail, whyItMatters: "Worth confirming both share flows open a working dialog." },
    });
    check("whyItMatters all homework: finding kept", f !== null);
    check("whyItMatters all homework: replaced with the coverage sentence", f?.detail.whyItMatters === HOMEWORK_FALLBACK, f?.detail.whyItMatters);
  }

  // 5 — the title is the claim: homework there means no finding.
  {
    const f = cleanFindingLanguage({ ...RUN_147, title: "Worth checking the VK share dialog on mobile" });
    check("title is homework: finding dropped", f === null);
  }

  // 6 — whatHappened that was only homework: nothing was observed → dropped.
  {
    const f = cleanFindingLanguage({
      ...RUN_147,
      detail: { ...RUN_147.detail, whatHappened: "You may want to check whether the VK dialog opens." },
    });
    check("whatHappened all homework: finding dropped", f === null);
  }

  // 7 — whatWeTried: an entry that is an ask goes, the others stay.
  {
    const f = cleanFindingLanguage({
      ...RUN_147,
      detail: {
        ...RUN_147.detail,
        whatWeTried: ["Fetched the VK share endpoint", "Please verify the dialog on your side"],
      },
    });
    check(
      "whatWeTried: the homework entry is removed, the other kept",
      JSON.stringify(f?.detail.whatWeTried) === JSON.stringify(["Fetched the VK share endpoint"]),
      JSON.stringify(f?.detail.whatWeTried),
    );
  }

  // 8 — a clean finding comes back as it went in.
  {
    const clean: SynthesizedFinding = {
      ...RUN_147,
      detail: { ...RUN_147.detail, whyItMatters: "Readers on VK and OK cannot share; that audience is lost to organic distribution." },
    };
    const f = cleanFindingLanguage(clean);
    check("a clean finding is unchanged", JSON.stringify(f) === JSON.stringify(clean));
  }

  // 8b — the ask as a trailing clause (runs #12, #15, #16 as published): the
  // clause goes, the consequence before it stays, closed with a full stop.
  {
    const run12 =
      "Expected behavior for an auth-gated endpoint, but firing it on public marketing pages means guest funnel events may be dropped and repeated 401s add noise to monitoring — worth confirming you're not losing top-of-funnel analytics.";
    check(
      "#12: dash clause cut, consequence kept",
      stripHomework(run12) ===
        "Expected behavior for an auth-gated endpoint, but firing it on public marketing pages means guest funnel events may be dropped and repeated 401s add noise to monitoring.",
      stripHomework(run12),
    );
    const run15 =
      "If the sticky header can cover interactive elements after scroll, real users on some viewport sizes may find buttons unresponsive; worth confirming the header z-index/offset doesn't shadow the CTA.";
    check(
      "#15: semicolon clause cut, consequence kept",
      stripHomework(run15) ===
        "If the sticky header can cover interactive elements after scroll, real users on some viewport sizes may find buttons unresponsive.",
      stripHomework(run15),
    );
    const run16 =
      "Fine for a private beta, but it will need real per-user auth before broader rollout — worth confirming this is intentional for the current stage.";
    check(
      "#16: dash clause cut",
      stripHomework(run16) === "Fine for a private beta, but it will need real per-user auth before broader rollout.",
      stripHomework(run16),
    );
    check(
      "comma + connector clause cut ('…, so you may want to check …')",
      stripHomework("The redirect chain has four hops, so you may want to check it after every DNS change.") === "The redirect chain has four hops.",
    );
    check(
      "homework that opens the sentence: the whole sentence goes",
      stripHomework(`${PRODUCT} Worth checking the VK button on mobile, since readers there are the majority.`) === PRODUCT,
    );
    check(
      "a prefix too short to stand alone is not kept as a fragment",
      stripHomework("Note — worth confirming the dialog opens.") === HOMEWORK_FALLBACK,
      stripHomework("Note — worth confirming the dialog opens."),
    );
    check(
      "productProse cuts the clause the same way",
      productProse("The header covers the CTA after scroll; worth confirming the offset on mobile.") === "The header covers the CTA after scroll.",
    );
  }

  // 9 — the bottom line: a trailing "Worth checking …" is cut; a line that
  // was only that becomes the fixed bottom-line sentence, never the empty string.
  {
    const bl = "Sign-in and search work; the VK share button times out. Worth checking the share dialog from a Russian IP.";
    check(
      "bottom line: trailing 'Worth checking …' removed",
      stripHomework(bl, BOTTOM_LINE_FALLBACK) === "Sign-in and search work; the VK share button times out.",
      stripHomework(bl, BOTTOM_LINE_FALLBACK),
    );
    check(
      "bottom line that was only homework: the bottom-line fallback",
      stripHomework("Worth checking the share dialog from a Russian IP.", BOTTOM_LINE_FALLBACK) === BOTTOM_LINE_FALLBACK,
    );
    check("bottom line without homework: unchanged", stripHomework("Everything we walked worked.", BOTTOM_LINE_FALLBACK) === "Everything we walked worked.");
  }

  // 10 — steps, journey summaries and the judge's sentence go through
  // productProse (CHE-180); the homework sentence is cut there too.
  {
    check(
      "productProse (step observed): homework sentence cut",
      productProse("The share dialog opened with the article title. You may want to verify it on mobile.") ===
        "The share dialog opened with the article title.",
    );
    check(
      "productProse (journey summary): homework sentence cut",
      productProse("Reading, searching and sharing to Telegram all work. Worth confirming the VK share on a phone.") ===
        "Reading, searching and sharing to Telegram all work.",
    );
    check("productProse: text that was only homework → null (the caller's fallback stands in)", productProse("Worth confirming the VK share on a phone.") === null);
    check(
      "productProse: reported speech about users survives",
      productProse("Users must confirm their email before posting; the confirmation arrived in four seconds.") ===
        "Users must confirm their email before posting; the confirmation arrived in four seconds.",
    );
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main();
