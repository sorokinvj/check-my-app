-- The ledger outlives the app row (CHE-101, CHE-103).
--
-- Two holes found while building the accuracy meter, both of the same class —
-- we lost track of what we had filed or been told:
--
-- 1. Six tickets went onto JobLander's board; four have IssueLink rows. The two
--    missing ones are the duplicates, and one of them (JOB-908) was CANCELED —
--    a customer telling us we were wrong, which is the most valuable signal the
--    loop can produce, and it could never reach us. Links are keyed to the App
--    row and deleted with it, so re-adding an app erases dedup, suppression and
--    the ability to reconcile anything filed before.
--
-- 2. IssueLink finds its Finding by re-hashing the first-seen run's findings
--    against the stored dedupKey. The retro-cleanup of leaking verdict language
--    rewrote finding titles, and the key is derived from the title — so for
--    those links the finding is simply unreachable. Loop C cannot mark it, the
--    re-verify pass cannot name the journey, and the defect classifier is blind.
--
-- Fixes, in the same shape as the rest of the loop: a direct pointer instead of
-- a lucky hash, and a settlement record that belongs to the OWNER rather than to
-- a row they might delete. A signature ruled not-a-bug stays ruled not-a-bug
-- after the app is removed and added again — which is precisely the state that
-- would otherwise let us re-file something we were already told was wrong.

-- AlterTable: stop recovering the finding by re-hashing prose that can change.
ALTER TABLE "IssueLink" ADD COLUMN "findingId" TEXT;

-- New: what the owner has settled about a signature, kept independently of the
-- App row so deleting an app never erases the answer.
CREATE TABLE "SettledSignature" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT,
    "appSlug" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "externalIssueId" TEXT NOT NULL,
    -- 'suppressed' = ruled not-a-bug, never auto-file it again
    -- 'resolved'   = we found it, they fixed it, we confirmed from outside
    -- 'superseded' = the link was re-pointed at a newer ticket; this keeps the
    --                older ticket's identity, which is how JOB-905 and JOB-908
    --                disappeared from the ledger in the first place.
    "outcome" TEXT NOT NULL,
    "defectClass" TEXT,
    "settledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "SettledSignature_ownerId_appSlug_idx" ON "SettledSignature"("ownerId", "appSlug");
CREATE INDEX "SettledSignature_externalIssueId_idx" ON "SettledSignature"("externalIssueId");
