"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Verdict → Run artifacts: "Export to GitHub". Nobody downloads .spec.ts files;
// with repo access we open a PR that drops them into e2e/checkmyapp/ instead.
// Client-side so the verdict page stays a server render; auth is resolved by
// the API (401 → sign-in redirect, mirroring EnableWatchButton).

type Phase = "idle" | "exporting" | "connecting";

export function ExportSpecs({
  runId,
  connectedRepo,
}: {
  runId: string;
  // Set when the signed-in viewer owns this app and has a repo connected.
  connectedRepo: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [showConnect, setShowConnect] = useState(false);
  const [repo, setRepo] = useState(connectedRepo);
  const [repoInput, setRepoInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const signInAndReturn = () => {
    const back = encodeURIComponent(window.location.pathname);
    router.push(`/sign-in?redirect_url=${back}`);
  };

  const doExport = async () => {
    setPhase("exporting");
    setErr(null);
    const res = await fetch(`/api/runs/${runId}/export-specs`, { method: "POST" }).catch(
      () => null,
    );
    if (res?.ok) {
      const { prUrl: url } = (await res.json()) as { prUrl: string };
      setPrUrl(url);
      setPhase("idle");
      return;
    }
    if (res?.status === 401) return signInAndReturn();
    const body = (await res?.json().catch(() => ({}))) as { error?: string; code?: string };
    if (body.code === "github_not_connected") {
      setShowConnect(true);
    } else {
      setErr(body.error ?? "Export failed.");
    }
    setPhase("idle");
  };

  const doConnect = async () => {
    setPhase("connecting");
    setErr(null);
    const res = await fetch("/api/integrations/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, repo: repoInput, token: tokenInput }),
    }).catch(() => null);
    if (res?.ok) {
      const { repoFullName } = (await res.json()) as { repoFullName: string };
      setRepo(repoFullName);
      setTokenInput("");
      setShowConnect(false);
      // Connecting from a verdict has one purpose — go straight to the PR.
      await doExport();
      return;
    }
    if (res?.status === 401) return signInAndReturn();
    const body = (await res?.json().catch(() => ({}))) as { error?: string };
    setErr(body.error ?? "Couldn't connect GitHub.");
    setPhase("idle");
  };

  return (
    <div className="mt-4 rounded-lg border border-ink-600 bg-ink-900/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-fg">Export to GitHub</p>
          <p className="mt-0.5 text-xs text-fg-muted">
            {repo ? (
              <>
                Opens a PR against{" "}
                <span className="font-mono text-fg">{repo}</span> with the specs under{" "}
                <span className="font-mono">e2e/checkmyapp/</span>. Never pushes to your
                default branch.
              </>
            ) : (
              <>
                We open a PR that adds these specs to your repo under{" "}
                <span className="font-mono">e2e/checkmyapp/</span> — review, merge, run in CI.
              </>
            )}
          </p>
        </div>
        {prUrl ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[13px] text-status-ok underline-offset-2 hover:underline"
          >
            ✓ PR opened — view →
          </a>
        ) : !showConnect ? (
          <Button
            variant="outline"
            disabled={phase !== "idle"}
            onClick={() => (repo ? doExport() : setShowConnect(true))}
          >
            {phase === "exporting" ? "Opening PR…" : repo ? "Export → PR" : "Connect GitHub"}
          </Button>
        ) : null}
      </div>

      {showConnect && !prUrl && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void doConnect();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              placeholder="owner/repo"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <Input
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="fine-grained personal access token"
              type="password"
              autoComplete="off"
              required
            />
          </div>
          <p className="text-xs text-fg-faint">
            Create a{" "}
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              fine-grained PAT
            </a>{" "}
            scoped to one repo with <span className="font-mono">Contents</span> and{" "}
            <span className="font-mono">Pull requests</span> read &amp; write. Stored
            encrypted; used only to open spec PRs.
          </p>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={phase !== "idle"}>
              {phase === "connecting"
                ? "Connecting…"
                : phase === "exporting"
                  ? "Opening PR…"
                  : "Connect & open PR"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setShowConnect(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {err && <p className="mt-2 text-xs text-status-broken">{err}</p>}
    </div>
  );
}
