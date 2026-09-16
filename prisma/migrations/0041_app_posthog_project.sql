-- CHE-237: which PostHog project holds this app's data.
--
-- The connection is the team's (0040); the project is the app's. One PostHog
-- account holds several projects and one team watches several apps, and only
-- the owner can say which is which — so we ask once and store the answer here.
--
-- Two columns rather than one. `posthogProjectId` is the identity and the only
-- thing sent to PostHog; `posthogProjectName` is a label cached at the moment
-- the owner chose, so the settings page can say "Check My App" without a round
-- trip on every render, and can still say it when the analytics connection is
-- expired or gone. A name that has since been changed in PostHog is a stale
-- label, not a broken link — the id still resolves, and the next successful
-- listing refreshes it.
--
-- Deliberately NOT stored here: the region. That belongs to the integration
-- (0040) because it is a property of the token, not of the app — a team cannot
-- hold one app's data in the US and another's in the EU through a single
-- connection, and duplicating it per app would create a second place for it to
-- be wrong. The ticket says the same thing in its own words.
--
-- Both nullable, and null is not a broken state: an app with no project keeps
-- our own estimate and says once that connecting a project would give it the
-- real number. It never nags.
--
-- No index. This is read when a single App row is already in hand, never
-- searched by; an index over a column that is NULL for most rows earns nothing
-- but write cost.

ALTER TABLE "App" ADD COLUMN "posthogProjectId" TEXT;
ALTER TABLE "App" ADD COLUMN "posthogProjectName" TEXT;
