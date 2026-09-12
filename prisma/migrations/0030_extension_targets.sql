ALTER TABLE "App" ADD COLUMN "targetKind" TEXT NOT NULL DEFAULT 'website';
ALTER TABLE "App" ADD COLUMN "extensionId" TEXT;
ALTER TABLE "App" ADD COLUMN "extensionConfig" TEXT;
ALTER TABLE "Run" ADD COLUMN "targetKind" TEXT NOT NULL DEFAULT 'website';
ALTER TABLE "Run" ADD COLUMN "extensionId" TEXT;
ALTER TABLE "Run" ADD COLUMN "extensionConfig" TEXT;
ALTER TABLE "Run" ADD COLUMN "extensionEvidence" TEXT;
ALTER TABLE "PendingCheck" ADD COLUMN "extensionConfig" TEXT;
