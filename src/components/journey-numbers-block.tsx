// The two numbers for one journey, side by side (CHE-240).
//
// The layout does the work the prose cannot: our estimate and their
// measurement are visually the same kind of thing — a labelled row — so a
// reader compares them, and every row carries its source so nobody has to
// remember which column meant what. A number without its source is the whole
// defect this component exists to prevent.
//
// All the sentences come from src/lib/journey-numbers.ts, which is pure and
// held to rule 1 by scripts/verify-journey-numbers.ts. Nothing here composes a
// customer-facing string of its own — a string written at the render layer is a
// string no check sees.

import {
  comparisonLine,
  completionOf,
  noMeasurementLine,
  ourLines,
  pagesLine,
  unfinishedLine,
  type JourneyPages,
  type NoMeasurement,
  type OurJudgement,
  type UnfinishedReason,
} from "@/lib/journey-numbers";
import { movementSentence, type Movement } from "@/lib/metric-movement";

export interface JourneyNumbersProps {
  ours: OurJudgement;
  /** The journey's own pages and how many people were on them (CHE-287). */
  pages: (JourneyPages & { windowDays: number }) | null;
  /** Did the walk reach the end of this journey? Gates every completion claim. */
  walkFinished: boolean;
  /** Why it did not, when it did not — one of these is ours to fix, one theirs. */
  unfinished: UnfinishedReason | null;
  /** A rise worth saying once, quietly, on the page (CHE-284). */
  rose: { movement: Movement; from: string; to: string } | null;
  /** The journey's name, for the movement sentence that names it. */
  title?: string;
  absent: NoMeasurement | null;
  sample?: number;
}

export function JourneyNumbersBlock({
  ours,
  pages,
  walkFinished,
  unfinished,
  rose,
  title,
  absent,
  sample,
}: JourneyNumbersProps) {
  const oursRows = ourLines(ours);
  const theirsRow = pages ? pagesLine(pages, pages.windowDays) : null;

  // CHE-283: the two numbers may only be compared when the walk actually
  // finished the journey. Otherwise the last page counted is where WE stopped,
  // not where the journey ends, and the difference between the two numbers is
  // an artefact — which is what CHE-279 removed and this restores under the
  // condition that makes it true.
  const completion = pages && walkFinished ? completionOf(pages, pages.windowDays) : null;
  const comparison = completion ? comparisonLine(ours, completion) : null;

  // Nothing judged and nothing measured: no block at all. An empty frame with
  // dashes in it reads as "we looked and found nothing", which is a claim.
  if (oursRows.length === 0 && !theirsRow && !absent) return null;

  return (
    <div className="mt-3 space-y-2 border-t border-ink-700/60 pt-3">
      <dl className="space-y-1.5">
        {oursRows.map((row) => (
          <Row key={row.label} label={row.label} value={row.value} source={row.source} tone="ours" />
        ))}
        {theirsRow && (
          <Row label={theirsRow.label} value={theirsRow.value} source={theirsRow.source} tone="measured" />
        )}
      </dl>

      {!theirsRow && absent && (
        <p className="text-xs text-fg-faint">{noMeasurementLine(absent, sample)}</p>
      )}

      {/* The sentence worth more than either number alone — and only where it is
          true. It exists only for a journey our walk finished, because only then
          is the last page counted the journey's end rather than the point where
          we stopped (CHE-283). Removed entirely in CHE-279 for want of that
          condition; restored with it. */}
      {comparison && <p className="text-xs text-fg-muted">{comparison}</p>}

      {/* Why there is no completion rate here, when the pages were counted but
          the journey was not finished (CHE-283). Shown only when there is no
          comparison to show instead — a reader who has the number does not need
          the reason it might have been missing. The database has known this all
          along (25 steps recorded `missing_access` in recent runs) and it
          reached no customer-facing surface until now. */}
      {!comparison && pages && !walkFinished && unfinished && (
        <p className="text-xs text-fg-faint">{unfinishedLine(unfinished)}</p>
      )}

      {/* Good news, said once and without a siren (CHE-284). The sentence has
          existed since CHE-241 and reached nobody: metricAlertsForRun keeps only
          falls, correctly — a rise must never break a quiet watch — so the
          "rose" branch was composed on every improving journey and thrown away.
          The page is where it belongs: the owner is already looking, and
          nothing is interrupted. */}
      {rose && title && (
        <p className="text-xs text-status-ok">
          {movementSentence(title, rose.movement, { from: rose.from, to: rose.to })}
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  source,
  tone,
}: {
  label: string;
  value: string;
  source: string;
  tone: "ours" | "measured";
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <dt className="w-32 shrink-0 text-xs text-fg-faint">{label}</dt>
      {/* The measured number is the one with evidence behind it, so it is the
          one that reads as solid. Ours is deliberately quieter — it is an
          opinion, and it should look like one next to a count. */}
      <dd className={tone === "measured" ? "font-medium text-fg" : "text-fg-muted"}>{value}</dd>
      <dd className="font-mono text-[11px] text-fg-faint">· {source}</dd>
    </div>
  );
}
