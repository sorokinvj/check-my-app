// CHE-108 verification: the submit button rendered in SSR must NOT be disabled
// based on `!valid` (which is always false until JS hydration). This ensures
// a user on a slow connection sees an active control from the first paint and
// a tap during the JS-loading window is not lost.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-submit-ssr.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ---- Test: submit button's disabled prop must not include !valid ----
// The SSR-rendered button should be enabled on first paint. If the disabled
// prop references `!valid` that means the button is disabled in the initial
// HTML (valid is false before hydration), making it unresponsive to taps on
// slow connections.
const source = readFileSync(resolve("src/components/submit-form.tsx"), "utf-8");

// Find the Button's disabled prop
const buttonDisabledMatch = source.match(/disabled\s*=\s*\{([^}]+)\}/g);
const targetDisabled = buttonDisabledMatch?.find(d => d.includes("Button") || d.includes("submit"));
// We want the one on the Button component
const disabledLineMatch = source.match(/<Button[^>]*disabled=\{([^}]+)\}/);
if (!disabledLineMatch) {
  check("submit Button has a disabled prop", false, "Could not find disabled= on <Button>");
} else {
  const disabledExpr = disabledLineMatch[1];
  check(
    "submit button disabled prop does NOT reference !valid",
    !/!valid/.test(disabledExpr),
    `disabled={${disabledExpr}}`
  );
}

if (failures > 0) {
  console.error(`\n✗ ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("\n✓ all checks passed");
}
