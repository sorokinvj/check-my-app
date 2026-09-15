// CHE-231 — the journey identity rules, driven against the titles production
// actually wrote.
//
// src/lib/journey-key.ts decides whether two journey titles name the same
// journey. That decision is what makes a journey the unit of a run instead of a
// row a run invents, so it gets the same treatment as the other deterministic
// gates in this repo: the real data, asserted, on every `npm run verify:all`.
//
// The fixture is every distinct journey title joblander.app produced in 60 runs
// (scripts/fixtures/journey-titles-joblander.json, exported from production D1
// on 2026-09-14): 167 titles for roughly a dozen journeys.
//
// Run: npm run verify:journeys       (add --print to see the clusters)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  anchorOf,
  journeyKey,
  matchJourney,
  normalizeSurface,
  normalizeTitle,
  signatureOf,
  tokenize,
  type JourneyCandidate,
} from "../src/lib/journey-key";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "journey-titles-joblander.json"), "utf8"),
) as { source: string; rows: Array<{ title: string; rows: number }> };

let failures = 0;
function check(what: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ok   ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

// The resolver as the agent runs it: read the catalog in creation order, match,
// or create a new entry. Greedy and order-dependent by construction — which is
// why the assertions below are about membership, not about the order titles
// happened to arrive in.
interface Cluster extends JourneyCandidate {
  aliases: string[];
  titles: Array<{ title: string; rows: number }>;
}

function cluster(rows: Array<{ title: string; rows: number }>): Cluster[] {
  const catalog: Cluster[] = [];
  for (const row of rows) {
    const hit = matchJourney(row.title, catalog);
    if (hit) {
      const c = hit as Cluster;
      if (!c.aliases.some((a) => normalizeTitle(a) === normalizeTitle(row.title))) {
        c.aliases.push(row.title);
      }
      c.titles.push(row);
      continue;
    }
    catalog.push({
      key: journeyKey(row.title, catalog.map((c) => c.key)),
      title: row.title,
      aliases: [row.title],
      titles: [row],
    });
  }
  return catalog;
}

const clusters = cluster(fixture.rows);
const byKey = new Map(clusters.map((c) => [c.key, c]));
const keyOf = (title: string): string | null => matchJourney(title, clusters)?.key ?? null;

console.log(`\n${fixture.rows.length} distinct titles → ${clusters.length} journeys\n`);
if (process.argv.includes("--print")) {
  for (const c of clusters.sort((a, b) => b.titles.length - a.titles.length)) {
    const rows = c.titles.reduce((n, t) => n + t.rows, 0);
    console.log(`  ${c.key}  (${c.titles.length} titles, ${rows} rows)  "${c.title}"`);
    for (const t of c.titles.slice(1)) console.log(`        · ${t.title}`);
  }
  console.log("");
}

console.log("Collapse");
// 167 titles for a product with a dozen flows. The bounds are wide on purpose:
// this asserts that identity collapses wording, not that a particular rule set
// produces a particular number.
check("the 167 titles collapse to fewer than 30 journeys", clusters.length < 30, `got ${clusters.length}`);
check("…and to more than 8 — collapsing everything would be just as wrong", clusters.length > 8, `got ${clusters.length}`);

console.log("\nAnchored journeys — one per app");
const anchorGroups = new Map<string, Set<string>>();
for (const row of fixture.rows) {
  const anchor = anchorOf(row.title);
  if (!anchor) continue;
  const key = keyOf(row.title);
  if (!key) continue;
  if (!anchorGroups.has(anchor)) anchorGroups.set(anchor, new Set());
  anchorGroups.get(anchor)!.add(key);
}
for (const [anchor, keys] of [...anchorGroups].sort()) {
  check(`every "${anchor}" title lands on one journey`, keys.size === 1, `${keys.size} journeys: ${[...keys].join(", ")}`);
}

console.log("\nJourneys that must stay apart");
const apart: Array<[string, string]> = [
  ["Sign up for a new account", "Log in to an existing account"],
  ["Sign up for a new account", "Reset forgotten password"],
  ["Install the Chrome extension for live interview hints", "Log in to existing account"],
  ["Configure insight preferences", "Browse tutorials"],
  ["Practice an interview with the AI coach", "Build and lock a Story answer"],
  ["Practice an interview with the AI coach", "Review past practice sessions"],
  ["Explore pricing and upgrade plan", "Explore tutorials"],
];
for (const [a, b] of apart) {
  const ka = keyOf(a);
  const kb = keyOf(b);
  check(`"${a}" ≠ "${b}"`, Boolean(ka) && Boolean(kb) && ka !== kb, `both → ${ka}`);
}

console.log("\nJourneys that must land together");
const together: Array<[string, string]> = [
  ["Sign up for a new account", "Account Registration"],
  ["Sign up for a new account", "New user signs up via email/password"],
  ["Log in to an existing account", "Sign in with email and password"],
  ["Log in to an existing account", "User Authentication (Log In)"],
  ["Install the Chrome extension for live interview hints", "Installing the Browser Extension"],
  ["Practice an interview with the AI coach", "Practice interviewing with an AI coach"],
  ["Practice an interview with the AI coach", "AI Interview Practice Session"],
  ["Build and lock a Story answer", "Story Building & Management"],
  ["Browse tutorials", "Explore Tutorials and Guides"],
  ["Configure insight preferences", "Configure Insight Preferences"],
];
for (const [a, b] of together) {
  const ka = keyOf(a);
  const kb = keyOf(b);
  check(`"${a}" = "${b}"`, Boolean(ka) && ka === kb, `${ka} vs ${kb}`);
}

console.log("\nStability");
// Resolving a title that is already in the catalog must return its entry, not
// create a new one — otherwise a journey's history restarts every run, which is
// the failure this whole change exists to end.
const unresolved = fixture.rows.filter((r) => !matchJourney(r.title, clusters));
check("every known title resolves against the finished catalog", unresolved.length === 0, `${unresolved.length} did not`);

// A journey's key must not depend on the wording that happened to arrive first.
const reversed = cluster([...fixture.rows].reverse());
check(
  "reversing the order the titles arrive in changes no journey count by more than 2",
  Math.abs(reversed.length - clusters.length) <= 2,
  `${clusters.length} forward vs ${reversed.length} reversed`,
);

console.log("\nMechanics");
check("titles normalise away decoration", normalizeTitle("Practice an interview (primary value action)") === "practice an interview", normalizeTitle("Practice an interview (primary value action)"));
check("stemming joins stories/story", tokenize("Build interview stories").includes("story"), tokenize("Build interview stories").join(" "));
check("an unanchored title still gets a key", journeyKey("Practice an interview with the AI coach").length > 0);
check("keys stay unique inside an app", journeyKey("Practice an interview", ["practic-interview"]) !== "practic-interview");
check("an anchor beats a token count", signatureOf("Sign up and practice an interview").anchor === "signup");

// CHE-247: a place the model invented must not outrank a title we have already
// agreed on. Every case here is a row production actually created.
console.log("\nA surface does not split a journey from its own history");
{
  // Run #197, live: the login journey had 21 walks, the alias "Sign in / sign
  // up via Clerk" and surface "/authenticated". The model proposed "Sign in /
  // OAuth through Clerk" on "/core" and got a second row.
  const login = {
    key: "login",
    title: "Authenticate and act on a verdict's findings",
    aliases: ["Authenticate and act on a verdict's findings", "Sign in / sign up via Clerk", "Sign in or create an account"],
    surface: "/authenticated",
  };
  check(
    "a known alias matches wherever the model says the journey lives",
    matchJourney("Sign in / sign up via Clerk", [login], "/core")?.key === "login",
    String(matchJourney("Sign in / sign up via Clerk", [login], "/core")?.key),
  );

  // The pair with byte-identical titles that production holds twice.
  const signup = { key: "signup", title: "Sign up via the free pricing CTA", surface: "/public" };
  check(
    "an identical title is the same journey even on a different surface",
    matchJourney("Sign up via the free pricing CTA", [signup], "/pricing")?.key === "signup",
    String(matchJourney("Sign up via the free pricing CTA", [signup], "/pricing")?.key),
  );

  // …and the reason surface exists at all still holds: joblander's /settings
  // carries three journeys that are NOT each other, and a merely similar title
  // on another surface must not fold into one of them.
  const settings = [
    { key: "settings", title: "Configure insight and coach preferences", surface: "/settings" },
    { key: "upload-resum", title: "Upload your resume", surface: "/settings" },
  ];
  check(
    "a similar title on a different surface is still a different journey",
    matchJourney("Upload your resume to the extension", settings, "/extension") === null,
    String(matchJourney("Upload your resume to the extension", settings, "/extension")?.key),
  );
  check(
    "…and on the same surface it still matches",
    matchJourney("Upload your resume", settings, "/settings")?.key === "upload-resum",
    String(matchJourney("Upload your resume", settings, "/settings")?.key),
  );
}

console.log("\nA surface is a place, not a sentence about one");
{
  check('"/pricing → /sign-up" is not a path', normalizeSurface("/pricing → /sign-up") === null, String(normalizeSurface("/pricing → /sign-up")));
  check('"/checkout -> /done" is not a path', normalizeSurface("/checkout -> /done") === null, String(normalizeSurface("/checkout -> /done")));
  check('"settings and billing" is not a path', normalizeSurface("settings and billing") === null, String(normalizeSurface("settings and billing")));
  check("a real path still is", normalizeSurface("/Settings/") === "/settings", String(normalizeSurface("/Settings/")));
  check("a full URL still reduces to its path", normalizeSurface("https://app.test/settings") === "/settings", String(normalizeSurface("https://app.test/settings")));
  check('"app" still means app-wide', normalizeSurface("app-wide") === "app", String(normalizeSurface("app-wide")));
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s)`}`);
process.exit(failures === 0 ? 0 : 1);
