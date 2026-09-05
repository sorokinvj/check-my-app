// CHE-132 verification: the page survey sees change and only change, and the
// full-run gate obeys the owner's rule.
//
// The rule (2026-09-03): a full walk happens when the app changed, never on the
// calendar once two snapshots can be compared; the seven-day fuse applies only
// when they cannot. Everything that decision rests on is deterministic and is
// exercised here without a network, a browser or a model: the HTML
// normalisation (nonces and timestamps drop out, build hashes stay in), link
// extraction (same-origin, no logout, no assets), the crawl's cap and deadline
// against a stub fetch that never runs out of links, the diff, the fingerprint,
// the gate, and what the smoke pass is handed.
//
// CHE-179 (2026-09-04): every real app has more than 50 pages, so every real
// survey was truncated, never compared, and the change-driven walk never
// fired. Two truncated surveys are now compared on the pages they share when
// they share enough (§9b), and the crawl order is checked to be a function of
// the site alone (§5), which is what makes "the pages they share" the same
// 50 pages every day.
//
// CHE-185 (2026-09-05): run #149 walked joblander.app in full because the raw
// HTML of every localised homepage differed from the day before — a live
// counter in the hero, re-rendered hourly per instance. The per-page hash is
// now a structural digest (§1b): what stays out of it (dates, counters,
// nonces, ids, attribute order, inline state) and what must still move it (a
// link, a heading, a field, a bundle, a copy edit) are both checked, with a
// fixture cut from the joblander hero. A previous snapshot hashed the old way
// is not comparable (§9c) and a survey whose homepage moved within the crawl
// is volatile, compared with text-only differences set aside (§9d).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-survey.ts

import {
  DIGEST_VERSION,
  diffSnapshots,
  describeDiff,
  diffIsChange,
  extractBuildId,
  extractBundles,
  extractLinks,
  fingerprintOf,
  normalizeHtml,
  pageDigest,
  pageHash,
  pageHashes,
  pathOverlap,
  stableText,
  surveyApp,
  type FetchLike,
  type SurveyPage,
} from "@/agent/survey";
import {
  applyVolatileRule,
  fullRunGate,
  isComparable,
  mergeSurveyedPages,
  parseStoredPages,
  serializeStoredPages,
  smokeTargetsFromSnapshot,
  surveyEvent,
  type SnapshotRecord,
} from "@/agent/snapshot";
import { detectTech } from "@/lib/tech-signals";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://target.test";

function html(body: string, head = ""): string {
  const title = /<title/i.test(head) ? "" : "<title>Target</title>";
  return `<!doctype html><html><head>${title}${head}</head><body>${body}</body></html>`;
}

function response(body: string, init: { status?: number; headers?: Record<string, string>; url?: string } = {}): Response {
  const res = new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });
  if (init.url) Object.defineProperty(res, "url", { value: init.url });
  return res;
}

// A stub fetch over a page table; unknown paths answer 404. Every request is
// logged so the tests can say what the crawler did and did not touch.
function stubFetch(
  pages: Record<string, string | (() => Response)>,
  log: string[],
  delayMs = 0,
): FetchLike {
  return async (url) => {
    log.push(url);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const u = new URL(url);
    const key = `${u.pathname}${u.search}`;
    const entry = pages[key] ?? pages[u.pathname];
    if (entry === undefined) return response("not found", { status: 404, url });
    if (typeof entry === "function") return entry();
    return response(entry, { url });
  };
}

function page(path: string, hash: string, status: number | null = 200): SurveyPage {
  return { url: `${ORIGIN}${path}`, path, status, title: path, hash, forms: 0, links: 0 };
}

function record(pages: SurveyPage[], extra: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    id: "snap",
    appSlug: "target.test",
    runId: null,
    takenAt: "2026-09-03T00:00:00.000Z",
    fingerprint: "",
    pages,
    bundles: [],
    buildId: null,
    tech: [],
    sitemapUrls: 0,
    blocked: false,
    truncated: false,
    digestVersion: DIGEST_VERSION,
    volatile: false,
    previousId: null,
    changed: null,
    diff: null,
    ...extra,
  };
}

// Every crawl below runs with the homepage recheck due immediately; §5c is the
// one place the 20-second rule itself is exercised, with a short delay.
const FAST = { homepageRecheckDelayMs: 0 };

