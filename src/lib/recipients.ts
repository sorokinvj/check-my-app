// CHE-262 (Teams T9): who a verdict goes to.
//
// Before teams there was one address — whoever submitted the check — so "who
// gets told" was not a question. On a team it is the question: the person who
// clicked may not be the person on call, and a reader who joined precisely to
// read what breaks could not subscribe at all.
//
// The rule, in order:
//
//   1. the address the check was submitted with, if there is one. Somebody
//      asked for this run and left an address; not answering them would be a
//      product that swallows requests.
//   2. the app's chosen recipients, if the team has chosen any.
//   3. otherwise the team's admins — so an app nobody has configured still
//      reaches a human, rather than going quiet in a way that looks like the
//      checks stopped.
//
// Pure, so every combination is asserted without a database
// (scripts/verify-recipients.ts). Whether the run should be sent AT ALL is a
// different question, decided earlier by silenceReason (rule 6) — this decides
// only where an allowed verdict goes.

export type RecipientSource = "submitted" | "chosen" | "team admins";

export type RecipientResolution = {
  to: string[];
  // Which rule produced the list, for the log line and for the run's
  // notifyOutcome. "We sent it" is worth little without "to whom, and why them".
  via: RecipientSource[];
};

function clean(email: string | null | undefined): string | null {
  const trimmed = (email ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed) ? trimmed : null;
}

export function resolveRecipients(input: {
  // The address on the run (or the watch it came from).
  submitted?: string | null;
  // Members of the team who chose to hear about THIS app.
  chosen?: (string | null | undefined)[];
  // The team's admins, as a fallback that always exists (a team always has one).
  admins?: (string | null | undefined)[];
}): RecipientResolution {
  const via: RecipientSource[] = [];
  const out: string[] = [];

  const add = (email: string | null, source: RecipientSource) => {
    if (!email || out.includes(email)) return;
    out.push(email);
    if (!via.includes(source)) via.push(source);
  };

  add(clean(input.submitted), "submitted");

  const chosen = (input.chosen ?? []).map(clean).filter((e): e is string => e !== null);
  for (const email of chosen) add(email, "chosen");

  // Admins are the floor, not an addition: if somebody has been chosen, the
  // team has said who cares about this app, and copying every admin on top
  // would train them to filter our mail — which is the same as not sending it.
  if (chosen.length === 0) {
    for (const email of (input.admins ?? []).map(clean)) add(email, "team admins");
  }

  return { to: out, via };
}

// What goes onto the run as notifyOutcome when nobody could be found. It is a
// defect of ours rather than a state to live with (rule 2): a team whose
// verdicts reach nobody is a team that will conclude the checks stopped
// running, and tell us so weeks later.
export const NO_RECIPIENTS =
  "no recipient: the app has none chosen and its team has no admin with an address";

export function describeRecipients(resolution: RecipientResolution): string {
  if (resolution.to.length === 0) return NO_RECIPIENTS;
  return `${resolution.to.length} recipient${resolution.to.length === 1 ? "" : "s"} (${resolution.via.join(" + ")})`;
}
