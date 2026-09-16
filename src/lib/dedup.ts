import crypto from "node:crypto";

// CHE-59: LLM prose drifts run-to-run ("returns 401 for all anonymous" vs
// "fires automatically on every page"), so the SAME regression hashed to
// different keys and refiled (JOB-902 vs JOB-905). When the finding names a
// failing request, derive the signature from MACHINE facts instead: first
// "METHOD /path" + first 4xx/5xx status across the finding's texts, with the
// path normalized (origin/query stripped, locale prefix dropped, numeric/hash
// segments collapsed). Same broken endpoint → same signature, whatever the
// prose around it says.
/**
 * A URL or path reduced to the thing two visits have in common.
 *
 * Origin and query dropped, locale prefix dropped, numeric and hash segments
 * collapsed to `:id`. Extracted from `requestSignature` (where it lived inline)
 * when CHE-238 needed the same reduction for funnel steps: two callers that
 * normalise paths *almost* identically is how a signature and a funnel come to
 * disagree about whether two visits were the same page.
 *
 * Deliberately byte-identical to what `requestSignature` did inline. Trailing
 * slashes are NOT stripped here even though `/pricing/` and `/pricing` are the
 * same page: every open ticket's dedup key was computed with the old behaviour,
 * and changing it during a refactor would refile them all — the exact failure
 * CHE-59 created this file to stop. The funnel does that reduction on its own
 * side, where nothing is keyed on the result.
 */
export function normalizePath(urlOrPath: string): string {
  let path = urlOrPath.replace(/^https?:\/\/[^/]+/i, "").toLowerCase();
  path = path.replace(/[?#].*$/, "").replace(/[.,;:!)]+$/, "");
  path = path.replace(/^\/(en|de|fr|es|pt|it|nl|ru)(\/|$)/, "/");
  path = path.replace(/\/\d+(?=\/|$)/g, "/:id").replace(/\/[0-9a-f-]{16,}(?=\/|$)/gi, "/:id");
  return path;
}

export function requestSignature(texts: Array<string | null | undefined>): string | null {
  const joined = texts.filter(Boolean).join(" \n ");
  const req = joined.match(
    /\b(GET|POST|PUT|PATCH|DELETE)\s+((?:https?:\/\/[^\s/]+)?\/[A-Za-z0-9_\-./%[\]:]+)/i,
  );
  if (!req) return null;
  const status = joined.match(/\b([45]\d{2})\b/);
  if (!status) return null;
  return `${req[1].toUpperCase()} ${normalizePath(req[2])} ${status[1]}`;
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
