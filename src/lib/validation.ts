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
