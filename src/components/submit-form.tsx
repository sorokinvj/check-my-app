"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VERDICT_META } from "@/lib/status";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

// Domain-keyed result cache hit (CHE-39) — latest completed run for this domain.
type LookupHit = {
  appSlug: string;
  count: number;
  run: {
    publicId: string;
    runNumber: number;
    verdict: string | null;
    bottomLine: string | null;
    completedAt: string | null;
  };
  watched: boolean;
  ageDays: number | null;
  stale: boolean;
};

// Screen 1 — Submit. One field, one button; credentials/notes hidden behind a
// single toggle so casual visitors aren't scared off.
export function SubmitForm({ initialUrl = "" }: { initialUrl?: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(initialUrl);
  // The URL the hit was fetched for rides along so a stale card never renders.
  const [lookupState, setLookupState] = useState<{ forUrl: string; hit: LookupHit } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testPassword, setTestPassword] = useState("");
  const [userNotes, setUserNotes] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);

  // Render the Turnstile widget only when a site key is configured (prod).
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !turnstileRef.current) return;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = () => {
      const ts = (window as unknown as { turnstile?: { render: (el: HTMLElement, o: object) => void } })
        .turnstile;
      ts?.render(turnstileRef.current as HTMLElement, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token: string) => setTurnstileToken(token),
      });
    };
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, []);

  // Bare domains are fine — we assume https:// (mirrors normalizeTargetUrl on the server).
  const normalizedUrl = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  const valid = /^https?:\/\/.+\..+/.test(normalizedUrl);

  // Domain-keyed cache (CHE-39): once the URL looks real, ask if we've already
  // checked this domain and offer the existing verdict instead of a cold start.
  useEffect(() => {
    if (!valid) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/checks/lookup?url=${encodeURIComponent(normalizedUrl)}`);
        const body = (await res.json()) as { found: boolean } & LookupHit;
        setLookupState(body.found ? { forUrl: normalizedUrl, hit: body } : null);
      } catch {
        setLookupState(null);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [normalizedUrl, valid]);

  const lookup = valid && lookupState?.forUrl === normalizedUrl ? lookupState.hit : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalizedUrl, testEmail, testPassword, userNotes, notifyEmail, turnstileToken }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Something went wrong");
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/run/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="stagger w-full max-w-xl space-y-6">
      <div className="space-y-3 text-center">
        <p className="section-label">free first run · no signup</p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-[2.75rem] sm:leading-[1.1]">
          Paste a link.
          <br />
          We&apos;ll show you <span className="text-accent">your app</span>.
        </h1>
      </div>

      <div className="card p-1.5">
        <div className="flex items-center gap-2">
          <span className="pl-3 font-mono text-sm text-fg-faint">→</span>
          {/* type="text": the browser's own type="url" validation rejects bare domains */}
          <input
            type="text"
            inputMode="url"
            placeholder="https://"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={url.length > 0 && !valid}
            className="w-full bg-transparent py-3 font-mono text-[15px] text-fg outline-none placeholder:text-fg-faint"
            autoFocus
          />
        </div>
      </div>
      {url.length > 0 && !valid && (
        <p className="-mt-3 text-sm text-status-broken">Doesn&apos;t look like a working URL</p>
      )}

      {lookup && (
        <div className="card animate-fade-up space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-fg">
              We&apos;ve already checked <span className="font-mono">{lookup.appSlug}</span>
              {lookup.count > 1 ? ` (${lookup.count} runs)` : ""}
            </p>
            {lookup.run.verdict && VERDICT_META[lookup.run.verdict] && (
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-xs ${VERDICT_META[lookup.run.verdict].pillClassName} ${lookup.stale ? "opacity-50" : ""}`}
              >
                {VERDICT_META[lookup.run.verdict].label}
              </span>
            )}
            {lookup.run.completedAt && (
              <span className="font-mono text-xs text-fg-faint">
                {new Date(lookup.run.completedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
            {lookup.watched && (
              <span className="font-mono text-xs text-status-ok">● watched daily</span>
            )}
          </div>
          {lookup.stale ? (
            <p className="text-sm text-status-risky">
              Checked {lookup.ageDays} days ago — this may be out of date. Run a fresh check
              below, or enable Daily Watch so it never goes stale.
            </p>
          ) : (
            lookup.run.bottomLine && (
              <p className="text-sm text-fg-muted">{lookup.run.bottomLine}</p>
            )
          )}
          <a
            href={`/verdict/${lookup.run.publicId}`}
            className="inline-block font-mono text-[13px] text-accent transition-colors hover:underline"
          >
            See the last results →
          </a>
          {!lookup.stale && (
            <p className="font-mono text-xs text-fg-faint">
              …or submit below for a fresh check.
            </p>
          )}
        </div>
      )}

      <div className="text-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="font-mono text-[13px] text-fg-muted transition-colors hover:text-fg"
        >
          <span className={`chevron mr-1 inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>
            ›
          </span>
          Add login &amp; notes (optional)
        </button>
      </div>

      {expanded && (
        <div className="card animate-fade-up space-y-4 p-5">
          <div className="space-y-2">
            <p className="text-sm font-medium text-fg">
              Test login{" "}
              <span className="font-normal text-fg-faint">(optional but recommended)</span>
            </p>
            <Input
              type="email"
              placeholder="test@example.com"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              autoComplete="off"
            />
            <Input
              type="password"
              placeholder="••••••••"
              value={testPassword}
              onChange={(e) => setTestPassword(e.target.value)}
              autoComplete="new-password"
            />
            <p className="text-xs text-fg-faint">
              Encrypted at rest, deleted after the run, never appears in evidence.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-fg">Anything we should know?</p>
            <Input
              placeholder="Don't delete the account, no admin access. OK to create test sessions."
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-fg">Where to email the result?</p>
            <Input
              type="email"
              placeholder="you@email.com"
              value={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.value)}
            />
          </div>
        </div>
      )}

      {error && <p className="text-center text-sm text-status-broken">{error}</p>}

      {TURNSTILE_SITE_KEY && <div ref={turnstileRef} className="flex justify-center" />}

      <Button type="submit" disabled={!valid || submitting} className="w-full py-3.5 text-[15px]">
        {submitting ? (
          <>
            <span className="inline-block h-2 w-2 animate-pulse-dot rounded-full bg-ink-950" />
            Spinning up agents…
          </>
        ) : (
          "Show me my app"
        )}
      </Button>

      <p className="text-center font-mono text-[13px] leading-6 text-fg-faint">
        No signup. Free first run. Takes ~2 hours.
        <br />
        We&apos;ll email you when ready.
      </p>
    </form>
  );
}
