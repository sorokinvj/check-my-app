-- CHE-231: a journey is the unit of a run, not a row a run invents.
--
-- joblander.app, 60 runs: 228 journey rows carrying 167 distinct titles for
-- roughly a dozen actual journeys. Continuity was reconstructed every run by
-- reading the last run's rows and matching prose — so "the sign-up journey has
-- been green for eleven days and broke today" was a sentence the data could not
-- support, and the thing that actually costs money (walking one journey) had no
-- row to accumulate on.
--
-- AppJourney is that row: identity (a key decided by src/lib/journey-key.ts),
-- the current plan, the current state, when it was last really walked, and what
-- it has cost. The per-run Journey row keeps its meaning and becomes a CHECK of
-- one of these.

CREATE TABLE "AppJourney" (
    "id"    TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    -- Stable slug ("signup", "install-extension"). Never rewritten: a key that
    -- moves is a history that restarts.
    "key"   TEXT NOT NULL,
    "title" TEXT NOT NULL,
    -- JSON string[]: every wording resolved to this journey — the audit trail
    -- for what the identity rules merged.
    "aliases" TEXT NOT NULL DEFAULT '[]',
    -- JSON string[]: ordered step labels from the last walk that produced any.
    "plan"    TEXT NOT NULL DEFAULT '[]',

    "status"          TEXT,
    "lastRunId"       TEXT,
    "lastRunNumber"   INTEGER,
    -- A carried copy does NOT move these: they are when the journey was really
    -- walked, and by which run.
    "lastWalkedAt"    DATETIME,
    "lastWalkedRunId" TEXT,
    "walkCount"       INTEGER NOT NULL DEFAULT 0,
    "consecutiveBad"  INTEGER NOT NULL DEFAULT 0,
    "failingSince"    DATETIME,
    "costUsd"         REAL NOT NULL DEFAULT 0,
    -- A journey the product no longer has: kept as the record of what the app
    -- used to do, never walked again.
    "retiredAt"     DATETIME,
    "retiredReason" TEXT,

    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "AppJourney_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AppJourney_appId_key_key" ON "AppJourney"("appId", "key");
CREATE INDEX "AppJourney_appId_retiredAt_idx" ON "AppJourney"("appId", "retiredAt");

-- Which journey of the app this run checked. NULL on runs with no App row
-- (anonymous checks, PR previews) and on rows written before the catalog.
ALTER TABLE "Journey" ADD COLUMN "appJourneyId" TEXT REFERENCES "AppJourney"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- The identity itself, denormalised: filled in even where no catalog row
-- exists, so every journey row ever written can be grouped by what it checked.
ALTER TABLE "Journey" ADD COLUMN "journeyKey" TEXT;
-- What this check cost (walking loop + its judge). NULL on a carried journey:
-- nothing was spent walking it.
ALTER TABLE "Journey" ADD COLUMN "costUsd" REAL;

CREATE INDEX "Journey_appJourneyId_idx" ON "Journey"("appJourneyId");
