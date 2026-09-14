// The loopback broker's rules (spikes/extension-browser-run/proxy.mjs).
//
// The broker exists so the model-directed Workflow never holds the probe's
// bearer token. That only holds if three things are true, and all three are
// checkable without a socket, so they are checked here rather than trusted:
// it refuses anything that is not an /attempt/{owner} call, it never forwards
// a caller-supplied Authorization header, and it fails loudly rather than
// anonymously when the token is missing.
//
// Usage: node scripts/verify-extension-proxy.mjs

import assert from "node:assert/strict";
import { proxyTarget } from "../spikes/extension-browser-run/proxy.mjs";

const PROBE = "https://probe.example.workers.dev";
const spike = extra => ({ "x-cma-spike": "1", ...extra });

const session = proxyTarget(
  { method: "POST", url: "/attempt/owner-run-1234/session", headers: spike({ "content-type": "application/json" }) },
  PROBE,
  "tok",
);
assert.equal(session.url, `${PROBE}/attempt/owner-run-1234/session`);
assert.equal(session.method, "POST");
assert.equal(session.headers.authorization, "Bearer tok", "The broker is the only holder of the probe credential");
assert.equal(session.headers["content-type"], "application/json");

const query = proxyTarget(
  { method: "GET", url: "/attempt/owner-run-1234/evidence?full=1", headers: spike() },
  PROBE,
  "tok",
);
assert.equal(query.url, `${PROBE}/attempt/owner-run-1234/evidence?full=1`, "The query survives the hop");
assert.equal(query.headers["content-type"], undefined, "A GET carries no content type");

// A caller-supplied credential must not reach the probe: the whole point of
// the hop is that the token used is this process's, not the Workflow's.
const forged = proxyTarget(
  { method: "GET", url: "/attempt/owner-run-1234/evidence", headers: spike({ authorization: "Bearer stolen" }) },
  PROBE,
  "tok",
);
assert.equal(forged.headers.authorization, "Bearer tok", "An inbound Authorization header is replaced, never forwarded");

// Path shape: the same restriction the probe Worker itself enforces, applied
// one hop earlier so a stray local process cannot address anything else.
for (const path of ["/", "/health", "/attempt/short/session", "/attempt/owner-run-1234/../../admin", "/admin"]) {
  const refused = proxyTarget({ method: "GET", url: path, headers: spike() }, PROBE, "tok");
  assert.equal(refused.status, 404, `${path} is not an attempt call`);
  assert.equal(refused.url, undefined);
}

// The spike header is what tells a deliberate call from anything else that
// happens to find the port open.
const unmarked = proxyTarget({ method: "GET", url: "/attempt/owner-run-1234/evidence", headers: {} }, PROBE, "tok");
assert.equal(unmarked.status, 403);

// No token is a loud failure, not an anonymous call the probe answers with 401
// — the operator has to see which half of the stand is unconfigured.
const untokened = proxyTarget({ method: "GET", url: "/attempt/owner-run-1234/evidence", headers: spike() }, PROBE, "");
assert.equal(untokened.status, 500);
assert.match(untokened.error, /PROBE_ACCESS_TOKEN/);

console.log("Extension proxy: attempt-only routing, credential substitution and missing-token failure verified");
