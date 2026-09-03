// Stack detection from a response's headers and HTML (CHE-132).
//
// Lived inside browser.ts's surface scan until the page survey needed the same
// tables without a browser: the stack is readable from a plain fetch, and
// asking a browser session — let alone a model — for it was paying for
// something the server already tells us for free. One table, two callers, so
// the surface scan and the survey can never disagree about what "Next.js"
// looks like.

export const HEADER_SIGNALS: Array<[string, RegExp, string]> = [
  ["x-powered-by", /next\.js/i, "Next.js"],
  ["server", /vercel/i, "Vercel"],
  ["server", /cloudflare/i, "Cloudflare"],
  ["x-vercel-id", /.+/, "Vercel"],
  ["cf-ray", /.+/, "Cloudflare"],
];

export const HTML_SIGNALS: Array<[RegExp, string]> = [
  [/__NEXT_DATA__|\/_next\//, "Next.js"],
  [/data-reactroot|react-dom/i, "React"],
  [/__NUXT__/, "Nuxt"],
  [/ng-version/, "Angular"],
  [/cdn\.tailwindcss|tailwind/i, "Tailwind"],
  [/supabase/i, "Supabase"],
  [/firebaseapp|firebaseio/i, "Firebase"],
  [/js\.stripe\.com/i, "Stripe"],
  [/posthog/i, "Posthog"],
];

/** Header names are matched case-insensitively; the order of the result is the table's. */
export function detectTech(headers: Record<string, string>, html: string): string[] {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const signals = new Set<string>();
  for (const [h, test, label] of HEADER_SIGNALS) {
    if (lower[h] && test.test(lower[h])) signals.add(label);
  }
  for (const [test, label] of HTML_SIGNALS) if (test.test(html)) signals.add(label);
  return [...signals];
}
