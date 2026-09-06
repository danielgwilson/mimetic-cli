# Terminal-product real-agent lane (issue #154)

Date: 2026-06-16 (runtime-auth contract updated 2026-09-05)

Status: live terminal-product route shipped in `0.8.0`. The in-sandbox backend,
command-scoped credential placement, exact-id cleanup proof, an interventions ledger,
cost/no-spend ledger, caps, and product scoring/feedback hooks are implemented;
the kept 2026-07-09 live receipt verifies 15/15 checks and `share_ready` at a
`$0` cap. That capability receipt is not adopter replacement: no deletion
branch has yet removed the reference adopter's bespoke generic study harness.
See the ratified goal packet
([`docs/goals/terminal-product-lane/goal.md`](../goals/terminal-product-lane/goal.md))
for the full slice plan and the safety contract.

## What this is

A lab lane for **terminal-product real-agent studies**: a real autonomous coding
agent (Codex) discovering and using a CLI/product from its **public surfaces
only**, running **inside an E2B shell** with declared runtime-auth placement and
spend/time caps, emitting durable terminal/substrate/cost/no-spend/cleanup/
intervention proof that verifies fail-closed. This is distinct from the browser
lanes: it is not testing whether a browser can click a local web app — it tests
whether an autonomous agent can discover and use a CLI/product surface from
public materials.

It rides the established lane-addition pattern (proven by the scripted-browser
and local-app lanes): a new `subject.source` × `execution.target`, a routing
predicate, a backend enum + dispatch, a registered actor with a capability lane,
fail-closed cross-validation, and forward-declared warnings.

## The composition

| Axis | Value |
| --- | --- |
| `subject.source` | `terminal-product` |
| `subject.product` | `{ name, publicSurfaces[] }` — the only world the agent sees |
| `execution.target` | `e2b-terminal` (or absent → implied) |
| `execution.terminal` | `{ transport: exec-stream, stdin: disabled }` |
| `execution.runtimeAuth` | `openai-env` (default) or opt-in `openai-egress`; names-only durable evidence |
| `execution.runtime.version` | Optional exact `@openai/codex` version; observed before keyed execution |
| `actors[0].model` / `reasoningEffort` | Forwarded to Codex; retained as declarations, not observed provider identity |
| `scenario.caps` | `{ maxUsd, maxJobs, maxMinutes }` — the blast-radius budget |
| `policies` | `allowPrivateRepoAccess` / `allowProviderCredentials` / `allowPaymentCredentials` / `allowGitHubMutation`, all DEFAULT FALSE |
| `actors[0].type` | `codex-exec` — a registered terminal actor (`keyPlacement: in-sandbox-command-scoped`) |
| `LabBackend` | `terminal` → `runTerminalProductLab` ([`src/e2b-terminal-lab.ts`](../../src/e2b-terminal-lab.ts)) |

Routing is `routesToTerminalProduct(config)` — the single source of truth that
both `selectLabBackend` and the forward-declared-warning logic consume, mirroring
`routesToComputerUse` / `routesToScriptedBrowser`.

## Repeating a terminal study with the same runtime

```yaml
actors:
  - type: codex-exec
    model: gpt-5.6-sol
    reasoningEffort: low
execution:
  target: e2b-terminal
  runtime:
    version: 0.153.3
```

An explicit version must be exact semver; tags, ranges, URLs, and extra runtime
fields fail at parsing. Before the keyed actor command, Humanish runs an unkeyed
`npx @openai/codex@<selector> --version` command with a 60-second deadline.
A malformed result, nonzero exit, or requested/observed mismatch fails the lane
and reclaims its owned sandbox. When the version is omitted, the probe resolves
`latest` once and execution uses the exact version it reported.

`actor.json`, the bundle's terminal actor, and `terminal-ledgers.json` retain
`humanish.actor-runtime.v1`: requested and observed versions, verification status,
declared model/effort, and the usage granularity. The observed executable version
also appears as `providerVersion`. An undeclared model stays explicitly
`runtime_default_unobserved`; Humanish does not label the runtime name as a model.
Dry runs record declarations only, in a `terminal-lab.runtime.declared` event.

