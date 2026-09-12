# Extension verification

Source: [Extension verification PRD](https://app.notion.com/p/3d97bac6430a81a1b09fdacc72d609c6).

## Current state — 2026-09-12 21:44 UTC

Feature branch `feat/chrome-extension-targets` is pushed through `026e3ca`.
Draft [PR #81](https://github.com/sorokinvj/check-my-app/pull/81) is open.
CheckMyApp production has not been migrated or deployed; no merge. The user’s
repository instruction prohibits merging and pushing to main.

- The native Cloudflare generated-spec replay described below passed. Actual
  workerd discovery through the Cloudflare executor also completed: 154.643
  seconds, 33 calls, session `95cdda9d-2496-4407-a9ef-79b35c65abf0`, five
  journeys including interview, practice and simultaneous scenarios. No paid
  session started; disposal and not-started cleanup were confirmed. Evidence:
  `/tmp/checkmyapp-cloudflare-discovery-result.json` and
  `/tmp/checkmyapp-cloudflare-discovery-cleanup.json`.
- Practice probe 6 reached its own Stop and SESSION COMPLETE, then disposed
  the browser. Session `de593cd7-b9db-47e9-a5ff-78d39d6c0b6e` lasted only a
  fraction of a second before its microphone operation failed. Its billing
  observation was inconclusive; it is not a passing practice test. The Linux
  microphone was an unnamed button with a muted microphone glyph, not the
  checkbox expected from the earlier UI. Call controls appeared before dialogue.
- The adapter now waits for the coach’s transcript control, then supports both
  the checkbox and the observed muted microphone button. Stop controls are
  restricted to the owned document, excluding extension shadow controls.
  Probe 7 was explicitly refused because another practice was still active.
  It retained that refusal, recorded zero owned sessions and disposed cleanly;
  it did not attempt to Stop another tab. Stable balance or Start call alone
  do not establish that the account’s active-practice lock has cleared.
- Durable cleanup now snapshots the matching owned session before disposal so
  an interrupted cleanup response retains the available lifecycle evidence.
  The public artifact keeps scenario and sanitized practice result only.
- Required generate, web and agent typechecks, lint and all 52 acceptance
  scripts passed again after these changes. Lint has three existing warnings.
- PR CI passed on `026e3ca`. The Claude review action failed before inference
  (one turn, no model usage or cost, no review comments); its log exposes no
  more specific cause. This is not a clean review. A current-head review and
  final CI remain required. No workflow files have been edited.

Current isolated Cloudflare version: `651cde1f-0b07-45cd-9efb-1e6665db221a`.
A fresh integrated workerd walk through that Cloudflare executor is running.
Remaining: successful practice-only and simultaneous runs, current integrated
walk and exported replay, full submission and Workflow, review/CI, authorized
production release and outside verification.

### Previous checkpoint — 21:17 UTC

Branch `feat/chrome-extension-targets` has commits `98c0c9a`, `22e23ac` and
`674bb45`. Further practice, cleanup and artifact changes are in progress.
CheckMyApp production has not been migrated or deployed; no push, PR or merge.

- The native executor is now deployed in an isolated Cloudflare Worker,
  `checkmyapp-extension-native-probe`, with its own R2 bucket and no application
  D1, scheduler, notification service or LLM credentials. It requires a secret
  bearer token. Docker builds use the existing meeting-lab host over SSH.
- The exact generated Playwright artifact passed against Cloudflare Containers
  in 4.4 minutes. Session `b527bda2-1118-4fad-9d32-46a80debc3ed`, version
  3.26.1 and original CRX digest unchanged. At 20:37–20:41 UTC it received a new
  relevant answer, confirmed End in 226 ms, observed a 149-second history row,
  balance 1599 → 1596, both live minute steps and unchanged balance 71.374 seconds
  later. Browser disposal, UI Stop, accounting and product result all passed.
  Evidence: `/tmp/checkmyapp-cloudflare-replay-cleanup.json` and
  `/tmp/checkmyapp-extension-cloudflare-replay-2.log`.
- The first Cloudflare allocation failed while provisioning. A later rollout
  hit the probe's one-instance limit. The probe now uses the production limit
  of three; instance acquisition is bounded at 60 seconds. These were executor
  failures, with no product verdict or paid session started.
- The 390px owner UI was checked again after entry animations settled. Adding
  a Store link, saving, seeing the on-demand card and opening settings passed.
  Removing an extension now uses extension-specific copy. Current disposable
  local App: `cmtyuj4jq000pwc13ie4dd0kt`; no Watch and no Run check submitted.
- Public cleanup artifacts now retain only this attempt's result, session
  durations and minute assessment. Prior account history and private history
  links stay out of the artifact. The original recovery record remains durable.
- Practice probes exposed differences from the PRD's earlier UI: the unnamed
  Stop button has a transparent hit area with a lucide-x icon; its dimensions
  vary with layout. Stop first shows SESSION COMPLETE and a rating surface.
  The practice microphone is an accessibility checkbox, not necessarily an
  input element. The adapter changes are still being verified live.
- Two early practice probes did not establish UI Stop. A fresh account audit
  found one 61-second and one 62-second practice row, each charged two minutes,
  and balances 1594 and 1592 respectively stayed unchanged for 84.847 and
  83.313 seconds. Those probes remain failures, not successful practice tests.
  The next probe reached SESSION COMPLETE after one second, but the microphone
  operation failed and durable cleanup returned no confirmed final record.
  Its subsequent account audit saw balance 1592, no new row and Start call.
- The owner class now coalesces concurrent cleanup requests, marks a lease
  closed only after durable evidence and disposal, preserves existing proof
  across restarts and removes its completed expiry schedule. A self-contained
  test exercises the actual class with a transport double. Live verification
  of this update is still pending.
- Discovery now reads practice's available controls through the account UI and
  proposes separate interview, practice and simultaneous journeys. Scenario
  metadata reaches each fresh executor; practice-only cannot start extension
  capture, and the simultaneous case must start capture first. The native
  exported spec includes these actions. Publication requires evidence for all
  three JobLander scenarios. Practice output requires candidate text followed
  by a relevant new coach response, not a greeting or timer alone.

All five required validation groups now pass in order, including 52 acceptance
scripts. Lint has only its three existing warnings. The current account audit
kept balance 1592 unchanged for 79.045 seconds, with no new history row. The next
practice attempt was explicitly refused by the product UI because a practice
was already running in another tab. This is contaminated by our prior failed
cleanup, not a customer finding. Its complete internal final record was retained
and the browser was disposed; product cleanup/accounting remain unverified.
Current Cloudflare probe version: `4ce981df-ecd3-45da-9d55-2675bc58de01`.
A new read-only workerd discovery through the actual Cloudflare executor is
running; no paid practice is active in that discovery. Remaining: successful practice-only
and simultaneous runs, integrated discovery/walk replay with current changes,
full submission and Workflow, review/CI, production release and outside check.

### Previous checkpoint — 20:25 UTC

New work since `22e23ac` adds bounded session observation for the agent,
product-grounded extension discovery, native replay spec generation, readable
extension names and the home/dashboard UI path. These changes are not deployed.

- Discovery #3 completed in 163 seconds / 38 calls, session
  `71bb0be3-ea51-4cf8-9902-137bf3dad98d`, with no paid sessions and confirmed
  disposal. Fixture content and guessed domains were absent, but extraction
  still invented internal services and treated Insights as a harmless toggle.
  The deterministic extension map now derives anatomy from observed controls
  and includes the interview answer → Stop → minutes journey whenever the
  observed JobLander start control exists. This is a proposed journey, not a
  claim that discovery itself ran it.
- Real workerd agent walk #1 reached a fresh answer and local Stop. Session
  `fae92bae-8d2e-47ce-845b-79ddbf6b1e4b`, UI meeting
  `fe1bf92a-7699-4028-9542-6ea908d5c267` at 19:55, 149 seconds, three minutes
  used, two live minute steps, balance unchanged 69.808 seconds later. The
  agent then failed on a disconnected inspection connection. No verdict was
  published. `/tmp/checkmyapp-walk-cleanup-1.json` preserves the executor result.
- Walk #2 completed with actual local D1 Steps and a GeneratedTest through
  `walkOneJourney`, using the installed Cloudflare Playwright fork and production
  JobLander. Run `worker-bridge-1789243551337`, session
  `6e0842a3-6319-4ff4-8049-346805715508`, 43 tool calls. A new relevant answer
  appeared. UI meeting `d052ffd4-aac5-40c6-ba24-dbde28daf772` at 20:07 lasted
  149 seconds; balance 1605 → 1602, expected debit 3, two minute steps,
  unchanged 71.044 seconds later. End/Confirm took 303 ms. Both cleanup gates
  passed and the browser was disposed. This replaces the DO transport with
  loopback and uses local D1; it is not a deployed CheckMyApp Workflow.
- That walk still spent extra turns looking for accounting: Stop returned only
  its ledger, and stale inspection transports blocked later popup invocation.
  Stop now returns the settled account observation, duplicate popup-close calls
  do not create extra connections, and the executor closes its own inspection
  transports before opening another native popup. These corrections still need
  a new integrated replay. Tool trace: `/tmp/checkmyapp-walk-tools-2.json`.
- The final account observation is now persisted as its own product-facing
  Step, even when the agent wraps up before accounting settles. Native tool
  responses and the shared language gate remove internal lifecycle fields,
  preflight and lease terminology from customer text.
- The native test is generated from successful observed actions after cleanup,
  pins the installed version/digest, requires explicit replay session permission,
  and asserts application Stop plus minute accounting in `finally`. It uses a
  fresh isolated native executor endpoint; popup.html never becomes a page tab.
  The actual generated artifact passed in 4.4 minutes with no model. Fresh
  session `9495c4cd-8411-4e60-9d56-3916dafe7b1e`, 3.26.1 and unchanged original
  CRX digest: new relevant output, End/Confirm in 360 ms, UI history
  `dae3cec4-74d0-4ac8-8886-90b9204acd95` at 20:20 with duration 149 seconds,
  balance 1602 → 1599, two live minute steps, unchanged 72.407 seconds later.
  Both cleanup gates and product result passed. Evidence:
  `/tmp/checkmyapp-export-replay-cleanup.json` and
  `/tmp/checkmyapp-extension-export-replay.log`.
- Actual owner UI with the existing Clerk QA account: dashboard → Add extension
  → Store link → save → on-demand card → settings passed locally. The App has
  targetKind=extension and no Watch. Current disposable local App:
  `cmtytirxc000ewc13gle3d2gz`. Desktop and 390px settings screenshots are in
  `/tmp/checkmyapp-extension-{dashboard-desktop,settings-mobile}.png`.
  The first assertion missed the existing labels suffix; it was a test selector
  error, not a failed save. Its own earlier App was removed via the normal UI.
- Home form matches the current production typography, cards and accent. A
  Store link selects extension options; session permission reveals test-login
  fields. Mobile settings had no horizontal overflow. Full-page screenshots
  should disable entry animations before the final visual check.

All five required validation groups pass in order, including all 49 acceptance
scripts; lint has only its three existing warnings. Remaining: practice-only and
practice+extension scenarios, final native replay/recovery acceptance, public
submission through the complete Workflow, current-head review/CI and production
release/verification. No push, PR, merge, production migration or deploy yet.
The additive extension migration is now 0030; only the two disposable local
D1 migration registries were renamed to match, after discovering main already
contained other migrations numbered 0028 and 0029.

### Previous checkpoint — 19:35 UTC

Commit `98c0c9a` contains the native runner and Workflow routing; `22e23ac`
adds the following validated changes, which are not deployed:
local session observation, native screenshot/filename redaction, fatal runtime
propagation, product-only discovery extraction, per-phase Run evidence links,
independent audio stimuli, UI-based minute accounting, and a JobLander core-flow
publication gate. The extension-aware exported spec and practice scenarios are
still outstanding. No push, PR, merge, production migration or deploy has run.

Fresh live evidence:

- Real LLM discovery through workerd and the installed Cloudflare Playwright
  fork completed in 177 seconds with 37 tool calls. Native email/password input
  reached the signed-in popup. Session `95d89b7b-a13e-4c19-bf14-2d8167f8b8e9`,
  Store/installed 3.26.1, original digest unchanged. Cleanup: not-started,
  sessions=[], browser disposed. This still replaces only the DO transport.
- That discovery incorrectly included the synthetic page/audio and guessed
  domains in its anatomy. It was not published as a product result. Extraction
  now receives only recorded product reads; fixture body/screenshots/actions and
  unobserved links cannot enter that path. A new discovery must verify this
  correction. Local transcript: `/tmp/checkmyapp-discovery-transcript-2.json`.
- Earlier discovery lost Chrome and kept calling failed tools. The runner now
  records signalled exits, rejects commands to a dead browser with 410, and the
  loop propagates executor/transport failure without a verdict. CDP clients may
  not dispose the owned browser or target before cleanup. The cause of that
  earlier exit is not established; the successful replay recorded no
  intercepted Browser.close commands. It is not evidence for that hypothesis.
- Capture `01a0965f-capture-observation-1`, session
  `b0977e8d-fe27-49b3-93c0-9968e21fa99a`: 148.112 seconds from visible Start to
  End, Confirm after 427 ms, 148 locally collected panel samples. A fresh answer
  addressed the interviewer audio's technical-challenge question. Chrome still
  requested microphone permission, so this does not prove that microphone
  branch. The account UI subsequently showed our 18:50 meeting with duration
  2m 29s. No before-start balance was taken; billing remained unverified.
- Capture `01a0965f-microphone-billing-1`, session
  `a043ea47-d892-4ca7-8e12-aee5999ba105`: microphone-only, tab audio paused,
  microphone RMS 0.3380207406. The distinct Maple/database-query question was
  transcribed under You, Mirror mode appeared, and the answer listed query
  profiling, indexing, caching, batching and performance monitoring. The
  positive question and answer were observed in the actual extension panel.
- That session ran 148.613 seconds before End; Confirm followed after 486 ms.
  The independently refreshed dashboard showed 1614 → 1613 → 1612, then 1611
  after Stop. Its new history row, meeting
  `91ca8bfe-4d83-47d4-bd8c-f909e4f1bf18`, displays 19:18 UTC and 149 seconds.
  The expected ceil(149/60)=3 equals the visible debit. A fresh read 73.087
  seconds later remained 1611. Both live minute steps, UI Stop and billing
  cessation passed. No customer database, logs or source were used.
  Local evidence: `/tmp/checkmyapp-microphone-billing-1.json` and
  `/tmp/checkmyapp-microphone-billing-1.png`; remote copy in the task-owned
  `~/checkmyapp-extension-preflight/` directory.
- The DOM read in that capture identified the real `data-testid="question"`
  and its answer card. Subsequent code records these separately from the timer
  and requires a fresh, relevant answer in the active interval.
- Capture `01a0965f-tab-billing-1`, session
  `f7fdef8e-1718-410d-9dab-8ceee2d13500`: deliberately tab-only, microphone
  RMS exactly 0, interviewer WAV playing. There were 146 local observations;
  112 contained the actual question/answer card. The new machine result gate
  confirmed the technical-challenge question and relevant prepared answer.
  Native End/Confirm took 338 ms; history meeting
  `ef6bf48d-45d9-4441-b4a8-8b4d0d0f2517` displays 19:31 UTC and 149 seconds.
  Balance 1611 → 1608, both live minute steps observed, ceil(149/60)=3,
  unchanged on a fresh read 71.456 seconds after Stop. Product result, UI Stop
  and minute accounting all passed; browser disposed. Local evidence:
  `/tmp/checkmyapp-tab-billing-1.json`.
- A read-only account probe saw Start call on the practice page and no owned
  practice was started. The container's independent deadline disposed that
  browser with sessions=[] and cleanup=not-started.

The current accounting observer reads only the customer-visible dashboard and
history. It requires a baseline before Start, independent rounding per new
owned history row, and another fresh balance at least 65 seconds after Stop.
Ambiguous rows, missing UI or changed balance stay inconclusive. Container
cleanup now reserves 120 seconds for the bounded read-only accounting follow-up.
Neither a clock, a silent microphone, an old answer nor successful login alone
can establish the JobLander core result.

Validation at this checkpoint: all five required groups passed in order,
including all 46 acceptance scripts. Lint retains only its three existing
warnings. An earlier full run exposed a workerd-only import in the shared
browser utility; that import now lives at the Workflow boundary, and the final
complete registry includes both previously affected scripts (ephemeral and
survey), the new audio, billing and result checks.

### Earlier implementation checkpoint — 18:03 UTC

The feature branch now routes extension checks through the isolated native
executor in surface scan, discovery and journey walking. Website checks retain
Browser Run. Store links never enter the website survey/smoke/partial ladder;
each phase verifies the installed version and the original CRX digest against
the scan. This is an implementation checkpoint, **not a production release**.

Native popup operations now use an exact document URI and a single-use reference
to an observed accessible control. The input path rechecks its role, name,
position and document before a physical click/fill. It refuses stale references,
cross-document references, control characters that could submit a field,
repeated credential submissions and session/purchase controls outside the owned
session tool. Credentials are substituted in the Worker and passed through stdin
inside the runner; they are never placed in process arguments or tool transcripts.
Missing access and undriven actions deterministically produce skipped steps.

The Worker disconnects page inspection before native invocation and reconnects
to the exact CDP target after popup dismissal. Page digests now include open
shadow panels and accessible iframe documents. The Container owns a durable
deadline, writes cleanup evidence to DO storage and R2 before disposal, and
refuses a verdict when a started session lacks both application Stop and separate
billing-cessation evidence. Runtime/cleanup failures file gaps on our own board.

New live evidence in this checkpoint:

- Native HTTP replay, session `d0c53492-5172-4df8-9b25-3afdb753e9dd`, JobLander
  3.26.1: opened the native action, signed into the authorized test account with
  native field input, observed Show JobLander Insights, and proved that an ordinary
  native click cannot start capture. Zero owned paid sessions; cleanup not-started.
  Repro: `scripts/replay-extension-native.mjs` with explicit local credential inputs.
- Actual workerd + installed Cloudflare Playwright fork, via a temporary loopback
  bridge to the isolated Linux executor: connected to the persistent profile,
  read the native popup, returned to the exact target, and observed no DevTools
  target. The initial and final page titles were Synthetic interview. This
  replaces only the DO transport, not Chrome or the native controls; it does not
  prove a deployed Cloudflare Container. Repro: `spikes/extension-browser-run/bridge.ts`.
- Final bridge state: running=false, sessions=[], applicationCleanup=not-started.
  The owned container was removed. The local bridge, SSH tunnel and Wrangler
  dev server were stopped. Existing meeting-lab sessions were untouched.
- The Worker bundles successfully with the new bindings using a dry run with
  `--containers-rollout=none`; the container image builds successfully on the
  Linux executor host. The ordinary local dry run cannot launch this Mac's
  Docker CLI. No Worker, migration or container was deployed.
- All five required check groups passed in order: Prisma generation, web
  typecheck, agent typecheck, lint (three existing warnings), and 39 acceptance
  scripts. Five of those scripts cover extension identity, consent, surfaces,
  target ownership, local Stop and cleanup/step gates.

Still required before shipping:

1. Replay product-only LLM discovery and walk the core journeys through the
   integrated path. The first completed discovery still mixed fixture facts
   into its map; no Workflow-to-production result has been published.
2. Exercise the structured result and accounting gates through the full agent
   path. Independent microphone and tab-audio production captures now both
   have two-minute UI accounting; the tab run also exercised the new result gate.
3. Implement and run the three PRD scenarios for at least two full minutes each,
   with user-visible balance/history, rounding, cessation and no active practice
   left behind. Billing cleanup intentionally remains unverified until measured.
4. Exercise the new per-phase evidence, core-flow publication gate and redacted
   native screenshots in the integrated path. Add an extension-aware executable
   test export; the current generated-spec path is still website-oriented.
5. Exercise lease expiry/retry/cancel recovery, native picker/permissions and
   unsupported surfaces. Verify UI appearance and both public/owner flows, run
   review/CI, then resolve the repository's no-merge boundary before release.

The historical notes below preserve the measurements and corrections that led
to this checkpoint; their older “not integrated yet” statements are superseded.

## Delivery and acceptance

- [x] Read product rules, current execution path, PRD and meeting-lab runbook.
- [x] Inspect the production form and preserve its existing visual language.
- [x] Create an isolated worktree from origin/main (5725423).
- [ ] Prove Store installation, installed identity, native popup, active tab,
  Shadow DOM and synthetic audio in a disposable Linux profile.
- [ ] Add Store links to the public submission and owner onboarding, with
  separate extension identity, companion URL and bounded session permission.
- [ ] Run discovery and journeys through the existing agent and verdict path.
- [ ] Persist version, actions, stimulus, result and verified cleanup evidence.
- [ ] Verify three JobLander scenarios, negative cases and cancellation.
- [x] Pass Prisma generation, both typechecks, lint and the acceptance registry (39 scripts).
- [ ] Commit to the feature branch and obtain current-head review and green CI.
- [ ] Deploy and run the complete production flow against the Store build.

## Constraints

Extension runs are on demand by default. A Store page is metadata, never proof
that the installed extension works. Store version and installed version remain
separate. No green result without observed effects and confirmed cleanup.
Credentials use the existing encrypted storage and substitution boundary.
Customer product judgments use external UI evidence, never the customer's logs
or repository. Extension failures, fixture failures and checker failures remain
distinct. The first release accepts official Chrome Web Store URLs; custom
artifact uploads need an additional build-source contract.

## Executor research, 2026-09-12 UTC

Cloudflare Browser Rendering (now named Browser Run) is managed headless Chrome,
not a static HTML renderer. The Worker runs the agent; a separate remote browser
runs the product. Playwright's Cloudflare fork sends CDP over a binding-backed
WebSocket. The installed package is 1.3.0, based on Playwright 1.58.2.

Browser Run supports tabs, isolated contexts, cookies/storage state, CDP, active
session reuse and reconnect. The inactivity timeout is 60 seconds by default,
configurable to 10 minutes; active sessions have no fixed maximum lifetime.
Session persistence is not a provisioned OS profile with installable software.
The actual WorkersLaunchOptions expose keep_alive, recording and lab, with no
extension artifact, browser executable, launch arguments or WAV device input.
launchPersistentContext and launchServer are explicitly unsupported by the
installed Cloudflare package. Official documentation supplies no native toolbar
or extension-installation interface. This is a limitation of the supported
service contract, not a claim that headless Chromium itself cannot run extensions.

A direct API capability probe could not acquire a session: the configured
account token is active (200 from /accounts/:id/tokens/verify), but the Browser
Rendering API returns 401 / code 10000. No live CDP capability claim follows
from that failure. The existing production Worker binding is a separate path.

### What meeting-lab actually supplies

The deployed service is FastAPI on 127.0.0.1:8765, reached through SSH. POST
/meetings launches a Node/Puppeteer process under Xvfb. Its launcher selects
/snap/bin/chromium and an on-disk profile, installs an unpacked extension with
Chrome launch flags, and supplies WAV/Y4M through native fake-device flags.
Hosts use a platform profile; every guest uses the same guest profile. The API
has no profile-selection or profile-lease mechanism. State and screenshots live
in one session directory. DELETE signals only that session's process group.

The predecessor ~/jl-harness has a relevant production experiment in
prod-mirror-vm.js. It established native toolbar activation before tabCapture;
opening popup.html as a tab was used for login only. The native popup was a
separate CDP target rather than a Puppeteer Page. Stored verdict-A/B/C artifacts
record successful real capture and one socket: silent start, audible start,
and silent-to-audible transition (530 ms, one transition event). These are
historical, narrow results on Store 3.25.0, not current JobLander acceptance.
Their wire/devlog assertions and direct tabCapture probe are diagnostic aids;
they cannot replace CheckMyApp's external user-result verdict.

check-fakeaudio.js separately measured RMS from getUserMedia before trusting
audio fixtures. Its historical README records Linux fake-WAV success and macOS
failure; fresh platform verification is required. A live timer, audible flag,
or nonzero RMS alone does not establish recognition or a relevant AI result.

The newer meeting API only loads the extension. It does not authenticate it,
open its popup, activate capture or prove Stop. Its cleanup closes the browser,
which does not prove that a paid application session stopped. The dwell timer
begins after joining, so it is not an absolute whole-session deadline.

For session 20260912-115012-98273a, the saved state reports a prejoin failure,
while meet-joined.png visibly shows the in-call toolbar including Leave call.
The deployed detector catches evaluation failures as false and uses only a
nonzero bounding box for visibility. The artifact confirms disagreement; the
exact failing predicate is not established. Keep this as fixture failure,
never a JobLander regression.

### Implementation consequences

Keep website checks on Browser Run. Provide the extension executor with the
Linux/headful/native-action capabilities proven by the harness. Reuse
meeting-lab's API for meeting fixtures. Add isolated per-run profile ownership,
an absolute lifetime, explicit popup/target-tab identities, bounded local
sequences and independently verified application cleanup. Keep store package
identity separate from installation identity. A container on the existing
Cloudflare platform is a candidate deployment mechanism; it is distinct from
Browser Run and still needs a real JobLander preflight.

Meeting fixtures use the existing meeting-lab API. Preflight on 2026-09-12 UTC
found two pre-existing Teams hosts, 20260727-110754-700e2c and
20260725-131341-a2e067. Neither belongs to this task. No meeting was created.

Repository rules prohibit merging and pushing main. Prepare the complete,
reviewable change before resolving that production delivery boundary.

## References

- https://playwright.dev/docs/chrome-extensions
- https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- https://developer.chrome.com/docs/extensions/reference/api/commands
- https://github.com/JobLander-app/meeting-lab/blob/main/skill/SKILL.md

## Fresh isolated preflight evidence

2026-09-12 16:38–16:43 UTC, disposable container `cma-extension-01a0965f`
on the existing VM; loopback-only control port, 2 GB/2 CPU limit, unique profile,
10-minute absolute browser deadline. No meeting fixture or paid session started.

- Official Store package and loaded runtime agree: ID
  `hafhjepjihcimcljkdphpinannbdmnhf`, version `3.26.1`.
- Original CRX SHA-256:
  `5e52e2eb824a6e3fa223ad3f2a6c288b4e73da66d913e7690badcc75d38a97b3`.
- Installed browser: Chrome for Testing `145.0.7632.6` (Playwright 1.58.2 image).
- Runtime identity must be polled after attaching to the service worker;
  its target can appear before `chrome.runtime` initializes.
- Native accessibility requires `ACCESSIBILITY_ENABLED=1` in addition to
  `--force-renderer-accessibility=complete` in this image. Chrome's toolbar
  action is named `open`, not `click`. Both discoveries concern the executor.
- Fresh AT-SPI lookup opened the Chrome extension menu and selected JobLander.
  The resulting popup was a `page` CDP target in this build (the historical
  harness had seen `other`). Playwright could read it and click its email-login
  control. A settled desktop screenshot confirms the actual floating popup
  anchored to the toolbar over the recorded companion tab, not a popup URL tab.
- Screenshots and target IDs are diagnostic preflight evidence only; this does
  not yet prove capture, stimulus recognition, billing or application Stop.

Additional primary references:
- https://developers.cloudflare.com/browser-run/playwright/
- https://developers.cloudflare.com/browser-run/limits/
- https://developers.cloudflare.com/browser-run/features/reuse-sessions/
- https://developers.cloudflare.com/containers/
- https://www.chromium.org/developers/accessibility/testing/automated-testing/ax-inspect/
- https://chromium.googlesource.com/chromium/src/+/9360d08502357e2ea00f4f052bb6a8ca9277e27a/chrome/test/fuzzing/atspi_in_process_fuzzer.cc

### Live Browser Run binding probe

A second probe used the real `BROWSER` Worker binding through Wrangler's remote
binding (2026-09-12 16:47 UTC). Unlike the direct REST-token probe, it acquired a
browser and closed it in `finally`. The production-compatible launch path
(no `lab` option) returned:

```json
{
  "product": "Chrome/128.0.6613.137",
  "protocolVersion": "1.3",
  "Extensions.getExtensions": "Protocol error: method wasn't found",
  "Extensions.loadUnpacked": "Protocol error: method wasn't found"
}
```

This is evidence for the browser actually supplied to this account/binding at
that time, not a prediction about every future Browser Run engine. The probe
is reproducible under `spikes/extension-browser-run/`, uses no customer URL,
accepts a single POST per reload and always disposes its own session. The
installed local workerd supports dates through 2026-06-18, so the probe uses
the agent's existing 2025-09-15 compatibility date. `keep_alive` is milliseconds
in this API: 60000, not 60 (the live API requires at least 10000).

The native JobLander popup also accepted the existing test account's credentials
on the first attempt and displayed its signed-in controls. No subscription,
resume, meeting, capture or paid session was created or changed by that check.

### Invocation correction after the capture preflight

The first capture attempt on the owned synthetic interview page did not produce
an End session control. Its lease remains `unverified`; there is no green result.
Fresh UI inspection showed an empty extension shadow root and the popup back at
Show JobLander Insights. It also revealed an extension DevTools window. This
invalidates treating the AT-SPI default action as proof of the normal Chrome
action invocation: popup availability and successful login were real, but
capture activation was not established. `native.py` now uses a physical left
click at the center of the freshly located named native control, matching the
historical harness's proven mechanism. No guessed screen coordinates.

A synthetic-microphone preflight on the same isolated Chrome measured RMS
0.4137489668 over four seconds. Its English candidate phrase and WAV SHA-256
are recorded separately from the interviewer/tab stimulus. Playback of the
interviewer WAV was observed running; recognized output has not been proven.

## Current implementation checkpoint

The isolated worktree now contains additive extension identity/config columns,
Store-link parsing, public-form target selection, on-demand dashboard onboarding,
settings and a saved-app run action. Paid starts and rechecks carry extension
configuration. These are draft changes: the Workflow is not yet routed to the
new executor, so this branch must not be deployed as a completed feature.

The runner prototype has a per-attempt browser lease, a synthetic microphone
preflight, a local JobLander Stop sequence and a session ledger that keeps failed
cleanup unverified. `ExtensionRunner` adds the Cloudflare Container/DO lifecycle,
but is not bound/exported by the production Worker yet. Integration, generic
surface tools, result/cleanup verdict gates and the three full production
scenarios remain open.

Validation so far: Prisma generation, both typechecks, lint (only three existing
warnings), all 35 existing acceptance scripts including the new lifecycle
script passed. The subsequently added extension-target acceptance script also
passes; a final full check is still required after integration.


The next physical-click attempt exposed the actual failure: a fresh desktop
screenshot showed the popup's DevTools console reporting `No active tab found`.
There were zero DevTools targets after login, and a DevTools window after the
runner's target lookup. `pageForTarget` had called `context.newCDPSession` on
every Page, including the popup. In this Chrome build that inspection moves the
last-focused window. It now first filters by the root CDP target's observed URL;
a popup requires a unique matching target and Page without another attachment.
Normal page IDs are checked only against matching normal-page candidates. The
old failed attempts remain unverified and produce no product finding.

A further replay showed that removing the explicit per-popup CDP lookup alone
was insufficient: opening a new Playwright connection while the native popup
was present still produced the focused popup inspector and the same no-active-tab
error. The capture command now uses the popup's freshly observed AT-SPI label
and physical native input, dismisses the popup, confirms that its exact target
has gone, then connects to the companion page. Authentication and reading a
popup are not proof that its capture action preserves native tab activation.
This correction still requires a successful live capture/Stop replay.

### Successful native capture and Stop preflight

Attempt `01a0965f-preflight-8`, Store/installed 3.26.1, Chrome for Testing
145.0.7632.6, synthetic interview page owned by the container:

- 17:19:03.938 UTC: owned capture lease registered, 60-second limit.
- 17:19:05.249 UTC: native Show JobLander Insights click produced the visible
  End session control on the exact target tab.
- 17:20:04.145 UTC: independent local deadline clicked End session.
- 17:20:04.374 UTC: Confirm end session clicked (229 ms from first click).
- 17:20:04.382 UTC: the session controls were gone; ledger state `stopped`.
- A subsequent read found the extension's shadow root empty and the controls
  remained absent. No popup inspector was used for activation.

This proves native capture UI activation and local application-UI Stop. It is
not the two-full-minute acceptance run, and it does not establish billing
cessation or recognition/answer quality. The attempted text sample arrived after
the deadline and therefore records no recognized output. Future sampling must
be local to the executor during the session, independent of agent latency.

Final checkpoint for the executor research, 2026-09-12 17:25 UTC:
all five required command groups passed in order, including all 37 acceptance
scripts (three new extension scripts). Lint has only the three pre-existing
anonymous-default-export warnings. The temporary Browser Run dev server is
stopped. The owned Docker container/profile was removed after its Stop evidence
and final state were saved outside the image context. Meeting-lab's existing
sessions were not modified. `wrangler containers list` succeeds and reports no
existing containers in this account; no production container was deployed.
The primary checkout is still main at 4d0c719; its only new untracked directory
is `.codex/`, which contains this task's isolated feature worktree.

Next implementation steps, in order:
1. Keep a structured native popup interface while it is active. Additional
   Playwright connections to that popup can move focus; ordinary page tools
   remain usable after the popup is closed. Bind each native operation to the
   observed extension, window and exact target tab, and preserve credential
   substitution/permission gates.
2. Sample stimulus/result evidence locally during capture. Agent round-trip
   latency must not cause the sample to arrive after the session deadline.
3. Wire the extension Container and native surfaces into Workflow discovery and
   journeys; never survey/replay the Store listing as a website. Keep website
   Browser Run behavior intact and prevent cross-version results.
4. Gate session actions with the local ledger, require positive Stop evidence,
   keep billing cessation separate from UI Stop, and prohibit a green result
   from missing/unverified session evidence. Persist evidence before disposal.
5. Verify the public and owner UI, then run the three full JobLander scenarios
   against production for two complete minutes with user-visible balance and
   history checks. Commit/review on the feature branch; repository rules still
   prohibit merging/main pushes, so resolve delivery only once reviewable.
