-- Run quotas (CHE-40): anonymous submissions carry a salted hash of the client
-- IP so the one-run-per-24h limit is countable without storing an IP. Additive
-- and nullable — existing rows (and every owner/scheduler run) stay NULL.

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "anonKeyHash" TEXT;

-- CreateIndex
CREATE INDEX "Run_anonKeyHash_idx" ON "Run"("anonKeyHash");
