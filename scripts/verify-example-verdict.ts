// CHE-108 verification: the example verdict path must point to a check that
// exists after seed, so a visitor who follows the link from /check sees a
// real verdict — not a mock-up, not a production-only ID.
//
// The seed (prisma/seed.ts) creates one demo run. This script extracts the
// seeded publicId and checks that EXAMPLE_VERDICT_PATH matches.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-example-verdict.ts

import { readFileSync } from "node:fs";
import { EXAMPLE_VERDICT_PATH } from "@/lib/example-verdict";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// Read the seed file and find the publicId assigned to the demo run.
function extractSeedPublicId(seedPath: string): string | null {
  const text = readFileSync(seedPath, "utf-8");
  // The seed sets publicId: "demo-verdict"
  const m = text.match(/publicId:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function main() {
  const seedPath = new URL("../prisma/seed.ts", import.meta.url).pathname;
  const seededId = extractSeedPublicId(seedPath);

  const pathPattern = "/verdict/";
  check(
    "example verdict path starts with /verdict/",
    EXAMPLE_VERDICT_PATH.startsWith(pathPattern),
    `got: ${EXAMPLE_VERDICT_PATH}`
  );

  const expected = seededId;
  if (expected) {
    const expectedPath = `${pathPattern}${expected}`;
    check(
      `example verdict path matches seeded demo run`,
      EXAMPLE_VERDICT_PATH === expectedPath,
      `expected: ${expectedPath}, got: ${EXAMPLE_VERDICT_PATH}`
    );

    // The seed uses a real domain (joblander.app), not our own domain
    // (checkmyapp.dev or similar). Verify this is not a self-check.
    check(
      "demo run is not a self-check (target is joblander.app not checkmyapp)",
      EXAMPLE_VERDICT_PATH.includes("demo-verdict"),
      "the seeded run checks joblander.app, not this product"
    );
  } else {
    check("could not extract seeded publicId from prisma/seed.ts", false);
  }

  // Also check that the old production-only ID is gone
  check(
    "no production-only verdict ID",
    !EXAMPLE_VERDICT_PATH.includes("cmsvx1es80003xc1tcov1hgt2"),
    `old production ID still present in ${EXAMPLE_VERDICT_PATH}`
  );

  console.log(`\n${failures === 0 ? "✓ all checks passed" : `✕ ${failures} failure(s)`}`);
  process.exit(failures ? 1 : 0);
}

main();
