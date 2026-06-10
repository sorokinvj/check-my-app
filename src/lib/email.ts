// Verdict-ready notifications. Provider-agnostic: wire Resend/Postmark/SES here.
// With no EMAIL_API_KEY set, it logs to the console so local dev works offline.

interface VerdictReadyArgs {
  to: string;
  appSlug: string;
  publicId: string;
  partial?: boolean;
}

export async function sendVerdictReady({
  to,
  appSlug,
  publicId,
  partial,
}: VerdictReadyArgs): Promise<void> {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const url = `${base}/verdict/${publicId}`;
  const subject = partial
    ? `We got partway through ${appSlug} — here's what we found`
    : `Your verdict for ${appSlug} is ready`;

  if (!process.env.EMAIL_API_KEY) {
    // eslint-disable-next-line no-console
    console.log(`[email:dev] to=${to} subject="${subject}" url=${url}`);
    return;
  }

  // TODO: replace with real provider call, e.g. Resend:
  //   await resend.emails.send({ from: process.env.EMAIL_FROM, to, subject, html });
  throw new Error("Email provider not implemented — set up src/lib/email.ts");
}
