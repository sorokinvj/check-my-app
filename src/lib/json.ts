// JSON-as-TEXT helpers. D1/SQLite has no JSON column type, so appLens, anatomy,
// events (Run) and detail (Finding) are stored as TEXT. Parse on read, stringify
// on write — these wrappers keep the call sites tidy and null-safe.

export function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function stringifyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}
