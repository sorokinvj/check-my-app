// CHE-254 (Teams, T1) verification: the scope table says the same thing twice
// only where we mean it to, and adding an action forces a decision.
//
// The table in src/lib/scopes.ts is written out per scope. This file checks it
// against statements made independently of it — the money list, the admin list,
// and three properties that hold whatever the table says:
//
//   1. exhaustive: every (scope × action) pair has an answer, and the table
//      names no action that does not exist;
//   2. monotonic: reader ⊆ member ⊆ admin, so a typo that gives a reader more
//      than a member cannot pass as a deliberate table;
//   3. a reader never spends the team's money, and nobody but an admin takes an
//      admin-only action.
//
// The failure this exists to prevent is the one CHE-108 already cost us on the
// verdict page: a surface offering a control the server will refuse. There the
// stranger was a stranger; here it is a colleague, which is worse — they will
// report it as a bug in the product rather than assume they lack access.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-team-scopes.ts

import {
  ADMIN_ONLY,
  funnelAllows,
  SPENDS_MONEY,
  TEAM_ACTIONS,
  TEAM_SCOPES,
  allowedActions,
  can,
  refusal,
  type TeamAction,
  type TeamScope,
} from "@/lib/scopes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ─── 1. Exhaustive ───────────────────────────────────────────────────────────
// Every pair is asserted, never sampled: the whole point of a table is that it
// can be read in full, and the whole point of this file is that it is.

const matrix: string[] = [];
for (const scope of TEAM_SCOPES) {
  for (const action of TEAM_ACTIONS) {
    const answer = can(scope, action);
    check(
      `${scope} · ${action} → ${answer ? "allowed" : "denied"}`,
      typeof answer === "boolean",
      typeof answer,
    );
    matrix.push(`${scope}\t${action}\t${answer ? "yes" : "no"}`);
  }
}
check(
  `the matrix is ${TEAM_SCOPES.length} × ${TEAM_ACTIONS.length} = ${TEAM_SCOPES.length * TEAM_ACTIONS.length} pairs, all present`,
  matrix.length === TEAM_SCOPES.length * TEAM_ACTIONS.length,
  String(matrix.length),
);

// A duplicate in either list would make a pair look covered while one of its
// copies is unchecked.
check(
  "TEAM_ACTIONS has no duplicates",
  new Set(TEAM_ACTIONS).size === TEAM_ACTIONS.length,
  TEAM_ACTIONS.join(", "),
);
check("TEAM_SCOPES has no duplicates", new Set(TEAM_SCOPES).size === TEAM_SCOPES.length);

// The two classification lists must name real actions — a stale entry here is
// an oracle that silently stops testing the thing it was written for.
const phantom = [...SPENDS_MONEY, ...ADMIN_ONLY].filter((a) => !TEAM_ACTIONS.includes(a));
check(
  "neither SPENDS_MONEY nor ADMIN_ONLY names an action that no longer exists",
  phantom.length === 0,
  phantom.join(", ") || "none",
);

// ─── 2. Monotonic ────────────────────────────────────────────────────────────
// The ladder is the property a table cannot fake: three scopes in one order.

const adminSet = new Set(allowedActions("admin"));
const memberSet = new Set(allowedActions("member"));
const readerSet = new Set(allowedActions("reader"));

check(
  "reader ⊆ member — a reader is never handed something a member lacks",
  [...readerSet].every((a) => memberSet.has(a)),
  [...readerSet].filter((a) => !memberSet.has(a)).join(", ") || "clean",
);
check(
  "member ⊆ admin — an admin is never the weakest scope on the team",
  [...memberSet].every((a) => adminSet.has(a)),
  [...memberSet].filter((a) => !adminSet.has(a)).join(", ") || "clean",
);
check(
  "an admin may do everything — no action is locked away from the person who pays for it",
  TEAM_ACTIONS.every((a) => can("admin", a)),
  TEAM_ACTIONS.filter((a) => !can("admin", a)).join(", ") || "clean",
);
check(
  "the three scopes are actually different — each step down loses something",
  readerSet.size < memberSet.size && memberSet.size < adminSet.size,
  `reader ${readerSet.size}, member ${memberSet.size}, admin ${adminSet.size}`,
);

