// CheckRunWorkflow (CHE-14/15) — the durable 6-phase orchestrator on Cloudflare
// Workflows, replacing the BullMQ worker loop. Each phase is a step.do(): the
// run survives retries and restarts; step outputs are persisted.
//
// connecting → surface_scan (deterministic) → discovery (LLM) → walking (LLM,
// per journey) → anatomy → writing (LLM synthesis + findings). Browser sessions
// are per-phase. Transcript (secret-free) → R2; cost rolled into Run.costUsd.
//
// Watch runs get a mode ladder in front of that, cheapest rung first:
//   1. SMOKE (CHE-51, ./replay.ts) — a free pre-check that can complete the run
//      before a single token is spent. See that file for what it does and does
//      not prove.
//   2. PARTIAL (CHE-57, ./partial.ts) — re-walk only the journeys that were bad
//      last time, carry the healthy ones forward. Skips discovery and reuses the
//      baseline anatomy; unlike smoke it does NOT skip synthesis, because it
//      produces fresh evidence that has to be adjudicated.
//   3. FULL — the six phases below.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { AppAnatomy } from "@/lib/types";
import type { Verdict } from "@/lib/enums";
import { normalizeAnatomy } from "@/lib/anatomy";
import { parseJson } from "@/lib/json";
import type { RunEvent, RunPhase } from "@/lib/types";
import { makeAgentEnv, putText, type AgentBindings, type AgentEnv } from "./env";
import { makeLlm, type UsageTotals } from "./llm";
import { launchAgentBrowser, surfaceScan } from "./browser";
import { LlmBudgetError } from "./core";
import { dedupKeyForFinding } from "@/lib/tracker/file";
import { discoverApp, type ProposedJourney, type RunInput } from "./discovery";
import { walkOneJourney, type WalkRun } from "./execution";
import { synthesizeVerdict, type SynthesizedFinding } from "./synthesis";
import { autoFileFindings } from "./autofile";
import { fileCapabilityGaps } from "./capability-gaps";
import { auditCreatedResources } from "./cleanup";
import { reconcileIssueLinks, reverifyInstructions, verifyFixedLinks } from "./reconcile";
import { sendVerdictReady } from "@/lib/email";
import { deliverWebhook, type RunCompletedPayload } from "@/lib/notify/webhook";
import { deliverSlack } from "@/lib/notify/slack";
import { decryptSecret } from "@/lib/crypto";
import type { TranscriptEntry } from "./core";
import { shortLabel, smokeReplay, SMOKE_COST_USD, type SmokeReport } from "./replay";
import {
  carryJourney,
  partialBottomLine,
  planPartialRun,
  type PartialDecision,
} from "./partial";

export interface CheckRunParams {
  runId: string;
}

// A budget failure must stop the whole run, and the Workflows engine must NOT
// retry the step (each retry would re-spend tokens we don't have) — convert at
// the step boundary (CHE-76).
function rethrowBudgetNonRetryable(err: unknown): never {
  if (err instanceof LlmBudgetError) {
    throw new NonRetryableError(err.message, "LlmBudgetError");
  }
  throw err as Error;
}

