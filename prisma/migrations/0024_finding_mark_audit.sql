-- Track who set a finding mark and when (CHE-109).
-- Null markedById = automated/agent; null markedAt = never marked.
ALTER TABLE "Finding" ADD COLUMN "markedById" TEXT;
ALTER TABLE "Finding" ADD COLUMN "markedAt" DATETIME;
