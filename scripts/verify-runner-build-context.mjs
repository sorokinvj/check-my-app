// Everything the executor imports has to be inside the image (CHE-233).
//
// extension-runner/.dockerignore is an allowlist — `*` followed by one `!name`
// per file — so a new module is excluded by default and nothing says so. On
// 2026-09-14 progress.mjs was added and imported from joblander-account.mjs
// but never listed: every image built afterwards carried the importer without
// the imported file, node died on ERR_MODULE_NOT_FOUND before printing a line,
// and from the outside six runs read as "the container is not running". The
// executor looked broken, the extension looked broken, and neither was.
//
// A missing file cannot be noticed by a test that runs in the repository,
// where every module is present. So the check is on the build context itself:
// walk the import graph from the entrypoints the Dockerfile actually runs, and
// require every file it reaches to survive .dockerignore.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runnerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension-runner");
const fail = (message) => { console.error(`verify-runner-build-context: ${message}`); process.exitCode = 1; };

// The Dockerfile's own entrypoints: CMD runs server.mjs, and a build step runs
// build-stimuli.mjs. Read them from the file so a changed CMD is not missed.
const dockerfile = readFileSync(path.join(runnerDir, "Dockerfile"), "utf8");
const entrypoints = ["server.mjs", "build-stimuli.mjs"].filter((name) => dockerfile.includes(name));
if (entrypoints.length !== 2) fail(`the Dockerfile no longer runs ${["server.mjs", "build-stimuli.mjs"].filter(n => !entrypoints.includes(n)).join(", ")} — this check is looking at the wrong entrypoints`);

// .dockerignore: `*` excludes everything, each `!name` brings one path back.
const ignore = readFileSync(path.join(runnerDir, ".dockerignore"), "utf8")
  .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
if (ignore[0] !== "*") fail(`.dockerignore no longer starts with "*" — the allowlist assumption behind this check is gone`);
const allowed = new Set(ignore.filter((line) => line.startsWith("!")).map((line) => line.slice(1).replace(/\/(\*\*)?$/, "")));

// Walk the local import graph. Only relative specifiers matter: a bare package
// name comes from npm ci inside the image, not from the build context.
const seen = new Set();
const queue = [...entrypoints];
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  const full = path.join(runnerDir, file);
  if (!existsSync(full)) { fail(`${file} is imported but does not exist`); continue; }
  for (const match of readFileSync(full, "utf8").matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"](\.[^'"]+)['"]/g)) {
    queue.push(path.normalize(path.join(path.dirname(file), match[1])));
  }
  for (const match of readFileSync(full, "utf8").matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    queue.push(path.normalize(path.join(path.dirname(file), match[1])));
  }
}

for (const file of [...seen].sort()) {
  if (!allowed.has(file)) fail(`${file} is reachable from the executor's entrypoint but .dockerignore leaves it out of the image — add "!${file}"`);
}

// A stale entry is the same lie in the other direction: it reads as if a file
// were shipped when there is nothing to ship.
for (const entry of allowed) {
  if (!existsSync(path.join(runnerDir, entry))) fail(`.dockerignore lists "${entry}", which does not exist`);
}

// Every module beside the graph is either dead code or an unlisted import we
// failed to parse. Saying so keeps the check honest as the executor grows.
const orphans = readdirSync(runnerDir).filter((name) => name.endsWith(".mjs") && !seen.has(name));
if (orphans.length) console.log(`verify-runner-build-context: not reachable from an entrypoint (fine if intentional): ${orphans.join(", ")}`);

if (!process.exitCode) console.log(`verify-runner-build-context: ok — ${seen.size} executor modules, all inside the image`);
