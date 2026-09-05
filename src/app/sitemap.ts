import type { MetadataRoute } from "next";

// CHE-108: /robots.txt answered 200 while /sitemap.xml answered 404 — a crawler
// was invited in and handed a dead end.
//
// Only the public pages belong here. A verdict lives on an unguessable permalink
// and is the customer's to share or not; putting those in a sitemap would hand
// every check we have ever run to a search engine.
export default function sitemap(): MetadataRoute.Sitemap {
  const site = process.env.NEXT_PUBLIC_APP_URL ?? "https://checkmyapp.dev";
  const now = new Date();
  // /checks/today is public by design: it lists anonymous checks, which are
  // public anyway, and it changes every day.
  return ["", "/check", "/checks/today", "/pricing", "/faq", "/about"].map((path) => ({
    url: `${site}${path}`,
    lastModified: now,
    changeFrequency: path === "/checks/today" ? ("daily" as const) : ("weekly" as const),
    priority: path === "" ? 1 : 0.7,
  }));
}
