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
  if (gaps.length === 0) return [];

  const self = await ourApp(env);
  if (!self?.tracker?.teamId) {
    // Nothing to file into yet — still say it out loud in the run feed so the
    // gap is never silent.
    return [
      {
        icon: "warn",
        text: `${gaps.length} step(s) went unverified because of our checker — connect the CheckMyApp app's own tracker to auto-file these.`,
      },
    ];
  }

  const tracker = new LinearTracker(
    await freshLinearToken(env.db, self.tracker, {
      clientId: env.bindings.LINEAR_CLIENT_ID,
      clientSecret: env.bindings.LINEAR_CLIENT_SECRET,
    }),
    self.tracker.teamId,
  );
  const baseUrl = env.bindings.APP_URL ?? "https://checkmyapp.dev";

  // Collapse this run's gaps onto capabilities before filing.
  const byCapability = new Map<string, { why: string; examples: string[] }>();
  for (const g of gaps) {
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
        policy: self.policy
          ? { ...self.policy, titleFormat: "[Checker gap] {verdict}" }
          : {
              priorityRule: "{}",
              pickupLabels: "[]",
              repoLabel: null,
              provenanceLabel: "checkmyapp",
              state: "Backlog",
              titleFormat: "[Checker gap] {verdict}",
              escalateAfterRuns: 3,
            },
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
