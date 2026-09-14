"use client";

import { useState } from "react";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import type { ExtensionOptions } from "@/lib/extension-target";

export function ExtensionFields({ value, onChange }: {
  value: ExtensionOptions;
  onChange: (value: ExtensionOptions) => void;
}) {
  return (
    <div className="card animate-fade-up space-y-4 p-5">
      <div>
        <p className="section-label">chrome extension</p>
        <p className="mt-1 text-sm text-fg-muted">From opening it to seeing its result.</p>
      </div>
      <label className="block space-y-1.5">
        <span className="text-sm text-fg">Where does it work?</span>
        <Input name="extensionCompanionUrl" type="url" placeholder="https://your-app.com"
          value={value.companionUrl ?? ""} onChange={e => onChange({ ...value, companionUrl: e.target.value })} />
        <span className="block text-xs text-fg-faint">The page where someone uses your extension. Optional for extensions that work on any page.</span>
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm text-fg">What should someone be able to do?</span>
        <Textarea name="extensionExpectedOutcome" rows={2} maxLength={1000}
          placeholder="Open the extension, start a session and receive a useful result."
          value={value.expectedOutcome ?? ""} onChange={e => onChange({ ...value, expectedOutcome: e.target.value })}
          className="ph-no-capture" />
      </label>
      <label className="flex items-start gap-2.5 text-sm text-fg">
        <input type="checkbox" name="extensionAllowSessions" value="yes"
          checked={value.allowSessions ?? false} onChange={e => onChange({ ...value, allowSessions: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-accent" />
        <span>Start and stop sessions as my test account
          <span className="mt-1 block text-xs text-fg-faint">Sessions may use the account&apos;s included minutes. Each one is stopped after the limit below. No purchases or upgrades.</span>
        </span>
      </label>
      {value.allowSessions && (
        <label className="flex items-center justify-between gap-4 text-sm text-fg-muted">
          <span>Maximum session length</span>
          <select name="extensionMaxSessionSeconds" value={value.maxSessionSeconds ?? 180}
            onChange={e => onChange({ ...value, maxSessionSeconds: Number(e.target.value) })}
            className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs text-fg">
            <option value={180}>3 minutes</option><option value={300}>5 minutes</option><option value={600}>10 minutes</option>
          </select>
        </label>
      )}
    </div>
  );
}

export function ExtensionSettings({ initialValue }: { initialValue: ExtensionOptions }) {
  const [value, setValue] = useState(initialValue);
  return <ExtensionFields value={value} onChange={setValue} />;
}
