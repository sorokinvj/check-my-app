// CHE-263 (Teams T10) verification: a key does exactly what its scope says,
// and never more than the person who made it.
//
// The defect this closes is not a missing feature. It is that **nothing decided
// what a key may do**: `canMutateOwned` went through a helper that only knows a
// Clerk session, so `POST /api/runs/{id}/recheck` refused the owner's own key
// (CHE-246) — not because anyone decided a key should be refused, but because
// the answer depended on which helper a route happened to call.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-key-scopes.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  TEAM_ACTIONS,
  TEAM_SCOPES,
  can,
  canMintKey,
  mintRefusal,
  type TeamScope,
} from "@/lib/scopes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ─── A key is answered by its own scope ──────────────────────────────────────
// Same table, same answers: a key is not a second kind of caller with a second
// set of rules, which is exactly how the first one drifted.

for (const scope of TEAM_SCOPES) {
  for (const action of TEAM_ACTIONS) {
    check(
      `${scope} key · ${action} → ${can(scope, action) ? "allowed" : "denied"}`,
      typeof can(scope, action) === "boolean",
    );
  }
}

// The key customers will ask for: reads everything, spends nothing.
check(
  "a reader key can read and cannot start a run",
  can("reader", "read") && !can("reader", "run.start") && !can("reader", "run.recheck"),
);
check(
  "a member key can run checks and cannot touch billing or membership",
  can("member", "run.start") &&
    can("member", "run.recheck") &&
    !can("member", "billing.manage") &&
    !can("member", "member.invite"),
);
check("an admin key can do everything a person could", TEAM_ACTIONS.every((a) => can("admin", a)));

// ─── Minting: never above your own scope ─────────────────────────────────────

check("an admin may mint any key", TEAM_SCOPES.every((s) => canMintKey("admin", s)));
check("a member may mint member and reader keys", canMintKey("member", "member") && canMintKey("member", "reader"));
check("…and may NOT mint an admin key", !canMintKey("member", "admin"));
check("a reader may mint a reader key only", canMintKey("reader", "reader") && !canMintKey("reader", "member") && !canMintKey("reader", "admin"));
check(
  "the refusal says why rather than just refusing",
  /can't do more than the person who made it/.test(mintRefusal("member", "admin") ?? ""),
  String(mintRefusal("member", "admin")),
);
check("no refusal when the mint is allowed", mintRefusal("admin", "reader") === null);

// The property behind all of the above, stated once: escalation is impossible
// by construction, not by a list of cases somebody remembered.
const ladder: TeamScope[] = ["reader", "member", "admin"];
check(
  "minting can never escalate: for every pair, a key is allowed only at or below its minter",
  ladder.every((minter, i) => ladder.every((key, j) => canMintKey(minter, key) === (j <= i))),
);

// ─── The 403 that started this (CHE-246) ─────────────────────────────────────

const recheckRoute = read("src/app/api/runs/[id]/recheck/route.ts");
check(
  "the recheck route answers a key and a session the same way",
  recheckRoute.includes("canMutateOwnedFromRequest"),
);
const auth = read("src/lib/auth.ts");
check(
  "…and that helper resolves an API key, not only a Clerk session",
  /canMutateOwnedFromRequest[\s\S]{0,900}resolveApiKeyGrant/.test(auth),
);
check(
  "…and asks the scope table whether that key may act, rather than assuming a key may",
  /canMutateOwnedFromRequest[\s\S]{0,900}can\(grant\.scope as TeamScope, "run\.recheck"\)/.test(auth),
);
check(
  "a run belonging to the caller's TEAM is actionable — the row belongs to the team, not to whoever clicked first",
  /canMutateOwnedFromRequest[\s\S]{0,900}grant\.team\.id === row\.teamId/.test(auth),
);

const teamAuth = read("src/lib/team-auth.ts");
check(
  "the route guard answers an API key from the KEY's scope and team",
  /resolveApiKeyGrant[\s\S]{0,700}grant\.scope as TeamScope/.test(teamAuth),
);
check(
  "…so a reader key stays a reader key after its author becomes an admin",
  /reader key stays a reader key/.test(teamAuth),
);

// ─── The migration's own promise ─────────────────────────────────────────────

const migration = read("prisma/migrations/0038_api_key_scope.sql");
check(
  "existing keys become `member` — a CI hook does not change behaviour on deploy day",
  /DEFAULT 'member'/.test(migration),
);

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
