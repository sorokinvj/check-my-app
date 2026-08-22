// Slack preset (CHE-53) — the same run.completed event as the generic webhook,
// pre-formatted as Slack Blocks so an owner can paste an Incoming Webhook URL
// and get readable daily-check posts with zero glue code. Fires on every
// completed watch run, like the generic webhook (consumers mute the channel,
// we don't guess for them).
//
// Workerd-safe: plain fetch, no signing (Slack incoming webhook URLs are
// themselves the capability). Delivery shares the webhook module's
// timeout + single-retry contract and never throws.

import { VERDICT_META, SEVERITY_META, CATEGORY_META } from "@/lib/status";
import {
  postWithRetry,
  type DeliveryResult,
  type RunCompletedPayload,
} from "./webhook";

export async function deliverSlack(
  url: string,
  payload: RunCompletedPayload,
): Promise<DeliveryResult> {
  const body = JSON.stringify(slackMessage(payload));
  return postWithRetry(url, { "Content-Type": "application/json" }, body);
}

// Blocks layout: verdict header → app + run context → bottom line → top
// findings as fields → a button to the verdict page.
export function slackMessage(p: RunCompletedPayload): Record<string, unknown> {
  const meta = p.verdict ? VERDICT_META[p.verdict] : undefined;
  const emoji = meta?.emoji ?? "◌";
  const label = meta?.label ?? (p.verdict ?? "No verdict");

  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${label}`, emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `*${p.app}* · Run #${p.runNumber}` +
            (p.previousVerdict && p.changed
              ? ` · was ${VERDICT_META[p.previousVerdict]?.label ?? p.previousVerdict}`
              : ""),
        },
      ],
    },
  ];

  if (p.bottomLine) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: p.bottomLine } });
  }

  if (p.findings.length) {
    // Slack caps section fields at 10 — the payload is already capped there too.
    blocks.push({
      type: "section",
      fields: p.findings.slice(0, 10).map((f) => ({
        type: "mrkdwn",
        text:
          `${CATEGORY_META[f.category]?.emoji ?? "•"} ` +
          `*${SEVERITY_META[f.severity]?.label ?? f.severity}* ${f.title}`,
      })),
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open verdict", emoji: true },
        url: p.verdictUrl,
      },
    ],
  });

  // `text` is the notification fallback for clients that don't render blocks.
  return { text: `${emoji} ${p.app} · Run #${p.runNumber} — ${label}`, blocks };
}
