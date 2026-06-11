// CHE-8 replay engine: run the agent-generated Playwright specs for an app
// deterministically and record pass/fail back onto GeneratedTest rows.
// This is the cheap half of Daily Watch — the LLM only investigates failures.
//
//   npm run replay -- localhost:3000
//   npm run replay -- joblander.app https://joblander.app

import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function fsSafeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-|-$/g, "");
}

interface PlaywrightJsonReport {
  suites?: Array<PlaywrightSuite>;
}
interface PlaywrightSuite {
  title: string; // file path relative to testDir
  suites?: PlaywrightSuite[];
  specs?: Array<{
    title: string;
    ok: boolean;
    file?: string;
  }>;
}

async function main() {
  const appSlug = process.argv[2];
  if (!appSlug) {
    console.error("Usage: npm run replay -- <app-slug> [target-url]");
    process.exit(1);
  }
  const target = process.argv[3] ?? `https://${appSlug}`;
  const dir = path.join("generated-tests", fsSafeSlug(appSlug));

  try {
    await fs.access(dir);
  } catch {
    console.error(`No generated specs at ${dir} — run a check first.`);
    process.exit(1);
  }

  console.log(`Replaying specs in ${dir} against ${target}`);
  const exitCode = await runPlaywright(dir, target);

  // Map spec files → pass/fail from the JSON report.
  const fileStatus = new Map<string, boolean>();
  try {
    const raw = await fs.readFile("test-results/generated-report.json", "utf8");
    const report = JSON.parse(raw) as PlaywrightJsonReport;
    collectFileStatus(report.suites ?? [], fileStatus);
  } catch (err) {
    console.error("Could not read the Playwright JSON report:", err);
  }

  // Update GeneratedTest rows (match by slugified title ↔ spec filename).
  const tests = await prisma.generatedTest.findMany({ where: { appSlug } });
  const now = new Date();
  for (const test of tests) {
    const fileSlug =
      test.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".spec.ts";
    const passed = [...fileStatus.entries()].find(([file]) => file.endsWith(fileSlug))?.[1];
    if (passed === undefined) continue;
    await prisma.generatedTest.update({
      where: { id: test.id },
      data: { lastRunStatus: passed ? "passed" : "failed", lastRunAt: now },
    });
    console.log(`  ${passed ? "✓ passed" : "✗ FAILED"}  ${test.title}`);
  }

  process.exit(exitCode === 0 ? 0 : 1);
}

function collectFileStatus(suites: PlaywrightSuite[], out: Map<string, boolean>) {
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.title;
      out.set(file, (out.get(file) ?? true) && spec.ok);
    }
    collectFileStatus(suite.suites ?? [], out);
  }
}

function runPlaywright(dir: string, target: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      "npx",
      ["playwright", "test", "--config", "playwright.generated.config.ts", dir],
      {
        stdio: "inherit",
        env: { ...process.env, TARGET_URL: target },
      },
    );
    child.on("close", (code) => resolve(code ?? 1));
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
