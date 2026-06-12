-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicId" TEXT NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "appSlug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "verdict" TEXT,
    "appLens" TEXT,
    "anatomy" TEXT,
    "events" TEXT,
    "costUsd" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Journey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    CONSTRAINT "Journey_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Step" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journeyId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "observed" TEXT,
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
    CONSTRAINT "Finding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "sha256" TEXT,
    "stepId" TEXT,
    "findingId" TEXT,
    CONSTRAINT "Evidence_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Evidence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Run_publicId_key" ON "Run"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Run_runNumber_key" ON "Run"("runNumber");

-- CreateIndex
CREATE INDEX "Run_appSlug_idx" ON "Run"("appSlug");

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

