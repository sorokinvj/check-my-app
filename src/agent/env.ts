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
  // Verdict-ready notifications (Resend). All optional — absent = log-only.
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  // Public web origin for links in emails, e.g. https://checkmyapp.dev
  APP_URL?: string;
}

export interface AgentEnv {
  bindings: AgentBindings;
  db: ReturnType<typeof getDb>;
}

export function makeAgentEnv(bindings: AgentBindings): AgentEnv {
  return { bindings, db: getDb(bindings) };
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