export class CheckRunWorkflow extends WorkflowEntrypoint<AgentBindings, CheckRunParams> {
  async run(event: WorkflowEvent<CheckRunParams>, step: WorkflowStep): Promise<void> {
    const { runId } = event.payload;
    const env = makeAgentEnv(this.env);
    const llm = makeLlm(this.env);

    const run = await step.do("load-run", async () => {
      const r = await env.db.run.findUnique({
        where: { id: runId },
        select: {
          id: true,
          publicId: true,
          runNumber: true,
          targetUrl: true,
          appSlug: true,
          testEmail: true,
          testPasswordEnc: true,
          scopeHints: true,
          userNotes: true,
          focusAreas: true,
          notifyEmail: true,
          watchId: true,
          baselineRunId: true,
          forceFull: true,
          smokeOnly: true,
          appId: true,
        },
      });
      if (!r) throw new Error(`run ${runId} not found`);
      return r;
    });

    // Everything below is inside the failure handler: a run left in a
    // non-terminal status is worse than a failed one — the scheduler treats it
    // as still in flight and never fires that Watch again.
    try {
      // Reverse sync (CHE-61): fold the tracker's verdicts back in before any
      // mode decision. Done tickets queue a targeted re-verification (and veto
      // the smoke shortcut below — a smoke pass can't confirm a fix); Canceled
      // tickets suppress their signatures for good. Same swallow contract as
      // the other pre-flight rungs: a tracker outage costs reverse sync, never
      // the run.
      const reconciled = await step.do("reconcile", async () => {
        try {
          const r = await reconcileIssueLinks(env, run);
          for (const note of r.notes) {
            await appendEvent(env, runId, "replay", note);
          }
          return r;
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          console.warn(`[reconcile] tracker sync failed: ${text}`);
          return { notes: [], reverify: [] };
        }
      });

      // Phase 0 — Replay-first (CHE-51). Before spending ~$0.53 of tokens on a
      // recurring watch run, re-check the pages we already know for free. A green
      // smoke pass ends the run right here carrying the baseline verdict forward;
      // anything else falls through to the next rung of the ladder. Errors inside
      // the check are swallowed on purpose: a Browser Rendering hiccup during a
      // cheap pre-check must cost a full run, never the run itself.
      const smoke = await step.do("replay", async () => {
        // Full re-check (CHE-74): the owner explicitly asked to walk everything
        // — no shortcut may eat that request.
        if (run.forceFull) {
          return { taken: false as const, reason: "full re-check requested — walking everything" };
        }
        // A pending fix verification needs a real walk of the journey the
        // ticket came from; "the pages still serve" cannot confirm a fix.
        if (reconciled.reverify.length > 0) {
          const n = reconciled.reverify.length;
          return {
            taken: false as const,
            reason: `${n} fixed ticket${n === 1 ? "" : "s"} to re-verify — a smoke pass can't confirm a fix`,
          };
        }
        try {
          return await smokeReplay(env, run);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          console.warn(`[replay] smoke check errored: ${text}`);
          return { taken: false as const, reason: `smoke check errored (${text})` };
        }
      });

      // Phase 0b — Partial mode (CHE-57), the middle rung of the ladder. Only
      // reachable when the smoke check did NOT run: a green smoke ends the run
      // above, and a red one is app-wide trouble that deserves a full walk. Same
      // swallow-and-fall-through contract as the smoke check — a planning error
      // costs a full run, never the run itself.
      const plan = await step.do("partial-plan", async (): Promise<PartialDecision> => {
        if (run.forceFull) {
          return { taken: false, reason: "full re-check requested — walking everything" };
        }
        if (run.smokeOnly) {
          return { taken: false, reason: "today's agent budget for this app is spent" };
        }
        if (!run.watchId) return { taken: false, reason: "one-off check" };
        if (smoke.taken) {
          return { taken: false, reason: "the smoke check found trouble — re-walking every journey" };
        }
        try {
          return await planPartialRun(env, run);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          console.warn(`[partial] planning errored: ${text}`);
          return { taken: false, reason: `partial planning errored (${text})` };
        }
      });

      if (run.watchId) {
        await step.do("replay-log", async () => {
          for (const event of modeEvents(smoke, plan, run.targetUrl)) {
            await appendEvent(env, runId, "replay", event);
          }
        });
      }

      // CHE-98: the budget is spent and the smoke pass could not carry the
      // verdict forward. Finish honestly rather than spend: the app was
      // checked for outages today, and the deep walk resumes tomorrow.
      if (run.smokeOnly && !(smoke.taken && smoke.ok)) {
        await step.do("budget-complete", async () => {
          await env.db.run.update({
            where: { id: runId },
            data: {
              status: "completed",
              verdict: "unverified",
              bottomLine:
                "We checked that your app is up and serving its known pages today. The full " +
                "journey check runs on the next cycle — your plan covers one deep check a day " +
                "per app, and today's has already run.",
              costUsd: SMOKE_COST_USD,
              currentAction: null,
              completedAt: new Date(),
            },
          });
          await appendEvent(env, runId, "replay", {
            icon: "info",
            text: "Budget for today is spent — this tick confirmed the app is up; the deep check runs next cycle",
          });
        });
        // Deliberately silent: a budget tick is our accounting, not news about
        // the customer's product. Emailing "unverified" three times a day
        // because we chose to spend less would be alarming and useless.
        return;
      }

      if (smoke.taken && smoke.ok) {
        // Deliberately NOT routed through synthesis or checkVerdictIntegrity: a
        // smoke run walks zero journeys, so the zero-coverage guard would rewrite
        // this to "unverified". The guard is right about LLM runs and wrong here —
        // coverage came from the baseline, and the bottom line says so out loud.
        await step.do("replay-complete", async () => {
          await env.db.run.update({
            where: { id: runId },
            data: {
              status: "completed",
              verdict: smoke.verdict,
              bottomLine:
                `Daily smoke pass: ${smoke.probes.length} page${smoke.probes.length === 1 ? "" : "s"} ` +
                `healthy, nothing changed since Run #${smoke.fullRunNumber} — full agent check ` +
                `skipped (replay-first). This confirms your app is up and its known pages still ` +
                `serve; it does not re-verify the journeys.`,
              // Carried from the last full run so the verdict page still describes
              // the app instead of rendering a near-empty shell.
              appLens: smoke.appLens,
              anatomy: smoke.anatomy,
              ...(smoke.screenshotUrl ? { liveScreenshotUrl: smoke.screenshotUrl } : {}),
              costUsd: SMOKE_COST_USD,
              currentAction: null,
              completedAt: new Date(),
            },
          });
        });

        // Same notification contract as a full run: a notifyOnChangeOnly watch
        // stays quiet, because the verdict we just carried forward is by
        // definition the baseline's.
        if (run.notifyEmail) {
          await step.do("replay-notify", () => notifyVerdictReady(env, this.env, run, smoke.verdict));
        }
        // No credential cleanup: a smoke pass only happens on watch runs, and a
        // Watch retains its credentials for the next one.
        return;
      }

      // Loop C: findings the owner marked "watch" on earlier runs of this app are
      // verified FIRST — they become a priority block in the client instructions.
      const watched = await step.do("load-watched-findings", async () => {
        const rows = await env.db.finding.findMany({
          where: { mark: "watch", run: { appSlug: run.appSlug, id: { not: run.id } } },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { title: true },
        });
        return rows.map((f) => f.title);
      });
      const watchNotes = watched.length
        ? `PRIORITY — the owner flagged these earlier findings to verify first thing this run:\n${watched
            .map((t) => `- ${t}`)
            .join("\n")}`
        : null;
      // Reverse sync (CHE-61): fixes claimed Done in the tracker ride the same
      // priority channel, so the walker chases them specifically.
      const reverifyBlock = reverifyInstructions(reconciled.reverify);
      const userNotes = [run.userNotes, reverifyBlock, watchNotes].filter(Boolean).join("\n\n") || null;

      // CHE-90: CRUD lifecycle checking is per-app and opt-in. The marker goes
      // into every record the agent creates so cleanup can only touch our own.
      const writeMode = run.appId
        ? ((await env.db.app.findUnique({ where: { id: run.appId }, select: { writeMode: true } }))
            ?.writeMode ?? "read_only")
        : "read_only";
      // CHE-91: creation happens ONLY as the owner's test account. Without one
      // the agent would be creating in shared or anonymous space — someone
      // else's data, not a sandbox we can clean up — so the permission is void
      // however the app is configured. Deterministic, not a prompt promise.
      const hasTestAccount = Boolean(run.testEmail && run.testPasswordEnc);
      const writeAllowed = writeMode === "create_cleanup" && hasTestAccount;
      if (writeMode === "create_cleanup" && !hasTestAccount) {
        await appendEvent(env, runId, "connecting", {
          icon: "warn",
          text:
            "Record creation is enabled for this app but no test account is set — " +
            "checking read-only. Add test credentials so we create only inside that account.",
        });
      }
      const walkRun: WalkRun = {
        id: run.id,
        appSlug: run.appSlug,
        appId: run.appId,
        targetUrl: run.targetUrl,
        testEmail: run.testEmail,
        testPasswordEnc: run.testPasswordEnc,
        scopeHints: run.scopeHints,
        userNotes,
        focusAreas: run.focusAreas,
        writeAllowed,
        testMarker: `CheckMyApp test r${run.runNumber}`,
      };

      await step.do("connecting", async () => {
        await transition(env, runId, "connecting", { icon: "info", text: "Spinning up agent" });
      });

      // Phase 2 — Surface scan (deterministic).
      const scan = await step.do("surface_scan", async () => {
        await transition(env, runId, "surface_scan", { icon: "info", text: `Loading ${run.targetUrl}` });
        const browser = await launchAgentBrowser(env);
        try {
          const r = await surfaceScan(env, browser, run.targetUrl);
          if (r.screenshotUrl) {
            await env.db.run.update({ where: { id: runId }, data: { liveScreenshotUrl: r.screenshotUrl } });
          }
          await appendEvent(env, runId, "surface_scan", {
            icon: "ok",
            text: `Loaded homepage (HTTP ${r.status ?? "?"})`,
          });
          if (r.techSignals.length) {
            await appendEvent(env, runId, "surface_scan", {
              icon: "ok",
              text: `Detected ${r.techSignals.join(" + ")}`,
            });
          }
          await appendEvent(env, runId, "surface_scan", {
            icon: "ok",
            text: `Found ${r.internalLinkCount} internal links`,
          });
          return r;
        } finally {
          await browser.close();
        }
      });

      // Phase 3 — Discovery (LLM), or its partial-mode stand-in. A partial run
      // already knows this app's map: re-mapping it would spend Sonnet tokens to
      // rediscover journeys we are about to re-walk by name anyway.
      if (plan.taken) {
        await step.do("reuse-map", async () => {
          await transition(env, runId, "discovery", {
            icon: "info",
            text: `Reusing Run #${plan.baselineRunNumber}'s map — no discovery needed`,
          });
          await appendEvent(env, runId, "discovery", {
            icon: "ok",
            text:
              `Carrying forward ${plan.carry.length} healthy journey` +
              `${plan.carry.length === 1 ? "" : "s"}: ${plan.carry.map((c) => c.title).join(" · ")}`,
          });
        });
      }
      const discovery = plan.taken ? null : await step.do("discovery", async () => {
        await transition(env, runId, "discovery", { icon: "info", text: "Mapping your app" });
        const browser = await launchAgentBrowser(env);
        try {
          const d = await discoverApp({
            env,
            llm,
            browser,
            run: { ...run, userNotes } as RunInput,
            onLiveScreenshot: (url) => setLive(env, runId, { liveScreenshotUrl: url }),
            onProgress: (note) => setLive(env, runId, { currentAction: note }),
          }).catch(rethrowBudgetNonRetryable);
          // Extraction trouble first, then the outcome — so "No journeys
          // mapped" always arrives with the reason it happened next to it.
          for (const n of d.notes) {
            await appendEvent(env, runId, "discovery", { icon: "warn", text: n });
          }
          await appendEvent(env, runId, "discovery", {
            icon: d.journeys.length ? "ok" : "warn",
            text: d.journeys.length
              ? `Proposed ${d.journeys.length} user journeys`
              : "No journeys mapped",
          });
          await recordUsage(env, runId, "discovery", llm.navModel, d.usage);
          return d;
        } finally {
          await browser.close();
        }
      });

      // Phase 4 — Walking journeys (LLM). ONE Workflow step per journey (CHE-24)
      // so a CPU-limit/retry only re-does that journey, never the whole walk;
      // walkOneJourney is idempotent on (runId, order). A fresh browser per
      // journey keeps each step's session within Browser Rendering limits.
      // A partial run walks its bad journeys under the SAME (runId, order) slots
      // they had in the baseline, with the carried ones filling the rest — so
      // journey order, dedupKeys (CHE-50) and synthesis stepRefs all line up with
      // the picture the owner already knows.
      const walkList: Array<{ order: number; proposed: ProposedJourney }> = plan.taken
        ? plan.rewalk.map((r) => ({ order: r.order, proposed: { title: r.title, steps: r.steps } }))
        : (discovery?.journeys ?? []).map((proposed, i) => ({ order: i, proposed }));

      await step.do("walking-start", async () => {
        await transition(env, runId, "walking", {
          icon: "info",
          text: plan.taken
            ? `Re-walking ${plan.rewalk.length} journey` +
              `${plan.rewalk.length === 1 ? "" : "s"} that had trouble in Run ` +
              `#${plan.baselineRunNumber}: ` +
              plan.rewalk.map((r) => `"${r.title}" (was ${r.previousStatus})`).join(" · ")
            : `Walking ${walkList.length} discovered journeys`,
        });
      });

      // Copy the healthy journeys across before walking anything: if a re-walk
      // burns its retries, the run still carries the coverage it was promised.
      if (plan.taken) {
        await step.do("carry-journeys", async () => {
          for (const entry of plan.carry) {
            await carryJourney(env, runId, entry);
          }
        });
      }

      let walkCost = 0;
      for (const { order, proposed } of walkList) {
        const jcost = await step.do(`walk-${order}`, async () => {
          const browser = await launchAgentBrowser(env);
          try {
            const r = await walkOneJourney({
              env,
              llm,
              browser,
              run: walkRun,
              proposed,
              index: order,
              onLiveScreenshot: (url) => setLive(env, runId, { liveScreenshotUrl: url }),
              onProgress: (note) => setLive(env, runId, { currentAction: note }),
            }).catch(rethrowBudgetNonRetryable);
            const journey = await env.db.journey.findFirst({
              where: { runId, order },
              select: { id: true },
            });
            await recordUsage(env, runId, "walking", llm.navModel, r.usage, journey?.id ?? null);
            // Persist the walking transcript per journey (CHE-58): the run-level
            // transcript only kept discovery, so walking — 90% of the calls and
            // the most useful audit + cost-analysis artifact — was invisible.
            if (r.transcript.length) {
              await putText(
                env,
                `transcripts/${runId}-walk-${order}.json`,
                JSON.stringify(r.transcript, null, 2),
              );
            }
            return r.costUsd;
          } finally {
            await browser.close();
          }
        });
        walkCost += jcost;
      }

      // Phase 5 — Anatomy (merge deterministic scan signals into the LLM map).
      // A partial run reuses the baseline's anatomy: nothing re-mapped the app
      // this run, so writing a fresh-looking map would be an invention.
      const anatomy: AppAnatomy = await step.do("anatomy", async () => {
        await transition(env, runId, "anatomy", {
          icon: "info",
          text: plan.taken
            ? `Reusing Run #${plan.baselineRunNumber}'s app anatomy`
            : "Assembling app anatomy",
        });
        const mapped = plan.taken
          ? normalizeAnatomy(parseJson<unknown>(plan.anatomy))
          : normalizeAnatomy(discovery?.anatomy);
        const safe = mapped ?? {
          pages: [],
          actions: [],
          services: [],
          tech: {},
        };
        const tech = { ...safe.tech };
        if (scan.techSignals.length && !tech.frontend) tech.frontend = scan.techSignals.join(" · ");
        const merged: AppAnatomy = { ...safe, tech };
        await env.db.run.update({ where: { id: runId }, data: { anatomy: JSON.stringify(merged) } });
        return merged;
      });

      // Phase 6 — Writing (LLM synthesis + findings + verdict).
      const verdict = await step.do("writing", async () => {
        await transition(env, runId, "writing", { icon: "info", text: "Writing your verdict" });
        const synth = await synthesizeVerdict({ env, llm, runId, anatomy }).catch(
          rethrowBudgetNonRetryable,
        );
        await recordUsage(env, runId, "synthesis", llm.synthModel, synth.usage);
        await persistFindings(env, runId, synth.findings);
        if (synth.findings.length) {
          await appendEvent(env, runId, "writing", {
            icon: "ok",
            text: `Recorded ${synth.findings.length} findings`,
          });
        }

        const checked = await checkVerdictIntegrity(env, runId, synth);
        if (checked.note) {
          await appendEvent(env, runId, "writing", { icon: "warn", text: checked.note });
        }

        const transcript: TranscriptEntry[] = discovery?.transcript ?? [];
        let transcriptUrl: string | null = null;
        if (transcript.length) {
          transcriptUrl = await putText(
            env,
            `transcripts/${runId}.json`,
            JSON.stringify(transcript, null, 2),
          );
        }

        // Coverage before opinion: a partial run's pill covers journeys nobody
        // walked today, so the bottom line says which is which before it says
        // anything else. The re-walk count comes from the rows that landed, so
        // an aborted walk shrinks the claim instead of inflating it.
        const bottomLine = plan.taken
          ? partialBottomLine(
              plan,
              checked.bottomLine,
              await env.db.journey.count({
                where: { runId, carriedFromRunId: null, status: { not: "skipped" } },
              }),
            )
          : checked.bottomLine;

        const costUsd = (discovery?.costUsd ?? 0) + walkCost + synth.costUsd;
        await env.db.run.update({
          where: { id: runId },
          data: {
            status: "completed",
            verdict: checked.verdict,
            bottomLine,
            appLens: JSON.stringify(synth.appLens),
            transcriptUrl,
            costUsd,
            currentAction: null,
            completedAt: new Date(),
          },
        });
        return checked.verdict;
      });

      // Auto-file tracker tickets (CHE-50). Watch runs only, and only when the
      // owner connected a tracker — autoFileFindings decides both. Non-fatal by
      // construction: a tracker outage leaves warn events on a completed run.
      if (run.watchId) {
        await step.do("autofile", async () => {
          try {
            for (const note of await autoFileFindings(env, runId)) {
              await appendEvent(env, runId, "writing", note);
            }
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            console.warn(`[autofile] ticket filing failed: ${text}`);
            await appendEvent(env, runId, "writing", {
              icon: "warn",
              text: `Couldn't file tracker tickets: ${text}`,
            });
          }
        });
      }

      // CHE-90 — cleanup audit. Anything this run created inside the customer's
      // product must be gone by now. Whatever is left is reported to the owner
      // (with where to find it) AND filed as our own defect: leaving junk in
      // someone's product is never an acceptable outcome. Older orphans from
      // crashed runs of the same app are swept in here too.
      await step.do("cleanup-audit", async () => {
        try {
          for (const note of await auditCreatedResources(env, runId)) {
            await appendEvent(env, runId, "writing", note);
          }
        } catch (err) {
          console.warn(`[cleanup] audit failed: ${err instanceof Error ? err.message : err}`);
        }
      });

      // CHE-83 — hold OURSELVES to the same loop. Any step this run could not
      // verify because of our checker (not because of the customer's product)
      // becomes a high-priority ticket on our own board. Runs for every run,
      // watch or not: a capability gap is a defect wherever it shows up. Never
      // fails the run, exactly like autofile.
      await step.do("capability-gaps", async () => {
        try {
          for (const note of await fileCapabilityGaps(env, runId)) {
            await appendEvent(env, runId, "writing", note);
          }
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          console.warn(`[capability] gap filing failed: ${text}`);
        }
      });

      // Reverse sync, closing half (CHE-61): after autofile, so a reappeared
      // signature has already been refiled (flipping its link back to "open")
      // and can never be mistaken for a verified fix. Links still "fixed" whose
      // signature stayed away — in a walk that actually covered their journey —
      // get the "verified fixed in prod" comment and status "resolved".
      if (run.watchId) {
        await step.do("reconcile-verify", async () => {
          try {
            for (const note of await verifyFixedLinks(env, runId)) {
              await appendEvent(env, runId, "writing", note);
            }
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            console.warn(`[reconcile] fix verification failed: ${text}`);
            await appendEvent(env, runId, "writing", {
              icon: "warn",
              text: `Couldn't verify fixed tickets: ${text}`,
            });
          }
        });
      }

      // Outbound integrations (CHE-53): generic webhook + Slack preset. Watch
      // runs only, and they fire on EVERY completed run — no notifyOnChangeOnly
      // here, because a monitoring feed that skips quiet runs can't be told
      // apart from one that died (consumers filter on `changed` themselves).
      // Non-fatal like autofile: delivery failures leave warn events, never throw.
      if (run.watchId && run.appId) {
        await step.do("notify-integrations", async () => {
          try {
            for (const note of await notifyIntegrations(env, runId, verdict)) {
              await appendEvent(env, runId, "writing", note);
            }
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            console.warn(`[notify-integrations] dispatch failed: ${text}`);
            await appendEvent(env, runId, "writing", {
              icon: "warn",
              text: `Couldn't deliver webhooks: ${text}`,
            });
          }
        });
      }

      // Verdict-ready email (CHE: the /check form promises it). Non-fatal: a
      // notification failure must never fail a completed run. Watch runs arrive
      // here too — the scheduler copies notifyEmail onto the run — but a
      // notifyOnChangeOnly watch stays quiet while the verdict holds steady.
      if (run.notifyEmail) {
        await step.do("notify", () => notifyVerdictReady(env, this.env, run, verdict));
      }

      // Privacy: clear test credentials after a terminal completion, unless a
      // Watch retains them for recurring runs.
      await step.do("cleanup", async () => {
        if (!run.watchId) {
          await env.db.run.update({ where: { id: runId }, data: { testPasswordEnc: null } });
        }
      });
    } catch (err) {
      await step.do("fail", async () => {
        const msg = err instanceof Error ? err.message : String(err);
        // CHE-76: our own LLM budget dying is an internal outage, not a fact
        // about the customer's app. Mark the run failed with an internal
        // reason (no verdict/findings/email were published — the throw
        // happened before synthesis) and retry the watch soon.
        const budget =
          err instanceof LlmBudgetError ||
          (err instanceof Error &&
            (err.name === "LlmBudgetError" || /available credits|payment_required/i.test(msg)));
        await env.db.run.update({
          where: { id: runId },
          data: {
            status: "failed",
            errorMessage: budget
              ? `internal: LLM budget exhausted — nothing was published. ${msg}`.slice(0, 500)
              : msg,
          },
        });
        if (budget) {
          console.error(`[budget] run ${runId} aborted: LLM provider refused for credit state`);
          await appendEvent(env, runId, "connecting", {
            icon: "warn",
            text:
              "Internal error on our side (LLM provider budget) — this run published no " +
              "verdict and sent no notifications. The watch retries automatically in ~2h.",
          });
          if (run.watchId) {
            await env.db.watch
              .update({
                where: { id: run.watchId },
                data: { nextRunAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
              })
              .catch(() => {});
          }
        }
      });
      throw err;
    }
  }
}

// ─── Mode-ladder event trail (CHE-51 + CHE-57) ───────────────────────────────
// The feed is the only place an owner can see why a day cost $0.01 instead of
// $0.53 — or why the cheap modes handed over to a full run anyway. Every rung
// says what it saw, in the same voice as the rest of the run, and the mode the
// run actually took is always stated out loud.

function modeEvents(
  smoke: { taken: false; reason: string } | SmokeReport,
  plan: PartialDecision,
  targetUrl: string,
): Array<Omit<RunEvent, "at" | "phase">> {
  const events: Array<Omit<RunEvent, "at" | "phase">> = [];

  if (smoke.taken) {
    const pages = smoke.probes.map((p) => shortLabel(p.url, targetUrl)).join(" · ");
    events.push({
      icon: "info",
      text: `Smoke check: re-visiting ${smoke.probes.length} known pages — ${pages}`,
    });
    events.push(
      smoke.ok
        ? {
            icon: "ok",
            text:
              `All ${smoke.probes.length} pages healthy, no uncaught errors — carrying Run ` +
              `#${smoke.baselineRunNumber}'s verdict forward and skipping the full agent check`,
          }
        : {
            icon: "warn",
            text: `Smoke found trouble: ${smoke.failures.join("; ")} — running the full check`,
          },
    );
  } else {
    events.push({ icon: "info", text: `No smoke check — ${smoke.reason}` });
  }

  if (plan.taken) {
    events.push({
      icon: "info",
      text:
        `Partial run: re-walking ${plan.rewalk.length} of ` +
        `${plan.rewalk.length + plan.carry.length} journeys ` +
        `(${plan.carry.length} carried from #${plan.baselineRunNumber})`,
    });
  } else if (!smoke.taken) {
    // When the smoke check ran and went red it already said "running the full
    // check"; repeating the partial mode's reason there would just be noise.
    events.push({ icon: "info", text: `Running the full check — ${plan.reason}` });
  }
  return events;
}

// ─── Verdict-ready notification ──────────────────────────────────────────────
// Shared by the full run and the replay-first pass. Non-fatal by construction:
// a notification failure must never fail a completed run.

async function notifyVerdictReady(
  env: AgentEnv,
  bindings: AgentBindings,
  run: {
    publicId: string;
    appSlug: string;
    notifyEmail: string | null;
    watchId: string | null;
    baselineRunId: string | null;
  },
  verdict: Verdict | null,
): Promise<void> {
  if (!run.notifyEmail) return;
  // CHE-100: self-checks are silent. A run owned by the test account exists so
  // CheckMyApp can check itself; the person running the business must be able
  // to forget it exists. Its results live in that account's dashboard, where
  // they can be looked at deliberately — they never arrive in anyone's inbox.
  if (await ownedByTestAccount(env, run.publicId)) {
    console.log(`[notify] run ${run.publicId} belongs to a test account — staying silent`);
    return;
  }
  if (run.watchId && !(await watchWantsNotice(env, run.watchId, run.baselineRunId, verdict))) {
    return;
  }
  // CHE-96: carry the answer into the mail. Read back rather than threaded
  // through, because both callers (smoke shortcut and full run) reach here at
  // different points, and the row is the single source of truth by now.
  const written = await env.db.run.findUnique({
    where: { publicId: run.publicId },
    select: {
      bottomLine: true,
      findings: { select: { category: true }, where: { mark: { not: "false_positive" } } },
    },
  });
  const findings = written?.findings ?? [];
  await sendVerdictReady({
    to: run.notifyEmail,
    appSlug: run.appSlug,
    publicId: run.publicId,
    verdict,
    recurring: Boolean(run.watchId),
    bottomLine: written?.bottomLine ?? null,
    findingCounts: {
      total: findings.length,
      broken: findings.filter((f) => f.category === "broken" || f.category === "exposed").length,
    },
    apiKey: bindings.EMAIL_API_KEY,
    from: bindings.EMAIL_FROM,
    baseUrl: bindings.APP_URL,
  }).catch((err) => {
    console.warn(`[notify] verdict email failed: ${err instanceof Error ? err.message : err}`);
  });
}

// ─── Verdict integrity (CHE-42) ──────────────────────────────────────────────
// Two rules the synthesis prompt asks for and this code then enforces, because
// a prompt is a request and a verdict is a promise:
//
//   1. Zero coverage is never a pass. Run #19 walked nothing and still shipped
//      "all good" — a run that verified nothing gets "unverified", full stop.
//   2. "Broken" needs a body. Run #20 called an app broken off eight risky /
//      confusing / polish findings; without a broken/exposed finding or an
//      observed broken/exposed step, it downgrades to "needs attention".
//
// Both rewrite bottomLine too — a corrected pill over uncorrected prose would
// just move the contradiction one line down.

async function checkVerdictIntegrity(
  env: AgentEnv,
  runId: string,
  synth: { verdict: Verdict; bottomLine: string | null },
): Promise<{ verdict: Verdict; bottomLine: string | null; note: string | null }> {
  const journeys = await env.db.journey.findMany({
    where: { runId },
    select: { status: true, steps: { select: { status: true } } },
  });
  const findings = await env.db.finding.findMany({
    where: { runId },
    select: { category: true, severity: true },
  });

  const walked = journeys.filter((j) => j.status !== "skipped");
  if (walked.length === 0) {
    // The model wrote its bottom line believing its verdict would stand, so it
    // is demoted to an outside observation rather than dropped or left to
    // contradict the coverage sentence.
    return {
      verdict: "unverified",
      bottomLine:
        "We couldn't verify anything this run — no user journey was walked, so read this as " +
        "zero coverage, not a clean bill of health." +
        (synth.bottomLine ? ` What we saw from the outside: ${synth.bottomLine}` : ""),
      note: `Zero journeys walked — verdict recorded as Not verified, not ${synth.verdict}`,
    };
  }

  // Findings are the adjudicated evidence (synthesis re-reads every step with
  // full context); step labels alone don't qualify — run #28's background
  // analytics 401 was step-labeled broken while every user journey worked.
  // Security exposures need HIGH severity to carry a broken verdict (run #29's
  // by-design medium exposure painted a working product broken).
  if (synth.verdict === "broken") {
    const evidence = findings.some(
      (f) => f.category === "broken" || (f.category === "exposed" && f.severity === "high"),
    );
    if (!evidence) {
      return {
        verdict: "needs_attention",
        bottomLine:
          sentence(synth.bottomLine ?? "Nothing we walked failed outright") +
          " Downgraded from Broken: no direct breakage evidence was captured.",
        note: "Verdict downgraded from Broken — nothing we observed actually broke",
      };
    }
  }
  return { verdict: synth.verdict, bottomLine: synth.bottomLine, note: null };
}

// Close a model-written line so a clause can be appended after it.
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// ─── Watch notifications (CHE-41) ────────────────────────────────────────────
// notifyOnChangeOnly means the owner only wants to hear from a recurring watch
// when something moved: the verdict differs from the baseline this run was
// diffed against. No baseline = first run of the watch = always worth sending.

async function ownedByTestAccount(env: AgentEnv, publicId: string): Promise<boolean> {
  const row = await env.db.run.findUnique({
    where: { publicId },
    select: { owner: { select: { isTestAccount: true } } },
  });
  return Boolean(row?.owner?.isTestAccount);
}

async function watchWantsNotice(
  env: AgentEnv,
  watchId: string,
  baselineRunId: string | null,
  verdict: string | null,
): Promise<boolean> {
  const watch = await env.db.watch.findUnique({
    where: { id: watchId },
    select: { notifyOnChangeOnly: true },
  });
  if (!watch?.notifyOnChangeOnly) return true;
  if (!baselineRunId) return true;
  const baseline = await env.db.run.findUnique({
    where: { id: baselineRunId },
    select: { verdict: true },
  });
  return !baseline || baseline.verdict !== verdict;
}

// ─── Outbound integrations (CHE-53) ──────────────────────────────────────────
// Build one run.completed payload and deliver it to whichever endpoints the
// app has configured: generic webhook (HMAC-signed if a secret is set) and/or
// the Slack preset. Both deliveries are best-effort and report run events.

// Worst first, so the payload's 10-finding cap keeps breakage over polish.
const FINDING_SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

async function notifyIntegrations(
  env: AgentEnv,
  runId: string,
  verdict: Verdict,
): Promise<{ icon: "ok" | "warn"; text: string }[]> {
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: {
      appId: true,
      appSlug: true,
      runNumber: true,
      publicId: true,
      bottomLine: true,
      baselineRunId: true,
      completedAt: true,
      deploySha: true,
      deployEnv: true,
    },
  });
  if (!run?.appId) return [];

  const app = await env.db.app.findUnique({
    where: { id: run.appId },
    select: { webhookUrl: true, slackWebhookUrl: true, webhookSecretEnc: true },
  });
  if (!app || (!app.webhookUrl && !app.slackWebhookUrl)) return [];

  const baseline = run.baselineRunId
    ? await env.db.run.findUnique({
        where: { id: run.baselineRunId },
        select: { verdict: true },
      })
    : null;
  const previousVerdict = baseline?.verdict ?? null;

  const findings = await env.db.finding.findMany({
    where: { runId },
    select: { title: true, category: true, severity: true },
    orderBy: { number: "asc" },
  });
  const top = findings
    .sort(
      (a, b) => (FINDING_SEVERITY_RANK[a.severity] ?? 3) - (FINDING_SEVERITY_RANK[b.severity] ?? 3),
    )
    .slice(0, 10);

  const baseUrl = env.bindings.APP_URL ?? "https://checkmyapp.dev";
  const payload: RunCompletedPayload = {
    event: "run.completed",
    app: run.appSlug,
    runNumber: run.runNumber,
    verdict,
    deploy: run.deploySha ? { sha: run.deploySha, env: run.deployEnv } : null,
    previousVerdict,
    changed: previousVerdict !== verdict,
    bottomLine: run.bottomLine,
    findings: top,
    verdictUrl: `${baseUrl}/verdict/${run.publicId}`,
    completedAt: (run.completedAt ?? new Date()).toISOString(),
  };

  const notes: { icon: "ok" | "warn"; text: string }[] = [];
  if (app.webhookUrl) {
    const secret = app.webhookSecretEnc ? decryptSecret(app.webhookSecretEnc) : null;
    const r = await deliverWebhook(app.webhookUrl, payload, secret);
    notes.push(
      r.ok
        ? { icon: "ok", text: `Webhook delivered (${r.status})` }
        : {
            icon: "warn",
            text: `Webhook delivery failed${r.status ? ` (HTTP ${r.status})` : `: ${r.error}`}`,
          },
    );
  }
  if (app.slackWebhookUrl) {
    const r = await deliverSlack(app.slackWebhookUrl, payload);
    notes.push(
      r.ok
        ? { icon: "ok", text: "Slack notification delivered" }
        : {
            icon: "warn",
            text: `Slack delivery failed${r.status ? ` (HTTP ${r.status})` : `: ${r.error}`}`,
          },
    );
  }
  return notes;
}

