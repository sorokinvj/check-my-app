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
  QUEUE_LABEL,
  HOLD_LABEL,
} from "./doer/eligibility.mjs";

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

console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
