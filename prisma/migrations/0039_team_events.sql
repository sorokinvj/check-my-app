-- CHE-264 (Teams T11): who changed membership, billing or credentials.
--
-- With one owner, "why is the watch paused" was answerable by memory. With five
-- people it is not, and rule 8 names that class by its own name: bookkeeping,
-- losing track of what we had done or been told. There is a precedent — a
-- paused watch came back to life because an agent pressed resume while
-- exploring (CHE-89, CHE-98).
--
-- Re-runnable, like the migrations before it.

CREATE TABLE IF NOT EXISTS "TeamEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "teamId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "action" TEXT NOT NULL,
  "subject" TEXT,
  "summary" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TeamEvent_teamId_createdAt_idx" ON "TeamEvent"("teamId", "createdAt");
