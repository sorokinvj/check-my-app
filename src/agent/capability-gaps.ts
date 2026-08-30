// Self-filing capability gaps (CHE-83).
//
// Owner rule, 2026-08-27: **"we couldn't verify X" is never an acceptable end
// state.** If CheckMyApp could not check something, that is a defect in
// CheckMyApp — not a caveat for the customer to live with, and never homework
// handed back to them. Every such gap opens a high-priority ticket on OUR OWN
// board, deduped and counted, until the capability exists.
//
// This is the same machinery the product sells (autofile → dedup → comment and
// count → escalate), pointed at ourselves: the checker is a customer of its own
// loop. Runs after the verdict is written and, like autofile, never fails a run.

import { LinearTracker } from "@/lib/tracker/linear";
import { fileFindingTicket, type TicketFinding, type TicketRun } from "@/lib/tracker/file";
import { freshLinearToken } from "@/lib/tracker/token";
import { findOrphans } from "./cleanup";
import type { AgentEnv } from "./env";

export interface CapabilityNote {
  icon: "ok" | "warn";
  text: string;
}

// One ticket per CAPABILITY, not per customer app: the same missing ability
// hit on ten apps is one thing to build. These labels are the dedup identity,
// so they must stay stable — the customer's own words never enter them.
const CAPABILITIES: { match: RegExp; label: string; why: string }[] = [
  {
    match: /new tab|target=_?"?_blank|could not follow|cannot follow|opens? in a new/i,
    label: "Checker cannot follow links that open in a new tab",
    why: "Outbound links are a large share of what owners worry about. verify_links resolves them server-side — the walker must reach for it automatically instead of leaving the step unverified.",
  },
  {
    match: /oauth|continue with google|social login|sign in with (google|github|apple)/i,
    label: "Checker cannot complete third-party OAuth sign-in",
    why: "Any app whose only login is Google/GitHub is unverifiable behind the login wall — a whole class of customers we cannot serve end to end.",
  },
  {
    match: /magic link|passwordless|email link|sign-?in link|login link/i,
    label: "Checker cannot complete passwordless / magic-link sign-in",
    why: "Magic-link products have NO password to hand us — no amount of owner input unblocks it. We need a mailbox the agent can read for test accounts; until then the entire signed-in half of every passwordless app is invisible to us.",
  },
  {
    match: /verification code|2fa|mfa|one-?time (code|password)|otp/i,
    label: "Checker cannot complete an emailed/SMS verification code step",
    why: "MFA-protected accounts stop the walk at the door. Needs a mailbox/code channel the agent can read for test accounts.",
  },
  {
    match: /camera|microphone|media device|getusermedia|webrtc/i,
    label: "Checker has no camera/microphone for media flows",
    why: "Video/voice products cannot be walked past the device prompt without synthetic media devices.",
  },
  {
    match: /captcha|turnstile|recaptcha|bot (check|protection)/i,
    label: "Checker is blocked by CAPTCHA/bot protection on the target",
    why: "Owners must be able to allowlist us, or we silently lose coverage of their signup/login.",
  },
  {
    match: /leaves its test records|records still present|cleanup audit/i,
    label: "Checker leaves test records behind in the customer's product",
    why: "Cleanup is the whole basis on which owners let us create anything. One orphan and the permission is rightly withdrawn — and the product fills with our junk (our own self-check left a live app plus a daily watch on your-app.com).",
  },
  {
    match: /file (upload|picker)|download/i,
    label: "Checker cannot drive file upload/download flows",
    why: "Upload-centric products (documents, images, CVs) have their core action unverified.",
  },
];

function classify(text: string): { label: string; why: string } {
  const hit = CAPABILITIES.find((c) => c.match.test(text));
  return (
    hit ?? {
      label: "Checker could not verify a step for an unclassified reason",
      why: "Unclassified coverage gaps are the ones we learn least from — the step text below should become its own capability entry.",
    }
  );
}

// Our own app row (the one watching checkmyapp.dev) owns the tracker connection
// the gaps are filed through, and namespaces their dedup keys.
async function ourApp(env: AgentEnv) {
  const host = (() => {
    try {
      return new URL(env.bindings.APP_URL ?? "https://checkmyapp.dev").host;
    } catch {
      return "checkmyapp.dev";
    }
  })();
  return env.db.app.findFirst({
    where: { appSlug: host },
    include: { tracker: true, policy: true },
    orderBy: { createdAt: "desc" },
  });
}

