import crypto from "node:crypto";

// Test credentials are encrypted at rest and must never be logged or appear in
// evidence (see Product Spec §5 Privacy). AES-256-GCM with a key derived from
// CREDENTIALS_SECRET. This is the minimum bar — rotate the secret per env.

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const secret = process.env.CREDENTIALS_SECRET;
  if (!secret) {
    throw new Error("CREDENTIALS_SECRET is not set — cannot handle test credentials");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv.tag.ciphertext, base64
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

// Anonymous run quotas (CHE-40) need a stable per-client key, and an IP is not
// something we want at rest — so we keep only a salted one-way hash of it.
// Web Crypto rather than the node:crypto above: this runs on every submit in the
// web worker, and subtle.digest is native there under any compat flag.
// globalThis because this module's `crypto` import shadows the global.
// Null when there's nothing to key on (no IP behind Cloudflare, or no secret in
// local dev) — the caller treats that as "can't identify, don't gate".
export async function hashClientKey(ip: string | null | undefined): Promise<string | null> {
  const secret = process.env.CREDENTIALS_SECRET;
  if (!ip || !secret) return null;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${ip}:${secret}`),
  );
  return Buffer.from(digest).toString("base64");
}

export function decryptSecret(blob: string): string {
  const [ivB64, tagB64, dataB64] = blob.split(".");
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
