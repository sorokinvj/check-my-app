// Phase 3 — Discovery (CF agent). The LLM explores the target through browser
// tools and returns proposed journeys + app anatomy as JSON. Client scope
// hints/notes are authoritative text in the system prompt (recursion guard).

import type { Browser } from "@cloudflare/playwright";
import { decryptSecret } from "@/lib/crypto";
import type { AppAnatomy } from "@/lib/types";
import { runAgentLoop, finalizeJson, type TranscriptEntry } from "./core";
import { prepareAgentPage, type ToolEnv } from "./tools";
import { discoverySystem } from "./instructions";
import { putScreenshot, type AgentEnv } from "./env";
import type { LlmConfig } from "./llm";

export interface RunInput {
  targetUrl: string;
  testEmail: string | null;
  testPasswordEnc: string | null;
  scopeHints: string | null;
  userNotes: string | null;
}

export interface ProposedJourney {
  title: string;
  steps: string[];
}

export interface DiscoveryResult {
  journeys: ProposedJourney[];
  anatomy: AppAnatomy;
  transcript: TranscriptEntry[];
  costUsd: number;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export async function discoverApp(args: {
  env: AgentEnv;
  llm: LlmConfig;
  browser: Browser;
  run: RunInput;
  onLiveScreenshot?: (url: string) => Promise<void>;
  onProgress?: (note: string) => Promise<void>;
}): Promise<DiscoveryResult> {
  const { env, llm, browser, run, onLiveScreenshot, onProgress } = args;
  const empty: DiscoveryResult = {
    journeys: [],
    anatomy: { pages: [], actions: [], services: [], tech: {} },
    transcript: [],
    costUsd: 0,
  };

  const context = await browser.newContext();
  const page = await context.newPage();

  const toolEnv: ToolEnv = {
    page,
    targetOrigin: originOf(run.targetUrl),
    testEmail: run.testEmail ?? undefined,
    // Decrypted only here, in-memory; the LLM only ever sees {{TEST_PASSWORD}}.
    testPassword: run.testPasswordEnc ? decryptSecret(run.testPasswordEnc) : undefined,
    networkLog: [],
    consoleLog: [],
    onScreenshot: async (buffer) => {
      const { storageUrl } = await putScreenshot(env, buffer);
      await onLiveScreenshot?.(storageUrl);
      return storageUrl;
    },
  };
  await prepareAgentPage(toolEnv);

  try {
    const result = await runAgentLoop({
      system: discoverySystem(run),
      task: `Target app: ${run.targetUrl}\nStart by navigating there, read the page, then explore.`,
      env: toolEnv,
      llm,
      maxIterations: 55,
      onProgress,
    });

    let parsed = parseDiscoveryJson(result.finalText);
    if (!parsed) {
      const retry = await finalizeJson(
        llm,
        result.messages,
        "Output ONLY the discovery JSON object now (journeys + anatomy), no prose, no markdown fences.",
      );
      parsed = parseDiscoveryJson(retry);
    }
    // A successful parse with zero journeys is a convergence failure, not an
    // empty app — every real app has at least a primary flow. Reuse the
    // exploration context for a focused journey extraction before giving up.
    if (parsed && parsed.journeys.length === 0) {
      const retry = await finalizeJson(
        llm,
        result.messages,
        "You explored the app but proposed no user journeys. That is wrong — every app has " +
          "at least one core flow. Based ONLY on what you actually saw, propose 3-5 user " +
          "journeys a real user would take (e.g. sign up, the primary value action, account/" +
          "settings). Output ONLY JSON: {\"journeys\":[{\"title\":\"...\",\"steps\":[\"...\"]}]}. " +
          "No prose, no markdown fences.",
      );
      const recovered = parseDiscoveryJson(retry);
      if (recovered && recovered.journeys.length > 0) {
        parsed = { ...parsed, journeys: recovered.journeys };
      }
    }
    return { ...(parsed ?? empty), transcript: result.transcript, costUsd: result.costUsd };
  } finally {
    await context.close();
  }
}

function parseDiscoveryJson(
  text: string,
): Omit<DiscoveryResult, "transcript" | "costUsd"> | null {
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
