import crypto from "node:crypto";

// Stable dedup key for a recurring regression (CHE-32). Same (journey, failing
// step, failure signature) → same key across daily runs, so we comment on the
// existing ticket instead of refiling. Normalized to survive cosmetic wording
// drift between runs. Truncated to 32 hex chars — collision-safe at our scale.
export function dedupKey(parts: {
  journeyTitle: string;
  stepLabel: string;
  failureSignature: string;
}): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const basis = [
    norm(parts.journeyTitle),
    norm(parts.stepLabel),
    norm(parts.failureSignature),
  ].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32);
}
