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

  const valid = /^https?:\/\/.+/.test(url.trim());

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
    <form onSubmit={onSubmit} className="w-full max-w-xl space-y-5">
      <h1 className="text-center text-2xl font-semibold tracking-tight">
        Paste a link. We&apos;ll show you your app.
      </h1>

      <Input
        type="url"
        inputMode="url"
        placeholder="https://"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-invalid={url.length > 0 && !valid}
      />
      {url.length > 0 && !valid && (
        <p className="text-sm text-status-broken">Doesn&apos;t look like a working URL</p>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-sm text-neutral-600 hover:text-neutral-900"
      >
        {expanded ? "⌄" : "⌃"} Add login &amp; notes (optional)
      </button>

      {expanded && (
        <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4">
          <p className="text-sm font-medium text-neutral-700">
            Test login (optional but recommended)
          </p>
          <Input
            type="email"
            placeholder="test@example.com"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
          />
          <Input
            type="password"
            placeholder="••••••••"
            value={testPassword}
            onChange={(e) => setTestPassword(e.target.value)}
          />
          <Input
            placeholder="Anything we should know? e.g. don't delete the account"
            value={userNotes}
            onChange={(e) => setUserNotes(e.target.value)}
          />
          <Input
            type="email"
            placeholder="Where to email the result? you@email.com"
            value={notifyEmail}
            onChange={(e) => setNotifyEmail(e.target.value)}
          />
        </div>
      )}

      {error && <p className="text-sm text-status-broken">{error}</p>}

      <Button type="submit" disabled={!valid || submitting} className="w-full">
        {submitting ? "Spinning up agents…" : "Show me my app"}
      </Button>

      <p className="text-center text-sm text-neutral-500">
        No signup. Free first run. Takes ~2 hours. We&apos;ll email you when ready.
      </p>
    </form>
  );
}
