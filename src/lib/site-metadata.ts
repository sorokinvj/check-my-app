import type { Metadata } from "next";

// CHE-108: link previews. The root layout defines the site-wide Open Graph
// card; a page that says nothing inherits it whole, so /pricing, /faq and
// /about all previewed as "CheckMyApp" with the generic tagline.
//
// Next merges metadata shallowly: a page that defines `openGraph` replaces the
// layout's `openGraph` object entirely, image included. So a page cannot set
// its own og:title and keep the layout's image by omission — it has to carry
// the image itself. This helper is the one place that knows the image, so a
// page names itself in two strings and gets a complete card.
export const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://checkmyapp.dev";

export const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "CheckMyApp" };

// `title` is the page's own name; the root layout's template appends the
// product name to <title>, while the og/twitter titles get it explicitly
// because templates do not apply to them.
export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: `/${string}`;
}): Metadata {
  const fullTitle = `${title} · CheckMyApp`;
  return {
    title,
    description,
    openGraph: {
      type: "website",
      siteName: "CheckMyApp",
      title: fullTitle,
      description,
      url: `${SITE}${path}`,
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [OG_IMAGE.url],
    },
  };
}
