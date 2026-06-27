-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clerkUserId" TEXT NOT NULL,
    "clerkOrgId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'requester',
    "plan" TEXT NOT NULL DEFAULT 'free',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "App" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "orgId" TEXT,
    "targetUrl" TEXT NOT NULL,
    "appSlug" TEXT NOT NULL,
    "testEmail" TEXT,
    "testPasswordEnc" TEXT,
    "scopeHints" TEXT,
    "userNotes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "App_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackerIntegration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'linear',
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" DATETIME,
    "teamId" TEXT,
    "externalOrg" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrackerIntegration_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TicketPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "pickupLabels" TEXT NOT NULL DEFAULT '[]',
    "repoLabel" TEXT,
    "provenanceLabel" TEXT NOT NULL DEFAULT 'checkmyapp',
    "state" TEXT NOT NULL DEFAULT 'Backlog',
    "priorityRule" TEXT NOT NULL DEFAULT '{}',
    "titleFormat" TEXT NOT NULL DEFAULT '[Monitor] {verdict}',
    "escalateAfterRuns" INTEGER NOT NULL DEFAULT 3,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TicketPolicy_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IssueLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "externalIssueId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "escalatedAt" DATETIME,
    "firstSeenRunId" TEXT,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IssueLink_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicId" TEXT NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "appSlug" TEXT NOT NULL,
    "testEmail" TEXT,
    "testPasswordEnc" TEXT,
    "scopeHints" TEXT,
    "userNotes" TEXT,
    "notifyEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "verdict" TEXT,
    "bottomLine" TEXT,
    "appLens" TEXT,
    "lensFeedback" TEXT,
    "anatomy" TEXT,
    "events" TEXT,
    "currentAction" TEXT,
    "liveScreenshotUrl" TEXT,
    "errorMessage" TEXT,
    "transcriptUrl" TEXT,
    "costUsd" REAL,
    "watchId" TEXT,
    "baselineRunId" TEXT,
    "appId" TEXT,
    "ownerId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Run_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "Watch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Run_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Run_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Run" ("anatomy", "appLens", "appSlug", "baselineRunId", "bottomLine", "completedAt", "costUsd", "createdAt", "currentAction", "errorMessage", "events", "id", "lensFeedback", "liveScreenshotUrl", "notifyEmail", "publicId", "runNumber", "scopeHints", "startedAt", "status", "targetUrl", "testEmail", "testPasswordEnc", "transcriptUrl", "updatedAt", "userNotes", "verdict", "watchId") SELECT "anatomy", "appLens", "appSlug", "baselineRunId", "bottomLine", "completedAt", "costUsd", "createdAt", "currentAction", "errorMessage", "events", "id", "lensFeedback", "liveScreenshotUrl", "notifyEmail", "publicId", "runNumber", "scopeHints", "startedAt", "status", "targetUrl", "testEmail", "testPasswordEnc", "transcriptUrl", "updatedAt", "userNotes", "verdict", "watchId" FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
CREATE UNIQUE INDEX "Run_publicId_key" ON "Run"("publicId");
CREATE UNIQUE INDEX "Run_runNumber_key" ON "Run"("runNumber");
CREATE INDEX "Run_appSlug_idx" ON "Run"("appSlug");
CREATE INDEX "Run_watchId_idx" ON "Run"("watchId");
CREATE INDEX "Run_appId_idx" ON "Run"("appId");
CREATE INDEX "Run_ownerId_idx" ON "Run"("ownerId");
CREATE TABLE "new_Watch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appSlug" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnChangeOnly" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmail" TEXT,
    "testEmail" TEXT,
    "testPasswordEnc" TEXT,
    "appId" TEXT,
    "ownerId" TEXT,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Watch_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Watch_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Watch" ("active", "appSlug", "createdAt", "frequency", "id", "lastRunAt", "nextRunAt", "notifyEmail", "notifyOnChangeOnly", "targetUrl", "testEmail", "testPasswordEnc", "updatedAt") SELECT "active", "appSlug", "createdAt", "frequency", "id", "lastRunAt", "nextRunAt", "notifyEmail", "notifyOnChangeOnly", "targetUrl", "testEmail", "testPasswordEnc", "updatedAt" FROM "Watch";
DROP TABLE "Watch";
ALTER TABLE "new_Watch" RENAME TO "Watch";
CREATE UNIQUE INDEX "Watch_appSlug_key" ON "Watch"("appSlug");
CREATE UNIQUE INDEX "Watch_appId_key" ON "Watch"("appId");
CREATE INDEX "Watch_ownerId_idx" ON "Watch"("ownerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkUserId_key" ON "User"("clerkUserId");

-- CreateIndex
CREATE INDEX "User_clerkOrgId_idx" ON "User"("clerkOrgId");

-- CreateIndex
CREATE INDEX "App_ownerId_idx" ON "App"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "App_ownerId_appSlug_key" ON "App"("ownerId", "appSlug");

-- CreateIndex
CREATE UNIQUE INDEX "TrackerIntegration_appId_key" ON "TrackerIntegration"("appId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketPolicy_appId_key" ON "TicketPolicy"("appId");

-- CreateIndex
CREATE INDEX "IssueLink_appId_idx" ON "IssueLink"("appId");

-- CreateIndex
CREATE UNIQUE INDEX "IssueLink_appId_dedupKey_key" ON "IssueLink"("appId", "dedupKey");

