// Which parts of the product we actually reached (CHE-107).
//
// Owner concern, 2026-09-01: "волнуюсь, что мы пропустим важные ui пути".
// A worry is not answerable by a prompt — asking the walker whether its own
// coverage was good is the observer certifying itself, which rule §8 says never
// works. It is answerable by counting.
//
// Discovery already writes down what it found (Run.anatomy.pages) and the walk
// already records where it went (each step's request log). Run #128 knew about
// seven pages and built four journeys, and nothing anywhere said which three
// pages no journey ever opened. That difference is the worry, in numbers.
//
// Carried journeys and stale evidence are NOT here: partialBottomLine already
// states "Re-checked 3 of 5 journeys; 2 carried forward from Run #101 (last
// walked Aug 29)", and FULL_RUN_MAX_AGE_DAYS already forces a full walk when
// any carried evidence gets old.

// Discovery writes pages as prose with the path in backticks — "Login
// (`/login`)". The path is the part a request log can be matched against; the
// prose around it is for the reader.
const PATH_IN_LABEL = /`(\/[^`\s]*)`/;

export interface PageRef {
  /** As discovery wrote it, for anything a person reads. */
  label: string;
  /** The path we can actually look for, lower-cased. */
  path: string;
}

export function pagePaths(pages: string[]): PageRef[] {
  const out: PageRef[] = [];
  for (const label of pages) {
    const m = label.match(PATH_IN_LABEL);
    if (!m) continue;
    const path = m[1].toLowerCase().replace(/\/+$/, "");
    // The homepage is loaded by the surface scan on every single run, so it is
    // never evidence of anything and would match every URL in the log besides.
    if (!path) continue;
    out.push({ label, path });
  }
  return out;
}

// Pages discovery found that no step went to. `evidence` is everything the walk
// wrote down that can contain a URL — request logs first, prose as a fallback.
//
// Deliberately conservative: a path counts as reached on a plain substring hit.
// Over-claiming coverage would be the dangerous direction (it hides a gap);
// under-claiming only nags. Where a path is a prefix of a deeper one
// (/tutorials vs /tutorials/101), the shallower one is credited by the deeper
// visit — which is true of a real user's navigation too.
export function unreachedPages(pages: string[], evidence: string[]): PageRef[] {
  const haystack = evidence.filter(Boolean).join("\n").toLowerCase();
  return pagePaths(pages).filter((p) => !haystack.includes(p.path));
}

// One sentence for the verdict, or null when there is nothing to disclose.
// Speaks about the customer's product only — these are their pages, and this is
// the honest scope of what we looked at (rule §2), never a note about how we
// work (rule §1).
export function coverageSentence(unreached: PageRef[], knownCount: number): string | null {
  if (unreached.length === 0 || knownCount === 0) return null;
  const names = unreached.slice(0, 4).map((p) => p.path);
  const rest = unreached.length - names.length;
  const list = names.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
  return `Not opened this run: ${list} — so nothing here speaks to ${
    unreached.length === 1 ? "it" : "them"
  }.`;
}
