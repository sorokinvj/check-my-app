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
  measuredLine,
  noMeasurementLine,
  ourLines,
  type NoMeasurement,
  type OurJudgement,
  type TheirMeasurement,
} from "@/lib/journey-numbers";

export interface JourneyNumbersProps {
  ours: OurJudgement;
  theirs: TheirMeasurement | null;
  absent: NoMeasurement | null;
  sample?: number;
}

export function JourneyNumbersBlock({ ours, theirs, absent, sample }: JourneyNumbersProps) {
  const oursRows = ourLines(ours);
  const theirsRow = theirs ? measuredLine(theirs) : null;

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

      {/* There was a sentence here drawing the two numbers together, and it is
          gone on purpose (CHE-279): our estimate counts people who set out to do
          the journey, the measurement counts people who reached one page of it,
          and the difference between them is an artefact of the two denominators
          rather than news about the product. The rows stay, each with its
          source, and the reader is not handed a conclusion we cannot support. */}
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
