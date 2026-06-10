// Shared domain types that aren't fully captured by the Prisma schema —
// mostly the shapes of JSON columns and the queue payload.

export type RunPhase =
  | "connecting" // 🔌 agent boot, ownership check
  | "surface_scan" // 🌐 homepage load, stack detection
  | "discovery" // 🔍 login, mapping nav, finding journeys
  | "walking" // 🚶 executing each discovered journey
  | "anatomy" // 🧩 assembling pages/actions/services/tech
  | "writing"; // 📋 LLM synthesizes the verdict

export const PHASE_ORDER: RunPhase[] = [
  "connecting",
  "surface_scan",
  "discovery",
  "walking",
  "anatomy",
  "writing",
];

export const PHASE_LABELS: Record<RunPhase, string> = {
  connecting: "🔌 Connecting",
  surface_scan: "🌐 Surface scan",
  discovery: "🔍 Discovery",
  walking: "🚶 Walking journeys",
  anatomy: "🧩 Anatomy",
  writing: "📋 Writing verdict",
};

// One line in the live activity feed on /run/{id}.
export interface RunEvent {
  at: string; // ISO timestamp
  phase: RunPhase;
  icon: "ok" | "info" | "notable" | "working" | "warn";
  text: string; // "Detected Next.js + Vercel"
}

// The App Lens: 5–7 PM-voice bullets. Rendered at the top of the verdict.
export interface AppLens {
  oneLiner: string; // "joblander.app is an AI-powered interview prep platform..."
  whoFor: string;
  coreValue: string;
  businessModel: string;
  techSurface: string;
  criticalPaths: string[];
  ifItBreaks: string;
}

// App Anatomy: the secondary "under the hood" lens.
export interface AppAnatomy {
  pages: string[];
  actions: string[];
  services: { name: string; role: string }[];
  tech: {
    frontend?: string;
    hosting?: string;
    auth?: string;
    realtime?: string;
    [k: string]: string | undefined;
  };
}

// Structured body of a Finding.detail JSON column.
export interface FindingDetail {
  where?: string; // "POST /api/auth/signup → 500"
  browser?: string; // "Mobile Safari simulation (iPhone 14)"
  reproduced?: number;
  whatWeTried?: string[];
  whatHappened?: string;
  whyItMatters?: string;
}

// Payload pushed onto the BullMQ queue when a run is created.
export interface RunJobData {
  runId: string;
}

export const RUN_QUEUE_NAME = "checkmyapp.runs";