// ─── LLM usage ledger ────────────────────────────────────────────────────────
// One row per unit of work (phase, or journey within walking). Idempotent per
// (runId, phase, journeyId) so Workflow step retries replace, not duplicate.

async function recordUsage(
  env: AgentEnv,
  runId: string,
  phase: string,
  model: string,
  usage: UsageTotals,
  journeyId?: string | null,
) {
  await env.db.llmUsage.deleteMany({
    where: { runId, phase, journeyId: journeyId ?? null },
  });
  await env.db.llmUsage.create({
    data: { runId, phase, journeyId: journeyId ?? null, model, ...usage },
  });
}

// ─── findings persistence (port of pipeline.persistFindings) ─────────────────

async function persistFindings(env: AgentEnv, runId: string, findings: SynthesizedFinding[]) {
  if (!findings.length) return;
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: { appSlug: true },
  });
  const journeys = await env.db.journey.findMany({
    where: { runId },
    include: { steps: { orderBy: { order: "asc" }, include: { evidence: true } } },
    orderBy: { order: "asc" },
  });

  // Marks the owner set on earlier runs' findings (CHE-78: "That's fine" must
  // survive into the next run). Keyed by the CHE-59 dedup signature, so the
  // match tolerates prose drift; latest mark per signature wins. "watch" rides
  // its own priority channel and "none" carries nothing.
  const inheritedMarks = new Map<string, string>();
  if (run) {
    const marked = await env.db.finding.findMany({
      where: {
        mark: { in: ["known", "false_positive"] },
        run: { appSlug: run.appSlug, id: { not: runId } },
      },
      orderBy: { createdAt: "asc" },
      select: { title: true, category: true, severity: true, detail: true, mark: true },
    });
    for (const m of marked) {
      inheritedMarks.set(dedupKeyForFinding(m, { appSlug: run.appSlug }), m.mark);
    }
  }

  let number = 1;
  for (const f of findings) {
    const step = f.stepRef ? journeys[f.stepRef.journeyIndex]?.steps[f.stepRef.stepIndex] : undefined;
    const shot = step?.evidence.find((e) => e.type === "screenshot");
    const shaped = {
      title: f.title.slice(0, 300),
      category: f.category,
      severity: f.severity,
      detail: JSON.stringify(f.detail),
    };
    const mark = run ? inheritedMarks.get(dedupKeyForFinding(shaped, { appSlug: run.appSlug })) : undefined;
    await env.db.finding.create({
      data: {
        runId,
        number: number++,
        ...shaped,
        ...(mark ? { mark } : {}),
        evidence: shot
          ? { create: [{ type: "screenshot", storageUrl: shot.storageUrl, sha256: shot.sha256 }] }
          : undefined,
      },
    });
  }
}

