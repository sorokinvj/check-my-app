-- Why a step went unverified (CHE-83). Owner rule, 2026-08-27: "we couldn't
-- verify X" is never an acceptable end state — if CheckMyApp could not check
-- something, that is OUR defect and must become a high-priority ticket on OUR
-- board until the capability exists.
--
-- Two very different reasons hide behind status='skipped':
--   our_capability  — the agent cannot do it yet (new-tab links, OAuth popups,
--                     MFA codes, media devices). Files against us.
--   missing_access  — the owner has not given us what we need (test
--                     credentials, a staging URL). We ask them; not our bug.
--   not_applicable  — deliberately out of scope (destructive action, scope hint).
--
-- Nullable: historical rows keep NULL and are classified heuristically.

-- AlterTable
ALTER TABLE "Step" ADD COLUMN "unverifiedReason" TEXT;
