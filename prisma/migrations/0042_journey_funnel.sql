-- CHE-238: the funnel a journey's walk implies, stored on the journey.
--
-- Derived from the pages the walk actually moved through (src/lib/funnel.ts),
-- never from anything the customer was asked to define — asking a founder to
-- define a funnel for us is homework, and homework is a hard failure of rule 1.
--
-- Stored rather than re-derived each run for one reason: a funnel that changes
-- shape silently makes every comparison meaningless. Yesterday's 12% and
-- today's 40% would look like a trend while measuring different questions. So
-- the first derivation wins, and a later run that would derive something else
-- records the fact in `funnelDriftAt` instead of quietly overwriting. Changing
-- a funnel is a decision someone makes, not a side effect of a walk going a
-- different way.
--
-- `funnelStages`   JSON array of normalised paths, in order. NULL means we have
--                  never successfully derived one.
-- `funnelRefusal`  why the last attempt produced no funnel — one of
--                  no_pages | single_stage | revisits | wandering. This is a
--                  statement about OUR capability, not the customer's product
--                  (rule 2): it is what a "[Checker gap]" ticket is filed from,
--                  and it must never reach a verdict as a caveat.
-- `funnelDerivedAt`/`funnelDriftAt` — when we first knew, and when we last
--                  noticed the walk disagreeing with what we stored.
--
-- No index: these are read with the journey row already in hand, never searched
-- by.

ALTER TABLE "AppJourney" ADD COLUMN "funnelStages" TEXT;
ALTER TABLE "AppJourney" ADD COLUMN "funnelRefusal" TEXT;
ALTER TABLE "AppJourney" ADD COLUMN "funnelDerivedAt" DATETIME;
ALTER TABLE "AppJourney" ADD COLUMN "funnelDriftAt" DATETIME;
