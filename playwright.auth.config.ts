import { defineConfig } from "@playwright/test";
import * as dotenv from "dotenv";

// Config for the auth dogfood suite (CHE-35) — separate from the agent-generated
// specs. Loads .env for Clerk keys + E2E test-user creds.
dotenv.config();

export default defineConfig({
  testDir: "./e2e/auth",
  globalSetup: "./e2e/auth/global-setup.ts",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.TARGET_URL ?? "http://localhost:3000",
    screenshot: "only-on-failure",
  },
});
