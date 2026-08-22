// Owner API keys (CHE-52). Raw key format: `cma_<32 random hex>`; only its
// SHA-256 hex digest is stored (ApiKey.keyHash), so a DB leak never leaks keys.
// Web Crypto throughout: these run in the workerd web worker on every
// key-authenticated request.

import type { PrismaClient } from "@/generated/prisma/client";

export const API_KEY_RE = /^cma_[0-9a-f]{32}$/;

// 16 random bytes → 32 hex chars. Raw key is returned ONCE, at creation.
export function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `cma_${toHex(bytes)}`;
}

export async function hashApiKey(raw: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return toHex(new Uint8Array(digest));
}

// Bearer token from an Authorization header, or null if it isn't ours.
export function extractApiKey(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m || !API_KEY_RE.test(m[1])) return null;
  return m[1];
}

// Resolve a request's API key to its owner (the User row). Touches lastUsedAt
// so the dashboard can show which keys are alive. Null = no/unknown key.
export async function resolveApiKeyOwner(db: PrismaClient, req: Request) {
  const raw = extractApiKey(req);
  if (!raw) return null;
  const keyHash = await hashApiKey(raw);
  const key = await db.apiKey.findUnique({
    where: { keyHash },
    include: { owner: true },
  });
  if (!key) return null;
  await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return key.owner;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
