import { test, expect, type APIResponse } from "@playwright/test";
import { createCheckSchema } from "../../src/lib/validation";

// Dogfood: deploy identity on POST /api/checks (CHE-56).
//
// Deliberately NOT an end-to-end submit. A POST that parses cleanly starts a
// real agent run and bills for it, and there is no cancel API — so the run-
// creating path stays covered by quotas.spec.ts (one url, one known cost) and
// this spec proves the new field two cheaper ways:
//
//   1. over HTTP, that the route accepts a request carrying `deploy` at all
//      (the only complaint left is the invalid url, and no run is created);
//   2. against createCheckSchema directly, that the sha rules are what CI will
//      actually meet — short shas and build ids in, junk out.
//
// Turnstile runs BEFORE the schema on this route, so on a target with
// TURNSTILE_SECRET set an anonymous POST answers 403 and never reaches the
// parser. The HTTP test skips there rather than reporting a validation result
// it did not observe.
const BASE = process.env.TARGET_URL ?? "http://localhost:3000";

const BAD_URL = "not a url";
const SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

test("a submit carrying `deploy` reaches the schema and dies on the url — no run created", async ({
  request,
}) => {
  const res: APIResponse = await request.post(`${BASE}/api/checks`, {
    data: { url: BAD_URL, deploy: { sha: SHA, env: "production" } },
  });
  test.skip(res.status() === 403, "Turnstile enforced on this target — API submit not walkable");

  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error?: unknown };
  expect(typeof body.error).toBe("string");
  // The url is the first field in the schema, so it owns the reported issue —
  // what matters is that a well-formed `deploy` did not add one of its own.
  expect(body.error as string).toMatch(/URL/i);
});

test("schema: a valid deploy identity survives parsing", () => {
  const parsed = createCheckSchema.safeParse({
    url: "https://example.com",
    deploy: { sha: SHA, env: "production" },
  });
  expect(parsed.success).toBe(true);
  expect(parsed.success && parsed.data.deploy).toEqual({ sha: SHA, env: "production" });
});

test("schema: shas CI actually produces are accepted", () => {
  // A short sha, a tag-shaped build id, and a sha with no environment — all
  // things a real post-deploy job sends. Rejecting them would break the caller
  // this feature exists for.
  for (const deploy of [
    { sha: "0f1e2d3" },
    { sha: "v2026.08.16-build.417", env: "staging" },
    { sha: SHA },
  ]) {
    expect(createCheckSchema.safeParse({ url: "https://example.com", deploy }).success).toBe(true);
  }
});

test("schema: malformed shas are rejected", () => {
  // Too short, too long, whitespace/flag injection, and an empty object — each
  // must fail rather than land junk in Run.deploySha.
  for (const deploy of [
    { sha: "abc" },
    { sha: "f".repeat(65) },
    { sha: "0f1e2d3 --drop" },
    { env: "production" },
  ]) {
    const parsed = createCheckSchema.safeParse({ url: "https://example.com", deploy });
    expect(parsed.success).toBe(false);
  }
});

test("schema: `deploy` stays optional — the browser form is unaffected", () => {
  const parsed = createCheckSchema.safeParse({ url: "https://example.com" });
  expect(parsed.success).toBe(true);
  expect(parsed.success && parsed.data.deploy).toBeUndefined();
});
