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
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-survey.ts

import {
  diffSnapshots,
  extractBuildId,
  extractBundles,
  extractLinks,
  fingerprintOf,
  normalizeHtml,
  pageHash,
  surveyApp,
  type FetchLike,
  type SurveyPage,
} from "@/agent/survey";
import {
  fullRunGate,
  isComparable,
  mergeSurveyedPages,
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
    previousId: null,
    changed: null,
    diff: null,
    ...extra,
  };
}

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
  const capped = await surveyApp(`${ORIGIN}/`, { fetch: stubFetch(farmPages, farmLog) });
  check("cap: exactly 50 pages surveyed", capped.pages.length === 50, String(capped.pages.length));
  check("cap: reported as truncated", capped.truncated);
  check("cap: homepage is the first page, at path /", capped.pages[0].path === "/");
  check("cap: nothing off-list was requested but robots/sitemap", farmLog.filter((u) => /robots|sitemap/.test(u)).length === 2, String(farmLog.filter((u) => /robots|sitemap/.test(u)).length));
  check("cap: a fingerprint was computed", /^[0-9a-f]{64}$/.test(capped.fingerprint));

  // The deadline: 30 ms per request, a 120 ms budget — the crawl stops well
  // short of the cap and keeps what it has.
  const slowLog: string[] = [];
  const timed = await surveyApp(`${ORIGIN}/`, {
    fetch: stubFetch(farmPages, slowLog, 30),
    deadlineMs: 120,
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
  const surveyed = await surveyApp(`${ORIGIN}/`, { fetch: stubFetch(site, siteLog) });
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
    const blocked = await surveyApp(`${ORIGIN}/`, { fetch: stubFetch({ "/": res }, []) });
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

  // 9b — a truncated survey is not comparable: unvisited pages are unknown,
  // not removed, so the fuse rules and never the diff.
  const full = record([page("/", "h")]);
  check("comparable: two complete unblocked snapshots", isComparable(full, { blocked: false, truncated: false }));
  check("not comparable: current truncated", !isComparable(full, { blocked: false, truncated: true }));
  check("not comparable: current blocked", !isComparable(full, { blocked: true, truncated: false }));
  check("not comparable: previous truncated", !isComparable(record([], { truncated: true }), { blocked: false, truncated: false }));
  check("not comparable: no previous", !isComparable(null, { blocked: false, truncated: false }));
  const truncatedNow = isComparable(full, capped);
  check("the 50-page link farm survey is not comparable", !truncatedNow);
  check("truncated current → changed stays null → gate not forced at 3 days", !fullRunGate({ comparable: truncatedNow, changed: null, lastWalkAgeDays: 3, maxAgeDays: 7 }).force);
  check("truncated current → gate forced at 8 days by the fuse", fullRunGate({ comparable: truncatedNow, changed: null, lastWalkAgeDays: 8, maxAgeDays: 7 }).force);

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
    surveyEvent({ snapshot: record(Array.from({ length: 50 }, (_, i) => page(`/p${i}`, "h")), { truncated: true }), previous: record([]), comparable: false }).text,
  ];
  check("feed: could not survey", lines[0] === "Could not survey the pages this run", lines[0]);
  check("feed: first snapshot", lines[1] === "Surveyed 1 page — first snapshot of this app", lines[1]);
  check("feed: nothing changed", lines[2] === "Surveyed 2 pages — nothing changed since the last check", lines[2]);
  check("feed: changed, with paths", lines[3] === "Surveyed 1 page — 3 pages changed since the last check: /pricing, /new, /old", lines[3]);
  check("feed: truncated", lines[4] === "Surveyed 50 pages — more pages than could be compared this run", lines[4]);
  check("feed: no crawler mechanics leak", !lines.some((l) => /fetch|crawl|hash|sitemap|headless|browser/i.test(l)));

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
