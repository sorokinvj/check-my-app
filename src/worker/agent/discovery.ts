// Phase 2–3 — Surface scan + Discovery.
//
// Loads the target, detects the stack from response headers / bundle, logs in if
// credentials were provided, crawls navigation, and proposes up-to-5 coherent user
// journeys (4–10 steps each). Returns the journeys to walk plus the app anatomy.

import type { Browser } from "playwright";
import type { Run } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";
import type { AppAnatomy } from "@/lib/types";

export interface ProposedStep {
  label: string;
}

export interface ProposedJourney {
  title: string;
  steps: ProposedStep[];
}

export interface DiscoveryResult {
  journeys: ProposedJourney[];
  anatomy: AppAnatomy;
}

export async function discoverApp(args: {
  run: Run;
  browser: Browser;
}): Promise<DiscoveryResult> {
  const { run, browser } = args;
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(run.targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // If credentials were supplied, decrypt only here, in-memory, never logged.
    const _password = run.testPasswordEnc ? decryptSecret(run.testPasswordEnc) : undefined;
    void _password; // TODO: use during automated login

    // TODO: detect stack from headers + bundle (Next.js/Vercel/Supabase/Stripe/etc.)
    // TODO: attempt login when run.testEmail + _password are present
    // TODO: crawl nav/links/CTAs/forms into an internal graph
    // TODO: ask the LLM to cluster the graph into up-to-5 coherent journeys

    // Skeleton placeholder so the pipeline runs end-to-end.
    const anatomy: AppAnatomy = {
      pages: [],
      actions: [],
      services: [],
      tech: {},
    };
    const journeys: ProposedJourney[] = [];

    return { journeys, anatomy };
  } finally {
    await context.close();
  }
}
