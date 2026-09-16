// CHE-257 (Teams T4) verification: every branch of an invitation, without a
// database or a clock.
//
// The branches are the product here. An invitation that refuses the person it
// was written for reads as a broken link, not as a rule — so each case is
// asserted by name rather than by exercising the happy path and trusting the
// rest.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-invites.ts

import {
  INVITE_TOKEN_RE,
  INVITE_TTL_DAYS,
  checkInviteRequest,
  decideAccept,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteState,
  type InviteRow,
} from "@/lib/invites";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const NOW = new Date("2026-09-15T12:00:00Z");
const later = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

function invite(over: Partial<InviteRow> = {}): InviteRow {
  return {
    teamId: "team_1",
    scope: "member",
    expiresAt: later(INVITE_TTL_DAYS),
    acceptedAt: null,
    revokedAt: null,
    revokedReason: null,
    ...over,
  };
}

// ─── The token ───────────────────────────────────────────────────────────────

async function tokenChecks() {
  const token = generateInviteToken();
check("a token looks like a bearer secret, not a guessable id", INVITE_TOKEN_RE.test(token), token);
check(
  "two tokens are not the same",
  generateInviteToken() !== generateInviteToken(),
);
const hash = await hashInviteToken(token);
check("the hash is SHA-256 hex", /^[0-9a-f]{64}$/.test(hash), hash.slice(0, 16) + "…");
check("the same token hashes the same way twice", (await hashInviteToken(token)) === hash);
check("a different token hashes differently", (await hashInviteToken(generateInviteToken())) !== hash);
check(
    `an invitation expires after ${INVITE_TTL_DAYS} days`,
    inviteExpiry(NOW).getTime() === later(INVITE_TTL_DAYS).getTime(),
    inviteExpiry(NOW).toISOString(),
  );
}

// ─── The state machine ───────────────────────────────────────────────────────

check("a fresh invitation is pending", inviteState(invite(), NOW) === "pending");
check("past its expiry it is expired", inviteState(invite(), later(8)) === "expired");
check("used is used", inviteState(invite({ acceptedAt: NOW }), NOW) === "accepted");
check("cancelled is cancelled", inviteState(invite({ revokedAt: NOW, revokedReason: "revoked" }), NOW) === "revoked");
check("replaced by a resend is its own state", inviteState(invite({ revokedAt: NOW, revokedReason: "resent" }), NOW) === "resent");

// Order is the rule, not an accident: an invitation cancelled before it expired
// stays cancelled afterwards, and one that was used stays used.
check(
  "cancelled beats expired",
  inviteState(invite({ revokedAt: NOW, revokedReason: "revoked" }), later(30)) === "revoked",
);
check("used beats expired", inviteState(invite({ acceptedAt: NOW }), later(30)) === "accepted");
check(
  "used beats cancelled — a race between accept and revoke does not un-join anyone",
  inviteState(invite({ acceptedAt: NOW, revokedAt: NOW, revokedReason: "revoked" }), NOW) === "accepted",
);

// ─── Accepting ───────────────────────────────────────────────────────────────

const ok = decideAccept(invite(), false, NOW);
check("a pending invitation is accepted, with the scope it was written with", ok.kind === "ok" && ok.scope === "member", JSON.stringify(ok));
check(
  "the scope comes from the invitation, not from a default",
  (() => {
    const d = decideAccept(invite({ scope: "reader" }), false, NOW);
    return d.kind === "ok" && d.scope === "reader";
  })(),
);

check(
  "already on the team is not an error — the answer is 'you are in'",
  decideAccept(invite(), true, NOW).kind === "already_member",
);
check(
  "…even when the invitation itself has expired: being a member is the fact that matters",
  decideAccept(invite(), true, later(30)).kind === "already_member",
);

for (const [label, row, when, mustSay] of [
  ["an unknown token", null, NOW, /isn't valid/],
  ["an expired invitation", invite(), later(8), /expired/],
  ["a cancelled invitation", invite({ revokedAt: NOW, revokedReason: "revoked" }), NOW, /cancelled/],
  ["a replaced invitation", invite({ revokedAt: NOW, revokedReason: "resent" }), NOW, /newer invitation/],
  ["an already-used invitation", invite({ acceptedAt: NOW }), NOW, /already been used/],
] as const) {
  const d = decideAccept(row, false, when);
  check(
    `${label}: refused, and the refusal says what to do next`,
    d.kind === "refused" && mustSay.test(d.reason) && /ask|use/i.test(d.reason),
    d.kind === "refused" ? d.reason : d.kind,
  );
}

// No refusal may leave the person with nothing to do — this is the product's
// own rule about homework, applied to our own surface: a dead end is worse than
// a refusal, because the reader cannot tell which of us is broken.
for (const row of [
  null,
  invite({ acceptedAt: NOW }),
  invite({ revokedAt: NOW, revokedReason: "revoked" }),
  invite({ revokedAt: NOW, revokedReason: "resent" }),
]) {
  const d = decideAccept(row, false, later(30));
  check(
    `every refusal names a way forward (${row ? inviteState(row, later(30)) : "unknown token"})`,
    d.kind === "refused" && d.reason.length > 20,
  );
}

// ─── What an admin may send ──────────────────────────────────────────────────

check("a good address and scope pass", checkInviteRequest({ email: "colleague@example.test", scope: "reader" }).ok);
check(
  "the address is normalised, so one person is not invited twice by capitalisation",
  (() => {
    const r = checkInviteRequest({ email: "  Colleague@Example.Test ", scope: "member" });
    return r.ok && r.email === "colleague@example.test";
  })(),
);
for (const bad of ["", "not-an-address", "missing@domain", "two@@at.test", "spaces in@example.test"]) {
  const r = checkInviteRequest({ email: bad, scope: "member" });
  check(`refused: "${bad}"`, !r.ok, r.ok ? "accepted" : r.reason);
}
for (const bad of ["owner", "org:admin", "", "ADMIN"]) {
  const r = checkInviteRequest({ email: "a@b.test", scope: bad });
  check(`refused scope: "${bad}"`, !r.ok, r.ok ? "accepted" : r.reason);
}
for (const scope of ["admin", "member", "reader"]) {
  check(`accepted scope: ${scope}`, checkInviteRequest({ email: "a@b.test", scope }).ok);
}

// The token checks are the only async ones (SubtleCrypto), and the esbuild
// transform this runs under has no top-level await — so they run last, and the
// summary waits for them.
tokenChecks().then(() => {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
