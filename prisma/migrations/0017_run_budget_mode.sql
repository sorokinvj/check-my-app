-- Daily spend cap per app (CHE-98).
--
-- Measured on real watch traffic: only 1 of 12 natural ticks took the free
-- smoke path, so a watched app costs ~$0.44/day on average and up to $1.05.
-- Starter ($29/mo/app ≈ $0.97/day) survives that; Growth does not — 5 apps on
-- a 6-hourly cadence is ~20 walks/day ≈ $264/mo against $99 of revenue. The
-- tier is sold at a loss the moment anyone actually uses it.
--
-- The cure is not to check less honestly, it is to spend deliberately: each app
-- gets a daily agent budget from its owner's plan. While the budget holds, ticks
-- run as they always have. Once it is spent, further ticks that day become
-- smoke-only — we still confirm the app is up and its known pages serve, and
-- the deep walk resumes tomorrow. Trouble is never ignored: a smoke pass that
-- finds something wrong still escalates to a real check.
--
-- budgetMode is set by the scheduler, so it is visible on the run itself rather
-- than hidden in a decision no one can audit later.

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "smokeOnly" BOOLEAN NOT NULL DEFAULT false;
