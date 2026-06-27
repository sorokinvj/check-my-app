-- DropIndex
DROP INDEX "Watch_appSlug_key";

-- CreateIndex
CREATE INDEX "Watch_appSlug_idx" ON "Watch"("appSlug");

