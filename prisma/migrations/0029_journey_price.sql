-- CHE-235: what a journey costs the person walking it, and where it lives.
--
-- The catalog (CHE-231) gave a journey identity and a history of statuses. What
-- it did not carry is the thing a founder actually argues about: the price the
-- user pays. Two numbers, both from the user's side and nobody else's —
--
--   price      how many actions the person performs to get the thing done
--   conversion of 100 people who start it, how many finish
--
-- assigned by the model at discovery against the value already stored, and
-- policed by src/agent/journey-metrics.ts: a changed number whose note names no
-- change is refused, and the stored number stands. Without that rule the
-- numbers drift a few points every run and the drift reads as a trend.
--
-- `surface` answers the other half: a journey is either app-wide ("app") or
-- belongs to one page ("/settings"). A page holds several journeys —
-- joblander's /settings has coach preferences, the resume upload and the
-- extension pairing, and they are three journeys, not three wordings of one.
-- Identity is matched within a surface for exactly that reason. NULL means
-- nobody has told us yet and matches anything, so no journey is split off from
-- its own history by the arrival of this column.

ALTER TABLE "AppJourney" ADD COLUMN "surface" TEXT;
ALTER TABLE "AppJourney" ADD COLUMN "price" INTEGER;
ALTER TABLE "AppJourney" ADD COLUMN "conversion" INTEGER;
-- The value before the last move, so "6 → 8 actions" is readable without
-- joining the run history.
ALTER TABLE "AppJourney" ADD COLUMN "prevPrice" INTEGER;
ALTER TABLE "AppJourney" ADD COLUMN "prevConversion" INTEGER;
-- The model's one sentence: what changed, or why this is the first value.
-- Internal: never rendered into a verdict or an email as written.
ALTER TABLE "AppJourney" ADD COLUMN "metricNote" TEXT;
ALTER TABLE "AppJourney" ADD COLUMN "metricRunId" TEXT;
ALTER TABLE "AppJourney" ADD COLUMN "metricAt" DATETIME;

-- What this particular check said.
ALTER TABLE "Journey" ADD COLUMN "surface" TEXT;
ALTER TABLE "Journey" ADD COLUMN "price" INTEGER;
ALTER TABLE "Journey" ADD COLUMN "conversion" INTEGER;
