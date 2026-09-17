// What the site tells a search engine about itself, checked two ways.
//
// On 2026-09-16 Search Console filed /check — the page every link, funnel and
// experiment metric is keyed on — as "Duplicate without user-selected
// canonical". Nothing on the site had said which address was real: `/` sent a
// temporary redirect to /check, both were in the sitemap, no page carried a
// canonical tag, and http:// answered 200 instead of redirecting. Google chose
// `/` and dropped /check. Every one of those is a fact this script pins.
//
// Static part (always): the source says one address per page.
// Live part (when SEO_SITE is set, e.g. SEO_SITE=https://checkmyapp.dev): the
// deployed site answers the way the source says it does. CI runs the static
// part; the live part is the post-deploy dogfood step (CLAUDE.md rule 7).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sitemap from "../src/app/sitemap";
import robots from "../src/app/robots";
import { HOME_PATH, PUBLIC_PATHS, SITE, canonical, pageMetadata } from "../src/lib/site-metadata";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

function staticChecks() {
  const home = readFileSync(path.join(repoRoot, "src/app/page.tsx"), "utf8");
  check(
    "`/` is a permanent redirect to the home page, not a temporary one",
    /permanentRedirect\(\s*["']\/check["']\s*\)/.test(home) && !/\bredirect\(/.test(home),
  );
  check("HOME_PATH is /check — the address analytics and experiments are keyed on", HOME_PATH === "/check");

  const entries = sitemap();
  const urls = entries.map((e) => e.url);
  check("sitemap has no bare root entry (it redirects, so it is not a canonical)", !urls.includes(SITE) && !urls.includes(`${SITE}/`));
  check("sitemap lists the home page", urls.includes(`${SITE}${HOME_PATH}`));
  check("sitemap is exactly the public pages", urls.join(",") === PUBLIC_PATHS.map((p) => `${SITE}${p}`).join(","));
  check("sitemap URLs carry no trailing slash", urls.every((u) => !u.endsWith("/")));
  check("home page has the top priority", entries.find((e) => e.url === `${SITE}${HOME_PATH}`)?.priority === 1);

  const md = pageMetadata({ title: "T", description: "D", path: "/faq" });
  check("pageMetadata names its own canonical", md.alternates?.canonical === "/faq");
  check("canonical() names the path it is given", canonical("/verdict/x").canonical === "/verdict/x");
  check("og:url and canonical agree", md.openGraph?.url === `${SITE}/faq`);

  const r = robots();
  const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
  const disallow = ([] as string[]).concat(rule.disallow ?? []);
  for (const p of ["/dashboard", "/onboarding", "/api/", "/sign-in", "/run/"]) {
    check(`robots keeps ${p} out`, disallow.includes(p));
  }
  for (const p of PUBLIC_PATHS) {
    check(`robots lets ${p} in`, !disallow.some((d) => p.startsWith(d)));
  }
  check("robots does not shut out verdicts (public by decision, 2026-09-05)", !disallow.some((d) => d.startsWith("/verdict")));
  check("robots points at the sitemap", r.sitemap === `${SITE}/sitemap.xml`);
}

async function head(url: string): Promise<{ status: number; location: string | null }> {
  const res = await fetch(url, { redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") };
}

async function liveChecks(site: string) {
  const origin = new URL(site);
  const httpOrigin = `http://${origin.host}`;

  const root = await head(`${site}/`);
  check("live: `/` answers 308 to the home page", root.status === 308 && !!root.location && new URL(root.location, site).pathname === HOME_PATH, `${root.status} ${root.location ?? ""}`);

  const http = await head(`${httpOrigin}/faq`);
  check("live: http:// is a permanent redirect to https://", (http.status === 301 || http.status === 308) && (http.location ?? "").startsWith("https://"), `${http.status} ${http.location ?? ""}`);

  const slash = await head(`${site}/faq/`);
  check("live: a trailing slash redirects to the canonical", slash.status === 308 && !!slash.location && new URL(slash.location, site).pathname === "/faq", `${slash.status} ${slash.location ?? ""}`);

  for (const p of PUBLIC_PATHS) {
    const url = `${site}${p}`;
    const res = await fetch(url);
    const html = await res.text();
    const tag = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? null;
    check(`live: ${p} answers 200`, res.status === 200, String(res.status));
    check(`live: ${p} declares itself canonical`, tag === url, tag ?? "no canonical tag");
  }

  const robotsTxt = await (await fetch(`${site}/robots.txt`)).text();
  check("live: robots.txt names the sitemap", robotsTxt.includes(`Sitemap: ${site}/sitemap.xml`));
  check("live: robots.txt keeps the dashboard out", /Disallow:\s*\/dashboard/.test(robotsTxt));

  const sitemapXml = await (await fetch(`${site}/sitemap.xml`)).text();
  check("live: sitemap.xml has no bare root entry", !sitemapXml.includes(`<loc>${site}</loc>`) && !sitemapXml.includes(`<loc>${site}/</loc>`));
  check("live: sitemap.xml lists the home page", sitemapXml.includes(`<loc>${site}${HOME_PATH}</loc>`));
}

async function main() {
  staticChecks();
  const site = process.env.SEO_SITE?.replace(/\/$/, "");
  if (site) await liveChecks(site);
  else console.log("skip  live checks (set SEO_SITE=https://checkmyapp.dev to run them against a deployment)");
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