// ─── D1 event helpers (single-instance serial — no transaction needed) ───────

async function setLive(
  env: AgentEnv,
  runId: string,
  data: { currentAction?: string; liveScreenshotUrl?: string },
) {
  await env.db.run.update({ where: { id: runId }, data });
}

async function transition(
  env: AgentEnv,
  runId: string,
  phase: RunPhase,
  event: Omit<RunEvent, "at" | "phase">,
) {
  const events = await readEvents(env, runId);
  events.push({ at: new Date().toISOString(), phase, ...event });
  await env.db.run.update({ where: { id: runId }, data: { status: phase, events: JSON.stringify(events) } });
}

async function appendEvent(
  env: AgentEnv,
  runId: string,
  phase: RunPhase,
  event: Omit<RunEvent, "at" | "phase">,
) {
  const events = await readEvents(env, runId);
  events.push({ at: new Date().toISOString(), phase, ...event });
  await env.db.run.update({ where: { id: runId }, data: { events: JSON.stringify(events) } });
}

async function readEvents(env: AgentEnv, runId: string): Promise<RunEvent[]> {
  const r = await env.db.run.findUnique({ where: { id: runId }, select: { events: true } });
  if (!r?.events) return [];
  try {
    return JSON.parse(r.events) as RunEvent[];
  } catch {
    return [];
  }
}
