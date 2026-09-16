-- CHE-263 (Teams T10): a key carries a scope.
--
-- Until now a key resolved to a person and inherited that person's whole
-- authority — which is how POST /api/runs/{id}/recheck came to refuse the
-- owner's own key (CHE-246): nothing decided what a key may do, so the answer
-- depended on which helper a route happened to call.
--
-- Existing keys become `member`: they can run checks and act on findings, which
-- is what they could do before, and they cannot manage billing or membership,
-- which they were never asked to do. Nobody's CI hook changes behaviour.
--
-- Re-runnable: the column has a default, and a second application is a no-op.

ALTER TABLE "ApiKey" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'member';
