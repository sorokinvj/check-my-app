-- A formal test account for checking CheckMyApp with CheckMyApp (CHE-105).
--
-- Self-checking means our agent signs into our own product as a real user and
-- uses it. Until now that user was an ordinary account, so everything it did
-- was indistinguishable from a paying customer's work: it registered an app on
-- a placeholder domain, re-enabled a watch the owner had paused, and the
-- scheduler dutifully spent real money on both for days.
--
-- The fix is not more rules for the agent, it is a different KIND of account:
--   - its watches are never scheduled — nothing it enables can cost money;
--   - everything it owns is disposable, and a janitor removes what it leaves;
--   - its verdicts and mail belong to it, never to the real owner's inbox.
--
-- Marked on the User so the guarantee holds wherever the account is used, not
-- only in the paths we remembered to guard.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "isTestAccount" BOOLEAN NOT NULL DEFAULT false;
