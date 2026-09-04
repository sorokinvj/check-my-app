// Agent worker runtime environment (CHE-14/15).
//
// The agent runs as a separate Cloudflare Worker from the web app (two-worker
// topology). Its dependencies — D1, R2, Browser Rendering, the Anthropic key —
// arrive as bindings/secrets on the Workflow env, not as module singletons.
// Phase functions receive an AgentEnv so the same logic is testable and the
// run is durable across Workflow steps.

import { getDb } from "@/lib/db";
import { putObject } from "@/lib/storage";

export interface AgentBindings {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  MYBROWSER: Fetcher;
  CHECK_RUN: Workflow;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_NAV_MODEL?: string;
  ANTHROPIC_SYNTH_MODEL?: string;
  // Cheap-model epic: models with a provider prefix ("z-ai/glm-5.2") route
  // through OpenRouter's Anthropic-compatible endpoint with this key.
  OPENROUTER_API_KEY?: string;
  // CHE-168: nav model routing without a deploy, so a candidate model can be
  // spiked in production by changing secrets. ANTHROPIC_NAV_VISION "on" sends
  // the nav model screenshots, "off" keeps them out of its context, unset →
  // the isVisionModel heuristic in llm.ts. ANTHROPIC_STRUCT_MODEL names the
  // model structured extraction runs on; unset → the text sibling of a vision
  // nav model, else the nav model itself.
  ANTHROPIC_NAV_VISION?: string;
  ANTHROPIC_STRUCT_MODEL?: string;
  // Linear OAuth app creds (CHE-68): freshLinearToken refreshes the owner's
  // 24h access tokens with these. Absent = tokens die a day after connect.
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  // Verdict-ready notifications (Resend). All optional — absent = log-only.
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  // Public web origin for links in emails, e.g. https://checkmyapp.dev
  APP_URL?: string;
  // CHE-130: how many recent screenshots the walking loop keeps in the model's
  // context. Unset → 3. "off" → unlimited, the pre-CHE-130 behaviour, so an A/B
  // can be rolled back with a var change instead of a deploy. A positive
  // integer → that many. Anything else → the default 3.
  WALK_IMAGE_WINDOW?: string;
  // CHE-133: whether a full run of a watched app gives discovery the map from
  // the last full check. Unset → on. "off" → every full run maps from scratch,
  // the pre-CHE-133 behaviour — an A/B rollback without a deploy, the same
  // pattern as WALK_IMAGE_WINDOW (CHE-130). Anything else → on.
  DISCOVERY_MEMORY?: string;
  // CHE-135: whether discovery runs lean — adaptive thinking off and no
  // screenshot JPEG in the model's context. Unset → on. "off" → the pre-CHE-135
  // discovery (thinking on, every screenshot in context) — the A/B rollback
  // without a deploy, the same pattern as DISCOVERY_MEMORY (CHE-133) and
  // WALK_IMAGE_WINDOW (CHE-130). Anything else → on.
  DISCOVERY_LEAN?: string;
}

export interface AgentEnv {
  bindings: AgentBindings;
  db: ReturnType<typeof getDb>;
}

export function makeAgentEnv(bindings: AgentBindings): AgentEnv {
  return { bindings, db: getDb(bindings) };
}

const DEFAULT_WALK_IMAGE_WINDOW = 3;

// CHE-130: parse WALK_IMAGE_WINDOW. `undefined` means "do not trim" and is
// returned only for an explicit "off" — a typo must not silently switch the
// walk back to the $2.31 behaviour, so it falls to the default instead.
export function walkImageWindow(bindings: Pick<AgentBindings, "WALK_IMAGE_WINDOW">): number | undefined {
  const raw = bindings.WALK_IMAGE_WINDOW?.trim();
  if (!raw) return DEFAULT_WALK_IMAGE_WINDOW;
  if (raw.toLowerCase() === "off") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_WALK_IMAGE_WINDOW;
}

// CHE-133: parse DISCOVERY_MEMORY. Only an explicit "off" disables memory —
// a typo must not silently put every watch back on the 55-iteration map.
export function discoveryMemoryEnabled(bindings: Pick<AgentBindings, "DISCOVERY_MEMORY">): boolean {
  return bindings.DISCOVERY_MEMORY?.trim().toLowerCase() !== "off";
}

// CHE-135: parse DISCOVERY_LEAN. Only an explicit "off" restores the heavier
// discovery — a typo must not silently put thinking and screenshots back into
// every discovery call.
export function discoveryLeanEnabled(bindings: Pick<AgentBindings, "DISCOVERY_LEAN">): boolean {
  return bindings.DISCOVERY_LEAN?.trim().toLowerCase() !== "off";
}

// Store a screenshot in R2, content-addressed. Returns the web evidence URL.
export async function putScreenshot(
  env: AgentEnv,
  buffer: Uint8Array,
): Promise<{ storageUrl: string; sha256: string }> {
  const hash = await crypto.subtle.digest("SHA-256", buffer as BufferSource);
  const sha256 = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const storageUrl = await putObject(env.bindings.EVIDENCE, `screenshots/${sha256}.png`, buffer);
  return { storageUrl, sha256 };
}

// Store a text artifact (transcript, generated spec) in R2.
export async function putText(
  env: AgentEnv,
  key: string,
  content: string,
): Promise<string> {
  return putObject(env.bindings.EVIDENCE, key, content);
}
