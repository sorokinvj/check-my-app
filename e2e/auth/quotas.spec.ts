import { test, expect, type APIResponse } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

// Dogfood: run quotas on POST /api/checks (CHE-55, limits from CHE-40).
//
// Both specs submit url=https://example.com — the cheapest known agent target
// (~$0.07/run). When a POST legitimately lands 201 a real run IS created and
// that cost is accepted: there is no cancel API, and probing plan state some
// other way would just re-implement the server. Keep example.com here.
//
// Plan state is NOT assumed: the downgrade spec (which runs just before this
// one, alphabetically) normally leaves the test user on free, but a partial run
// or a slow Stripe webhook can leave them on starter. Each spec branch-asserts
// the response SHAPE strictly for every legitimate outcome instead.
//
// Turnstile: prod enforces it only when TURNSTILE_SECRET is set — a 403
// "Verification failed" means this API path isn't walkable headlessly, so the
// spec skips cleanly rather than lying either way.
const BASE = process.env.TARGET_URL ?? "http://localhost:3000";

const SUBMIT_BODY = { url: "https://example.com" };

function skipIfTurnstile(res: APIResponse) {
  test.skip(res.status() === 403, "Turnstile enforced on this target — API submit not walkable");
}

// 201 shape: exactly { id } where id is the run's unguessable publicId.
function expectCreatedShape(body: unknown) {
  const b = body as { id?: unknown };
  expect(Object.keys(b as object).sort()).toEqual(["id"]);
  expect(typeof b.id).toBe("string");
  expect((b.id as string).length).toBeGreaterThan(0);
}

// 429 shape: exactly { error, code } with the expected quota code.
function expectQuotaShape(body: unknown, code: "quota_anon" | "quota_free") {
  const b = body as { error?: unknown; code?: unknown };
  expect(Object.keys(b as object).sort()).toEqual(["code", "error"]);
  expect(b.code).toBe(code);
  expect(typeof b.error).toBe("string");
}

test("signed-in submit: 201 (paid/under-quota) or 429 quota_free with upgrade copy", async ({
  page,
}) => {
  await setupClerkTestingToken({ page });
  await page.goto(`${BASE}/`);
  await clerk.signIn({ page, emailAddress: process.env.E2E_CLERK_USER_EMAIL! });

  const res = await page.request.post(`${BASE}/api/checks`, { data: SUBMIT_BODY });
  skipIfTurnstile(res);

  expect([201, 429]).toContain(res.status());
  const body = (await res.json()) as unknown;

  if (res.status() === 201) {
    // Plan is starter (or free with lifetime runs left) — a real ~$0.07 run on
    // example.com was just created; accepted, see file header.
    expectCreatedShape(body);
  } else {
    // Plan is free and the 3-run lifetime cap is spent.
    expectQuotaShape(body, "quota_free");
    expect((body as { error: string }).error).toContain("Free plan");
    expect((body as { error: string }).error).toMatch(/upgrade/i);
  }
});

test("anonymous submit: daily quota fires on the repeat POST", async ({ request }) => {
  // The `request` fixture carries no Clerk cookies — this is the stranger
  // funnel, keyed server-side by (hashed) client IP. CI runners share egress
  // IPs and previous runs count against today's allowance, so the FIRST post
  // may already be 429; only when it is 201 does the second post prove the
  // 1/day cap deterministically.
  const first = await request.post(`${BASE}/api/checks`, { data: SUBMIT_BODY });
  skipIfTurnstile(first);

  expect([201, 429]).toContain(first.status());
  const firstBody = (await first.json()) as unknown;

  if (first.status() === 429) {
    // Quota already spent by an earlier run from this IP — still proves the
    // gate and its shape.
    expectQuotaShape(firstBody, "quota_anon");
    return;
  }

  // First was 201 (one real ~$0.07 run, accepted) — the repeat must be capped.
  expectCreatedShape(firstBody);
  const second = await request.post(`${BASE}/api/checks`, { data: SUBMIT_BODY });
  expect(second.status()).toBe(429);
  expectQuotaShape((await second.json()) as unknown, "quota_anon");
});
