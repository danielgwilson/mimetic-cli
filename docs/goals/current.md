# Current Goals

Status date: 2026-09-06 (rev 20)

This page is the current public-safe operating goal for `humanish`. Keep it
short enough to reread before a coding session and concrete enough that future
agents can choose useful work without private context.

## North Star

Humanish should be the open-source CLI that lets a maintainer ask:

> What happens when realistic synthetic personas try to use this app, CLI, or
> agent-facing workflow?

The answer should be observable, verifiable, public-safe, and easy to turn into
actionable feedback.

What humanish runs is synthetic user research, and every surface is checked
against the three people a study involves — researcher, stakeholder,
participant ([docs/principles/three-roles.md](../principles/three-roles.md)).
The operational consequences: a study declares `tasks` with success criteria
the participant never sees and gets a per-task completion funnel back; budgets
are study-level recruiting decisions (`execution.caps.maxTotalUsd`) with
per-lane caps as backstops; sessions end because the participant finished, not
because a timer fired; abandonment and reported friction are findings that
become feedback candidates, not failures. Receipts: the email-gated signup
study completed, reproduced, and produced a real accessibility finding via a
keyboard-first participant
([docs/goals/email-gated-signup/receipts/](email-gated-signup/receipts/)).

## Current Program Truth (source `0.83.1`)

The package source and repository implementation in this tree agree on these
points:

