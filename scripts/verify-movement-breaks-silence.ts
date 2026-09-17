// CHE-241 verification: a metric that moved is itself a change.
//
// The Watch's "only tell me when something changes" setting used to ask one
// question — did the verdict differ from the baseline? — and the metric alert
// was assembled AFTER that gate. So on a change-only watch:
//
//   yesterday   verdict all_good
//   today       verdict all_good, and a journey converting twenty points worse
//   sent        nothing
//
// The app worked, so the verdict did not move, so the mail was skipped, so the
// sentence died with it. That sentence is the whole of what this epic adds to
// Watch, and on 2026-09-17 every watch in production was change-only — the
// owner's three, which is all of them. The feature could not fire for anybody.
//
// CHE-241 states the rule the code was missing, in its own words:
//
//   "A verdict of 'all good' with a conversion that fell is not a contradiction
//    and must not be smoothed into one: the app works, and fewer people finish.
//    Both sentences stand."
//
// Two mechanisms:
//
//   1. the gate is a pure function over (verdict changed, alerts) and is checked
//      across every combination of the two;
//   2. `metricAlerts` is a REQUIRED parameter of the gate, so it cannot be
//      evaluated before the alerts exist. This file reads the source to confirm
//      the ordering holds, because the failure mode is silence — and silence is
//      indistinguishable from nothing being wrong, which is why it survived.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-movement-breaks-silence.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changeOnlyWantsNotice } from "@/agent/notify-verdict";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const FELL = ["“Sign up” — fewer people are getting from / to /signup: 15% of 400, against 40% before — 25 points down."];

console.log("\n— a movement is a change, even when the verdict is not —\n");

check(
  "verdict unchanged + a journey moved → the owner still hears about it",
  changeOnlyWantsNotice({ verdictChanged: false, metricAlerts: FELL }) === true,
  "this is the case that shipped silent",
);
check(
  "verdict unchanged + nothing moved → still quiet, as the setting asks",
  changeOnlyWantsNotice({ verdictChanged: false, metricAlerts: [] }) === false,
);
check(
  "verdict changed + nothing moved → sent, as before",
  changeOnlyWantsNotice({ verdictChanged: true, metricAlerts: [] }) === true,
);
check(
  "verdict changed + a journey moved → sent",
  changeOnlyWantsNotice({ verdictChanged: true, metricAlerts: FELL }) === true,
);
check(
  "several movements are still one decision",
  changeOnlyWantsNotice({ verdictChanged: false, metricAlerts: [...FELL, ...FELL] }) === true,
);

console.log("\n— the gate cannot be reached before the alerts exist —\n");

{
  const src = readFileSync(join(import.meta.dirname, "..", "src/agent/notify-verdict.ts"), "utf8");

  const alertsAt = src.indexOf("const metricAlerts =");
  const gateAt = src.indexOf("await watchWantsNotice(");
  check("the alerts are assembled in notify-verdict", alertsAt > 0);
  check("the change-only gate is called there too", gateAt > 0);
  check(
    "…and the alerts are assembled BEFORE the gate decides",
    alertsAt > 0 && gateAt > 0 && alertsAt < gateAt,
    `alerts at ${alertsAt}, gate at ${gateAt}`,
  );

  // Structural, not textual: a gate that can be called without the alerts will
  // eventually be called without them, and the result is silence nobody sees.
  check(
    "the gate takes the alerts as a required argument",
    /async function watchWantsNotice\([^)]*metricAlerts: readonly string\[\]/s.test(src),
  );
  check(
    "…and the pure decision is exported, so it can be held to account here",
    /export function changeOnlyWantsNotice/.test(src),
  );
}

console.log("\n— the self-check silence is NOT weakened by any of this —\n");

{
  const src = readFileSync(join(import.meta.dirname, "..", "src/agent/notify-verdict.ts"), "utf8");
  const silentAt = src.indexOf("if (silent)");
  const alertsAt = src.indexOf("const metricAlerts =");
  // Rule 6 is absolute and comes first: our own run of our own product never
  // reaches an inbox, whatever its metrics did. Ordering proves it — the silence
  // return happens before anything about movement is considered.
  check(
    "our own product's run is still dropped before movement is even considered",
    silentAt > 0 && alertsAt > 0 && silentAt < alertsAt,
    `silence at ${silentAt}, alerts at ${alertsAt}`,
  );
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
