"use client";

import { useState } from "react";
import type { Evidence, Finding } from "@/generated/prisma/client";
import type { FindingMark } from "@/lib/enums";
import type { FindingDetail } from "@/lib/types";
import { parseJson } from "@/lib/json";
import { CATEGORY_META, CATEGORY_ORDER, SEVERITY_META } from "@/lib/status";

type FindingWithEvidence = Finding & { evidence: Evidence[] };

const EVIDENCE_LABEL: Record<Evidence["type"], string> = {
  screenshot: "📷 screenshot",
  screencast: "▶ video clip",
  console_log: "📋 console",
  network_har: "📋 HAR",
  dom_snapshot: "📋 DOM",
};

const MARK_LABEL: Record<FindingMark, string | null> = {
  none: null,
  known: "that's fine",
  fixed: "marked fixed",
  false_positive: "disputed",
  watch: "watching",
};

// Verdict §3.4 — "WHAT WE FOUND". Third on purpose: lead with the mirror, not the
// bug list. Grouped by category; each finding expands to full detail + evidence +
// triage actions (Loop C — marks feed the Daily Check noise filter).
export function FindingsList({ findings }: { findings: FindingWithEvidence[] }) {
  const counts = CATEGORY_ORDER.filter(
    (c) => findings.some((f) => f.category === c),
  )
    .map((c) => `${findings.filter((f) => f.category === c).length} ${c}`)
    .join(" · ");

  return (
    <section>
      <h2 className="section-label">What we found</h2>
      <p className="mt-1 font-mono text-[13px] text-fg-muted">{counts || "Nothing recorded yet."}</p>

      <div className="mt-4 space-y-2.5">
        {CATEGORY_ORDER.map((category) => {
          const group = findings.filter((f) => f.category === category);
          if (group.length === 0) return null;
          const meta = CATEGORY_META[category];
          return (
            <details
              key={category}
              className="card overflow-hidden"
              open={category === "broken" || category === "exposed"}
            >
              <summary className="flex cursor-pointer select-none items-center justify-between px-5 py-3.5 transition-colors hover:bg-ink-800/50">
                <span className={`text-sm font-medium ${meta.className}`}>
                  <span className="chevron mr-2 inline-block text-fg-faint">›</span>
                  {meta.emoji} {meta.label} ({group.length})
                </span>
                {category === "exposed" && (
                  <span className="font-mono text-[11px] uppercase tracking-wider text-status-exposed">
                    critical
                  </span>
                )}
              </summary>
              <ul className="space-y-2 border-t border-ink-700 p-4">
                {group.map((f) => (
                  <FindingRow key={f.id} finding={f} />
                ))}
              </ul>
            </details>
          );
        })}
        {findings.length === 0 && (
          <p className="text-sm text-fg-faint">No findings recorded yet.</p>
        )}
      </div>
    </section>
  );
}

