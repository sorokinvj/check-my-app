// The doer's rails, verified the way the credential gate is — by us, in CI,
// before anything of it runs unattended overnight.
//
// Each case below is a rail that something already paid for. The merge cases in
// particular: "still computing", "unreadable" and "went quiet" read as approval
// only once, and that is how a gate merges a change nobody reviewed.

import {
  decideTick,
  decideMerge,
  branchFor,
  isDoerBranch,
  isMergeCandidate,
  QUEUE_LABEL,
  HOLD_LABEL,
} from "./doer/eligibility.mjs";
import {
  decideShadow,
  shadowCommand,
  newShadowPrs,
  ledgerRowsSince,
  unpricedAttempt,
  isShadowBranch,
  noPrExplanation,
  findJourneymanHome,
  SHADOW_BRANCH_PREFIX,
} from "./doer/shadow.mjs";

let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
};

const issue = (number, labels, createdAt, title = "t") => ({ number, labels, createdAt, title });

// ── which ticket, and whether to act at all ──────────────────────────────────
{
  const d = decideTick({ issues: [], openDoerPrs: [], stopped: true });
  check("stop flag halts the tick", d.act === false && d.reason.includes("stopped"), d.reason);
}
{
  const d = decideTick({
    issues: [issue(1, [QUEUE_LABEL], "2026-09-01")],
    openDoerPrs: [{ number: 9, headRef: "doer/9-x" }],
    stopped: false,
  });
  check("one open PR blocks a second", d.act === false && d.reason.includes("#9"), d.reason);
}
{
  const d = decideTick({ issues: [issue(1, ["bug"], "2026-09-01")], openDoerPrs: [], stopped: false });
  check("unlabelled issues are not the queue", d.act === false, d.reason);
}
{
  const d = decideTick({
    issues: [issue(1, [QUEUE_LABEL, HOLD_LABEL], "2026-09-01")],
    openDoerPrs: [],
    stopped: false,
  });
  check("a held issue is skipped", d.act === false, d.reason);
}
{
  const d = decideTick({
    issues: [issue(5, [QUEUE_LABEL], "2026-09-02"), issue(3, [QUEUE_LABEL], "2026-08-20")],
    openDoerPrs: [],
    stopped: false,
  });
  check("oldest first, so nothing starves", d.act === true && d.issue.number === 3, `picked #${d.issue?.number}`);
}
{
  const d = decideTick({
    issues: [issue(3, [QUEUE_LABEL], "2026-08-20")],
    openDoerPrs: [],
    stopped: false,
  });
  check("merging is the default, not an opt-in", d.act === true && d.mayMerge === true, `mayMerge=${d.mayMerge}`);
}
{
  const d = decideTick({
    issues: [issue(3, [QUEUE_LABEL, HOLD_LABEL], "2026-08-20")],
    openDoerPrs: [],
    stopped: false,
  });
  check("a held ticket is not claimed at all", d.act === false, d.reason);
}

// ── the merge gate ───────────────────────────────────────────────────────────
const green = [{ name: "check", conclusion: "success", headSha: "aaa" }];
const approved = [{ state: "APPROVED", headSha: "aaa" }];
{
  const m = decideMerge({ mayMerge: false, headSha: "aaa", checks: green, reviews: approved });
  check("a held ticket never merges", m.merge === false, m.reason);
}
{
  const m = decideMerge({ mayMerge: true, headSha: "aaa", checks: [], reviews: approved });
  check("no checks reported yet is not success", m.merge === false, m.reason);
}
{
  const m = decideMerge({
    mayMerge: true,
    headSha: "aaa",
    checks: [{ name: "check", conclusion: null, headSha: "aaa" }],
    reviews: approved,
  });
  check("a check still running is not success", m.merge === false, m.reason);
}
{
  const m = decideMerge({
    mayMerge: true,
    headSha: "aaa",
    checks: [{ name: "check", conclusion: "failure", headSha: "aaa" }],
    reviews: approved,
  });
  check("a failing check blocks", m.merge === false, m.reason);
}
{
  // Found by a live tick, not by imagination: our deploy job reports "skipped"
  // on every PR, and blocking on that would stall the gate permanently.
  const m = decideMerge({
    mayMerge: true,
    headSha: "aaa",
    checks: [
      { name: "check", conclusion: "success", headSha: "aaa" },
      { name: "deploy", conclusion: "skipped", headSha: "aaa" },
    ],
    reviews: approved,
  });
  check("a correctly skipped job is not a failure", m.merge === true, m.reason);
}
{
  const m = decideMerge({
    mayMerge: true,
    headSha: "aaa",
    checks: [{ name: "check", conclusion: "cancelled", headSha: "aaa" }],
    reviews: approved,
  });
  check("a cancelled check still blocks", m.merge === false, m.reason);
}
{
  const m = decideMerge({ mayMerge: true, headSha: "aaa", checks: green, reviews: [] });
  check("green checks alone do not merge", m.merge === false, m.reason);
}
{
  const m = decideMerge({
    mayMerge: true,
    headSha: "bbb",
    checks: [{ name: "check", conclusion: "success", headSha: "aaa" }],
    reviews: [{ state: "APPROVED", headSha: "aaa" }],
  });
  check("verdicts about an older push do not count", m.merge === false, m.reason);
}
{
  const m = decideMerge({ mayMerge: true, headSha: "aaa", checks: green, reviews: approved });
  check("green and reviewed for THIS head merges", m.merge === true, m.reason);
}

