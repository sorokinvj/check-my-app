-- CHE-262 (Teams T9): who on the team gets told about this app.
--
-- Before teams, a verdict went to one address: whoever submitted the check. On
-- a team that means the person who happened to click, while the colleague who
-- is on call for that app hears nothing — and a reader, who joined precisely to
-- read what breaks, cannot subscribe at all.
--
-- No row for an app means "the team's admins", so this table is empty until
-- somebody chooses otherwise, and an app that nobody has configured still
-- reaches a human.
--
-- Re-runnable, like the migrations before it.

CREATE TABLE IF NOT EXISTS "AppNotifier" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "appId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppNotifier_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AppNotifier_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "AppNotifier_appId_userId_key" ON "AppNotifier"("appId", "userId");
CREATE INDEX IF NOT EXISTS "AppNotifier_appId_idx" ON "AppNotifier"("appId");
CREATE INDEX IF NOT EXISTS "AppNotifier_userId_idx" ON "AppNotifier"("userId");
