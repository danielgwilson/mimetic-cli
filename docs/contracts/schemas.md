# Contract Schema Index

Date: 2026-06-02 (current-state note updated 2026-07-14)

Status: reference map for the major contracts shipped through source version
`0.82.1`; it is not an exhaustive inventory of command/result envelopes. Exported types,
schema constants, parsers, and validators in `src/` are authoritative. Rows
marked "reserved" name layering intent only — no code emits or validates them
yet. Do not emit a reserved schema.

## Purpose

This document names the core Humanish contracts before more implementation
lands. It is intentionally public-safe: examples use synthetic ids, local
relative artifact paths, env var names without values, and redacted evidence
notes.

Core contracts are reusable. Adapter contracts describe a target app, CLI, or
workflow without leaking private upstream truth into core.

## Ownership Rule

| Layer | Owns | Does not own |
| --- | --- | --- |
| Core | Schema versions, run ids, artifact layout, lifecycle events, actor/substrate status, evidence shape, review, verification, redaction, feedback mechanics, latest/history indexes. | Product routes, real customer data, private screenshots, private transcripts, credential values, target-specific acceptance language. |
| Adapter | Product routes, scenario/persona choices, app topology, env var names, network allowlists, coverage vocabulary, milestones, fixture data, target-specific proof expectations. | Generic run bundle schema, public-safety gates, provider secret values, raw private artifacts, GitHub mutation authority. |

## Contract Index

| Contract | Schema | Public-safe fixture |
| --- | --- | --- |
| Run bundle | `humanish.run-bundle.v1` | `synthetic-run-bundle` |
| Adapter | `humanish.adapter.v1` | `synthetic-cli-adapter` |
| Lab | `humanish.lab.v2` | `first-run` |
| Persona | `humanish.persona.v1` | `synthetic-maintainer` |
| Scenario | `humanish.scenario.v1` | `first-run-smoke` |
| Actor trace | `humanish.actor-trace.v1` | `synthetic-actor-trace` |
| Substrate | reserved (never shipped) | none |
| Evidence stream | reserved (streams live inside the run bundle) | see [`run-bundle.md`](run-bundle.md) |
| Review | `humanish.review.v1` | `contract-proof-review` |
| Verification | `humanish.verify-result.v1` | `five-check-verify` |
| Policy | `humanish.policy.v1` (fixture-only; not engine-validated) | `public-safety-policy` |
| Feedback | `humanish.feedback.v1` | `public-safe-feedback` |
| Terminal cost ledger | `humanish.terminal-cost-ledger.v1` | see Terminal Cost Ledger below |
| Terminal no-spend proof | `humanish.terminal-no-spend-proof.v1` | see Terminal Cost Ledger below |
| Pricing (operator-editable rates) | `humanish.pricing.v1` (`src/pricing.ts`; dated per-model + E2B desktop rates) | see Run Cost Summary And Estimated Actor Cost below |
| Run cost summary | `humanish.run-cost-summary.v1` (additive `RunBundle.cost`; estimate, never a charge) | see Run Cost Summary And Estimated Actor Cost below |
| Estimated actor cost | `humanish.actor-estimated-cost.v1` (additive `ActorTrace.estimatedCost`) | see Run Cost Summary And Estimated Actor Cost below |
| Model settings | `humanish.model-settings.v1` (additive `ActorTrace.modelSettings`; the reasoning effort the request carried) | see Actor Trace below |
| Affordance use | `humanish.affordance-use.v1` (additive `ActorTrace.affordanceUse`; per-class counts of the routes an actor took) | see Affordance Use below |
| Adapter score | `humanish.adapter-score.v1` (`RunBundle.adapterScore`; namespaced; route-specific acceptance semantics) | see Product-Adapter Extension Seam below |
| Adapter artifact | `humanish.adapter-artifact.v1` (`RunBundle.adapterArtifacts[]`; namespaced; local relative proof references) | see Product-Adapter Extension Seam below |
| Shared-world evidence | `humanish.shared-world.v1` (additive `RunBundle.sharedWorld` + `RunBundle.attributionClass`; `topologyMode: sequential \| concurrent`) | see Shared-World Evidence below |
| Comms thread | `humanish.comms-thread.v1` (off-app email/SMS the app sent, captured; a `kind: log` run-dir artifact of DIGESTS only — from/to/subject/link digests + an OTP count, never raw) | see `comms` under Lab Manifest |
| Serve result | `humanish.serve-result.v1` (`src/observer-serve.ts` is authoritative) | none (command result envelope; see Serve Result below) |
| Serve control plane | reserved (`/_humanish/api/*` answers `501` `HUMANISH_SERVE_CONTROL_PLANE_DISABLED` in v1) | none |

## Lab Manifest

Schema: `humanish.lab.v2` (`src/lab-config.ts`). There is deliberately no v1
compatibility: v1 (`kind`, top-level `sims`) had zero real users and was
deleted when labs became config.

A lab is a composition over code primitives, not a hardcoded kind:

- `subject`: what the run acts on — `this-repo`, `clone` (owner/repo slugs,
  optional in-sandbox `serve` + env var names + `state`), `local-tree` (the
  operator's own working tree, packed on the host and provisioned in-sandbox
  in place of a clone; see below), `app-url`
  (loopback unless `policies.allowPublicTargets` declares an owned deployment),
  `local-app` (an already-running LOCAL dev server driven IN-PROCESS via a
  custom `CuaExecutor`, NO clone and NO E2B desktop — always loopback), or
  `terminal-product` (a CLI/product a real autonomous terminal agent studies
  from PUBLIC surfaces only — see below). A
  `local-app` subject pairs a computer-use actor with `execution.target: local`
  (or absent) and is library-assisted: the caller supplies
  `cuaHooks.buildExecutor` + `buildProvider`; with no hooks the engine fails
  closed (`HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR`), never a desktop attempt. See
  [`docs/architecture/state-driven-executor.md`](../architecture/state-driven-executor.md);
- `subject.localTree` (`local-tree` subjects, computer-use route): pack/upload
  knobs for the packed working tree: `exclude[]` (extra archive excludes on
  top of the always-on denylist; entries match as a repo-relative path
  prefix or an exact basename, absolute paths and glob syntax are rejected
  at parse time, and leading `./` / trailing `/` are normalized), `keep`
  (preserve the sandbox on a failed lane for debugging, mirroring
  `subject.clone.keep`; a kept local-tree sandbox holds the packed working
  tree, including any file that survived the denylist), and
  `maxArchiveBytes` (upload size cap override; default 256 MiB). Routing requires `execution.target: e2b-desktop` and a
  computer-use actor; `subject.serve`/`env`/`state` apply exactly as they do
  on the clone route (identical install/build/start/state semantics). The
  packed root is the lab resolution cwd; there is no path field, by design
  (an absolute path in a lab manifest would be a machine-specific,
  unshareable, leak-prone artifact). Enumeration is git-aware when the root
  is a git work tree (`git ls-files --cached --others --exclude-standard`,
  honoring `.gitignore`) or a denylist-only recursive walk otherwise; an
  always-on denylist (`.git`, `node_modules`, `.humanish`, `.env*`, key/cert
  file patterns, and common credential-shaped names; the authoritative list
  is `LOCAL_TREE_DENYLIST_BASENAME_PATTERNS` in `src/source-archive.ts`)
  applies in both modes and is not overridable. The denylist matches names,
  not contents; a secret in a file it does not name packs like any other
  file, so review the pack summary line and use `localTree.exclude`. The lab packs
  ONCE per run and uploads the identical archive to every fan-out lane. The
  in-sandbox commit refresh clone subjects use is skipped: `.git` is never
  uploaded, so identity comes from the host-side archive digest instead. See
  [`docs/goals/local-tree-subject/goal.md`](../goals/local-tree-subject/goal.md);
- `subject.product` (terminal-product subjects): the product the agent studies.
  `product.name` is a public-safe token (committed fixtures use a NEUTRAL mock
  name); `product.publicSurfaces[]` is the list of http(s) URLs (docs, llms.txt,
  skill manifest) that are the ONLY world the agent sees — the lab does not
  clone/provision the product, so its provenance is recorded UNPINNED
  (invariant 5). `serve`/`clone`/`state`/`repos`/`appUrl` are rejected on a
  terminal-product subject (a field that cannot act on the route is a parse
  error, not silently dropped). See
  [`docs/architecture/terminal-product-lane.md`](../architecture/terminal-product-lane.md);
- `subject.state` (clone or local-tree subjects, computer-use route): the
  subject's state story. `state.seed[]` declares ordered, bounded
  seed/migration/fixture steps (`{ name, command, when: before-build |
  before-start | after-ready, timeoutMs }`) executed in-sandbox around the
  serve sequence; `state.external[]` declares env var NAMES (each must also
  appear in `subject.env`) pointing at state the lab does not control,
  recorded as UNPINNED in provenance. Commands persist in evidence as
  sha256-16 digests only, never as text;
- `actors`: who drives it. On computer-use (including shared-world),
  scripted-browser, and terminal-product routes, `actors[0].type` is a real
  dispatch key resolved against the actor registry. On synthetic and meta-lab
  routes it remains a descriptive label (e.g. `synthetic-persona`). The
  `codex-exec` descriptor's direct `runSession` member is a fail-closed
  compatibility entry, not the live runner; the terminal-product lab route
  owns the live sandbox, auth, cap, evidence, and cleanup lifecycle.
  `actors[0].count` carries route-specific meanings: synthetic route lane
  count (simCount); scripted-browser route surface roster (1 = desktop,
  2 = desktop + mobile, default 1); computer-use **E2B** route the HOMOGENEOUS
  fan-out lane count (N identical lanes, each its own E2B desktop — per-lane
  worlds, cap 16). The in-process/local-app computer-use route stays single
  lane (no E2B to fan out);
