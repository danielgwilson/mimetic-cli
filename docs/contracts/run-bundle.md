# Run Bundle Contract

Date: 2026-06-02 (current-state note updated 2026-07-14)

Status: `humanish.run-bundle.v1` is the shipped evidence contract. The
TypeScript shape and fail-closed verification in `src/run.ts` are
authoritative; this document explains the stable public fields and extension
rules rather than independently versioning the runtime.

## Purpose

A run bundle is the durable evidence packet for one harness run. It should be
reviewable by a person, parseable by a tool, and safe to use as the source for
feedback drafts and future public issues.

## Minimum Bundle Shape

```yaml
schema: humanish.run-bundle.v1
runId: "<core run id>"
mode: "dry-run|live"
simCount: 1
createdAt: "<ISO timestamp>"
lab: # optional, additive: which manifest produced this run
  id: "<lab id>"
  path: "humanish/labs/<lab id>.yaml"
  origin: "committed|ignored|explicit"
cwd: "[target-cwd]"
artifactRoot: ".humanish/runs/<run-id>"
source:
  packageName: "<public package name or null>"
  humanishSource: "present|missing"
  git:
    schema: humanish.git-state.v1
    status: "clean|dirty|missing|unavailable"
    capturedAt: "<ISO timestamp>"
    head:
      shortSha: "<short sha or null>"
      refState: "attached|detached|unborn|unknown"
    changes:
      staged: 0
      unstaged: 0
      untracked: 0
      total: 0
    note: "<public-safe note>"
lifecycle:
  - at: "<ISO timestamp>"
    event: "run.created"
    message: "<public-safe message>"
artifacts:
  run: "run.json"
  reviewJson: "review.json"
  reviewMarkdown: "review.md"
  observerData: "observer/observer-data.json"
  events: "events.ndjson"
review:
  schema: humanish.review.v1
  verdict: "contract_proof_only|pass|fail|blocked|timed_out"
adapterScore:
  schema: humanish.adapter-score.v1
  namespace: "<adapter namespace>"
  status: "pass|partial|fail"
  score: 0
  summary: "<public-safe adapter score summary>"
  data: {}
feedbackCandidates:
  - schema: humanish.feedback-candidate.v1
    id: "<stable candidate id>"
    failure_owner: "harness|target-app|actor|environment|unknown"
    evidence:
      - path: "<relative run artifact path>"
        kind: "review|state|log|trace|screenshot|filesystem"
adapterArtifacts:
  - schema: humanish.adapter-artifact.v1
    namespace: "<adapter namespace>"
    label: "<human-readable artifact label>"
    path: "<relative run artifact path>"
    kind: "state|review|log|trace|screenshot|filesystem|summary"
    note: "<public-safe note>"
```

Persisted `run.json` files must not contain absolute local target paths. Runtime
commands may return the caller's working directory in process-local JSON
responses, but durable run bundles use the public-safe `[target-cwd]` marker.

## Hosted Desktop Geometry

Hosted browser streams may carry additive `desktopGeometry` evidence. Its fields keep five
different facts separate:

- `screen.requested`: the E2B/X screen size requested by config;
- `screen.verified`: the screen size measured in-sandbox with `xdpyinfo`;
- `screen.declared`: the device preset the lab ASKED for, present only when it differs from
  `screen.requested` because the rendered width was floored to Chrome's ~500px window minimum.
  `verified` compares the floored number with itself and reports a match, so a matching
  `verified` block is NOT evidence that the preset width rendered. When `declared` is present,
  it did not: a `mobile` (414) and a `small-mobile` (360) seat both render at 500 and are
  indistinguishable by rendered width;
- `browserWindow`: measured browser bounds after the window-fill attempt; physical X client
  bounds (`source: xdotool`) take precedence over page-reported outer bounds (`source: cdp`),
  which can reflect mobile emulation;
- `viewport`: the page's CSS layout viewport and device-pixel ratio measured through CDP on
  Chromium-family hosted browsers.

