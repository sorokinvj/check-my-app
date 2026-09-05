// verify-demo-verdict: the home page must link to a real demo verdict
// so a visitor who gives nothing can read a real verdict end to end.
// CHE-108

import { readFileSync } from "node:fs";

const page = readFileSync("src/app/page.tsx", "utf8");

if (!page.includes("/verdict/demo-verdict")) {
  console.error("FAIL: Home page does not link to /verdict/demo-verdict");
  process.exit(1);
}

console.log("PASS: Home page links to demo verdict");
