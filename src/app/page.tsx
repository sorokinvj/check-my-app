import { permanentRedirect } from "next/navigation";

// No landing page in MVP — go straight to the submit screen.
//
// Permanent (308), not temporary. A 307 here told Google that `/` was the
// real address and `/check` a stand-in, so it indexed `/` and filed `/check`
// — the page every link, funnel and experiment metric is keyed on — as
// "Duplicate without user-selected canonical" (Search Console, 2026-09-16).
// A 308 says the opposite: `/check` is the page, `/` is the alias. The
// canonical tag on /check and the sitemap say the same thing.
export default function Home() {
  permanentRedirect("/check");
}
