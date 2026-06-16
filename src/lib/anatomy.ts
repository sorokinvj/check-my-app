import type { AppAnatomy } from "./types";

// The discovery LLM does not always honor the AppAnatomy shape — it has been
// observed to emit `pages` as a grouped object ({public:[{path,title}],…})
// instead of string[], or `actions`/`services` as objects. The UI renders this
// structure directly (.map/.length), so any drift crashes the verdict page.
// We never trust unvalidated LLM output: coerce ANY shape to a safe AppAnatomy
// at the data boundary. Applied both on write (workflow anatomy step) and on
// read (verdict page), so already-stored malformed runs render too.

function asString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Common page/action object shapes → a single label.
    const label = o.path ?? o.url ?? o.name ?? o.title ?? o.label ?? o.action;
    if (typeof label === "string") return label.trim() || null;
  }
  return null;
}

// Flatten anything (string[], object-of-arrays, array-of-objects, single
// value) into a deduped string[].
function toStringList(v: unknown): string[] {
  const out: string[] = [];
  const push = (x: unknown) => {
    const s = asString(x);
    if (s) out.push(s);
  };
  if (Array.isArray(v)) {
    v.forEach(push);
  } else if (v && typeof v === "object") {
    for (const val of Object.values(v as Record<string, unknown>)) {
      if (Array.isArray(val)) val.forEach(push);
      else push(val);
    }
  } else {
    push(v);
  }
  return [...new Set(out)];
}

function toServices(v: unknown): { name: string; role: string }[] {
  const items: unknown[] = Array.isArray(v)
    ? v
    : v && typeof v === "object"
      ? Object.values(v as Record<string, unknown>).flat()
      : [];
  const out: { name: string; role: string }[] = [];
  for (const it of items) {
    if (typeof it === "string") {
      if (it.trim()) out.push({ name: it.trim(), role: "" });
    } else if (it && typeof it === "object") {
      const o = it as Record<string, unknown>;
      const name = asString(o.name ?? o.service ?? o.provider);
      if (name) out.push({ name, role: asString(o.role ?? o.purpose ?? o.description) ?? "" });
    }
  }
  return out;
}

function toTech(v: unknown): AppAnatomy["tech"] {
  const tech: AppAnatomy["tech"] = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const s = asString(val);
      if (s) tech[k] = s;
    }
  }
  return tech;
}

export function normalizeAnatomy(raw: unknown): AppAnatomy | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    pages: toStringList(o.pages),
    actions: toStringList(o.actions),
    services: toServices(o.services),
    tech: toTech(o.tech),
  };
}