- `actors[0].lanes[]` (computer-use E2B route): a DIFFERENTIATED fan-out roster,
  each `{ id?, actorType?, surface?, caseGroup?, persona?, device?,
  instruction?, target?, entry? }` becoming one independent E2B desktop (or, on the
  shared-world routes, one role/seat against the shared plane). `actorType`,
  `surface`, and `caseGroup` are adapter-owned public-safe labels for grouping
  simulated users; they are not core enums, and `actorType` is deliberately
  separate from the execution dispatch key `actors[0].type`. `lanes` is XOR with
  `count` (declare a roster OR a homogeneous count) and XOR with
  `actors[0].laneFocus` (a roster's per-lane `instruction` is the steer);
  `lanes[].device` is XOR with a raw `execution.desktop.resolution`. Lane ids
  default `lane-01`..`lane-NN`, must be unique, and name per-lane evidence paths
  (`actors/<streamId>.json`, `screenshots/<laneId>/`). Cap 16 lanes. On every
  non-cua route `lanes` is inert (warned). `subject.clone.fanout` is REJECTED on
  the cua route (declare fan-out via `count`/`lanes`; `clone.fanout` drives the
  OSS smoke/meta routes only);
- `actors[0].lanes[].target` (app-url × computer-use E2B route only): an
  absolute browser URL that lane opens instead of `subject.appUrl`. This is the
  setup-produced-target handoff for crawler/swarm labs: an adapter may start any
  topology it needs, then declare exactly which target each actor should drive.
  If any lane declares `target`, every lane in that roster must declare one.
  Public/non-loopback targets still require `policies.allowPublicTargets: true`.
  `target` is mutually exclusive with `entry`: `target` is an absolute app-url
  browser target; `entry` is a shared-world same-origin seat path;
- `actors[0].roster[]` (computer-use E2B route): compact authoring sugar for
  repeated lane groups, each `{ id, count, actorType?, surface?, caseGroup?,
  persona?, device?, instruction?, target?, entry? }`. The parser expands it into
  deterministic `lanes[]` before the engine runs (`viewer-01`, `viewer-02`,
  ...), so the runtime and run bundle keep one normalized lane shape. `roster`
  is XOR with explicit `lanes`, homogeneous `count`, and `laneFocus`;
- `execution.concurrency` (computer-use E2B routes, including shared-world): a
  CAP on lanes in flight at once. When omitted, every declared seat runs
  simultaneously (the parser fills `concurrency = laneCount` for multi-seat
  labs) — total sessions and spend are identical either way; only wall-clock
  and simultaneity differ. Declaring a value below the seat count runs seats in
  waves and emits a warning saying so, because a green waved run is otherwise
  indistinguishable from the all-live run the author meant. On shared-world
  labs this field is also the sequential/concurrent selector: `concurrency: 1`
  is the sequential turn-taking PoC; anything higher (including the filled
  default) is the concurrent substrate. The env override
  `HUMANISH_CUA_MAX_CONCURRENCY` may only LOWER the effective bound, never
  raise concurrent paid desktops (invariant 3), and a lowering is recorded on
  the plan (`envLoweredConcurrencyFrom`). Inert (warned) on other routes.
  `execution.timeoutMs` is the PER-LANE session budget on this route (semantics
  change: it was the single-session budget pre-fan-out); there is no run-level
  wall clock. `policies.allowPublicTargets` cannot combine with N>1 against one
  implicit public `subject.appUrl` (ambiguous shared-world-ish topology); it may
  combine with N>1 only when the roster declares explicit `lanes[].target` for
  every lane, OR when `subject.topology: shared-world` is ALSO declared — that
  routes N>1 against one public target to the EXTERNAL-PUBLIC shared-world plane
  (see Shared-World Evidence below), not per-lane worlds;
- `subject.publicTarget: { owner, authorized: true }` (external-public shared-world
  route ONLY): the operator's REQUIRED ownership attestation when a real PUBLIC
  deployment (`source: app-url` + `topology: shared-world` + `allowPublicTargets` +
  `concurrency > 1`) is used directly as the shared plane. The harness neither
  provisions nor exposes the target, so it cannot attest synthetic data; the operator
  MUST attest they own/operate it. Author-trust (unverifiable); rejected on every other
  route. `actors[0].lanes[].host: true` marks the single designated host seat there;
- `subject.appUrl`: a loopback http(s) URL a computer-use actor drives, OR — on the
  external-public shared-world route — the non-loopback public deployment used as the
  shared plane (with `publicTarget` + `allowPublicTargets`);
- `execution`: where it runs — `local`, `e2b-desktop`, or `e2b-terminal`, plus
  desktop device/resolution and timeouts. app-url subjects pair `e2b-desktop`
  with a computer-use actor, or `local` (or absent) with a scripted-browser
  actor; terminal-product subjects pair `e2b-terminal` (or absent → implied)
  with a registered terminal actor;
- `execution.desktop.template` (e2b-desktop computer-use routes): a custom E2B
  desktop TEMPLATE (image) NAME or ID the run launches on — for a subject that
  needs runtimes the stock `desktop` image lacks (e.g. node/bun/a local Postgres
  baked into an adopter-maintained image). Any non-empty string is a valid
  name/id (no allowlist); a blank/whitespace value is rejected. Threaded to the
  SDK's `Sandbox.create(template, opts)` on EVERY desktop-creating route (the
  single-lane + fan-out cua lanes, the sequential shared-world plane, and the
  concurrent shared-world subject AND every actor sandbox); when absent the call
  stays the byte-stable `Sandbox.create(opts)` default (the stock template). The
  template actually used is recorded in the run bundle as `desktopTemplate`
  (public-safe — a template name is not a secret). Inert (warned) on every route
  that creates no desktop, incl. the in-process `local-app` cua route and the
  meta route — never silently ignored (invariant 6);
