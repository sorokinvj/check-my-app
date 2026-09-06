// CHE-190 verification: a link we cannot reach from here is unverified, never
// broken or risky.
//
// Run #147 (theins.ru, anonymous, 2026-09-05 15:33 UTC) reported the finding
// "VK and Odnoklassniki share links did not resolve" — risky, low — because
// verify_links fetched vk.com/share.php and connect.ok.ru/offer from the
// worker, both stalled past the 10 s limit, and the tool called that "BROKEN
// fetch-error". The journey went risky, the verdict needs_attention; run #148
// of the same site twenty minutes later found nothing of the kind and went
// mostly_ok. From a residential connection both URLs answer 302 into the share
// widgets. CLAUDE.md rule 3: silence is not evidence; rule 8: our incapacity
// is never their defect.
//
// Three things are proven here, through the real executeTool with a stub
// fetch and a stub page — no browser, no network, no model, no database:
//   1. verify_links classifies every result three ways — OK, BROKEN (a real
//      HTTP error from the link's own host), UNREACHABLE (a timeout, a
//      connection error, or a 403/429/503 from a host other than the target)
//      — and its summary tells the model what UNREACHABLE means;
//   2. report_step cannot write a risky/confusing/broken step off an
//      unreachable host — it is written skipped / our_capability with the
//      coverage sentence in product language — while a step that also cites a
//      real error from the product itself stays exactly what the model said;
//   3. the findings gate (CHE-188) then drops a finding that rests on the
//      coerced step, so nothing of it reaches the verdict page.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-egress-links.ts

import { gateFindings, type GateJourney } from "@/agent/findings-gate";
import type { SynthesizedFinding } from "@/agent/synthesis";
import {
  coerceUnreachable,
  executeTool,
  isTargetHost,
  UNREACHABLE_INSTRUCTION,
  type ReportedStep,
  type ToolEnv,
} from "@/agent/tools";
import { hasEnvironmentLeak } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://theins.ru";

// ─── Stub fetch ──────────────────────────────────────────────────────────────
//
// One answer per URL: a status (with the URL that answered, after redirects
// when the case says so), or a thrown error of the kind workerd's fetch throws.

type Answer = { status: number; answeredBy?: string } | { throws: Error };

function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

function stubFetch(answers: Record<string, Answer>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const answer = answers[url];
    if (!answer) throw new Error(`stub fetch: no answer for ${url}`);
    if ("throws" in answer) throw answer.throws;
    return { status: answer.status, url: answer.answeredBy ?? url } as Response;
  }) as typeof fetch;
}

// report_step never touches the page; verify_links never touches it either.
function stubEnv(): ToolEnv {
  return {
    page: { url: () => `${ORIGIN}/` },
    targetOrigin: ORIGIN,
    networkLog: [],
    consoleLog: [],
    writeAllowed: false,
    credentials: { rejected: false },
    actionTrail: [],
  } as unknown as ToolEnv;
}

function line(result: string, url: string): string {
  return result.split("\n").find((l) => l.endsWith(` ${url}`)) ?? "(no line)";
}