**Mobile input correction, 2026-09-05 (#676).** The historical 4/4 TodoMVC phone-lane rename
failures describe the shipped desktop pointer-to-touch conversion path. In two new hosted
conformance probes, SDK double click emitted two single clicks; direct touch opened the same
original editor in both. A separate local native-X control reproduced the difference by toggling
conversion. Mobile viewport and touch flags do not certify gesture equivalence or establish a
physical-device app defect. Mobile lanes using touch conversion now carry that advisory in run
warnings. [Method, traces summary and limits](computer-use-actor/receipts/mobile-input-conformance-2026-09-05.md).

The immutable 2026-06-10 proof-roadmap packet is paired with a
[current implementation checkpoint](https://github.com/danielgwilson/humanish/blob/main/docs/goals/proof-roadmap/README.md).

| Surface | Shipped | Still unproven or unbuilt |
| --- | --- | --- |
| Actor execution | Six first-party registry descriptors; computer-use, scripted-browser, and terminal-product dispatch paths. `0.55.0` makes reasoning effort declarable per actor and per lane and records the resolved value on the trace (`humanish.model-settings.v1`) — it had been reachable in the provider and unreachable from a lab, so every prior run silently took the provider default | Public out-of-tree actor registration and conformance certification |
| Persona scale | Bounded per-lane-world fan-out, including differentiated lanes and roster expansion; kept deterministic and live receipts | A completed first-party deletion branch that replaces a bespoke generic harness |
| Shared state | Sequential and concurrent single-origin shared-world execution; sequential has deterministic proof, concurrent has deterministic and kept live proof | Multi-origin shared-world runtime/schema support; real-adopter deletion proof |
| Subject sources/routes | Seven declared sources: `this-repo`, `clone`, `app-url`, `local-app`, `terminal-product`, `desktop-cli`, and `local-tree`; support is route-specific and `this-repo` remains dry-run-only | One centralized run/resource lifecycle boundary across all routes |
| Public proof | A legible four-persona Observer hero from a verified real public-application study (commit-pinned drawDB) shipped in the npm payload (`0.16.0`) | Coverage beyond a single studied subject; the stratified breadth panel remains unbuilt |
| OSS meta-lab | Dry-run contract and separate disposable smoke harness | Live meta-lab execution; disabled until repository instructions and actor credentials have an isolated boundary |
| Observer serving | `watch`/`observe` loopback servers plus `serve` — the run-library surface with loopback default, capability-link exposure, `share_ready`-gated open mode, and optional operator-run tunnel; streams never served remotely | A remote live-stream (`--live-streams`) design; a persistent capability-link store |
| Stakeholder terminal surface | `humanish tui` (`0.50.0`, redesigned to the reviewed spec in `0.51.0`, reworked again in `0.56.0` from stakeholder feedback: two explicit start rows instead of a hidden mode toggle, a description line so a list of studies says what they are, `?` keys, and ←/→ back to meaning back and open): labs -> lab -> run, arrow-key navigation, and starting a dry or live run from the lab screen. The run is DETACHED and outlives the terminal — live-proven by killing the terminal 42s into a real run that then ran on for ~3.5 minutes and finished `pass` at $0.639751. The run screen leads with the participant and their recorded thinking, live-proven mid-flight against a real computer-use run. Ships as one bundled file loaded on demand; refuses a non-interactive stdin/stdout naming the JSON commands instead. `0.51.0` builds the reviewed rev-8 design: wordmark and project context, content capped at 96 columns, live rows naming the PARTICIPANT and their elapsed clock, spinners and verdict glyphs, breadcrumbs, the lab's subject/model/caps/keys line, and one Start with a dry-run/live toggle. `0.52.0` completes the reviewed screen set: the run outcome card (denominator first, the participant's closing words, then Open in Observer / Run again), the interrupted card with Reclaim — live-proven by killing a real run and stopping its orphaned sandbox — and All runs, the cross-lab peer where participants lead and one thought line follows the cursor. `0.53.0` gives it the reviewed palette rather than the terminal's theme: exact hex on a truecolor terminal, downsampled where not, and never colour alone. `0.54.0` closes the last two gaps: stopping a running run (armed, signals the process GROUP, and says plainly that sandboxes are separate), and pricing a run WHILE it runs — the running usage now travels with the trace into the mid-run flush | Cancelling a run from the surface; per-user persisted config (#470); the TUI views over `export` (#471) and `stats` (#472), both shipped as CLI commands in `0.68.0` and `0.69.0`; agent-authored labs (#473); a reusable persona panel (#474) |
| Off-app comms | Vendor-neutral in-sandbox email/SMS catch, a minimal persona inbox surface, and digest-only `humanish.comms-thread.v1` evidence; wired into the computer-use and shared-world routes over both HTTP and SMTP; live-proven end to end on 2026-08-08 — a persona signed up for a public app, read the emailed link in its inbox, and reached the signed-in product (`docs/goals/email-gated-signup/receipts/signup-verify-live-2026-08-08.md`); the adopter-hosted / app-url ingress plane is wired on the CUA and concurrent external-public routes (#387/#380, 2026-08-11) | Real-provider delivery; a live adopter-hosted receipt |

Capability proof and adopter replacement are different gates. A deterministic
test or kept live receipt proves that a Humanish mechanism works. The depth-axis
goal is met only when an adopter produces decision-equivalent evidence on a
green branch that deletes its bespoke generic harness and retains at most a
thin product-specific extension. No first-party deletion branch had met that
bar as of this status date.

Multi-origin shared-world has a ratified core-design direction, but the
implementation gate is still closed. A real adopter must first show a concrete
cross-origin need that the single-origin path or a downstream facade cannot
serve cleanly; the implementation packet then requires maintainer review before
build work starts. The current amendment is
[`docs/goals/multi-origin-shared-world/README.md`](https://github.com/danielgwilson/humanish/blob/main/docs/goals/multi-origin-shared-world/README.md);
the dated design packet remains unchanged.

## Current Safety Boundary

- Managed run, Observer, feedback, lab, actor-output, and source-archive paths
  bind to validated physical filesystem identities and fail closed on unsafe
  traversal, link, special-file, or retargeting states.
- Provider IDs stored in `run.json` are mutable evidence, not cleanup
  authority. `humanish cleanup` writes an inspection receipt; same-process
  teardown continues to use the provider handles that created the resources.
- The bundled `oss` manifest defaults to dry-run. Live OSS meta-lab execution
  fails with `HUMANISH_OSS_META_LIVE_ISOLATION_REQUIRED` before side effects
  until repository-derived instructions have an isolated credential boundary.
- Ordinary Git repositories and verified linked worktrees remain supported.
  Git metadata that cannot pass containment validation is recorded as
  unavailable rather than followed.

## Definition Of Awesome

A world-class Humanish run should eventually provide:

- one human-friendly command that starts simulations and opens Observer;
- multiple synthetic personas with different goals, patience, and skill levels;
- UI, CLI, TUI, and code-agent lanes in one mission-control Observer;
- real evidence: screenshots, terminal transcripts, lifecycle events, traces,
  filesystem setup-quality snapshots, artifacts, and verifier output;
- clear pass, fail, blocked, and gap states;
- public-safe feedback issue drafts that do not mutate GitHub by default;
- first-class `.yaml` lab manifests for reusable simulation runs;
- adapter contracts that let projects customize behavior without forking core;
- release gates that prevent PII, PHI, secrets, private artifacts, and stale
  internal residue from reaching the public repo or package.

## Current Objective

Make the public package and repo credible enough that an external maintainer can:

1. install the skill;
2. install `humanish`;
3. run `humanish init`;
4. run `humanish watch`;
5. run `humanish watch first-run` or another lab manifest;
6. inspect Observer evidence;
7. verify the bundle;
8. produce a public-safe feedback draft;
9. understand the next live-adapter path without reading chat history.

## Near-Term Goals

### 1. Public Readiness

Keep the repository clean and public-safe.

Acceptance:

```bash
pnpm release:check
git diff --check
```

Fresh clone release checks should pass before public visibility changes.

### 2. Future-Agent Ramp

Maintain a durable ramp that tells future contributors and coding agents where
to start, what exists, what remains, and what proof is required.

Acceptance:

- [`docs/ramp/README.md`](../ramp/README.md) stays current;
- this page stays current;
- README links both;
- release package includes both docs directories.

### 3. Fresh-Agent Install Proof

Prove the skill and package setup flow from a disposable target app with no chat
context.

Target proof:

```bash
npm i -D humanish
npx humanish init --yes
npx humanish watch --json --no-open
npx humanish verify --run latest --json
npx humanish feedback issue --run latest --repo owner/repo --format markdown
```

The proof target must use synthetic personas and no real user data.

### 4. Live Browser Adapter

Graduate from synthetic UI lanes to a real browser journey against a local app.

Minimum acceptance:

- local app target detection;
- browser launch;
- route/state capture;
- screenshot artifact;
- run bundle references screenshot evidence;
- Observer renders the screenshot;
- `verify` fails closed if required evidence is missing;
- bounded desktop/mobile two-step browser persona proof with per-step traces and
  screenshots. `done`
- LLM-driven browser lane: the registered `openai-computer-use` actor dispatches
  from a lab config (`subject.source: app-url`, loopback entry only) into a hosted
  E2B desktop, fills the provider-neutral `stream.actor` trace seam, and persists
  a verified redacted bundle (0.3.0 registered the actor; 0.4.0 made
  `actors[].type` a real dispatch key). `done`
- Clone subject provider: `subject.source: clone` + `serve` clones a repo INTO the
  sandbox, installs/builds/starts it from config, probes readiness, and records
  provenance (repo, commit, env names) in the bundle — config-only computer-use
  labs against real apps (0.5.0; see `docs/goals/proof-roadmap/goal.md` —
  repo-only, not shipped in the npm package — and
  `docs/principles/invariants-and-defaults.md`, which ships in the package).
  `done`
- De-paranoia (0.6.0): the redaction redesign + demoted defaults. Screenshots are
  full-fidelity by default (redaction binds the publish boundary, not capture —
  `policies.redactScreenshots` opts back in); `policies.allowPublicTargets` lets an
  owner drive a declared deployment/preview; `subject.clone.keep` is honored on
  failure for debugging; `serve.installTimeoutMs`/`buildTimeoutMs` are configurable
  for monorepo-scale builds. Doctrine updated with the capture-vs-publish rule. This
  re-sequences the proof roadmap: a redaction redesign and an overridable
  public-target policy are prerequisites for any decision-grade depth evidence, so
  they land BEFORE the consumer-web-app / agent-skill depth phases. `done`
- Device presets (0.6.1): screen/device is a real dimension, with LITERAL values copied
  from the in-house sims (mobile 414×896 … wide 1920×1080; default `desktop` 1440×950) —
  not guessed. `execution.desktop.device` picks the per-run hosted screen; the guessed 1280×800
  is gone. Honest fidelity: on the E2B route only width/height render (real mobile *layout*)
  + the model is told its device, matching the sims' organic lanes; true touch/DPR/UA needs
  the CDP actor. Per-*persona* device (N×devices) rides fan-out. `done`

### 5. Live Terminal And Codex Lanes

Make local PTY and Codex-style lanes reliable enough that Observer can show
running, passed, failed, blocked, and timed-out states without human inference.

Minimum acceptance:

- sanitized transcript persistence;
- explicit completion reason;
- verifier checks redaction status;
- Observer polling reflects lane completion;
- no raw private transcript or credential values.

Terminal-product real-agent lane (0.8.0; depth-axis layer 6, so an adopter can delete a
bespoke real-agent sim for humanish + a thin adapter — see
`docs/goals/terminal-product-lane/goal.md`):

- `subject.source: terminal-product` + `execution.target: e2b-terminal` + the registered
  `codex-exec` terminal actor route a config to a real Codex agent studying a product from
  public surfaces inside an E2B shell. `done`
- The credential-placement inversion is enforced by construction AND by verifier: the runtime
  key is injected ONLY command-scoped into the `codex` invocation, never sandbox-global; a
  deny-by-default allowlist excludes GitHub/payment/deploy/db creds; metadata is a positive
  allowlist; stdin is disabled with an always-present interventions ledger; cleanup is proven
  or the run fails closed. `done`
- Cost/no-spend ledger with the null-vs-known-zero-vs-absent discipline (unknowns are `null`,
  never guessed); the no-spend proof is DERIVED from the ledger, never asserted; `maxUsd`/
  `maxJobs`/`maxMinutes` caps enforced fail-closed. `done`
- Product-adapter extension seam: exported contract types + a scorer/feedback DI hook +
  adapter-namespaced product nouns, so an adopter attaches scoring/feedback as a thin
  in-repo extension without forking core. `done`
- Cleanup is proven BY EXACT CREATED ID: `Sandbox.kill(id)`, confirmed further by
  `Sandbox.getInfo(id)` where the SDK exposes it, and humanish never calls `Sandbox.list`. A live
  rung never needs a dedicated or isolated E2B key; the SAME shared operator key used everywhere
  else in this repo is safe, because humanish only ever reaches a sandbox it created (see
  "The placement rule" corollary in `docs/principles/invariants-and-defaults.md`).
- LIVE-PROVEN (2026-07-09): a real Codex agent, bootstrapped in a stock E2B shell (Node
  installed in-sandbox, run via `npx -y @openai/codex@latest exec`), studied a public
  agent-CLI product from its declared public surfaces and ran the product's free zero-spend
  guide within `$0` no-spend caps; verdict nonce-verified, cleanup proven BY EXACT ID
  (`getInfo(id)` SandboxNotFoundError, never `Sandbox.list`), verify 15/15, share_ready
  (`docs/goals/terminal-product-lane/receipts/terminal-live-rung-2026-07-09.md`). This closes
  the #159 live-receipt gap. Optional follow-up: a custom image with the agent runtime baked in
  to drop the per-run npx bootstrap. Duplex-PTY/xterm replay is a deferred SLICE 5.

Multi-lane fan-out for the computer-use lab (0.9.0; proof-roadmap layer 2, the prerequisite
for multi-actor shared-state work — #163, see `docs/goals/multi-lane-fanout/goal.md`):

- `actors[0].lanes[]` (differentiated roster: per-lane persona/device/starting-surface) XOR
  `actors[0].count` (homogeneous) fan out N independent E2B desktops in ONE run bundle;
  `per-lane worlds` is the only topology this slice (shared-world is #164). `done`
- `execution.concurrency` bounds in-flight paid desktops (default min(N,3); env may only
  lower it); a pre-flight spend/lane plan prints before any sandbox/provider call and at $0
  in dry-run; per-lane teardown reclaims ONLY each lane's own sandbox by id (never
  account-wide). `done`
- Proven deterministically (fake substrate: bounded concurrency, by-id teardown, fail-fast,
  hollow-lane caught) AND with a kept live rung (2 lanes, two distinct desktops, both
  reclaimed by id, bundle verifies — `docs/goals/multi-lane-fanout/receipts/`). `done`
- Deferred: seed-fork provisioning (PR-2), in-process-route fan-out, shared-world topology
  (#164).

Shared-world topology — multi-actor against ONE shared mutable service (0.10.0; proof-roadmap
layer 7; #164; `docs/goals/shared-world-topology/`). The north-star sim leverage: MANY personas,
ONE shared world.

- Sequential (`topology: shared-world`, concurrency 1): one sandbox, N role seats take turns
  against the shared DB; a checkpoint timeline proves role B acted on a world already containing
  role A's mutation. `done`
- **Concurrent (`topology: shared-world` + `concurrency > 1`): one subject sandbox served +
  `getHost`-exposed, N actor desktop sandboxes drive that one URL SIMULTANEOUSLY** (reuses fan-out
  orchestration; all N+1 reclaimed by id). Honest attribution under concurrency: per-persona
  outcomes + harness-clocked `laneWindows` proving real overlap + a `stateSeries` of the shared
  world under load; causation is structurally inexpressible (independent series, no
  per-delta→actor field). `done`
- A new `attributionClass: isolated | shared-world` honesty axis + verify FAIL-CLOSED on the
  required/forbidden `attributionLimits` sets + a concurrency-on-pass gate (a passed concurrent
  run must show real overlap AND a state delta coincident with it). `getHost` URLs are
  internet-reachable → the route is gated (verify) to synthetic+seeded subjects; the raw URL is
  digest-only in evidence. `done`
- **LIVE-PROVEN (0.10.1):** a kept live receipt ran 3 personas concurrently against ONE
  getHost-exposed synthetic plane — all 3 passed, all 3 lane-windows overlapped on the real clock,
  the shared stateSeries evolved under load, N+1=4 sandboxes reclaimed by id, verify ok
  (`docs/goals/shared-world-topology/receipts/concurrent-live-rung-2026-06-17.md`). One trial =
  phase-change proof, not scale. The next step is the real downstream sim migration (a
  synthetic-seeded multi-role app in the adopter's domain). Per-action causation,
  cross-sandbox concurrency beyond getHost, and #108 PII/PHI remain out of scope.
- shared-world (sequential AND concurrent) now also accepts `subject.source: local-tree` alongside
  `clone`: the ONE subject sandbox packs the operator's own working tree instead of cloning,
  reusing `provisionLocalTreeSubject` from the local-tree keystone (0.14.0). Provenance carries
  `archiveSha256` (the pin - one archive per run, so no per-lane unanimity math applies) plus
  host-side commit/dirty when the packed root is a git work tree; local-tree has no repo/publicRepo
  field. The N actor desktops on the concurrent route still drive the harness-minted getHost URL
  exactly as before; only the subject's provisioning + provenance source changed. The multi-origin
  design (`docs/goals/multi-origin-shared-world/design.md`) remains a separate,
  ratified but implementation-gated downstream slice. It is not part of
  `0.15.3`.

Adopter-driven engine features (0.11.0; surfaced by real bespoke-sim migrations):

- `execution.desktop.template` — run a lab on a CUSTOM E2B desktop image (name/ID) instead of the
  stock `desktop` template, threaded to `Sandbox.create(template, opts)` via one
  `createDesktopSandbox` seam across every desktop route (cua single+fan-out, sequential +
  concurrent shared-world subject+actors). Absent == the byte-stable stock-template call; recorded
  as `RunBundle.desktopTemplate`. Lets a Node/bun/DB-bearing adopter image run without
  installing the runtime per lane. `done`
- `humanish observe --run <id>` — serves a run's Observer over `http://127.0.0.1:<port>` (loopback
  only, path-traversal-guarded to the run dir, `/`->`/observer/index.html`) instead of `file://`,
  so browsers/automation can open it and artifact links resolve. `done`

Patch hardening (0.11.1):

- concurrent shared-world review now fails closed when any actor lane records a failed terminal
  trace; a lane can remain evidence without making the aggregate review green. `done`
- scripted-browser labs can provision a single cloned synthetic subject, expose it through a
  tokenless sandbox host, and drive deterministic scripted steps while persisting only public-safe
  provenance and host digests. `done`

Adopter-driven roster/readback ergonomics (0.12.0):

- Lane grouping metadata (`actorType`, `surface`, `caseGroup`) is adapter-owned and projected into
  Observer `laneGroups[]` plus stream labels, so downstream projects can group simulated users
  without teaching Humanish private role names. `done`
- `actors[0].roster[]` is compact authoring sugar for repeated lane groups. The parser expands it
  into deterministic `lanes[]` (`<group.id>-01`, `<group.id>-02`, ...) before the engine runs, so
  the runtime and run bundle keep one normalized lane shape. `done`

Provenance hardening (0.12.1):

- Clone-subject provenance now refreshes after successful provisioning phases, so `subject.commit`
  records the served subject HEAD rather than only the initial clone HEAD. This preserves truthful
  run-bundle provenance when an adopter's install/provisioning step checks out the exact revision to
  test. `done`

Adapter artifact evidence (0.12.15):

- Browser/shared-world adapter hooks may now write product/state proof files under the ignored run
  directory and return namespaced `humanish.adapter-artifact.v1` references. Core validates only the
  generic reference shape and local-path safety, Observer links the artifacts, and `verify` fails
  closed if a referenced file disappears. The payload schema and product nouns stay in the adapter's
  namespace. `done`

Evidence hygiene and readback polish (0.12.16):

- Browser-backed lanes launch Chromium with shared evidence-hygiene defaults (first-run/update
  background surfaces suppressed, extensions/sync/component update disabled, password/autofill
  profile prompts disabled) so screenshots prefer product pixels over browser chrome. `done`
- Run-bundle producers now use percent-scale simulation progress consistently: terminal states
  serialize as `100`, and only true in-progress shared-world snapshots serialize partial progress.
  This keeps Observer status pills from rendering completed runs as low-percentage complete states.
  `done`
- Verify results now separate valid local evidence from public-promotable evidence with
  `shareSafety.status`. Raw full-fidelity screenshot runs remain valid local proof
  (`local_only`), while feedback draft/issue commands require `share_ready` and fail
  closed with structured reasons. `done`

Attached CUA live Observer (shipped):

- Plain computer-use labs now honor the same attached `onObserverReady` lifecycle as shared-world
  labs: a live CUA run writes an in-progress bundle before actor sessions complete, loopback
  `serveObserver` can hydrate desktop stream iframes while actors are still running, and stream auth
  URLs remain runtime-only through the Observer WeakMap rather than persisted into `run.json` or
  `observer-data.json`. `done`

Local working-tree subject + operator observability (0.14.0):

- `subject.source: local-tree` packs the lab resolution cwd on the host (git-aware
  enumeration honoring `.gitignore` and including uncommitted work, an always-on
  non-overridable secrets denylist, symlinks stored never dereferenced, one
  enumeration driving both the tar file list and the digest), uploads the
  once-per-run archive into each lane's desktop sandbox, extracts into the subject
  dir, and reuses the clone route's install/build/state/start/probe pipeline
  unchanged. Provenance pins the tree by `archiveSha256` (a dirty tree cannot be
  commit-pinned) plus host-side commit/dirty; `verify` fails closed on a live
  local-tree bundle without a well-formed pin. Live-proven twice with kept
  receipts: a dirty synthetic fixture and this repo packing itself
  (`docs/goals/local-tree-subject/receipts/`). `done`
- Subject provisioning phase events: started/completed boundaries for
  clone/upload/extract/install/build/serve/readiness/seed-step phases stream to
  stderr by default (injectable via `CuaActorLabHooks.onPhase` /
  `SharedWorldLabHooks.onPhase`) and the completed trail persists into
  `bundle.events`; a single-lane provisioned boot is never silent again. `done`
- Truthful CLI envelopes at the command boundary: any uncaught action error emits
  one structured `humanish.cli-response.v1` envelope (never a raw stack trace under
  `--json`, never a second stdout document after a flushed envelope), `humanish runs`
  gained a real failure branch, and `doctor` failure now exits 2 like every other
  structured command (behavioral change). `done`

### 6. Lab Manifest Shape

Make reusable simulations feel like source artifacts, not hardcoded command
branches.

Minimum acceptance:

- `humanish/labs/*.yaml` is the committed lab source convention;
- `.humanish/labs/*.yaml` and `.humanish/local/labs/*.yaml` are ignored local
  overlays;
- `humanish watch [lab]`, `humanish lab list`, `humanish lab inspect <lab>`, and
  `humanish lab run <lab>` are supported;
- `--env-file <path>` loads local values for the current command without
  persisting values into artifacts;
- maintainer dogfood labs such as `oss` are examples, not the canonical
  consumer taxonomy.

### 7. OSS Lab Health Readback

Make the maintainer `oss` lab report nested lane health back into the
top-level Observer instead of relying on a human watching the desktops.

The current safety boundary above governs this lane. The completed bullets below
record prior capability and evidence shape; they do not mean the live
entrypoint is currently enabled.

Minimum acceptance:

- each lane records setup status; `done`
- each lane records target app status/URL or blocker; `done`
- each lane records nested Observer presence; `done`
- each lane records nested verification status or blocker; `done`
- each lane records setup-quality filesystem evidence and Observer can inspect
  it; `done`
- top-level Observer updates lane verdicts from evidence; `done`
- feedback candidates are derived from setup-quality/actor evidence; `done`
- Codex app-server actor telemetry is persisted as redacted trace, event, and
  transcript artifacts; `done`
- each lane receives a meaningful-use score over setup, filesystem, nested
  Humanish proof, actor activity, product surface, and feedback; `done`
- provider-backed nested app-url proof now drives a bounded two-step
  desktop/mobile browser persona journey in a headed E2B lane; `done`
- app-specific executable browser steps can now be authored under
  `humanish/scenarios/*.yaml` and are summarized into top-level nested proof
  evidence; `done`
- repeated public app/tool headed proofs with app-specific manifests have passed
  against two public targets; `done`
- next gap: richer multi-step product journeys and broader multi-persona
  matrices.

## Non-Goals

Do not make these default behavior:

- live provider spend;
- GitHub API mutation;
- hosted queues, databases, or webhooks;
- production deploys;
- real customer/user/patient data;
- private screenshots or raw transcripts;
- private upstream artifacts.

Maintainer-only tooling can exist later, but it must be opt-in, token-explicit,
and dry-run-first.

## Drift Alarms

Stop and correct course if:

- docs start depending on chat memory;
- Observer gets prettier without stronger evidence;
- feedback drafts imply product proof from synthetic contract proof;
- tests pass while generated artifacts are not inspectable;
- actor setup/use trials produce findings that never become feedback candidates;
- live labs require private infrastructure to look impressive;
- package docs link to files that are not shipped;
- public-safety gates become optional.

## Best Next Work

**2026-09-06 (0.83.1).** Desktop CLI studies without a declared product install
now prepare Node/npm before participant entry, while leaving the product
uninstalled. Two real stock desktops began without the runtime and reached the
entry hook with Node/npm/npx available in ordinary and sudo shells. The hook
then stopped deliberately without starting a participant or model. See the
[runtime conformance receipt](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/desktop-cli-runtime-2026-09-06.md).

Terminal startup failures preserve confirmed cleanup from the desktop startup
guard. An existing empty terminal event log is valid only when both embedded
and retained terminal traces declare zero events. Unknown cleanup stays
unproven, and a failed startup remains a failed run. The compiled CLI regression
checks verified failure evidence and natural process exit using the installed
SDK's debug constructor with network access blocked. See the
[startup evidence receipt](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/terminal-startup-evidence-2026-09-06.md).

**2026-09-06 (0.83.0).** First-party OpenAI computer-use actors accept
an optional per-response `maxOutputTokens` setting. Two independent lanes and two
sequential shared-world roles forwarded the declared limit in real requests; all
four preserved provider truncation as incomplete, with zero actions or closing
requests. The same scoped integration confirmed sequential actor-level reasoning
effort and a lane override on the request and trace. This proves configuration
propagation, not participant success or persona efficacy. See the
[four-role live receipt](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/output-token-limit-2026-09-06.md).

Hosted browser setup checks physical X window bounds before participant actions.
A clipped window gets one correction and a measured readback; a window that
remains clipped stops the lane. Two hosted fault-injection probes restored a
bottom-edge button and clicked it successfully. This checks desktop containment,
not mobile gesture fidelity. See the [desktop geometry receipt](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/desktop-geometry-2026-09-06.md).

Recovery hints now allow task-directed waiting and suggest recovery without
asking a participant to abandon early. Deterministic delayed-start tests cover
the prompt change and unchanged hard idle limits; live multiplayer patience
has not been measured. Lane and roster-group objects reject unknown fields
before allocation, so misspelled controls cannot silently become defaults.

**2026-09-05 (0.82.1).** Computer-use actors now preserve a provider output-limit
interruption as incomplete instead of treating a response without actions as
success. Two captured live Responses API shapes reproduce the old false pass
and verify the correction; other explicit non-completed statuses also fail
closed. Usage and partial text remain in the run, with no execution of actions
from an interrupted response. See the [provider-limit receipt](computer-use-actor/receipts/provider-token-limit-2026-09-05.md).

**2026-09-05 (0.82.0).** Computer-use desktop estimates now use observed CPU and RAM,
with missing resources and incomplete lifetimes left unknown (#687). Repeated clicks avoid
the redundant cursor move when a fresh position check confirms the pointer is already there
(#685). Terminal studies accept an exact Codex package version and forward the declared model
and reasoning effort; evidence records the executed version without presenting runtime defaults
as observed model usage (#688). Local-path redaction preserves nested terminal JSON framing,
and the release report reader exposes skipped malformed lines (#686). Observer cards and reports
show typed participant blockers as Blocked while retaining the original protocol trace (#691).

The new [TodoMVC comparison](https://github.com/danielgwilson/humanish/blob/main/docs/goals/computer-use-actor/receipts/todomvc-edit-confirmation-2026-09-05.md)
connects a keyboard blocker to a reproducible local patch: uninterrupted keyboard completion was
0/2 before and 2/2 after, with one provider interruption in each version retained in the twelve
attempts. This descriptive synthetic comparison does not establish human completion rates.
The public field notes and shorter reference-linked README make the method easier to inspect
(#673, #682, #689).

**2026-09-05 (0.81.0).** First use now distinguishes the free evidence preview
from a live participant study, with concise successful setup output and complete JSON details
(#660). The website has runnable docs and a generated CLI reference (#661, #668). Retained participant
reports survive automatic stops. Supported providers with retained history can add one closing
report when time and known budget remain; clean reports such as “no confusion or hesitation”
stay clean (#658, #670, #671). Desktop startup cleanup retains acquired handles and records
confirmed or unknown reclamation. The SDK's detached screenshot-file cleanup rejection is
handled (#665, #666).
Terminal output reconciles SDK callbacks with returned aggregates, preserving legitimate
repeated lines and usage turns while avoiding doubled capture (#672). Opt-in `openai-egress`
auth keeps the raw OpenAI runtime key outside the sandbox; every sandbox process can still
spend through the proxy, so this is not a provider spending limit (#663). Stock terminal
startup installs a checksum-verified Node archive without refreshing unrelated package mirrors
and gives newly installed npm a default global prefix on the standard PATH (#677, #680). Mobile studies warn that desktop pointer-to-touch conversion can change repeated-tap
behavior; gesture failures require direct or native touch confirmation before app attribution
(#678).

**2026-09-04, night (0.80.0).** The observation window reaches every desktop route: the
sequential and concurrent shared-world seats forward `dwell` the way they forward `stopWhen`
(#645), with a plumbing test per route and two live receipts, three participants holding together
on one shared board whose checkpoint digest stood still until they acted, and two seats holding
in turn on one sandbox (`receipts/dwell-window-2026-09-04.md`). The sequential route refuses a
sandbox request over the provider's 60-minute cap before any call and names the per-role ceiling
(#649); the provider's refusal had surfaced as a bundle that failed verification. The planted-defect
benchmark ran with a second brain, the operator's own Claude Code as the participant: 14 of 15
reported, nothing invented in three clean runs, 72 of 75 across both brains
(`bench/RESULTS-2026-09-04-claude.md`). A two-minute window and a camera feed of the adopter's own
are live receipts too.

**2026-09-04, evening (0.79.0).** Two of the operator's own asks, each with a live receipt. A
declared observation window (#510): `dwell` on an actor or a lane holds the page once its condition
matches (or from the start), captures a frame on a cadence, takes no action and requests no model
turn, then hands control back with a hint or ends the session; the window is recorded in the trace
as deliberate and never outlasts the session budget. On TodoMVC the window opened when "1 item
left" matched, held 60.6 s, captured six frames with no model turn inside, and the participant then
added the second task (`receipts/dwell-window-2026-09-04.md`). The first live attempt found the
option dropped between the lane and the loop by a spread the type checker cannot see; a plumbing
test now pins it. A participant with a camera (#509, first slice): `execution.desktop.media.camera`
gives a hosted Chrome lane a capture device (ffmpeg's test pattern generated in the sandbox, or a
`.y4m` of the adopter's) behind the browser's own permission dialog by default;
`policies.mediaPermission: granted` bypasses it; the bundle records the feed and the flags under
`desktopBrowser.media`; a microphone is refused without an image that has an audio stack, before
any spend. Live, Chrome raised its real dialog with a preview of the feed, the participant chose
"Allow this time" and read back 640x480 (`receipts/participant-camera-2026-09-04.md`). Under
the then-shipped mobile-emulation input path, TodoMVC rename had stopped 3 of 3 phone
participants at this checkpoint; Excalidraw read 12 of 12. The 2026-09-05 input-conformance
correction above qualifies attribution of those mobile failures.

**2026-09-04, later (0.78.0).** `@e2b/desktop` moved from 2.2.3 to 2.3.3 (#638): its 2.3.1
changelog names the socket #581 found today, a background command's event stream the SDK kept
open after `Xvfb` and `startxfce4` were launched, which held the CLI process alive twelve minutes
past a run's written result. `doctor` now prints the installed desktop SDK version on its row and
attaches an advisory with the fix below 2.3.1 (#639). A live try-live on the new SDK reached its
goal in 104 s and settled with no active resources.

**2026-09-04 (0.77.0).** Four fixes found by runs and one by a scanner. A phone-emulated lane now
follows the participant into a tab that opens later: the hold-mode applier attaches to every page
target Chrome creates, paused before its first navigation, so the new tab lays out at the phone
width, and the state observer reads each new tab's own fidelity report, recording a covered tab
under `desktopGeometry.fidelity.laterTargets` (width, DPR, touch points) and a drifted one as a
lane warning with the number the page gave; the applier's own log travels as `holderLog`. The
first live proof failed in the participant's hands (a paused popup never resumed) and the shipped
design is the one four live runs settled on: never pause a later tab, send the overrides the
moment it exists, reload it once after its first navigation commits
(`docs/goals/computer-use-actor/receipts/later-tab-emulation-2026-09-04.md`, #623, #636). A sandbox create
or archive upload that fails on a transient provider error is retried once and named on the lane
(#630): six lanes started 20 s apart lost five to E2B SDK errors before any turn, a probe of the
same SDK a minute later worked in 6 s. The provider's `Retry-After` now governs a retry (capped
at 60 s) and a `403 misalignment_policy_violation` ends the lane named and unresumed (#633). The
provisioned-clone CI flake runs on an injected clock (#276 closed). The fourth benchmark run on
this build read 15 of 15 planted defects with nothing invented in three clean runs, cumulative 58
of 60 (`bench/RESULTS-2026-09-04-0.76.0.md`). humanish.dev negotiates `Accept: text/markdown`
and llms.txt says when to use humanish (#634).

## Best Next Work

**2026-09-03, later (0.76.0).** A hosted Chromium lane on a mobile preset can now be a
mobile-emulated browser: `execution.desktop.fidelity.mobileEmulation: true` applies a real 414 px
CSS viewport, the preset's device pixel ratio, touch events and a mobile user agent before the
participant's first observation, and the bundle records what the page then reported about itself
under `desktopGeometry.fidelity` (#221, `docs/goals/computer-use-actor/receipts/mobile-emulation-2026-09-03.md`).
On the published 0.76.0, neither phone participant could rename through the emulated input path,
where the 500 px runs without touch had finished. Those are historical instrument observations:
the 2026-09-05 conformance check found SDK double click and direct touch differ on the original
editor, so the earlier outcome does not establish a touch-device app defect.
The persona axis was replicated the same evening on drawDB and TodoMVC and given a third app,
Excalidraw, as the clean control (`persona-axis-phone-2026-09-03.md`); a multi-lane study's
second and third findings reach `feedback draft` through `--candidate` (#609); a negated report
word no longer counts as friction (#614); and the adopter metric excludes this project's own
checkout wherever its CLI is spawned from (#611). Three host-timing test flakes were made
load-independent.

**2026-09-03 (0.75.0).** Three fixes found by runs, each with a receipt. The DevTools probe behind
every url, page-text and CSS-viewport observation ran on Node inside the sandbox, and the stock
desktop has none, so on the app-url route and on any subject served by something other than Node
every `urlIncludes` / `textIncludes` stop condition and task criterion had been silently blind; it
runs on python3 now, a dark channel is named in the lane warnings, and the same lab reads
"never measured in 2" on 0.74.0 and 2/2 at turn 0 on 0.75.0
(`docs/goals/computer-use-actor/receipts/task-observation-514-2026-09-03.md`, #514). A subject
install or runtime bootstrap that exits non-zero is retried once, and the error leads with a line a
person can act on (#602). The gpt-5.6-sol rates were re-pinned at the live promotional sheet
(4 / 0.40 / 5 / 20 per 1M through at least 2026-11-21), so estimates stop running 25-33% high, and
gpt-6-astra is priced. #548 closed on the benchmark receipts.

**2026-09-01 (0.66.0 through 0.70.0, one session).** The product got its first efficacy numbers and
they are in the repo with run ids: planted-defect recall 43 of 45 over three benchmark runs and
12 clean runs with nothing invented (`bench/`; 58 of 60 and 15 clean runs after the 09-04 rerun), 5 of 6 findings confirmed on TodoMVC and 11 of 12
on drawDB against the source (20 participants on apps we did not write, 0 false reports), and the
comparison of keyboard and pointer use on two apps: every keyboard-first participant hit a defect no
mouse-driving participant met (drawDB's mouse-only database modal, TodoMVC's double-click-only
rename), receipts under `docs/goals/computer-use-actor/receipts/`. These observations show
sensitivity to explicit keyboard-versus-pointer instructions; they do not establish incremental
benefit from persona prompting over a matched generic tester. Five cold installs of two
published versions reached the goal in under three minutes each. On the way the runs found and
the releases fixed: telemetry that never said what a study was (and stored IPs), a refused lane
written up as a pass (#476), a blocker regex that refused five of five finished runs (#565, then
the structural #570: the participant declares its own outcome, 12 of 12 adherence), a
study-participant marker nothing set (#546), hung turns that ate a lane's budget (#469, #480),
and a Claude participant with no memory across turns (#520). `humanish stats` (#472) and
`humanish export` (#471) exist as CLI commands.

The next outcome to establish is an external maintainer using Humanish on their
own app, finding a useful problem, repairing it and retaining a comparable rerun.
The published studies establish synthetic capability on their named subjects;
they do not establish external adoption or incremental persona value.
[Runnable documentation](https://humanish.dev/docs) and the repair-study recipe
are available; the documentation gap from #513 is closed.

Remaining engineering work includes:

- #581: #665 already reclaims acquired desktop instances when startup fails,
  and #666 handles detached screenshot cleanup errors. Remaining boundaries are
  allocation ambiguity before instance acquisition, unconfirmed reclamation,
  and direct proof that a failed real-SDK CLI exits promptly after its result.
  The 2.3.3 SDK update fixed the identified background stream holder; older
  optional peers still receive an advisory, so a universal no-linger claim
  would be too broad.
- #509: microphone support requires a desktop image with an audio stack and
  the matching launch path. The unsupported declaration remains rejected.
- #221 and #676: real-device and touch-input fidelity beyond viewport emulation;
  #623: scripted-browser support beyond its current model-free route.
- TUI views over `stats` and `export` (#455), registry promotions (#431), and
  the remaining shared-world evidence work (#365, #446).

Earlier state, kept for the record:

The bounded public-proof side task is done: a verified, legible four-persona
Observer hero from a commit-pinned public application (drawDB) shipped in
`0.16.0`. That run treats the application as a study subject, not a Humanish
adopter, and does not imply endorsement; it does not satisfy the depth gate.

The operator-pinned train-of-thought thread (#427, both stages) and the
#441 queue head are done as of `0.47.0`, live-proven the same day they
shipped: trace items carry recording stamps and structured click
coordinates; the live path flushes `liveActor` partials mid-run so the
attached Observer's timeline grows while a study runs; playback runs at
the participant's recorded pace when stamps exist (and the transport says
which clock it is on); the participant card's decide-line ticks the
newest reported thought during a live lane; and a live-shaped golden cut
from a kept receipt run pins the whole shape (`?fixture=live`). On the way
the capture exposed and closed two evidence-quality defects: the persona
identity leak (#452) and the credible-pass guard's incentive inversion
against post-success defect reports (#453 — the verdict scan and the
friction tally are now separate reads of the same narrative). Shared-world
roll-up honesty (#364) closed via an external contribution that separates
credibility, mission endpoint, and convergence into three explicit claims.

Deep links landed in `0.48.0` (#464): every participant and frame is
addressable (`#/lane/<id>/f/<n>`), Back/Forward restore the view, and a
reload or shared link lands on the exact moment — #441 closed entirely.

The npx-first-try adoption cluster closed in `0.49.0`, operator-prompted and
adversarially red-teamed before merge (both arcs): provider keys now resolve
through each vendor's native chain (#436 — the documented project overlay,
`e2b auth login`'s store, `gh auth token`, and a `humanish keys set` user
store; fills announced by name and source, never value; `HUMANISH_STRICT_KEYS=1`
opts out) and #346 closed on its receipts. The computer-use default moved to
`gpt-5.6-sol` with the whole 5.6 family priced, and the cost estimate now
models the two billing mechanics 5.6 introduced — cache writes at 1.25x and
long-context re-tiering — exactly, from a new per-request usage ledger on the
trace (#334). Both spend caps price through the same tier-aware estimator.

The standing queue, in rough order:

1. registry promotions: the wordmark (#431), the participant card, and the two
   vendored Base UI wrappers (drawer, popover) once a second surface consumes
   them;
2. shared-world honesty, remaining half: per-action evidence (#365) and
   exposure-flag coverage (#446);
3. the stakeholder TUI (#455): research + token-translated mocks on the
   operator review surface, design sign-off gated before any code.

The depth-axis deletion front (an adopter's bespoke terminal-product sim,
comparator contract posted on the adopter's tracker) is paused awaiting the
operator's decision-ledger sign-off, deliberately: it resumes on that
sign-off, not by default. The multi-actor shared-state adopter gate (#166)
needs one live rerun of its replacement-critical family on current humanish;
the recon (family, runner pin) is recorded and it runs as its own arc.

The version-pinned README hero is the drawDB real-application study: a live
four-persona capture that proves package/Observer rendering, public-safe asset
delivery, and real-application evidence against a studied subject. It is not
adopter deletion evidence, which is a separate and higher gate.
