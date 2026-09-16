// CHE-258 (Teams T5) verification: a team can never lose its last admin.
//
// Every way of losing one is asserted by name — demotion, removal, leaving —
// and so is every way of NOT losing one, because a rule that refuses too much
// is as broken as one that refuses too little: a two-admin team where neither
// may leave would be a bug nobody reports, they just stop using the feature.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-membership-rules.ts

import {
  REMOVAL_KEEPS_EVERYTHING,
  decideLeave,
  decideRemoval,
  decideScopeChange,
  type MemberRow,
} from "@/lib/membership";
import { TEAM_SCOPES, type TeamScope } from "@/lib/scopes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const solo: MemberRow[] = [{ userId: "u1", scope: "admin" }];
const adminPlusMember: MemberRow[] = [
  { userId: "u1", scope: "admin" },
  { userId: "u2", scope: "member" },
];
const twoAdmins: MemberRow[] = [
  { userId: "u1", scope: "admin" },
  { userId: "u2", scope: "admin" },
];
const adminMemberReader: MemberRow[] = [
  { userId: "u1", scope: "admin" },
  { userId: "u2", scope: "member" },
  { userId: "u3", scope: "reader" },
];

// ─── The last admin ──────────────────────────────────────────────────────────

for (const scope of ["member", "reader"] as TeamScope[]) {
  const d = decideScopeChange(solo, "u1", scope);
  check(`a personal team's only admin cannot become a ${scope}`, !d.ok, d.ok ? "allowed" : d.reason);
}
check(
  "…nor can the last admin of a team with other people in it",
  !decideScopeChange(adminPlusMember, "u1", "member").ok,
);
check("the last admin cannot be removed", !decideRemoval(adminPlusMember, "u1", "u2").ok);
check("the last admin cannot leave", !decideLeave(adminPlusMember, "u1").ok);
check("the only member of a personal team cannot leave it", !decideLeave(solo, "u1").ok);

// The refusal has to say what to do, or the person is stuck holding a rule.
for (const d of [
  decideScopeChange(solo, "u1", "member"),
  decideRemoval(adminPlusMember, "u1", "u2"),
  decideLeave(adminPlusMember, "u1"),
]) {
  check(
    "every last-admin refusal names the way out (make someone else an admin)",
    !d.ok && /admin/i.test(d.reason) && d.reason.length > 30,
    d.ok ? "allowed" : d.reason,
  );
}

// ─── …and not one step further ───────────────────────────────────────────────

check("with two admins, either may be demoted", decideScopeChange(twoAdmins, "u1", "member").ok);
check("with two admins, either may be removed", decideRemoval(twoAdmins, "u1", "u2").ok);
check("with two admins, either may leave", decideLeave(twoAdmins, "u1").ok);
check("a member may leave", decideLeave(adminPlusMember, "u2").ok);
check("a reader may leave", decideLeave(adminMemberReader, "u3").ok);
check("a member may be removed", decideRemoval(adminMemberReader, "u2", "u1").ok);
check("a member may be promoted to admin", decideScopeChange(adminPlusMember, "u2", "admin").ok);
check("a reader may be promoted to member", decideScopeChange(adminMemberReader, "u3", "member").ok);
check("a member may be demoted to reader", decideScopeChange(adminMemberReader, "u2", "reader").ok);

// ─── The cases that are not errors ───────────────────────────────────────────

check(
  "setting somebody to the scope they already have is a no-op, not a refusal",
  decideScopeChange(adminPlusMember, "u2", "member").ok,
);
check(
  "…including the last admin being 'set' to admin",
  decideScopeChange(solo, "u1", "admin").ok,
);

// ─── The wrong door ──────────────────────────────────────────────────────────

const selfRemoval = decideRemoval(adminMemberReader, "u2", "u2");
check(
  "removing yourself points at leaving rather than refusing flatly",
  !selfRemoval.ok && /leave/i.test(selfRemoval.reason),
  selfRemoval.ok ? "allowed" : selfRemoval.reason,
);

for (const [label, d] of [
  ["scope change", decideScopeChange(adminPlusMember, "stranger", "member")],
  ["removal", decideRemoval(adminPlusMember, "stranger", "u1")],
  ["leaving", decideLeave(adminPlusMember, "stranger")],
] as const) {
  check(`${label} of somebody who is not on the team is refused`, !d.ok, d.ok ? "allowed" : d.reason);
}

// ─── Every scope is covered ──────────────────────────────────────────────────
// A new scope must be decided about rather than inheriting whatever the last
// branch happened to do.

for (const scope of TEAM_SCOPES) {
  const d = decideScopeChange(adminMemberReader, "u2", scope);
  check(`a member can be moved to ${scope} on a team with two other people`, d.ok, d.ok ? "" : d.reason);
}

check(
  "what a removal keeps is stated once, for the page and the action to share",
  /stay with the team/i.test(REMOVAL_KEEPS_EVERYTHING) && /access/i.test(REMOVAL_KEEPS_EVERYTHING),
  REMOVAL_KEEPS_EVERYTHING,
);

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
