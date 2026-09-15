-- CHE-253 (Teams T0): a team owns the apps, pays the bill and grants the
-- access; a personal account is a team of one.
--
-- Every statement is written to be re-runnable against a database that already
-- has some of it: D1 has no transactions, so a migration that half-applies must
-- be safe to apply again. Ids are derived ('team_' || User.id) rather than
-- random for exactly that reason — the second run inserts nothing new.

-- 1. The tables.

CREATE TABLE IF NOT EXISTS "Team" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "isPersonal" INTEGER NOT NULL DEFAULT 1,
  "plan" TEXT NOT NULL DEFAULT 'free',
  "stripeCustomerId" TEXT,
  "stripeSubscriptionId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "Team_stripeCustomerId_key" ON "Team"("stripeCustomerId");

CREATE TABLE IF NOT EXISTS "Membership" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "teamId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'member',
  "invitedByUserId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Membership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Membership_teamId_userId_key" ON "Membership"("teamId", "userId");
CREATE INDEX IF NOT EXISTS "Membership_userId_idx" ON "Membership"("userId");
CREATE INDEX IF NOT EXISTS "Membership_teamId_idx" ON "Membership"("teamId");

-- 2. teamId on everything a team owns. Nullable: SQLite cannot add a NOT NULL
-- column to a populated table without a default, and a default team id would be
-- a lie. What makes these non-null in practice is the backfill below plus
-- scripts/verify-team-backfill.ts, which counts the exceptions rather than
-- trusting this comment.

ALTER TABLE "App" ADD COLUMN "teamId" TEXT;
ALTER TABLE "Run" ADD COLUMN "teamId" TEXT;
ALTER TABLE "Watch" ADD COLUMN "teamId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "teamId" TEXT;
ALTER TABLE "SettledSignature" ADD COLUMN "teamId" TEXT;

CREATE INDEX IF NOT EXISTS "App_teamId_idx" ON "App"("teamId");
CREATE INDEX IF NOT EXISTS "Run_teamId_idx" ON "Run"("teamId");
CREATE INDEX IF NOT EXISTS "Watch_teamId_idx" ON "Watch"("teamId");
CREATE INDEX IF NOT EXISTS "ApiKey_teamId_idx" ON "ApiKey"("teamId");
CREATE INDEX IF NOT EXISTS "SettledSignature_teamId_appSlug_idx" ON "SettledSignature"("teamId", "appSlug");

-- 3. A personal team for every existing user, carrying their plan and their
-- Stripe identity across value for value. Nobody's plan changes on deploy day.

INSERT INTO "Team" ("id", "name", "isPersonal", "plan", "stripeCustomerId", "stripeSubscriptionId", "createdAt", "updatedAt")
SELECT
  'team_' || u."id",
  COALESCE(NULLIF(u."name", ''), u."email"),
  1,
  u."plan",
  u."stripeCustomerId",
  u."stripeSubscriptionId",
  u."createdAt",
  CURRENT_TIMESTAMP
FROM "User" u
WHERE NOT EXISTS (SELECT 1 FROM "Team" t WHERE t."id" = 'team_' || u."id");

-- The one member of that team, and its admin. The last-admin rule (CHE-258)
-- starts here: a personal team's single member can never be demoted, so nobody
-- can lock themselves out of their own apps.

INSERT INTO "Membership" ("id", "teamId", "userId", "scope", "invitedByUserId", "createdAt", "updatedAt")
SELECT
  'mem_' || u."id",
  'team_' || u."id",
  u."id",
  'admin',
  NULL,
  u."createdAt",
  CURRENT_TIMESTAMP
FROM "User" u
WHERE NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."id" = 'mem_' || u."id");

-- 4. Everything that had an owner now has a team. Anonymous rows (ownerId
-- NULL) keep teamId NULL — the public funnel is untouched, and an ephemeral
-- PR-preview run stays app-less and private.

UPDATE "App" SET "teamId" = 'team_' || "ownerId" WHERE "ownerId" IS NOT NULL AND "teamId" IS NULL;
UPDATE "Run" SET "teamId" = 'team_' || "ownerId" WHERE "ownerId" IS NOT NULL AND "teamId" IS NULL;
UPDATE "Watch" SET "teamId" = 'team_' || "ownerId" WHERE "ownerId" IS NOT NULL AND "teamId" IS NULL;
UPDATE "ApiKey" SET "teamId" = 'team_' || "ownerId" WHERE "ownerId" IS NOT NULL AND "teamId" IS NULL;
UPDATE "SettledSignature" SET "teamId" = 'team_' || "ownerId" WHERE "ownerId" IS NOT NULL AND "teamId" IS NULL;

-- 5. The old identity, replaced rather than kept alongside. Two columns meaning
-- "which team" is how the next CHE-156 gets written; two columns meaning "what
-- does this account pay" is how a webhook updates the one nothing reads.
--
-- Indexes first: SQLite refuses to drop a column an index still names.

DROP INDEX IF EXISTS "User_stripeCustomerId_key";
DROP INDEX IF EXISTS "User_clerkOrgId_idx";

ALTER TABLE "User" DROP COLUMN "plan";
ALTER TABLE "User" DROP COLUMN "stripeCustomerId";
ALTER TABLE "User" DROP COLUMN "stripeSubscriptionId";
ALTER TABLE "User" DROP COLUMN "clerkOrgId";

-- App.orgId was written at three sites and never read in any WHERE clause: a
-- team column that never became a team. teamId above is what it meant to be.
ALTER TABLE "App" DROP COLUMN "orgId";

-- The unique constraint on App stays (ownerId, appSlug). With a personal team
-- per person, "one team ↔ one target" says the same thing today, and moving it
-- would rewrite every ownerId_appSlug lookup in the product for no behaviour
-- gained. It moves in T5 (CHE-258), when a second member can add an app.
