// One-off data fix for CHE-59: recompute IssueLink.dedupKey with the new
// machine-fact signature. Reads the link's first-seen run's findings, matches
// each link by its OLD key, prints the new key + SQL updates (merging links
// that now collapse to one signature — keep the earliest, drop the rest).
//
// Usage: npx tsx scripts/rekey-issuelinks.ts <links.json> <findings.json>
// where both files are `wrangler d1 execute … --json` dumps (see CHE-59 notes).

import { readFileSync } from "node:fs";
import { dedupKey, requestSignature } from "../src/lib/dedup";
import { dedupKeyForFinding } from "../src/lib/tracker/file";
import { parseJson } from "../src/lib/json";
import type { FindingDetail } from "../src/lib/types";

interface LinkRow {
  externalIssueId: string;
  dedupKey: string;
  firstSeenRunId: string;
}
interface FindingRow {
  runId: string;
  title: string;
  category: string;
  severity: string;
  detail: string | null;
}

const APP_SLUG = "joblander.app";

function oldKey(f: FindingRow): string {
  const detail = parseJson<FindingDetail>(f.detail) ?? {};
  return dedupKey({
    journeyTitle: detail.where ?? APP_SLUG,
    stepLabel: f.title,
    failureSignature: `${f.category}/${f.severity}`,
  });
}

const links: LinkRow[] = JSON.parse(readFileSync(process.argv[2], "utf8"))[0].results;
const findings: FindingRow[] = JSON.parse(readFileSync(process.argv[3], "utf8"))[0].results;

const seenNewKeys = new Map<string, string>(); // newKey -> externalIssueId that kept it
for (const link of links) {
  const source = findings.find((f) => f.runId === link.firstSeenRunId && oldKey(f) === link.dedupKey);
  if (!source) {
    console.log(`-- ${link.externalIssueId}: no finding matches old key, leaving as-is`);
    continue;
  }
  const detail = parseJson<FindingDetail>(source.detail) ?? {};
  const sig = requestSignature([detail.where, source.title, detail.whatHappened]);
  const newKey = dedupKeyForFinding(source, { appSlug: APP_SLUG });
  const holder = seenNewKeys.get(newKey);
  if (holder) {
    console.log(`-- ${link.externalIssueId} collapses into ${holder} (sig: ${sig}) — delete row`);
    console.log(`DELETE FROM IssueLink WHERE externalIssueId='${link.externalIssueId}';`);
  } else {
    seenNewKeys.set(newKey, link.externalIssueId);
    console.log(`-- ${link.externalIssueId}: sig=${sig ?? "(prose fallback)"} old=${link.dedupKey.slice(0, 8)} new=${newKey.slice(0, 8)}`);
    if (newKey !== link.dedupKey) {
      console.log(`UPDATE IssueLink SET dedupKey='${newKey}' WHERE externalIssueId='${link.externalIssueId}';`);
    }
  }
}