Before participant actions, hosted computer-use lanes check measured X bounds against every
edge of the captured desktop. If a browser is clipped, one bounded move-and-fit correction
accounts for the window manager's client origin. A window that remains clipped, or whose repair
cannot be verified, ends the lane before participant actions. A fully contained smaller window
can run. Missing X measurements are explicitly unverified; an emulated CSS viewport cannot
establish physical containment. Final capture observes geometry without resizing the app.

For new hosted-desktop computer-use bundles, `stream.viewport` mirrors the measured
`desktopGeometry.viewport`; it is omitted when runtime measurement is unavailable. It is never
filled from the requested screen size. Dry-run bundles therefore carry the requested screen but
no verified screen, browser bounds, or viewport. Historical bundles remain loadable and may
contain the older requested-screen `stream.viewport` shape without `desktopGeometry`.
Deterministic Playwright-style adapters remain free to declare a viewport that they also render
exactly; this hosted-desktop rule does not change that contract.

## Subject Provenance

`subject` is an optional, additive top-level field: structured provenance for
what the computer-use backend actually drove (code pin plus state story). It
is absent on pre-existing bundles and on bundles from backends that have not
adopted it. The field shape, its three sources (`clone`, `app-url`,
`local-tree`), and the `humanish verify` checks that guard it are the schema doc's
job, not this one: see the `subject` entry under
[`schemas.md`](schemas.md#contract-schema-index). In short, `clone` carries a
`repo`/`commit` pin, `local-tree` carries an `archiveSha256`/`dirty` pin
instead (a dirty working tree cannot be commit-pinned), and `app-url` carries
no code pin at all. No path, basename, or other host-machine string ever
enters this field; identity is digests, a sha, a boolean, and counts.

## Cost Estimate (advisory)

`cost` is optional and additive (`humanish.run-cost-summary.v1`): the
computer-use lane's run-level cost ESTIMATE — the sum of each lane's
token-derived model cost plus E2B desktop compute lines. New independent CUA runs
emit one line per owned desktop, keyed by public lane ID and carrying observed CPU/memory,
resource source, host-measured minutes, and the derived per-second rate. Older
single aggregate desktop lines remain valid. Missing resource metadata stays
unpriced; unconfirmed cleanup adds an unknown remaining-lifetime line. It is an
ESTIMATE, never authoritative: every dollar is a rate-table multiply from the
operator-editable `src/pricing.ts`, carries the pricing `ratesAsOf` date and
`source`, and is surfaced with the "estimated (rates as of `<date>`)" label —
never a bare charge. It follows the same **declared-absent** discipline as the
terminal cost ledger: an unpriceable line stays present with
`estimatedCostUsd: null` + a `reason` and contributes nothing;
`estimatedTotalUsd` is `null` iff every line is null (never coerced to `0`).
Dry-runs and lanes that spend nothing omit `cost` entirely, so pre-existing
bundles stay byte-stable. Each lane's own estimate also rides its
`stream.actor.estimatedCost` (`humanish.actor-estimated-cost.v1`), kept distinct
from the reserved provider-returned `tokenUsage.costUsd`. See
[`schemas.md`](schemas.md) → Run Cost Summary And Estimated Actor Cost.

`humanish verify` treats cost as ADVISORY on magnitude and FAIL-CLOSED on
labeling: absence passes, but a claimed dollar figure without its `ratesAsOf`
date + `source`, or a total that does not match its known lines, fails. Verify
never inspects the magnitude — a correctly-labeled large estimate still passes.

## Adapter Score

`adapterScore` is optional and namespaced. It lets a downstream adapter summarize
its own product-specific rubric without adding product nouns to core schemas.
Core validates only `schema`, `namespace`, `status`, `score`, `summary`, and
that optional `data` is a record.

Terminal-product runs record `adapterScore` additively. Browser/computer-use
runs treat `status: fail` as product-red: the route result returns `ok: false`,
the persisted `review.verdict` becomes `fail` when it was pass-like, and a
generic adapter gap is appended. The bundle remains valid evidence for
`humanish verify` because the failure is an observed product-acceptance outcome,
not corrupt evidence.

## Adapter Artifacts

`adapterArtifacts` is optional and namespaced. It lets a downstream adapter
attach product/state proof outputs to the Humanish bundle without making the
payload shape a core concept. Core validates only:

- `schema: humanish.adapter-artifact.v1`;
- non-empty `namespace`, `label`, `path`, and `note`;
- local relative paths only, with no absolute paths, traversal, or URLs;
- supported generic artifact kinds.

Adapters that use browser/shared-world hooks may write files under the ignored
run directory and return relative references through `deriveArtifacts`. Core
stores those references, Observer links them, and `humanish verify` fails closed
when any referenced file is missing. The adapter owns the artifact payload schema
under its namespace.

## Lane Grouping Metadata

Multi-lane browser/shared-world routes may carry optional lane grouping metadata:

```yaml
actors:
  - type: openai-computer-use
    lanes:
      - id: lane-01
        actorType: viewer
        surface: intake
        caseGroup: case-001
```

For repeated lanes, authors can use compact roster groups. The parser expands
each group into deterministic `lanes[]` before the engine runs:

```yaml
actors:
  - type: openai-computer-use
    roster:
      - id: viewer
        count: 3
        actorType: viewer
        surface: review-queue
        caseGroup: case-001
        persona: curious-reviewer
        device: desktop
```

The generated lane ids are `<group.id>-01`, `<group.id>-02`, and so on. `roster`
is mutually exclusive with explicit `lanes`, homogeneous `count`, and
`laneFocus`; it is an authoring convenience, not a second runtime shape.

These fields are adapter-owned labels, not core enums. They let downstream
projects express "N actors of M app-defined types across S surfaces" without
teaching Humanish private product nouns. Values must be public-safe tokens and
are projected into:

- the preflight lane plan;
- shared-world `laneWindows[]` and `outcomes[]`;
- Observer `laneGroups[]`;
- human-readable Observer stream labels.

`actorType` is deliberately separate from `actors[0].type`. The latter selects
the Humanish execution actor, such as `openai-computer-use` or `scripted-browser`.
The former is the app-defined simulated user bucket, such as `viewer`,
`maintainer`, or a downstream adapter's own role label.

## Completion And Meaningful-Use Verdicts

Each live stream may include `completion` when the harness has enough evidence
to judge the lane. Completion state is deliberately compact and public-safe:
it records actor/app/nested-Observer status, terminal tails that have already
passed redaction, and optional setup-quality evidence.

`completion.meaningfulUse` is the first-class scored verdict for meta-lab
lanes where a coding agent is asked to set up Humanish inside another project.
It is a rubric over already-redacted evidence, not a raw transcript dump.

```yaml
completion:
  status: "running|passed|failed|blocked|timed_out"
  reason: "<public-safe lane summary>"
  actorStatus: "not_started|running|passed|failed|blocked|timed_out|suspended|unknown"
  appStatus: "not_started|running|blocked|failed|missing|unknown"
  nestedObserverPresent: true
  nestedVerifyPassed: true
  visualStatus: "not_started|visible|blocked|unknown"
  meaningfulUse:
    schema: humanish.meaningful-use-score.v1
    status: "pass|partial|fail"
    score: 0
    summary: "<public-safe score explanation>"
    hardFailures:
      - "<hard failure that prevents green proof>"
    components:
      - id: "setup-correctness"
        label: "Setup correctness"
        status: "pass|partial|fail"
        score: 0
        detail: "<public-safe detail>"
```

The current OSS meta-lab rubric totals 100 points:

- setup correctness: 15;
- filesystem evidence: 10;
- nested Humanish evidence: 20;
- actor activity: 15;
- product surface: 15;
- feedback quality: 25.

A score of 80 or higher is `pass` only when no hard failure is present and
every rubric component passes. Scores from 45 through 79, or scores of 80 or
higher with any non-passing component, are `partial`. Scores below 45,
failed/timed-out bootstraps, missing nested Humanish proof, required actor
failure, or completed lanes without a running visible product surface are
`fail`.

## Relative Artifact Layout

For run id `example-2026-06-02t10-00-00-000z-proof`, the core layout is:

```text
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/run.json
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/review.json
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/review.md
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/observer/observer-data.json
.humanish/runs/example-2026-06-02t10-00-00-000z-proof/events.ndjson
.humanish/runs/latest.json
```

Absolute paths, traversal segments, remotes, hosted logs, and private artifact
URLs are not part of the core layout.

## Filesystem Evidence

Filesystem setup evidence is first-class when a lane asks an actor to install
or configure Humanish inside another project. It is not a repo dump.

The durable artifact kind is `filesystem`. The current schema is:

```yaml
schema: humanish.setup-quality.v1
status: "passed|needs_review|blocked"
redaction:
  status: "passed"
  rawPreviews: "included|suppressed"
checks:
  - id: "humanish-config"
    ok: true
tree:
  - path: "humanish/config.ts"
    type: "file"
previews:
  - path: "humanish/config.ts"
    language: "typescript"
studyQuality:
  schema: humanish.study-quality.v1
  rating: "none|ceremonial|useful|high_leverage"
  checks:
    - id: "coverage-customized"
      ok: true
  signals:
    appUrlProofBlocked: false
    appUrlProofMentioned: true
    actorInsightCaptured: true
    coverageCustomized: true
    personaCustomized: true
    scenarioCustomized: true
packageScripts:
  humanish: "humanish watch"
humanish:
  configPresent: true
  personaCount: 1
  scenarioCount: 1
  packageScriptPresent: true
  gitignoreContainsRuntimeIgnore: true
```

For public OSS runs, previews may include allowlisted setup files such as
`package.json`, `.gitignore`, `humanish/config.ts`, and
`humanish/labs/*.yaml` / `humanish/personas/*.yaml` /
`humanish/scenarios/*.yaml`. For token-backed or private maintainer runs, raw
previews are suppressed by default. Generated state, `.git`, `.env*`, `.npmrc`,
browser profiles, `node_modules`, `.humanish/`, and arbitrary source files are
not included. `studyQuality` is deliberately structural: it stores booleans,
checks, and a rating so private runs can preserve the useful quality signal
without committing raw private persona, scenario, or coverage text.

## Latest And History

The latest pointer is a small local index:

```yaml
schema: humanish.latest-run.v1
runId: "<run-id>"
path: ".humanish/runs/<run-id>"
updatedAt: "<ISO timestamp>"
```

History entries use:

```yaml
schema: humanish.run-history-entry.v1
runId: "<run-id>"
createdAt: "<ISO timestamp>"
lab: # optional, additive: which manifest produced this run
  id: "<lab id>"
  path: "humanish/labs/<lab id>.yaml"
  origin: "committed|ignored|explicit"
mode: "dry-run|live"
path: ".humanish/runs/<run-id>"
```

The latest pointer may move. Run bundle directories should not.

## Verify Result Share Safety

`humanish.verify-result.v1` includes a machine-readable `shareSafety` block in
addition to `ok`, `checks[]`, and `warnings[]`:

```yaml
schema: humanish.verify-result.v1
ok: true
shareSafety:
  status: "share_ready|local_only|blocked"
  reasons:
    - code: "RAW_SCREENSHOTS"
      message: "Full-fidelity screenshots are present ..."
```

`ok: true` means the bundle is valid evidence. It does not necessarily mean the
bundle is safe to promote into a public issue. Public promotion should branch on
`shareSafety.status`:

- `share_ready`: feedback draft commands may render public issue payloads;
- `local_only`: keep the run local or generate a redacted replacement bundle;
- `blocked`: fix the verification or public-safety failure first.

## Contract Fixture Proof

The core fixture proves:

- deterministic run ids from explicit inputs;
- stable relative artifact paths;
- latest/history/lifecycle/timing records;
- git status counts without branch names, remotes, file names, file paths, or
  absolute directories;
- no environment-specific nouns in `src/core`.

Proof commands:

```bash
pnpm test
pnpm typecheck
```
