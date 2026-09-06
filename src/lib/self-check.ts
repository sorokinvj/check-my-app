// Self-checks are read-only (CHE-193).
//
// CheckMyApp checks CheckMyApp (CLAUDE.md rule 6). On 2026-09-05 the daily
// self-check of checkmyapp.dev (run #146) opened the public example verdict of
// a third-party site, pressed "Re-check now" twice and "Looks right ✓" once.
// That started two real, paid runs of a stranger's site (#147, #148) and left
// a lens mark on a public verdict — and it would have recurred every day.
//
// The contract has two halves. The checker's browser sends the header below on
// every request to *.checkmyapp.dev (agent side). Every endpoint that creates
// or mutates a record refuses such a request before it does anything else —
// before Turnstile, quota, auth, even before reading the body (this side).
// Nothing is created, nothing is charged, nothing is marked.
//
// The header is the whole contract. Not the egress ASN, not the country, not
// the IP: WARP users share Cloudflare's ASN, and a real visitor must never be
// refused for looking like us.

export const SELF_CHECK_HEADER = "x-checkmyapp-checker";
export const SELF_CHECK_HEADER_VALUE = "1";

// The 403 body every refused API call answers with. The code is stable so the
// agent can tell "we were refused on purpose" from an ordinary 403.
export const SELF_CHECK_READ_ONLY = {
  error: "Self-checks are read-only.",
  code: "self_check_read_only",
} as const;

// Query flag a refused server action redirects back with. The page renders
// nothing for it on purpose: a self-check must not see anything a visitor
// would not.
export const SELF_CHECK_QUERY = "self_check=read_only";

type HeaderSource = Pick<Headers, "get"> | Record<string, string | string[] | undefined>;

function readHeader(source: HeaderSource, name: string): string | null {
  // Fetch-style Headers (and next/headers) look up case-insensitively already.
  if (typeof (source as Pick<Headers, "get">).get === "function") {
    return (source as Pick<Headers, "get">).get(name);
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(source as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  return null;
}

// True when the request comes from our own checker. Header name is matched
// case-insensitively; the value must be exactly "1" (whitespace ignored) —
// "0", "true" or an empty value are not the contract and are not honoured.
export function isSelfCheckRequest(headers: HeaderSource): boolean {
  const value = readHeader(headers, SELF_CHECK_HEADER);
  return value !== null && value.trim() === SELF_CHECK_HEADER_VALUE;
}

// The refusal an API route handler returns. A plain Response (not
// NextResponse) so this module has no framework import and any handler —
// route, action or a test — can use it.
export function selfCheckReadOnlyResponse(): Response {
  return Response.json(SELF_CHECK_READ_ONLY, { status: 403 });
}

// Where a refused server action sends the browser back to.
export function selfCheckRedirectPath(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${SELF_CHECK_QUERY}`;
}
