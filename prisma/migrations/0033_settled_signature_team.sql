-- CHE-256: the settlements a team has already made belong to the team.
--
-- 0032 added SettledSignature.teamId with a comment saying exactly that, and
-- every writer kept setting only ownerId — so the column existed and was never
-- written. Harmless while the reader also used ownerId, and a re-armed CHE-99
-- the moment a reader moved: every settlement would have a null team, the
-- lookup would miss, and the loop would re-file tickets customers had already
-- rejected. Found by the `journeys` session reading the map rather than the
-- summary.
--
-- Re-runnable, like 0032: it only fills NULLs.

-- The App the signature came from knows its team. An App can be deleted and
-- re-created (which is why SettledSignature is not a relation — CHE-101), so
-- the match is on the pair the row itself carries.
UPDATE "SettledSignature"
SET "teamId" = (
  SELECT a."teamId" FROM "App" a
  WHERE a."ownerId" = "SettledSignature"."ownerId"
    AND a."appSlug" = "SettledSignature"."appSlug"
    AND a."teamId" IS NOT NULL
  LIMIT 1
)
WHERE "teamId" IS NULL AND "ownerId" IS NOT NULL;

-- For a settlement whose App is already gone, the owner's personal team is the
-- team that made it — the same derivation 0032 used, so the two agree.
UPDATE "SettledSignature"
SET "teamId" = 'team_' || "ownerId"
WHERE "teamId" IS NULL AND "ownerId" IS NOT NULL;

-- Rows with no owner keep no team: they were settled by nobody in particular
-- and the reader falls back to matching on appSlug and signature alone.