type OurApp = NonNullable<Awaited<ReturnType<typeof ourApp>>>;

// The board we file our own defects onto. Null when the CheckMyApp app has no
// tracker connected yet — callers say so out loud rather than swallowing it.
async function ourBoard(
  env: AgentEnv,
): Promise<{ self: OurApp; tracker: LinearTracker; baseUrl: string } | null> {
  const self = await ourApp(env);
  if (!self?.tracker?.teamId) return null;
  const tracker = new LinearTracker(
    await freshLinearToken(env.db, self.tracker, {
      clientId: env.bindings.LINEAR_CLIENT_ID,
      clientSecret: env.bindings.LINEAR_CLIENT_SECRET,
    }),
    self.tracker.teamId,
  );
  return { self, tracker, baseUrl: env.bindings.APP_URL ?? "https://checkmyapp.dev" };
}

// The ticket policy for anything we file against ourselves — the owner's own
// policy when the CheckMyApp app has one, otherwise the same defaults autofile
// falls back to, with the title prefix swapped.
function selfPolicy(self: OurApp, titleFormat: string) {
  return self.policy
    ? { ...self.policy, titleFormat }
    : {
        priorityRule: "{}",
        pickupLabels: "[]",
        repoLabel: null,
        provenanceLabel: "checkmyapp",
        state: "Backlog",
        titleFormat,
        escalateAfterRuns: 3,
      };
}

