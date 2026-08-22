-- Owner API keys (CHE-52): a coding agent authenticates to the public HTTP API
-- with `Authorization: Bearer cma_<32 hex>`. Only the SHA-256 hash of the raw
-- key is stored (raw key shown once at creation); lookup is hash → owner.
-- Additive — no existing table changes.

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_ownerId_idx" ON "ApiKey"("ownerId");
