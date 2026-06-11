import { defineConfig } from "@playwright/test";

// Config for AGENT-GENERATED specs (CHE-8), not for our own test suite.
// Specs live in generated-tests/{app-slug}/ and use process.env.TARGET_URL.
// Run via: npm run replay -- <app-slug> [target-url]
export default defineConfig({
  testDir: "./generated-tests",
  timeout: 30_000,
  retries: 0,
  workers: 2,
  reporter: [["json", { outputFile: "test-results/generated-report.json" }]],
  use: {
    baseURL: process.env.TARGET_URL ?? "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
