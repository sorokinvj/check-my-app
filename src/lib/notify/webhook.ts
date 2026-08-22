// Outbound webhook dispatch (CHE-53) — the generic "plug CheckMyApp into your
// monitoring stack" surface. One POST per completed watch run, fired for EVERY
// run regardless of outcome (consumers filter; unlike email's notifyOnChangeOnly,
// an observability feed that goes quiet is indistinguishable from a dead one).
//
// Runs inside the agent worker (workerd), so everything here is web-standard:
// native fetch, AbortController timeouts, and HMAC via crypto.subtle — no
// node:crypto (see hashClientKey in src/lib/crypto.ts for the same pattern).
// Delivery is best-effort by contract: single attempt plus one immediate retry
// on network error, failures reported to the caller, never thrown.

export interface WebhookFinding {
  title: string;
  category: string;
  severity: string;
}

export interface DeployIdentity {
  sha: string;
  env: string | null;
}

export interface RunCompletedPayload {
  event: "run.completed";
  app: string; // appSlug
  runNumber: number;
  verdict: string | null;
  // Which build this run verified (CHE-56), or null when the run wasn't tied to
  // a deploy — a watch run, or a submission that named no sha.
  deploy: DeployIdentity | null;
  // Verdict of the baseline run this one was diffed against (null on first run).
  previousVerdict: string | null;
  changed: boolean;
  bottomLine: string | null;
  // Top findings only (capped at 10) — the verdict page has the full set.
  findings: WebhookFinding[];
  verdictUrl: string;
  completedAt: string; // ISO 8601
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const TIMEOUT_MS = 10_000;

// Sign the raw body with HMAC-SHA256 → "sha256=<hex>", the header format most
// webhook consumers (GitHub-style) already know how to verify.
export async function signPayload(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

// POST the payload to the owner's endpoint. Never throws: a webhook failure is
// the consumer's outage, not ours — the run is already complete.
export async function deliverWebhook(
  url: string,
  payload: RunCompletedPayload,
  secret?: string | null,
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-CheckMyApp-Signature"] = await signPayload(secret, body);
  return postWithRetry(url, headers, body);
}

// Single attempt + one immediate retry, but only on a network error (fetch
// threw): a non-2xx response is the endpoint's answer, not a transient blip,
// so retrying it would just double-deliver into a misconfigured consumer.
export async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<DeliveryResult> {
  const attempt = async (): Promise<DeliveryResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
      return { ok: res.ok, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt();
  } catch {
    // Network error / timeout — one immediate retry, then give up.
    try {
      return await attempt();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
