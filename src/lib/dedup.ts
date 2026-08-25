import crypto from "node:crypto";

// CHE-59: LLM prose drifts run-to-run ("returns 401 for all anonymous" vs
// "fires automatically on every page"), so the SAME regression hashed to
// different keys and refiled (JOB-902 vs JOB-905). When the finding names a
// failing request, derive the signature from MACHINE facts instead: first
// "METHOD /path" + first 4xx/5xx status across the finding's texts, with the
// path normalized (origin/query stripped, locale prefix dropped, numeric/hash
// segments collapsed). Same broken endpoint → same signature, whatever the
// prose around it says.
export function requestSignature(texts: Array<string | null | undefined>): string | null {
  const joined = texts.filter(Boolean).join(" \n ");
  const req = joined.match(
    /\b(GET|POST|PUT|PATCH|DELETE)\s+((?:https?:\/\/[^\s/]+)?\/[A-Za-z0-9_\-./%[\]:]+)/i,
  );
  if (!req) return null;
  const status = joined.match(/\b([45]\d{2})\b/);
  if (!status) return null;
  let path = req[2].replace(/^https?:\/\/[^/]+/i, "").toLowerCase();
  path = path.replace(/[?#].*$/, "").replace(/[.,;:!)]+$/, "");
  path = path.replace(/^\/(en|de|fr|es|pt|it|nl|ru)(\/|$)/, "/");
  path = path.replace(/\/\d+(?=\/|$)/g, "/:id").replace(/\/[0-9a-f-]{16,}(?=\/|$)/gi, "/:id");
  return `${req[1].toUpperCase()} ${path} ${status[1]}`;
}

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