async function main() {
  // 0 — whose host is it.
  check("host: the target and its subdomains are the target's; www. is the same site",
    isTargetHost("theins.ru", ORIGIN) && isTargetHost("www.theins.ru", ORIGIN) && isTargetHost("api.theins.ru", ORIGIN));
  check("host: another site is not, and a suffix match is not a subdomain",
    !isTargetHost("vk.com", ORIGIN) && !isTargetHost("nottheins.ru", ORIGIN));

  // 1 — verify_links classification, one URL per class.
  const realFetch = globalThis.fetch;
  {
    const VK = "https://vk.com/share.php?url=https%3A%2F%2Ftheins.ru%2Fnews%2F1";
    const OK_RU = "https://connect.ok.ru/offer?url=https%3A%2F%2Ftheins.ru%2Fnews%2F1";
    const FINE = "https://t.me/share/url?url=https%3A%2F%2Ftheins.ru";
    const GONE_OWN = `${ORIGIN}/old-article`;
    const GONE_OTHER = "https://partner.example/dead-page";
    const GATED_403 = "https://cdn.example/asset";
    const GATED_429 = `${ORIGIN}/api/search`;
    const GATED_503 = "https://widget.example/embed";
    const DOWN_OWN = `${ORIGIN}/api/health`;
    const RESET = "https://mail.example/contact";
    const REDIRECT_GATED = `${ORIGIN}/go/vk`;
    const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const YT_OEMBED = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(YT)}`;
    globalThis.fetch = stubFetch({
      [VK]: { throws: timeoutError() },
      [OK_RU]: { throws: timeoutError() },
      [FINE]: { status: 200 },
      [GONE_OWN]: { status: 404 },
      [GONE_OTHER]: { status: 404 },
      [GATED_403]: { status: 403 },
      [GATED_429]: { status: 429 },
      [GATED_503]: { status: 503 },
      [DOWN_OWN]: { status: 503 },
      [RESET]: { throws: new Error("connect ECONNRESET 203.0.113.9:443") },
      [REDIRECT_GATED]: { status: 403, answeredBy: "https://vk.com/away.php" },
      [YT_OEMBED]: { status: 404 },
    });
    const urls = [VK, OK_RU, FINE, GONE_OWN, GONE_OTHER, GATED_403, GATED_429, GATED_503, DOWN_OWN, RESET, REDIRECT_GATED, YT, "mailto:tips@theins.ru"];
    const result = await executeTool(stubEnv(), "verify_links", { urls });
    globalThis.fetch = realFetch;

    check("200 → OK", line(result, FINE) === `OK 200 ${FINE}`, line(result, FINE));
    check("timeout → UNREACHABLE (timed out), not BROKEN",
      line(result, VK) === `UNREACHABLE (timed out) ${VK}` && line(result, OK_RU) === `UNREACHABLE (timed out) ${OK_RU}`,
      line(result, VK));
    check("connection reset → UNREACHABLE (connection failed)",
      line(result, RESET).startsWith(`UNREACHABLE (connection failed: connect ECONNRESET`), line(result, RESET));
    check("404 from the target origin → BROKEN", line(result, GONE_OWN) === `BROKEN 404 ${GONE_OWN}`, line(result, GONE_OWN));
    check("404 from another host → BROKEN as well (a page that really is gone)",
      line(result, GONE_OTHER) === `BROKEN 404 ${GONE_OTHER}`, line(result, GONE_OTHER));
    check("403 from another host → UNREACHABLE, naming the host",
      line(result, GATED_403) === `UNREACHABLE (HTTP 403 from cdn.example) ${GATED_403}`, line(result, GATED_403));
    check("503 from another host → UNREACHABLE",
      line(result, GATED_503) === `UNREACHABLE (HTTP 503 from widget.example) ${GATED_503}`, line(result, GATED_503));
    check("503 from the target origin → BROKEN (the product's own answer)",
      line(result, DOWN_OWN) === `BROKEN 503 ${DOWN_OWN}`, line(result, DOWN_OWN));
    check("429 from the target origin → UNREACHABLE (our own volume, CLAUDE.md rule 3)",
      line(result, GATED_429) === `UNREACHABLE (HTTP 429 from theins.ru) ${GATED_429}`, line(result, GATED_429));
    check("a target link that redirects to a gating host is judged by the host that answered",
      line(result, REDIRECT_GATED) === `UNREACHABLE (HTTP 403 from vk.com) ${REDIRECT_GATED}`, line(result, REDIRECT_GATED));
    check("YouTube still goes through oEmbed and a 404 there is BROKEN",
      line(result, YT) === `BROKEN 404 (via YouTube oEmbed) ${YT}`, line(result, YT));
    check("mailto still goes through the address check",
      line(result, "mailto:tips@theins.ru") === "OK mailto mailto:tips@theins.ru", line(result, "mailto:tips@theins.ru"));

    const [summary, note] = result.split("\n");
    check("summary counts broken and unreachable separately",
      summary === "Checked 13 links — 4 broken, 7 unreachable.", summary);
    check("the summary carries the instruction for unreachable links",
      note === `7 ${UNREACHABLE_INSTRUCTION}` && note.includes("never broken or risky"), note);
  }
  // No unreachable link → no instruction line, the counts still both appear.
  {
    const FINE = "https://t.me/share";
    globalThis.fetch = stubFetch({ [FINE]: { status: 200 } });
    const result = await executeTool(stubEnv(), "verify_links", { urls: [FINE] });
    globalThis.fetch = realFetch;
    const lines = result.split("\n");
    check("all reachable: summary says 0 unreachable and no instruction follows",
      lines[0] === "Checked 1 links — 0 broken, 0 unreachable." && lines[1] === `OK 200 ${FINE}`, result);
  }

  // 2 — report_step: the #147 shape.
  const RUN_147_OBSERVED =
    "VK (vk.com/share.php) and OK (connect.ok.ru/offer) both timed out and could not be confirmed; Telegram and X share links resolved.";
  const reportStep = async (input: ReportedStep): Promise<ReportedStep> => {
    const env = stubEnv();
    const reported: ReportedStep[] = [];
    env.onReportStep = async (s) => {
      reported.push(s);
    };
    await executeTool(env, "report_step", input);
    return reported[0];
  };
  const coerced = await reportStep({
    label: "Share links (VK, OK, Telegram, X)",
    status: "risky",
    attempted: "Verified the four share links under the article",
    observed: RUN_147_OBSERVED,
  });
  check("#147: a risky step off two hosts that timed out is written skipped / our_capability",
    coerced.status === "skipped" && coerced.unverifiedReason === "our_capability",
    `${coerced.status}/${coerced.unverifiedReason}`);
  check("#147: the coverage sentence names the hosts, in product language",
    coerced.observed.endsWith(" Could not confirm vk.com and connect.ok.ru this run.") && !hasEnvironmentLeak(coerced.observed),
    coerced.observed);
  check("#147: a file name in the URL is not mistaken for a host",
    !coerced.observed.includes("share.php this run"), coerced.observed);

  // The tool's own words copied into the step, without a host in the sentence.
  const quoted = await reportStep({
    label: "Share links",
    status: "confusing",
    attempted: "Verified the share links",
    observed: "verify_links: UNREACHABLE (timed out) for the VK share link.",
  });
  check("the tool's UNREACHABLE word alone is enough to coerce a confusing step",
    quoted.status === "skipped" && quoted.unverifiedReason === "our_capability", `${quoted.status}/${quoted.unverifiedReason}`);
  check("no host named → the coverage sentence says 'this link'",
    quoted.observed.endsWith(" Could not confirm this link this run."), quoted.observed);

  // A status from a foreign host in the same sentence is that host gating us.
  const gated = await reportStep({
    label: "Share links",
    status: "broken",
    attempted: "Verified the share links",
    observed: "The VK share link answered HTTP 403 from vk.com and could not be reached.",
  });
  check("broken off 'HTTP 403 from vk.com' is coerced — a foreign host's refusal is not evidence",
    gated.status === "skipped", gated.status);

  // Non-coercion: a real error from the product's own host in the same step.
  const withOwn500 = await reportStep({
    label: "Share links",
    status: "broken",
    attempted: "Verified the four share links",
    observed: "vk.com timed out; the share counter at https://theins.ru/api/share answered 500.",
  });
  check("a 500 from the target's own host in the same step keeps it broken", withOwn500.status === "broken", withOwn500.status);
  const withOwnPath = await reportStep({
    label: "Share links",
    status: "broken",
    attempted: "Verified the share links",
    observed: "vk.com timed out and /api/share returned 502.",
  });
  check("a 5xx on a bare path (the product's own request) keeps it broken", withOwnPath.status === "broken", withOwnPath.status);
  const withConsole = await reportStep({
    label: "Share links",
    status: "broken",
    attempted: "Clicked the VK share button",
    observed: "The VK request to vk.com timed out and the console shows an uncaught TypeError from share.js.",
  });
  check("a console exception in the same step keeps it broken", withConsole.status === "broken", withConsole.status);
  const ownTimeout = await reportStep({
    label: "Search",
    status: "broken",
    attempted: "Searched for 'elections'",
    observed: "The search request to https://theins.ru/api/search timed out after 30 s and no results appeared.",
  });
  check("a timeout naming only the target's own host is not an egress problem — untouched",
    ownTimeout.status === "broken", ownTimeout.status);
  const noHost = await reportStep({
    label: "Checkout",
    status: "broken",
    attempted: "Pressed Pay",
    observed: "The payment step timed out and the order was never confirmed.",
  });
  check("a timeout with no host named at all is about the product — untouched", noHost.status === "broken", noHost.status);
  const okStep: ReportedStep = {
    label: "Share links",
    status: "ok",
    attempted: "Verified",
    observed: "vk.com timed out earlier but the link opened on retry.",
  };
  coerceUnreachable(okStep, { targetOrigin: ORIGIN });
  check("only risky/confusing/broken are rewritten", okStep.status === "ok", okStep.status);
  const noPhrase = await reportStep({
    label: "Share links",
    status: "risky",
    attempted: "Verified the share links",
    observed: "The vk.com share link opens a page in Russian only, with no way back to the article.",
  });
  check("a foreign host without an egress phrase is the model's own observation — untouched",
    noPhrase.status === "risky", noPhrase.status);

  // 3 — the findings gate drops the finding that rested on the coerced step.
  {
    const journeys: GateJourney[] = [
      {
        steps: [
          { label: "Open an article", status: "ok", unverifiedReason: null, observed: "The article rendered." },
          {
            label: coerced.label,
            status: coerced.status,
            unverifiedReason: coerced.unverifiedReason ?? null,
            observed: coerced.observed,
          },
        ],
      },
    ];
    const finding: SynthesizedFinding = {
      title: "VK and Odnoklassniki share links did not resolve",
      category: "risky",
      severity: "low",
      detail: {
        where: "Article page — share bar",
        whatHappened: "VK (vk.com/share.php) and OK (connect.ok.ru/offer) both timed out and could not be confirmed.",
        whyItMatters: "Readers who share to VK or OK would meet a dead control.",
      },
      stepRef: { journeyIndex: 0, stepIndex: 1 },
    };
    const gatedRun = gateFindings([finding], journeys);
    check("findings gate: the #147 finding with a stepRef to the coerced step is dropped",
      gatedRun.kept.length === 0 && gatedRun.dropped.length === 1 && gatedRun.dropped[0].reason.includes("our_capability"),
      gatedRun.dropped[0]?.reason ?? "(kept)");
    const unreferenced: SynthesizedFinding = { ...finding, stepRef: undefined };
    const gatedByWords = gateFindings([unreferenced], journeys);
    check("findings gate: the same finding without a stepRef is tied to the skipped step by its words and dropped",
      gatedByWords.kept.length === 0, gatedByWords.dropped[0]?.reason ?? "(kept)");
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
