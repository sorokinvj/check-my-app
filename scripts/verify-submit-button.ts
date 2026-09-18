// CHE-108 verification: the submit button is not disabled in the server-rendered
// HTML, so a tap on a slow connection is never ignored.
//
// The button used to be disabled={!valid || submitting} where `valid` depends on
// client-side state that only React's onChange can update. Without JavaScript the
// button stayed disabled forever. This test checks that the source no longer
// includes a pattern that gates the disabled attribute on `valid`.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-submit-button.ts

import { readFileSync } from "fs";
import { join } from "path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const sourcePath = join(__dirname, "..", "src", "components", "submit-form.tsx");
const source = readFileSync(sourcePath, "utf-8");

// The button must not have a disabled prop that depends on `valid` (client-side only state).
// Only `submitting` (a transient state) should gate it.
const hasValidGatedDisabled = /disabled\s*=\s*\{!valid\b/.test(source);
check("Button disabled not gated on client-only valid state", !hasValidGatedDisabled);

// Also check the button element exists and has a disabled prop that is only `submitting`.
const match = source.match(/<Button[^>]*disabled\s*=\s*\{([^}]*)\}[^>]*>/);
if (match) {
  const disabledExpr = match[1];
  const onlySubmitting = /^submitting$/.test(disabledExpr);
  check("Button disabled prop only depends on submitting", onlySubmitting, `got: ${disabledExpr}`);
} else {
  check("Button with disabled prop found", false, "could not find Button with disabled attrib");
}

process.exit(failures > 0 ? 1 : 0);
