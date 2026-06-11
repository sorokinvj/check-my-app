import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Derive a stable app slug from a target URL host, e.g.
// "https://joblander.app/dashboard" → "joblander.app".
export function appSlugFromUrl(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Filesystem-safe variant of an app slug ("localhost:3000" → "localhost-3000").
// Used for generated-tests/ directories and similar artifact paths.
export function fsSafeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-|-$/g, "");
}
