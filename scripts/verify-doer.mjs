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
import { mayUnpark, unparkOurRuns, DOER_PR_AUTHOR, PARKED_STATUS } from "./doer/unpark.mjs";
import { admit, partition } from "./doer/queue.mjs";

let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
};

// A queue item as board-queue.ts hands it over: a ticket of ours that a run
// filed and queue.mjs admitted. No labels — the label queue is gone (CHE-118).
const item = (ticket, createdAt, label = "t") => ({ ticket, createdAt, label, kind: "gap" });

// ── which ticket, and whether to act at all ──────────────────────────────────
{
  const d = decideTick({ queue: [], openDoerPrs: [], stopped: true });
  check("stop flag halts the tick", d.act === false && d.reason.includes("stopped"), d.reason);
}
{
  const d = decideTick({
    queue: [item("CHE-96", "2026-09-01")],
    openDoerPrs: [{ number: 9, headRef: "doer/9-x" }],
    stopped: false,
  });
  check("one open PR blocks a second", d.act === false && d.reason.includes("#9"), d.reason);
}
{
  const d = decideTick({ queue: [], openDoerPrs: [], stopped: false });
  check(
    "an empty queue is named, not silent",
    d.act === false && d.reason.includes("no open ticket"),
    d.reason,
  );
}
{
  const d = decideTick({
    queue: [item("CHE-146", "2026-09-02"), item("CHE-96", "2026-08-20")],
    openDoerPrs: [],
    stopped: false,
  });
  check(
    "oldest first, so nothing starves",
    d.act === true && d.item.ticket === "CHE-96",
    `picked ${d.item?.ticket}`,
  );
}
{
  // The reader sorts too; this rail must hold even if it hands over an
  // out-of-order list, because the order is a decision and decisions live here.
  const d = decideTick({
    queue: [item("CHE-146", "2026-09-02"), item("CHE-96", "2026-08-20")].reverse(),
    openDoerPrs: [],
    stopped: false,
  });
  check("order does not depend on the reader", d.act === true && d.item.ticket === "CHE-96", d.item?.ticket);
}
{
  const d = decideTick({ queue: [item("CHE-96", "2026-08-20")], openDoerPrs: [], stopped: false });
  check("merging is the default, not an opt-in", d.act === true && d.mayMerge === true, `mayMerge=${d.mayMerge}`);
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

// ── releasing a parked run (CHE-153) ─────────────────────────────────────────
//
// This repository is public, and the only thing standing between a stranger's
// fork and this repository's compute is the approval GitHub parks their run
// for. These cases are that boundary. The three conditions are required
// together, so each one is tested by removing exactly that one from an
// otherwise releasable run.
{
  const REPO = "sorokinvj/check-my-app";
  const ourPr = { headRef: "doer/6-x", headRepo: REPO, author: DOER_PR_AUTHOR };
  // The shape GitHub actually reports, taken from a real parked run rather than
  // imagined: run 33872669967 on 2026-09-04 came back as a COMPLETED run whose
  // conclusion is that a person must act. Written as `status: "action_required"`
  // — the reading the field name invites — this fixture passed while the sweep
  // skipped every real parked run and reported success having released nothing.
  const parked = {
    id: 1, status: "completed", conclusion: PARKED_STATUS,
    headBranch: "doer/6-x", headRepository: REPO,
  };

  check("our own parked run is released", mayUnpark({ run: parked, prs: [ourPr], repo: REPO }).unpark === true);
  check("a run parked in the status field is released too",
    mayUnpark({
      run: { ...parked, status: PARKED_STATUS, conclusion: null },
      prs: [ourPr], repo: REPO,
    }).unpark === true);

  {
    // The whole reason the policy exists. A fork may name its branch anything,
    // `doer/6-x` included; the head repository is the part it cannot forge.
    const fork = { ...parked, headRepository: "stranger/check-my-app" };
    const d = mayUnpark({
      run: fork,
      prs: [{ headRef: "doer/6-x", headRepo: "stranger/check-my-app", author: DOER_PR_AUTHOR }],
      repo: REPO,
    });
    check("a fork's run stays parked even on a doer/* branch", d.unpark === false, d.reason);
  }
  {
    const d = mayUnpark({
      run: { ...parked, headBranch: "feature/whatever" },
      prs: [{ headRef: "feature/whatever", headRepo: REPO, author: DOER_PR_AUTHOR }],
      repo: REPO,
    });
    check("a branch outside doer/* and journeyman/* stays parked", d.unpark === false, d.reason);
  }
  {
    // Write access here is enough to push a `doer/*` branch, so the prefix alone
    // is not proof of authorship — the pull request's author is.
    const d = mayUnpark({
      run: parked,
      prs: [{ headRef: "doer/6-x", headRepo: REPO, author: "someone-else" }],
      repo: REPO,
    });
    check("a doer/* branch somebody else opened the PR for stays parked", d.unpark === false, d.reason);
  }
  {
    const d = mayUnpark({ run: parked, prs: [], repo: REPO });
    check("a parked run with no open pull request stays parked", d.unpark === false, d.reason);
  }
  {
    const d = mayUnpark({
      run: { ...parked, headBranch: "journeyman/7-x" },
      prs: [{ headRef: "journeyman/7-x", headRepo: REPO, author: DOER_PR_AUTHOR }],
      repo: REPO,
    });
    check("the shadow leg's own branch is released too", d.unpark === true, d.reason);
  }
  {
    const d = mayUnpark({
      run: { ...parked, status: "completed", conclusion: "success" }, prs: [ourPr], repo: REPO,
    });
    check("a run that is not parked is left alone", d.unpark === false, d.reason);
  }

  // ── the sweep around that decision ─────────────────────────────────────────
  const fakeGh = ({ runs = [], prs = [], prsThrow = false }) => (args) => {
    const url = args[1] ?? "";
    if (url.includes("/actions/runs")) return runs;
    if (url.includes("/pulls")) {
      if (prsThrow) throw new Error("gh: 502 Bad Gateway");
      return prs;
    }
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  const quiet = () => {};
  {
    const approved = [];
    const r = unparkOurRuns({
      repo: REPO,
      gh: fakeGh({ runs: [parked, { ...parked, id: 2, headRepository: "stranger/x" }], prs: [ourPr] }),
      approve: (id) => approved.push(id),
      say: quiet,
    });
    check("the sweep releases ours and skips the rest",
      approved.join() === "1" && r.released.join() === "1" && r.skipped.length === 1,
      `approved=${approved.join()} skipped=${r.skipped.length}`);
  }
  {
    // An empty sweep still speaks. "Nothing was parked" and "the sweep never
    // ran" must not read the same in a log — this sweep is what stands between
    // a doer pull request and its checks (CHE-152).
    const said = [];
    const r = unparkOurRuns({
      repo: REPO,
      gh: fakeGh({ runs: [], prs: [ourPr] }),
      approve: () => { throw new Error("nothing should be approved"); },
      say: (s) => said.push(s),
    });
    check("an empty sweep says so rather than saying nothing",
      r.released.length === 0 && said.some((s) => s.includes("nothing is parked")),
      `said=${said.join(" | ") || "(silence)"}`);
  }
  {
    // Fail closed. Without the pull requests, ownership cannot be established,
    // and an unverifiable claim of ownership releases nothing.
    const approved = [];
    const r = unparkOurRuns({
      repo: REPO,
      gh: fakeGh({ runs: [parked], prsThrow: true }),
      approve: (id) => approved.push(id),
      say: quiet,
    });
    check("unreadable pull requests release nothing", approved.length === 0 && r.released.length === 0);
  }
  {
    // If GitHub refuses a workflow token this permission, the loop stops at a
    // button again — and it must never stop there silently.
    const said = [];
    const r = unparkOurRuns({
      repo: REPO,
      gh: fakeGh({ runs: [parked], prs: [ourPr] }),
      approve: () => { throw new Error("Resource not accessible by integration"); },
      say: (s) => said.push(s),
    });
    check("a refused approval is reported, not swallowed",
      r.failed.length === 1 && said.some((s) => s.includes("FAILED")),
      said.join(" | "));
  }
}

// ── what the doer may take off our own board (CHE-118) ───────────────────────
//
// The rail here is not "does it admit the right things" — that is a judgement
// written down in queue.mjs. It is that every verdict carries a reason, that an
// unknown capability is refused rather than guessed at, and that nothing is
// silently dropped between the board and the queue.
{
  const v = admit({ title: "Fix the pricing page copy" });
  check(
    "a hand-written ticket is not the doer's queue",
    v.ok === false && v.reason.includes("not filed by a run"),
    v.reason,
  );
}
{
  const v = admit({ title: "[Checker gap] Checker cannot follow links that open in a new tab" });
  check("an admitted capability is taken, with its reason", v.ok === true && v.reason.length > 0, v.reason);
}
{
  // The real tickets on the board carry the policy's prefix; the ruling is
  // about the capability, so the prefix must not change the verdict.
  const v = admit({
    title: "[Checker gap] CheckMyApp agent capability: Checker cannot drive file upload/download flows",
  });
  check("the ticket policy's prefix does not hide the capability", v.ok === true, v.reason);
}
{
  const v = admit({
    title: "[Checker gap] CheckMyApp agent capability: Checker is blocked by CAPTCHA/bot protection on the target",
  });
  check(
    "bypassing bot protection is refused outright",
    v.ok === false && v.reason.includes("forbidden"),
    v.reason,
  );
}
{
  const v = admit({ title: "[Checker gap] Checker cannot read the customer's mind" });
  check(
    "a capability nobody has ruled on is refused, and says how to rule",
    v.ok === false && v.reason.includes("queue.mjs"),
    v.reason,
  );
}
{
  const v = admit({
    title: "[Checker defect] CheckMyApp checker accuracy: Checker reported a product defect caused by our own configuration",
  });
  check("a named defect class is work the doer may take", v.ok === true, v.reason);
}
{
  const v = admit({
    title: "[Checker defect] CheckMyApp checker accuracy: Checker filed a claim the owner rejected, cause unclassified",
  });
  check(
    "an unclassified defect is refused — nothing is named to fix",
    v.ok === false && v.reason.includes("classifying it is the filer's job"),
    v.reason,
  );
}
{
  // The shape the reader hands over: capability already recognised, no title.
  // Both shapes must reach the same ruling — a rule that depends on who asks is
  // two rules. This case exists because the first version had exactly that bug,
  // and the dry run against the real board caught it: eight tickets refused as
  // "not filed by a run" when all eight were filed by runs.
  const resolved = admit({ label: "Checker leaves test records behind in the customer's product", kind: "gap" });
  const byTitle = admit({
    title: "[Checker gap] Checker leaves test records behind in the customer's product",
  });
  check(
    "the reader's shape and a raw title reach the same ruling",
    resolved.ok === true && byTitle.ok === true && resolved.reason === byTitle.reason,
    `${resolved.ok}/${byTitle.ok}`,
  );
}
{
  const tickets = [
    { title: "[Checker gap] Checker cannot follow links that open in a new tab", createdAt: "2026-09-05" },
    { title: "[Checker gap] Checker is blocked by CAPTCHA/bot protection on the target", createdAt: "2026-09-01" },
    { title: "[Checker gap] Checker leaves test records behind in the customer's product", createdAt: "2026-08-27" },
  ];
  const { queue, refused } = partition(tickets);
  check(
    "nothing is dropped between the board and the queue",
    queue.length + refused.length === tickets.length,
    `${queue.length} queued + ${refused.length} refused of ${tickets.length}`,
  );
  check(
    "oldest first, so the queue never becomes a stack",
    queue[0]?.createdAt === "2026-08-27",
    String(queue[0]?.createdAt),
  );
  check(
    "every refusal carries its reason",
    refused.every((r) => typeof r.reason === "string" && r.reason.length > 0),
  );
}

console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