These settings make a study's request reproducible, but do not attest the actual
provider model or add a provider spending limit. Codex `turn.completed` usage can
aggregate several model requests, so Humanish does not use a declared model to
infer per-request pricing tiers or fill in unknown costs. Runtime-token costs
and the studied product's no-spend boundary still need separate interpretation.

## Runtime auth: raw-key placement and remaining provider access

`execution.runtimeAuth: openai-env` remains the compatible default. It supplies
`CODEX_API_KEY` command-scoped to Codex, with `OPENAI_API_KEY` also supplied when
that was the host source. Child processes can read and use the raw key.

Opt in to keeping the raw key outside the sandbox:

```yaml
execution:
  target: e2b-terminal
  runtimeAuth: openai-egress
  terminal:
    transport: exec-stream
    stdin: disabled
```

`openai-egress` resolves the same host key (`CODEX_API_KEY` first, otherwise
`OPENAI_API_KEY`) and supplies it only to E2B's host-side network rule for
`api.openai.com`. The rule sets the HTTPS `Authorization` header. The sandbox's
Codex command receives the nonsecret value `humanish-egress-auth-placeholder`
under `CODEX_API_KEY`, plus `CODEX_CA_CERTIFICATE` pointing at E2B's existing
system CA bundle (`/etc/ssl/certs/ca-certificates.crt`) so TLS verification trusts
the platform's proxy CA. Humanish does not disable TLS verification or download
an unauthenticated CA. The sandbox receives no raw runtime key in command env, sandbox env,
files, metadata, or captured evidence. The host still scrubs the actual key from
output and errors, including errors during sandbox creation.

This mode supports the default OpenAI endpoint only. Humanish explicitly sets
Codex's built-in `openai` provider and `openai_base_url` to
`https://api.openai.com/v1` for that invocation. It does not support a custom
provider, proxy base URL, or regional endpoint under this mode. `openai-env`
retains its existing command behavior. E2B header rules are a public-beta
capability; the local contract is checked against the installed Desktop SDK
(`@e2b/desktop` 2.3.3, resolving `e2b` 2.46.1).

**The sandbox still has a spendable OpenAI proxy capability.** Every process can
make authenticated requests to that host from sandbox creation until teardown,
including bootstrap/setup commands and commands launched outside Codex. Calls
made outside Codex may be absent from its usage ledger. This mode does not impose
a provider-side spending limit, restrict models/API paths, or make
`scenario.caps.maxUsd` a preventive provider budget. A hard provider budget needs
a separately enforced control; do not infer zero spend from an unmeasured ledger
line.

Public internet discovery stays unrestricted unless the lab already declares
`execution.egressAllow`. The mode preserves that allowlist and its deny-all
fallback without adding hosts. If an allowlist omits `api.openai.com`, provider
requests can fail. E2B domain allowlists are routing controls rather than strict
destination isolation on shared infrastructure. An existing exact OpenAI host
rule is rejected instead of silently overwritten.

Evidence records the selected auth mode and the residual proxy capability.
Resolved live actor traces use `keyPlacement: external` in `openai-egress`; the
actor registry continues to describe the default `in-sandbox-command-scoped`
placement. Dry runs record declarations and prove no live proxy behavior.

