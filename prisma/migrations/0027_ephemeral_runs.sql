-- CHE-202: a PR-preview hostname is a run, not an app.
--
-- A check of pr-123.preview.example.com must not leave an App behind — nothing
-- will ever watch that hostname, file tickets against it or export specs for
-- it, and the hostname itself is gone within days. Such a run is marked
-- ephemeral and dated: it stays private to the owner who started it, is never
-- attached to an App row, and is deleted outright — journeys, steps, findings,
-- evidence rows and R2 objects — once expiresAt passes (src/lib/ephemeral.ts,
-- called from the janitor on every scheduler tick). The only kind of run we
-- delete: the target it describes no longer exists either.

ALTER TABLE "Run" ADD COLUMN "ephemeral" BOOLEAN NOT NULL DEFAULT false;
-- NULL on every non-ephemeral run; set at creation from EPHEMERAL_RUN_TTL_DAYS.
ALTER TABLE "Run" ADD COLUMN "expiresAt" DATETIME;

-- The sweep's lookup: ephemeral = true AND expiresAt < now.
CREATE INDEX "Run_ephemeral_expiresAt_idx" ON "Run"("ephemeral", "expiresAt");
