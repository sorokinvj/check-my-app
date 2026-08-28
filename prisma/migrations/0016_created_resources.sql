-- CRUD lifecycle checking with guaranteed cleanup (CHE-90).
--
-- Owner rule, 2026-08-28: "always end by deleting the resource you created".
-- Forbidding creation outright (CHE-89) was the wrong cure — creating a record
-- IS the core value action of most products, so a checker that never creates
-- can only verify the marketing surface. The right shape is the full lifecycle:
-- CREATE → READ (it shows up where a user expects) → UPDATE (the edit sticks)
-- → DELETE (it disappears, and the direct URL stops resolving). Four real
-- verifications, and no state left behind.
--
-- The promise "we clean up" cannot live in a prompt: a crashed journey, a
-- retried step or a model that simply forgets would leave junk in a customer's
-- product (our own self-check left a live app + daily watch on your-app.com,
-- $1.10 burned). So every created resource is written HERE first, and the run
-- audits this ledger at the end: anything still alive is reported to the owner
-- and filed as our own defect.
--
-- App.writeMode gates the whole thing per app: read_only (default, safest) or
-- create_cleanup (the owner opted in to lifecycle checking).

-- AlterTable
ALTER TABLE "App" ADD COLUMN "writeMode" TEXT NOT NULL DEFAULT 'read_only';

-- CreateTable
CREATE TABLE "CreatedResource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "appId" TEXT,
    -- What it is in the product's own words ("story", "app", "job posting").
    "kind" TEXT NOT NULL,
    -- The marker we typed into it, e.g. "CheckMyApp test 2026-08-28 r107".
    -- Cleanup may ONLY ever touch records carrying our marker.
    "marker" TEXT NOT NULL,
    -- Where to find it again — list URL, detail URL, or a human description.
    "locationUrl" TEXT,
    "notes" TEXT,
    "deletedAt" DATETIME,
    -- Why it could not be removed, when it could not.
    "cleanupNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreatedResource_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "CreatedResource_runId_idx" ON "CreatedResource"("runId");
CREATE INDEX "CreatedResource_appId_deletedAt_idx" ON "CreatedResource"("appId", "deletedAt");
