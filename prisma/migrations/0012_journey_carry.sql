-- Journey carry (CHE-57). A partial watch run re-walks only the journeys that
-- were bad last time and copies the healthy ones forward, so a Journey row now
-- has to be able to say "this was not walked in this run".
--
-- carriedFromRunId names the run that ACTUALLY walked the journey — the
-- provenance root, not necessarily the run we copied it from. When a partial run
-- carries a journey that was itself carried, the id points further back, so the
-- verdict chip ("carried · Run #42") and the bottom line's "last walked <date>"
-- always name the run where the evidence was really produced.
--
-- Nullable with no default and no backfill: NULL means "this run walked it",
-- which is what every historical row genuinely is. Stored as a bare id rather
-- than a foreign key on purpose — provenance must survive the source run being
-- pruned, and a cascade would delete the carried journey along with it.

-- AlterTable
ALTER TABLE "Journey" ADD COLUMN "carriedFromRunId" TEXT;
