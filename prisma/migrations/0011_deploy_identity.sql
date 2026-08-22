-- Deploy identity (CHE-56). A run can name the deploy it verified — commit sha
-- plus the environment it landed in — so CI can gate a release on the verdict
-- and, later, point at the exact build a finding belongs to.
--
-- Both columns are nullable and carry no default: a run without a deploy
-- identity (the browser funnel, a scheduled watch run) is the normal case, not
-- a degraded one, and NULL says "this run was not tied to a deploy" without
-- inventing a sha nobody can look up. No backfill for the same reason — a
-- historical run's deploy is genuinely unknown.
--
-- Stored as free text, not validated in SQL: the sha is whatever the caller's
-- VCS calls a revision (git sha, hg node, a build id), and the API layer is the
-- one place that decides what is acceptable (createCheckSchema).

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "deploySha" TEXT;
ALTER TABLE "Run" ADD COLUMN "deployEnv" TEXT;
