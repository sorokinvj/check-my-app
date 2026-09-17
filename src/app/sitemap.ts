import type { MetadataRoute } from "next";
import { HOME_PATH, PUBLIC_PATHS, SITE } from "@/lib/site-metadata";

// CHE-108: /robots.txt answered 200 while /sitemap.xml answered 404 — a crawler
// was invited in and handed a dead end.
//
// Only the public pages belong here. A verdict lives on an unguessable permalink
// and is the customer's to share or not; putting those in a sitemap would hand
// every check we have ever run to a search engine.
//
// Only canonical addresses belong here. When the home page had two — `/`
// redirecting to /check — listing both told Google we had two home pages
// ("Duplicate without user-selected canonical", 2026-09-16).
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  // /checks/today is public by design: it lists anonymous checks, which are
  // public anyway, and it changes every day.
  return PUBLIC_PATHS.map((path) => ({
    url: `${SITE}${path}`,
    lastModified: now,
    changeFrequency: path === "/checks/today" ? ("daily" as const) : ("weekly" as const),
    priority: path === HOME_PATH ? 1 : 0.7,
  }));
}
