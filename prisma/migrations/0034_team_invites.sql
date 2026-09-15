-- CHE-257 (Teams T4): an invitation is an email, a scope and an expiry.
--
-- Ours rather than Clerk's: the scope is one of our three, decided when the
-- invitation is written, which Clerk's organizations cannot express without the
-- B2B add-on. Only a hash of the token is stored — the raw token exists in the
-- emailed link and nowhere else, so a database dump does not let anyone join a
-- team.
--
-- Re-runnable, like 0032 and 0033.

CREATE TABLE IF NOT EXISTS "TeamInvite" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "teamId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'member',
  "tokenHash" TEXT NOT NULL,
  "invitedByUserId" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "acceptedAt" DATETIME,
  "acceptedByUserId" TEXT,
  "revokedAt" DATETIME,
  "revokedReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamInvite_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeamInvite_tokenHash_key" ON "TeamInvite"("tokenHash");
CREATE INDEX IF NOT EXISTS "TeamInvite_teamId_idx" ON "TeamInvite"("teamId");
CREATE INDEX IF NOT EXISTS "TeamInvite_email_idx" ON "TeamInvite"("email");