The upstream contracts are documented in [E2B internet access and network
rules](https://docs.e2b.dev/network/internet-access) and [Codex advanced
configuration](https://developers.openai.com/codex/config-advanced),
[Codex custom CA bundles](https://developers.openai.com/codex/auth#custom-ca-bundles),
and [E2B's CA installer](https://github.com/e2b-dev/infra/blob/main/packages/envd/internal/host/cacerts.go).
E2B's installed
SDK documents that transformed headers override request headers. Deterministic
request/redaction tests do not establish live wire behavior. The [2026-09-05
transport receipt](../goals/terminal-product-lane/receipts/2026-09-05-runtime-egress-auth.md)
records the controlled live header/auth checks and their scope.

## Runtime prerequisite

The terminal route reuses a working Node >=20 and npm from the calling shell.
Otherwise it installs the pinned official Node 22.23.2 Linux x64 or arm64 archive,
downloaded over verified HTTPS and checked against an architecture-specific
SHA256 committed in the bootstrap. It does not refresh apt repositories or fetch
an unpinned checksum beside the archive. Node 22 is a supported LTS line on the
[official release schedule](https://nodejs.org/en/about/previous-releases); the
trusted hashes come from its [release manifest](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt).

Installation requires `curl`, `sha256sum`, `tar`, `gzip`, `mktemp`, and passwordless
`sudo`. Only a verified archive is extracted into a root-owned versioned directory
under `/opt/humanish`; `/usr/local/bin` links make Node/npm/npx available to later
shells. In that new distribution only, a missing built-in npm `prefix` defaults
to `/usr/local`, so global product executables use the existing PATH. Existing
distribution settings and higher-priority npm overrides are preserved; an adopter
override can still choose a bin directory outside PATH. The installer changes no
user/global npm configuration, global permissions, or shell startup files. It
checks Node/npm in both ordinary and sudo shells after installation. The existing
runtime fast path preserves user-specific installations; a later sudo product
install can still fail if that installation is absent from sudo's PATH.

The [global executable receipt](../goals/terminal-product-lane/receipts/2026-09-05-global-npm-prefix.md)
records the regression found after the initial runtime-only proof and its stock
desktop checks. npm documents [global executable locations](https://docs.npmjs.com/cli/v10/configuring-npm/folders#executables)
and the [distribution built-in configuration](https://docs.npmjs.com/cli/v10/configuring-npm/npmrc#built-in-config-file).

An egress allowlist must permit `nodejs.org` if the runtime needs installation,
as well as the registries and product surfaces the study uses. Missing tools,
unsupported architectures, a failed download or checksum, and a failed runtime
check stop the lane before Codex. Downloads have finite connection, transfer, and
retry bounds within the existing five-minute bootstrap deadline.

The `desktop-cli` computer-use route uses this same Node/npm prerequisite when
`subject.product.install` is omitted or declares a Node command. With install
omitted, the participant arrives at an open terminal with Node/npm available;
the product remains uninstalled for them to discover and install from its public
surfaces. Runtime setup runs unkeyed and a failed bootstrap stops before the
participant starts. A declared non-Node install keeps its existing runtime
behavior. The desktop route retains its ten-minute runtime step deadline.

## The original command-scoped safety contract

The default mode **inverts** the credential-placement default of every other E2B route.
On the computer-use route the model's key stays *outside* the sandbox; here the
agent-under-test runs *inside* with a real `OPENAI_API_KEY`/`CODEX_API_KEY` and
is **presumed exfiltratable**. The doctrine (invariants-and-defaults.md, the
placement rule): *keys live where the keyed process runs — and nowhere else;
blast radius is bounded by key scoping and budgets, not by hoping.*

The inversion is declared as registry metadata, not a code convention: the
terminal actor's capabilities carry `keyPlacement: "in-sandbox-command-scoped"`.
SLICE 1 shipped the DECLARED field + value (the contract was honest about where
the key would go); SLICE 2's engine added command-scoped injection (only into the
per-command `envs` of the `codex` invocation, never `Sandbox.create({envs})`)
keyed off that capability, plus the deny-by-default credential allowlist, the
positive-allowlist sandbox metadata, the cleanup proof, the interventions ledger,
and a minimal fail-closed cap.

## Historical SLICE 1 scope (DRY-RUN only when shipped)

At SLICE 1, `runTerminalProductLab` implemented only the dry-run path: it built a valid
`humanish.run-bundle.v1` contract bundle, honestly labeled contract-only, with:

- the subject declared as a terminal-product with its public surfaces, provenance
  **UNPINNED** (the agent drives public surfaces, not a clone — invariant 5);
- the author mission recorded as plaintext (public-safe committed lab text) + a
  **digest** of the full composed prompt (nothing beyond the author mission goes
  plaintext);
- the caps / deny-by-default policies / runtime-auth channel recorded as
  declarations (names only — invariant 1);
- a terminal-kind stream that is an honest **contract placeholder**: stdin
  disabled, empty tail, `transport: snapshot` — **not** `pty` (captured
  non-interactive exec output is never an interactive PTY; invariant 6 + the
  goal packet's PTY ruling). SLICE 2 later added redacted exec-stream capture;
- empty/placeholder ledgers (substrate lifecycle, command log, terminal event
  stream, interventions, cost) that SLICE 2/3 later filled.

The dry-run bundle passed the existing `verifyRun`. Terminal-specific verifier
checks (terminal/transcript presence, lifecycle, cleanup, interventions,
metadata allowlist, no-credential-in-artifacts, no-spend) landed in SLICE 2/3.

At SLICE 1, a non-dry-run call returned a structured
`HUMANISH_TERMINAL_AGENT_NOT_IMPLEMENTED` failure before launch or spend.
SLICE 2 implemented the real session.

The DI seams SLICE 2 needs (`loadModule`, `buildSandbox`, `runtimeAuthEnv`,
`detachedTimers`) are declared on `TerminalProductLabHooks` and threaded through
`RunLabOptions.terminalHooks`, mirroring `cuaHooks` / `scriptedHooks`; only the
dry-run path was implemented in that slice.

## SLICE 4 — the product-adapter extension seam (layer 6)

This lane is proof-roadmap **layer 6**: an adopter attaches product-specific
scoring + feedback as a THIN in-repo extension WITHOUT forking core. SLICE 4
ships the SEAM (not a built-in product scorer — the adopter's scorecard lives in
the adopter's repo):

- **Exported contract types** a thin adapter types against from the package
  barrel (`humanish`) alone — never a deep `src/` import: `RunBundle`,
  `RunFeedbackCandidate`, `RunAdapterScore`, `RunMeaningfulUseScore`
  (+ `RunMeaningfulUseComponentId`), `ActorTrace`, and the terminal-lane
  `TerminalProductScoringContext` / `TerminalLedgers` / `TerminalCostLedger` /
  `NoSpendProof` / `CostLine` / record types. Before this slice these were not
  exported — which FORCED a fork (a thin adapter could not type against the
  bundle), the gap issue #154 acceptance #8 names.
- **A registrable scorer / feedback DI hook** on `TerminalProductLabHooks`:
  `score?(ctx: TerminalProductScoringContext) => RunAdapterScore | Promise<…>`
  and `deriveFeedback?(ctx) => RunFeedbackCandidate[] | Promise<…>`. The lane
  calls the hooks over the FULLY-ASSEMBLED, redacted evidence and attaches the
  results (`bundle.adapterScore`, appended `bundle.feedbackCandidates`) WITHOUT
  core knowing any product noun. Default (no hook) behavior is unchanged: the
  mission-based verdict stands alone.
- **Adapter-namespaced product nouns.** Product-specific concepts (public
  CLI/product command observed, hosted product success-or-blocker, feedback
  id/draft, media/job/asset ids, no-media/no-provider-spend proof,
  defection/friction risk) ride ONLY under a single namespaced field
  (`RunFeedbackCandidate.adapter: { namespace, data }` and
  `RunAdapterScore.{namespace, data}`) so core's enums stay product-agnostic and
  a future inert-field audit never misfires. No adopter noun is hardcoded into a
  core enum (avoiding closed-taxonomy rot); `e2b-terminal` is added to the
  substrate enum so a terminal-agent candidate names its substrate honestly.

The seam is fail-closed: the lane scrubs+redacts the returned payloads and DROPS
any malformed score/candidate with a warning, and `verifyRun` re-checks the
surviving shapes — a bad extension never poisons a verifiable bundle. Proven by
`tests/terminal-product-adapter-seam.test.ts` (a thin in-repo example adapter
typing against the barrel only, registering a scorer, attaching namespaced nouns,
emitting a candidate; the bundle verifies). At SLICE 4 this was contract proof,
not a live rung; the later end-to-end lane receipt is linked from the status
note.

The adopter's real scorecard is its OWN thin extension. The end-to-end lane's
live receipt is kept under the terminal-product goal, and true duplex PTY replay
is deferred to SLICE 5.

## The reference adopter (codename-neutral)

The requesting adopter is a public creative-CLI product (see issue #154 for its
concrete public surfaces). Committed source and docs here stay codename-neutral
per the public-surface scan; the committed CI fixture
([`humanish/labs/terminal-product-demo.yaml`](../../humanish/labs/terminal-product-demo.yaml))
uses a FICTIONAL mock CLI (`widgetsmith-cli`) with `example.com` surfaces. The
adopter's real public surfaces appear only in operator-run docs and the GitHub
issue, never in scanned committed text.
