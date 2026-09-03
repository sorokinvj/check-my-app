-- Record what the walk did, not only what it saw (CHE-129).
--
-- Walking is 69% of a run's cost — about 24 model calls per journey — and a
-- watch run spends them re-discovering a path it walked the day before. It has
-- to, because Step keeps prose (label / attempted / observed) and prose cannot
-- be executed. The Playwright specs the walk writes can, but only under the
-- test runner on Node, never on workerd where the runs live.
--
-- This is the spike the owner chose to start first (2026-09-03): store the
-- machine actions behind each step, replay them on workerd with no model in
-- the loop, and measure how many journeys reproduce. Whether the full feature
-- gets built is decided from that number, so the measurement is written on
-- the journey itself and read by nobody but our own scripts.

-- AlterTable: the navigate/click/fill calls the walk actually executed for
-- this step, as JSON, credentials left as placeholders.
ALTER TABLE "Step" ADD COLUMN "actions" TEXT;

-- AlterTable: the replay verdict — reproduced | no_actions | refused |
-- diverged | errored — and a one-line note saying where it stopped.
ALTER TABLE "Journey" ADD COLUMN "replayStatus" TEXT;
ALTER TABLE "Journey" ADD COLUMN "replayNote" TEXT;