- `execution.desktop.browser` (e2b-desktop computer-use/fan-out routes, plus
  sequential and concurrent shared-world actor seats): optional browser family
  preference: `default`, `chrome`, `chromium`, or `firefox`. Absent/default
  preserves the historical desktop opener behavior. A concrete value means
  launch that browser or fail closed; when configured, the bundle records
  `desktopBrowser` with the requested value and the resolved in-sandbox command;
  `streams[].desktopGeometry.fidelity` (tier `mobile-emulated`, request, CDP methods applied,
  and the page's own read-back) only when `execution.desktop.fidelity.mobileEmulation` was set
  when known. Inert (warned) where this route-specific browser launcher is not
  used;
- `execution.terminal` + `execution.runtimeAuth` (terminal-product route):
  `terminal.transport` is `exec-stream` — captured NON-interactive exec output
  (stdin disabled); `pty` is rejected because labeling captured exec output as
  an interactive PTY would overstate the mechanism (invariant 6; a true duplex
  PTY transport does not ship). `terminal.stdin` defaults to `disabled`
  (`sent`/assisted input is rejected until the interventions ledger + a
  non-comparable marker exist). `runtimeAuth: openai-env` declares the agent's
  runtime-auth channel — recorded as NAMES ONLY. On a live run, the engine
  resolves the registered terminal descriptor and requires
  `keyPlacement: in-sandbox-command-scoped` before creating a sandbox. The key
  is passed only to the agent command, never to `Sandbox.create` or metadata;
  a dry-run neither reads nor injects it;
- `scenario`: `mode: dry-run` (contract evidence, no spend) or `live`.
  `scenario.ref` is CONSUMED (and REQUIRED) on the scripted-browser route: it
  resolves a committed scenario (`humanish/scenarios/<ref>.yaml` or a repo
  path) whose `browser.steps` ARE what the actor executes, digest-pinned into
  bundle provenance; on other routes `ref`/`inline` stay forward-declared
  warnings. On the scripted route `live` gates real browser ACTUATION against
  the declared app — provider spend stays $0 by mechanism (no model runs);
- `scenario.caps` (terminal-product route): `{ maxUsd, maxJobs, maxMinutes }`,
  all non-negative numbers (0 = no-spend, the default). The blast-radius budget
  that bounds the in-sandbox live key by MECHANISM, not by hope — the live key
  is never exercised without a fail-closed cap in force. `maxMinutes` is the
  wall-clock kill; `maxUsd`/`maxJobs` are enforced fail-closed against the cost
  ledger (a run whose KNOWN spend exceeds the cap fails closed,
  `HUMANISH_TERMINAL_LAB_CAPS_EXCEEDED`). The no-spend proof is derived from that
  real ledger, never asserted (see Terminal Cost Ledger And No-Spend Proof).
  Inert (warned) on every other route;
- `policies`: `redactRepos`, `redactScreenshots`, `allowPublicTargets`, and the
  terminal-product credential-boundary booleans `allowPrivateRepoAccess`,
  `allowProviderCredentials`, `allowPaymentCredentials`, `allowGitHubMutation`
  (all DEFAULT FALSE — deny-by-default; only the runtime LLM key enters, and
  only command-scoped). The scripted-browser route is loopback-only and rejects
  `redactScreenshots: true` (blur unimplemented there) and
  `allowPublicTargets: true` fail-closed rather than ignoring them.
- `comms` (#297; hosted on the clone/local-tree computer-use lanes and the
  CONCURRENT shared-world getHost plane — warned inert everywhere else,
  including app-url/operator-provided subjects and the sequential
  `concurrency: 1` shared world, neither of which has a catch to host): off-app
  email/SMS the app itself SENDS, made a persona-driven testable surface.
  `comms.email` = `{ kind: fake, injectEnv?, port?, recipients?, linkOrigin?, external? }`.
  `injectEnv` is the ADOPTER-NAMED env var the app reads for its email-API base
  URL (e.g. `RESEND_API_URL`); the harness sets it to an in-sandbox catch (so it
  is NOT declared in `subject.env`) that captures the app's sends without touching
  the internet — verify the app actually reads that variable, because a run whose
  catch captured zero sends warns at teardown for exactly that. `kind` must be
  `fake` (`real`/provider-backed is rejected until implemented); `port` ≤ 65534
  (the catch reserves `port+1` for the read-only inbox listener the shared-world
  route getHost-exposes). `recipients[]` = `{ lane, address? }`: OMIT the list
  and the parser fills one deterministic address per lane
  (`<laneId>@example.test`) so every seat can do email (#351). When declared, a
  `lane` must be one of the lab's real lane ids (roster ids, or the generated
  `lane-01..lane-NN` under `count`) — an unknown lane is a hard parse error
  listing them, zero addressed lanes is a hard error, partial coverage warns
  with the uncovered lanes. Each addressed lane's actor prompt is extended with
  the full handoff: its address ("enter exactly that"), the inbox URL, and the
  wait steering ("waiting for an email is normal, not a blocker").
  `external` (#328) switches the funnel to an ADOPTER-HOSTED catch, which is what
  makes comms work on planes humanish does not provision (app-url /
  operator-provisioned): `{ catchBaseUrl, inboxBaseUrl?, authTokenEnv? }`. The
  operator runs the catch — `humanish comms catch` runs the same implementation
  humanish deploys in-sandbox, so the capture shape, inbox surface, and drain
  contract cannot drift between the two planes — and points their own app's
  email-API base URL at it. `injectEnv` is then absent and meaningless, since
  there is no subject env for humanish to inject. humanish keeps every other
  part: per-lane addresses, the injected inbox handoff, a fail-closed readiness
  probe before any actor spend (GET /health must return the
  `humanish-comms-catch` marker, so a proxy answering 200 for everything cannot
  pass for a catch), the teardown drain over `GET /deliveries`, and the same
  digest-only evidence. `authTokenEnv` names an env var holding a bearer token
  for the drain read — the NAME is recorded as evidence, the value never
  persists. Declaring `external` on a harness-provisioned subject warns: two
  catches would exist and the app would point at humanish's own. `linkOrigin`
  is an optional operator-declared origin the app bakes into links when it
  differs from the serve origin; the harness rewrites captured links through it
  so a clicked link resolves to a reachable host. Captured mail is drained into a
  digest-only `humanish.comms-thread.v1` artifact (from/to/subject/link DIGESTS +
  an OTP COUNT — no raw address/link/code persists); the READABLE proof a
  persona saw the email is its screenshots of the inbox page. Requires `python3`
  in the subject sandbox (the stock E2B desktop template has it).

Lab backends report results in their own schemas (`humanish.run-result.v1`,
`humanish.oss-lab-result.v1`, `humanish.oss-meta-lab-result.v1`,
`humanish.cua-lab-result.v2`, `humanish.scripted-lab-result.v1`,
`humanish.terminal-lab-result.v1`); the evidence record stays
`humanish.run-bundle.v1` in every case. The computer-use result bumped to v2 for
fan-out: it carries `plan` (the pre-flight lane table — concurrency, waves,
per-lane session budget, worst-case sandbox-minutes), `lanes[]` (ALWAYS present,
length 1 at N=1; per-lane status/session/sandbox/subject), and `laneSummary`
(passed/skipped/harnessError/hollow counts). The top-level `session`/`sandbox`
mirror the first lane and `subject.commit` is unanimity-gated across lanes
(omitted with a divergence warning when lanes resolve different commits). At N=1
the run bundle is byte-stable with the pre-fan-out output; only the result
projection changed. A fan-out run records a `cua-lab.fanout.plan` bundle event
(and a `cua-lab.fanout.fail-fast` event when a harness error skips queued lanes);
`ok = observer.ok ∧ no skipped lane ∧ all lanes terminal ∧ no harness error ∧ no
hollow lane`.

Explicit failed-lane reruns are supported on the CUA fan-out route via
`humanish lab run <lab> --rerun-failed-from <run-id> [--lanes lane-a,lane-b]`.
The source run must be a live CUA fan-out bundle. Humanish creates a NEW run for
the selected failed/blocked/timed-out/hollow lanes (or explicit lane ids), leaves
the source verdict unchanged, and records lineage as `run.rerun` plus a
`cua-lab.fanout.rerun` event: source run id, selected lane ids, and previous lane
statuses/reasons. This is intentionally not automatic retry; a passing rerun is a
nondeterminism candidate for human/product scoring, not a rewrite of the old run.

Manifests are human-authored `.yaml` source under `humanish/labs/*.yaml` for
committed public-safe labs, or ignored `.humanish/labs/*.yaml` /
`.humanish/local/labs/*.yaml` for private local dogfood. Fields the engine does
not yet consume are accepted but reported as warnings (`humanish lab inspect`
shows them), so a manifest never silently claims behavior that did not run.

Committed fixture (`humanish/labs/first-run.yaml`):

```yaml
schema: humanish.lab.v2
id: first-run
title: First-run synthetic Observer
description: Public-safe starter lab that generates a synthetic run bundle and Observer without provider spend.
subject:
  source: this-repo
actors:
  - type: synthetic-persona
    count: 4
scenario:
  mode: dry-run
defaults:
  open: true
```

## Run Bundle

Run bundles are the canonical evidence record. Observer data, review Markdown,
feedback drafts, and issue text are projections from the bundle.

Core-owned fields:

- `schema`
- `runId`
- `mode`
- `simCount`
- `createdAt`
- `artifactRoot`
- `source.git`
- `lifecycle`
- `simulations`
- `streams`
- `events`
- `redaction`
- `artifacts`
- `review`
- `feedbackCandidates`
- `lab` (optional, additive): which manifest produced the run —
  `{ id, path?, origin? }`, where `origin` is `committed` (humanish/labs),
  `ignored` (a local overlay), or `explicit` (a path the operator passed).
  Absent on bundles written before this contract and on library callers who
  hand a `LabConfig` directly — the run is then honestly lab-less rather than
  guessed. Readers wanting attribution for an older bundle may fall back to
  `inferLegacyLabId`, which reads only the historical
  `persona.source = "lab:<id>"` convention and nothing else.
- `subject` (optional, additive): structured subject provenance —
  `{ source: clone | app-url | local-tree, repo?, commit?, archiveSha256?,
  dirty?, envNames?, state }` where `state` is `{ provenance: seeded |
  unpinned | declared-not-run | undeclared, seed?: [{ name, when,
  commandDigest, ok?, exitCode?, timedOut?, durationMs? }], externalEnvNames?
  }`. Emitted by the computer-use backend; absent on pre-existing and other
  backends' bundles. `repo`/`commit` are clone-route fields; `archiveSha256`
  (64-hex sha256, the local-tree provenance pin) and `dirty` (host git
  porcelain status at pack time) are local-tree-route fields, additive under
  `humanish.run-bundle.v1`: a dirty working tree cannot be commit-pinned, so
  the archive content digest stands in for it. `commandDigest` is the
  sha256-16 of the exact seed command — command text and env values never
  appear. `humanish verify` fails closed when a LIVE `local-tree` bundle carries
  no well-formed `archiveSha256`, in addition to the existing `subject state
  provenance` check.
- `desktopTemplate` (optional, additive): the custom E2B desktop TEMPLATE (image)
  the run's sandbox(es) launched on, from `execution.desktop.template` — so the
  evidence shows WHICH image ran. Present only when a template was configured;
  absent == the stock `desktop` template, so every pre-existing bundle is
  byte-stable. Public-safe (a template name is not a secret).
- `attributionClass` (optional, additive): `isolated | shared-world`. Absent ==
  `isolated`, so every existing bundle is byte-stable. The interaction-attribution
  honesty axis (#164) — ORTHOGONAL to the persona-sampling evidence classes. Set
  to `shared-world` by the shared-world backend, paired with `sharedWorld`.
- `sharedWorld` (optional, additive): the shared-world evidence block
  (`humanish.shared-world.v1`) — see [Shared-World Evidence](#shared-world-evidence)
  below. Present only on shared-world runs; verified fail-closed by the
  `shared-world evidence` check in `humanish verify`.

Adapter-owned fields:

- `source.packageName`
- `source.humanishSource`
- `persona`
- `scenario`
- target-specific stream labels and public-safe summaries

Synthetic fixture:

```yaml
schema: humanish.run-bundle.v1
runId: synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
mode: dry-run
simCount: 1
createdAt: "2026-06-02T10:00:00.000Z"
artifactRoot: .humanish/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
source:
  packageName: fixture-app
  humanishSource: present
  git:
    schema: humanish.git-state.v1
    status: clean
    capturedAt: "2026-06-02T10:00:00.000Z"
    head:
      shortSha: null
      refState: unknown
    changes:
      staged: 0
      unstaged: 0
      untracked: 0
      total: 0
    note: public-safe synthetic fixture
persona:
  id: synthetic-maintainer
  name: Synthetic Maintainer
  source: humanish/personas/synthetic-maintainer.yaml
  sourceDigest: synthetic
scenario:
  id: first-run-smoke
  title: First-run smoke
  goal: Prove setup and verification without private data.
  source: humanish/scenarios/first-run-smoke.yaml
  sourceDigest: synthetic
lifecycle:
  - at: "2026-06-02T10:00:00.000Z"
    event: run.created
    message: Created synthetic contract fixture.
redaction:
  status: passed
  notes: Synthetic fixture only.
artifacts:
  run: run.json
  reviewJson: review.json
  reviewMarkdown: review.md
  observerData: observer/observer-data.json
  events: events.ndjson
review:
  schema: humanish.review.v1
  verdict: contract_proof_only
  summary: Synthetic contract fixture generated.
  gaps: []
feedbackCandidates: []
```

## Shared-World Evidence

The shared-world topology (#164) is the DECLARED override of the per-lane-worlds
default: N distinct actor ROLES drive ONE provisioned, mutable service plane (one
app + one seeded DB) so their actions interact through shared state. The ONE
subject plane is provisioned via `subject.source: clone` (a fresh `git clone`) or
`subject.source: local-tree` (the operator's own working tree, packed on the host
and provisioned in-sandbox in place of a clone - see `subject.localTree` above);
both sources are accepted on the sequential AND concurrent shared-world routes. A
shared-world bundle adds TWO additive, optional fields to `humanish.run-bundle.v1`
(absent on every other bundle, so they stay byte-stable):

- `attributionClass: isolated | shared-world` — a new, ORTHOGONAL honesty axis
  ("how well did the run attribute INTERACTION?"), distinct from the persona-sampling
  evidence classes ("how representative is the actor?"). Absent == `isolated`.
- `sharedWorld` (`humanish.shared-world.v1`): TWO variants discriminated by
  `topologyMode: "sequential" | "concurrent"` (validateSharedWorldEvidence branches on
  it FIRST; unknown/missing or a mismatched shape fails closed). Common fields:
  - `topology: shared-world`
  - `topologyMode: sequential | concurrent`
  - `roleCount` — the DECLARED number of role/persona seats.
  - `plane: { commit?, seedDigest, envNames, hostDigest?, exposure?, publicOriginDigest? }` — the ONE
    shared-plane provenance. `seedDigest` is the sha256-16 of the ordered seed-step
    command digests (the seed RECIPE identity, not the runtime state); `envNames` are
    NAMES only. `hostDigest`/`exposure` are CONCURRENT provisioned-getHost-only, and
    `publicOriginDigest` is CONCURRENT external-public-only (below).
  - `planeClass?: provisioned-getHost | external-public` and `lobbyConvergenceDigest?` are
    CONCURRENT-only (below); both absent on the sequential shape.
  - `attributionLimits: [...]` — the verify-enforced attribution ceiling (the set
    differs per `topologyMode`, below).

  SEQUENTIAL shape (`topologyMode: sequential`, #164 PR1):
  - `sequence: [roleId, …]` — the role ids that actually took a turn, in declared order.
  - `timeline: (checkpoint | turn)[]` — a harness-clocked, strictly alternating
    timeline that starts `cp-baseline`, alternates checkpoint → turn → checkpoint,
    and ends on a checkpoint:
    - checkpoint = `{ kind: checkpoint, name, digest, deltaFromPrev }` — `digest` is
      sha256-16(scrub+redact(probe stdout)); the record is DIGEST-ONLY (no
      value-shaped field). `deltaFromPrev` is true when the observed state changed
      across the intervening turn.
    - turn = `{ kind: turn, roleId, simId, streamId, commit?, seedDigest }` — references
      a real RunSimulation/RunStream; carries the plane provenance it observed
      (identical across turns by construction — the single-plane proof).
  - Sequential `attributionLimits` MUST contain `sequential-only`, `no-concurrent-races`,
    and `delta-attributed-to-turn-not-action`.

  CONCURRENT shape (`topologyMode: concurrent`, #164 phase 2 — N personas drive ONE
  getHost-exposed plane AT ONCE; NO `timeline`/`sequence`):
  - `plane.hostDigest` — sha256-16 of the harness-minted `getHost` ORIGIN every actor
    drove (a first-class provisioned-subject target — invariant 2). A DIGEST, not the raw
    URL: a getHost URL embeds the live sandbox id and matches the publish-safety e2b-URL
    redaction, so it never lands raw in a published bundle (the raw tokenless URL is
    surfaced only on the ephemeral lab result). The orchestrator confirms the URL is
    TOKENLESS (no authKey — invariant 1) before digesting.
  - `plane.exposure: synthetic` — the REQUIRED author attestation that the subject behind
    the internet-reachable getHost URL is synthetic seeded data (author-trust + a
    provenance gate, NOT a no-real-data guarantee).
  - `laneWindows: [{ roleId, simId, streamId, startedAt, endedAt, verdict, routeHostDigest,
    commit?, seedDigest }]` — one harness-clocked window per actor; OVERLAPPING windows
    prove ≥2 personas were active simultaneously. `routeHostDigest` == `plane.hostDigest`
    (every actor drove exactly the harness-minted host).
  - `stateSeries: [{ timestamp, digest }]` — cadence digests of the shared world under
    load (baseline + periodic + final). DIGEST-ONLY: the allowed-keys tripwire permits
    ONLY `timestamp` + `digest` (no per-delta→actor field — causation under concurrency is
    structurally inexpressible).
  - `outcomes: [{ roleId, simId, streamId, status, completionReason?, ok }]` — per-persona
    OUTCOME (the "M of N succeeded" headline).
  - Concurrent `attributionLimits` MUST contain `concurrent`,
    `best-effort-causal-attribution`, `non-deterministic-shared-state`,
    `window-and-snapshot-granularity`, `contention-observed-not-proven-safe`,
    `state-change-not-isolated-to-actors`, and MUST NOT contain `sequential-only` or
    `no-concurrent-races` (a sequential guarantee on a concurrent run is an overclaim).

The `shared-world evidence` check in `humanish verify` is fail-closed (live runs only;
dry-run contract bundles are skipped). It dispatches on `topologyMode` FIRST.
SEQUENTIAL: the timeline must be well-formed (start `cp-baseline`, strictly alternate,
end on a checkpoint, turn order == sequence, sequence length == roleCount == turn
count, no `laneWindows`); every turn's simId/streamId resolves; every checkpoint digest
is sha256-16 with NO value-shaped field; all turns share ONE plane provenance; the
mandatory limits are present; and a PASSED run shows ≥1 checkpoint `deltaFromPrev` (the
delta-on-pass gate). CONCURRENT: no `timeline`; laneWindows + stateSeries + outcomes
cover exactly roleCount; the required limits are present AND the forbidden ones absent;
`plane.hostDigest` present and every `routeHostDigest` equals it (invariant 2);
`plane.exposure == synthetic` AND `subject.state.provenance == seeded` (the
synthetic-subject gate); stateSeries snapshots are digest-only (allowed-keys tripwire);
all laneWindows share ONE plane provenance; and the CONCURRENCY-ON-PASS gate — a PASSED
run MUST show ≥2 overlapping laneWindows AND a stateSeries delta whose timestamp is
AT/AFTER an overlap interval start (otherwise it was not actually concurrent, or the
world never changed under load). The per-role no-engagement guard applies to both.
Checkpoints / stateSeries persist digest-only by DEFAULT until the #108 PII/PHI
detector lands.

WHAT THE BUNDLE CAN / CANNOT CLAIM. SEQUENTIAL: each role's own behavior at full
fidelity; the OBSERVED system outcome as an ordered DIGEST sequence; and the
SEQUENCED-INTERACTION proof (role B entered a world already containing role A's mutation
— the checkpoint after A strictly precedes B's turn). It CANNOT claim action-granular
causation, concurrency/races (sequential-only), or exact-state determinism. CONCURRENT:
each persona's own behavior at full fidelity; per-persona OUTCOME against the contended
world ("M of N"); PROVEN CONCURRENCY (overlapping windows); and system-state evolution
under load (the stateSeries) with best-effort temporal correlation. It CANNOT claim
strict causal attribution of a delta to an actor (concurrent ⇒ ambiguous), determinism
of exact state, per-action granularity, or concurrency-SAFETY (races are OBSERVED, never
PROVEN absent). HONESTY: the deterministic $0 gate proves the plumbing + the
attribution contract. A kept 2026-06-17 live receipt separately proves one
bounded three-persona trial against a synthetic plane. Neither the deterministic
gate nor that receipt proves scale, repeatability, or adopter-harness replacement.

### Concurrent plane classes: provisioned-getHost vs external-public (#164 phase 2, 0.20.0)

The CONCURRENT shape carries a PLANE-class discriminator, `sharedWorld.planeClass:
"provisioned-getHost" | "external-public"`. Absent == `provisioned-getHost` (every existing
concurrent bundle byte-stable). It gates EVERY getHost-specific verify assertion, so a getHost
claim can never leak onto the external-public class (or vice versa).

- `provisioned-getHost` — the historical plane described above: a `clone`/`local-tree` subject the
  harness serves + getHost-exposes in-sandbox. The harness MINTED the host, so it asserts the
  synthetic-seeded attestation (`plane.exposure: synthetic` + `subject.state.provenance == seeded`),
  the harness-minted host identity (`plane.hostDigest`, every `routeHostDigest == it`), and an
  authoritative in-sandbox checkpoint `stateSeries` with a delta-on-pass.

- `external-public` — a real, operator-OWNED public deployment used DIRECTLY as the shared plane
  (`subject.source: app-url` + `topology: shared-world` + `policies.allowPublicTargets: true` +
  `execution.concurrency > 1`). NO getHost, NO clone, NO subject sandbox, NO seed. The subject
  carries the ownership attestation `subject.publicTarget: { owner, authorized: true }` (the honest
  analog of `exposure: synthetic` — you cannot attest synthetic on a real site, but you MUST attest
  you own/operate it; author-trust, unverifiable by the harness). Evidence deltas, all
  asserted-absent (never silently dropped):
  - `plane.publicOriginDigest` — sha256-16 of the operator-DECLARED origin. Every
    `laneWindow.routeHostDigest` (computed from that seat's CDP-OBSERVED final-URL origin) equals it.
    This proves inter-seat CONVERGENCE on one declared origin, NOT harness control of the plane
    (WEAKER than getHost's `hostDigest`, and disclosed).
  - `plane.exposure` is ABSENT (verify fails closed if `synthetic` appears — a lie on a real site);
    `plane.hostDigest` is ABSENT (the harness minted no host).
  - `subject.state.provenance == "external-public"` — NOT `seeded`, NOT `unpinned`, NOT `undeclared`.
  - `stateSeries` is OMITTED (Option A): no in-sandbox filesystem to authoritatively digest, so there
    is NO authoritative shared-state proof. Concurrency-on-pass is RELAXED to temporal co-occupancy
    ONLY (≥2 overlapping `laneWindows`); there is no state-delta requirement.
  - `lobbyConvergenceDigest` (optional, strong, cheap) — sha256-16 of the shared `/lobby/CODE` PATH
    all seats' CDP URLs converged on; present only when every seat converged on ONE code. Digest-only
    (the raw 6-char code and full URLs are runtime-only and never land).
  - `attributionLimits` MUST contain the concurrent family PLUS `external-public-plane`,
    `operator-attested-target-not-harness-controlled`, `no-synthetic-attestation`,
    `no-authoritative-shared-state-proof`, `concurrency-by-temporal-co-occupancy-only`; and MUST NOT
    contain `sequential-only`, `no-concurrent-races`, or any `seeded`/`synthetic` limit.

The getHost synthetic gate is deliberately NOT reachable from the app-url branch, and why: that gate
exists because getHost is internet-reachable AND harness-owned (real data behind a harness-exposed
URL is the hazard). A public site the harness neither provisioned nor exposed has neither property,
so the gate's hazard does not exist there. Attribution stays `shared-world` (N seats, ONE plane); the
plane-control claim degrades from "harness-controlled" to "operator-attested, observed-only".

## Adapter

Adapters describe target-specific affordances without changing core contracts.

Core-owned fields:

- `schema`
- `id`
- normalized route/reference shape
- public-safety validation of adapter references

Adapter-owned fields:

- `name`
- `routes`
- route descriptions
- target-specific commands, paths, milestones, and vocabulary

Synthetic fixture:

```yaml
schema: humanish.adapter.v1
id: synthetic-cli-adapter
name: Synthetic CLI Adapter
routes:
  - id: help
    path: synthetic-cli --help
    description: Public-safe command discovery.
  - id: dry-run
    path: synthetic-cli run --dry-run --json
    description: Generate a synthetic run bundle.
```

## Persona And Scenario

Personas and scenarios define trial intent. They are adapter-owned source
documents that core copies into run bundles by digest and id.

Core-owned fields:

- schema naming rules
- id/source/sourceDigest references inside run bundles
- redaction gates before persona/scenario text can appear in public feedback

Adapter-owned fields:

- persona traits
- scenario goals
- steps and expectations
- accessibility or workflow constraints

Synthetic fixture:

```yaml
persona:
  schema: humanish.persona.v1
  id: synthetic-maintainer
  name: Synthetic Maintainer
  summary: Privacy-safe maintainer evaluating first-run clarity.
  constraints:
    - Do not use real personal data.
    - Treat credentials as env var names only.
scenario:
  schema: humanish.scenario.v1
  id: first-run-smoke
  title: First-run smoke
  persona: synthetic-maintainer
  goal: Prove setup, dry-run evidence, verification, and feedback drafting.
  mode: dry-run
  steps:
    - name: Inspect help
      expectation: Help explains setup and verification commands.
    - name: Verify bundle
      expectation: Verification passes without private data.
```

## Actor Trace

Actors execute or simulate the trial. Actor evidence is the provider-neutral
`humanish.actor-trace.v1` (`src/actor-contract.ts`): Codex app-server items,
Claude Agent SDK blocks, pi events, computer-use cycles, scripted browser
steps, and in-sandbox terminal-agent exec output all map onto one `ActorTrace`.
Registered actors live in
`src/actor-registry.ts` (`codex-app-server`, `pi-agent-core`,
`claude-agent-sdk`, `openai-computer-use`, `scripted-browser`, `codex-exec`).
There is no `humanish.actor.v1`; that name never shipped.

Core-owned fields:

- `schema`
- `provider` / `providerVersion`
- `protocol` (`json-rpc` | `json-stream` | `in-process-sdk` | `cua-loop` |
  `scripted-steps` | `terminal-exec`)
- `lane` (`code` | `app` | `computer-use` | `scripted-browser` | `terminal`)
- `persona` (`id`, `traitsApplied`, `promptDigest`)
- `capabilities.keyPlacement` (`external` | `in-sandbox-command-scoped`): WHERE
  the actor's runtime key lives — registry metadata the engine enforces. The
  terminal agent declares `in-sandbox-command-scoped` (the agent-under-test runs
  inside the sandbox); every other actor is `external` (absent === external).
- `redaction` (`status`, `screenshots: n/a|raw|blurred|ocr_scrubbed`, `notes`)
- `startedAt` / `completedAt` / `durationMs`
- `status` / `completionReason` / `reason` (`completionReason` includes
  `step_failed`: a deterministic scripted step/expectation evaluated false —
  the subject failed the script while the harness executed faithfully; and
  `budget_reached`: a computer-use session stopped by its time or estimated
  spend budget, or an explicit provider token limit — status `incomplete`.
  The `reason` distinguishes these causes; none establishes that the goal was
  reached. `timed_out` remains the zero-progress wall-clock deadline outcome)
- `ids`, `counts`, `items[]`, optional `tokenUsage`, `capabilities`. `tokenUsage`
  may carry `cacheWriteInput` (tokens billed at the provider's cache-write rate,
  OpenAI 5.6+) and `turns[]` (per provider-request usage, the recorded fact
  long-context tier pricing needs) — both additive and honestly absent on
  producers that do not report them (#334). Items may
  carry `at` (ISO-8601 recording stamp from the loop's clock) and, on
  click-like `ui_action` items, structured `coord` (`x`/`y`) — both additive
  (#441): absent on older bundles and non-stamping producers, and absence means
  "timing/position unrecorded", never zero
- optional `modelSettings` (`humanish.model-settings.v1`, #497): HOW the model was
  asked to run, alongside `ids.model` which says which model it was.
  `reasoningEffort` records the value the request ACTUALLY carried,
  including the provider default when a lab declared nothing — the resolved
  value is what produced the trace, so reporting it is honest where reporting
  "unset" would not be. Absent when a provider declares no settings and on every
  pre-existing bundle; tolerated by verify. It exists because effort was
  unreachable from a lab, which made every run take the default silently. Effort
  is part of WHO the participant was rather than of how the instrument was tuned
  (docs/principles/actor-fidelity.md), so a trace without it is a result missing
  half its sample description
- optional `modelSettings.maxOutputTokens`: the declared positive integer
  `actors[0].maxOutputTokens`, passed to every first-party OpenAI CUA response
  request, including reasoning output. Absent when undeclared, with no default
  change. Closing reports use `min(maxOutputTokens, 1024)`. Unsupported routes,
  custom provider/session hooks, and per-lane overrides fail before allocation.
  This is an output-token limit, not an input-token, request-count or billing cap.
- optional `affordanceUse` (`humanish.affordance-use.v1`): which KIND of route this
  actor took (see Affordance Use below)
- optional `estimatedCost` (`humanish.actor-estimated-cost.v1`): a token-derived
  cost ESTIMATE for this lane (see Run Cost Summary And Estimated Actor Cost).
  It is deliberately a DIFFERENT field from `tokenUsage.costUsd`: a bare
  `costUsd` is RESERVED for a real provider-returned charge, while
  `estimatedCost.estimatedCostUsd` is a rate-table multiply, named honestly as
  an estimate so a reader can never confuse the two (invariant 6). Absent on
  codex/scripted lanes and on every pre-existing bundle; a `null`
  `estimatedCostUsd` is DECLARED ABSENT (unknown rate / no usage), never 0.

Unexpected actor-loop diagnostics live inside `items[]` as
`kind: notice`, `status: error` rows. They are public-safe evidence, not crash
dumps: redacted message, coarse phase, optional error name, last normalized UI
action, and last screenshot reference. They must not carry raw stacks, env
values, target URLs, or unredacted provider payloads.

Adapter-owned fields:

- the prompt, mission, persona text, and lane focus that produced the trace
- product-specific acceptance notes

Synthetic fixture (abridged; see `src/actor-contract.ts` for the full type):

```yaml
schema: humanish.actor-trace.v1
provider: codex-app-server
protocol: json-rpc
lane: code
persona:
  id: synthetic-maintainer
  traitsApplied: []
  promptDigest: synthetic
redaction:
  status: passed
  screenshots: n/a
  notes: Synthetic fixture only.
startedAt: "2026-06-02T10:00:00.000Z"
completedAt: "2026-06-02T10:00:01.000Z"
durationMs: 1000
status: passed
completionReason: turn_completed
reason: Synthetic dry-run fixture completed.
ids: {}
counts: {}
items: []
```

## Substrate

Reserved: `humanish.substrate.v1` is named here for layering intent but has
never shipped — no code emits or validates it. Substrate truth today lives
inside run bundles (per-stream transport and status) and lab execution config
(`execution.target: local | e2b-desktop`). Do not emit this schema.

## Serve Result And Reserved Control-Plane Namespace

`humanish serve` reports `humanish.serve-result.v1`. The exported `ServeResult`
type and `SERVE_SCHEMA` constant in `src/observer-serve.ts` are authoritative:
mode (`loopback | exposed | share-safe-open`), the loopback host/port,
`publicUrl`, the `tunnel` provider/url, an `oauth` echo (`provider`,
`allowEmails`, `allowDomains` — operator-supplied allow rules, public-safe to
echo to the operator's own stdout, never persisted into any bundle), runs
listed, computed warnings, and the `ServeErrorCode` union. Exposure auth is
tunnel-edge only — as of 0.20.0 there are no `capabilityUrl`/`publicCapabilityUrl`
/`ttlMinutes` fields, no `--auth`/`--ttl` flags, and no `capability-link` mode
(the in-process `observer-auth.ts` capability-link was removed as a pre-1.0
breaking change).

Reserved: `/_humanish/api/*` is the serve control-plane namespace. Any request
under it answers `501` with error code `HUMANISH_SERVE_CONTROL_PLANE_DISABLED`.
Because the in-process auth gate is gone, a request that clears the edge (or a
loopback caller) reaches the `501` directly — there is no `401`-first anymore.
The typed `ServeControlPlane` parameter exists in the handler options and is
always `undefined` in v1; no code dispatches into it yet. Do not build against
the namespace; the reservation guarantees only that no run artifact or observer
asset will ever be served under it. See
[`docs/architecture/serve.md`](../architecture/serve.md) for the v2 seam
contract.

## Terminal Cost Ledger And No-Spend Proof

The terminal-product lane (`src/e2b-terminal-lab.ts`) passes a real provider key
only to the in-sandbox agent command, never to sandbox-global env or metadata,
so the no-spend claim must be REAL — derived from a ledger, never asserted. The
live run writes both to `terminal-ledgers.json` (a `cost` block + a
`noSpendProof` block, additive to `humanish.terminal-ledgers.v1`).

The cost ledger (`humanish.terminal-cost-ledger.v1`) has one line per category —
`product`, `media`, `payment`, `provider` — and follows a strict **null
discipline** that distinguishes three states and never conflates them:

- `usd: 0` — **known zero**: the category was metered and billed nothing.
- `usd: null` — **not measured**: no spend signal exists for the category on
  this run. `null` is written explicitly (never `undefined`-omitted, never guessed
  to `0`). A line with `null` says "this category exists but we did not measure
  it"; the no-spend proof reports it as unmeasured and does NOT claim it is zero.
- line **absent** — **not applicable** (n/a) to the lane/run.

`knownTotalUsd` sums ONLY the non-null lines (a `null` line contributes nothing
and is never coerced to `0`); `fullyMeasured` is true only when no line is null.
Core meters only the `provider` line, populated from the actor trace's
`tokenUsage.costUsd` when present (else `null`); `product`/`media`/`payment`
remain `null` unless an adapter supplies those signals through the shipped
cost-probe seam.

```yaml
schema: humanish.terminal-cost-ledger.v1
currency: usd
lines:
  product: { usd: null, count: null, source: unmeasured, note: "…no signal yet…" }
  media: { usd: null, count: null, source: unmeasured, note: "…no signal yet…" }
  payment: { usd: null, count: null, source: unmeasured, note: "…no signal yet…" }
  provider: { usd: null, source: unmeasured, note: "…no tokenUsage.costUsd this run…" }
knownTotalUsd: 0
fullyMeasured: false
```

The no-spend proof (`humanish.terminal-no-spend-proof.v1`) is DERIVED from the
ledger. It vouches only for what it measured: `knownZeroLines` (proven zero),
`knownNonZeroLines` (break `satisfied`), and `unmeasuredLines` (the `null` lines
it explicitly CANNOT vouch for). `satisfied` is true only when every KNOWN line
is within `maxUsd` (for a no-spend run, `maxUsd: 0` ⇒ every known line is `0`);
unmeasured lines never make it satisfied. A proof never claims zero on a `null`
line — verification fails closed if it does.

```yaml
schema: humanish.terminal-no-spend-proof.v1
maxUsd: 0
satisfied: true
knownZeroLines: []
knownNonZeroLines: []
unmeasuredLines: [product, media, payment, provider]
knownTotalUsd: 0
statement: "No-spend proof SATISFIED for maxUsd=0: every MEASURED spend line is zero…"
```

**Full caps enforcement (fail-closed, not advisory).** `scenario.caps.maxUsd`
is enforced against the ledger: if the observed KNOWN spend exceeds `maxUsd`, the
run fails closed (`HUMANISH_TERMINAL_LAB_CAPS_EXCEEDED`); `maxJobs` likewise when
a known job count is present; `maxMinutes` is the wall-clock kill (unchanged).
Unknowns (`null`) never trip a cap (we cannot claim a violation we did not
measure) and never grant a green pass (they surface as unmeasured). `verifyRun`
fails closed when a live bundle lacks the cost ledger or no-spend proof, when the
proof claims zero on a `null` line, or when known spend exceeds the declared cap.

## Run Status (identity + liveness index)

`humanish.run-status.v1` — `status.json`, written inside each run directory by
every backend at run start, refreshed on a fixed cadence while the run is
alive, and finalized when it ends: `{ schema, runId, state: running |
finished, mode, lab?, pid, startedAt, updatedAt, completedAt?, outcome? }`.

It answers two questions the filesystem could not answer before: **which lab**
a run belongs to, and **whether it is still alive** — including for runs an
agent launched (`lab run --json`) or that were detached, which previously wrote
nothing at all until they completed.

It is a DERIVED INDEX, not evidence. `run.json` remains the evidence-of-record;
`verify` never gates on `status.json`, nothing in it is a claim about what a
participant did, and when the two disagree the bundle wins and the record is
rebuildable from it. A `running` record whose `updatedAt` is older than three
touch intervals is INTERRUPTED, not alive — a dropped connection or a killed
terminal leaves exactly that shape, and reading it as interrupted is the honest
outcome (`classifyRunStatus` is the one shared definition). Fields are
public-safe by construction: no hostname and no user paths, because a run
directory may be shared.

## Run Index, Run Detail, And The Terminal Surface (#455)

Three derived projections that exist so a surface can list, classify and watch
runs without opening evidence for all of them. None is authoritative: `run.json`
remains the evidence-of-record, `verify` gates on none of these, and nothing in
them is a claim about what a participant did.

`humanish.run-index.v1` — the listing projection. One entry per run, read
cheapest-source-first: the `status.json` record, else the bundle, else the run
directory alone. `{ runId, derivedFrom: status | bundle | directory, liveness,
mode?, pid?, lab?, startedAt?, updatedAt?, completedAt?, verdict?,
participants?, estimatedCostUsd?, durationMs? }`. The point is cost: walking
every run tree and parsing every bundle measured 167ms on a 25-run project,
against 16ms cold and 2.8ms warm here, which is what makes a surface that
refreshes on a cadence affordable. `derivedFrom` is reported so a surprising row
can be traced to the file it came from. A run with receipts and no outcome is
`interrupted` — the shape a dropped connection leaves — and so is an
IN-PROGRESS bundle reached without a status record, because there is no
freshness to judge and "it started and nothing here says it finished" is the
honest reading.

`humanish.run-detail.v1` — the watching projection, for ONE run. Who is in it
and what they are thinking: `{ runId, participants: [{ id, label, personaId?,
traits, status?, completionReason?, thought?, turns?, actions?, thoughts?,
estimatedCostUsd? }], observerPath? }`. It reads the actor trace from
`stream.liveActor` while a run is in flight and `stream.actor` once it has
finished, preferring the live one, so a single screen renders a run the whole
way through. A reasoning item still being written is skipped rather than quoted
half-finished, and the text is carried verbatim — a surface may wrap it, nothing
paraphrases it. Unlike the index this DOES open the bundle, which is affordable
only because it is asked for the one run being watched.

`humanish.tui-result.v1` — what `humanish tui` emits when it refuses:
`{ schema, ok: false, error: { code, message } }` with `HUMANISH_TUI_REQUIRES_TTY`,
`HUMANISH_TUI_AGENT_SESSION`, `HUMANISH_TUI_UNSUPPORTED_NODE`, or
`HUMANISH_TUI_BUNDLE_MISSING`. `HUMANISH_TUI_AGENT_SESSION` is the one a TTY
check could not catch: `codex exec` allocates a PTY for the commands it runs, so
both streams are terminals and the surface used to open — a study watched an
agent navigate the labs list and start a run it did not mean to start
(labs/handed-a-human-surface.yaml). The refusal names the environment variable
that identified the runner, so the reader can check the claim, and `--force` is
the escape for a person who really is at that keyboard. Every other
command is built for an agent to drive; this one takes the screen and waits for
a person, so a non-interactive stdin or stdout fails closed naming the commands
that DO answer the question rather than rendering escape codes into a pipe.

## Run Cost Summary And Estimated Actor Cost

The computer-use (CUA) lane surfaces an ADVISORY, additive cost ESTIMATE. It is
never authoritative: every dollar figure is a rate-table multiply, labeled
"estimated (rates as of `<date>`)", and is NEVER presented as a provider charge
(invariant 6). Three new `.v1` schema tags ship, all additive and optional so
`humanish.run-bundle.v1` stays v1 and every pre-existing bundle is byte-stable:

- `humanish.pricing.v1` — the OPERATOR-EDITABLE rate table in `src/pricing.ts`:
  dated per-model input/output USD-per-token rates and E2B CPU/GiB-second
  rates, each with a public pricing-page `source` and an `asOf`
  date. A prominent banner says these are estimates to update when providers
  change pricing. Model rates may carry a `cacheWriteUsdPerToken` (OpenAI 5.6+
  bills cache writes at 1.25x input as the total rate for written tokens) and a
  `longContext` tier (a per-request input threshold that re-prices the whole
  request; priced exactly only from the trace's per-request `turns` ledger —
  totals alone never re-tier, which is the under-estimate direction). Some
  entries are `placeholder: true` stand-ins (the legacy desktop helper's
  8-vCPU/8-GiB planning assumption) — an operator MUST confirm them before trusting
  the magnitude; the flag propagates into every estimate so a stand-in is never
  mistaken for a live rate. An UNKNOWN model/desktop rate is DECLARED ABSENT
  (`estimatedCostUsd: null` + a `reason`), never guessed.
- `humanish.actor-estimated-cost.v1` — `ActorTrace.estimatedCost`: one lane's
  token-derived model cost, with `estimatedCostUsd` (or `null` + `reason`
  `no_rate_for_model`/`no_token_usage`), `ratesAsOf`, `source`, `modelId`,
  optional `placeholder`, and a `breakdown`.
- `humanish.run-cost-summary.v1` — `RunBundle.cost`: the sum of every lane's
  `model-tokens` lines PLUS `desktop-minutes` lines. New independent CUA runs
  price each owned desktop separately; older single aggregate lines remain readable.
  A desktop line's optional `desktop` object records `minutes`,
  `durationBasis: host-acquired-to-cleanup`, observed `resources` (`cpuCount`,
  `memoryMiB`), `resourceSource: e2b.getInfo`, and `usdPerSecond` when priceable.
  Failed metadata reads record `resourceUnavailableReason`; no resource guess is used.
  Resource metadata and missing/unsupported rates produce a null line. A kept or
  unconfirmed allocation adds `desktop_lifetime_incomplete` as a second null line.

The summary follows the SAME null discipline as the terminal cost ledger above.
`estimatedTotalUsd` sums ONLY the non-null `breakdown` lines and is `null` iff
EVERY line is null (never coerced to `0`); a present-but-unpriceable line stays
in `breakdown` with `estimatedCostUsd: null` + a `reason` (it records that we
tried and could not price it) and contributes nothing. `fullyEstimated` is
`false` when any applicable line is null (the total is then a lower bound);
`placeholder` is true when any contributing rate is a stand-in; `ratesAsOf` is
the MIN (oldest) `asOf` across contributing rates — an aggregate is only as fresh
as its stalest input, so MAX would overclaim freshness (each `breakdown` line
keeps its own true `asOf`). `desktopMinutes` is a HOST-SIDE
acquired-handle→cleanup span, excluding allocation/startup before handle acquisition.
It approximates E2B's server-side billed lifetime. Plan fees, credits, and negotiated
prices are excluded; unknown remaining lifetime makes `fullyEstimated` false.
Shared-world, scripted-browser, and terminal routes do not yet emit these desktop lines.

```yaml
schema: humanish.run-cost-summary.v1
currency: usd
estimatedTotalUsd: 11.60167          # sum of KNOWN lines only; null iff every line null
ratesAsOf: "2026-08-01"
fullyEstimated: true                  # both breakdown lines are priced (no null line)
placeholder: true                     # a stand-in rate contributed
breakdown:
  - { kind: model-tokens, laneId: lane-01, modelId: computer-use-preview,
      estimatedCostUsd: 11.60, ratesAsOf: "2026-08-01", source: "openai.com/api/pricing" }
  - { kind: desktop-minutes, estimatedCostUsd: 0.00167, ratesAsOf: "2026-08-01",
      source: "…e2b.dev/pricing", placeholder: true }
tokenUsage: { input: 3843523, output: 5869, total: 3849392 }
desktopMinutes: 1
note: "Estimated 11.60167 USD total…"
```

`verifyRun` asserts LABELING/provenance, never MAGNITUDE. Absence PASSES
(fail-open on display): a bundle with no cost, a null estimate, or a lane without
`estimatedCost` verifies fine. A CLAIMED number FAILS closed when it lacks its
`ratesAsOf` date or `source`, or when `estimatedTotalUsd` does not equal the
rounded sum of its non-null lines (a null line coerced to 0 is a mechanism
mismatch). A correctly-labeled huge estimate still passes. Cost is neither a
secret nor a share-blocker, so it never affects `shareSafety`.

**Computer-use spend thresholds.** `execution.caps.maxUsd` applies independently
to each lane. `execution.caps.maxTotalUsd` shares an estimated model-spend ledger
across the study's lanes. Either, both, or neither may be declared. Without a
shared threshold, N lanes each have their own `maxUsd`; N × `maxUsd` is the sum
of those thresholds, not a guaranteed total spending ceiling.

The loop checks reported usage after a model response, before dispatching that
response's actions or requesting another turn. It does not reserve the next
request's worst-case cost. In-flight requests, retries, concurrent lanes, and
unreported usage can exceed or escape these estimates. These thresholds are
not hard provider billing caps and exclude desktop and target-app charges.

A lane with material progress that crosses `maxUsd` ends `budget_reached` /
`incomplete`; the existing zero-action guard ends `gave_up` / `abandoned`.
Crossing the shared study threshold ends `budget_reached` / `incomplete`, with
sibling lanes stopping when their next post-response check sees it. Reaching a
threshold is not proof of task completion.

An absent threshold is uncapped. A zero threshold can still permit a paid model
request before reported usage trips it; `maxUsd: 0` is not a no-provider-call
mode. Use the keyless `humanish run first-run` preview or an explicit
`humanish lab run <lab> --dry-run` for a path without provider calls. A declared
threshold on a model `src/pricing.ts` cannot price is refused at preflight
(`HUMANISH_CUA_LAB_UNPRICED_CAP`) before sandbox allocation. This rate-availability
check is separate from the post-response spend check.

These computer-use rules do not replace the terminal route's separate
`scenario.caps` cost-ledger and product-spend rules described above.

## Affordance Use

`humanish.affordance-use.v1` (additive `ActorTrace.affordanceUse`) records WHICH
KIND of route an actor took, per dispatched action, as counts by class:

| Class | What it covers |
| --- | --- |
| `pointer` | click, double-click, drag, scroll — interaction with what is rendered |
| `keyboard` | typed text and key presses into the page |
| `url-navigation` | typing a URL (the `nav` subset) — a HUMAN affordance, see below |
| `script-execution` | a `javascript:` or `data:` URL — not a human affordance |
| `devtools` | developer tooling opened by keyboard chord |
| `browser-internal` | `chrome://`, `about:`, `view-source:`, `file:` — the browser, not the product |
| `observation` | screenshots, waits, bare pointer moves — the actor looking rather than acting |

`counts` omits classes that never occurred; `total` is the denominator for any
rate; `shortcutTotal` rolls up `script-execution` + `devtools` +
`browser-internal`, and a value of `0` is a meaningful result rather than an
absence.

Direct URL navigation is deliberately its OWN class and is grouped with the
naturalistic classes, not with script execution: `load(url)` appears in 99.4% of
2,337 real human web demonstrations, so address-bar use is ordinary human
behavior and classifying it as a shortcut would make an ordinary human lane look
unfaithful. See [`docs/principles/actor-fidelity.md`](../principles/actor-fidelity.md)
for the evidence and the scoping of what a fidelity claim can mean.

The record carries a CLASS and at most a scheme-shaped signal (`javascript:`,
`https:`, a devtools chord) — never the typed text, which can be a password, a
session token, or an identifying URL path. Classification runs at dispatch
because the text exists only there: the trace's own action label deliberately
renders `type [N chars]`.

The harness states NO verdict about a class. Whether an affordance invalidates a
study depends on the population that study declares, which is product semantics
and belongs to the adopter's scorer — which already receives the full trace, so
`affordanceUse` needs no extra wiring to reach it. Present on computer-use lanes
that dispatched at least one action; absent elsewhere and on every pre-existing
bundle, and its absence is tolerated by verify.

## Product-Adapter Extension Seam

The terminal-product and browser/computer-use lanes let an adopter attach
product-specific scoring + feedback as a THIN in-repo extension WITHOUT forking
core. The seam is the EXPORTED contract types plus DI hooks:
`TerminalProductLabHooks` for terminal-product runs, and the browser adapter
hooks inherited by `CuaActorLabHooks` / `SharedWorldLabHooks` for CUA,
sequential shared-world, and concurrent shared-world runs. This is never a
built-in product scorer (the adopter's scorecard lives in the adopter's repo).

Three product-agnostic carriers keep core's nouns closed while letting the adapter
record its own:

- **Adapter score** (`humanish.adapter-score.v1`, `RunBundle.adapterScore`).
  A namespaced summary the adapter's `score` hook returns: `{ schema, namespace,
  status, score, summary, data? }`. Core never reads `data` — the adopter's
  component rubric rides there; `namespace` (an adopter slug) scopes the whole
  record so a future inert-field audit never misfires.
- **Namespaced product-noun block** (`RunFeedbackCandidate.adapter`). The
  adapter's `deriveFeedback` hook returns feedback candidates that satisfy core's
  feedback-candidate shape; product-specific concepts (public CLI/product command
  observed, hosted product success-or-blocker, feedback id/draft, media/job/asset
  ids, explicit no-media/no-provider-spend proof, defection/friction risk) are
  recorded ONLY under `adapter: { namespace, data }` — never as core enums. Core
  validates the SHAPE (a non-empty `namespace` + a `data` record); the keys inside
  `data` are the adapter's.
- **Adapter artifacts** (`humanish.adapter-artifact.v1`,
  `RunBundle.adapterArtifacts[]`). A namespaced list of local relative artifact
  references the adapter's `deriveArtifacts` hook returns after writing
  product/state proof files under the ignored run directory. Core validates only
  schema/namespace/label/path/kind/note and local-path safety, Observer links the
  artifacts, and `verifyRun` fails closed if a referenced file is missing.

```yaml
# RunBundle.adapterScore (namespaced; data is the adopter's, core never reads it)
schema: humanish.adapter-score.v1
namespace: adopter-slug
status: pass
score: 88
summary: Product study scored by the adopter's own rubric.
data: { productRubric: { discovery: 1, firstImage: 1 }, hostedProductSucceeded: true }
```

```yaml
# RunFeedbackCandidate.adapter — product nouns stay NON-core under the namespace
adapter:
  namespace: adopter-slug
  data:
    publicCommandObserved: "product generate --prompt '…'"
    hostedProductOutcome: success
    feedbackId: null
    mediaJobIds: []
    noMediaSpendProof: { mediaUsd: null, providerUsd: 0 }
    defectionFrictionRisk: low
```

```yaml
# RunBundle.adapterArtifacts — product/state proof payloads stay adapter-owned
- schema: humanish.adapter-artifact.v1
  namespace: adopter-slug
  label: Product state readback
  path: adapter/product-state-readback.json
  kind: state
  note: Adapter-owned product/state proof.
```

Acceptance semantics are route-specific:

- Terminal-product runs keep the mission-based `review` verdict unchanged; the
  adapter score is additive because the route is a public-product study lane.
- Browser/computer-use runs treat `adapterScore.status: fail` as product-red:
  the bundle keeps the adapter score, `review.verdict` becomes `fail` when it
  was pass-like, a generic adapter gap is appended, and the route result returns
  `ok: false`. This closes the false-positive class where a generic actor reaches
  a terminal session but an adopter scorer finds no product-visible completion
  evidence.

The `e2b-terminal` substrate is added to `RunFeedbackCandidate.substrate` so a
terminal-agent candidate names its substrate honestly; browser candidates use
the existing `e2b-desktop` substrate. Lanes invoke hooks over FULLY-ASSEMBLED,
redacted evidence (`TerminalProductScoringContext` or
`BrowserLabScoringContext`: `bundle`, runtime-only `runDir`, run identifiers,
actor/backend metadata; all exported public types), scrub+redact returned
payloads, and DROP any malformed score, candidate, or artifact reference with a
warning so a bad extension never poisons a verifiable bundle. On the terminal
route the context also carries `transcript` — the FULL normalized session
transcript, source-scrubbed then shape-redacted and byte-identical to the
persisted `terminal-transcript.txt` (the trace's `transcriptTail` is a ~2KB
projection of it), so an adopter rubric can find command-tier evidence anywhere
in the session rather than only in the tail window (#341). Default behavior
(no hook) is unchanged. `verifyRun` re-checks the surviving shapes fail-closed,
including existence for referenced adapter artifacts.

## Evidence Streams

Reserved: `humanish.evidence-stream.v1` has never shipped as a standalone
schema, and streams are not standalone artifacts. They are the `streams` array
inside `humanish.run-bundle.v1`, normalizing UI, browser, terminal, TUI,
code-agent UI, artifact, and summary lanes — each with transport, terminal
tail, completion, meaningful-use verdicts, and artifact pointers. See
[`run-bundle.md`](run-bundle.md#completion-and-meaningful-use-verdicts) for
the stream shape, the meaningful-use rubric, and hard-failure rules.

## Review

Review summarizes whether evidence supports the claim. It does not replace
verification or maintainer acceptance.

Core-owned fields:

- `schema`
- `verdict`
- `summary`
- `gaps`

Adapter-owned fields:

- vocabulary labels
- milestone names
- product-specific gap language

Synthetic fixture:

```yaml
schema: humanish.review.v1
verdict: contract_proof_only
summary: Synthetic dry-run proves bundle shape, not product behavior.
gaps:
  - Live product behavior was not exercised.
```

## Verification

Verification checks bundles and evidence pointers. It fails closed when schema,
redaction, or artifacts are missing.

Core-owned fields:

- `schema`
- `ok`
- `run`
- `bundlePath`
- check names
- check booleans
- `warnings` (advisory postures, e.g. raw screenshots; never flip `ok`)
- machine-readable error codes

Adapter-owned fields:

- optional target-specific checks
- acceptance proof commands
- coverage-specific check names

Synthetic fixture:

```yaml
schema: humanish.verify-result.v1
ok: true
run: synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
bundlePath: .humanish/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof/run.json
checks:
  - name: run.json exists
    ok: true
    message: run.json present
  - name: redaction passed
    ok: true
    message: redaction status must be passed
shareSafety:
  status: share_ready
  reasons: []
```

## Policy

Policy names boundaries before an actor runs or feedback is promoted.
`humanish.policy.v1` exists today only as an adapter fixture shape
(`adapters/fixtures/`); the engine does not validate it. The committed policy
source files scaffolded by `humanish init` use `humanish.redaction-policy.v1`,
`humanish.network-policy.v1`, and `humanish.credentials-policy.v1`.

Core-owned fields:

- `schema`
- policy kind
- default action
- validation outcome
- redaction status
- no-secret-value persistence rules

Adapter-owned fields:

- allowed env var names
- allowed public hosts
- app-specific credential manifest
- network allowlist
- scenario-specific authority

Synthetic fixture:

```yaml
schema: humanish.policy.v1
kind: public-safety
default: deny_sensitive_material
deny:
  - pii
  - phi
  - secrets
  - tokens
  - raw_private_transcripts
  - private_screenshots
allow:
  - synthetic_personas
  - synthetic_fixtures
  - env_var_names
credentialManifest:
  - envName: OPENAI_API_KEY
    valuePersisted: false
network:
  default: local_only
  allowedHosts:
    - localhost
```

## Feedback

Feedback turns verified evidence into public-safe issue draft material. The
default public CLI prints issue text or a prefilled URL; it does not mutate
GitHub.

Core-owned fields:

- `schema`
- run/source/evidence pointers
- redaction status
- idempotency key
- proposed next state
- failure owner enum
- public issue eligibility gates

Adapter-owned fields:

- adapter id
- scenario id
- persona id
- expected/actual language
- target-specific reproduction steps
- acceptance proof commands

Synthetic fixture:

```yaml
schema: humanish.feedback.v1
run_id: synthetic-run-bundle-2026-06-02t10-00-00-000z-proof
adapter_id: synthetic-cli-adapter
scenario_id: first-run-smoke
persona_id: synthetic-maintainer
actor: synthetic-dry-run
substrate: local-filesystem
failure_owner: harness
summary: Synthetic user needed clearer verification instructions.
expected: Verification command is visible and public-safe.
actual: Dry-run review noted missing live behavior proof.
source_bundle: .humanish/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof/run.json
evidence:
  - path: .humanish/runs/synthetic-run-bundle-2026-06-02t10-00-00-000z-proof/review.md
    kind: review
    note: Public-safe synthetic review.
redaction:
  status: passed
  notes: Synthetic fixture only.
idempotency_key: synthetic-cli-adapter:first-run-smoke:verification-instructions
proposed_next_state: watch
acceptance_proof:
  - pnpm humanish -- verify --run latest --json
```

## Contract Stop Conditions

Do not promote a contract fixture when:

- it needs private artifact data to make sense;
- it contains credential values instead of env var names;
- it embeds raw hosted stream URLs or auth-bearing links;
- it uses product-specific private nouns in a core-owned schema;
- it implies GitHub mutation without explicit maintainer authority;
- it cannot be proven with `git diff --check` and public-surface scanning.
