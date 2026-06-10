"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Screen 1 — Submit. One field, one button; credentials/notes hidden behind a
// single toggle so casual visitors aren't scared off.
export function SubmitForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testPassword, setTestPassword] = useState("");
  const [userNotes, setUserNotes] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = /^https?:\/\/.+\..+/.test(url.trim());

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, testEmail, testPassword, userNotes, notifyEmail }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Something went wrong");
      }
      const { id } = await res.json();
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
          <input
            type="url"
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
