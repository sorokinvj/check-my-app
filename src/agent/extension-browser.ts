import { connect, type Browser, type Page, type Locator } from "@cloudflare/playwright";
import type { AgentEnv } from "./env";
import type { ToolEnv } from "./tools";
import { prepareAgentPage, scrubSecrets, normalizeFillValue, UNDRIVEN_INSTRUCTION } from "./tools";
import { assertExtensionIdentity, extensionCleanupComplete, gateExtensionStep, type ExtensionIdentity, type ExtensionRunnerInput, type ExtensionSession } from "./extension-contract";
import type { ExtensionRunner } from "./extension-runner";

const sessions = new WeakMap<Browser, ExtensionBrowser>();
export const extensionBrowserFor = (browser: Browser) => sessions.get(browser);

interface NativeNode { ref: string; name: string; role: string; editable: boolean; protected: boolean }

// The popup and page are two mutually exclusive connections. Opening another
// inspector while Chrome's native popup is active changes lastFocusedWindow
// and breaks tabCapture even though login/read still appear to work.
export class ExtensionBrowser {
  browser!: Browser;
  page!: Page;
  popup = false;
  private nodes: NativeNode[] = [];
  private credentialFilled = false;
  private pendingReason?: "missing_access" | "our_capability";
  private finishPromise?: Promise<void>;
  private constructor(private runner: DurableObjectStub<ExtensionRunner>, readonly identity: ExtensionSession) {}

  static async open(env: AgentEnv, input: ExtensionRunnerInput, expected?: ExtensionIdentity): Promise<ExtensionBrowser> {
    if (!env.bindings.EXTENSION_RUNNER) throw new Error("internal: extension executor binding is unavailable");
    const runner = env.bindings.EXTENSION_RUNNER.getByName(input.ownerRunId);
    const identity = await runner.openSession(input);
    const session = new ExtensionBrowser(runner, identity);
    try {
      assertExtensionIdentity(identity, expected);
      await session.connectPage();
      return session;
    } catch (error) { await runner.expire(); throw error; }
  }

