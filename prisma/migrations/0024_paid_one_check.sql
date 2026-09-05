-- A paid one-off check for a visitor the free allowance has run out on
-- (launch, owner decision 2026-09-05).
--
-- The site's free anonymous checks for a day are capped. Past the cap a
-- visitor may pay $1 for one check; it stays an anonymous, public check.
-- Payment is the abuse barrier — no Turnstile on this path.
--
-- The form input is parked in PendingCheck while the visitor pays. A Run is
-- created from it only once Stripe reports the Checkout Session paid — by the
-- webhook, or by the success page polling when the webhook is late. Whichever
-- arrives first creates the run; the other finds it.

-- New: what the visitor typed, waiting on payment. Anonymous — no User row,
-- no Stripe customer.
CREATE TABLE "PendingCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetUrl" TEXT NOT NULL,
    "testEmail" TEXT,
    -- encrypted like Run.testPasswordEnc; nulled once the run exists
    "testPasswordEnc" TEXT,
    "userNotes" TEXT,
    "notifyEmail" TEXT,
    -- the salted IP hash the anonymous quota keys on, carried onto the run
    "anonKeyHash" TEXT,
    "checkoutSessionId" TEXT,
    "runId" TEXT,
    -- unpaid rows are garbage after this
    "expiresAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "PendingCheck_checkoutSessionId_key" ON "PendingCheck"("checkoutSessionId");
CREATE UNIQUE INDEX "PendingCheck_runId_key" ON "PendingCheck"("runId");

-- AlterTable: the session that paid for this run. UNIQUE is the lock — D1 has
-- no transactions, so two starters racing on one payment can only produce one
-- run; the loser reads the winner's.
ALTER TABLE "Run" ADD COLUMN "paidCheckoutSessionId" TEXT;
CREATE UNIQUE INDEX "Run_paidCheckoutSessionId_key" ON "Run"("paidCheckoutSessionId");
