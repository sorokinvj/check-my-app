-- CHE-247: what the product actually does on this journey, when something other
-- than a model can say so.
--
-- The identity rules read titles, and titles could not separate these two:
--
--   "Interview assistance and session minutes"   ["interview","assistanc","session","minut"]
--   "Practice with interview assistance"         ["practic","interview","assistanc"]
--
-- Two shared tokens of the shorter title's three — 0.67 against a 0.60
-- threshold — so the second was absorbed into the first. They are not two
-- wordings of one journey: the extension executor gates them apart
-- (`extensionToolAllowed` refuses `extension_start_practice` outside a practice
-- scenario), interview runs one paid meter and practice-extension runs two at
-- once, and the two-meter case is where billing confirmation fails. The row
-- that would carry that history was the one being merged away.
--
-- No token rule could have separated them. The words genuinely overlap; what
-- differs is what the product does. So identity now takes a second input that
-- is not prose: the scenario, which is gated in code rather than described by a
-- model. That is why it outranks the title rules instead of filtering behind
-- them (src/lib/journey-key.ts, `sameScenario`) — unlike `surface`, which IS a
-- model's answer and was demoted below an agreed title for exactly that reason.
--
-- NULL means nobody has told us, and matches anything: a journey that predates
-- this column is never split off from its own history by its arrival.

ALTER TABLE "AppJourney" ADD COLUMN "scenario" TEXT;
ALTER TABLE "Journey" ADD COLUMN "scenario" TEXT;