function FindingRow({ finding }: { finding: FindingWithEvidence }) {
  const [mark, setMark] = useState<FindingMark>(finding.mark as FindingMark);
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<{ id: string; url?: string } | null>(null);
  const [ticketErr, setTicketErr] = useState<string | null>(null);
  const detail = parseJson<FindingDetail>(finding.detail) ?? {};
  const sev = SEVERITY_META[finding.severity];
  const markLabel = MARK_LABEL[mark];

  async function createTicket() {
    setBusy(true);
    setTicketErr(null);
    const res = await fetch(`/api/findings/${finding.id}/ticket`, { method: "POST" }).catch(
      () => null,
    );
    const body = ((await res?.json().catch(() => null)) ?? {}) as {
      identifier?: string;
      url?: string;
      message?: string;
      error?: string;
    };
    if (res?.ok && body.identifier) {
      setTicket({ id: body.identifier, url: body.url });
    } else {
      setTicketErr(body.message ?? body.error ?? "Couldn't create the ticket.");
    }
    setBusy(false);
  }

  async function setMarkRemote(next: FindingMark) {
    setBusy(true);
    const prev = mark;
    setMark(next);
    const res = await fetch(`/api/findings/${finding.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mark: next }),
    }).catch(() => null);
    if (!res?.ok) setMark(prev);
    setBusy(false);
  }

  return (
    <li>
      <details className={`rounded-lg border border-ink-700 bg-ink-900 ${markLabel ? "opacity-60" : ""}`}>
        <summary className="flex cursor-pointer select-none items-baseline gap-3 px-4 py-3">
          <span className="font-mono text-xs text-fg-faint">
            #{String(finding.number).padStart(3, "0")}
          </span>
          <span className="flex-1 text-sm text-fg">{finding.title}</span>
          {markLabel && (
            <span className="rounded-full bg-ink-800 px-2 py-0.5 font-mono text-[11px] text-fg-faint">
              {markLabel}
            </span>
          )}
          <span className={`font-mono text-[11px] font-semibold ${sev.className}`}>
            [{sev.label}]
          </span>
        </summary>

        <div className="space-y-3 border-t border-ink-700 px-4 py-4">
          <div className="grid gap-x-6 gap-y-1 font-mono text-[13px] leading-6 text-fg-muted sm:grid-cols-[auto_1fr]">
            {detail.where && (
              <>
                <span className="text-fg-faint">Where:</span>
                <span>{detail.where}</span>
              </>
            )}
            {detail.browser && (
              <>
                <span className="text-fg-faint">Browser:</span>
                <span>{detail.browser}</span>
              </>
            )}
            {typeof detail.reproduced === "number" && (
              <>
                <span className="text-fg-faint">Reproduced:</span>
                <span>{detail.reproduced} times</span>
              </>
            )}
          </div>

          {detail.whatWeTried && detail.whatWeTried.length > 0 && (
            <div>
              <p className="section-label mb-1.5">What we tried</p>
              <ol className="space-y-0.5 font-mono text-[13px] leading-6 text-fg-muted">
                {detail.whatWeTried.map((s, i) => (
                  <li key={i}>
                    <span className="text-fg-faint">{i + 1}.</span> {s}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {detail.whatHappened && (
            <div>
              <p className="section-label mb-1.5">What happened</p>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-ink-950 p-3 font-mono text-xs leading-5 text-fg-muted">
                {detail.whatHappened}
              </pre>
            </div>
          )}

          {detail.whyItMatters && (
            <div>
              <p className="section-label mb-1.5">Why this matters</p>
              <p className="text-sm leading-relaxed text-fg">{detail.whyItMatters}</p>
            </div>
          )}

          {finding.evidence.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {finding.evidence.map((ev) => (
                <a
                  key={ev.id}
                  href={ev.storageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-ink-600 px-2.5 py-1 font-mono text-xs text-fg-muted transition-colors hover:border-ink-700 hover:text-fg"
                >
                  {EVIDENCE_LABEL[ev.type]}
                </a>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-ink-700 pt-3">
            {/* Loop C triage: "That's fine" mutes it for future runs (noise
                filter), "Watch it" makes the next run verify it FIRST, and
                "Create Ticket" files it into the owner's Linear with the
                onboarding TicketPolicy parameters. */}
            <TriageButton
              active={mark === "known"}
              disabled={busy}
              onClick={() => setMarkRemote(mark === "known" ? "none" : "known")}
            >
              That&apos;s fine
            </TriageButton>
            <TriageButton
              active={mark === "watch"}
              disabled={busy}
              onClick={() => setMarkRemote(mark === "watch" ? "none" : "watch")}
            >
              Watch it
            </TriageButton>
            <TriageButton
              active={mark === "fixed"}
              disabled={busy}
              onClick={() => setMarkRemote(mark === "fixed" ? "none" : "fixed")}
            >
              Mark as fixed
            </TriageButton>
            <TriageButton
              active={mark === "false_positive"}
              disabled={busy}
              onClick={() => setMarkRemote(mark === "false_positive" ? "none" : "false_positive")}
            >
              Dispute
            </TriageButton>
            {ticket ? (
              <a
                href={ticket.url}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 font-mono text-xs text-accent"
              >
                ✓ {ticket.id}
              </a>
            ) : (
              <TriageButton active={false} disabled={busy} onClick={createTicket}>
                Create Ticket
              </TriageButton>
            )}
            {ticketErr && <span className="text-xs text-status-broken">{ticketErr}</span>}
          </div>
        </div>
      </details>
    </li>
  );
}

function TriageButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 font-mono text-xs transition-colors disabled:opacity-50 ${
        active
          ? "border-accent bg-accent/15 text-accent"
          : "border-ink-600 text-fg-muted hover:border-ink-700 hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
