// Launch analytics verification: the pieces of src/lib/analytics.ts and
// src/lib/analytics-server.ts that can be wrong silently are checked here,
// without a browser and without PostHog.
//
// - the A/B bucket is a pure function of the id (same id → same variant) and
//   the hash is the real FNV-1a (known-answer vectors);
// - over 10k random ids and 10k structured ids, B lands between 45% and 55%;
// - the event catalogues have no duplicates and pageview maps to $pageview;
// - the before_send guard drops autocapture on sensitive inputs and strips
//   secret-looking property keys, and leaves an ordinary event untouched;
// - the server capture helper posts the documented payload to the documented
//   endpoint and never throws;
// - the browser's distinct id can be read back from the PostHog cookie.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-analytics.ts

import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ANALYTICS_EVENTS,
  fnv1a32,
  guardEvent,
  POSTHOG_TOKEN,
  posthogEventName,
  resolveLandingVariant,
  variantForId,
  type AnalyticsEvent,
  type LandingVariant,
} from "@/lib/analytics";
import {
  buildCapturePayload,
  captureServer,
  distinctIdFromCookies,
  POSTHOG_CAPTURE_URL,
  POSTHOG_COOKIE_NAME,
  POSTHOG_SERVER_TOKEN,
  SERVER_ANALYTICS_EVENTS,
  serverDistinctId,
  type FetchLike,
} from "@/lib/analytics-server";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ─── Hash and bucketing ─────────────────────────────────────────────────────

// Published FNV-1a 32-bit test vectors.
check("fnv1a32('') is the offset basis", fnv1a32("") === 0x811c9dc5, fnv1a32("").toString(16));
check("fnv1a32('a') matches the reference", fnv1a32("a") === 0xe40c292c, fnv1a32("a").toString(16));
check("fnv1a32('foobar') matches the reference", fnv1a32("foobar") === 0xbf9cf968, fnv1a32("foobar").toString(16));

const sample = randomUUID();
check(
  "the same id always lands in the same bucket",
  Array.from({ length: 100 }, () => variantForId(sample)).every((v) => v === variantForId(sample)),
);

function shareB(ids: string[]): number {
  return ids.filter((id) => variantForId(id) === "B").length / ids.length;
}

const randomIds = Array.from({ length: 10_000 }, () => randomUUID());
const pctRandom = shareB(randomIds) * 100;
check("10k random ids: B between 45% and 55%", pctRandom >= 45 && pctRandom <= 55, `${pctRandom.toFixed(2)}% B`);

// Ids that differ only in a counter, the shape a stable id scheme produces.
const structuredIds = Array.from({ length: 10_000 }, (_, i) => `0198f0c2-${String(i).padStart(4, "0")}-7abc-8def-0123456789ab`);
const pctStructured = shareB(structuredIds) * 100;
check(
  "10k structured ids: B between 45% and 55%",
  pctStructured >= 45 && pctStructured <= 55,
  `${pctStructured.toFixed(2)}% B`,
);

check("an empty id still buckets", variantForId("") === "A" || variantForId("") === "B");

// The flag decides; the hash is only the fallback for when it cannot.
const dev = "0198f0c2-dead-7abc-8def-0123456789ab";
const hashed = variantForId(dev);
const other: LandingVariant = hashed === "A" ? "B" : "A";
check("a flag value of A or B wins over the hash", resolveLandingVariant(other, dev).variant === other && resolveLandingVariant(other, dev).source === "flag");
check("an undefined flag falls back to the device hash", resolveLandingVariant(undefined, dev).variant === hashed && resolveLandingVariant(undefined, dev).source === "hash");
check("a flag value outside A/B (false, 'control') falls back to the hash", resolveLandingVariant(false, dev).source === "hash" && resolveLandingVariant("control", dev).source === "hash");
check("no flag and no device id → A", resolveLandingVariant(undefined, null).variant === "A");

// ─── Catalogue ──────────────────────────────────────────────────────────────

const clientNames: readonly AnalyticsEvent[] = ANALYTICS_EVENTS;
check("client catalogue has no duplicates", new Set(clientNames).size === clientNames.length, clientNames.join(", "));
check(
  "server catalogue has no duplicates",
  new Set(SERVER_ANALYTICS_EVENTS).size === SERVER_ANALYTICS_EVENTS.length,
  SERVER_ANALYTICS_EVENTS.join(", "),
);
const overlap = clientNames.filter((n) => (SERVER_ANALYTICS_EVENTS as readonly string[]).includes(n));
check("no name is both a client and a server event", overlap.length === 0, overlap.join(", "));
check(
  "every event name is snake_case",
  [...clientNames, ...SERVER_ANALYTICS_EVENTS].every((n) => /^[a-z][a-z0-9_]*$/.test(n)),
);
check("pageview is sent as $pageview", posthogEventName("pageview") === "$pageview");
check(
  "every other event is sent under its own name",
  clientNames.filter((n) => n !== "pageview").every((n) => posthogEventName(n) === n),
);

