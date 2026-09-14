// Guards against the exact drift that sent feat/chrome-extension-targets
// (PR #81) through weeks of validation on claude-sonnet-4-6/claude-opus-4-8
// while production had moved nav/discovery to DeepSeek since 2026-09-05
// (CHE-168/169). Nothing caught it: .env.example still documented the old
// models, README.md repeated the claim, and src/agent/llm.ts's fallback
// logged nothing when it kicked in.
//
// src/agent/model-tier.recommended.json is now the single checked-in source
// for "what should a fresh environment default to" — this script is the CI
// gate that keeps the rest of the repo honest against it.
//
// Two checks, two different strengths, matching the two different failure
// modes:
//
//   1. .env.example vs the canonical file — HARD FAIL, always runs, no
//      credentials needed. There is no legitimate reason for these to ever
//      diverge; this is the check that would have caught the actual
//      incident before merge.
//
//   2. live production LlmUsage vs the canonical file — best-effort WARNING
//      only, via the same read-only `wrangler d1 execute --remote` pattern
//      scripts/measure/gate-ready-supply.ts uses. A deliberate spike
//      (COSTS.md's "DeepSeek nav spike" section) is a legitimate temporary
//      divergence, so this never fails the build — it just turns the manual
//      "read-only сверка" the owner had to do by hand into a routine,
//      automatic signal. Needs CLOUDFLARE_API_TOKEN; the CI job that runs
//      `verify:all` today does not have one, so this half prints SKIPPED
//      and exits clean rather than failing over a credential it was never
//      given. Run it locally (a checkout with .env, or the token exported)
//      to get the live signal.
//
// Usage:
//   node scripts/verify-model-config.mjs
//   node scripts/verify-model-config.mjs --local   # local D1 replica instead of prod

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const LOCAL = process.argv.includes("--local");

const TIER = JSON.parse(
  readFileSync(path.join(repoRoot, "src/agent/model-tier.recommended.json"), "utf8"),
);

// ─── Check 1: .env.example (hard fail) ────────────────────────────────────

const ENV_KEYS = {
  ANTHROPIC_NAV_MODEL: TIER.navModel,
  ANTHROPIC_SYNTH_MODEL: TIER.synthModel,
  ANTHROPIC_JUDGE_MODEL: TIER.judgeModel,
};

function checkEnvExample() {
  const envExamplePath = path.join(repoRoot, ".env.example");
  const text = readFileSync(envExamplePath, "utf8");
  const failures = [];
  for (const [key, expected] of Object.entries(ENV_KEYS)) {
    const line = text.split("\n").find((l) => l.trim().startsWith(`${key}=`));
    if (!line) continue; // not every key has to be documented; nothing to check
    const match = line.match(/=\s*"?([^"#]*)"?/);
    const actual = match ? match[1].trim() : "";
    if (actual !== expected) {
      failures.push(
        `  .env.example: ${key}="${actual}" but model-tier.recommended.json says "${expected}"`,
      );
    }
  }
  return failures;
}

// ─── Check 2: live production D1 (best-effort warning) ───────────────────

function d1(sql) {
  if (!/^\s*select\b/i.test(sql)) throw new Error("this script only reads");
  const argv = ["wrangler", "d1", "execute", "checkmyapp", LOCAL ? "--local" : "--remote", "--json", "--command", sql];
  const out = execFileSync("npx", argv, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const start = out.indexOf("[");
  if (start < 0) throw new Error(`no JSON in wrangler output: ${out.slice(0, 200)}`);
  const first = JSON.parse(out.slice(start))[0];
  if (!first || first.success === false) {
    throw new Error(`query failed: ${JSON.stringify(first).slice(0, 300)}`);
  }
  return first.results;
}

// phase -> which canonical field it should match
const PHASE_EXPECTATION = {
  discovery: "navModel",
  walking: "navModel",
  synthesis: "synthModel",
  judge: "judgeModel",
};

function checkLiveProd() {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.log("[verify-model-config] live-prod check: SKIPPED (no CLOUDFLARE_API_TOKEN)");
    return;
  }
  let rows;
  try {
    rows = d1(
      "SELECT phase, model, max(createdAt) AS latest FROM LlmUsage GROUP BY phase, model ORDER BY phase, latest DESC;",
    );
  } catch (err) {
    console.log(`[verify-model-config] live-prod check: SKIPPED (${err.message})`);
    return;
  }
  const latestByPhase = new Map();
  for (const row of rows) {
    const seen = latestByPhase.get(row.phase);
    if (!seen || row.latest > seen.latest) latestByPhase.set(row.phase, row);
  }
  console.log("[verify-model-config] live-prod check (informational, never fails the build):");
  for (const [phase, expectedField] of Object.entries(PHASE_EXPECTATION)) {
    const expected = TIER[expectedField];
    const actual = latestByPhase.get(phase);
    if (!actual) {
      console.log(`  ${phase}: no rows — nothing to compare`);
      continue;
    }
    const status = actual.model === expected ? "PASS" : "DIVERGED";
    console.log(
      `  ${phase}: ${status} — live "${actual.model}" (as of ${actual.latest}) vs recommended "${expected}"`,
    );
  }
}

const envFailures = checkEnvExample();
checkLiveProd();

if (envFailures.length > 0) {
  console.error("\n[verify-model-config] FAIL — .env.example has drifted from the recommended tier:");
  for (const f of envFailures) console.error(f);
  console.error(
    "\nUpdate .env.example (or model-tier.recommended.json if the recommendation itself changed) " +
      'and COSTS.md\'s "Recommended tier config" section together.',
  );
  process.exit(1);
}

console.log("[verify-model-config] PASS — .env.example matches model-tier.recommended.json");
