-- CHE-236: the analytics connection, made once for the team.
--
-- Keyed by TEAM, not by owner. The ticket says owner because it was written on
-- 2026-09-14, before teams existed; as of CHE-253 the plan and the subscription
-- belong to the team, and an analytics connection owned by one member would
-- strand everyone else the day that person leaves. That is the same defect
-- shape as SettledSignature holding team knowledge per person (CHE-253/0033),
-- and it is cheaper to not introduce it than to migrate out of it.
--
-- `connectedByUserId` stays as attribution — who pressed Connect — mirroring
-- how Run keeps ownerId alongside teamId.
--
-- One connection per team, enforced by the unique index rather than by
-- application code: two tokens for one team is a question nobody has an answer
-- to ("which one do we read from?"), so the database refuses to hold it.
--
-- The alternative considered and rejected for now: `UNIQUE (teamId,
-- organizationId)`, which would let one team connect two PostHog
-- organisations. It costs the same today and would keep that door open — but
-- PostHog's documentation does not say whether an OAuth token is scoped to one
-- organisation or reaches every organisation the consenting user belongs to,
-- and the answer decides which key is honest. Guessing would mean a unique
-- index over a column that may be NULL for every row (SQLite treats NULLs as
-- distinct, so it would enforce nothing).
--
-- So: one per team now, and the composite becomes a cheap migration the day a
-- real team needs two. Same rule as everywhere else today — do not build for a
-- case nobody has seen, and write down what would prove it.
--
-- Tokens are encrypted at rest with src/lib/crypto (AES-GCM), the same way the
-- Linear and GitHub integrations store theirs. `expiresAt` is absolute rather
-- than a lifetime: a duration stored at write time is wrong by however long the
-- row sat there, and CHE-68 already cost us one integration that died at its
-- first token expiry.

CREATE TABLE "PostHogIntegration" (
  "id"                TEXT PRIMARY KEY NOT NULL,
  "teamId"            TEXT NOT NULL,
  -- Who connected it. Attribution only: access follows the team.
  "connectedByUserId" TEXT,
  "accessTokenEnc"    TEXT NOT NULL,
  "refreshTokenEnc"   TEXT,
  "expiresAt"         DATETIME,
  -- The scopes PostHog actually granted, as it reported them back. Stored so a
  -- later read can say "this connection cannot answer that" instead of failing
  -- with a 403 the owner has to interpret.
  "scope"             TEXT,
  -- What PostHog says the connection belongs to, for the dashboard to show.
  "organizationName"  TEXT,
  "organizationId"    TEXT,
  -- Which region the tokens belong to (us | eu), as discovered during the flow.
  "region"            TEXT,
  "createdAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PostHogIntegration_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PostHogIntegration_teamId_key" ON "PostHogIntegration" ("teamId");
