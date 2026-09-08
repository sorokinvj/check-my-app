-- CHE-215: what a published finding was allowed to rest on, recorded at the
-- moment it was written rather than re-derived later.
--
-- The retro pass this ticket asked for could not tell whether run #159's
-- finding had named a step, because persistence read `stepRef` to copy a
-- screenshot and then threw it away. The answer had to be inferred from
-- whether an Evidence row existed — a proxy, and a fragile one. Findings are
-- the record of what we told a customer; the evidence they were allowed to
-- stand on belongs in that record too, so the next audit reads a column
-- instead of guessing.
--
-- JSON, internal only, never rendered and never in an email:
--   {"stepRef":{"journeyIndex":0,"stepIndex":2}|null,
--    "hands":["fill"],           -- null-effect claims the gate checked
--    "trail":"present"|"absent"} -- whether the run had a machine action trail
-- NULL for every row written before this column existed.

ALTER TABLE "Finding" ADD COLUMN "anchor" TEXT;
