// Verdict-ready notifications, provider = Resend (plain fetch — works in both
// Node and workerd). Config arrives as arguments because the agent worker has
// no process.env: bindings flow in from workflow.ts. With no apiKey the send
// degrades to a console log so local dev works offline.

import { VERDICT_META } from "@/lib/status";

interface VerdictReadyArgs {
  to: string;
  appSlug: string;
  publicId: string;
  partial?: boolean;
  // Verdict of the finished run — surfaced in the subject and body when known.
  verdict?: string | null;
  // The run came from a Daily Watch, so the mail is a recurring report rather
  // than the one-off result the /check form promised.
  recurring?: boolean;
  apiKey?: string;
  from?: string;
  baseUrl?: string;
}

export async function sendVerdictReady({
  to,
  appSlug,
  publicId,
  partial,
  verdict,
  recurring,
  apiKey,
  from,
  baseUrl,
}: VerdictReadyArgs): Promise<void> {
  const base = baseUrl ?? "http://localhost:3000";
  const url = `${base}/verdict/${publicId}`;
  const label = verdict ? (VERDICT_META[verdict]?.label ?? verdict) : null;
  const subject = partial
    ? `We got partway through ${appSlug} — here's what we found`
    : recurring
      ? `Daily check: ${appSlug}${label ? ` — ${label}` : ""}`
      : `Your verdict for ${appSlug} is ready`;

  if (!apiKey || !from) {
    // eslint-disable-next-line no-console
    console.log(`[email:dev] to=${to} subject="${subject}" url=${url}`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html:
        `<p>We finished looking at <strong>${appSlug}</strong>.</p>` +
        (label ? `<p>Verdict: <strong>${label}</strong></p>` : "") +
        `<p><a href="${url}">Open your verdict</a></p><p>— CheckMyApp</p>`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}