// ─── before_send guard ──────────────────────────────────────────────────────

const base = { uuid: "u", timestamp: new Date() };

const clickOnPassword = guardEvent({
  ...base,
  event: "$autocapture",
  properties: {
    $event_type: "click",
    $elements: [
      { tag_name: "input", attr__type: "password", attr__class: "input" },
      { tag_name: "form" },
    ],
  },
});
check("autocapture touching a password input is dropped", clickOnPassword === null);

const clickOnEmail = guardEvent({
  ...base,
  event: "$autocapture",
  properties: { $elements: [{ tag_name: "input", attr__type: "email" }] },
});
check("autocapture touching an e-mail input is dropped", clickOnEmail === null);

const clickOnNoCapture = guardEvent({
  ...base,
  event: "$autocapture",
  properties: { $elements: [{ tag_name: "button" }, { tag_name: "div", attr__class: "card ph-no-capture" }] },
});
check("autocapture inside a ph-no-capture element is dropped", clickOnNoCapture === null);

const clickOnButton = guardEvent({
  ...base,
  event: "$autocapture",
  properties: { $elements: [{ tag_name: "button", $el_text: "Check it" }, { tag_name: "form" }] },
});
check("autocapture on an ordinary button passes", clickOnButton !== null && clickOnButton.event === "$autocapture");

const withSecrets = guardEvent({
  ...base,
  event: "check_submitted",
  properties: { appSlug: "example.com", hasCredentials: true, testPassword: "hunter2", apiKey: "k", token: "t", credentials: "e:p" },
});
check(
  "secret-looking property keys with a value are stripped; booleans and the rest kept",
  withSecrets !== null &&
    Object.keys(withSecrets.properties).sort().join(",") === "appSlug,hasCredentials" &&
    withSecrets.properties.appSlug === "example.com",
  JSON.stringify(withSecrets?.properties),
);

// The SDK stamps every event with `token` (the public project token) and
// `$`-prefixed properties; ingestion drops an event without `token`. The
// first browser probe of this guard lost every event that way.
const pageview = guardEvent({
  ...base,
  event: "$pageview",
  properties: { $current_url: "https://checkmyapp.dev/check", token: POSTHOG_TOKEN, $lib: "web", landing_variant: "B" },
});
check(
  "a pageview keeps the SDK's token, $-properties and the variant",
  pageview !== null &&
    pageview.properties.$current_url === "https://checkmyapp.dev/check" &&
    pageview.properties.token === POSTHOG_TOKEN &&
    pageview.properties.$lib === "web" &&
    pageview.properties.landing_variant === "B",
  JSON.stringify(pageview?.properties),
);
const foreignToken = guardEvent({ ...base, event: "x", properties: { token: "sk_live_something_else", $lib: "web" } });
check("a token that is not the project token is stripped", foreignToken !== null && !("token" in foreignToken.properties));
check("null passes through", guardEvent(null) === null);

// ─── Server capture ─────────────────────────────────────────────────────────

const fixedNow = new Date("2026-09-05T12:00:00.000Z");
const payload = buildCapturePayload("run_created", "user_123", { appSlug: "example.com", paid: false, hasCredentials: false }, fixedNow);
check("payload carries the project token as api_key", payload.api_key === POSTHOG_SERVER_TOKEN);
check("payload carries event, distinct_id and ISO timestamp",
  payload.event === "run_created" && payload.distinct_id === "user_123" && payload.timestamp === "2026-09-05T12:00:00.000Z",
  JSON.stringify(payload),
);
check(
  "payload properties are the caller's plus $lib",
  payload.properties.appSlug === "example.com" && payload.properties.paid === false && payload.properties.$lib === "checkmyapp-server",
  JSON.stringify(payload.properties),
);

async function serverChecks() {
  const calls: { url: string; init: RequestInit }[] = [];
  const okFetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const accepted = await captureServer("checkout_completed", "user_123", { plan: "business" }, okFetch);
  check("captureServer reports acceptance", accepted === true);
  check("captureServer posts to the documented single-event endpoint", calls[0]?.url === POSTHOG_CAPTURE_URL, calls[0]?.url);
  check(
    "captureServer sends JSON with the right headers",
    calls[0]?.init.method === "POST" &&
      (calls[0]?.init.headers as Record<string, string>)["Content-Type"] === "application/json",
  );
  const body = JSON.parse(String(calls[0]?.init.body));
  check(
    "captureServer body is the built payload",
    body.api_key === POSTHOG_SERVER_TOKEN && body.event === "checkout_completed" && body.distinct_id === "user_123" && body.properties.plan === "business",
    JSON.stringify(body),
  );

  const refusing: FetchLike = async () => ({ ok: false, status: 401 });
  const warn = console.warn;
  console.warn = () => {};
  try {
    check("a refused event is reported, not thrown", (await captureServer("one_check_paid", "u", { appSlug: "x" }, refusing)) === false);
    const throwing: FetchLike = async () => {
      throw new Error("network down");
    };
    check("an unreachable PostHog is reported, not thrown", (await captureServer("one_check_paid", "u", { appSlug: "x" }, throwing)) === false);
  } finally {
    console.warn = warn;
  }
}

