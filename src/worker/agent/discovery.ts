// Phase 3 — Discovery (CHE-2, on top of the CHE-7 agent core).
//
// The LLM explores the target through browser tools, then returns the proposed
// journeys + app anatomy as JSON. Client scope hints/notes are authoritative
// text in the system prompt — this is what keeps a self-check from recursively
// submitting our own /check form.

import type { Browser } from "playwright";
import type { Run } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";
import type { AppAnatomy } from "@/lib/types";
import { hasApiKey } from "./llm";
import { runAgentLoop, finalizeJson, type TranscriptEntry } from "./core";
import { prepareAgentPage, type ToolEnv } from "./tools";
import { discoverySystem } from "./instructions";
import { storeScreenshot } from "./evidence";

export interface ProposedJourney {
  title: string;
  steps: string[];
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export interface DiscoveryResult {
  journeys: ProposedJourney[];
  anatomy: AppAnatomy;
  transcript: TranscriptEntry[];
}

export async function discoverApp(args: {
  run: Run;
  browser: Browser;
  onLiveScreenshot?: (url: string) => Promise<void>;
  onProgress?: (note: string) => Promise<void>;
}): Promise<DiscoveryResult> {
  const { run, browser, onLiveScreenshot, onProgress } = args;

  const empty: DiscoveryResult = {
    journeys: [],
    anatomy: { pages: [], actions: [], services: [], tech: {} },
    transcript: [],
  };
  if (!hasApiKey()) return empty; // offline dev: pipeline still completes

  const context = await browser.newContext();
  const page = await context.newPage();

  const env: ToolEnv = {
    page,
    targetOrigin: originOf(run.targetUrl),
    testEmail: run.testEmail ?? undefined,
    // Decrypted only here, in-memory; the LLM only ever sees {{TEST_PASSWORD}}.
    testPassword: run.testPasswordEnc ? decryptSecret(run.testPasswordEnc) : undefined,
    networkLog: [],
    consoleLog: [],
    onScreenshot: async (buffer) => {
      const { storageUrl } = await storeScreenshot(buffer);
      await onLiveScreenshot?.(storageUrl);
      return storageUrl;
    },
  };
  await prepareAgentPage(env);

  try {
    const result = await runAgentLoop({
      system: discoverySystem(run),
      task: `Target app: ${run.targetUrl}\nStart by navigating there, read the page, then explore.`,
      env,
      maxIterations: 30,
      onProgress,
    });

    let parsed = parseDiscoveryJson(result.finalText);
    if (!parsed) {
      // Final turn didn't parse (truncation/prose) — ask once for clean JSON.
      const retry = await finalizeJson(
        result.messages,
        "Output ONLY the discovery JSON object now (journeys + anatomy), no prose, no markdown fences.",
      );
      parsed = parseDiscoveryJson(retry);
    }
    return { ...(parsed ?? empty), transcript: result.transcript };
  } finally {
    await context.close();
  }
}

function parseDiscoveryJson(text: string): Omit<DiscoveryResult, "transcript"> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as {
      journeys?: Array<{ title?: string; steps?: string[] }>;
      anatomy?: Partial<AppAnatomy>;
    };
    return {
      journeys: (raw.journeys ?? [])
        .filter((j) => j.title)
        .slice(0, 5)
        .map((j) => ({ title: String(j.title), steps: (j.steps ?? []).map(String) })),
      anatomy: {
        pages: raw.anatomy?.pages ?? [],
        actions: raw.anatomy?.actions ?? [],
        services: raw.anatomy?.services ?? [],
        tech: raw.anatomy?.tech ?? {},
      },
    };
  } catch {
    return null;
  }
}
