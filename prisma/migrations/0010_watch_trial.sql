-- Daily Watch free trial (CHE-54). A Watch enabled by a FREE owner runs for 7
-- days and then pauses until they subscribe; every other watch is unlimited.
--
-- NULL trialEndsAt is the "not a trial" marker — paid owners and the legacy
-- ownerless watches from before M3 — rather than a zero/epoch sentinel, so the
-- scheduler's rule reads exactly like the product rule: no trial date, no pause.
-- trialNoticeSentAt stamps the one-time "your watch is paused" email so the
-- 15-minute cron can't mail the same owner on every tick.

-- AlterTable
ALTER TABLE "Watch" ADD COLUMN "trialEndsAt" DATETIME;
ALTER TABLE "Watch" ADD COLUMN "trialNoticeSentAt" DATETIME;

-- Backfill: watches already owned by a free-plan account start their 7 days
-- from this migration, not retroactively — nobody's watch goes dark the moment
-- this ships. Paid owners and ownerless rows stay NULL (`ownerId IN (SELECT …)`
-- is NULL, never true, for a NULL ownerId).
--
-- The literal is written in the exact shape the Prisma D1 adapter stores
-- DateTime in (YYYY-MM-DDTHH:MM:SS.sss+00:00) so backfilled rows read back the
-- same way rows the app writes do.
UPDATE "Watch"
SET "trialEndsAt" = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+7 days') || '+00:00'
WHERE "ownerId" IN (SELECT "id" FROM "User" WHERE "plan" = 'free');
