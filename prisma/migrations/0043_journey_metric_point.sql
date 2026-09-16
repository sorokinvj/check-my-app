-- CHE-239: what the customer's own analytics say happened on a journey.
--
-- A TIME SERIES, not a current value. One point per run, so "conversion fell
-- from 31% to 12% over three weeks" is a question the data can answer — a
-- single mutable column can only ever say what today looks like, and by the
-- time anyone asks why, the before is gone.
--
-- ── Why this is a separate table and not a column on AppJourney ─────────────
--
-- AppJourney.conversion (CHE-235) is OUR opinion, formed by walking the journey
-- and judging it. This is THEIR measurement, counted from their traffic. The
-- two must never share a column, and the ticket says so in as many words.
-- A number whose provenance is ambiguous is worse than either number alone:
-- nobody can tell whether "12%" is something we decided or something that
-- happened, and the honest answer changes what you do about it.
--
-- `conversion` is NULL when we counted and there was not enough traffic to
-- measure. That is a real answer and it has a row: `sampleSize` still says how
-- many people we saw, so "not enough traffic" is a fact with a number behind it
-- rather than a shrug. A run where the query FAILED writes no row at all — an
-- absent point and a measured-but-too-small point are different things and must
-- not look the same.
--
-- `steps` is the per-stage counts as JSON, in funnel order, so the drop-off is
-- readable without re-querying: [{"stage":"/check","count":25}, …]. Counts
-- only. No person, no property value, no identifier belonging to one of the
-- customer's users is read or stored, here or anywhere in this path.
--
-- `source` is "posthog" today and exists so a second analytics provider does
-- not require a migration to tell its numbers apart from PostHog's.

CREATE TABLE "JourneyMetricPoint" (
  "id"            TEXT PRIMARY KEY NOT NULL,
  "appJourneyId"  TEXT NOT NULL,
  -- The run that asked. Null-safe: a point outlives the run row it came from.
  "runId"         TEXT,
  "measuredAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- How far back the question looked. Stored per point because changing the
  -- window changes the question, and a series that silently mixes 14-day and
  -- 30-day numbers is a trend line about nothing.
  "windowDays"    INTEGER NOT NULL,
  -- 0-100, or NULL when the sample was below the floor.
  "conversion"    INTEGER,
  -- People who reached the first stage. Always present: it is what makes the
  -- line above either trustworthy or absent.
  "sampleSize"    INTEGER NOT NULL,
  -- Per-stage counts in funnel order, as JSON. Counts only.
  "steps"         TEXT,
  "source"        TEXT NOT NULL DEFAULT 'posthog',
  "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JourneyMetricPoint_appJourneyId_fkey" FOREIGN KEY ("appJourneyId")
    REFERENCES "AppJourney" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The one question this table is asked: this journey's points, newest first.
CREATE INDEX "JourneyMetricPoint_appJourneyId_measuredAt_idx"
  ON "JourneyMetricPoint" ("appJourneyId", "measuredAt");