export async function fileCapabilityGaps(env: AgentEnv, runId: string): Promise<CapabilityNote[]> {
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: { id: true, runNumber: true, publicId: true, startedAt: true, appSlug: true },
  });
  if (!run) return [];

  const gaps = await env.db.step.findMany({
    where: { unverifiedReason: "our_capability", journey: { runId } },
    select: { label: true, attempted: true, observed: true, journey: { select: { title: true } } },
  });

  // CHE-90: leaving a test record behind is our defect too, not just an
  // inability — it files through the same loop so it gets fixed, not tolerated.
  const orphans = await findOrphans(env, runId);
  const orphanGaps =
    orphans.fromThisRun + orphans.older > 0
      ? [
          {
            label: "Checker leaves its test records behind",
            attempted: "Create → read → update → delete lifecycle with guaranteed cleanup",
            observed: `Records still present: ${orphans.lines.slice(0, 5).join(" · ")}`,
            journey: { title: "Cleanup audit" },
          },
        ]
      : [];

  const allGaps = [...gaps, ...orphanGaps];
  if (allGaps.length === 0) return [];

  const board = await ourBoard(env);
  if (!board) {
    // Nothing to file into yet — still say it out loud in the run feed so the
    // gap is never silent.
    return [
      {
        icon: "warn",
        text: `${gaps.length} step(s) went unverified because of our checker — connect the CheckMyApp app's own tracker to auto-file these.`,
      },
    ];
  }
  const { self, tracker, baseUrl } = board;

  // Collapse this run's gaps onto capabilities before filing.
  const byCapability = new Map<string, { why: string; examples: string[] }>();
  for (const g of allGaps) {
    const { label, why } = classify(`${g.observed ?? ""} ${g.attempted ?? ""} ${g.label}`);
    const entry = byCapability.get(label) ?? { why, examples: [] };
    entry.examples.push(`${run.appSlug} · ${g.journey.title} → ${g.label}: ${g.observed ?? ""}`.slice(0, 300));
    byCapability.set(label, entry);
  }

  const notes: CapabilityNote[] = [];
  for (const [label, { why, examples }] of byCapability) {
    const finding: TicketFinding = {
      runId: run.id,
      number: 0,
      title: label,
      category: "broken",
      severity: "high",
      detail: JSON.stringify({
        where: "CheckMyApp agent capability",
        whatWeTried: examples,
        whatHappened:
          `A customer run could not verify a step because of our own checker, not because of ` +
          `anything wrong with their product. Seen on ${run.appSlug} (run #${run.runNumber}).`,
        whyItMatters: `${why} Until this exists, we ship "we could not verify X" — which is exactly what customers pay us to avoid.`,
      }),
      evidence: [],
    };
    const ticketRun: TicketRun = {
      runNumber: run.runNumber,
      publicId: run.publicId,
      startedAt: run.startedAt,
      // Dedup identity lives on OUR app, so one capability = one ticket across
      // every customer app that trips it.
      appSlug: self.appSlug,
    };

    try {
      const outcome = await fileFindingTicket({
        db: env.db,
        tracker,
        appId: self.id,
        finding,
        run: ticketRun,
        policy: selfPolicy(self, "[Checker gap] {verdict}"),
        verdictUrl: `${baseUrl}/verdict/${run.publicId}`,
      });
      notes.push({
        icon: "ok",
        text:
          outcome.kind === "created"
            ? `Opened ${outcome.identifier} on our own board: ${label}`
            : outcome.kind === "commented"
              ? `Our checker gap "${label}" recurred — ${outcome.identifier} now at ${outcome.occurrences} occurrence(s)`
              : `Our checker gap "${label}" is filed as ${outcome.identifier}`,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      console.warn(`[capability] filing failed: ${text}`);
      notes.push({ icon: "warn", text: `Couldn't file our checker gap "${label}": ${text}` });
    }
  }
  return notes;
}

// ─── A rejected ticket is a defect report against us (CHE-99) ───────────────
//
// Owner rule, 2026-08-30: "is this our bug or theirs" must never be settled by
// looking deeper into the customer — it must be made impossible by not having
// bugs on our side. Reverse sync already reads Canceled as not-a-bug and stops
// refiling that signature (reconcile.ts), and that is exactly where it used to
// go quiet: a customer telling us we were wrong produced nothing on our board.
//
// Deduped by CLASS, not by incident — the same way one missing capability is
// one ticket across every app that trips it. We want the count of "times our
// configuration produced a false claim" to climb on ONE ticket until the cause
// is gone, not to scatter into a ticket per apology.

export type DefectClass = "capability" | "configuration" | "interpretation" | "bookkeeping";

const DEFECTS: Record<DefectClass, { label: string; why: string }> = {
  capability: {
    label: "Checker reported a product defect it was never able to observe",
    why: "We could not perform the action, and said the product was at fault instead of saying we could not do it. Every instance is a capability we owe ourselves — the step should have gone to our own board, silently, and the customer should have read nothing.",
  },
  configuration: {
    label: "Checker reported a product defect caused by our own configuration",
    why: "Our inputs were wrong — a stale credential, a wrong URL, a scope that no longer matches. The truth was entirely on our side of the boundary and we never checked it before spending money and someone else's attention.",
  },
  interpretation: {
    label: "Checker reported a product defect from the absence of evidence",
    why: "Silence is not evidence. Rule §3 requires positive evidence a real user would hit; a claim built on nothing happening is a claim about our own uncertainty wearing the customer's name.",
  },
  bookkeeping: {
    label: "Checker re-filed something it had already been told was not a bug",
    why: "We lost track of what we had filed or been told. Repeating a disproved claim is the fastest way to be filtered out — the second one costs more trust than the first one cost time.",
  },
};

const UNCLASSIFIED = {
  label: "Checker filed a claim the owner rejected, cause unclassified",
  why: "An unclassified rejection is the one we learn least from. Whoever picks this up should name the cause and, if it is a new shape, give it its own class.",
};

// Our own formulaic phrasing for "nothing happened, so we called it a defect" —
// the exact shape rules §1 and §3 exist to forbid.
const ABSENCE_CLAIM =
  /could not be (confirmed|verified)|did ?n[o']t respond|no (network )?(request|reaction|response) (followed|at all)|nothing happened|unresponsive|inert/i;

// Which of our failure modes produced a claim the owner rejected. Fact-based
// where a fact exists, null where it does not: a guess here would corrupt the
// only number that tells us whether we are getting better.
//
// `bookkeeping` is deliberately not inferred. It is not a thing to detect after
// the fact — CHE-101 makes re-filing a settled signature structurally
// impossible, and until then the honest answer is "unclassified".
export async function classifyCheckerDefect(
  env: AgentEnv,
  opts: {
    originRunId: string | null;
    journeyTitle: string | null;
    claimText: string;
    /** Set by the credential preflight (CHE-100) when our own inputs were wrong. */
    configurationFault?: boolean;
  },
): Promise<DefectClass | null> {
  if (opts.configurationFault) return "configuration";

  // Recorded fact, not inference: the walk itself said OUR checker could not do
  // something in this journey. A customer-facing claim on top of that is ours.
  if (opts.originRunId) {
    const blocked = await env.db.step.count({
      where: {
        unverifiedReason: "our_capability",
        journey: {
          runId: opts.originRunId,
          ...(opts.journeyTitle ? { title: opts.journeyTitle } : {}),
        },
      },
    });
    if (blocked > 0) return "capability";
  }

  if (ABSENCE_CLAIM.test(opts.claimText)) return "interpretation";

  return null;
}

// Open (or count another occurrence on) the ticket for this class of our own
// defect. Same failure contract as everything else in this file: it never
// throws, because housekeeping on our own board must not cost a customer a run.
export async function fileCheckerDefect(
  env: AgentEnv,
  opts: {
    defectClass: DefectClass | null;
    /** The customer ticket the owner canceled, e.g. "JOB-904". */
    rejectedIssueId: string;
    customerAppSlug: string;
    /** What we claimed, in our own words at the time. */
    claimTitle: string | null;
    originRunId: string | null;
  },
): Promise<CapabilityNote> {
  const { label, why } = opts.defectClass ? DEFECTS[opts.defectClass] : UNCLASSIFIED;

  const board = await ourBoard(env);
  if (!board) {
    return {
      icon: "warn",
      text: `${opts.rejectedIssueId} was rejected as not-a-bug — connect the CheckMyApp app's own tracker so our own defects get filed.`,
    };
  }
  const { self, tracker, baseUrl } = board;

  const origin = opts.originRunId
    ? await env.db.run.findUnique({
        where: { id: opts.originRunId },
        select: { runNumber: true, publicId: true, startedAt: true },
      })
    : null;

  const finding: TicketFinding = {
    runId: opts.originRunId ?? "",
    number: 0,
    title: label,
    category: "broken",
    severity: "high",
    detail: JSON.stringify({
      // Fixed, so every instance of this class hashes to the same ticket. The
      // customer's own request facts stay OUT of the three fields the dedup
      // signature reads — one endpoint must not fork this into its own ticket.
      where: "CheckMyApp checker accuracy",
      whatWeTried: [
        `We claimed: ${opts.claimTitle ?? "(claim text no longer on file)"}`,
        `On: ${opts.customerAppSlug}${origin ? ` (run #${origin.runNumber})` : ""}`,
        `The owner closed ${opts.rejectedIssueId} as not-a-bug.`,
      ],
      whatHappened:
        "We told a customer their product was broken and they showed us it was not. " +
        "The cost is not the wasted ticket — it is that a customer's team now has " +
        "evidence that our output needs checking before it is trusted.",
      whyItMatters: `${why} This ticket counts every time this class of ours reaches a customer; it closes when the cause is gone, not when the incident is forgotten.`,
    }),
    evidence: [],
  };

  try {
    const outcome = await fileFindingTicket({
      db: env.db,
      tracker,
      appId: self.id,
      finding,
      run: {
        runNumber: origin?.runNumber ?? 0,
        publicId: origin?.publicId ?? "",
        startedAt: origin?.startedAt ?? new Date(),
        // Dedup identity lives on OUR app: one class = one ticket across every
        // customer that ever rejects us.
        appSlug: self.appSlug,
      },
      policy: selfPolicy(self, "[Checker defect] {verdict}"),
      verdictUrl: origin ? `${baseUrl}/verdict/${origin.publicId}` : baseUrl,
    });
    return {
      icon: "ok",
      text:
        outcome.kind === "created"
          ? `Opened ${outcome.identifier} on our own board: ${label}`
          : outcome.kind === "commented"
            ? `Our own defect "${label}" reached a customer again — ${outcome.identifier} now at ${outcome.occurrences} occurrence(s)`
            : `Our own defect "${label}" is filed as ${outcome.identifier}`,
    };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.warn(`[checker-defect] filing failed: ${text}`);
    return { icon: "warn", text: `Couldn't file our own defect for ${opts.rejectedIssueId}: ${text}` };
  }
}
