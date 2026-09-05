// CHE-99 verification: replay classifyCheckerDefect over the rejections we
// already have on record, with no writes and no tracker calls.
//
// Ground truth: JOB-904 (run #50, "Sign in button did not respond…") and CHE-79
// (run #79, Clerk modal) are the two tickets a human ruled not-a-bug. This runs
// the real exported classifier against the real findings behind them.
//
// Usage: npx tsx scripts/replay-defect-class.ts <links.json> <findings.json> <steps.json>
// where each file is a `wrangler d1 execute … --json` results array.
//
// Named replay-, not verify-: it needs D1 exports as arguments, so it is a
// replay tool, not an acceptance check. Since CHE-183 the acceptance registry
// is every scripts/verify-*.{ts,mjs}, run by `npm run verify:all` and CI with
// no arguments — a file under that mask that cannot run standalone fails CI.

import { readFileSync } from "node:fs";
import { dedupKeyForFinding } from "../src/lib/tracker/file";
import { classifyCheckerDefect } from "../src/agent/capability-gaps";
import { parseJson } from "../src/lib/json";
import type { FindingDetail } from "../src/lib/types";
import type { AgentEnv } from "../src/agent/env";

interface LinkRow {
  externalIssueId: string;
  dedupKey: string;
  firstSeenRunId: string;
  appSlug: string;
  runNumber: number;
}
interface FindingRow {
  runId: string;
  title: string;
  category: string;
  severity: string;
  detail: string | null;
}
interface StepRow {
  runId: string;
  journeyTitle: string;
  unverifiedReason: string | null;
}

const [linksPath, findingsPath, stepsPath] = process.argv.slice(2);
const links: LinkRow[] = JSON.parse(readFileSync(linksPath, "utf8"));
const findings: FindingRow[] = JSON.parse(readFileSync(findingsPath, "utf8"));
const steps: StepRow[] = JSON.parse(readFileSync(stepsPath, "utf8"));

// The only database call the classifier makes, served from the dump.
const env = {
  db: {
    step: {
      count: async (args: {
        where: {
          unverifiedReason: string;
          journey: { runId: string; title?: string };
        };
      }) =>
        steps.filter(
          (s) =>
            s.unverifiedReason === args.where.unverifiedReason &&
            s.runId === args.where.journey.runId &&
            (!args.where.journey.title || s.journeyTitle === args.where.journey.title),
        ).length,
    },
  },
} as unknown as AgentEnv;

async function main() {
for (const link of links) {
  const original =
    findings
      .filter((f) => f.runId === link.firstSeenRunId)
      .find((f) => dedupKeyForFinding(f, { appSlug: link.appSlug }) === link.dedupKey) ?? null;

  const detail = parseJson<FindingDetail>(original?.detail ?? null);
  const cls = await classifyCheckerDefect(env, {
    originRunId: link.firstSeenRunId,
    journeyTitle: detail?.where ?? null,
    claimText: [original?.title, detail?.whatHappened].filter(Boolean).join(" "),
  });

  console.log(`\n${link.externalIssueId}  (${link.appSlug}, run #${link.runNumber})`);
  console.log(`  claimed : ${original?.title ?? "(finding not recoverable from the dedup key)"}`);
  console.log(`  journey : ${detail?.where ?? "—"}`);
  console.log(`  class   : ${cls ?? "null (unclassified — needs a person)"}`);
}
}

main();
