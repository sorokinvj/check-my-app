-- Priority concerns (CHE-81). The owner's "this is what I'm most worried
-- about" in their own words ("all YouTube links must work"). Distinct from
-- scopeHints (limits) and userNotes (context): concerns are POSITIVE checking
-- priorities — discovery must cover each one with a journey, walking verifies
-- them explicitly, synthesis speaks to them in the bottom line.
--
-- Nullable, no backfill: apps without concerns keep today's behavior.

-- AlterTable
ALTER TABLE "App" ADD COLUMN "focusAreas" TEXT;
ALTER TABLE "Run" ADD COLUMN "focusAreas" TEXT;
