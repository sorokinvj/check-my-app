-- Full re-check (CHE-74). Partial planning (CHE-57) and the smoke replay save
-- money by carrying healthy journeys forward, but that leaves no way to say
-- "walk everything from scratch NOW" — needed after a big deploy of the target
-- app, and for re-verifying carried journeys on demand. forceFull marks a run
-- the owner explicitly requested as full: replay/partial planning steps skip
-- themselves when it is set.
--
-- Default false and no backfill: every historical run keeps its behavior.

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "forceFull" BOOLEAN NOT NULL DEFAULT false;