  async call<T>(path: string, input?: unknown): Promise<T> {
    const response = await this.runner.fetch(new Request(`http://runner${path}`, {
      method: input === undefined ? "GET" : "POST",
      ...(input === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
    }));
    if (!response.ok) throw new Error(`Extension operation unavailable: ${(await response.text()).slice(0, 300)}`);
    return response.json<T>();
  }

  private async connectPage(env?: ToolEnv): Promise<void> {
    const endpoint = { fetch: (input: RequestInfo | URL, init?: RequestInit) => this.runner.fetch(new Request(input, init)) };
    const options = { sessionId: this.identity.sessionId, persistent: true };
    this.browser = await connect(endpoint, options);
    sessions.set(this.browser, this);
    const context = this.browser.contexts()[0];
    if (!context) throw new Error("Extension profile context is unavailable");
    const root = await this.browser.newBrowserCDPSession();
    try {
      const { targetInfo } = await root.send("Target.getTargetInfo", { targetId: this.identity.targetTabId });
      const candidates = context.pages().filter(page => page.url() === targetInfo.url && !page.url().startsWith("chrome-extension:"));
      let selected: Page | undefined;
      for (const candidate of candidates) {
        const channel = await context.newCDPSession(candidate);
        try {
          if ((await channel.send("Target.getTargetInfo")).targetInfo.targetId === this.identity.targetTabId) selected = candidate;
        } finally { await channel.detach(); }
      }
      if (!selected) throw new Error("The owned extension target tab is unavailable");
      this.page = selected;
      if (env) { env.page = selected; await prepareAgentPage(env); }
    } finally { await root.detach(); }
  }

  async tool(env: ToolEnv, name: string, input: Record<string, unknown>): Promise<string | undefined> {
    if (name === "report_step" && this.pendingReason) {
      gateExtensionStep(input, this.pendingReason);
      this.pendingReason = undefined;
    }
    if (!name.startsWith("extension_")) {
      if (this.popup && ["navigate", "read_page", "click", "fill", "screenshot"].includes(name)) return "The native popup is active. Use extension_read / extension_click / extension_fill, or extension_close to return to its target tab.";
      return undefined;
    }
    try {
      let result: unknown;
      if (name === "extension_open") {
        if (!this.popup) {
          await this.browser.close();
          result = await this.call("/popup", { targetId: this.identity.targetTabId });
          this.popup = true;
        }
        result = await this.read(env);
      } else if (name === "extension_close") {
        await this.call("/popup/close", {});
        this.popup = false;
        this.nodes = [];
        await this.connectPage(env);
        result = { surface: "target-tab", url: this.page.url() };
      } else if (name === "extension_read") result = await this.read(env);
      else if (name === "extension_click" || name === "extension_fill") {
        const node = this.nodes.find(n => n.ref === input.ref);
        if (!node || !this.popup) throw new Error("Read the native popup to obtain a current control reference");
        if (name === "extension_click" && env.credentials?.rejected && /log.?in|sign.?in/i.test(node.name)) return this.missingAccess("The saved credentials were already rejected. This step requires missing_access.");
        let value = normalizeFillValue(String(input.value ?? ""));
        const recordedValue = scrubSecrets(env, value);
        const credential = name === "extension_fill" && /\{\{TEST_(EMAIL|PASSWORD)\}\}/.test(value);
        if (credential) {
          if (env.credentials?.rejected) return this.missingAccess("The saved credentials were already rejected. This step requires missing_access.");
          if ((value.includes("{{TEST_EMAIL}}") && !env.testEmail) || (value.includes("{{TEST_PASSWORD}}") && !env.testPassword)) return this.missingAccess("Test credentials are missing. Skip this step with missing_access; do not submit an empty sign-in form.");
          // The runner binds this field to the exact installed extension URL;
          // URL.origin === 'null' must never authorize credential substitution.
          value = value.replaceAll("{{TEST_EMAIL}}", env.testEmail ?? "").replaceAll("{{TEST_PASSWORD}}", env.testPassword ?? "");
          this.credentialFilled = true;
        }
        this.nodes = [];
        result = await this.call("/popup/action", { ref: input.ref, operation: name === "extension_fill" ? "fill" : "click", ...(name === "extension_fill" ? { value, credential } : {}) });
        const surface = { kind: "native_popup" as const, extensionId: this.identity.extensionId, targetId: this.identity.targetTabId };
        const urlAfter = `chrome-extension://${this.identity.extensionId}/${this.identity.popupPath}`;
        env.actionTrail?.push(name === "extension_fill"
          ? { kind: "fill", label: node.name || node.role, value: recordedValue, surface, outcome: { urlAfter } }
          : { kind: "click", role: node.role, name: node.name, surface, outcome: { urlAfter, navigated: null, requests: null, mutations: null } });
      } else if (name === "extension_audio_preflight") {
        if (this.popup) return "Close the native popup before checking the audio fixture.";
        result = await this.call("/fixture/preflight", {});
      } else if (name === "extension_start_session") {
        if (!this.identity.allowSessions) return this.missingAccess("Session-start permission and a test account are required for this step. It remains skipped with missing_access.");
        if (!this.popup) return "Open the native popup on the target tab before starting its session.";
        result = await this.call("/session/start", {});
        this.popup = false;
        await this.connectPage(env);
      } else if (name === "extension_stop_sessions") {
        await this.browser.close();
        await this.call("/popup/close", {});
        this.popup = false;
        result = await this.call("/session/stop", {});
        await this.connectPage(env);
      } else return "Unknown extension tool";
      return scrubSecrets(env, JSON.stringify(result));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.pendingReason = "our_capability";
      env.undrivenControls?.push({ hand: name === "extension_fill" ? "fill" : "click", target: "extension control", reason });
      return scrubSecrets(env, `${reason}. The extension control ${UNDRIVEN_INSTRUCTION}`);
    }
  }

  private missingAccess(message: string): string {
    this.pendingReason = "missing_access";
    return message;
  }

  private async read(env: ToolEnv) {
    const result = await this.call<{ nodes: NativeNode[] }>("/popup/read");
    this.nodes = result.nodes;
    if (this.credentialFilled && this.nodes.some(n => /invalid (?:login|credentials|password|email)|incorrect (?:email|password)|wrong password|too many (?:attempts|requests)|auth\/(?:invalid-credential|wrong-password|user-not-found)/i.test(n.name))) {
      if (env.credentials) env.credentials.rejected = true;
      await env.onCredentialRejected?.("native sign-in: explicit credential rejection");
    }
    return result;
  }

  async guardClick(target: Locator): Promise<string | null> {
    // Resolve the actual DOM control, including labels and nested icons, so a
    // CSS selector cannot bypass the session ledger by omitting its name.
    const label = await target.evaluate(el => {
      const control = el.closest("button,label,[role=button],[role=checkbox]") ?? el;
      return [control.textContent, control.getAttribute("aria-label"), control.getAttribute("title")].filter(Boolean).join(" ");
    });
    return /\b(start|begin|record|capture|insights|practice|end session|stop session)\b/i.test(label)
      ? "Session controls require extension_start_session / extension_stop_sessions and their owned Stop sequence." : null;
  }

  async finish(): Promise<void> {
    this.finishPromise ??= this.dispose();
    return this.finishPromise;
  }
  private async dispose(): Promise<void> {
    await this.browser?.close().catch(() => {});
    await this.runner.expire();
    const final = await this.runner.finalEvidence();
    if (!final.disposed || !final.session || !extensionCleanupComplete(final.session)) throw new Error("internal: extension session cleanup is unverified; no verdict may be published");
  }
}