// ── branch naming ────────────────────────────────────────────────────────────
{
  const b = branchFor(12, "Checker cannot complete third-party OAuth sign-in");
  check("branch is prefixed and slugged", b.startsWith("doer/12-") && !/[^a-z0-9/-]/.test(b), b);
}

// ── the shadow run (CHE-128) ─────────────────────────────────────────────────
//
// The whole design rests on two rails that already existed, so they are asserted
// here rather than trusted: a journeyman/* PR is not the doer's, and a draft is
// never a merge candidate. If either stops holding, a second implementer's
// unreviewed patch becomes something the gate could merge.
{
  check("a journeyman branch is not the doer's", isDoerBranch(`${SHADOW_BRANCH_PREFIX}7-x`) === false);
  check("a doer branch still is", isDoerBranch("doer/7-x") === true);
  check(
    "the merge gate ignores a shadow PR",
    isMergeCandidate({ headRefName: `${SHADOW_BRANCH_PREFIX}7-x`, isDraft: true }) === false,
  );
  check(
    "the merge gate ignores a shadow PR even if it is not a draft",
    isMergeCandidate({ headRefName: `${SHADOW_BRANCH_PREFIX}7-x`, isDraft: false }) === false,
  );
  check(
    "a draft doer PR is not a merge candidate either",
    isMergeCandidate({ headRefName: "doer/7-x", isDraft: true }) === false,
  );
  check(
    "an ordinary doer PR is",
    isMergeCandidate({ headRefName: "doer/7-x", isDraft: false }) === true,
  );
  check("a shadow branch is recognised as one", isShadowBranch("journeyman/7-x") === true);
}
{
  // Absent journeyman, the tick must say so by name and carry on. A silent skip
  // is how a measurement quietly stops being taken.
  const d = decideShadow({ home: "", hasCli: false, hasUv: false });
  check("no journeyman checkout is a named skip", d.run === false && d.reason.includes("JOURNEYMAN_HOME"), d.reason);

  const noUv = decideShadow({ home: "/x", hasCli: true, hasUv: false });
  check("no uv is a named skip", noUv.run === false && noUv.reason.includes("uv"), noUv.reason);

  const off = decideShadow({ home: "/x", hasCli: true, hasUv: true, disabled: true });
  check("DOER_SHADOW=0 turns it off", off.run === false, off.reason);

  const on = decideShadow({ home: "/x", hasCli: true, hasUv: true });
  check("everything present runs it", on.run === true, on.reason);
}
{
  // An operator who names a path and silently gets a different checkout is the
  // "configuration" defect class of CLAUDE.md §8 — our own wrong input, read
  // later as somebody else's result. An explicit setting wins or it skips.
  check(
    "JOURNEYMAN_HOME wins, and never falls back to a sibling",
    findJourneymanHome({ JOURNEYMAN_HOME: "/nope" }, () => true) === "/nope",
  );
  check(
    "with nothing set and no sibling, there is no home",
    findJourneymanHome({}, () => false) === "",
  );
  check(
    "with nothing set, the sibling checkout is used when it is really there",
    findJourneymanHome({}, () => true).endsWith("/journeyman"),
    findJourneymanHome({}, () => true),
  );
}
{
  const args = shadowCommand({
    repo: "sorokinvj/check-my-app", issueNumber: 7, tier: "t1", budget: 1, runnerTimeout: 1800,
  });
  check(
    "the shadow command names the issue, the tier and a cap",
    args.includes("https://github.com/sorokinvj/check-my-app/issues/7") &&
      args.includes("--tier") && args.includes("t1") && args[args.indexOf("--budget") + 1] === "1.00",
    args.join(" "),
  );
  check(
    "the class is journeyman's to infer unless forced",
    !args.includes("--class"),
    args.join(" "),
  );
  check(
    "a live shadow run is never a rehearsal by accident",
    !args.includes("--dry-run"),
    args.join(" "),
  );
  const rehearsal = shadowCommand({
    repo: "r/r", issueNumber: 7, tier: "t1", budget: 1, runnerTimeout: 60, rehearse: true,
  });
  check("a rehearsal spends nothing and publishes nothing", rehearsal.includes("--dry-run"));
}
{
  // Journeyman names its own branch. We find the PR by what appeared, not by
  // recomputing somebody else's slug rule.
  const before = [{ number: 14, headRefName: "journeyman/7-old" }, { number: 20, headRefName: "doer/6-x" }];
  const after = [...before, { number: 21, headRefName: "journeyman/6-new" }, { number: 22, headRefName: "doer/6-y" }];
  const fresh = newShadowPrs(before, after);
  check("only the new shadow PR is picked up", fresh.length === 1 && fresh[0].number === 21, JSON.stringify(fresh));
}
{
  // CRLF, because that is what Python's csv.writer produces and what the real
  // ledger contains. Written with "\n" this fixture passed while the parser read
  // every ts as undefined, and the tick announced an unpriced attempt on a run
  // journeyman had priced correctly.
  const csv = [
    "task_id,attempt_no,tier,model,provider,input_tokens,cached_input_tokens,output_tokens,cost_usd,sandbox_seconds,steps,verdict,failure_stage,diff_files,diff_lines,wall_seconds,ts",
    "a,1,t1,m,openrouter,1,0,1,0.04,10,3,red,no_patch,0,0,11,2026-09-04T04:00:00+00:00",
    "b,1,t1,m,openrouter,1,0,1,0.02,10,3,green,,2,9,11,2026-09-04T06:00:00+00:00",
  ].join("\r\n") + "\r\n";
  const since = ledgerRowsSince(csv, Date.parse("2026-09-04T05:00:00Z"));
  check("the ledger row for THIS attempt is the one written since it started",
    since.length === 1 && since[0].task_id === "b", JSON.stringify(since.map((r) => r.task_id)));
  check("an earlier row is not mistaken for ours", ledgerRowsSince(csv, Date.parse("2026-09-04T07:00:00Z")).length === 0);
  check("the last column survives the line terminator", since[0]?.ts === "2026-09-04T06:00:00+00:00", since[0]?.ts);
}
{
  // An attempt with no cost recorded is the row that makes the week's total a
  // lie — journeyman lost $0.155 to exactly this on 2026-09-04.
  check("a real call recorded at $0.00 is unpriced",
    unpricedAttempt({ provider: "openrouter", cost_usd: "0.0" }) === true);
  check("a stub row is free, not unpriced",
    unpricedAttempt({ provider: "stub", cost_usd: "0.0" }) === false);
  check("a priced attempt is fine",
    unpricedAttempt({ provider: "openrouter", cost_usd: "0.043937" }) === false);
}
{
  // The three reasons a shadow PR is missing are different news, and collapsing
  // them into one sentence is how a defect gets filed under "as expected".
  check("a red gate publishing nothing is the measurement",
    noPrExplanation({ row: { verdict: "red", failure_stage: "no_patch" } }).includes("no_patch"));
  check("a green gate publishing nothing is a defect",
    noPrExplanation({ row: { verdict: "green", failure_stage: "" } }).includes("defect"));
  check("no row at all says so",
    noPrExplanation({ row: null }).includes("no attempt"));
  check("a rehearsal is working as intended",
    noPrExplanation({ row: { verdict: "green" }, rehearse: true }).includes("rehearsal"));
}

console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
