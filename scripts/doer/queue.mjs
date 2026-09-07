// What the doer is allowed to pick up, and why each thing it refuses is refused.
//
// The queue used to be GitHub issues carrying a `doer` label, filled by hand on
// 1-2 September and by nothing since (CHE-170). The raw material was always
// somewhere else: `src/agent/capability-gaps.ts` files "[Checker gap] …" on our
// own board whenever a run cannot verify a step because of us, and
// `src/agent/reconcile.ts` files "[Checker defect] …" when a claim of ours is
// rejected. Both run on every run, with no human in the middle. This file is the
// missing step between that supplier and the dispatcher (CHE-118).
//
// ─── Why a list of capabilities and not a classifier ────────────────────────
//
// The obvious design is to judge each ticket's text: is this a symptom, is it
// bounded, can a machine tell when it is gone. That would be a second model
// guessing on our behalf, and its guesses would drift from the filer's.
//
// It is also unnecessary. The filer does not write free text: it collapses every
// gap onto a CLOSED SET of capabilities (`CAPABILITIES` in capability-gaps.ts,
// eight labels plus an unclassified fallback) and every rejected claim onto four
// defect classes. One capability is one ticket, across every app that trips it.
// So the question "can the doer take this" is answered once per class, by a
// person, in writing — and a class nobody has ruled on is refused until someone
// rules. That is a decision the next reader can audit and argue with; a
// classifier's verdict is neither.
//
// The three conditions behind each ruling are the ones already proven on real
// data by scripts/measure/gate-ready-supply.ts: a symptom is named; it is ours
// to fix in THIS repository; and its disappearance can be checked by a machine.
// The conditions are reused; that script is not, because it judges findings
// about customers' products and deliberately excludes our own domain.

/** Capability labels the doer may take, with the reason each was admitted. */
export const ADMITTED_CAPABILITIES = new Map([
  [
    "Checker cannot follow links that open in a new tab",
    "browser handling inside our own runner; a verify script can open a fixture that targets a new tab",
  ],
  [
    "Checker leaves test records behind in the customer's product",
    "the janitor already exists (CLAUDE.md §6); 'no orphans after a run' is checkable by a query",
  ],
  [
    "Checker cannot drive file upload/download flows",
    "automation inside our own runner; a fixture page with a file input decides it",
  ],
]);

/** Capability labels the doer must refuse, each with the reason it is refused. */
export const REFUSED_CAPABILITIES = new Map([
  [
    "Checker cannot complete third-party OAuth sign-in",
    "needs credentials we do not hold, not code we can write — this is access (CLAUDE.md §2), and the owner is the only one who can grant it",
  ],
  [
    "Checker cannot complete passwordless / magic-link sign-in",
    "needs a mailbox the checker can read; that is infrastructure to decide, not a change to make",
  ],
  [
    "Checker cannot complete an emailed/SMS verification code step",
    "same: an inbox or a number we do not have",
  ],
  [
    "Checker has no camera/microphone for media flows",
    "a property of the browser we rent, not of our code",
  ],
  [
    "Checker is blocked by CAPTCHA/bot protection on the target",
    "bypassing bot protection is forbidden outright; there is no version of this ticket the doer may do",
  ],
  [
    "Checker could not verify a step for an unclassified reason",
    "nothing is named, so nothing can be built or checked — this ticket asks the filer to classify, not the doer to fix",
  ],
]);

/** Defect classes the doer may take. Each names a wrong behaviour of ours. */
export const ADMITTED_DEFECTS = new Map([
  [
    "Checker reported a product defect it was never able to observe",
    "a concrete claim we made without evidence, with the run that made it",
  ],
  [
    "Checker reported a product defect caused by our own configuration",
    "our own stale state produced the claim; the fix and its proof are both ours",
  ],
  [
    "Checker reported a product defect from the absence of evidence",
    "silence read as breakage — rule §3, and a verify script can hold the line",
  ],
  [
    "Checker re-filed something it had already been told was not a bug",
    "bookkeeping we own end to end",
  ],
]);

export const REFUSED_DEFECTS = new Map([
  [
    "Checker filed a claim the owner rejected, cause unclassified",
    "no class means no named cause; classifying it is the filer's job, not the doer's",
  ],
]);

/**
 * May the doer take this ticket?
 *
 * Never returns a bare false: a refusal without a reason is indistinguishable
 * from a queue that silently lost a ticket, and that confusion is what CHE-152
 * was about.
 *
 * @param {{title:string, state?:string}} ticket a ticket from our own board
 * @returns {{ok:true, reason:string} | {ok:false, reason:string}}
 */
export function admit(ticket) {
  // Two callers, two shapes. The reader (board-queue.ts) has already recognised
  // the capability from the ticket's dedup key and hands over {label, kind};
  // anything else arrives as a raw title and is parsed below. Both must reach
  // the same ruling, or the rule would depend on who is asking.
  if (ticket?.label && ticket?.kind) return ruling(ticket.label, ticket.kind);

  const title = String(ticket?.title ?? "").trim();

  // The filer's title format is "[Checker gap] {label}" / "[Checker defect]
  // {label}" (selfPolicy in capability-gaps.ts). Anything else on the board is
  // somebody's hand-written ticket: it may be perfectly good work, but it did
  // not come from a run, and the doer's supply is what runs produce.
  const gap = title.match(/^\[Checker gap\]\s*(.+)$/i);
  const defect = title.match(/^\[Checker defect\]\s*(.+)$/i);
  if (!gap && !defect) {
    return { ok: false, reason: "not filed by a run — the doer's queue is what our own runs produce" };
  }

  // The label the filer wrote, minus the wrapper the ticket policy adds. The two
  // wrappers differ by a word — gaps say "CheckMyApp agent capability:", defects
  // say "CheckMyApp checker accuracy:" — and a ruling must not depend on which
  // one a ticket happens to carry. Taken from the real titles on the board
  // (CHE-94 and CHE-110), not from what the format looked like it should be.
  const label = (gap ?? defect)[1]
    .replace(/^CheckMyApp\s+(?:agent\s+capability|checker\s+accuracy):\s*/i, "")
    .trim();

  return ruling(label, gap ? "gap" : "defect");
}

/**
 * The ruling for one capability or defect class.
 *
 * @param {string} label the capability the filer named
 * @param {"gap"|"defect"} kind which family it belongs to
 */
export function ruling(label, kind) {
  const admitted = kind === "gap" ? ADMITTED_CAPABILITIES : ADMITTED_DEFECTS;
  const refused = kind === "gap" ? REFUSED_CAPABILITIES : REFUSED_DEFECTS;

  if (admitted.has(label)) return { ok: true, reason: admitted.get(label) };
  if (refused.has(label)) return { ok: false, reason: refused.get(label) };

  // A capability nobody has ruled on. Refusing is the safe direction: a wrong
  // admission spends money on an attempt with no checkable outcome, while a
  // wrong refusal costs one line in this file once someone notices.
  return {
    ok: false,
    reason: `no ruling for "${label}" — add it to scripts/doer/queue.mjs with a reason before the doer may take it`,
  };
}

/**
 * Split a board's open tickets into what may be taken and what may not.
 * Oldest first, for the same reason as the old queue: a ticket that keeps
 * losing to newer ones never gets built, and the queue silently becomes a stack.
 */
export function partition(tickets) {
  const queue = [];
  const refused = [];
  for (const t of tickets) {
    const verdict = admit(t);
    (verdict.ok ? queue : refused).push({ ...t, reason: verdict.reason });
  }
  queue.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  return { queue, refused };
}
