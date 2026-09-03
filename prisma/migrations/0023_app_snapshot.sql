-- A full walk when the app changed, not when the calendar says so (CHE-132).
--
-- A watch run has been re-walking every journey once a week regardless of
-- whether anything about the app moved (FULL_RUN_MAX_AGE_DAYS = 7). The smoke
-- check in between re-visits at most six URLs, and the stack and page list are
-- asked of a model although both are readable from the server for free.
--
-- Owner decision, 2026-09-03: once we can say "nothing changed", a calendar
-- full walk is not to happen at all. The seven-day rule stays only as a fuse
-- for the case where nothing can be compared — a blocked homepage, or no
-- earlier snapshot. The verdict must go out at the same time as before, so
-- whatever answers "did it change?" has to be fast and free: a plain fetch of
-- the app's own pages, hashed after stripping the noise (nonces, CSRF tokens,
-- timestamps) but not the build signal (hashed asset names, the Next.js build
-- id). Two such snapshots are the comparison; this table is where they live.

-- New: one row per run, the app's pages as a plain fetch saw them.
CREATE TABLE "AppSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appSlug" TEXT NOT NULL,
    "appId" TEXT,
    "runId" TEXT,
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- sha256 over the sorted per-page content hashes + the bundle list
    "fingerprint" TEXT NOT NULL,
    -- JSON [{ url, path, status, title, hash, forms, links }]
    "pages" TEXT NOT NULL,
    -- JSON string[] — script URLs, same-origin and first-party CDN, sorted
    "bundles" TEXT NOT NULL,
    "buildId" TEXT,
    -- JSON string[] — detected stack signals
    "tech" TEXT NOT NULL,
    "sitemapUrls" INTEGER NOT NULL DEFAULT 0,
    -- the homepage answered 403/429/503 or a challenge page: nothing comparable
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    -- the cap or the deadline stopped the survey early: unvisited pages are
    -- unknown, not removed, so this row is not compared either
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "previousId" TEXT,
    -- NULL = not comparable (first snapshot, or a blocked/truncated side)
    "changed" BOOLEAN,
    -- JSON { addedPaths, removedPaths, changedPaths, bundlesChanged, buildIdChanged }
    "diff" TEXT
);

CREATE INDEX "AppSnapshot_appSlug_takenAt_idx" ON "AppSnapshot"("appSlug", "takenAt");
-- The lookup path for owned apps: the previous snapshot is found by App, not
-- by hostname, because a slug is unique only per owner.
CREATE INDEX "AppSnapshot_appId_takenAt_idx" ON "AppSnapshot"("appId", "takenAt");

-- AlterTable: the snapshot this run took before choosing its mode.
ALTER TABLE "Run" ADD COLUMN "snapshotId" TEXT;
