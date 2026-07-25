// Phase 3 — Discovery (CF agent). The LLM explores the target through browser
// tools and returns proposed journeys + app anatomy as JSON. Client scope
// hints/notes are authoritative text in the system prompt (recursion guard).

import type { Browser } from "@cloudflare/playwright";
import { decryptSecret } from "@/lib/crypto";
import type { AppAnatomy } from "@/lib/types";
import { runAgentLoop, finalizeStructured, type TranscriptEntry } from "./core";
import { prepareAgentPage, type ToolEnv } from "./tools";
import { discoverySystem } from "./instructions";
import { putScreenshot, type AgentEnv } from "./env";
import { emptyUsage, mergeUsage, type LlmConfig, type UsageTotals } from "./llm";

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
  usage: UsageTotals;
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
    usage: emptyUsage(),
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

    let costUsd = result.costUsd;
    const usage = result.usage;

    // Guaranteed structured extraction. The model frequently spends its whole
    // iteration budget exploring and never emits the closing JSON on its own —
    // so instead of hoping its final text parses, we always run a structured
    // pass over the exploration context that forces schema-valid journeys +
    // anatomy. This is what makes discovery reliable instead of coin-flip.
    // A failure in the extraction (bad schema, transient API) must NEVER throw
    // out of the discovery step — that would make Cloudflare retry the entire
    // ~10-min exploration from scratch. Catch and fall back to scraping the
    // model's free-text final answer instead.
    let parsed: ShapedDiscovery | null = null;
    try {
      const extracted = await finalizeStructured<RawDiscovery>(
        llm,
        result.messages,
        "Based ONLY on what you actually explored above, output the discovery result: " +
          "3-5 concrete user journeys (each a title + ordered steps) covering the app's core " +
          "flows (e.g. sign up / log in, the primary value action, account/settings), plus the " +
          "app anatomy (pages, actions, external services, tech as key/value pairs). Every app " +
          "has at least one core journey — never return an empty journeys array.",
        DISCOVERY_SCHEMA,
      );
      costUsd += extracted.costUsd;
      mergeUsage(usage, extracted.usage);
      if (extracted.parsed) parsed = shapeDiscovery(extracted.parsed);
    } catch (err) {
      console.error("[discovery] structured extraction failed:", err);
    }
    if (!parsed) parsed = parseDiscoveryJson(result.finalText);

    // Still no journeys → one focused structured retry dedicated to journeys.
    if (parsed && parsed.journeys.length === 0) {
      try {
        const j = await finalizeStructured<{ journeys?: RawDiscovery["journeys"] }>(
          llm,
          result.messages,
          "You proposed no user journeys — that is wrong. Propose 3-5 user journeys a real " +
            "user would take, based only on what you saw. Each is a title plus ordered steps.",
          JOURNEYS_SCHEMA,
        );
        costUsd += j.costUsd;
        mergeUsage(usage, j.usage);
        const recovered = shapeDiscovery({ journeys: j.parsed?.journeys ?? [] }).journeys;
        if (recovered.length > 0) parsed = { ...parsed, journeys: recovered };
      } catch (err) {
        console.error("[discovery] journeys retry failed:", err);
      }
    }
    return { ...(parsed ?? empty), transcript: result.transcript, costUsd, usage };
  } finally {
    await context.close();
  }
}

interface RawDiscovery {
  journeys?: Array<{ title?: string; steps?: string[] }>;
  anatomy?: {
    pages?: unknown;
    actions?: unknown;
    services?: unknown;
    // structured outputs can't express an open string map, so `tech` comes back
    // as an array of {key,value} pairs; free-text parses may send a record.
    tech?: Array<{ key?: string; value?: string }> | Record<string, string>;
  };
}

type ShapedDiscovery = Omit<DiscoveryResult, "transcript" | "costUsd" | "usage">;

function techToRecord(tech: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(tech)) {
    for (const p of tech) {
      if (p && typeof p === "object" && typeof p.key === "string" && typeof p.value === "string") {
        out[p.key] = p.value;
      }
    }
  } else if (tech && typeof tech === "object") {
    for (const [k, v] of Object.entries(tech as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

// Normalize a raw (structured-output or hand-parsed) discovery object into the
// DiscoveryResult shape: at most 5 titled journeys, anatomy fields defaulted.
// normalizeAnatomy (workflow) re-coerces anatomy again before persistence, so
// loose shapes here are safe.
function shapeDiscovery(raw: RawDiscovery): ShapedDiscovery {
  const a = raw.anatomy ?? {};
  return {
    journeys: (raw.journeys ?? [])
      .filter((j) => j.title)
      .slice(0, 5)
      .map((j) => ({ title: String(j.title), steps: (j.steps ?? []).map(String) })),
    anatomy: {
      pages: (Array.isArray(a.pages) ? a.pages : []) as AppAnatomy["pages"],
      actions: (Array.isArray(a.actions) ? a.actions : []) as AppAnatomy["actions"],
      services: (Array.isArray(a.services) ? a.services : []) as AppAnatomy["services"],
      tech: techToRecord(a.tech),
    },
  };
}

// Fallback only — used when structured extraction returns nothing and we scrape
// the model's final free-text for a JSON object.
function parseDiscoveryJson(text: string): ShapedDiscovery | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return shapeDiscovery(JSON.parse(match[0]) as RawDiscovery);
  } catch {
    return null;
  }
}

// Strict JSON schemas for structured outputs. additionalProperties:false and
// full required lists are mandatory for the json_schema output format.
const JOURNEY_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "steps"],
  properties: {
    title: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
  },
};

const JOURNEYS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["journeys"],
  properties: {
    journeys: { type: "array", items: JOURNEY_ITEM_SCHEMA },
  },
};

const DISCOVERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["journeys", "anatomy"],
  properties: {
    journeys: { type: "array", items: JOURNEY_ITEM_SCHEMA },
    anatomy: {
      type: "object",
      additionalProperties: false,
      required: ["pages", "actions", "services", "tech"],
      properties: {
        pages: { type: "array", items: { type: "string" } },
        actions: { type: "array", items: { type: "string" } },
        services: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "role"],
            properties: { name: { type: "string" }, role: { type: "string" } },
          },
        },
        tech: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "value"],
            properties: { key: { type: "string" }, value: { type: "string" } },
          },
        },
      },
    },
  },
};
