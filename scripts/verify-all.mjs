// The acceptance registry, discovered by mask (CHE-183).
//
// The registry used to be a hand-kept list: one `verify:*` line in package.json
// and one `- run:` step in ci.yml per script. Every new script added a line at
// the same spot in both files, so every merge conflicted every open PR — on
// 2026-09-05 two sessions merging in parallel spent the day rebasing each other
// (#40 → #41/#42/#43; #38/#39 → #40/#43). This runner replaces the list: the
// registry is the set of files matching scripts/verify-*.{ts,mjs}, and a new
// script is picked up here and in CI without touching either file.
//
// Nothing is skipped silently. A script that exits non-zero, runs past the
// per-script timeout, or cannot be started (its runner is missing) is a FAIL,
// and one FAIL fails the whole run. `--only` narrowing to zero scripts is also a
// failure — a green run that ran nothing is the lie this file exists to prevent.
//
//   node scripts/verify-all.mjs               run every script, summary at the end
//   node scripts/verify-all.mjs --list        print the discovered files, exit 0
//   node scripts/verify-all.mjs --fail-fast   stop at the first FAIL
//   node scripts/verify-all.mjs --only smoke  run only files whose name contains "smoke"
//
// Plain Node, no dependencies: this must run before `npm ci` can be blamed.

import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// This file matches its own mask; excluded by name so it cannot run itself.
const SELF = "verify-all.mjs";
const MASK = /^verify-.*\.(ts|mjs)$/;
const PER_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");

function parseArgs(argv) {
  const opts = { list: false, failFast: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") opts.list = true;
    else if (a === "--fail-fast") opts.failFast = true;
    else if (a === "--only") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) usage(`--only needs a substring`);
      opts.only = v;
    } else if (a.startsWith("--only=")) opts.only = a.slice("--only=".length);
    else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument: ${a}`);
  }
  return opts;
}

function usage(error) {
  const text =
    "usage: node scripts/verify-all.mjs [--list] [--fail-fast] [--only <substring>]";
  if (error) {
    console.error(`verify-all: ${error}\n${text}`);
    process.exit(2);
  }
  console.log(text);
  process.exit(0);
}

// Sorted by code point so the order is the same on every machine and in CI.
function discover(only) {
  const all = readdirSync(scriptsDir)
    .filter((f) => MASK.test(f) && f !== SELF)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return only ? all.filter((f) => f.includes(only)) : all;
}

// .ts goes through tsx with the web tsconfig, exactly as the hand-written
// `verify:*` entries did; .mjs is plain Node. Anything else that ever matches
// the mask has no runner and is reported as a FAIL, never skipped.
function runnerFor(file) {
  if (file.endsWith(".ts")) {
    return { cmd: "npx", args: ["tsx", "--tsconfig", "tsconfig.json", `scripts/${file}`] };
  }
  if (file.endsWith(".mjs")) {
    return { cmd: process.execPath, args: [`scripts/${file}`] };
  }
  return null;
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (ok, reason) =>
      resolve({ file, ok, reason, seconds: (Date.now() - started) / 1000 });

    const runner = runnerFor(file);
    if (!runner) return done(false, "no runner for this extension");

    // Output is inherited so the script streams as it runs; nothing is buffered
    // or reformatted, and a hang is visible while it hangs.
    const child = spawn(runner.cmd, runner.args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, PER_SCRIPT_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      done(false, `could not start ${runner.cmd}: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return done(false, `timed out after ${PER_SCRIPT_TIMEOUT_MS / 60000} min`);
      if (signal) return done(false, `killed by ${signal}`);
      if (code !== 0) return done(false, `exit code ${code}`);
      done(true, null);
    });
  });
}

function printSummary(results, notRun) {
  const width = Math.max(...results.map((r) => r.file.length), ...notRun.map((f) => f.length), 4);
  const line = (a, b, c) => `${a.padEnd(width)}  ${b.padEnd(7)}  ${c}`;
  console.log("");
  console.log("verify-all summary");
  console.log(line("file", "result", "seconds"));
  console.log(line("-".repeat(width), "-".repeat(7), "-------"));
  for (const r of results) {
    const tail = r.ok ? "" : `   (${r.reason})`;
    console.log(line(r.file, r.ok ? "PASS" : "FAIL", r.seconds.toFixed(1).padStart(7)) + tail);
  }
  for (const f of notRun) console.log(line(f, "NOT RUN", "      -") + "   (stopped by --fail-fast)");
  const failed = results.filter((r) => !r.ok).length;
  const passed = results.length - failed;
  console.log("");
  console.log(
    `verify-all: ${passed} passed, ${failed} failed, ${notRun.length} not run, ${results.length + notRun.length} total`,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = discover(opts.only);

  if (opts.list) {
    console.log(`verify-all: ${files.length} scripts${opts.only ? ` matching "${opts.only}"` : ""}`);
    for (const f of files) console.log(f);
    process.exit(0);
  }

  if (files.length === 0) {
    console.error(
      opts.only
        ? `verify-all: no script matches "${opts.only}" — nothing ran, which is not a pass`
        : `verify-all: no scripts/verify-*.{ts,mjs} found — nothing ran, which is not a pass`,
    );
    process.exit(1);
  }

  console.log(`verify-all: ${files.length} scripts${opts.only ? ` matching "${opts.only}"` : ""}`);

  const results = [];
  const notRun = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`\n▶ [${i + 1}/${files.length}] ${file}`);
    const r = await runOne(file);
    results.push(r);
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${file} (${r.seconds.toFixed(1)}s)${r.ok ? "" : ` — ${r.reason}`}`);
    if (!r.ok && opts.failFast) {
      notRun.push(...files.slice(i + 1));
      break;
    }
  }

  printSummary(results, notRun);
  process.exit(results.some((r) => !r.ok) || notRun.length > 0 ? 1 : 0);
}

main();