// ─── 3. The two rules that are not the table's to soften ─────────────────────

check(
  "a reader never spends the team's money",
  SPENDS_MONEY.every((a) => !can("reader", a)),
  SPENDS_MONEY.filter((a) => can("reader", a)).join(", ") || "clean",
);
check(
  "a member may do every action that spends money — the scope exists to do the work",
  SPENDS_MONEY.every((a) => can("member", a)),
  SPENDS_MONEY.filter((a) => !can("member", a)).join(", ") || "clean",
);
check(
  "an admin-only action is denied to both other scopes",
  ADMIN_ONLY.every((a) => !can("member", a) && !can("reader", a)),
  ADMIN_ONLY.filter((a) => can("member", a) || can("reader", a)).join(", ") || "clean",
);
check(
  "a reader can read",
  can("reader", "read") && can("member", "read") && can("admin", "read"),
);

// Every action is classified exactly once: admin-only, spends money, or plain
// operational. An unclassified action fails here until somebody decides what it
// is — which is the mechanism, not the comment above it. A guard that watched
// how many actions exist would have missed the first one added without a class
// (CHE-217/218/220); this one cannot, because it asks about each action by name.
const unclassified = TEAM_ACTIONS.filter(
  (a) =>
    a !== "read" &&
    !ADMIN_ONLY.includes(a) &&
    !SPENDS_MONEY.includes(a) &&
    // Operational: allowed to a member, denied to a reader, costs nothing.
    !(can("member", a) && !can("reader", a)),
);
check(
  "every action is admin-only, money-spending, operational or read — a new one fails here until it is classified",
  unclassified.length === 0,
  unclassified.join(", ") || "none unclassified",
);
const bothClasses = TEAM_ACTIONS.filter((a) => ADMIN_ONLY.includes(a) && SPENDS_MONEY.includes(a));
check(
  "no action is both admin-only and money-spending — those two lists mean different things",
  bothClasses.length === 0,
  bothClasses.join(", ") || "none",
);

// ─── 4. The refusal is a sentence, not a status code ─────────────────────────
// A person denied something is a colleague of whoever can grant it. The copy
// says who that is; it never says "contact support", never explains our
// machinery, and never appears at all when the answer is yes.

for (const scope of TEAM_SCOPES) {
  for (const action of TEAM_ACTIONS) {
    const text = refusal(scope, action);
    if (can(scope, action)) {
      check(`${scope} · ${action}: allowed, so there is nothing to say`, text === null, String(text));
    } else {
      check(
        `${scope} · ${action}: the refusal names who can do it instead`,
        typeof text === "string" && text.length > 0 && /admin|member/i.test(text),
        String(text),
      );
    }
  }
}

const readerRun = refusal("reader", "run.start");
check(
  "a reader denied a check is told it is the plan being spent, not that something failed",
  typeof readerRun === "string" && /read-only/i.test(readerRun) && /spends/i.test(readerRun),
  String(readerRun),
);
check(
  "a member denied billing is pointed at an admin",
  refusal("member", "billing.manage") === "Only an admin of this team can do that.",
  String(refusal("member", "billing.manage")),
);

// ─── 5. A stranger's door does not widen for a reader (CHE-265) ─────────────
//
// Found by T12's dogfood, in production: a reader-scope API key started a
// check. `POST /api/checks` was registered `public`, `public` means "anyone",
// and so authentication made the caller LESS restricted than their own scope.
// The rule is asserted here by name because the failure is invisible — a run
// starts, nothing errors, and the bill arrives later.

check(
  "a stranger may use the funnel",
  funnelAllows(null, "run.start"),
);
check(
  "a READER may not — being a reader on a team is not a way to gain a stranger's capabilities",
  !funnelAllows("reader", "run.start"),
);
for (const scope of ["member", "admin"] as TeamScope[]) {
  check(`a ${scope} may`, funnelAllows(scope, "run.start"));
}
check(
  "the same holds for every action a funnel could ever name",
  TEAM_ACTIONS.every((a) => funnelAllows(null, a) && funnelAllows("admin", a) === can("admin", a)),
);

// The full table, printed. A reviewer should be able to read what this ticket
// decided without opening the source.
console.log("\nscope\taction\tallowed");
for (const row of matrix) console.log(row);

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