async function main() {
  // 1 — normalisation: nonces, CSRF values, timestamps and churny inline
  // scripts go; hashed asset names and the Next.js build path stay.
  const a = html(
    `<script nonce="abc123">window.__t = "2026-09-03T10:00:00.000Z";</script>` +
      `<meta name="csrf-token" content="tok-1">` +
      `<form><input type="hidden" name="_token" value="v1"></form>` +
      `<div data-timestamp="1725350400">Hi</div>` +
      `<script src="/_next/static/chunks/main-abc123.js"></script>`,
  );
  const b = html(
    `<script nonce="zzz999">window.__t = "2026-09-04T11:22:33.000Z";</script>` +
      `<meta name="csrf-token" content="tok-2">` +
      `<form><input type="hidden" name="_token" value="v2"></form>` +
      `<div data-timestamp="1725436800">Hi</div>` +
      `<script src="/_next/static/chunks/main-abc123.js"></script>`,
  );
  check("nonce/csrf/timestamp differences hash equal", (await pageHash(a)) === (await pageHash(b)));
  const c = b.replace("main-abc123.js", "main-def456.js");
  check("a different asset hash hashes differently", (await pageHash(b)) !== (await pageHash(c)));
  const n1 = html(`<script src="/_next/static/BUILD-ONE/_buildManifest.js"></script>`);
  const n2 = html(`<script src="/_next/static/BUILD-TWO/_buildManifest.js"></script>`);
  check("a different /_next/static/<id>/ path hashes differently", (await pageHash(n1)) !== (await pageHash(n2)));
  check("build id read off the manifest path", extractBuildId(n1) === "BUILD-ONE", String(extractBuildId(n1)));
  check(
    "build id read off __NEXT_DATA__",
    extractBuildId(`<script id="__NEXT_DATA__">{"buildId":"xyz789","page":"/"}</script>`) === "xyz789",
  );
  check("whitespace runs collapse", normalizeHtml("<p>a   b\n\n c</p>") === "<p>a b c</p>", normalizeHtml("<p>a   b\n\n c</p>"));
  check(
    "content that actually changed still differs",
    (await pageHash(html("<h1>Pricing</h1>"))) !== (await pageHash(html("<h1>Pricing — new</h1>"))),
  );

  // 2 — links: same-origin only, no logout / api / assets / tokens, deduped.
  const linky = html(
    `<a href="/pricing">p</a><a href="/pricing#top">p</a><a href="https://target.test/docs/">d</a>` +
      `<a href="https://elsewhere.test/x">ext</a><a href="/logout">out</a><a href="/account/sign-out">out</a>` +
      `<a href="/api/users">api</a><a href="/brochure.pdf">pdf</a><a href="/logo.svg">svg</a>` +
      `<a href="mailto:a@b.c">m</a><a href="tel:123">t</a><a href="#">h</a>` +
      `<a href="/reset?token=abcdefghijklmnopqrstuvwxyz">tok</a><a href="/items?page=2">q</a>` +
      `<a href="/delete/42">del</a><a href="/unsubscribe">u</a><a href="/_next/image?url=x">img</a>`,
  );
  const links = extractLinks(linky, `${ORIGIN}/`).sort();
  check(
    "extractLinks: same-origin, filtered, deduped",
    JSON.stringify(links) ===
      JSON.stringify([`${ORIGIN}/docs`, `${ORIGIN}/items?page=2`, `${ORIGIN}/pricing`, `${ORIGIN}/reset`]),
    JSON.stringify(links),
  );

  // 3 — bundles: own scripts and first-party CDN, third parties out, sorted.
  const scripty = html(
    `<script src="/static/app.js?v=3"></script><script src="https://cdn.target.test/vendor.js"></script>` +
      `<script src="https://js.stripe.com/v3"></script><script src="https://www.googletagmanager.com/gtag.js"></script>` +
      `<script src="/static/app.js?v=3"></script>`,
  );
  const bundles = extractBundles(scripty, `${ORIGIN}/`);
  check(
    "extractBundles: own + sibling host, deduped, sorted, third parties out",
    JSON.stringify(bundles) === JSON.stringify([`https://cdn.target.test/vendor.js`, `${ORIGIN}/static/app.js?v=3`]),
    JSON.stringify(bundles),
  );

  // 4 — tech signals off headers + html, shared with the surface scan.
  const tech = detectTech({ "X-Powered-By": "Next.js", server: "Vercel" }, `<div id="__next"></div><script src="/_next/static/x.js">`);
  check("detectTech reads headers case-insensitively and html", JSON.stringify(tech) === JSON.stringify(["Next.js", "Vercel"]), JSON.stringify(tech));

  // 5 — the crawl: a link farm never runs out; the cap stops it at 50.
  const farm = (path: string) =>
    html(Array.from({ length: 10 }, (_, i) => `<a href="${path}${i}/">${i}</a>`).join(""));
  const farmPages: Record<string, string> = { "/": farm("/p") };
  for (let i = 0; i < 10; i++) {
    farmPages[`/p${i}`] = farm(`/p${i}-`);
    for (let j = 0; j < 10; j++) farmPages[`/p${i}-${j}`] = farm(`/p${i}-${j}-`);
  }
  const farmLog: string[] = [];
  const capped = await surveyApp(`${ORIGIN}/`, { fetch: stubFetch(farmPages, farmLog), ...FAST });
  check("cap: exactly 50 pages surveyed", capped.pages.length === 50, String(capped.pages.length));
  check("cap: reported as truncated", capped.truncated);
  check("cap: homepage is the first page, at path /", capped.pages[0].path === "/");
  check("cap: nothing off-list was requested but robots/sitemap", farmLog.filter((u) => /robots|sitemap/.test(u)).length === 2, String(farmLog.filter((u) => /robots|sitemap/.test(u)).length));
  check("cap: a fingerprint was computed", /^[0-9a-f]{64}$/.test(capped.fingerprint));

  // 5b — CHE-179: the crawl order is a function of the site alone. The same
  // farm crawled again — with the stub answering in a different order this
  // time — visits the same 50 pages in the same order. A site's stable first
  // 50 is what two truncated snapshots are compared on.
  const jitter = (delay: () => number): FetchLike => {
    const inner = stubFetch(farmPages, []);
    return async (url, init) => {
      await new Promise((r) => setTimeout(r, delay()));
      return inner(url, init);
    };
  };
  const again = await surveyApp(`${ORIGIN}/`, { fetch: jitter(() => Math.floor(Math.random() * 4)), ...FAST });
  const order = (r: { pages: SurveyPage[] }) => r.pages.map((p) => p.path);
  check("order: the same farm crawled twice gives the same 50 pages in the same order", JSON.stringify(order(capped)) === JSON.stringify(order(again)), order(again).slice(0, 5).join(" "));
  check("order: sitemap first, then homepage links in DOM order, then breadth-first", JSON.stringify(order(capped).slice(0, 12)) === JSON.stringify(["/", ...Array.from({ length: 10 }, (_, i) => `/p${i}`), "/p0-0"]), order(capped).slice(0, 12).join(" "));
  check("order: two truncated crawls of a stable site overlap fully", pathOverlap(capped.pages, again.pages) === 1);

  // The deadline: 30 ms per request, a 120 ms budget — the crawl stops well
  // short of the cap and keeps what it has.
  const slowLog: string[] = [];
  const timed = await surveyApp(`${ORIGIN}/`, {
    fetch: stubFetch(farmPages, slowLog, 30),
    deadlineMs: 120,
    ...FAST,
  });
  check("deadline: stopped before the cap", timed.pages.length > 0 && timed.pages.length < 50, String(timed.pages.length));
  check("deadline: reported as truncated", timed.truncated);

  // 6 — sitemap seeding, forms, titles, and the never-touch list under crawl.
  const siteLog: string[] = [];
  const site: Record<string, string | (() => Response)> = {
    "/": html(`<a href="/login">l</a><a href="/logout">x</a>`),
    "/robots.txt": () =>
      new Response(`User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } }),
    "/sitemap.xml": () =>
      new Response(
        `<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/pricing</loc></url><url><loc>${ORIGIN}/logout</loc></url><url><loc>https://elsewhere.test/</loc></url></urlset>`,
        { headers: { "content-type": "application/xml" } },
      ),
    "/pricing": html(`<h1>Pricing</h1>`, `<title>Pricing – Target</title>`),
    "/login": html(`<form></form><form></form>`, `<title>Sign in</title>`),
  };
  const surveyed = await surveyApp(`${ORIGIN}/`, { fetch: stubFetch(site, siteLog), ...FAST });
  const paths = surveyed.pages.map((p) => p.path).sort();
  check("sitemap + homepage links surveyed", JSON.stringify(paths) === JSON.stringify(["/", "/login", "/pricing"]), JSON.stringify(paths));
  check("sitemap URL count recorded (logout and off-origin excluded)", surveyed.sitemapUrls === 1, String(surveyed.sitemapUrls));
  check("/logout never requested", !siteLog.some((u) => u.includes("logout")));
  check("no request other than GET pages, robots and sitemap", siteLog.every((u) => u.startsWith(ORIGIN)));
  const login = surveyed.pages.find((p) => p.path === "/login");
  check("forms counted, title read", login?.forms === 2 && login.title === "Sign in", JSON.stringify(login));
  check("not blocked, not truncated", !surveyed.blocked && !surveyed.truncated);

  // 7 — a blocked homepage: nothing comparable was seen.
  for (const [name, res] of [
    ["403", () => response("forbidden", { status: 403 })],
    ["503 challenge", () => response(html("<h1>Just a moment...</h1>"), { status: 503 })],
    ["cf-mitigated header", () => response(html("ok"), { headers: { "cf-mitigated": "challenge" } })],
    ["Vercel protection", () => response(html(`<script src="/_vercel/protection/x.js"></script>`))],
    ["network error", () => { throw new Error("connect ECONNREFUSED"); }],
  ] as Array<[string, () => Response]>) {
    const blocked = await surveyApp(`${ORIGIN}/`, { fetch: stubFetch({ "/": res }, []), ...FAST });
    check(`blocked homepage (${name}) → blocked: true, no pages`, blocked.blocked && blocked.pages.length === 0);
  }

  // 8 — diff and fingerprint.
  const prev = { pages: [page("/", "h1"), page("/pricing", "h2"), page("/old", "h3")], bundles: ["a.js"], buildId: "b1" };
  const curr = { pages: [page("/", "h1"), page("/pricing", "h2x"), page("/new", "h4")], bundles: ["a.js", "b.js"], buildId: "b2" };
  const diff = diffSnapshots(prev, curr);
  check(
    "diffSnapshots: added / removed / changed / bundles / buildId",
    JSON.stringify(diff) ===
      JSON.stringify({ addedPaths: ["/new"], removedPaths: ["/old"], changedPaths: ["/pricing"], bundlesChanged: true, buildIdChanged: true }),
    JSON.stringify(diff),
  );
  const same = diffSnapshots(prev, { ...prev, pages: [...prev.pages].reverse(), bundles: ["a.js"] });
  check("diffSnapshots: identical in another order → no change", JSON.stringify(same) === JSON.stringify({ addedPaths: [], removedPaths: [], changedPaths: [], bundlesChanged: false, buildIdChanged: false }));
  const statusOnly = diffSnapshots({ pages: [page("/x", "h", 200)], bundles: [], buildId: null }, { pages: [page("/x", "h", 500)], bundles: [], buildId: null });
  check("diffSnapshots: a status change counts as changed", statusOnly.changedPaths.length === 1);
  const f1 = await fingerprintOf([page("/", "h1"), page("/p", "h2")], ["b.js", "a.js"]);
  const f2 = await fingerprintOf([page("/p", "h2"), page("/", "h1")], ["a.js", "b.js"]);
  const f3 = await fingerprintOf([page("/p", "h2"), page("/", "h1")], ["a.js"]);
  check("fingerprintOf is order-independent", f1 === f2);
  check("fingerprintOf sees a bundle change", f1 !== f3);

  // 9 — the gate: the owner's rule.
  const gate = (comparable: boolean, changed: boolean | null, age: number | null) =>
    fullRunGate({ comparable, changed, lastWalkAgeDays: age, maxAgeDays: 7, diff });
  check("gate: unchanged and 30 days old → not forced (the calendar is gone)", !gate(true, false, 30).force);
  check("gate: unchanged and 2 days → not forced", !gate(true, false, 2).force);
  const forced = gate(true, true, 1);
  check("gate: changed and 1 day → forced with the diff as reason", forced.force && forced.reason === "3 pages changed since the last check: /pricing, /new, /old", forced.force ? forced.reason : "not forced");
  const fuse = gate(false, null, 8);
  check("gate: not comparable and 8 days → forced by the fuse", fuse.force && /8 days ago/.test(fuse.reason), fuse.force ? fuse.reason : "not forced");
  check("gate: not comparable and 3 days → not forced", !gate(false, null, 3).force);
  check("gate: not comparable and no walk at all → not forced (other rungs decide)", !gate(false, null, null).force);
  check("gate: changed but reported not comparable → fuse rules, not the diff", !gate(false, true, 3).force);

  // 9b — CHE-179: a truncated survey IS comparable when the two share enough
  // pages; a page only one side reached is unknown, never added or removed.
  const full = record([page("/", "h")]);
  const cur = (pages: SurveyPage[], truncated = false, blocked = false) => ({ blocked, truncated, pages, digestVersion: DIGEST_VERSION });
  check("comparable: two complete unblocked snapshots", isComparable(full, cur([page("/", "h")])));
  check("comparable: complete pair with different page sets (no overlap rule)", isComparable(full, cur([page("/", "h"), page("/a", "h"), page("/b", "h"), page("/c", "h")])));
  check("not comparable: current blocked", !isComparable(full, cur([page("/", "h")], false, true)));
  check("not comparable: previous blocked", !isComparable(record([page("/", "h")], { blocked: true }), cur([page("/", "h")])));
  check("not comparable: no previous", !isComparable(null, cur([page("/", "h")])));
  const fifty = (prefix: string, from: number, n: number, hash = "h") => Array.from({ length: n }, (_, i) => page(`${prefix}${from + i}`, hash));
  const prevT = record(fifty("/p", 0, 50), { truncated: true });
  check("comparable: two truncated snapshots with the same 50 paths", isComparable(prevT, cur(fifty("/p", 0, 50), true)));
  check("comparable: 45 common + 5 different (90% overlap)", isComparable(prevT, cur([...fifty("/p", 0, 45), ...fifty("/q", 0, 5)], true)));
  check("not comparable: 30 common (60% overlap)", !isComparable(prevT, cur([...fifty("/p", 0, 30), ...fifty("/q", 0, 20)], true)));
  check("not comparable: previous truncated at 50, current complete at 12", !isComparable(prevT, cur(fifty("/p", 0, 12))));
  check("comparable: previous complete at 40, current truncated at 50 (80%)", isComparable(record(fifty("/p", 0, 40)), cur(fifty("/p", 0, 50), true)));
  check("pathOverlap: 45 of 50 → 0.9", pathOverlap(fifty("/p", 0, 50), [...fifty("/p", 0, 45), ...fifty("/q", 0, 5)]) === 0.9);
  const sameT = diffSnapshots({ ...prevT }, { pages: fifty("/p", 0, 50), bundles: [], buildId: null, truncated: true });
  check("diff: same 50 paths, both truncated → unchanged", JSON.stringify(sameT) === JSON.stringify({ addedPaths: [], removedPaths: [], changedPaths: [], bundlesChanged: false, buildIdChanged: false }), JSON.stringify(sameT));
  const shifted = diffSnapshots({ ...prevT }, { pages: [...fifty("/p", 0, 45), ...fifty("/q", 0, 5)], bundles: [], buildId: null, truncated: true });
  check("diff: 45 common + 5 different, both truncated → the 5 are neither added nor removed", shifted.addedPaths.length === 0 && shifted.removedPaths.length === 0 && shifted.changedPaths.length === 0, JSON.stringify(shifted));
  const contentT = diffSnapshots({ ...prevT }, { pages: [...fifty("/p", 0, 49), page("/p49", "h", 500)], bundles: [], buildId: null, truncated: true });
  check("diff: a status change on a common page still counts", JSON.stringify(contentT.changedPaths) === JSON.stringify(["/p49"]), JSON.stringify(contentT.changedPaths));
  const hashT = diffSnapshots({ ...prevT }, { pages: [page("/p0", "h-new"), ...fifty("/p", 1, 49)], bundles: [], buildId: null, truncated: true });
  check("diff: a hash change on a common page still counts", JSON.stringify(hashT.changedPaths) === JSON.stringify(["/p0"]));
  const grew = diffSnapshots({ pages: fifty("/p", 0, 40), bundles: [], buildId: null }, { pages: fifty("/p", 0, 50), bundles: [], buildId: null, truncated: true });
  check("diff: previous complete, current truncated → pages the previous never had ARE added", grew.addedPaths.length === 10 && grew.removedPaths.length === 0, JSON.stringify(grew.addedPaths.length));
  const shrank = diffSnapshots({ pages: fifty("/p", 0, 50), bundles: [], buildId: null, truncated: true }, { pages: fifty("/p", 0, 45), bundles: [], buildId: null });
  check("diff: previous truncated, current complete → pages the current lacks ARE removed, nothing added", shrank.removedPaths.length === 5 && shrank.addedPaths.length === 0);
  const farmAgainComparable = isComparable(record(capped.pages, { truncated: true }), again);
  check("the 50-page link farm survey is comparable with its own repeat", farmAgainComparable);
  check("… and unchanged", !fullRunGate({ comparable: farmAgainComparable, changed: false, lastWalkAgeDays: 30, maxAgeDays: 7 }).force);
  const lowOverlap = isComparable(prevT, cur([...fifty("/p", 0, 30), ...fifty("/q", 0, 20)], true));
  check("low overlap → changed stays null → gate not forced at 3 days", !fullRunGate({ comparable: lowOverlap, changed: null, lastWalkAgeDays: 3, maxAgeDays: 7 }).force);
  check("low overlap → gate forced at 8 days by the fuse", fullRunGate({ comparable: lowOverlap, changed: null, lastWalkAgeDays: 8, maxAgeDays: 7 }).force);

  // 10 — smoke targets from a snapshot: served pages only, homepage out.
  const targets = smokeTargetsFromSnapshot(
    record([page("/", "h"), page("/pricing", "h"), page("/gone", "h", 404), page("/down", "h", 500), page("/dead", "", null), page("/docs/", "h")]),
    `${ORIGIN}/`,
  );
  check("smokeTargetsFromSnapshot: < 400 only, homepage excluded, normalised", JSON.stringify(targets) === JSON.stringify([`${ORIGIN}/pricing`, `${ORIGIN}/docs`]), JSON.stringify(targets));
  check("smokeTargetsFromSnapshot: nothing without a snapshot", smokeTargetsFromSnapshot(null, `${ORIGIN}/`).length === 0);

  // 11 — the anatomy merge: coverage.ts's label shape, no duplicates, capped.
  const merged = mergeSurveyedPages(
    ["Login (`/login`)", "/pricing  (Pricing page)"],
    { snapshot: record([page("/", "h"), page("/login", "h"), page("/pricing", "h"), { ...page("/docs", "h"), title: "Docs (Guide)" }, page("/404", "h", 404)]), previous: null, comparable: false },
  );
  check("mergeSurveyedPages: adds only unmentioned served pages in label shape", JSON.stringify(merged) === JSON.stringify(["Login (`/login`)", "/pricing  (Pricing page)", "Docs Guide (`/docs`)"]), JSON.stringify(merged));
  const many = record(Array.from({ length: 60 }, (_, i) => page(`/p${i}`, "h")));
  check("mergeSurveyedPages: capped at 40", mergeSurveyedPages([], { snapshot: many, previous: null, comparable: false }).length === 40);
  check("mergeSurveyedPages: no snapshot → unchanged", JSON.stringify(mergeSurveyedPages(["a"], null)) === JSON.stringify(["a"]));

  // 12 — the feed line speaks about their pages only.
  const lines = [
    surveyEvent({ snapshot: null, previous: null, comparable: false }).text,
    surveyEvent({ snapshot: record([page("/", "h")]), previous: null, comparable: false }).text,
    surveyEvent({ snapshot: record([page("/", "h"), page("/a", "h")], { changed: false }), previous: record([]), comparable: true }).text,
    surveyEvent({ snapshot: record([page("/", "h")], { changed: true, diff }), previous: record([]), comparable: true }).text,
    surveyEvent({ snapshot: record(fifty("/p", 0, 50), { truncated: true, changed: null }), previous: record([]), comparable: false }).text,
    surveyEvent({ snapshot: record(fifty("/p", 0, 50), { truncated: true, changed: false }), previous: record([]), comparable: true }).text,
    surveyEvent({ snapshot: record(fifty("/p", 0, 50), { truncated: true, changed: true, diff: { ...diff, addedPaths: [], removedPaths: [] } }), previous: record([]), comparable: true }).text,
    surveyEvent({ snapshot: record(fifty("/p", 0, 50), { truncated: true }), previous: null, comparable: false }).text,
  ];
  check("feed: could not survey", lines[0] === "Could not survey the pages this run", lines[0]);
  check("feed: first snapshot", lines[1] === "Surveyed 1 page — first snapshot of this app", lines[1]);
  check("feed: nothing changed", lines[2] === "Surveyed 2 pages — nothing changed since the last check", lines[2]);
  check("feed: changed, with paths", lines[3] === "Surveyed 1 page — 3 pages changed since the last check: /pricing, /new, /old", lines[3]);
  check("feed: truncated, not comparable", lines[4] === "Surveyed 50 pages (the first 50 of a larger site) — more pages than could be compared this run", lines[4]);
  check("feed: truncated, comparable, unchanged (CHE-179)", lines[5] === "Surveyed 50 pages (the first 50 of a larger site) — nothing changed since the last check", lines[5]);
  check("feed: truncated, comparable, changed (CHE-179)", lines[6] === "Surveyed 50 pages (the first 50 of a larger site) — 1 page changed since the last check: /pricing", lines[6]);
  check("feed: truncated, first snapshot", lines[7] === "Surveyed 50 pages (the first 50 of a larger site) — first snapshot of this app", lines[7]);
  check("feed: no crawler mechanics leak", !lines.some((l) => /fetch|crawl|hash|sitemap|headless|browser/i.test(l)));

  // ─── CHE-185 ───────────────────────────────────────────────────────────────

  // 1b — the structural digest. One page in many per-request disguises must
  // hash the same; one real change of each kind must not.
  const stable = (mid: string, head = "") =>
    html(
      `<header><a href="/pricing">Pricing</a><a href="/docs#intro">Docs</a></header>` +
        `<main><h1>Welcome home</h1><p>Hello there, friend.</p>${mid}` +
        `<form><input name="email" type="email"><input type="checkbox" name="tos"><button>Go</button></form></main>` +
        `<script src="/static/app-abc123.js?v=1"></script><link rel="stylesheet" href="/static/site-def456.css">`,
      head,
    );
  const sameHash = async (name: string, a: string, b: string) =>
    check(`digest: ${name} → same hash`, (await pageHash(a, `${ORIGIN}/`)) === (await pageHash(b, `${ORIGIN}/`)), pageDigest(b, `${ORIGIN}/`).split("\n").find((l) => l.startsWith("text:")) ?? "");
  const otherHash = async (name: string, a: string, b: string) =>
    check(`digest: ${name} → different hash`, (await pageHash(a, `${ORIGIN}/`)) !== (await pageHash(b, `${ORIGIN}/`)));
  const origin = stable(`<p>Updated Sep 5, 2026 at 15:30 — 1,234 users, 17 teams</p><div data-id="a1b2c3">x</div>`, `<script nonce="n-one">window.__s = {"id":"req-111"}</script>`);
  await sameHash("a nonce", origin, origin.replace("n-one", "n-two"));
  await sameHash('a date "Sep 5, 2026"', origin, origin.replace("Sep 5, 2026", "Oct 12, 2027"));
  await sameHash("an ISO timestamp", stable(`<p>as of 2026-09-05T16:31:00Z</p>`), stable(`<p>as of 2026-09-06T09:02:11.123+02:00</p>`));
  await sameHash('a clock time "15:30"', origin, origin.replace("15:30", "09:05"));
  await sameHash('a counter "1,234 users"', origin, origin.replace("1,234 users", "1,301 users"));
  await sameHash("a plain number", origin, origin.replace("17 teams", "9 teams"));
  await sameHash("a random data-id", origin, origin.replace('data-id="a1b2c3"', 'data-id="z9y8x7"'));
  await sameHash("attribute order", origin, origin.replace('<input name="email" type="email">', '<input type="email" name="email">').replace('<a href="/pricing">', '<a class="nav" href="/pricing">'));
  await sameHash("a link fragment", origin, origin.replace("/docs#intro", "/docs#usage"));
  await sameHash("an inline __NEXT_DATA__ blob with other ids", stable(`<script id="__NEXT_DATA__" type="application/json">{"props":{"reqId":"aaa","ts":1725500000}}</script>`), stable(`<script id="__NEXT_DATA__" type="application/json">{"props":{"reqId":"bbb","ts":1725586400}}</script>`));
  await sameHash("an inline script with a per-request id", stable(`<script>window.__id="one"</script>`), stable(`<script>window.__id="two"</script>`));
  await sameHash("a script query string", origin, origin.replace("app-abc123.js?v=1", "app-abc123.js?v=2"));
  await sameHash("whitespace and comments", origin, origin.replace("<p>Hello there, friend.</p>", "<p>Hello   there,\n<!-- x -->friend.</p>"));
  await otherHash("a new link", origin, origin.replace("</header>", `<a href="/blog">Blog</a></header>`));
  await otherHash("a removed link", origin, origin.replace(`<a href="/docs#intro">Docs</a>`, ""));
  await otherHash("a changed heading", origin, origin.replace("Welcome home", "Welcome back"));
  await otherHash("a new form field", origin, origin.replace("</form>", `<input name="phone" type="tel"></form>`));
  await otherHash("a field type change", origin, origin.replace('<input name="email" type="email">', '<input name="email" type="text">'));
  await otherHash("a renamed script bundle", origin, origin.replace("app-abc123.js", "app-def456.js"));
  await otherHash("a renamed stylesheet", origin, origin.replace("site-def456.css", "site-999999.css"));
  await otherHash("a copy edit", origin, origin.replace("Hello there, friend.", "Hello there, stranger."));
  await otherHash("a changed title", origin, origin.replace("<title>Target</title>", "<title>Target — new</title>"));
  await otherHash("a changed meta description", stable("", `<meta name="description" content="One">`), stable("", `<meta content="Two" name="description">`));
  await otherHash("a new button", origin, origin.replace("<button>Go</button>", "<button>Go</button><button>Reset</button>"));
  check("digest: text is taken from <main> when there is one", !pageDigest(origin).includes("Pricing Docs"), pageDigest(origin).split("\n").pop() ?? "");
  check("digest: links are absolute, sorted, unique, fragment-free", JSON.stringify(pageDigest(origin, `${ORIGIN}/x/`).split("\n").filter((l) => l.startsWith("a:"))) === JSON.stringify([`a:${ORIGIN}/docs`, `a:${ORIGIN}/pricing`]), JSON.stringify(pageDigest(origin, `${ORIGIN}/x/`).split("\n").filter((l) => l.startsWith("a:"))));
  check("digest: form fields in document order as tag|name|type", pageDigest(origin).includes("field:input|email|email\nfield:input|tos|checkbox"));
  check("digest: assets without query strings", pageDigest(origin).includes("asset:/static/app-abc123.js\nasset:/static/site-def456.css"));
  check("digest: control counts", pageDigest(origin).includes("buttons:1\ninputs:2"));
  const dated = "<p>Sep 5, 2026 · 5 September 2026 · Friday, March 24, 2026 · 2026-09-05 · 05/09/2026 · 15:30 · 4:05 pm · 1,234 users · v2.1 · 12 345</p>";
  check("stableText: dates, times and numbers gone, words intact", stableText(dated) === "· · · · · · · users · v ·", JSON.stringify(stableText(dated)));
  check("stableText: a month name outside a date is text", stableText("<p>May I decorate in March</p>") === "May I decorate in March", stableText("<p>May I decorate in March</p>"));
  const hashes = await pageHashes(origin, `${ORIGIN}/`);
  check("pageHashes: hash, rawHash and skeletonHash are three different sha256s", /^[0-9a-f]{64}$/.test(hashes.hash) && /^[0-9a-f]{64}$/.test(hashes.rawHash) && /^[0-9a-f]{64}$/.test(hashes.skeletonHash) && new Set([hashes.hash, hashes.rawHash, hashes.skeletonHash]).size === 3);
  check("pageHashes: rawHash is the old normalised-HTML hash and still moves with a counter", hashes.rawHash !== (await pageHashes(origin.replace("1,234 users", "1,301 users"), `${ORIGIN}/`)).rawHash);
  check("pageHashes: skeletonHash ignores a copy edit", hashes.skeletonHash === (await pageHashes(origin.replace("friend.", "stranger."), `${ORIGIN}/`)).skeletonHash);
  check("pageHashes: skeletonHash sees a new link", hashes.skeletonHash !== (await pageHashes(origin.replace("</header>", `<a href="/blog">B</a></header>`), `${ORIGIN}/`)).skeletonHash);
  check("pageHashes: skeletonHash sees a renamed bundle", hashes.skeletonHash !== (await pageHashes(origin.replace("app-abc123.js", "app-def456.js"), `${ORIGIN}/`)).skeletonHash);

  // 1c — the joblander shape (run #149). Two real renders of
  // https://joblander.app/ on 2026-09-05 (etags zt094t3lma48aj at 17:17 and
  // q1367t6xwx48aj at 17:43, 197,677 chars both) differed in exactly one
  // fragment, inside an inline flight-data script: the initialCanonicalUrl
  // carried the _rsc cache-buster of whichever request had triggered that ISR
  // regeneration. The fixture is that script, verbatim in shape, inside the
  // page's chrome, plus the hero's live figure — the other thing on the page
  // that moves the bytes. Two renders must hash the same; a copy edit, a
  // bundle rename or a build id change must not.
  const joblander = (rsc: string, figure = "169,500", copy = "insights delivered this month", buildId = "KsTYig8L1zpL2GwSgPCrL") =>
    `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>JobLander – AI Interview Copilot</title>` +
    `<meta name="description" content="Real-time AI hints during your job interview."/>` +
    `<script src="/_next/static/chunks/webpack-3b051936b880caf9.js" async=""></script>` +
    `<script src="/_next/static/chunks/main-app-a8c44041507ebd1f.js" async=""></script></head>` +
    `<body class="__className_44151c notranslate"><!--$!--><template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"></template><!--/$-->` +
    `<header class="flex justify-between w-full"><nav><a href="/">Home</a><a href="/practice">Practice</a><a href="/pricing">Pricing</a></nav>` +
    `<button data-href="/signup" data-label="Create account">Create account</button></header>` +
    `<main class="flex flex-col gap-20"><h1 class="font-semibold text-4xl">Your ultimate<br/>job interview co-pilot</h1>` +
    `<p class="max-w-2xl text-lg">Real-time hints during your actual interview.</p>` +
    `<div class="flex flex-col items-center gap-0.5 text-center"><p class="font-mono text-[11px] uppercase">Real interview hints, delivered in real time</p>` +
    `<p class="text-sm text-slate-500"><span class="font-semibold text-accent">${figure}</span> <!-- -->${copy}</p></div>` +
    `<h2>How it works in a real interview</h2></main>` +
    `<footer>© 2026 JobLander</footer>` +
    `<script>self.__next_f.push([1,"0:[null,[\\"$\\",\\"$La\\",null,{\\"buildId\\":\\"${buildId}\\",\\"assetPrefix\\":\\"\\",\\"initialCanonicalUrl\\":\\"/?_rsc=${rsc}\\",\\"initialTree\\":[\\"\\",{\\"children\\":[[\\"lang\\",\\"en\\",\\"d\\"]]}]}]]\\n"])</script>` +
    `<script>self.__next_f.push([1,"3:I[1234,[\\"9946\\"],\\"\\"]\\n"])</script>` +
    `<script>self.__next_f.push([1,"5:[\\"$\\",\\"$L6\\",null,{\\"figure\\":\\"${figure}\\"}]\\n"])</script></body></html>`;
  const jl1 = joblander("p18k4");
  const jlRsc = joblander("1j6xg");
  const jl2 = joblander("p18k4", "171,000");
  check("joblander: the two real renders' shape — a different _rsc in the flight data — hash the same", (await pageHash(jl1, "https://joblander.app/")) === (await pageHash(jlRsc, "https://joblander.app/")));
  check("joblander: … while the old hash moved on it (this is what run #149 compared)", (await pageHashes(jl1, "https://joblander.app/")).rawHash !== (await pageHashes(jlRsc, "https://joblander.app/")).rawHash);
  check("joblander: two renders with a different hero counter hash the same", (await pageHash(jl1, "https://joblander.app/")) === (await pageHash(jl2, "https://joblander.app/")), pageDigest(jl2, "https://joblander.app/").split("\n").pop() ?? "");
  check("joblander: the old hash moved on the counter too", (await pageHashes(jl1, "https://joblander.app/")).rawHash !== (await pageHashes(jl2, "https://joblander.app/")).rawHash);
  check("joblander: the App Router build id is read off the escaped flight data", extractBuildId(jl1) === "KsTYig8L1zpL2GwSgPCrL", String(extractBuildId(jl1)));
  check("joblander: a new build id (a deploy) is a different build id", extractBuildId(joblander("p18k4", "169,500", "insights delivered this month", "NEWBUILD0000000000000")) === "NEWBUILD0000000000000");
  check("joblander: the counter's line survives as words", pageDigest(jl1).includes("insights delivered this month") && !/\d/.test(pageDigest(jl1).split("\n").pop() ?? "x"));
  check("joblander: a copy edit on the same line still changes the hash", (await pageHash(jl1, "https://joblander.app/")) !== (await pageHash(joblander("169,500", "answers delivered this month"), "https://joblander.app/")));
  check("joblander: a new bundle name (a deploy) still changes the hash", (await pageHash(jl1)) !== (await pageHash(jl1.replace("main-app-a8c44041507ebd1f", "main-app-0000000000000000"))));

  // 5c — the homepage recheck: a second homepage fetch at least
  // homepageRecheckDelayMs after the first, skipped when the deadline could
  // not hold it. A stub whose skeleton moves on every request is volatile; a
  // stub whose only movement is a counter is not — the digest absorbed it.
  const stamps: Array<{ url: string; at: number }> = [];
  let hits = 0;
  const churny = (skeletonMoves: boolean): FetchLike => async (url) => {
    stamps.push({ url, at: Date.now() });
    const u = new URL(url);
    if (u.pathname !== "/") return response("not found", { status: 404, url });
    hits += 1;
    const body = skeletonMoves
      ? html(`<h1>Home</h1><a href="/promo-${hits}">now</a><p>${hits * 100} visitors</p>`)
      : html(`<h1>Home</h1><a href="/promo">now</a><p>${hits * 100} visitors</p>`);
    return response(body, { url });
  };
  const counted = await surveyApp(`${ORIGIN}/`, { fetch: churny(false), homepageRecheckDelayMs: 60 });
  const homeHits = stamps.filter((s) => s.url === `${ORIGIN}/`);
  check("recheck: the homepage was fetched twice", homeHits.length === 2, String(homeHits.length));
  check("recheck: the second fetch came at least 60 ms after the first", homeHits.length === 2 && homeHits[1].at - homeHits[0].at >= 60, homeHits.length === 2 ? `${homeHits[1].at - homeHits[0].at} ms` : "");
  check("recheck: a moving counter alone is not volatile", !counted.volatile && counted.digestVersion === DIGEST_VERSION);
  check("recheck: the snapshot keeps what the crawl saw first (one homepage row)", counted.pages.filter((p) => p.path === "/").length === 1);
  stamps.length = 0;
  hits = 0;
  const moving = await surveyApp(`${ORIGIN}/`, { fetch: churny(true), ...FAST });
  check("recheck: a homepage whose link set moves between fetches is volatile", moving.volatile);
  stamps.length = 0;
  hits = 0;
  const noRoom = await surveyApp(`${ORIGIN}/`, { fetch: churny(true), homepageRecheckDelayMs: 5_000, deadlineMs: 200, requestTimeoutMs: 50 });
  check("recheck: skipped when the deadline cannot hold it (one homepage fetch, not volatile)", stamps.filter((s) => s.url === `${ORIGIN}/`).length === 1 && !noRoom.volatile);
  check("survey result carries digestVersion and rawHash/skeletonHash per page", surveyed.digestVersion === DIGEST_VERSION && surveyed.pages.every((p) => /^[0-9a-f]{64}$/.test(p.rawHash ?? "") && /^[0-9a-f]{64}$/.test(p.skeletonHash ?? "")));

  // 9c — compatibility: a previous snapshot hashed the old way is not
  // comparable, the fuse decides for that one day, and the feed says so in
  // terms of their pages.
  const oldRow = record([page("/", "old-h")], { digestVersion: 1 });
  check("not comparable: previous snapshot has digest v1", !isComparable(oldRow, cur([page("/", "new-h")])));
  check("comparable: previous snapshot has the current digest version", isComparable(record([page("/", "h")]), cur([page("/", "h")])));
  const v1Line = surveyEvent({ snapshot: record([page("/", "h"), page("/a", "h")]), previous: oldRow, comparable: false }).text;
  check("feed: first snapshot with the new digest speaks of a baseline, not of digests", v1Line === "Surveyed 2 pages — a new baseline for this app; changes are reported from the next check", v1Line);
  check("feed: … and leaks nothing", !/digest|hash|version|fetch|crawl/i.test(v1Line));
  check("gate: v1 previous at 3 days → not forced (the fuse, not a diff)", !fullRunGate({ comparable: false, changed: null, lastWalkAgeDays: 3, maxAgeDays: 7 }).force);
  check("gate: v1 previous at 8 days → the fuse fires", fullRunGate({ comparable: false, changed: null, lastWalkAgeDays: 8, maxAgeDays: 7 }).force);
  const bare = parseStoredPages(JSON.stringify([page("/", "h")]));
  check("stored pages: a bare array (pre-2026-09-05 row) parses as digest v1, not volatile", bare.digestVersion === 1 && !bare.volatile && bare.pages.length === 1);
  const envelope = parseStoredPages(serializeStoredPages({ digestVersion: DIGEST_VERSION, volatile: true, pages: [page("/", "h")] }));
  check("stored pages: the envelope round-trips", envelope.digestVersion === DIGEST_VERSION && envelope.volatile && envelope.pages[0].hash === "h");
  check("stored pages: garbage parses as an empty v1", parseStoredPages("nope").pages.length === 0 && parseStoredPages("nope").digestVersion === 1);

  // 9d — the volatile rule, as defined in snapshot.ts: on a volatile side, a
  // changed page with the same status and the same skeletonHash on both sides
  // is set aside; anything else stays a change.
  const sk = (path: string, hash: string, skeletonHash: string | undefined, status: number | null = 200): SurveyPage => ({ ...page(path, hash, status), skeletonHash });
  const vPrev = { volatile: false, pages: [sk("/", "h1", "s1"), sk("/a", "h2", "s2"), sk("/b", "h3", "s3"), sk("/c", "h4", "s4"), sk("/old", "h5", undefined)] };
  const vCurr = { volatile: true, pages: [sk("/", "h1x", "s1"), sk("/a", "h2x", "s2-moved"), sk("/b", "h3x", "s3", 500), sk("/c", "h4", "s4"), sk("/old", "h5x", undefined)] };
  const vDiff = diffSnapshots({ ...vPrev, bundles: [], buildId: null }, { ...vCurr, bundles: ["new.js"], buildId: null });
  const ruled = applyVolatileRule(vPrev, vCurr, vDiff);
  check("volatile: text-only change (same status, same skeleton) is set aside", JSON.stringify(ruled.ignored) === JSON.stringify(["/"]), JSON.stringify(ruled.ignored));
  check("volatile: a skeleton change stays a change", ruled.diff.changedPaths.includes("/a"));
  check("volatile: a status change stays a change", ruled.diff.changedPaths.includes("/b"));
  check("volatile: a page without a skeletonHash on one side stays a change", ruled.diff.changedPaths.includes("/old"));
  check("volatile: an unchanged page is neither", !ruled.diff.changedPaths.includes("/c") && !ruled.ignored.includes("/c"));
  check("volatile: ignored paths are recorded on the diff, bundles untouched", JSON.stringify(ruled.diff.ignoredPaths) === JSON.stringify(["/"]) && ruled.diff.bundlesChanged);
  const onlyText = applyVolatileRule(vPrev, { volatile: true, pages: [sk("/", "h1x", "s1")] }, diffSnapshots({ pages: vPrev.pages.slice(0, 1), bundles: [], buildId: null }, { pages: [sk("/", "h1x", "s1")], bundles: [], buildId: null }));
  check("volatile: when only text moved, the snapshot is unchanged", !diffIsChange(onlyText.diff) && onlyText.diff.changedPaths.length === 0, JSON.stringify(onlyText.diff));
  check("volatile: describeDiff does not list the set-aside pages", describeDiff(onlyText.diff) === "nothing changed since the last check", describeDiff(onlyText.diff));
  const calm = applyVolatileRule({ ...vPrev, volatile: false }, { ...vCurr, volatile: false }, vDiff);
  check("not volatile: the same diff is left exactly as it was", calm.ignored.length === 0 && calm.diff === vDiff);
  const prevVolatile = applyVolatileRule({ ...vPrev, volatile: true }, { ...vCurr, volatile: false }, vDiff);
  check("volatile on the previous side alone also applies the rule", JSON.stringify(prevVolatile.ignored) === JSON.stringify(["/"]));
  check("volatile snapshots are still comparable", isComparable(record(vPrev.pages, { volatile: true }), { ...cur(vCurr.pages), digestVersion: DIGEST_VERSION }));

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
