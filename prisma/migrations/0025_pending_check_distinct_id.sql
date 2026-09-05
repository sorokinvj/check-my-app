-- Launch analytics, phase 2 (owner, 2026-09-05): a paid one-off check is
-- bought by a browser we already know — its PostHog distinct id rides in the
-- cookie on the POST that parks the submission. Stored here so the server
-- events the payment produces later (one_check_paid, run_created) land on
-- the same person as the browser's own events, and the landing A/B can be
-- measured through to the dollar. Nullable: a Do Not Track visitor has no id.

ALTER TABLE "PendingCheck" ADD COLUMN "distinctId" TEXT;
