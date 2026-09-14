// The loopback broker between the local Workflow and the Cloudflare probe.
//
// workflow.ts sends every native-session call to http://127.0.0.1:19092 and
// deliberately holds no credential: the walk it drives is model-directed, and
// a bearer token inside that worker is a token inside reach of whatever the
// model decides to do. This process is the only holder — it adds the header,
// forwards to the probe Worker, and returns the response.
//
// It existed as an uncommitted shell one-off during runs 1-7 and was lost when
// that shell was closed, which left the whole stand unreproducible: the
// committed half (workflow.ts, native-cloudflare.ts, the wrangler configs)
// points at a port nothing was listening on any more. That is why it is a file
// now. See docs/extension-verification.md, "Running the stand".
//
// Usage (see the runbook for the full sequence):
//   PROBE_ACCESS_TOKEN=... node spikes/extension-browser-run/proxy.mjs
//
// Environment:
//   PROBE_ACCESS_TOKEN  required; the probe Worker's bearer token
//   PROBE_URL           optional; defaults to the deployed probe below
//   PROXY_PORT          optional; defaults to 19092 (what workflow.ts calls)

import { createServer } from "node:http";

const DEFAULT_PROBE = "https://checkmyapp-extension-native-probe.frosty-fog-32a2.workers.dev";
const PORT = Number(process.env.PROXY_PORT ?? 19092);

// Pure, so verify-extension-proxy.mjs can check the rules without a socket.
// Two of them are load-bearing rather than cosmetic:
//   - only /attempt/{owner}/... is forwarded, the same shape the probe itself
//     validates, so a stray local process cannot address anything else;
//   - an inbound Authorization header is dropped, never passed through: the
//     point of this hop is that the caller's credential is not the one used.
export function proxyTarget({ method, url, headers }, probeUrl = DEFAULT_PROBE, token = "") {
  if (headers?.["x-cma-spike"] !== "1") return { error: "Missing spike header", status: 403 };
  const parsed = new URL(url, "http://127.0.0.1");
  if (!/^\/attempt\/[a-zA-Z0-9_-]{8,100}(\/.*)?$/.test(parsed.pathname)) {
    return { error: "Not found", status: 404 };
  }
  if (!token) return { error: "PROBE_ACCESS_TOKEN is not set", status: 500 };
  return {
    url: new URL(parsed.pathname + parsed.search, probeUrl).toString(),
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(headers["content-type"] ? { "content-type": headers["content-type"] } : {}),
    },
  };
}

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function main() {
  const token = process.env.PROBE_ACCESS_TOKEN;
  if (!token) {
    console.error("proxy: PROBE_ACCESS_TOKEN is not set — the probe rejects every call without it.");
    console.error("It is recorded in Notion (CheckMyApp Progress Log, the keys section at the top).");
    process.exit(2);
  }
  const probeUrl = process.env.PROBE_URL ?? DEFAULT_PROBE;

  const server = createServer(async (request, response) => {
    const target = proxyTarget(request, probeUrl, token);
    if (target.error) {
      console.log(`[proxy] ${request.method} ${request.url} -> ${target.status} ${target.error}`);
      response.writeHead(target.status).end(target.error);
      return;
    }
    try {
      const body = await readBody(request);
      const upstream = await fetch(target.url, { method: target.method, headers: target.headers, body });
      const payload = Buffer.from(await upstream.arrayBuffer());
      // The path, not the body: session payloads carry account state and the
      // evidence responses carry observations that stay private (rule 1).
      console.log(`[proxy] ${request.method} ${new URL(target.url).pathname} -> ${upstream.status} (${payload.length}b)`);
      const type = upstream.headers.get("content-type");
      response.writeHead(upstream.status, type ? { "content-type": type } : {}).end(payload);
    } catch (error) {
      console.log(`[proxy] ${request.method} ${request.url} -> 502 ${error.message}`);
      response.writeHead(502).end(`Probe unreachable: ${error.message}`);
    }
  });

  // Loopback only. This process holds a credential; it must never be bound to
  // an address another machine can reach.
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[proxy] 127.0.0.1:${PORT} -> ${probeUrl}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
