# Humanish Ramp

Status: public-safe contributor and agent ramp.

Package/source version in this tree: `0.83.1` (2026-09-06). The Observer is phone-usable as a stated requirement (observer/AGENTS.md); interactive primitives start from Base UI. The Observer renderer is the observer/ workspace artifact only; the legacy string-concat renderer was deleted at cutover (#426), and rollback is a version pin to 0.42.0. The containment boundary introduced in
`0.15.1` remains in force: managed run and output paths bind to validated
physical filesystem identities, and stored provider IDs are evidence, not
cleanup authority. The bundled OSS meta-lab is dry-run only until
repository-derived instructions have an isolated credential boundary.

Use this page when you are starting cold on `humanish`. It is meant to be
useful without chat history, private notes, local machine paths, or maintainer
context.

## First Read

Read these in order:

1. [`AGENTS.md`](../../AGENTS.md) for public boundary and engineering rules.
2. [`docs/principles/invariants-and-defaults.md`](../principles/invariants-and-defaults.md) — which rules are invariants and which are overridable defaults, each with the reason it exists and the check that enforces it. (The enforcement is what makes a rule real here — when a doc sentence and a test disagree, trust the test and say so.)
3. [`README.md`](../../README.md) for install, commands, and package shape.
4. [`docs/goals/current.md`](../goals/current.md) for the active product goal.
5. [`docs/goals/proof-roadmap/goal.md`](https://github.com/danielgwilson/humanish/blob/main/docs/goals/proof-roadmap/goal.md) for the ratified proof architecture (repo-only; not shipped in the npm package, hence the absolute link).
6. [`docs/product/open-source-install-experience.md`](../product/open-source-install-experience.md) for first-run UX.
7. [`docs/roadmap/world-class-open-source-v0.md`](../roadmap/world-class-open-source-v0.md) for staged delivery history (historical; see its status banner).
8. [`docs/architecture/observer.md`](../architecture/observer.md) for Observer architecture.
9. [`docs/contracts/run-bundle.md`](../contracts/run-bundle.md) and [`docs/contracts/policy.md`](../contracts/policy.md) for proof contracts.
10. [`docs/release/public-readiness-standard.md`](../release/public-readiness-standard.md) before deciding what must be scrubbed.
11. [`docs/release/open-source-readiness.md`](../release/open-source-readiness.md) before touching public packaging or repository visibility.

## Mental Model

Humanish is a persona simulation harness for apps, CLIs, and agent-facing product
flows.

- `humanish/` is committed source: personas, scenarios, policy, adapters, and
  lab manifests.
- `.humanish/` is ignored runtime state: runs, Observer output, transcripts,
  reviews, temporary clones, and local evidence.
- Humanish source uses `.yaml` for human-authored simulation intent, `.ts` for
  executable integration, and JSON/NDJSON for generated artifacts.
- A run bundle is the source of truth.
- The Observer is the projection that makes that truth reviewable.
- Feedback commands turn verified evidence into public-safe issue drafts.

If a change does not improve one of those loops, it probably belongs elsewhere.

## Current State

Humanish has a working public package shape and a safe first-run path:

```bash
pnpm install --frozen-lockfile
pnpm release:check
pnpm humanish -- watch --json --no-open
pnpm humanish -- verify --run latest --json
```

Implemented:

- `commander` CLI with stable command help;
- `init`, `doctor`, `run`, `watch`, `verify`, `review`, `runs`, and `feedback`;
- synthetic run bundles;
- public-safety verification with machine-readable `shareSafety.status`
  (`share_ready`, `local_only`, or `blocked`);
- mission-control Observer over UI, CLI, TUI, and Codex UI stream contracts;
- public-safe feedback issue drafts without GitHub API mutation, gated on
  `share_ready` evidence;
- skills.sh-compatible agent skill;
- first-class lab manifest resolution through `humanish/labs/*.yaml` and
  ignored `.humanish/labs/*.yaml` overlays — `humanish.lab.v2` compositions
  (`src/lab-config.ts`), one engine, no hardcoded lab kinds;
- a first-party actor registry with six registered descriptors
  (`src/actor-registry.ts`); `actors[0].type` is a real dispatch key on the
  computer-use, scripted-browser, and terminal-product routes;
- a computer-use route and clone subject provider: `subject.source: app-url`
  drives a lab-owner loopback app in a hosted desktop, and `subject.source:
  clone` + `serve` clones, installs, and serves a real app in-sandbox from
  config before the actor drives it (`src/cua-actor-lab.ts`);
- six declared subject sources: `this-repo` (dry-run-only), `clone`, `app-url`,
  `local-app` (library-assisted, in-process, no desktop), `terminal-product`,
  and `local-tree`; each route fails closed on unsupported combinations;
- bounded per-lane-world fan-out (`actors[0].count`, `lanes[]`, or `roster[]`),
  backed by deterministic and kept live proof;
- sequential/concurrent single-origin shared-world execution: sequential has
  deterministic proof, while concurrent has deterministic and kept live proof;
- `subject.source: local-tree`, which packages one selected working tree with a
  content pin before using the same provision-and-serve path as clone subjects;
- an off-app comms funnel for email/SMS-gated flows: a vendor-neutral in-sandbox
  catch redirects the app's own send API, a persona reads a minimal inbox surface
  and clicks through, and a digest-only `humanish.comms-thread.v1` artifact
  records the thread with no raw address, link, or code — wired into the
  computer-use and shared-world routes and live-proven on computer-use;
- resolved-persona directives that actually shape the actor prompt on the
  terminal-product route (traits are applied and recorded in the actor trace, not
  decorative), reusing the same `persona.ts` compiler as the computer-use lane;
- a CLI-loadable adopter scorer seam (`review.scorer.ref` in the lab manifest, or
  a `--scorer <path>` override): a config-declared `.mjs` supplies
  `{score, deriveFeedback, deriveArtifacts}`, resolved with the same containment
  as `scenario.ref` and digest-pinned in the bundle
  (`humanish.scorer-provenance.v1`); a config-declared scorer that fails to render
  a pass fails the run on the scorer-capable routes, while library callers keep
  the additive behavior (`costProbe` stays library-only); on the terminal route
  the scoring context carries the FULL normalized transcript (byte-identical to
  the persisted `terminal-transcript.txt`), not only the ~2KB tail projection;
- containment checks for managed run storage, Observer and feedback reads,
  actor artifacts, lab discovery, Git metadata, and source archives;
- an OSS meta-lab dry-run contract and a separate disposable public-repo OSS
  smoke harness;
- cleanup inspection receipts that do not treat mutable run-bundle IDs as
  provider-mutation authority.

Still not good enough:

The [current proof-roadmap checkpoint](https://github.com/danielgwilson/humanish/blob/main/docs/goals/proof-roadmap/README.md)
supersedes implementation-status phrases in the 2026-06-10 roadmap packet
(kept as written — it is a dated record; its README carries current status)
without changing its success standard.

- capability receipts are not adopter replacement: no first-party deletion
  branch has yet removed a bespoke generic harness while preserving
  decision-equivalent proof;
- the six actor descriptors are a closed first-party union, not a supported
  out-of-tree actor-registration API;
- run storage and provider-resource lifecycle logic still spans several routes
  instead of one `RunStore` and `ResourceLease` boundary;
- multi-origin shared-world is a ratified design direction, but remains
  unimplemented and gated on a real adopter proving the need;
- live OSS meta-lab execution remains disabled until repository-derived
  instructions have an isolated credential boundary; historical headed-lane
  evidence does not make the current entrypoint available;
- the README hero is the drawDB real-application study — a legible capture of a
  studied public subject, not a Humanish adopter; coverage beyond that single
  studied subject (the stratified breadth panel) remains open.

## First Commands

From a clean checkout:

```bash
git status --short --branch
pnpm install --frozen-lockfile
pnpm release:check
pnpm humanish -- watch --json --no-open
pnpm humanish -- runs --json
pnpm humanish -- lab list
```

For local product feel:

```bash
pnpm humanish -- watch
```

For public OSS dogfood without credentials:

```bash
pnpm humanish -- lab run oss --dry-run --json --no-open
pnpm humanish -- lab run oss-smoke --limit 1 --json
```

For private/local dogfood, author an ignored lab manifest under
`.humanish/labs/` or `.humanish/local/labs/`, then invoke it explicitly with an
ignored env file:

```bash
pnpm humanish -- watch .humanish/labs/local-dogfood.yaml --env-file .humanish/local/provider.env
```

## How To Pick Work

Start from [`docs/goals/current.md`](../goals/current.md).

Prefer work that makes Humanish more believable to a new maintainer:

- a command becomes easier to run;
- a run bundle becomes more truthful;
- Observer evidence becomes more inspectable;
- verification catches a real bad state;
- feedback drafts become more actionable;
- public-safety gates catch a class of leak or stale residue.

If no GitHub issue exists for substantial work, draft one with the repo issue
template before building. Use labels to communicate authority, area, risk, and
required proof.

## Quality Bar

Do not close a change on narrative alone.

Useful proof includes:

- `pnpm release:check`;
- `pnpm release:dogfood` before a tag — see below;
- focused unit or contract tests;
- a generated run bundle under ignored `.humanish/`;
- Observer screenshots or health output;
- `humanish verify` results;
- public-surface scan output;
- fresh clone checks for packaging or release work.

A green subset is not the same thing as complete coverage. If something is not
covered, name it as a gap.

## Public Boundary

Assume this repository is public even when local or remote visibility says it is
private.

Never commit or paste:

- PII or PHI;
- secrets, keys, tokens, cookies, or raw env files;
- raw private transcripts;
- private screenshots;
- private customer or patient data;
- local machine paths;
- private upstream code or operational details.

Use synthetic examples, redacted evidence, and env var names without values.

## Embarrassment Filter

Before committing, ask:

- Would this make sense to someone who found the repo through npm?
- Would I be comfortable with this file quoted in a public issue?
- Does this depend on private chat memory?
- Does it mention removed docs, private machine paths, or internal-only names?
- Does it claim product proof when it only proves a contract?

If the answer is uncomfortable, rewrite it, synthesize it, or keep it out of the
repo.

## Hand-Off Format

End substantial work with:

- what changed;
- what proof passed;
- what remains uncertain;
- the next best issue or command.

Future agents should be able to continue from the repo, not from the previous
chat transcript.


## Before you tag: send a participant to meet the build

```bash
pnpm release:dogfood     # needs OPENAI_API_KEY + E2B_API_KEY; costs about a dollar
```

`release:check` proves the code is internally consistent. It cannot tell you whether
someone landing on this build can get anywhere with it, and that gap is not
theoretical: `0.56.0` passed every check and shipped a regression that hid a run's
price at exactly the moment a person was deciding whether to set keys up. A
synthetic participant found it hours later.

So the last gate before a tag is the product's own first-contact study, pointed at
the release candidate. It packs the tarball, uploads it into the sandbox, and has a
real autonomous agent install THAT — not `humanish@latest`, which would measure the
last release, the one artifact we already know about.

It prints the participant's report and fails the gate if they could not get there.
**Read the report even when it passes.** The verdict is a marker the participant
sets; the paragraph underneath it is the finding, and it has twice repeated an
adoption problem we already knew about in words no test could produce.

This spends money and needs keys, so it is deliberately NOT part of `release:check`
and never runs in CI. The lab's caps hold product spend to `$0`; what it costs is
the agent's own tokens and a few sandbox-minutes.
