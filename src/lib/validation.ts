import { z } from "zod";

// Submission payload from the /check form (Screen 1).
export const createCheckSchema = z.object({
  url: z
    .string()
    .trim()
    .url("Doesn't look like a working URL")
    .refine((u) => /^https?:\/\//.test(u), "URL must start with http:// or https://"),
  testEmail: z.string().email().optional().or(z.literal("")),
  testPassword: z.string().optional().or(z.literal("")),
  scopeHints: z.string().max(2000).optional().or(z.literal("")),
  userNotes: z.string().max(2000).optional().or(z.literal("")),
  notifyEmail: z.string().email("Enter a valid email").optional().or(z.literal("")),
});

export type CreateCheckInput = z.infer<typeof createCheckSchema>;

// Loop C — edit the App Lens / react to it (Verdict §3.1).
export const updateLensSchema = z.object({
  lens: z
    .object({
      oneLiner: z.string().max(500),
      whoFor: z.string().max(500),
      coreValue: z.string().max(500),
      businessModel: z.string().max(500),
      techSurface: z.string().max(500),
      criticalPaths: z.array(z.string().max(300)).max(10),
      ifItBreaks: z.string().max(500),
    })
    .optional(),
  // "confirmed" = [Looks right ✓]; anything else = the "something's off" note.
  feedback: z.string().max(2000).optional(),
});

// Loop C — finding triage from the verdict page (feeds Daily Check noise filter).
export const markFindingSchema = z.object({
  mark: z.enum(["none", "known", "fixed", "false_positive"]),
});

// Enable Daily Watch from the verdict footer (Loop B).
export const createWatchSchema = z.object({
  runId: z.string().min(1), // run publicId the watch is created from
  frequency: z.enum(["daily", "every_6h", "manual"]).default("daily"),
  notifyOnChangeOnly: z.boolean().default(true),
});

// Connect GitHub for spec export (verdict "Export to GitHub"). v1: fine-grained
// PAT + owner/repo; the token is validated against the repo before storing.
export const connectGithubSchema = z.object({
  runId: z.string().min(1), // run publicId the connect started from
  token: z.string().trim().min(20).max(400),
  repo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use the owner/repo form"),
});

// Watch settings (Screen 4).
export const updateWatchSchema = z.object({
  frequency: z.enum(["daily", "every_6h", "manual"]).optional(),
  notifyOnChangeOnly: z.boolean().optional(),
  active: z.boolean().optional(),
});