// ─── Whom a server event belongs to ─────────────────────────────────────────

check("a cookie id wins", serverDistinctId("ph-cookie", "user_1", "run:x").distinctId === "ph-cookie");
check("no cookie → the signed-in owner", serverDistinctId(null, "user_1", "run:x").distinctId === "user_1");
const orphan = serverDistinctId(null, null, "run:x");
check(
  "no cookie, no owner → the per-object id, and no person profile is created",
  orphan.distinctId === "run:x" && orphan.extra.$process_person_profile === false,
);
check("a cookie id creates a person as usual", Object.keys(serverDistinctId("ph-cookie", null, "run:x").extra).length === 0);

// ─── Call sites ─────────────────────────────────────────────────────────────
//
// Every event the product emits is in the catalogue (the compiler enforces
// that), and every catalogue event is emitted somewhere — a name nobody
// calls is a chart that will stay empty. Phase 2 wired the calls; this keeps
// them wired.

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "generated" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(d.name) ? [p] : [];
  });
}
const srcFiles = sources(join(process.cwd(), "src")).filter((f) => !/[\\/]lib[\\/]analytics(-server)?\.ts$/.test(f));
const clientCalls = new Map<string, string[]>();
const serverCalls = new Map<string, string[]>();
for (const file of srcFiles) {
  const text = readFileSync(file, "utf8");
  const rel = file.slice(process.cwd().length + 1);
  for (const m of text.matchAll(/\btrack\("([a-z_]+)"/g)) clientCalls.set(m[1], [...(clientCalls.get(m[1]) ?? []), rel]);
  for (const m of text.matchAll(/\bevent="([a-z_]+)"/g)) clientCalls.set(m[1], [...(clientCalls.get(m[1]) ?? []), rel]);
  for (const m of text.matchAll(/\b(?:captureServer|capture|deps\.capture)\("([a-z_]+)"/g)) serverCalls.set(m[1], [...(serverCalls.get(m[1]) ?? []), rel]);
}
const unknownClient = [...clientCalls.keys()].filter((n) => !(clientNames as readonly string[]).includes(n));
check("every client call site names a catalogue event", unknownClient.length === 0, unknownClient.join(", "));
const unknownServer = [...serverCalls.keys()].filter((n) => !(SERVER_ANALYTICS_EVENTS as readonly string[]).includes(n));
check("every server call site names a catalogue event", unknownServer.length === 0, unknownServer.join(", "));
const silentClient = clientNames.filter((n) => !clientCalls.has(n));
check("every client catalogue event has a call site", silentClient.length === 0, `uncalled: ${silentClient.join(", ")}`);
const silentServer = SERVER_ANALYTICS_EVENTS.filter((n) => !serverCalls.has(n));
check("every server catalogue event has a call site", silentServer.length === 0, `uncalled: ${silentServer.join(", ")}`);
for (const [name, files] of [...clientCalls, ...serverCalls]) console.log(`      ${name} ← ${[...new Set(files)].join(", ")}`);

// The three inputs that hold what a customer typed for us carry the class
// the SDK and guardEvent both honour.
const form = readFileSync(join(process.cwd(), "src/components/submit-form.tsx"), "utf8");
const noCapture = (form.match(/className="ph-no-capture"/g) ?? []).length;
check("the test e-mail, password and notify e-mail inputs carry ph-no-capture", noCapture >= 3, `${noCapture} inputs`);

// ─── Cookie → distinct id ───────────────────────────────────────────────────

const cookieValue = encodeURIComponent(JSON.stringify({ distinct_id: "0198f0c2-dead-7abc-8def-0123456789ab", $device_id: "dev" }));
check(
  "the browser's distinct id is read from the PostHog cookie",
  distinctIdFromCookies(`__clerk=abc; ${POSTHOG_COOKIE_NAME}=${cookieValue}; other=1`) === "0198f0c2-dead-7abc-8def-0123456789ab",
);
check("no PostHog cookie → null", distinctIdFromCookies("__clerk=abc") === null);
check("no Cookie header → null", distinctIdFromCookies(null) === null);
check("a malformed PostHog cookie → null", distinctIdFromCookies(`${POSTHOG_COOKIE_NAME}=%7Bnot-json`) === null);

serverChecks().then(() => {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
