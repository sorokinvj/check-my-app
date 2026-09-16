// CHE-262 (Teams T9) verification: a verdict reaches the people who asked for
// it, and the self-check still reaches nobody.
//
// The resolution rule is pure, so every combination is asserted rather than
// sampled. The second half matters more than it looks: teams add a third way to
// say "who should hear about this", and the rule that must NOT change is rule 6
// — our own run of our own product is silent, decided by the host and whether
// the run is ours, never by who happens to be on a recipient list.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-recipients.ts

import { NO_RECIPIENTS, describeRecipients, resolveRecipients } from "@/lib/recipients";
import { isOwnRun, silenceReason } from "@/agent/notify-verdict";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ─── The order of the rule ───────────────────────────────────────────────────

const submittedOnly = resolveRecipients({ submitted: "visitor@example.test" });
check(
  "an anonymous check answers the address it was submitted with",
  submittedOnly.to.length === 1 && submittedOnly.to[0] === "visitor@example.test",
  JSON.stringify(submittedOnly),
);

const chosen = resolveRecipients({
  submitted: null,
  chosen: ["oncall@team.test", "lead@team.test"],
  admins: ["boss@team.test"],
});
check(
  "when the team has chosen people, they get it",
  chosen.to.join(",") === "oncall@team.test,lead@team.test",
  JSON.stringify(chosen.to),
);
check(
  "…and the admins are NOT copied on top — a team copied on everything learns to filter us",
  !chosen.to.includes("boss@team.test"),
);

const fallback = resolveRecipients({ submitted: null, chosen: [], admins: ["boss@team.test", "cto@team.test"] });
check(
  "an app nobody configured still reaches a human: the team's admins",
  fallback.to.length === 2 && fallback.via.includes("team admins"),
  JSON.stringify(fallback),
);

const both = resolveRecipients({ submitted: "asked@example.test", chosen: ["oncall@team.test"], admins: ["boss@team.test"] });
check(
  "the person who asked for this run is answered, alongside the chosen",
  both.to.includes("asked@example.test") && both.to.includes("oncall@team.test") && !both.to.includes("boss@team.test"),
  JSON.stringify(both.to),
);
check("the submitter comes first — it is their answer", both.to[0] === "asked@example.test");

// ─── Nobody is mailed twice, and nothing invalid is mailed at all ────────────

const duped = resolveRecipients({
  submitted: "Same@Team.test",
  chosen: ["same@team.test", " same@team.test "],
  admins: ["same@team.test"],
});
check(
  "one person is one email, whatever the capitalisation or spacing",
  duped.to.length === 1 && duped.to[0] === "same@team.test",
  JSON.stringify(duped.to),
);

const junk = resolveRecipients({
  submitted: "not-an-address",
  chosen: ["", null, undefined, "missing@domain"],
  admins: ["real@team.test"],
});
check(
  "an unusable address is not a recipient — and the fallback still runs",
  junk.to.length === 1 && junk.to[0] === "real@team.test",
  JSON.stringify(junk.to),
);

const nobody = resolveRecipients({ submitted: null, chosen: [], admins: [] });
check("nobody resolvable is an empty list, not a crash", nobody.to.length === 0);
check(
  "…and it is described as our defect rather than a state to live with",
  describeRecipients(nobody) === NO_RECIPIENTS && /no recipient/.test(NO_RECIPIENTS),
  NO_RECIPIENTS,
);
check(
  "a resolved list says how many and why, so 'we sent it' can be checked",
  describeRecipients(both) === "2 recipients (submitted + chosen)",
  describeRecipients(both),
);

// ─── Rule 6 is untouched by any of this ──────────────────────────────────────
// The four rows again, because T9 is exactly the kind of change that flattens
// them by accident: a recipient list is a new way to say "who hears about
// this", and it must not become a new way to decide "is this ours".

for (const [label, targetUrl, ownRun, ownedByTestAccount, expected] of [
  ["our host + our team's run, with recipients chosen", "https://checkmyapp.dev/x", true, false, "our own product, checked by us"],
  ["our host + a visitor's run", "https://checkmyapp.dev/x", false, false, null],
  ["a customer host + their team's run", "https://joblander.app/x", true, false, null],
  ["a customer host + a test account", "https://joblander.app/x", true, true, "a self-check account"],
] as const) {
  check(
    `silence still decided by host and ownership: ${label}`,
    silenceReason({ targetUrl, ownRun, ownedByTestAccount }) === expected,
    String(silenceReason({ targetUrl, ownRun, ownedByTestAccount })),
  );
}
check(
  "a team-owned run is still ours for the silence rule",
  isOwnRun({ ownerId: null, teamId: "team_x", watchId: null }),
);

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
