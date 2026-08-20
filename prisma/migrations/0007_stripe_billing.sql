-- Stripe billing (CHE-40 phase 3): link a User to their Stripe customer and
-- active subscription so webhooks can flip `plan`. Additive and nullable —
-- every existing row (and every manual business/enterprise account) stays NULL.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "stripeCustomerId" TEXT;
ALTER TABLE "User" ADD COLUMN "stripeSubscriptionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");
