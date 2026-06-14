-- CreateTable
CREATE TABLE "Run" (
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
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Run_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "Watch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Journey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "videoUrl" TEXT,
    CONSTRAINT "Journey_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Step" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journeyId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "screenshotUrl" TEXT,
    "attempted" TEXT,
    "observed" TEXT,
    "consoleLog" TEXT,
    "networkLog" TEXT,
    CONSTRAINT "Step_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "detail" TEXT,
    "mark" TEXT NOT NULL DEFAULT 'none',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Finding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "sha256" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stepId" TEXT,
    "findingId" TEXT,
    CONSTRAINT "Evidence_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Evidence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GeneratedTest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appSlug" TEXT NOT NULL,
    "journeyId" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastRunStatus" TEXT NOT NULL DEFAULT 'never_run',
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Watch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appSlug" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnChangeOnly" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmail" TEXT,
    "testEmail" TEXT,
    "testPasswordEnc" TEXT,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Counter" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "value" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "Run_publicId_key" ON "Run"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Run_runNumber_key" ON "Run"("runNumber");

-- CreateIndex
CREATE INDEX "Run_appSlug_idx" ON "Run"("appSlug");

-- CreateIndex
CREATE INDEX "Run_watchId_idx" ON "Run"("watchId");

-- CreateIndex
CREATE INDEX "Journey_runId_idx" ON "Journey"("runId");

-- CreateIndex
CREATE INDEX "Step_journeyId_idx" ON "Step"("journeyId");

-- CreateIndex
CREATE INDEX "Finding_runId_idx" ON "Finding"("runId");

-- CreateIndex
CREATE INDEX "Evidence_stepId_idx" ON "Evidence"("stepId");

-- CreateIndex
CREATE INDEX "Evidence_findingId_idx" ON "Evidence"("findingId");

-- CreateIndex
CREATE INDEX "GeneratedTest_appSlug_idx" ON "GeneratedTest"("appSlug");

-- CreateIndex
CREATE UNIQUE INDEX "Watch_appSlug_key" ON "Watch"("appSlug");

