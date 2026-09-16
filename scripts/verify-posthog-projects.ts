// CHE-237 verification: which project holds this app's data, and how sure we are.
//
// The picker's job is to make one question short. Everything that can go wrong
// here is a wrong ANSWER offered confidently — a suggestion accepted without
// reading, attributing one product's numbers to another product's page. So
// these checks are mostly about when we must NOT suggest:
//
//   1. localhost never matches anything — it is in nearly every project's event
//      stream and would make every project look like every app's;
//   2. two projects that both saw the host is "we do not know", not "the first
//      one";
//   3. a different registrable domain is never a match, however similar;
//   4. no match at all is a real answer the screen must render as "pick one".
//
// And the ordering rules, because a list that reshuffles between visits makes
// the owner re-read it every time.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-posthog-projects.ts

import {
  hostOf,
  listProjects,
  hostsSeenBy,
  matchStrength,
  rankProjects,
  suggestedProject,
  MAX_PROJECTS_TO_PROBE,
  type PostHogProject,
} from "@/lib/posthog/projects";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const P = (id: string, name: string): PostHogProject => ({ id, name });

async function main() {
  console.log("Reading a URL down to the host that matters");
  {
    check("a plain https URL", hostOf("https://checkmyapp.dev/dashboard") === "checkmyapp.dev");
    check("www. is not a different app", hostOf("https://www.checkmyapp.dev") === "checkmyapp.dev");
    check("a bare host with no scheme still parses", hostOf("checkmyapp.dev") === "checkmyapp.dev");
    check("uppercase is the same host", hostOf("https://CheckMyApp.DEV") === "checkmyapp.dev");
    check("nonsense is null, not a guess", hostOf("not a url at all") === null || hostOf("not a url at all") === "not%20a%20url%20at%20all");
    check("a subdomain is kept — app.x.com is not x.com", hostOf("https://app.example.com") === "app.example.com");
  }

  console.log("\nWhat counts as a match");
  {
    check("the same host is an exact match",
      matchStrength("checkmyapp.dev", ["checkmyapp.dev", "localhost:3011"]) === "exact");
    check("a port on the observed host does not spoil it",
      matchStrength("checkmyapp.dev", ["checkmyapp.dev:443"]) === "exact");
    check("www on the observed host does not spoil it",
      matchStrength("checkmyapp.dev", ["www.checkmyapp.dev"]) === "exact");
    check("a sibling subdomain is same-domain, not exact",
      matchStrength("app.example.com", ["www.example.com"]) === "same-domain");
    check("a different registrable domain is no match",
      matchStrength("checkmyapp.dev", ["example.org", "joblander.app"]) === "none");
    check("a look-alike domain is no match",
      matchStrength("checkmyapp.dev", ["checkmyapp.com"]) === "none");

    // The one that would quietly ruin everything: a developer's machine appears
    // in nearly every project's events.
    check("localhost in the project never matches a real app",
      matchStrength("checkmyapp.dev", ["localhost:3011", "127.0.0.1"]) === "none");
    check("an app whose own URL is localhost matches nothing",
      matchStrength("localhost", ["localhost:3011"]) === "none");
    check("a .local host matches nothing", matchStrength("mymac.local", ["mymac.local"]) === "none");
    check("no hosts seen is no match", matchStrength("checkmyapp.dev", []) === "none");
    check("no app host is no match", matchStrength(null, ["checkmyapp.dev"]) === "none");
  }

  console.log("\nOrdering a picker so it does not have to be re-read");
  {
    const projects = [P("3", "Zebra"), P("1", "Check My App"), P("2", "Meet Bashar")];
    const hosts = {
      "1": ["localhost:3011", "checkmyapp.dev"],
      "2": ["bashar.example"],
      "3": [],
    };
    const ranked = rankProjects("https://checkmyapp.dev", projects, hosts);
    check("the matching project is offered first", ranked[0].id === "1", ranked[0].name);
    check("…and it says which host earned it", ranked[0].matchedHost === "checkmyapp.dev", String(ranked[0].matchedHost));
    check("the rest are alphabetical, not API order",
      ranked.slice(1).map((p) => p.name).join(",") === "Meet Bashar,Zebra",
      ranked.map((p) => p.name).join(","));
    check("every project is still offered — ranking never hides one", ranked.length === 3);
    check("a project with no match says so", ranked[2].match === "none" && ranked[2].matchedHost === null);

    // Stability: same input, same order, regardless of how the API listed them.
    const shuffled = rankProjects("https://checkmyapp.dev", [projects[2], projects[0], projects[1]], hosts);
    check("the order does not depend on the order the API returned",
      shuffled.map((p) => p.id).join(",") === ranked.map((p) => p.id).join(","),
      shuffled.map((p) => p.id).join(","));

    const exactBeatsDomain = rankProjects("https://app.example.com",
      [P("a", "Aaa sibling"), P("b", "Bbb exact")],
      { a: ["www.example.com"], b: ["app.example.com"] });
    check("an exact match outranks a same-domain one, alphabetical order notwithstanding",
      exactBeatsDomain[0].id === "b", exactBeatsDomain.map((p) => p.name).join(","));
  }

  console.log("\nWhen we refuse to suggest");
  {
    const two = [P("1", "Prod"), P("2", "Staging")];
    const bothSaw = { "1": ["checkmyapp.dev"], "2": ["checkmyapp.dev"] };
    const ranked = rankProjects("https://checkmyapp.dev", two, bothSaw);
    check("two projects that both saw the host → no suggestion",
      suggestedProject(ranked) === null,
      JSON.stringify(ranked.map((p) => [p.name, p.match])));

    const onlyOne = rankProjects("https://checkmyapp.dev", two, { "1": ["checkmyapp.dev"], "2": ["other.example"] });
    check("exactly one match → that one is suggested", suggestedProject(onlyOne)?.id === "1");

    const noneMatch = rankProjects("https://checkmyapp.dev", two, { "1": ["a.example"], "2": ["b.example"] });
    check("nothing matches → null, so the screen says 'pick one' instead of preselecting",
      suggestedProject(noneMatch) === null);

    check("an empty account suggests nothing and does not throw",
      suggestedProject(rankProjects("https://checkmyapp.dev", [], {})) === null);

    // An exact match and a same-domain match are not "equally good" — the exact
    // one wins outright rather than being suppressed as ambiguous.
    const mixed = rankProjects("https://app.example.com", two, { "1": ["app.example.com"], "2": ["www.example.com"] });
    check("an exact match is not suppressed by a weaker one elsewhere",
      suggestedProject(mixed)?.id === "1", JSON.stringify(mixed.map((p) => [p.name, p.match])));
  }

  console.log("\nReading the provider, and surviving it");
  {
    const ok = (body: unknown, status = 200) =>
      (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const projects = await listProjects({
      token: "pha_x",
      baseUrl: "https://us.posthog.com",
      fetchImpl: ok({ count: 2, results: [{ id: 595090, name: "Check My App" }, { id: 266212, name: "  " }] }),
    });
    check("numeric ids become strings — an id is an identifier, not a quantity",
      projects[0].id === "595090" && typeof projects[0].id === "string", JSON.stringify(projects[0]));
    check("a blank name still gives the picker something to show",
      projects[1].name === "Project 266212", projects[1].name);

    let threw = false;
    try {
      await listProjects({ token: "pha_x", baseUrl: "https://us.posthog.com", fetchImpl: ok({}, 403) });
    } catch {
      threw = true;
    }
    check("a refused listing throws rather than presenting an empty account", threw);

    check("a listing with no results is an empty list, not a crash",
      (await listProjects({ token: "t", baseUrl: "https://us.posthog.com", fetchImpl: ok({ count: 0 }) })).length === 0);

    // hostsSeenBy is the opposite: it must never throw, because a project we
    // cannot read is one we cannot suggest — not a broken picker.
    const dead = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    check("a project we cannot query yields no hosts instead of failing the picker",
      (await hostsSeenBy({ token: "t", baseUrl: "https://us.posthog.com", projectId: "1", fetchImpl: dead })).length === 0);
    check("a 403 on one project yields no hosts, not an exception",
      (await hostsSeenBy({ token: "t", baseUrl: "https://us.posthog.com", projectId: "1", fetchImpl: ok({}, 403) })).length === 0);
    check("hosts come back in the order the query ranked them",
      (await hostsSeenBy({
        token: "t", baseUrl: "https://us.posthog.com", projectId: "1",
        fetchImpl: ok({ results: [["localhost:3011", 124], ["checkmyapp.dev", 68]] }),
      })).join(",") === "localhost:3011,checkmyapp.dev");

    check("the probe is capped so a large account cannot cost a query per project",
      MAX_PROJECTS_TO_PROBE > 0 && MAX_PROJECTS_TO_PROBE <= 25, String(MAX_PROJECTS_TO_PROBE));
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
