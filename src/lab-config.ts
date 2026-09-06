// humanish.lab.v2 — a lab is a COMPOSITION over code primitives, not a hardcoded kind.
//
// HONEST SCOPE (read before trusting field names): the engine routes by
// subject.source × execution.target (disambiguated by the actor lane where both axes
// collide) and consumes a deliberately small set of fields:
//   subject.source/repos/appUrl/serve/env/state/clone.{depth,fanout,keep}, actors[0].count,
//   execution.target + execution.desktop.codexAppServer, scenario.mode,
//   policies.redactRepos, defaults.open.
// On the computer-use routes (app-url × e2b-desktop, and clone × e2b-desktop with a
// computer-use actor), `actors[0].type` IS load-bearing: it must resolve to a registered
// computer-use actor, and that descriptor runs the session. Those routes also consume
// actors[0].{mission,persona,laneFocus.instruction,model,reasoningEffort}, execution.timeoutMs,
// execution.desktop.{browser,resolution,sandboxTimeoutMs}, and (clone)
// subject.{serve,env,state,clone.depth}.
// On the scripted-browser route (app-url × local-or-absent, or clone × e2b-desktop, with a
// registered scripted-browser actor), `actors[0].type` is equally load-bearing, and the route
// consumes scenario.ref (REQUIRED there — the committed scenario's browser steps ARE what the
// actor executes), actors[0].{persona,count}, and execution.timeoutMs. On the provisioned
// clone slice it also consumes subject.{repos,serve,env,state,exposure,clone.depth} and
// execution.desktop.template. actors[0].{mission,laneFocus,model} are inert on that route
// because no model runs, and most execution.desktop.* fields remain forward-declared (device
// presets belong to the cua route — scripted surfaces are the driver's own desktop/mobile
// viewports where isMobile/DSF genuinely RENDER via playwright emulation).
// On the other routes those fields remain FORWARD-DECLARED and NOT yet consumed —
// parseLabConfig emits a warning listing any such field that is set, so `lab inspect` shows
// the truth.
//
// NOTE on actors[0].count: it now carries ROUTE-SPECIFIC meanings — synthetic route: simCount;
// scripted-browser route: surface roster {1 = desktop, 2 = desktop + mobile}, default 1 (the
// defaults-table single-lane row governs; count: 2 is the declared override); computer-use
// E2B route: the HOMOGENEOUS fan-out lane count (N identical lanes, each its own E2B desktop),
// capped at 16; the in-process/local-app cua route stays single lane (no E2B to fan out).
//
// NOTE on actors[0].lanes / actors[0].roster (computer-use E2B route, this slice): a
// DIFFERENTIATED fan-out roster — each `{ id?, persona?, device?, instruction?, target? }` becomes one
// independent E2B desktop (per-lane worlds, the default topology). `roster[]` is parser sugar for
// repeated groups and is normalized into `lanes[]` before the engine sees it. `lanes|roster` XOR
// `count` (declare a differentiated roster OR a homogeneous count, never both); `lanes|roster`
// XOR `actors[0].laneFocus` (per-lane `instruction` is the roster's steer); `lanes[].device` XOR
// raw `execution.desktop.resolution`. `execution.concurrency` bounds in-flight lanes (default
// min(laneCount, 3); env HUMANISH_CUA_MAX_CONCURRENCY may only LOWER it — invariant 3). On every
// non-cua route normalized `lanes` are inert (warned). subject.clone.fanout is REJECTED on the cua
// route. `lanes[].target` is app-url × computer-use ONLY: an absolute browser URL this lane opens
// instead of `subject.appUrl`; it is the generic setup-produced-target handoff, not a service
// topology primitive.
//
// There is deliberately NO v1 compatibility: v1 had zero real users. Breaking schema changes
// bump the version honestly.

import { normalizeExtraExcludeEntry } from "./source-archive.js";
import { actorRegistry } from "./actor-registry.js";
import { containsSensitive } from "./redaction.js";
import type { LabTask } from "./tasks.js";
import { DEVICE_PRESET_NAMES, isDevicePresetName } from "./device-presets.js";
import type { DwellWindow, StopConditionPrimitive, StopWhen, StopWhenRule } from "./stop-conditions.js";
import { isReasoningEffort, reasoningEffortNames, type ReasoningEffort } from "./reasoning-effort.js";
import { isExactRuntimeVersion } from "./terminal-runtime.js";
import { isMaxOutputTokens } from "./output-token-limit.js";

export const LAB_CONFIG_SCHEMA = "humanish.lab.v2";

// Must start alphanumeric so an id never collides with the path-vs-id resolver heuristic
// (a leading "." or "/" is read as a file path; a leading "-" collides with CLI flags).
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Where the run acts: the host repo, a fresh clone, a running app a browser actor drives
 * (`app-url`), an already-running LOCAL dev server driven IN-PROCESS via a custom
 * CuaExecutor with NO clone and NO E2B desktop (`local-app`), or the operator's own local
 * working tree packed and provisioned in-sandbox in place of a clone (`local-tree`).
 * `local-app` routes to the cua backend and is library-assisted: a caller supplies
 * `cuaHooks.buildExecutor` + `buildProvider` (no built-in driver exists yet), and the engine
 * fails closed (HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR) when run without them: a structured
 * error, never a desktop attempt. See docs/architecture/state-driven-executor.md.
 */
export type LabSubjectSource = "this-repo" | "clone" | "app-url" | "local-app" | "terminal-product" | "desktop-cli" | "local-tree";

/**
 * How a subject's WORLD relates across actor lanes. `per-lane-worlds` (the default; absent ==
 * this) is the only fan-out topology the computer-use route ships — N lanes, N independent
 * worlds, isolation + per-lane attribution. `shared-world` (#164) is the DECLARED override: ONE
 * provisioned, mutable service plane that N role SEATS take turns against IN DECLARED ORDER, so
 * their actions interact through shared state. Consumed ONLY on the shared-world route (clone ×
 * e2b-desktop × a computer-use actor); inert/warned everywhere else (invariant 6).
 */
export type LabSubjectTopology = "per-lane-worlds" | "shared-world";

export interface LabSubjectClone {
  /** git clone depth; 1 (shallow) by default. Consumed on the computer-use clone route. */
  depth?: number;
  /** how many independent clone lanes to fan out (one sandbox/desktop each). */
  fanout?: number;
  /** keep the disposable clone for debugging instead of discarding. */
  keep?: boolean;
}

/**
 * `local-tree`: how the operator's own working tree is packed and provisioned in-sandbox in
 * place of a clone. Internal shape (not re-exported from src/index.ts, same as LabSubjectClone).
 */
export interface LabSubjectLocalTree {
  /** extra archive excludes (path prefixes/basenames) added on top of the always-on denylist. */
  exclude?: string[];
  /** keep the disposable sandbox on failure for debugging (mirrors subject.clone.keep). */
  keep?: boolean;
  /** upload size cap override in bytes; default 256 MiB. */
  maxArchiveBytes?: number;
}

/** How a cloned subject is installed/built/started inside the sandbox (computer-use route). */
export interface LabSubjectServe {
  /** Optional bounded install step (e.g. "pnpm install --frozen-lockfile"). */
  install?: string;
  /** Optional bounded build step. */
  build?: string;
  /** Required long-lived start command — launched detached; the sandbox lifecycle owns it. */
  start: string;
  /** Loopback entry URL: the readiness-probe target and the URL the actor drives. The lab
   *  serves the clone INSIDE the sandbox, so this is always loopback (not subject to
   *  allowPublicTargets — that governs app-url subjects, i.e. external deployments). */
  url: string;
  /** Budget for the served app to answer the readiness probe. Default 180000. */
  readyTimeoutMs?: number;
  /** Override the install-step timeout (default 600000). Monorepos can exceed it. */
  installTimeoutMs?: number;
  /** Override the build-step timeout (default 600000). Large builds can exceed it. */
  buildTimeoutMs?: number;
}

/** When a state step runs, relative to the serve sequence (clone subjects, computer-use route). */
export type LabStateStepWhen = "before-build" | "before-start" | "after-ready";

export interface LabSubjectStateStep {
  /**
   * [a-z0-9-] step label (must start alphanumeric), <=40 chars, unique across steps; becomes
   * the detached-step name `subject-state-<name>` (interpolates into in-sandbox file paths —
   * the shape is load-bearing, validated at parse AND re-enforced in the engine).
   */
  name: string;
  /**
   * Author-trusted shell command (same trust class as serve.install/build/start — the
   * "serve commands are author-trusted" corollary). Runs detached in the subject directory
   * with an atomic status file, kill-on-timeout, and a capped log tail. Persisted in
   * evidence as a sha256-16 DIGEST only, never as text.
   */
  command: string;
  /**
   * Phase: before-build (after install — for builds that read the DB, e.g. SSG),
   * before-start (after build, before the server launches — migrations, SQL/file fixtures,
   * an in-sandbox `service postgresql start`), after-ready (after the readiness probe —
   * fixtures loaded through the RUNNING app's API). Default: before-start.
   */
  when?: LabStateStepWhen;
  /** Wall-clock budget per step. Default 300000. */
  timeoutMs?: number;
}

/**
 * A shared-world state CHECKPOINT: an author-trusted, READ-ONLY, AGGREGATE/DIGEST probe command
 * (counts, max-timestamps, hashes) run at baseline and after each role's turn. Reuses the
 * seed-step validation shape (name [a-z0-9-] ≤40, unique; command required). Persisted DIGEST-ONLY
 * (only sha256-16(scrub+redact(stdout)) ever lands — never the raw value), same lockdown as the
 * seed surface. Consumed ONLY on the shared-world route (#164); inert/warned elsewhere.
 */
export interface LabSubjectStateCheckpoint {
  /**
   * [a-z0-9-] probe label (must start alphanumeric), <=40 chars, unique across checkpoints;
   * names the detached step (`checkpoint-<snapshot>-<name>`) — load-bearing shape, validated at
   * parse AND re-enforced in the engine.
   */
  name: string;
  /**
   * Author-trusted READ-ONLY shell command (same trust class as serve/seed — the "serve commands
   * are author-trusted" corollary). Its stdout is scrubbed + pattern-redacted, then digested
   * (sha256-16); the raw value never persists.
   */
  command: string;
  /**
   * Optional extra literal values to scrub from this probe's stdout before digesting (author-known
   * values that may appear in the probe output, beyond the harness-provisioned env values which are
   * always scrubbed). Names/values are NEVER persisted — only the digest is.
   */
  redact?: string[];
}

/** The subject's STATE story (clone subjects): seeded in-sandbox, or declared external. */
export interface LabSubjectState {
  /** Ordered seed/migration/fixture steps. Order within a phase is declaration order. */
  seed?: LabSubjectStateStep[];
  /**
   * Env var NAMES whose values point at state the lab does NOT control (e.g. a shared dev
   * DB). Must be a subset of subject.env (so the declaration is mechanically backed by a
   * provisioned name, not a vibe). Flips state provenance to "unpinned".
   */
  external?: string[];
  /**
   * Shared-world state checkpoints (#164): read-only digest probes run at baseline + after each
   * role's turn to produce the harness-clocked interaction timeline. Consumed ONLY on the
   * shared-world route; inert/warned elsewhere (invariant 6). Shape-validated everywhere.
   */
  checkpoint?: LabSubjectStateCheckpoint[];
}

/**
 * `terminal-product`: the product-under-study a terminal agent must discover and use from PUBLIC
 * SURFACES ONLY (the terminal-product route's subject). The subject is NOT provisioned/cloned —
 * the agent drives the declared public surfaces, so provenance is UNPINNED (invariant 5). The
 * concrete product name + surfaces are operator data; committed fixtures use a NEUTRAL mock name.
 */
export interface LabSubjectProduct {
  /** Public-safe product label (shape-validated like a lab id; interpolates into evidence). */
  name: string;
  /**
   * How the product gets onto the machine, run UNKEYED before the participant starts, in the
   * lane's working directory. Consumed on BOTH product routes: `desktop-cli` (a person at a
   * desktop) and `terminal-product` (an agent in a shell).
   *
   * Absent means the participant installs it themselves from the public surfaces, which is a
   * different study — one about the install, not about the tool. Present means the study starts
   * where you want it to start: asking a participant what studies a project contains, in an empty
   * directory, measures the lab rather than the product.
   */
  install?: string;
  /**
   * `desktop-cli` ONLY: the directory the participant's terminal opens in. Absent means the home
   * directory. (The terminal-product lane has its own fixed study workdir.)
   *
   * This exists because the first live study failed on it: the participant was asked what studies
   * the project contained, landed in an empty home directory, correctly reported that there was no
   * project, and stopped. The finding was about the lab, not the product. A study of a
   * project-scoped tool has to put the participant IN a project, the same way an app study opens
   * the app rather than a blank tab.
   */
  workdir?: string;
  /**
   * The product's PUBLIC surfaces — the only world the agent sees. Each must be an http(s) URL
   * (e.g. a docs page, an llms.txt, a skill manifest). Validated at parse; recorded in evidence.
   */
  publicSurfaces: string[];
  /**
   * `terminal-product` ONLY: a local file uploaded into the sandbox before `install` runs, and
   * exposed to it as `$HUMANISH_PRODUCT_UPLOAD`. A project-relative path; `..` and absolute paths
   * are refused, because this reads a file off the operator's disk and puts it on a machine an
   * autonomous agent is about to drive.
   *
   * It exists so a study can test a build that is NOT PUBLISHED YET. Installing `@latest` measures
   * the last release, which is exactly the wrong artifact for a pre-release gate — the point is to
   * meet the candidate before anyone else does. Any adopter shipping a CLI wants the same thing.
   */
  upload?: string;
}

export interface LabSubject {
  source: LabSubjectSource;
  /**
   * WORLD topology across actor lanes. Absent == `per-lane-worlds` (the isolation default; every
   * existing lab is byte-stable). `shared-world` is the declared override (#164): one mutable
   * service plane, N role seats taking turns. Consumed ONLY on the shared-world route (clone ×
   * e2b-desktop × a computer-use actor + a roster of ≥2 lanes); inert/warned elsewhere.
   */
  topology?: LabSubjectTopology;
  /**
   * CONCURRENT shared-world route ONLY (#164 phase 2): the author's REQUIRED attestation that the
   * subject behind the internet-reachable `getHost` URL is SYNTHETIC seeded data. The concurrent
   * route exposes the subject on a tokenless public URL for the run's duration, so real/external
   * data must never sit behind it. This is author-trust + a provenance gate (verify also requires
   * `subject.state.provenance == "seeded"`), NOT a no-real-data guarantee. Required when
   * `topology: shared-world` + `execution.concurrency > 1`; inert/warned elsewhere.
   */
  exposure?: "synthetic";
  /**
   * EXTERNAL-PUBLIC shared-world route ONLY (#164 phase 2): the author's REQUIRED ownership
   * attestation when a real PUBLIC deployment (`source: app-url` + `topology: shared-world` +
   * `concurrency > 1` + `policies.allowPublicTargets: true`) is used directly as the shared plane.
   * The harness neither provisions nor exposes this target (no getHost, no clone, no seed), so it
   * cannot attest the data is synthetic; instead the operator MUST attest they own/operate it.
   * `owner` is a public-safe operator/repo label; `authorized` must be true. This is author-trust —
   * the harness cannot verify ownership — surfaced honestly in the evidence class. Required on the
   * external-public branch. On a non-`app-url` subject it is REJECTED (parse error); on any OTHER
   * `app-url` config that does not route to external-public shared-world it is IGNORED-WITH-A-WARNING
   * (forwardDeclaredWarnings), never silently consumed — it is meaningless without that plane.
   */
  publicTarget?: { owner: string; authorized: boolean };
  /** `clone`: one or more owner/repo slugs (public or authorized-private). */
  repos?: string[];
  clone?: LabSubjectClone;
  /**
   * `app-url`: a loopback http(s) URL the computer-use actor drives (127.0.0.1/localhost
   * only — driving arbitrary public sites is not allowed). The URL must be reachable from
   * INSIDE the desktop sandbox; library callers provision it via the prepareDesktop hook.
   * For a config-only path use `clone` + `serve` — the lab serves the app itself.
   *
   * `local-app`: the loopback http(s) URL of an already-running LOCAL dev server the caller's
   * custom CuaExecutor drives in-process (no sandbox, no public-target option — always
   * loopback). Passed to `buildExecutor` so the bridge knows where the app lives.
   */
  appUrl?: string;
  /** `clone` (computer-use route): how the cloned app is served in-sandbox. */
  serve?: LabSubjectServe;
  /**
   * Env var NAMES the subject app needs, provisioned into the sandbox from the caller's
   * environment (--env-file). Names are recorded in evidence; values never are. Consumed
   * on the computer-use clone route.
   */
  env?: string[];
  /**
   * LITERAL, NON-SECRET env values committed alongside the lab — the configuration every real app
   * needs before it will boot: a public base URL, a transport selector, a feature flag. None of that
   * is secret, and routing it through `subject.env` would force an adopter to carry a private env
   * file just to reproduce a public study, which is the opposite of a reproducible lab.
   *
   * These values ARE recorded in evidence, because they are part of how the subject was configured,
   * so a value that looks like a secret or a local path is refused at parse rather than committed to
   * a public repo. Anything genuinely secret belongs in `subject.env`.
   */
  envValues?: Record<string, string>;
  /**
   * `clone` (computer-use route): the subject's state story — seed/migration/fixture steps
   * executed in-sandbox around the serve sequence, and/or declared external state. Recorded
   * in the run bundle as structured provenance (invariant 5): seeded with command digests,
   * UNPINNED for external state, declared-not-run for dry-run/failed provisioning.
   */
  state?: LabSubjectState;
  /**
   * `terminal-product` (terminal route): the product the terminal agent discovers + uses from
   * PUBLIC surfaces only. Consumed on the terminal route; rejected on every other source.
   */
  product?: LabSubjectProduct;
  /**
   * `local-tree` (computer-use route): local-tree packs the lab resolution cwd (the project
   * directory humanish runs from) instead of cloning a repo. `exclude` adds extra archive excludes
   * on top of the always-on denylist; `keep` preserves the sandbox on failure for debugging;
   * `maxArchiveBytes` caps the upload. Consumed on the local-tree route; rejected on every other
   * source.
   */
  localTree?: LabSubjectLocalTree;
}

export interface LabActorLaneFocus {
  id?: string;
  label?: string;
  /** Per-lane steer appended to the actor's mission. Consumed on the app-url route. */
  instruction?: string;
}

/**
 * One differentiated fan-out lane on the computer-use E2B route (per-lane worlds). Each lane
 * becomes an independent E2B desktop sandbox with its own persona/device/starting-steer. All
 * fields optional: an omitted persona/device/instruction inherits the actor-level default. `id`
 * defaults to `lane-01`..`lane-NN` and must be a public-safe token (it names per-lane evidence
 * paths). Consumed ONLY on the computer-use E2B route (inert/warned elsewhere).
 */
export interface LabActorLane {
  /** Public-safe lane label (interpolates into per-lane evidence paths). Default lane-NN. */
  id?: string;
  /**
   * App-defined actor type label for grouping simulated users ("operator", "viewer",
   * "maintainer", etc.). This is NOT the execution actor dispatch key (`actors[0].type`);
   * it is adapter-owned taxonomy for roster/readback.
   */
  actorType?: string;
  /** App-defined surface label for grouping lanes that start from different product areas. */
  surface?: string;
  /** App-defined correlation id tying lanes to one shared case/account/work item. */
  caseGroup?: string;
  /** Persona id/label threaded into this lane's actor prompt. Default: actors[0].persona. */
  persona?: string;
  /** Named hosted-screen preset for this lane. XOR raw execution.desktop.resolution. */
  device?: string;
  /** Per-lane steer appended to this lane's mission (the roster's per-lane focus). */
  instruction?: string;
  /**
   * Deterministic lane completion guard. When set, this lane stops as soon as the runtime
   * observation matches any declared rule; actor-level stopWhen is used as the default.
   */
  stopWhen?: StopWhen;
  /** A declared observation window for THIS lane (#510); actor-level dwell is the default. */
  dwell?: DwellWindow;
  /**
   * How hard the model is asked to think in THIS lane; actor-level reasoningEffort is the default.
   *
   * The single-run control: same persona, same mission, two efforts, one set of conditions.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * App-url computer-use ONLY: absolute browser URL this lane opens instead of `subject.appUrl`.
   * This is the generic setup-produced-target handoff for crawler/swarm labs: product adapters may
   * start any topology they need, then hand Humanish explicit lane targets. Public/non-loopback
   * targets still require `policies.allowPublicTargets: true`. Inert/rejected on clone, local-app,
   * shared-world, scripted-browser, and terminal routes.
   */
  target?: string;
  /**
   * Shared-world ONLY (#164): this role's per-seat loopback entry route, resolved against
   * `subject.serve.url` and REQUIRED to be same-origin (loopback) with it — the seat opens
   * `serve.url + entry`. Validated at parse AND re-enforced in the engine. Inert/warned on every
   * non-shared-world route (the per-lane-worlds fan-out roster has no per-lane entry).
   */
  entry?: string;
  /**
   * EXTERNAL-PUBLIC shared-world ONLY (#164 phase 2): marks this lane the DESIGNATED HOST seat — it
   * creates the shared session (e.g. a multiplayer lobby) that the follower seats then join. Exactly
   * ONE lane in the roster may carry `host: true` (validated in externalPublicSharedWorldValidationReason).
   * The orchestrator watches the host seat's observed URL for the shared-session code and threads it
   * into the follower missions at a host-first barrier. Inert/warned on every other route.
   */
  host?: boolean;
}

/**
 * Compact authoring sugar for repeated lane groups. The parser expands each group into concrete
 * `lanes[]` with deterministic ids (`<group.id>-01`, `<group.id>-02`, ...). The runtime never
 * consumes this shape directly; it always sees ordinary `LabActorLane` entries.
 */
export interface LabActorRosterGroup extends Omit<LabActorLane, "id"> {
  /** Public-safe group id; prefixes generated lane ids. */
  id: string;
  /** Number of lanes to generate for this group. */
  count: number;
}

export interface LabActor {
  /**
   * The actor label. On computer-use (including shared-world), scripted-browser, and
   * terminal-product routes this is a REAL dispatch key resolved against the closed first-party
   * actor registry. On synthetic and meta routes it remains a free-form descriptive label (e.g.
   * synthetic-persona or humanish-setup). The terminal route owns its live lifecycle after using
   * the descriptor for dispatch and capability enforcement.
   */
  type: string;
  /** Lane count — route-specific (see HONEST SCOPE header): synthetic simCount; scripted
   *  surface roster {1 = desktop, 2 = desktop + mobile, default 1}; computer-use E2B route the
   *  HOMOGENEOUS fan-out lane count (cap 16). XOR `lanes`. */
  count?: number;
  /** Computer-use E2B route: a DIFFERENTIATED fan-out roster (per-lane worlds). XOR `count`,
   *  `roster`, and `laneFocus`. Cap 16 lanes. Consumed only on the cua E2B route
   *  (inert/warned elsewhere). */
  lanes?: LabActorLane[];
  /** Persona id/label threaded into the actor prompt. Consumed on the app-url route. */
  persona?: string;
  /** Consumed on the app-url route (laneFocus.instruction appended to the mission). XOR `lanes`. */
  laneFocus?: LabActorLaneFocus;
  /** Free-form mission threaded into the actor prompt. Consumed on the app-url route. A mission on
   *  its own is a complete, valid lab — `tasks` is additive, never required. */
  mission?: string;
  /**
   * The researcher's protocol: discrete tasks, each with what the participant is asked to do and
   * (optionally) how the researcher measures it. Additive to `mission`, which stays the brief.
   *
   * The two halves belong to different people. `goal` reaches the participant's prompt; `success`
   * never does — a moderator does not read the success criterion aloud, because telling someone how
   * they will be judged changes what they do. See src/tasks.ts.
   */
  tasks?: LabTask[];
  /** Provider model override. Consumed on the app-url route. */
  model?: string;
  /** First-party OpenAI CUA only: per-response output limit including reasoning, not a dollar cap. */
  maxOutputTokens?: number;
  /**
   * `local-agent` ONLY: which locally signed-in coding agent is the brain. Absent = codex.
   *
   * A separate field from `model` on purpose. The first cut of this route overloaded `model` to
   * mean BOTH which CLI and which model, which left no way to say "Claude Code, running Opus" —
   * two different choices wearing one name.
   */
  localAgent?: "codex" | "claude";
  /**
   * How hard the model is asked to think, per turn. Lane-level `reasoningEffort` overrides this.
   *
   * Absent means the PROVIDER's default, and absence is recorded as absence: a run that did not
   * declare an effort does not claim one. Support is model-dependent (see src/reasoning-effort.ts),
   * so a level a model does not accept fails on the first turn rather than being downgraded.
   *
   * This is a recruiting decision, not a tuning knob: it changes who the participant IS, the same
   * way a persona prompt does. Two lanes running the same persona and mission at different efforts
   * is therefore a CONTRAST between two participants, not a control for an instrument — a lane that
   * abandons at one level and completes at another has reported on both of them. The obligation it
   * creates is to declare and record, never to hold it constant. See
   * docs/principles/actor-fidelity.md.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Deterministic completion guard used as the default for CUA lanes. Lane-level stopWhen
   * overrides this value.
   */
  stopWhen?: StopWhen;
  /**
   * A declared observation window (#510), the default for every lane; lane-level dwell overrides
   * it. `when` is a stopWhen-shaped condition (absent: the window opens after the first
   * observation); `ms` is the hold, `everyMs` the frame cadence (default 10 s), `then` whether
   * the participant continues afterwards (default) or the session ends. The harness takes no
   * action and requests no model turn during the window.
   */
  dwell?: DwellWindow;
}

export type LabExecutionTarget = "local" | "e2b-desktop" | "e2b-terminal";

/** Terminal transport: the captured non-interactive exec stream (stdin disabled). NOT an
 *  interactive duplex PTY — labeling captured exec output "pty" would be a claim/mechanism
 *  mismatch (invariant 6 + the goal packet's PTY ruling), so this lane uses "exec-stream". */
export type LabTerminalTransport = "exec-stream";

/** Whether operator stdin reaches the in-sandbox agent. Disabled by default (the run is
 *  autonomous + comparable to an unassisted baseline). "planned" records intent but sends no
 *  input; "sent" is rejected because assisted-input capture and a non-comparable marker do not
 *  ship (the safety contract forbids an assisted run masquerading as green). */
export type LabTerminalStdin = "disabled" | "planned" | "sent";

export interface LabExecutionTerminal {
  /** Transport label. Default and only shipped value is "exec-stream". */
  transport?: LabTerminalTransport;
  /** Operator stdin posture. Default "disabled". */
  stdin?: LabTerminalStdin;
}

/**
 * The terminal agent's runtime-auth channel. "openai-env" (the default) passes the raw runtime
 * key command-scoped. "openai-egress" keeps it in an E2B outbound header transform for the default
 * OpenAI endpoint and passes an inert placeholder to Codex. The latter still gives every sandbox
 * process a spendable OpenAI proxy capability; it is not a spend cap or an egress restriction.
 */
export type LabRuntimeAuth = "openai-env" | "openai-egress";

export type LabDesktopBrowser = "default" | "chrome" | "chromium" | "firefox";

export interface LabExecutionDesktop {
  /**
   * Named device preset (mobile / small-mobile / narrow-mobile / tablet / desktop / wide) the
   * run renders at. Consumed on the computer-use route; default `desktop` (1440x950). On that
   * route only width/height physically render (the X screen is sized to the preset, so
   * width-based responsive CSS fires) — touch/DPR/UA are sim-parity prompt signals, not rendered.
   */
  device?: string;
  /** Raw hosted screen resolution [width, height] — an escape hatch that overrides `device`. */
  resolution?: [number, number];
  /**
   * Browser family to launch for hosted desktop actor lanes. Absent/default preserves the
   * historical desktop opener behavior. A concrete value means "launch this browser or fail"
   * instead of silently accepting the template's default URL opener.
   */
  browser?: LabDesktopBrowser;
  /** Sandbox server-side timeout. Consumed on the app-url route. */
  sandboxTimeoutMs?: number;
  /**
   * Custom E2B desktop TEMPLATE (image) the run launches on — a non-empty template NAME or ID —
   * instead of the stock `desktop` template. Lets a subject that needs runtimes the stock image
   * lacks (e.g. node/bun/a local Postgres baked into an adopter-maintained image) run as-is. Any
   * string is a valid template name/id (there is no allowlist). Consumed ONLY on the
   * `execution.target: e2b-desktop` computer-use routes (the cua/shared-world/concurrent backends
   * that call `Sandbox.create`); inert/warned on every route that creates no desktop. Threaded to
   * `Sandbox.create(template, opts)`; absent leaves the byte-stable `Sandbox.create(opts)` default.
   * A template name is public-safe (not a secret) and is recorded in the run bundle.
   */
  template?: string;
  /** Use the Codex app-server client mode for headed desktop actor surfaces. Consumed (meta). */
  codexAppServer?: boolean;
  /**
   * Mobile fidelity beyond viewport size (#221). With `mobileEmulation: true`, every hosted
   * Chromium computer-use lane ON A MOBILE PRESET (mobile / small-mobile / narrow-mobile) gets
   * CDP device emulation applied to its launch page before the participant arrives; desktop,
   * tablet and wide lanes in the same run are untouched and carry no fidelity block. Applied: the lane's device preset width/height as the CSS viewport, the preset's
   * device pixel ratio (or `deviceScaleFactor`), touch events (`touch`, default true) and a mobile
   * user agent (`userAgent`, default an iPhone Safari string). The bundle records what the page
   * then reported about itself under `desktopGeometry.fidelity`; a browser that cannot be
   * emulated (Firefox) fails the lane closed instead of shipping a desktop run labelled mobile.
   * Applies to the launch tab; a tab the participant opens later is not emulated.
   */
  fidelity?: LabDesktopFidelity;
  /** Synthetic media devices behind the browser's own permission prompt (#509). */
  media?: LabDesktopMedia;
}

/**
 * A participant with a camera (#509): a property of the ENVIRONMENT, like the screen preset and
 * the browser, never support for any conferencing product. `camera.source: synthetic` generates
 * a test pattern in the sandbox with the image's own ffmpeg; a `.y4m` path on the host is
 * uploaded instead. A microphone needs an image with an audio stack (`execution.desktop.template`);
 * the stock desktop has none, so a declared microphone without a template is refused at parse
 * time, before any spend.
 */
export interface LabDesktopMedia {
  camera?: { source: string };
  microphone?: { source: string };
}

export interface LabDesktopFidelity {
  mobileEmulation: boolean;
  /** Emulated devicePixelRatio; default: the device preset's. */
  deviceScaleFactor?: number;
  /** Emulate touch (coarse pointer, touch events); default true. */
  touch?: boolean;
  /** Full user-agent string to present; default: a mobile Safari string. */
  userAgent?: string;
}

export interface LabExecution {
  target?: LabExecutionTarget;
  /** Actor session wall-clock budget. Consumed on the app-url route. */
  timeoutMs?: number;
  /** FORWARD-DECLARED. */
  completionTimeoutMs?: number;
  /** FORWARD-DECLARED. */
  concurrency?: number;
  desktop?: LabExecutionDesktop;
  /**
   * Blast-radius budget for the computer-use lane. CONSUMED on the CUA route: `caps.maxUsd`, when
   * set, is a FAIL-CLOSED abort — the session stops the moment its running ESTIMATED spend crosses
   * it (the runaway-retry guard), and a cap on a model src/pricing.ts cannot price is REFUSED at
   * preflight rather than run uncapped. It is a PER-LANE cap: enforced inside each lane's loop, so
   * an N-lane fan-out can spend up to N × maxUsd before any lane aborts (the run warns with the
   * true ~N × cap ceiling). `caps.maxTotalUsd` is the shared STUDY budget (#299): one ledger
   * across every lane, the knob a researcher actually reasons with. Absent = UNCAPPED (the
   * historical CUA behavior); maxUsd: 0 = no-spend (any measurable estimate > 0 aborts). Inert
   * (warned) on non-CUA routes. Reuses the same LabScenarioCaps shape as the terminal lane's
   * `scenario.caps` (not a fork).
   */
  caps?: LabScenarioCaps;
  /** `terminal-product` route: the terminal transport + stdin posture. Consumed on that route. */
  terminal?: LabExecutionTerminal;
  /** `terminal-product` route: runtime key placement, defaulting to openai-env. openai-egress
   *  uses an external header transform; dry-runs record declarations only. Inert on other routes. */
  runtimeAuth?: LabRuntimeAuth;
  /** Terminal Codex package pin. Omit to resolve latest once, observe it, then execute that version. */
  runtime?: { version: string };
  /**
   * `terminal-product` route: outbound routing allowlist passed to E2B with a deny-all fallback.
   * Domain filtering is a routing control, not strict destination isolation on shared hosting.
   * It does not constrain spending through an allowed runtime provider (#538), including when
   * openai-egress keeps the raw runtime key outside the sandbox.
   *
   * Absent means unrestricted, which is the historical behavior and stays the default, because a
   * wrong host list fails studies in ways that look like product bugs. Opt in per lab.
   *
   * Domain filtering covers HTTP on :80 (Host header) and TLS on :443 (SNI); anything else needs
   * an IP or CIDR. `*.example.com` matches subdomains at any depth and NOT the apex, which needs
   * its own entry.
   */
  egressAllow?: string[];
}

export type LabScenarioMode = "dry-run" | "live";

/**
 * The blast-radius budget for a route that passes a live key to an in-sandbox command.
 * Per the safety contract, the live key is never exercised without a fail-closed cap in force.
 * All values are non-negative numbers (0 is the no-spend default). Live runs require maxUsd and a
 * positive maxMinutes; maxUsd/maxJobs are enforced against known ledger signals and maxMinutes is
 * enforced as the command wall clock.
 */
export interface LabScenarioCaps {
  /** Max USD the run may spend (provider + product). 0 = no-spend. */
  maxUsd?: number;
  /**
   * STUDY-LEVEL model-spend budget (#299), the number a researcher actually reasons with: "this
   * study is N participants, roughly $X" — decided once, up front, where recruiting decisions are
   * made. Consumed on the CUA route: every lane's running ESTIMATED model spend feeds one shared
   * ledger, and the moment the run total crosses this, each lane stops at its next turn with an
   * honest `budget_reached` (status `incomplete` — the participant ran out of budget; never
   * `gave_up`, because a study-level stop is not the participant's doing). Estimated MODEL spend
   * only — desktop-minutes ride the cost summary but not this ledger. Independent of the per-lane
   * `maxUsd` backstop; either, both, or neither may be set. Inert (warned) on the terminal route,
   * where the single agent's maxUsd already caps the whole run.
   */
  maxTotalUsd?: number;
  /** Max billable product jobs the agent may trigger. 0 = none. */
  maxJobs?: number;
  /** Max wall-clock minutes for the agent session. */
  maxMinutes?: number;
}

export interface LabScenario {
  /** Reference a committed scenario by id (humanish/scenarios/<ref>.yaml) or path. CONSUMED
   *  (and REQUIRED) on the scripted-browser route; FORWARD-DECLARED elsewhere. */
  ref?: string;
  /** Or inline the scenario body. FORWARD-DECLARED (PR #2). */
  inline?: Record<string, unknown>;
  /** dry-run = contract evidence (no provider spend); live = real run. Consumed. */
  mode?: LabScenarioMode;
  /** Spend/job/time caps. Consumed (recorded in the bundle) on the terminal-product route;
   *  inert (warned) elsewhere. */
  caps?: LabScenarioCaps;
}

export interface LabPolicies {
  /**
   * Redact target repo labels in durable artifacts. Consumed on the meta route and on the
   * computer-use clone route (provenance), where it DEFAULTS to true when the clone
   * authenticates via GITHUB_TOKEN (a token-bearing clone is treated as private until
   * declared otherwise).
   */
  redactRepos?: boolean;
  /**
   * Blur+downscale persisted screenshots on the computer-use route. Default FALSE — the common
   * case is watching a sim of your OWN app locally (gitignored .humanish), where full fidelity is
   * the deliverable. Set true for unowned subjects or bundles meant to be shared as-is. The
   * provider always sees raw frames; this only governs what is persisted. Raw bundles stay
   * local (gitignored, commit-scan-guarded); a redact-on-export step for them is planned.
   */
  redactScreenshots?: boolean;
  /**
   * Allow an app-url subject to point at a non-loopback (public/preview/staging) URL the lab
   * owner declares. Default FALSE (loopback-only). The invariant is "the actor drives a target
   * the owner declared" — setting this IS that declaration (e.g. a Vercel preview of your app).
   */
  allowPublicTargets?: boolean;
  /**
   * How the browser's camera/microphone permission is answered (#509). `prompt` (default): the
   * participant meets Chrome's real dialog and answers it, which is where a real person hesitates
   * or refuses. `granted`: the dialog is bypassed (`--use-fake-ui-for-media-stream`, which Chrome
   * marks with an "unsupported command-line flag" banner), for studies about what happens after
   * the gate.
   */
  mediaPermission?: "prompt" | "granted";
  /**
   * Terminal-product credential-boundary declarations — all DEFAULT FALSE (deny-by-default). The
   * shipped live engine always passes only the runtime LLM key, command-scoped, and records these
   * booleans as evidence. Setting one true records intent but does not create an injection channel
   * or authorize any additional credential in the current route.
   */
  /** Recorded private-repo-access intent. No private-repo provisioning channel ships. */
  allowPrivateRepoAccess?: boolean;
  /** Recorded provider-credential intent. No provider-credential injection channel ships. */
  allowProviderCredentials?: boolean;
  /** Recorded payment-credential intent. No payment-credential injection channel ships. */
  allowPaymentCredentials?: boolean;
  /** Recorded GitHub-mutation intent. No GitHub-token injection channel ships. */
  allowGitHubMutation?: boolean;
}

export interface LabReview {
  /** FORWARD-DECLARED (PR #2). */
  scoring?: string;
  /** FORWARD-DECLARED (PR #2). */
  milestones?: string;
  /** FORWARD-DECLARED (PR #2). */
  vocabulary?: string;
  /**
   * #316 code escape hatch: a repo-relative path to an adopter scorer module (.mjs recommended) that
   * exports any of `{score, deriveFeedback, deriveArtifacts}`. CONSUMED on the scorer-capable routes
   * (terminal / computer-use / shared-world); loaded fail-closed (typed error, pre-spend). The entry
   * is executable code — review a PR that adds one as code, not config.
   */
  scorer?: { ref: string };
}

export interface LabDefaults {
  open?: boolean;
}

/** Off-app comms (email/SMS the persona lives in) the harness provides for the run (#297). */
export interface LabComms {
  email?: LabCommsEmail;
}

export interface LabCommsSmtp {
  /** Fixed in-sandbox loopback SMTP port (default 2525). Known before sandbox create, like `port`. */
  port?: number;
  /** The subject-env var carrying the SMTP host. The harness sets it to 127.0.0.1. */
  hostEnv: string;
  /** The subject-env var carrying the SMTP port. The harness sets it to the port above. */
  portEnv: string;
  /** Optional subject-env vars for a username/password the app insists on sending. The catch accepts
   *  any credentials (it is loopback-only), but many apps refuse to start without the vars set. */
  userEnv?: string;
  passwordEnv?: string;
  /** The value written to `userEnv`/`passwordEnv` when those are declared. Never a real secret. */
  user?: string;
  password?: string;
}

export interface LabCommsEmail {
  /** Which implementation backs the inbox (a backend discriminator, distinct from `scenario.mode`):
   *  `fake` (default) is an in-harness in-memory inbox in the Fowler test-double sense — an in-sandbox
   *  catch captures the app's sends and nothing leaves the machine. `real` (provider-backed) is not yet
   *  supported and is rejected at parse; when it lands it will carry a `provider` alongside `kind`. */
  kind: "fake";
  /**
   * The subject-env var the harness sets to the in-sandbox catch's base URL — ADOPTER-NAMED (an app
   * calling Resend's API directly reads `RESEND_API_URL`; an app using the SDK reads `RESEND_BASE_URL`).
   * The value is computed by the harness (a loopback URL), so it is NOT declared in `subject.env`.
   * REQUIRED on the provisioned routes; absent (and meaningless) when `external` is declared,
   * because there the adopter runs the catch and points their own app at it.
   */
  injectEnv?: string;
  /** Fixed in-sandbox loopback port the catch listens on (default 8025). Known before sandbox create. */
  port?: number;
  /**
   * SMTP transport, for the many self-hostable apps that send mail through SMTP rather than a
   * provider's HTTP API. The catch opens a loopback SMTP listener and normalizes what it receives
   * into the same captured-send shape the HTTP path produces, so the inbox surface, the drain, and
   * the evidence artifact are identical either way.
   *
   * `hostEnv` and `portEnv` are ADOPTER-NAMED, exactly like `injectEnv`: the harness sets them to
   * its own loopback and the chosen port. Declare the pair your app actually reads.
   */
  smtp?: LabCommsSmtp;
  /** Optional escape hatch: the exact absolute origin the app-under-test bakes into its email verify
   *  links, when that differs from the serve origin (e.g. an app configured with an absolute
   *  APP_URL/NEXT_PUBLIC_BASE_URL). The harness cannot infer it, so the operator declares it; it is
   *  prepended to the inbox link-origin rewrite so the persona's clicked link resolves to a reachable
   *  host. Omit when the app emits loopback links (the default derivation covers those). */
  linkOrigin?: string;
  /** Each lane's inbox address: the actor is TOLD to sign up with it (the injected inbox
   *  instruction carries it) and the teardown drain matches captured mail against it. Omit the
   *  whole list and the parser fills one deterministic address per lane (`<laneId>@example.test`)
   *  so every seat can do email out of the box (#351). When declared: a `lane` naming a lane that
   *  does not exist is a hard parse error (a mismatch silently disables the funnel for that seat),
   *  zero covered lanes is a hard error, and partial coverage warns with the uncovered lanes. An
   *  entry without `address` is legal but inert for the funnel — it is NOT matched by the drain
   *  and its lane gets no inbox instruction; captured mail to an undeclared address is warned,
   *  never silently dropped. */
  recipients?: LabCommsRecipient[];
  /**
   * ADOPTER-HOSTED ingress (#328). Declaring this says: the operator runs the catch and the inbox
   * themselves, so humanish neither provisions the subject nor injects `injectEnv` — it points the
   * persona at the declared inbox, drains the declared catch over HTTP at teardown, and writes the
   * same digest-only evidence. This is what makes comms work on the app-url / operator-provisioned
   * plane, where humanish holds no sandbox handle to host a catch in and the block was previously
   * warned inert. Run the same implementation with `humanish comms catch`.
   */
  external?: LabCommsExternal;
}

export interface LabCommsExternal {
  /** Where the adopter's app POSTs its email sends, and where humanish reads GET /deliveries. */
  catchBaseUrl: string;
  /** Where the persona opens its inbox. Defaults to catchBaseUrl (one server serves both). */
  inboxBaseUrl?: string;
  /** Env var NAME holding the bearer token for the drain read. The NAME is recorded as evidence;
   *  the value is read at runtime and never persisted (the credential-boundary discipline). */
  authTokenEnv?: string;
}

export interface LabCommsRecipient {
  lane: string;
  /** The literal address the app sends to — what the evidence drain matches. Omit to reserve the lane
   *  for the persona surface's default address (not drain-matched). */
  address?: string;
}

export interface LabConfig {
  schema: typeof LAB_CONFIG_SCHEMA;
  id: string;
  title?: string;
  description?: string;
  subject: LabSubject;
  actors: LabActor[];
  execution?: LabExecution;
  /** FORWARD-DECLARED (PR #2). */
  personas?: Record<string, unknown>[];
  scenario?: LabScenario;
  policies?: LabPolicies;
  review?: LabReview;
  defaults?: LabDefaults;
  comms?: LabComms;
}

export interface LabConfigParseSuccess {
  ok: true;
  config: LabConfig;
  warnings: string[];
}

export interface LabConfigParseFailure {
  ok: false;
  error: { code: "HUMANISH_LAB_INVALID"; message: string };
}

export type LabConfigParseResult = LabConfigParseSuccess | LabConfigParseFailure;

/**
 * Validate a parsed YAML object into a LabConfig. Pure: the caller owns file IO. Structural
 * validation only. Fields the engine does not yet consume are accepted but reported in
 * `warnings` so `lab inspect` never silently swallows a setting that does nothing.
 */
export function parseLabConfig(raw: unknown): LabConfigParseResult {
  if (!isRecord(raw)) {
    return invalid("Lab manifest must be a YAML object.");
  }
  if (raw.schema !== LAB_CONFIG_SCHEMA) {
    return invalid(`Lab schema must be ${LAB_CONFIG_SCHEMA}.`);
  }

  const id = str(raw.id);
  if (!id || !ID_PATTERN.test(id)) {
    return invalid("Lab id must be a public-safe token starting with a letter or digit (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).");
  }

  const subjectResult = parseSubject(raw.subject);
  if (!subjectResult.ok) {
    return subjectResult;
  }

  const actorsResult = parseActors(raw.actors);
  if (!actorsResult.ok) {
    return actorsResult;
  }

  const executionResult = parseExecution(raw.execution);
  if (!executionResult.ok) {
    return executionResult;
  }

  const config: LabConfig = {
    schema: LAB_CONFIG_SCHEMA,
    id,
    ...optionalStr("title", raw.title),
    ...optionalStr("description", raw.description),
    subject: subjectResult.value,
    actors: actorsResult.value,
    ...(executionResult.value ? { execution: executionResult.value } : {})
  };

  const personas = parsePersonas(raw.personas);
  if (personas) config.personas = personas;
  const scenarioResult = parseScenario(raw.scenario);
  if (!scenarioResult.ok) {
    return scenarioResult;
  }
  if (scenarioResult.value) config.scenario = scenarioResult.value;
  if (isRecord(raw.policies) && raw.policies.mediaPermission !== undefined && raw.policies.mediaPermission !== "prompt" && raw.policies.mediaPermission !== "granted") {
    return invalid("`policies.mediaPermission` must be `prompt` (the participant answers the browser's own dialog) or `granted`.");
  }
  const policies = parsePolicies(raw.policies);
  if (policies) config.policies = policies;
  const reviewResult = parseReview(raw.review);
  if (!reviewResult.ok) return reviewResult;
  if (reviewResult.value) config.review = reviewResult.value;
  const defaults = parseDefaults(raw.defaults);
  if (defaults) config.defaults = defaults;
  const commsResult = parseComms(raw.comms);
  if (!commsResult.ok) return commsResult;
  if (commsResult.value) config.comms = commsResult.value;

  const outputLimitReason = outputTokenLimitValidationReason(config);
  if (outputLimitReason) return invalid(outputLimitReason);

  // All-parallel default (#350): a multi-seat computer-use lab that does not declare
  // execution.concurrency runs EVERY seat at once — the declared field is a cap the author chose,
  // never a mode. A throttle default silently turned "N actors live" into waves of 3 in the field;
  // total sessions and spend are identical either way, only simultaneity differs, so the default
  // follows the author's roster. Resolved here at parse time so routing (sequential vs concurrent
  // shared-world), validation, warnings, and both engines all see one explicit number. The
  // sequential shared-world PoC stays available as an explicit choice: `execution.concurrency: 1`.
  {
    const seats = config.actors[0]?.lanes?.length ?? config.actors[0]?.count ?? 1;
    if (seats > 1 && config.execution?.concurrency === undefined && routesToComputerUse(config)) {
      config.execution = { ...(config.execution ?? {}), concurrency: seats };
    }
  }

  // Email that just works (#351): the funnel's ONLY handoff to an actor is the per-lane inbox
  // instruction, gated on recipients[]. Guessed lane names broke a field run — recipients copied
  // from a single-lane example matched nothing, so every actor was left inbox-blind with zero
  // signal. Omitted recipients are therefore FILLED (one deterministic address per lane); a
  // recipient naming an unknown lane is a hard error listing the real lane ids; declared
  // recipients covering zero lanes are a hard error (a guaranteed-dead funnel).
  if (config.comms?.email && routesToComputerUse(config)) {
    const laneIds = effectiveComputerUseLaneIds(config);
    const email = config.comms.email;
    if (email.recipients === undefined) {
      email.recipients = laneIds.map((lane) => ({ lane, address: `${lane.toLowerCase()}@example.test` }));
    } else {
      const unknown = email.recipients.filter((recipient) => !laneIds.includes(recipient.lane));
      if (unknown.length > 0) {
        return invalid(
          `comms.email.recipients name lane(s) that do not exist: ${unknown.map((r) => `"${r.lane}"`).join(", ")}. This lab's lane ids are: ${laneIds.join(", ")}. A recipient's lane must match one of them exactly — the inbox instruction is injected per lane, and a mismatch disables the email funnel for that seat.`
        );
      }
      if (!email.recipients.some((recipient) => recipient.address !== undefined)) {
        return invalid(
          "comms.email.recipients cover no lane with an address — no actor would be told an inbox exists and no captured mail could match. Give at least one recipient an address, or omit `recipients` entirely (every lane then gets a deterministic address automatically)."
        );
      }
    }
  }

  // this-repo subjects run locally and dry-run only — there is no live execution target for the
  // host repo (clone/app-url provide that). Reject the mis-configs rather than silently mishandle.
  if (config.subject.source === "this-repo") {
    if (config.execution?.target) {
      return invalid("`execution.target` applies only to clone/app-url/local-app subjects; this-repo labs run locally.");
    }
    if (config.scenario?.mode === "live") {
      return invalid("this-repo labs are dry-run only; use a clone or app-url subject for a live run.");
    }
  }

  // local-app route: an already-running LOCAL dev server driven IN-PROCESS via a custom
  // CuaExecutor (no clone, no E2B desktop). Parse-validated fail-closed: a computer-use actor
  // only, execution.target local or absent (NEVER e2b-desktop — the whole point is to skip the
  // desktop), and no public-target policy (it is always loopback; the loopback shape was already
  // enforced in parseSubject). The actual "no buildExecutor hook supplied" case is inherently an
  // engine-time decision (the parser cannot know whether a library caller will pass hooks), so
  // it fails closed in runCuaActorLab with HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR.
  if (config.subject.source === "local-app") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "local") {
      return invalid("local-app subjects drive an in-process LOCAL dev server with NO E2B desktop — set `execution.target: local` or omit it (absent means local); `e2b-desktop` is rejected (use an app-url subject for the hosted-desktop route).");
    }
    if (!actorResolvesToComputerUse(type)) {
      return invalid(`actors[0].type must be a registered computer-use actor for local-app subjects (one of: ${registeredComputerUseActors().join(", ")}); the caller's custom executor runs the computer-use loop. Got "${type}".`);
    }
    if (cuaLaneCount(config) > 1) {
      return invalid("Multi-lane fan-out is not supported on the in-process/local-app route — fan-out provisions one independent E2B desktop per lane, which the in-process route deliberately skips; set actors[0].count to 1 and drop actors[0].lanes (use an app-url or clone subject on execution.target: e2b-desktop for fan-out).");
    }
    if (config.actors[0]?.lanes !== undefined) {
      return invalid("`actors[0].lanes` (fan-out roster) is not supported on the in-process/local-app route — it provisions one E2B desktop per lane, which this route skips. Use an app-url or clone subject with execution.target: e2b-desktop.");
    }
    if (config.policies?.allowPublicTargets === true) {
      return invalid("`policies.allowPublicTargets` is not supported on the local-app route — a local-app subject is always a loopback dev server; there is no public target to allow.");
    }
  }

  // app-url routes: the actor type is a REAL dispatch key (registry-resolved). The actor LANE
  // picks the substrate: a scripted-browser actor runs locally against the declared loopback
  // app; a computer-use actor drives a hosted desktop browser. Fail closed on mis-configs.
  if (config.subject.source === "app-url") {
    const type = config.actors[0]?.type ?? "";
    if (actorResolvesToScriptedBrowser(type)) {
      // Scripted-browser route (all fail-closed: invariant 6 — a field that cannot act on
      // this route is rejected, never silently ignored).
      if (config.execution?.target !== undefined && config.execution.target !== "local") {
        return invalid("scripted-browser actors run on the operator's machine — set `execution.target: local` or omit it (absent means local); in-sandbox scripted execution is a later slice.");
      }
      if (!config.scenario?.ref) {
        return invalid("scripted-browser labs require `scenario.ref` — the committed scenario's browser steps are what this actor executes; there is no built-in fallback on the lab route.");
      }
      if ((config.actors[0]?.count ?? 1) > 2) {
        return invalid("scripted-browser labs support actors[0].count of 1 (desktop surface) or 2 (desktop + mobile); larger fan-out is a later slice.");
      }
      if (config.policies?.redactScreenshots === true) {
        return invalid("`policies.redactScreenshots: true` is not implemented on the scripted-browser route yet — screenshots persist raw in gitignored .humanish; a silently ignored redaction policy would be a safety lie, so it is rejected.");
      }
      if (config.policies?.allowPublicTargets === true) {
        return invalid("`policies.allowPublicTargets` is not supported on the scripted-browser route — the scripted step driver enforces loopback at every navigation; public targets on this route are a later slice.");
      }
      if (!isLoopbackUrl(config.subject.appUrl ?? "")) {
        return invalid("`subject.appUrl` must be a loopback URL (127.0.0.1/localhost) on the scripted-browser route.");
      }
    } else {
      if (config.execution?.target !== "e2b-desktop") {
        return invalid("app-url subjects require `execution.target: e2b-desktop` with a registered computer-use actor (the actor drives a hosted desktop browser), or a registered scripted-browser actor for local execution.");
      }
      if (!actorResolvesToComputerUse(type)) {
        return invalid(`actors[0].type must be a registered computer-use actor for app-url × e2b-desktop labs (one of: ${registeredComputerUseActors().join(", ")}); for local scripted execution use a registered scripted-browser actor (${registeredScriptedBrowserActors().join(", ")}). Got "${type}".`);
      }
      // Multi-lane fan-out is CONSUMED on this route (per-lane worlds; the shared cua-lane
      // cross-validation below enforces lanes/count XOR rules, the 16 cap, and the
      // lane-level target gates, and the allowPublicTargets+N>1 rejection for ambiguous one-target
      // fan-out).
      // Loopback by default; an owner may declare a public/preview target via policies.
      const laneTargets = declaredLaneTargets(config);
      const declaredTargets = [config.subject.appUrl ?? "", ...laneTargets];
      const unsafeTarget = declaredTargets.find((target) => !config.policies?.allowPublicTargets && !isLoopbackUrl(target));
      if (unsafeTarget !== undefined) {
        return invalid("`subject.appUrl` and `actors[0].lanes[].target` must be loopback URLs (127.0.0.1/localhost) unless `policies.allowPublicTargets: true` is set — set it to drive deployed/preview URLs you own.");
      }
    }
  } else if (actorResolvesToScriptedBrowser(config.actors[0]?.type)) {
    if (config.subject.source !== "clone") {
      return invalid("scripted-browser actors require `subject.source: app-url` (a running app at a loopback URL) or `subject.source: clone` with `execution.target: e2b-desktop` (a provisioned synthetic subject).");
    }
    if (config.execution?.target !== "e2b-desktop") {
      return invalid("clone subjects with scripted-browser actors require `execution.target: e2b-desktop` — the lab provisions the clone in E2B, exposes it with getHost, then drives deterministic browser steps.");
    }
    if (!config.subject.serve) {
      return invalid("clone subjects with scripted-browser actors require `subject.serve` (start + url) — the lab serves the app in-sandbox before the scripted browser drives it.");
    }
    if ((config.subject.repos?.length ?? 0) !== 1) {
      return invalid("clone scripted-browser labs require exactly one repo in subject.repos.");
    }
    const repo = config.subject.repos?.[0] ?? "";
    if (!REPO_SLUG_PATTERN.test(repo)) {
      return invalid(`subject.repos[0] must be an owner/repo slug (got "${repo}").`);
    }
    if (config.subject.topology !== undefined) {
      return invalid("clone scripted-browser labs do not support `subject.topology` yet — this slice provisions one synthetic subject and one deterministic scripted actor roster, not a shared-world run.");
    }
    if (config.subject.clone?.fanout !== undefined || config.subject.clone?.keep === true) {
      return invalid("clone scripted-browser labs do not support `subject.clone.fanout` or `subject.clone.keep` yet — the provisioned subject is always a single disposable E2B sandbox.");
    }
    if (!config.scenario?.ref) {
      return invalid("scripted-browser labs require `scenario.ref` — the committed scenario's browser steps are what this actor executes; there is no built-in fallback on the lab route.");
    }
    if ((config.actors[0]?.count ?? 1) > 2) {
      return invalid("scripted-browser labs support actors[0].count of 1 (desktop surface) or 2 (desktop + mobile); larger fan-out is a later slice.");
    }
    if (config.actors[0]?.lanes !== undefined) {
      return invalid("`actors[0].lanes` is not supported on the scripted-browser route yet — use actors[0].count for the deterministic surface roster.");
    }
    if (config.policies?.redactScreenshots === true) {
      return invalid("`policies.redactScreenshots: true` is not implemented on the scripted-browser route yet — screenshots persist raw in gitignored .humanish; a silently ignored redaction policy would be a safety lie, so it is rejected.");
    }
    if (config.policies?.allowPublicTargets === true) {
      return invalid("`policies.allowPublicTargets` is not supported on the clone scripted-browser route — the only external host is the harness-minted getHost URL for a provisioned synthetic subject.");
    }
    if (config.subject.exposure !== "synthetic") {
      return invalid("clone scripted-browser labs require `subject.exposure: synthetic` — the subject is exposed on an internet-reachable getHost URL for the run, so the author must attest it is synthetic seeded data.");
    }
    if (!config.subject.state?.seed || config.subject.state.seed.length === 0 || (config.subject.state.external?.length ?? 0) > 0) {
      return invalid("clone scripted-browser labs require `subject.state.seed` and do not allow `subject.state.external` — getHost-exposed subjects must be synthetic seeded data, not external/unpinned state.");
    }
    if (!config.subject.serve.start.includes("0.0.0.0")) {
      return invalid("clone scripted-browser labs require `subject.serve.start` to bind all interfaces (e.g. `-H 0.0.0.0` / `--host 0.0.0.0` / `HOST=0.0.0.0`) — getHost only routes to a 0.0.0.0-bound port; the readiness probe stays loopback.");
    }
  }

  // clone × e2b-desktop disambiguates on the actor lane: a computer-use actor means the lab
  // clones AND serves the subject in-sandbox, then drives it (the meta route otherwise).
  if (config.subject.source === "clone" && config.execution?.target === "e2b-desktop"
    && actorResolvesToComputerUse(config.actors[0]?.type)) {
    if (!config.subject.serve) {
      return invalid("clone subjects on the computer-use route require `subject.serve` (start + url) — the lab serves the app in-sandbox before the actor drives it.");
    }
    if ((config.subject.repos?.length ?? 0) !== 1) {
      return invalid("computer-use clone labs run a single lane; declare exactly one repo in subject.repos.");
    }
    const repo = config.subject.repos?.[0] ?? "";
    if (!REPO_SLUG_PATTERN.test(repo)) {
      return invalid(`subject.repos[0] must be an owner/repo slug (got "${repo}").`);
    }
    // Fan-out is CONSUMED here: N lanes each clone the SAME single repo into their own E2B
    // desktop (per-lane worlds). The shared cua-lane cross-validation below enforces the
    // lanes/count rules and the 16 cap; the single-repo rule above is unchanged.
  }

  // local-tree route: packs and uploads the operator's own working tree, then serves it exactly
  // like a computer-use clone subject. There is no smoke/meta/scripted equivalent for a packed
  // working tree in this slice, so e2b-desktop + a computer-use actor are the ONLY combination
  // this source supports. `subject.serve` is already required at parse time (parseSubject); the
  // repos/clone rejection also already happened there (local-tree never carries git slugs).
  if (config.subject.source === "local-tree") {
    if (config.execution?.target !== "e2b-desktop") {
      return invalid("local-tree subjects require `execution.target: e2b-desktop`: the packed working tree is provisioned and served inside a hosted desktop sandbox; there is no local/smoke route for a local-tree subject.");
    }
    if (!actorResolvesToComputerUse(config.actors[0]?.type)) {
      return invalid(`actors[0].type must be a registered computer-use actor for local-tree subjects (one of: ${registeredComputerUseActors().join(", ")}); the actor drives the hosted desktop that serves the packed working tree. Got "${config.actors[0]?.type ?? ""}".`);
    }
  }

  // Shared computer-use fan-out cross-validation (per-lane worlds, the only topology this
  // slice). Runs for every route that resolves to the cua backend (app-url, clone, local-app).
  // The in-process/local-app route already forced a single lane above, so this is a no-op there
  // beyond rejecting the same fields; on the E2B routes it enforces the roster contract.
  if (routesToComputerUse(config)) {
    const reason = cuaLaneValidationReason(config);
    if (reason) {
      return invalid(reason);
    }
  }

  // Shared-world topology cross-validation (#164). Runs whenever shared-world is DECLARED (not just
  // when it routes), so a half-declared shared-world fails closed with a precise reason rather than
  // silently downgrading to a per-lane-worlds cua run. With `execution.concurrency > 1` the
  // concurrent extras (synthetic-subject attestation, 0.0.0.0 serve bind, no clone.keep) also apply.
  if (config.subject.topology === "shared-world") {
    const reason = config.subject.source === "app-url"
      // The external-public plane (a real public deployment as the shared plane): NEVER the getHost
      // synthetic gate — that gate exists because getHost is internet-reachable AND harness-owned; a
      // public site the harness neither provisioned nor exposed has neither property.
      ? externalPublicSharedWorldValidationReason(config)
      : (config.execution?.concurrency ?? 1) > 1
        ? concurrentSharedWorldValidationReason(config)
        : sharedWorldValidationReason(config);
    if (reason) {
      return invalid(reason);
    }
  }

  // desktop-cli route: a computer-use participant studies a CLI/TUI the way a person does — at a
  // desktop, in a terminal window, by looking at it. The sibling of terminal-product, and the
  // distinction is the POPULATION, not the product: terminal-product sends an autonomous agent
  // through a pipe with stdin disabled, which is the honest way to study what an agent meets and
  // structurally cannot study an interactive surface. This route sends someone who can see it.
  //
  // Fail-closed on the pairing (invariant 6): a hosted desktop and a computer-use actor, because
  // "watch a person use a terminal" is not something the other substrates can do.
  if (config.subject.source === "desktop-cli") {
    if (config.subject.product?.name === undefined) {
      return invalid("desktop-cli subjects need `subject.product.name` — the CLI the participant is being asked to use.");
    }
    if (config.execution?.target !== undefined && config.execution.target !== "e2b-desktop") {
      return invalid("desktop-cli subjects are studied at a hosted desktop — set `execution.target: e2b-desktop` or omit it.");
    }
    if (!actorResolvesToComputerUse(config.actors[0]?.type ?? "")) {
      return invalid("desktop-cli subjects need a registered computer-use actor: the participant reads the screen and types, which is what makes an interactive surface studiable at all.");
    }
    const install = config.subject.product.install;
    if (install !== undefined && install.trim().length === 0) {
      return invalid("`subject.product.install` must be a non-empty command when set (omit it to study the install itself).");
    }
  }

  // terminal-product route: a real autonomous agent studies a CLI/product from PUBLIC surfaces
  // inside an E2B shell. Fail-closed (invariant 6 — a field that cannot act on this route is an
  // honest parse error): a registered terminal actor only, execution.target e2b-terminal or absent
  // (absent defaults to e2b-terminal — the only honest target for an in-sandbox agent), single
  // lane until fan-out lands.
  if (config.subject.source === "terminal-product") {
    const type = config.actors[0]?.type ?? "";
    if (config.execution?.target !== undefined && config.execution.target !== "e2b-terminal") {
      return invalid("terminal-product subjects run the agent inside an E2B shell — set `execution.target: e2b-terminal` or omit it (absent means e2b-terminal); `local`/`e2b-desktop` are rejected.");
    }
    if (!actorResolvesToTerminal(type)) {
      return invalid(`actors[0].type must be a registered terminal actor for terminal-product subjects (one of: ${registeredTerminalActors().join(", ")}). Got "${type}".`);
    }
    if ((config.actors[0]?.count ?? 1) > 1) {
      return invalid("Multi-lane terminal fan-out is not supported yet; set actors[0].count to 1.");
    }
  } else if (config.execution?.target === "e2b-terminal") {
    // e2b-terminal is the terminal-product substrate ONLY. Any other source declaring it is a
    // mis-config — reject, never silently mishandle (mirrors app-url's e2b-desktop pairing rule).
    return invalid("`execution.target: e2b-terminal` requires `subject.source: terminal-product` with a registered terminal actor.");
  } else if (actorResolvesToTerminal(config.actors[0]?.type)) {
    // A registered terminal actor on a non-terminal-product subject: rejected, never ignored (the
    // terminal agent only studies a declared terminal-product from public surfaces).
    return invalid("terminal actors require `subject.source: terminal-product` (a CLI/product the agent studies from public surfaces); other subjects are not supported on this route.");
  }

  return { ok: true, config, warnings: forwardDeclaredWarnings(config) };
}

// The slug interpolates into an in-sandbox shell command; the strict shape is load-bearing.
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
// A lane id interpolates into per-lane evidence paths (screenshots/<id>/, actors/<id>.json), so
// it must be a public-safe path token, same shape as a lab id.
const LANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const LANE_ID_MAX_CHARS = 40;
const LANE_METADATA_MAX_CHARS = 80;
// Hard cap on fan-out lanes (per the ratified design). No HUMANISH_MAX_LANES escape above this
// until a reference panel demands it — N concurrent paid desktops is real money.
export const MAX_CUA_LANES = 16;

function actorResolvesToComputerUse(type: string | undefined): boolean {
  if (!type) return false;
  const descriptor = (actorRegistry as Record<string, (typeof actorRegistry)[keyof typeof actorRegistry] | undefined>)[type];
  return Boolean(descriptor?.capabilities.lanes.includes("computer-use"));
}

function registeredComputerUseActors(): string[] {
  return Object.values(actorRegistry)
    .filter((entry) => entry.capabilities.lanes.includes("computer-use"))
    .map((entry) => entry.id);
}

function actorResolvesToScriptedBrowser(type: string | undefined): boolean {
  if (!type) return false;
  const descriptor = (actorRegistry as Record<string, (typeof actorRegistry)[keyof typeof actorRegistry] | undefined>)[type];
  return Boolean(descriptor?.capabilities.lanes.includes("scripted-browser"));
}

function registeredScriptedBrowserActors(): string[] {
  return Object.values(actorRegistry)
    .filter((entry) => entry.capabilities.lanes.includes("scripted-browser"))
    .map((entry) => entry.id);
}

/** True when `type` resolves to a registered terminal actor (the "terminal" lane). Exported so
 *  the engine + tests can resolve the dispatch the same way the parser does. */
export function actorResolvesToTerminal(type: string | undefined): boolean {
  if (!type) return false;
  const descriptor = (actorRegistry as Record<string, (typeof actorRegistry)[keyof typeof actorRegistry] | undefined>)[type];
  return Boolean(descriptor?.capabilities.lanes.includes("terminal"));
}

function registeredTerminalActors(): string[] {
  return Object.values(actorRegistry)
    .filter((entry) => entry.capabilities.lanes.includes("terminal"))
    .map((entry) => entry.id);
}

/**
 * True when this config routes to the computer-use backend: an app-url subject whose first
 * actor resolves to a registered computer-use actor, or a clone subject on a hosted desktop
 * whose first actor does. Single source of truth — selectLabBackend and the warning logic
 * both use it. (The app-url branch used to be unconditionally true; it narrowed when the
 * scripted-browser lane arrived. Behavior-preserving for every parse-valid config —
 * selectLabBackend keeps a bare app-url fallback to the cua backend so library-API configs
 * with unknown actors still hit its fail-closed ACTOR_UNSUPPORTED.)
 */
/**
 * The declared fan-out lane count on the computer-use route: a `lanes[]` roster's length, else
 * a homogeneous `count`, else 1. The single source of truth shared by the parser, the engine,
 * and the pre-flight plan so the lane count is computed ONE way everywhere.
 */
export function cuaLaneCount(config: LabConfig): number {
  const actor = config.actors[0];
  if (actor?.lanes !== undefined) {
    return actor.lanes.length;
  }
  return actor?.count ?? 1;
}

/**
 * Cross-validate the computer-use fan-out declaration (per-lane worlds). Returns the failure
 * message, or null when valid. Enforced at parse AND re-enforced in the engine (runCuaActorLab
 * is itself exported npm surface). Structural lane shape (id/device validity, id uniqueness) is
 * already checked in parseLanes; this is the route-scoped XOR/cap/policy layer.
 */
export function cuaLaneValidationReason(config: LabConfig): string | null {
  const actor = config.actors[0];
  const lanes = actor?.lanes;
  const structuralReason = laneRosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  // clone.fanout is a DECLARED behavior change: rejected on the cua route (was inert-warned).
  // Fan-out is declared via actors[0].count/lanes; subject.clone.fanout never applied here.
  if (config.subject.clone?.fanout !== undefined) {
    return "`subject.clone.fanout` is not used on the computer-use route — declare fan-out with actors[0].count (homogeneous) or actors[0].lanes (a per-lane roster). (clone.fanout drives the OSS smoke/meta routes only.)";
  }
  if (lanes !== undefined) {
    if (actor?.count !== undefined) {
      return "Declare EITHER actors[0].count (a homogeneous lane count) OR actors[0].lanes (a differentiated roster), not both.";
    }
    if (actor?.laneFocus !== undefined) {
      return "actors[0].laneFocus and actors[0].lanes are mutually exclusive — a roster's per-lane `instruction` is the fan-out steer; laneFocus is the single-lane steer.";
    }
    if (config.execution?.desktop?.resolution !== undefined && lanes.some((lane) => lane.device !== undefined)) {
      return "actors[0].lanes[].device and a raw execution.desktop.resolution are mutually exclusive — a per-lane device preset and a single hand-set resolution cannot both govern lane geometry.";
    }
    const targeted = lanes.filter((lane) => lane.target !== undefined);
    if (targeted.length > 0) {
      if (config.subject.source !== "app-url") {
        return "actors[0].lanes[].target is supported only on app-url computer-use labs — clone/shared-world/local-app routes provision or own their entry URL by mechanism.";
      }
      if (lanes.some((lane) => lane.entry !== undefined)) {
        return "actors[0].lanes[].target and actors[0].lanes[].entry are mutually exclusive — target is an app-url fan-out browser URL; entry is a shared-world same-origin seat path.";
      }
      if (targeted.length !== lanes.length) {
        return "When any actors[0].lanes[].target is declared, every lane in the roster must declare target — this keeps the setup-produced target contract explicit and prevents accidental mixed worlds.";
      }
    }
  }
  const laneCount = cuaLaneCount(config);
  if (laneCount > MAX_CUA_LANES) {
    return `Computer-use fan-out is capped at ${MAX_CUA_LANES} lanes (declared ${laneCount}); N concurrent paid desktops is real spend — there is no override above the cap this slice.`;
  }
  // Public targets fan out into N independent worlds driving the SAME public app — that is an
  // ambiguous shared-world-ish shape, not a per-lane target swarm. Permit N>1 public runs only when
  // every roster lane declares its own target, making the adapter-owned topology explicit. But when
  // `subject.topology: shared-world` is ALSO declared, N lanes against one public target is the
  // EXTERNAL-PUBLIC shared-world topology (#164 phase 2) — ROUTE it there (a real public deployment
  // as the shared plane) instead of refusing; externalPublicSharedWorldValidationReason then applies.
  if (laneCount > 1 && config.policies?.allowPublicTargets === true && declaredLaneTargets(config).length === 0
    && config.subject.topology !== "shared-world") {
    return "policies.allowPublicTargets cannot be combined with multi-lane fan-out (N>1) — N lanes against one declared public target is the SHARED-WORLD topology (layer 7, #164), not per-lane worlds. Declare `subject.topology: shared-world` to run the external-public shared-world route, fan out against a loopback/provisioned subject, or run a single public-target lane.";
  }
  return null;
}

/**
 * Engine-level path-token validation for configs supplied directly through the
 * public TypeScript/JavaScript API instead of parseLabConfig.
 */
export function laneRosterStructuralValidationReason(config: LabConfig): string | null {
  const lanes = config.actors[0]?.lanes;
  const seenIds = new Set<string>();
  if (lanes !== undefined) {
    if (!Array.isArray(lanes) || lanes.length === 0) {
      return "actors[0].lanes must be a non-empty array when set.";
    }
    for (const [index, lane] of lanes.entries()) {
      if (!lane || typeof lane !== "object" || Array.isArray(lane)) {
        return `actors[0].lanes[${index}] must be an object.`;
      }
      const id = lane.id;
      if (id === undefined) {
        continue;
      }
      if (typeof id !== "string" || !LANE_ID_PATTERN.test(id) || id.length > LANE_ID_MAX_CHARS) {
        return `actors[0].lanes[${index}].id must be a public-safe path token matching ${LANE_ID_PATTERN} and at most ${LANE_ID_MAX_CHARS} chars.`;
      }
      if (seenIds.has(id)) {
        return `actors[0].lanes ids must be unique (duplicate "${id}").`;
      }
      seenIds.add(id);
    }
  }
  return null;
}

function declaredLaneTargets(config: LabConfig): string[] {
  return (config.actors[0]?.lanes ?? [])
    .map((lane) => lane.target)
    .filter((target): target is string => target !== undefined);
}

/**
 * Cross-validate a `topology: shared-world` declaration (#164). Returns the failure message, or
 * null when valid. Enforced at parse AND re-enforced in the engine (runSharedWorldLab is exported
 * npm surface). The shared-world override REQUIRES: a clone or local-tree source + e2b-desktop
 * target + a computer-use actor + a `subject.serve` block + an `actors[0].lanes` roster of ≥2 roles (the
 * roster IS the role roster — no parallel roles[] field), and every role `entry` must resolve
 * same-origin (loopback) with serve.url. Fail-closed: a half-declared shared-world is rejected,
 * never silently downgraded.
 */
export function sharedWorldValidationReason(config: LabConfig): string | null {
  const structuralReason = laneRosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  if (config.subject.source !== "clone" && config.subject.source !== "local-tree") {
    return "`subject.topology: shared-world` requires `subject.source: clone` or `subject.source: local-tree` - the shared world is ONE provisioned, served, seeded plane (#164).";
  }
  if (config.execution?.target !== "e2b-desktop") {
    return "`subject.topology: shared-world` requires `execution.target: e2b-desktop` — the role seats drive hosted desktop browsers against one in-sandbox app.";
  }
  if (!actorResolvesToComputerUse(config.actors[0]?.type)) {
    return `\`subject.topology: shared-world\` requires a registered computer-use actor (one of: ${registeredComputerUseActors().join(", ")}) — each role seat runs a computer-use session.`;
  }
  const serve = config.subject.serve;
  if (!serve) {
    return "`subject.topology: shared-world` requires `subject.serve` (start + url) — the lab serves ONE shared app in-sandbox that every role drives.";
  }
  const lanes = config.actors[0]?.lanes;
  if (!lanes || lanes.length < 2) {
    return "`subject.topology: shared-world` requires an `actors[0].lanes` roster of at least 2 roles (the roster IS the role roster — declare ≥2 lanes; a single-role shared world proves no interaction).";
  }
  if (!config.subject.state?.checkpoint || config.subject.state.checkpoint.length === 0) {
    return "`subject.topology: shared-world` requires `subject.state.checkpoint` (≥1 read-only digest probe) — the checkpoint timeline IS the interaction-attribution mechanism; without it the run cannot prove role B acted on role A's mutation.";
  }
  for (const lane of lanes) {
    if (lane.entry !== undefined && resolveSeatUrl(serve.url, lane.entry) === null) {
      return `actors[0].lanes role "${lane.id ?? "(unnamed)"}".entry must resolve same-origin (loopback) with subject.serve.url (${serve.url}); got "${lane.entry}".`;
    }
  }
  return null;
}

/**
 * The lane ids the computer-use engine will actually run: declared roster ids, else the generated
 * `lane-01..lane-NN` names. Mirrors the naming in cua-actor-lab.ts's laneSpecsAndPlan — a test
 * pins the two together — so comms recipient validation can never drift from the engine (#351).
 */
export function effectiveComputerUseLaneIds(config: LabConfig): string[] {
  const actor = config.actors[0];
  const roster = actor?.lanes;
  if (roster && roster.length > 0) {
    return roster.map((lane, index) => lane.id ?? `lane-${String(index + 1).padStart(2, "0")}`);
  }
  const count = Math.max(1, actor?.count ?? 1);
  return Array.from({ length: count }, (_, index) => `lane-${String(index + 1).padStart(2, "0")}`);
}

export function routesToComputerUse(config: LabConfig): boolean {
  // local-app drives the cua loop in-process (a custom executor + a non-vision provider), so it
  // routes to the cua backend exactly like an app-url subject with a computer-use actor.
  if (config.subject.source === "app-url" || config.subject.source === "local-app") {
    return actorResolvesToComputerUse(config.actors[0]?.type);
  }
  // desktop-cli hands the participant a terminal instead of a served page (#495), but it is the
  // same lane: same desktop, same actor, same prompt fields. Leaving it out of this predicate told
  // adopters their mission and persona were inert on the one route whose whole point is that a
  // person reads a screen.
  if (config.subject.source === "desktop-cli") {
    return (config.execution?.target === undefined || config.execution.target === "e2b-desktop")
      && actorResolvesToComputerUse(config.actors[0]?.type);
  }
  // local-tree packs+uploads the working tree, then serves it exactly like a computer-use clone
  // subject: same e2b-desktop + computer-use-actor gate.
  return (config.subject.source === "clone" || config.subject.source === "local-tree")
    && config.execution?.target === "e2b-desktop"
    && actorResolvesToComputerUse(config.actors[0]?.type);
}

/** Refuse a claimed output bound when the route cannot pass it to the first-party provider. */
export function outputTokenLimitValidationReason(config: LabConfig): string | null {
  const actor = config.actors[0];
  if (actor?.maxOutputTokens === undefined) return null;
  if (!isMaxOutputTokens(actor.maxOutputTokens)) return "actors[0].maxOutputTokens must be a positive safe integer.";
  if (actor.type !== "openai-computer-use" || !routesToComputerUse(config) || config.subject.source === "local-app") {
    return "actors[0].maxOutputTokens is supported only by first-party OpenAI computer-use routes; terminal, local-agent, scripted and custom in-process routes cannot enforce it.";
  }
  return null;
}

/**
 * True when this config routes to the SHARED-WORLD backend (#164): a clone or local-tree subject
 * on a hosted desktop whose first actor resolves to a computer-use actor AND that declares the
 * `shared-world` topology. Mirror of routesToComputerUse; the single source of truth shared by
 * selectLabBackend (which checks it BEFORE the cua route) and the warning logic. The same
 * clone/local-tree × e2b-desktop × computer-use composition WITHOUT `topology: shared-world` stays per-lane-worlds
 * (the cua route) — the topology declaration is the override switch.
 */
export function routesToSharedWorld(config: LabConfig): boolean {
  return routesToProvisionedSharedWorld(config) || routesToExternalPublicSharedWorld(config);
}

/** The getHost provisioned-subject shared-world shape (clone/local-tree served + exposed in-sandbox). */
export function routesToProvisionedSharedWorld(config: LabConfig): boolean {
  return (config.subject.source === "clone" || config.subject.source === "local-tree")
    && config.subject.topology === "shared-world"
    && config.execution?.target === "e2b-desktop"
    && actorResolvesToComputerUse(config.actors[0]?.type);
}

/**
 * The EXTERNAL-PUBLIC shared-world shape (#164 phase 2): a real PUBLIC deployment used DIRECTLY as
 * the shared plane — `source: app-url` + `topology: shared-world` + a computer-use actor on
 * e2b-desktop + `policies.allowPublicTargets: true`. NO getHost, NO clone, NO subject sandbox, NO
 * seed. The operator-ownership attestation `subject.publicTarget` is required (validated in
 * externalPublicSharedWorldValidationReason, not here — this predicate is the router only, so a
 * half-declared external-public config still routes here to get its precise fail-closed reason
 * rather than silently downgrading to the per-lane cua route). Always concurrent (concurrency > 1 is
 * enforced by the validation reason).
 */
export function routesToExternalPublicSharedWorld(config: LabConfig): boolean {
  return config.subject.source === "app-url"
    && config.subject.topology === "shared-world"
    && config.execution?.target === "e2b-desktop"
    && actorResolvesToComputerUse(config.actors[0]?.type)
    && config.policies?.allowPublicTargets === true;
}

/**
 * True when this config routes to the CONCURRENT shared-world backend (#164 phase 2): a shared-world
 * config with `execution.concurrency > 1` (N actor seats driving ONE plane AT ONCE). Two plane
 * classes: the getHost provisioned-subject shape (clone/local-tree) AND the external-public shape (a
 * real public deployment used directly as the plane — `source: app-url` + `allowPublicTargets`, no
 * getHost/clone/seed). An omitted `concurrency` is filled at parse with the seat count (all seats
 * live — the all-parallel default, #350), so multi-seat shared-world labs route here unless the
 * author explicitly declares `concurrency: 1`, which is the sequential PoC (getHost only).
 * selectLabBackend checks this BEFORE routesToSharedWorld.
 */
export function routesToConcurrentSharedWorld(config: LabConfig): boolean {
  return routesToSharedWorld(config) && (config.execution?.concurrency ?? 1) > 1;
}

/**
 * Cross-validate a CONCURRENT shared-world declaration (#164 phase 2). Returns the failure message,
 * or null when valid. Includes the base shared-world checks PLUS the concurrent extras: a synthetic
 * subject attestation (FIX-3), a 0.0.0.0 serve bind (FIX-4 — getHost only routes to a port bound on
 * all interfaces), and no `subject.clone.keep`/`subject.localTree.keep` (FIX-9 - either would
 * orphan actor sandboxes). Enforced at parse AND re-enforced in the engine (runConcurrentSharedWorld
 * is exported npm surface).
 */
export function concurrentSharedWorldValidationReason(config: LabConfig): string | null {
  const base = sharedWorldValidationReason(config);
  if (base) {
    return base;
  }
  if ((config.execution?.concurrency ?? 1) <= 1) {
    return "the concurrent shared-world route requires `execution.concurrency > 1` (N concurrent actor seats); concurrency 1 is the sequential PoC.";
  }
  if (config.subject.exposure !== "synthetic") {
    return "the concurrent shared-world route requires `subject.exposure: synthetic` — the subject is exposed on an internet-reachable getHost URL for the run, so the author must attest it is synthetic seeded data (no real/external data behind a getHost URL).";
  }
  const serve = config.subject.serve;
  if (!serve || !serve.start.includes("0.0.0.0")) {
    return "the concurrent shared-world route requires `subject.serve.start` to bind all interfaces (e.g. `-H 0.0.0.0` / `--host 0.0.0.0` / `HOST=0.0.0.0`) — getHost only routes to a 0.0.0.0-bound port; a loopback-only bind 502s. (The readiness probe stays loopback.)";
  }
  if (config.subject.clone?.keep === true || config.subject.localTree?.keep === true) {
    const keepField = config.subject.clone?.keep === true ? "subject.clone.keep" : "subject.localTree.keep";
    return `\`${keepField}\` is not supported on the concurrent shared-world route - it would orphan the N actor sandboxes (reclaimed only by server-timeout, not by id). All N+1 sandboxes are torn down by id.`;
  }
  return null;
}

/**
 * Cross-validate the EXTERNAL-PUBLIC shared-world declaration (#164 phase 2): a real PUBLIC
 * deployment used DIRECTLY as the shared plane (no getHost, no clone, no subject sandbox, no seed).
 * The honest analog of concurrentSharedWorldValidationReason for a plane the harness does NOT own:
 * it FORBIDS every provisioned-subject field (serve/state.seed/state.checkpoint/exposure/clone/repos
 * are inert with no sandbox — fail closed, never silently ignored, per invariant 6), and REQUIRES a
 * non-loopback appUrl + allowPublicTargets + the operator-ownership attestation subject.publicTarget +
 * concurrency > 1 + an actors[0].lanes roster of ≥2 with EXACTLY ONE host lane. The getHost synthetic
 * gate is deliberately unreachable here (there is no internet-reachable harness-owned URL to attest).
 * Enforced at parse AND re-enforced in the engine (runConcurrentSharedWorld is exported npm surface).
 */
export function externalPublicSharedWorldValidationReason(config: LabConfig): string | null {
  const structuralReason = laneRosterStructuralValidationReason(config);
  if (structuralReason) {
    return structuralReason;
  }
  if (config.subject.source !== "app-url") {
    return "the external-public shared-world route requires `subject.source: app-url` — a real public deployment is used directly as the shared plane (no clone, no provisioned subject).";
  }
  if (config.execution?.target !== "e2b-desktop") {
    return "the external-public shared-world route requires `execution.target: e2b-desktop` — the role seats drive hosted desktop browsers against the one public deployment.";
  }
  if (!actorResolvesToComputerUse(config.actors[0]?.type)) {
    return `the external-public shared-world route requires a registered computer-use actor (one of: ${registeredComputerUseActors().join(", ")}) — each role seat runs a computer-use session.`;
  }
  if ((config.execution?.concurrency ?? 1) <= 1) {
    return "the external-public shared-world route requires `execution.concurrency > 1` (N concurrent seats sharing ONE public plane); concurrency 1 proves no shared world.";
  }
  if (config.policies?.allowPublicTargets !== true) {
    return "the external-public shared-world route requires `policies.allowPublicTargets: true` — the shared plane is a real non-loopback public deployment.";
  }
  const appUrl = config.subject.appUrl ?? "";
  if (!isHttpUrl(appUrl) || isLoopbackUrl(appUrl)) {
    return "the external-public shared-world route requires a non-loopback http(s) `subject.appUrl` — a loopback URL is not a shared public plane (use the getHost provisioned route for a local subject).";
  }
  // The operator-ownership attestation (the honest analog of exposure: synthetic — you cannot claim
  // synthetic on a real site, but you MUST attest you own/operate it). Author-trust; unverifiable.
  if (config.subject.publicTarget?.authorized !== true) {
    return "the external-public shared-world route requires `subject.publicTarget: { owner, authorized: true }` — you must attest you own/operate the public deployment used as the shared plane (author-trust; the harness cannot verify ownership).";
  }
  // FORBID every provisioned-subject field: with no sandbox they cannot act, so they are rejected
  // with a precise reason, never silently ignored (invariant 6). exposure: synthetic in particular
  // would be a LIE on a real site (the harness neither provisioned nor exposed it).
  if (config.subject.exposure !== undefined) {
    return "`subject.exposure: synthetic` is forbidden on the external-public shared-world route — you cannot attest a real public deployment is synthetic seeded data; use `subject.publicTarget` to attest ownership instead.";
  }
  if (config.subject.serve !== undefined) {
    return "`subject.serve` is forbidden on the external-public shared-world route — the harness does not serve the plane (it is an already-deployed public app); there is no in-sandbox serve to run.";
  }
  if (config.subject.state?.seed !== undefined || config.subject.state?.checkpoint !== undefined || config.subject.state !== undefined) {
    return "`subject.state` (seed/checkpoint/external) is forbidden on the external-public shared-world route — the harness neither seeds nor snapshots the plane (no in-sandbox filesystem to digest); no authoritative shared-state proof is possible on this class.";
  }
  if (config.subject.clone !== undefined || config.subject.repos !== undefined) {
    return "`subject.clone`/`subject.repos` are forbidden on the external-public shared-world route — nothing is cloned; the public deployment IS the plane.";
  }
  const lanes = config.actors[0]?.lanes;
  if (!lanes || lanes.length < 2) {
    return "the external-public shared-world route requires an `actors[0].lanes` roster of at least 2 roles (a single-seat shared world proves no shared session).";
  }
  if (lanes.some((lane) => lane.entry !== undefined)) {
    return "`actors[0].lanes[].entry` (the loopback same-origin seat path) is forbidden on the external-public shared-world route — there is no harness-served serve.url to resolve it against; seats open the public appUrl and reach the shared session through the real UI.";
  }
  const hostLanes = lanes.filter((lane) => lane.host === true);
  if (hostLanes.length !== 1) {
    return `the external-public shared-world route requires EXACTLY ONE \`host: true\` lane (the designated host seat that creates the shared session; got ${hostLanes.length}). The other ≥1 lanes are followers that join it.`;
  }
  return null;
}

/**
 * Resolve a shared-world seat's entry URL from `serve.url` + a role's `entry` (relative path or
 * same-origin absolute URL). Returns null when the combination is not a same-origin loopback URL
 * (the load-bearing public-safety boundary — a seat only ever drives the in-sandbox app).
 */
export function resolveSeatUrl(serveUrl: string, entry: string | undefined): string | null {
  if (entry === undefined || entry === "") {
    return isLoopbackUrl(serveUrl) ? serveUrl : null;
  }
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(serveUrl);
    resolved = new URL(entry, serveUrl);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) {
    return null;
  }
  const value = resolved.toString();
  return isLoopbackUrl(value) ? value : null;
}

/**
 * True when this config routes to the scripted-browser backend: an app-url subject whose
 * first actor resolves to a registered scripted-browser actor (execution.target local or
 * absent — the parse layer enforces that pairing). Mirror of routesToComputerUse; the single
 * source of truth for selectLabBackend and the warning logic.
 */
export function routesToScriptedBrowser(config: LabConfig): boolean {
  return routesToLocalScriptedBrowser(config) || routesToProvisionedScriptedBrowser(config);
}

export function routesToLocalScriptedBrowser(config: LabConfig): boolean {
  return config.subject.source === "app-url"
    && actorResolvesToScriptedBrowser(config.actors[0]?.type);
}

export function routesToProvisionedScriptedBrowser(config: LabConfig): boolean {
  return config.subject.source === "clone"
    && config.execution?.target === "e2b-desktop"
    && actorResolvesToScriptedBrowser(config.actors[0]?.type);
}

/**
 * True when this config routes to the terminal-product backend: a terminal-product subject whose
 * first actor resolves to a registered terminal actor (execution.target e2b-terminal or absent —
 * the parse layer enforces that pairing). Mirror of routesToComputerUse/routesToScriptedBrowser;
 * the single source of truth for selectLabBackend and the warning logic.
 */
export function routesToTerminalProduct(config: LabConfig): boolean {
  return config.subject.source === "terminal-product"
    && actorResolvesToTerminal(config.actors[0]?.type);
}

// Report fields that are present but not yet consumed by the engine, so a user never trusts a
// setting that silently does nothing. Keeps the schema forward-correct AND honest.
function forwardDeclaredWarnings(config: LabConfig): string[] {
  const inert: string[] = [];
  // The computer-use routes consume the actor prompt fields, execution.timeoutMs,
  // execution.desktop.{resolution,sandboxTimeoutMs}, and (clone) subject.{serve,env,state,
  // clone.depth}; the scripted-browser route consumes scenario.ref, actors[0].{persona,count},
  // and execution.timeoutMs (mission/laneFocus/model are inert there: this actor runs no
  // model); on every other route those fields are inert.
  const routesToCua = routesToComputerUse(config);
  const routesToScripted = routesToScriptedBrowser(config);
  const routesToTerminal = routesToTerminalProduct(config);
  const routesToShared = routesToSharedWorld(config);
  const routesToConcurrent = routesToConcurrentSharedWorld(config);
  // The external-public plane (a real public deployment as the shared plane) consumes host lanes +
  // subject.publicTarget; it is only ever the concurrent app-url shape.
  const routesToExternalPublic = routesToConcurrent && config.subject.source === "app-url";
  const routesToHostedCuaBrowser = config.execution?.target === "e2b-desktop"
    && routesToCua;
  for (const [index, actor] of config.actors.entries()) {
    // Shared-world ONLY fields on the roster: per-role `entry` is inert anywhere else (invariant 6).
    if (actor.lanes?.some((lane) => lane.entry !== undefined) && !routesToShared) {
      inert.push(`actors[${index}].lanes[].entry (the per-role loopback entry is a shared-world capability; needs subject.topology: shared-world)`);
    }
    // The host-seat marker acts ONLY on the external-public shared-world route; inert elsewhere.
    if (actor.lanes?.some((lane) => lane.host === true) && !routesToExternalPublic) {
      inert.push(`actors[${index}].lanes[].host (the designated host-seat marker; needs the external-public shared-world route: app-url × topology shared-world × allowPublicTargets × concurrency > 1)`);
    }
    if (routesToCua || routesToTerminal) {
      // The cua + terminal routes consume mission/persona/model + laneFocus.instruction (they
      // compose the agent prompt + bundle provenance); laneFocus.id/label remain inert. On the
      // cua E2B route actors[0].lanes is CONSUMED (the fan-out roster).
      if (actor.laneFocus?.id) inert.push(`actors[${index}].laneFocus.id`);
      if (actor.laneFocus?.label) inert.push(`actors[${index}].laneFocus.label`);
      if (routesToTerminal && actor.lanes) inert.push(`actors[${index}].lanes (fan-out is a computer-use route capability; terminal fan-out is a later slice)`);
    } else if (routesToScripted) {
      // persona and count are consumed (trace/bundle provenance; surface roster). The prompt
      // fields can never act here — the scripted actor runs no model.
      if (actor.mission) inert.push(`actors[${index}].mission (the scripted-browser actor runs no model)`);
      if (actor.laneFocus) inert.push(`actors[${index}].laneFocus (the scripted-browser actor runs no model)`);
      if (actor.model) inert.push(`actors[${index}].model (the scripted-browser actor runs no model)`);
      if (actor.lanes) inert.push(`actors[${index}].lanes (the scripted-browser route fans out via actors[0].count, not a lane roster)`);
    } else {
      if (actor.mission) inert.push(`actors[${index}].mission`);
      if (actor.laneFocus) inert.push(`actors[${index}].laneFocus`);
      if (actor.persona) inert.push(`actors[${index}].persona`);
      if (actor.model) inert.push(`actors[${index}].model`);
      if (actor.lanes) inert.push(`actors[${index}].lanes`);
    }
  }
  if (config.subject.clone?.depth !== undefined && !routesToCua && !routesToScripted) inert.push("subject.clone.depth");
  if (config.subject.serve && !routesToCua && !routesToScripted) inert.push("subject.serve");
  if (config.subject.env && !routesToCua && !routesToScripted) inert.push("subject.env");
  if (config.subject.state && !routesToCua && !routesToScripted) inert.push("subject.state");
  // topology + checkpoint act ONLY on the shared-world route (#164); a set-but-unconsumed value
  // (incl. an explicit per-lane-worlds, which the cua route already is by mechanism) warns inert.
  if (config.subject.topology !== undefined && !routesToShared) {
    inert.push("subject.topology (drives behavior only on the shared-world route; needs subject.topology: shared-world + clone × e2b-desktop × a computer-use actor + a ≥2 lane roster)");
  }
  if (config.subject.state?.checkpoint !== undefined && !routesToShared) {
    inert.push("subject.state.checkpoint (the shared-world state-checkpoint probe; needs subject.topology: shared-world)");
  }
  // publicTarget (the external-public ownership attestation) acts ONLY on the external-public
  // shared-world route; inert elsewhere. (It is already parse-rejected on non-app-url sources.)
  if (config.subject.publicTarget !== undefined && !routesToExternalPublic) {
    inert.push("subject.publicTarget (the external-public ownership attestation; needs the external-public shared-world route: app-url × topology shared-world × allowPublicTargets × concurrency > 1)");
  }
  // exposure (the synthetic-subject attestation) acts ONLY on the CONCURRENT shared-world route
  // (the getHost-exposed plane); inert on the sequential shared-world route (loopback) and elsewhere.
  if (config.subject.exposure !== undefined && !routesToConcurrent && !(routesToScripted && config.subject.source === "clone")) {
    inert.push("subject.exposure (the synthetic-subject attestation for a getHost-exposed plane; needs concurrent shared-world or clone × e2b-desktop × scripted-browser)");
  }
  // comms.email drives the in-sandbox email/SMS catch, which needs a subject sandbox HUMANISH
  // provisions (clone or local-tree) so it holds a handle to host the catch. On an app-url /
  // operator-provided subject there is no such handle, so a declared comms block would silently
  // collect nothing — a false green. Warn at parse time (fires on inspect + dry-run too).
  if (
    config.comms?.email
    && config.comms.email.external === undefined
    && config.subject.source !== "clone"
    && config.subject.source !== "local-tree"
  ) {
    inert.push("comms.email (the in-sandbox email/SMS catch needs a harness-provisioned subject to host it — subject.source: clone or local-tree; on an app-url or operator-provided subject humanish holds no sandbox handle. Declare `comms.email.external` to run the catch yourself: humanish then points the persona at your inbox, drains your catch, and writes the same evidence — see #328)");
  }
  // The reverse mis-config: declaring an adopter-hosted catch on a route where humanish provisions
  // the subject itself. Two catches would exist and the app would point at humanish's, so the
  // declared external one would silently collect nothing.
  if (config.comms?.email?.external && (config.subject.source === "clone" || config.subject.source === "local-tree")) {
    inert.push("comms.email.external (this subject is harness-provisioned, so humanish hosts the catch itself and injects its URL; an adopter-hosted catch would receive nothing. Drop `external` here, or move the study to an app-url/operator-provisioned subject)");
  }
  // The SEQUENTIAL shared-world route has no comms wiring at all (no catch deploy, no inbox
  // instruction) — a comms block there does nothing, and the actors are never told an inbox
  // exists. Say so at parse time; the concurrent route (the default since #350: all seats live)
  // is the one that hosts the email funnel (#351).
  if (config.comms?.email && config.subject.topology === "shared-world" && (config.execution?.concurrency ?? 1) <= 1) {
    inert.push("comms.email (the sequential turn-taking shared-world route has no comms wiring — no catch is deployed and no actor is told an inbox exists; remove `execution.concurrency: 1` so all seats run concurrently, which is the route that hosts the email funnel)");
  }
  // clone.keep IS consumed on the cua route (honored on FAILURE: the sandbox is left up to debug
  // a failed install/boot; otherwise always killed). clone.fanout is REJECTED on the cua route
  // (a hard parse error above), so it can never reach this warning list there.
  if (!routesToCua && !routesToScripted && !routesToTerminal && config.execution?.timeoutMs !== undefined) inert.push("execution.timeoutMs");
  if (config.execution?.completionTimeoutMs !== undefined) inert.push("execution.completionTimeoutMs");
  // execution.concurrency is CONSUMED on the cua route (it bounds in-flight fan-out lanes);
  // inert (warned) everywhere else.
  if (config.execution?.concurrency !== undefined && !routesToCua) inert.push("execution.concurrency");
  // execution.caps is CONSUMED on the cua route (maxUsd is the fail-closed spend abort); inert
  // (warned) everywhere else so a misplaced budget field is never trusted to cap a route it cannot.
  if (config.execution?.caps && !routesToCua) inert.push("execution.caps (the fail-closed spend abort is a computer-use route capability; needs a computer-use actor on e2b-desktop)");
  // terminal-product consumes subject.product, scenario.caps, execution.{terminal,runtimeAuth}:
  // dry-run records the contract; live execution enforces caps and command-scoped auth. On every
  // OTHER route they are inert and must warn so a
  // misplaced safety/budget field is never trusted to do something it cannot (invariant 6).
  if (config.subject.product && !routesToTerminal && config.subject.source !== "desktop-cli") inert.push("subject.product (needs subject.source: terminal-product or desktop-cli with the matching actor)");
  if (config.scenario?.caps && !routesToTerminal) inert.push("scenario.caps (needs subject.source: terminal-product + a registered terminal actor)");
  // The study-level budget is a CUA-route capability; the terminal route is a single agent whose
  // maxUsd already caps the whole run, so a maxTotalUsd there would be trusted and unenforced.
  if (config.scenario?.caps?.maxTotalUsd !== undefined && routesToTerminal) inert.push("scenario.caps.maxTotalUsd (the study-level budget is a computer-use route capability; the terminal route's maxUsd already caps the whole run)");
  if (config.execution?.terminal && !routesToTerminal) inert.push("execution.terminal (needs subject.source: terminal-product + a registered terminal actor)");
  if (config.execution?.runtimeAuth !== undefined && !routesToTerminal) inert.push("execution.runtimeAuth (needs subject.source: terminal-product + a registered terminal actor)");
  if (config.execution?.runtime !== undefined && !routesToTerminal) inert.push("execution.runtime (needs subject.source: terminal-product + a registered terminal actor)");
  // execution.desktop.* stays inert on the scripted route by design: device presets belong to
  // the cua desktop; scripted surfaces are the driver's fixed desktop/mobile viewports, where
  // isMobile/DSF genuinely render via playwright emulation.
  if (!routesToCua && config.execution?.desktop?.resolution) inert.push("execution.desktop.resolution");
  if (!routesToCua && config.execution?.desktop?.device !== undefined) inert.push("execution.desktop.device");
  if (!routesToHostedCuaBrowser && config.execution?.desktop?.browser !== undefined) inert.push("execution.desktop.browser");
  if (!routesToHostedCuaBrowser && config.execution?.desktop?.fidelity !== undefined) {
    inert.push("execution.desktop.fidelity (mobile emulation is applied only to hosted Chromium computer-use lanes on execution.target: e2b-desktop)");
  }
  if (!routesToCua && config.execution?.desktop?.sandboxTimeoutMs !== undefined) inert.push("execution.desktop.sandboxTimeoutMs");
  // execution.desktop.template (the custom E2B desktop image) is consumed ONLY where a desktop is
  // actually created via Sandbox.create — the e2b-desktop computer-use routes (cua/shared-world/
  // concurrent). It is INERT on every other route (incl. the in-process local-app cua route, which
  // creates no desktop, and the meta route): warn so an unconsumed template is never silently
  // ignored (invariant 6).
  const createsE2BDesktop = (routesToCua || (routesToScripted && config.subject.source === "clone"))
    && config.execution?.target === "e2b-desktop";
  if (config.execution?.desktop?.template !== undefined && !createsE2BDesktop) {
    inert.push("execution.desktop.template (the custom E2B desktop image is consumed only on execution.target: e2b-desktop computer-use routes that create a desktop; needs a computer-use actor on e2b-desktop)");
  }
  // codexAppServer is consumed only on the e2b-desktop (meta) route; flag it when it cannot reach there.
  const routesToDesktop = config.subject.source === "clone" && config.execution?.target === "e2b-desktop";
  if (config.execution?.desktop?.codexAppServer !== undefined && !routesToDesktop) {
    inert.push("execution.desktop.codexAppServer (needs subject.source: clone + execution.target: e2b-desktop)");
  }
  // scenario.ref is CONSUMED on the scripted-browser route (required there); forward-declared
  // everywhere else.
  if (config.scenario?.ref && !routesToScripted) inert.push("scenario.ref");
  if (config.scenario?.inline) inert.push("scenario.inline");
  // review.{scoring,milestones,vocabulary} stay forward-declared (reserved for #319) on every route.
  // review.scorer (#316) IS consumed (loaded + wired, or fail-closed at load) on every scorer-capable
  // route, so it does not warn there; on the scripted-browser route the actor carries no scorer seam,
  // so a declared scorer is flagged inert (the run also fails closed at load).
  if (config.review?.scoring) inert.push("review.scoring (reserved for a later slice; not yet consumed)");
  if (config.review?.milestones) inert.push("review.milestones (reserved for a later slice; not yet consumed)");
  if (config.review?.vocabulary) inert.push("review.vocabulary (reserved for a later slice; not yet consumed)");
  if (config.review?.scorer && routesToScripted) {
    inert.push("review.scorer (the scripted-browser actor has no adopter-scorer seam; declare it on a terminal / computer-use / shared-world route)");
  }
  if (config.personas) inert.push("personas");
  const warnings = inert.length === 0
    ? []
    : [`Forward-declared fields are set but not yet consumed by the engine (planned for a later slice): ${inert.join(", ")}.`];
  // A declared cap below the seat count is legal but loud: the roster promises N live actors and
  // the cap delivers waves of M. Say so up front (inspect + dry-run + run) — a green run in waves
  // is otherwise indistinguishable from the all-live run the author meant (#350).
  {
    const seats = config.actors[0]?.lanes?.length ?? config.actors[0]?.count ?? 1;
    const cap = config.execution?.concurrency;
    // concurrency: 1 on a shared-world lab is the SEQUENTIAL selector (turn-taking is that
    // route's whole design), not a mistaken throttle — no warning there.
    const sequentialSelector = config.subject.topology === "shared-world" && cap === 1;
    if (routesToCua && cap !== undefined && seats > 1 && cap < seats && !sequentialSelector) {
      warnings.push(
        `execution.concurrency ${cap} caps a ${seats}-seat roster: seats run in waves of ${cap}, never all live at once. Remove execution.concurrency (the default runs all ${seats} seats simultaneously) or set it to ${seats}; declare a lower cap only to bound simultaneous paid desktops.`
      );
    }
  }
  // Partial email coverage is legal but loud (#351): a lane without an addressed recipient never
  // hears an inbox exists, so an email-gated flow on that seat dead-ends by construction.
  if (routesToCua && config.comms?.email?.recipients) {
    const laneIds = effectiveComputerUseLaneIds(config);
    const covered = new Set(config.comms.email.recipients.filter((r) => r.address !== undefined).map((r) => r.lane));
    const uncovered = laneIds.filter((id) => !covered.has(id));
    if (covered.size > 0 && uncovered.length > 0 && laneIds.length > 1) {
      warnings.push(
        `comms.email covers ${covered.size} of ${laneIds.length} lanes; the uncovered lane(s) get no inbox and are never told one exists: ${uncovered.join(", ")}. Add addressed recipients for them if their flows need email.`
      );
    }
  }
  return warnings;
}

function parseSubject(raw: unknown): { ok: true; value: LabSubject } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid("Lab `subject` is required and must be an object.");
  }
  const source = str(raw.source);
  if (source !== "this-repo" && source !== "clone" && source !== "app-url" && source !== "local-app" && source !== "desktop-cli" && source !== "terminal-product" && source !== "local-tree") {
    return invalid("`subject.source` must be one of: this-repo, clone, app-url, local-app, terminal-product, desktop-cli, local-tree.");
  }
  const subject: LabSubject = { source };

  // topology is enum-validated everywhere; its SEMANTICS (shared-world requires clone × e2b-desktop
  // × a ≥2 roster) are enforced in the shared-world cross-validation below, and a set-but-unconsumed
  // topology warns as inert off the shared-world route (invariant 6).
  if (raw.topology !== undefined) {
    const topology = str(raw.topology);
    if (topology !== "per-lane-worlds" && topology !== "shared-world") {
      return invalid("`subject.topology` must be per-lane-worlds (the default) or shared-world.");
    }
    subject.topology = topology;
  }
  // exposure is enum-validated everywhere; it is REQUIRED on the concurrent shared-world route (the
  // getHost synthetic-subject attestation) and warns inert elsewhere.
  if (raw.exposure !== undefined) {
    const exposure = str(raw.exposure);
    if (exposure !== "synthetic") {
      return invalid("`subject.exposure` must be `synthetic` (the author attestation that the getHost-exposed subject is synthetic seeded data).");
    }
    subject.exposure = exposure;
  }

  // `product` is terminal-product-only; reject it elsewhere (invariant 6: a field that cannot act
  // on this route is an honest parse error, not silently dropped).
  if (source !== "terminal-product" && source !== "desktop-cli" && raw.product !== undefined) {
    return invalid("`subject.product` applies only to terminal-product and desktop-cli subjects (the CLI a participant studies from public surfaces).");
  }
  // appUrl is app-url/local-app-only; a terminal-product subject drives PUBLIC surfaces, not a
  // single loopback app — reject appUrl on it.
  if (source === "terminal-product" && raw.appUrl !== undefined) {
    return invalid("`subject.appUrl` does not apply to terminal-product subjects — declare `subject.product.publicSurfaces` (the agent works from public surfaces, not one loopback app).");
  }

  // serve/env/state are shared between clone (cloned app) and local-tree (packed working
  // tree): both routes serve a subject in-sandbox with the same install/build/start/url +
  // env-name + seed/external/checkpoint shapes.
  if (source !== "clone" && source !== "local-tree" && raw.serve !== undefined) {
    return invalid("`subject.serve` applies only to clone subjects or local-tree subjects (the lab serves the cloned/packed app in-sandbox).");
  }
  if (source !== "clone" && source !== "local-tree" && raw.env !== undefined) {
    return invalid("`subject.env` applies only to clone subjects or local-tree subjects (the served app's environment channel).");
  }
  if (source !== "clone" && source !== "local-tree" && raw.state !== undefined) {
    return invalid("`subject.state` applies only to clone subjects or local-tree subjects (the lab seeds the state it serves).");
  }
  // repos/clone are clone-ONLY (a fresh-clone subject's git inputs). local-tree packs the
  // resolution cwd itself, so it has no repo slug to clone and gets its own precise reasons
  // rather than falling through to the generic clone-only message below.
  if (source === "local-tree" && raw.repos !== undefined) {
    return invalid("`subject.repos` does not apply to local-tree subjects. The local-tree route packs the lab resolution cwd itself; there is no owner/repo slug to clone.");
  }
  if (source === "local-tree" && raw.clone !== undefined) {
    return invalid("`subject.clone` does not apply to local-tree subjects. Declare `subject.localTree` instead (keep/exclude/maxArchiveBytes).");
  }
  // Rejected, never silently dropped, on app-url/local-app/this-repo/terminal-product subjects
  // too (invariant 6: a field that cannot act on this route is an honest parse error).
  if (source !== "clone" && raw.repos !== undefined) {
    return invalid("`subject.repos` applies only to clone subjects (the owner/repo slugs to clone).");
  }
  if (source !== "clone" && raw.clone !== undefined) {
    return invalid("`subject.clone` applies only to clone subjects (clone depth/fanout/keep).");
  }
  // localTree is local-tree-ONLY (pack/upload knobs for the packed working tree).
  if (source !== "local-tree" && raw.localTree !== undefined) {
    return invalid("`subject.localTree` applies only to local-tree subjects (keep/exclude/maxArchiveBytes for packing the working tree).");
  }
  // publicTarget is app-url-ONLY (the external-public shared-world ownership attestation). It is
  // meaningless without a real public deployment as the plane — reject it elsewhere (invariant 6).
  if (source !== "app-url" && raw.publicTarget !== undefined) {
    return invalid("`subject.publicTarget` applies only to app-url subjects on the external-public shared-world route (the operator's ownership attestation for a real public deployment used directly as the shared plane).");
  }

  if (source === "clone") {
    const repos = strList(raw.repos);
    if (!repos || repos.length === 0) {
      return invalid("`subject.repos` must list at least one owner/repo slug when source is clone.");
    }
    subject.repos = repos;
    const clone = parseClone(raw.clone);
    if (clone) {
      subject.clone = clone;
    }
    const serveResult = parseServe(raw.serve);
    if (!serveResult.ok) {
      return serveResult;
    }
    if (serveResult.value) subject.serve = serveResult.value;
    if (raw.env !== undefined) {
      const env = strList(raw.env);
      if (!env || env.length === 0) {
        return invalid("`subject.env` must be a non-empty list of env var NAMES when set.");
      }
      const badName = env.find((name) => !ENV_NAME_PATTERN.test(name));
      if (badName) {
        return invalid(`subject.env entries must be env var NAMES like DATABASE_URL (got "${badName}"); values come from the caller's environment and are never persisted.`);
      }
      subject.env = env;
    }
    const envValuesResult = parseEnvValues(raw.envValues);
    if (!envValuesResult.ok) return envValuesResult;
    if (envValuesResult.value) subject.envValues = envValuesResult.value;
    const stateResult = parseState(raw.state);
    if (!stateResult.ok) {
      return stateResult;
    }
    if (stateResult.value) {
      // Semantic validation is shared with the engine (runCuaActorLab re-enforces it for
      // configs that arrive through the library API without the parser).
      const reason = subjectStateInvalidReason(stateResult.value, subject.env);
      if (reason) {
        return invalid(reason);
      }
      subject.state = stateResult.value;
    }
  }

  if (source === "local-tree") {
    // A local-tree subject exists to be packed and served; there is no other way to boot it, so
    // serve is REQUIRED here (unlike clone, where serve is optional for the smoke/meta routes).
    if (raw.serve === undefined) {
      return invalid("`subject.serve` is required when source is local-tree: a local-tree subject exists to be packed and served, so declare install/build/start/url exactly like the clone route.");
    }
    const serveResult = parseServe(raw.serve);
    if (!serveResult.ok) {
      return serveResult;
    }
    if (serveResult.value) subject.serve = serveResult.value;
    if (raw.env !== undefined) {
      const env = strList(raw.env);
      if (!env || env.length === 0) {
        return invalid("`subject.env` must be a non-empty list of env var NAMES when set.");
      }
      const badName = env.find((name) => !ENV_NAME_PATTERN.test(name));
      if (badName) {
        return invalid(`subject.env entries must be env var NAMES like DATABASE_URL (got "${badName}"); values come from the caller's environment and are never persisted.`);
      }
      subject.env = env;
    }
    const envValuesResult = parseEnvValues(raw.envValues);
    if (!envValuesResult.ok) return envValuesResult;
    if (envValuesResult.value) subject.envValues = envValuesResult.value;
    const stateResult = parseState(raw.state);
    if (!stateResult.ok) {
      return stateResult;
    }
    if (stateResult.value) {
      // Semantic validation is shared with the engine (same helper the clone route uses).
      const reason = subjectStateInvalidReason(stateResult.value, subject.env);
      if (reason) {
        return invalid(reason);
      }
      subject.state = stateResult.value;
    }
    const localTreeResult = parseLocalTree(raw.localTree);
    if (!localTreeResult.ok) {
      return localTreeResult;
    }
    if (localTreeResult.value) {
      subject.localTree = localTreeResult.value;
    }
  }

  if (source === "app-url" || source === "local-app") {
    const appUrl = str(raw.appUrl);
    if (!appUrl) {
      return invalid(`\`subject.appUrl\` is required when source is ${source}.`);
    }
    // app-url: shape-only here; the loopback-vs-public-target gate is applied in the
    // cross-validation block below, where policies.allowPublicTargets is available.
    // local-app: an in-process local dev server — ALWAYS loopback (no public-target option),
    // so the loopback wall is enforced right here at parse.
    if (source === "local-app") {
      if (!isLoopbackUrl(appUrl)) {
        return invalid("`subject.appUrl` must be a loopback URL (127.0.0.1/localhost) on a local-app subject — it drives an already-running LOCAL dev server in-process; public targets are not supported on this route.");
      }
    } else if (!isHttpUrl(appUrl)) {
      return invalid("`subject.appUrl` must be an http(s) URL.");
    }
    subject.appUrl = appUrl;
    // publicTarget (external-public shared-world ownership attestation) is app-url-only. Shape it
    // here; its REQUIRED-on-that-route semantics live in externalPublicSharedWorldValidationReason.
    if (source === "app-url" && raw.publicTarget !== undefined) {
      const publicTargetResult = parsePublicTarget(raw.publicTarget);
      if (!publicTargetResult.ok) {
        return publicTargetResult;
      }
      subject.publicTarget = publicTargetResult.value;
    }
  }

  if (source === "terminal-product" || source === "desktop-cli") {
    const productResult = parseProduct(raw.product);
    if (!productResult.ok) {
      return productResult;
    }
    subject.product = productResult.value;
  }

  return { ok: true, value: subject };
}

// The publicTarget.owner is a public-safe operator/repo label surfaced in evidence (e.g.
// "example-operator/lobby-trivia" or a bare org name). Slash allowed for the owner/repo convention.
const PUBLIC_TARGET_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;

/** Parse the external-public shared-world ownership attestation ({ owner, authorized: true }). The
 *  harness cannot verify ownership — this is author-trust, surfaced honestly in the evidence class. */
function parsePublicTarget(raw: unknown): { ok: true; value: { owner: string; authorized: boolean } } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid("`subject.publicTarget` must be an object ({ owner, authorized: true }) — the operator's ownership attestation for the external-public shared plane.");
  }
  const owner = str(raw.owner);
  if (!owner || !PUBLIC_TARGET_OWNER_PATTERN.test(owner)) {
    return invalid("`subject.publicTarget.owner` must be a public-safe operator/repo label (e.g. owner/repo); it is recorded in evidence, so it must carry no secret.");
  }
  if (raw.authorized !== true) {
    return invalid("`subject.publicTarget.authorized` must be true — you must attest you own/operate the public deployment used as the shared plane (author-trust; the harness cannot verify ownership).");
  }
  return { ok: true, value: { owner, authorized: true } };
}

// The product name interpolates into evidence labels and the composed prompt; the public-safe
// token shape is the same load-bearing constraint as a lab id.
const PRODUCT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function parseProduct(raw: unknown): { ok: true; value: LabSubjectProduct } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid("`subject.product` is required on terminal-product subjects and must be an object ({ name, publicSurfaces }).");
  }
  const name = str(raw.name);
  if (!name || !PRODUCT_NAME_PATTERN.test(name)) {
    return invalid("`subject.product.name` must be a public-safe token starting with a letter or digit (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).");
  }
  const workdir = str(raw.workdir);
  if (raw.workdir !== undefined && (workdir === undefined || !/^[A-Za-z0-9_./-]+$/.test(workdir))) {
    return invalid("`subject.product.workdir` must be a plain path (it interpolates into an in-sandbox command).");
  }
  const upload = str(raw.upload);
  if (raw.upload !== undefined) {
    if (upload === undefined || upload.trim().length === 0) {
      return invalid("`subject.product.upload` must be a non-empty project-relative path when set.");
    }
    if (upload.startsWith("/") || /^[A-Za-z]:/.test(upload) || upload.split(/[\\/]/).includes("..")) {
      return invalid("`subject.product.upload` must stay inside the project — no absolute paths and no `..` segments.");
    }
  }
  const install = str(raw.install);
  if (raw.install !== undefined && (install === undefined || install.trim().length === 0)) {
    return invalid("`subject.product.install` must be a non-empty command string when set.");
  }
  const publicSurfaces = strList(raw.publicSurfaces);
  if (!publicSurfaces || publicSurfaces.length === 0) {
    return invalid("`subject.product.publicSurfaces` must list at least one public surface URL.");
  }
  const badSurface = publicSurfaces.find((surface) => !isHttpUrl(surface));
  if (badSurface) {
    return invalid(`subject.product.publicSurfaces entries must be http(s) URLs (got "${badSurface}").`);
  }
  return { ok: true, value: { name, publicSurfaces, ...(install === undefined ? {} : { install }), ...(workdir === undefined ? {} : { workdir }), ...(upload === undefined ? {} : { upload }) } };
}

// Public-safe stance: a computer-use actor's ENTRY URL is always an app the lab owner runs on
// loopback (inside the sandbox), never an arbitrary public site. (The constraint binds the
// entry point; a navigation watchdog for mid-session escapes is a later slice.) Exported so
// the engine re-enforces the same boundary on configs that arrive through the library API.
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** A well-formed http(s) URL (any host). Shape gate before the loopback/public-target policy. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseServe(raw: unknown): { ok: true; value: LabSubjectServe | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`subject.serve` must be an object ({ install?, build?, start, url, readyTimeoutMs? }).");
  }
  const start = str(raw.start);
  if (!start) {
    return invalid("`subject.serve.start` is required when serve is set (the long-lived command that serves the app).");
  }
  const url = str(raw.url);
  if (!url || !isLoopbackUrl(url)) {
    return invalid("`subject.serve.url` must be a loopback http(s) URL (127.0.0.1 or localhost) — the app is served INSIDE the sandbox.");
  }
  const serve: LabSubjectServe = { start, url };
  const install = str(raw.install);
  if (install) serve.install = install;
  const build = str(raw.build);
  if (build) serve.build = build;
  const readyTimeoutMs = posInt(raw.readyTimeoutMs);
  if (readyTimeoutMs !== undefined) serve.readyTimeoutMs = readyTimeoutMs;
  const installTimeoutMs = posInt(raw.installTimeoutMs);
  if (installTimeoutMs !== undefined) serve.installTimeoutMs = installTimeoutMs;
  const buildTimeoutMs = posInt(raw.buildTimeoutMs);
  if (buildTimeoutMs !== undefined) serve.buildTimeoutMs = buildTimeoutMs;
  return { ok: true, value: serve };
}

/**
 * Structural parse of `subject.state` into a candidate LabSubjectState. Deliberately keeps
 * unrecognized `when`/`timeoutMs` values in the candidate (instead of silently dropping
 * them) so subjectStateInvalidReason rejects them — a state declaration that silently does
 * less than it says would violate invariant 6.
 */
/**
 * LITERAL non-secret subject env. Real apps need configuration before they will boot — a public base
 * URL, a transport selector, a feature flag — and none of that is secret. Routing it through
 * `subject.env` would force an adopter to carry a private env file just to reproduce a public study.
 *
 * These values ARE recorded in evidence (they are part of how the subject was configured), so a
 * value that looks like a credential is refused here rather than committed to a public repo.
 */
function parseEnvValues(raw: unknown): { ok: true; value?: Record<string, string> } | LabConfigParseFailure {
  if (raw === undefined) return { ok: true };
  if (!isRecord(raw)) {
    return invalid("`subject.envValues` must be a mapping of env var NAME to a literal non-secret value.");
  }
  const envValues: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(raw)) {
    if (!ENV_NAME_PATTERN.test(name)) {
      return invalid(`subject.envValues keys must be env var NAMES like NEXT_PUBLIC_APP_URL (got "${name}").`);
    }
    const value = typeof rawValue === "number" || typeof rawValue === "boolean" ? String(rawValue) : str(rawValue);
    if (value === undefined) {
      return invalid(`\`subject.envValues.${name}\` must be a string, number, or boolean.`);
    }
    // Reuse the redaction module's own detector rather than inventing a second opinion about what
    // a secret looks like — the two must never disagree about the same string.
    if (containsSensitive(value)) {
      return invalid(
        `\`subject.envValues.${name}\` looks like a secret or a local path, and these values are committed with the lab and recorded in evidence. Declare the NAME in \`subject.env\` instead — those values come from the caller's environment and never persist.`
      );
    }
    envValues[name] = value;
  }
  return { ok: true, value: envValues };
}

function parseState(raw: unknown): { ok: true; value: LabSubjectState | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`subject.state` must be an object ({ seed?, external? }).");
  }
  const state: LabSubjectState = {};
  if (raw.seed !== undefined) {
    if (!Array.isArray(raw.seed) || !raw.seed.every(isRecord)) {
      return invalid("`subject.state.seed` must be an array of step objects ({ name, command, when?, timeoutMs? }).");
    }
    state.seed = raw.seed.map((entry) => ({
      name: typeof entry.name === "string" ? entry.name.trim() : "",
      command: typeof entry.command === "string" ? entry.command.trim() : "",
      ...(entry.when === undefined ? {} : { when: entry.when as LabStateStepWhen }),
      ...(entry.timeoutMs === undefined ? {} : { timeoutMs: (posInt(entry.timeoutMs) ?? entry.timeoutMs) as number })
    }));
  }
  if (raw.external !== undefined) {
    const external = strList(raw.external);
    if (!external) {
      return invalid("`subject.state.external` must be a non-empty list of env var NAMES when set.");
    }
    state.external = external;
  }
  if (raw.checkpoint !== undefined) {
    if (!Array.isArray(raw.checkpoint) || !raw.checkpoint.every(isRecord)) {
      return invalid("`subject.state.checkpoint` must be an array of probe objects ({ name, command, redact? }).");
    }
    state.checkpoint = raw.checkpoint.map((probe) => ({
      name: typeof probe.name === "string" ? probe.name.trim() : "",
      command: typeof probe.command === "string" ? probe.command.trim() : "",
      // Preserve the redact list verbatim (literal secret values may contain commas, so do NOT
      // run it through the comma-splitting strList); subjectStateInvalidReason validates the shape.
      ...(probe.redact === undefined ? {} : { redact: probe.redact as string[] })
    }));
  }
  return { ok: true, value: state };
}

// The step name interpolates into in-sandbox script/status/log paths (`subject-state-<name>`);
// the strict shape is load-bearing, exactly like the repo slug.
const STATE_STEP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const STATE_STEP_NAME_MAX_CHARS = 40;
const STATE_STEP_WHENS: readonly LabStateStepWhen[] = ["before-build", "before-start", "after-ready"];

/**
 * Semantic validation for `subject.state`, shared by parseLabConfig and the engine
 * (runCuaActorLab re-enforces it on configs that arrive through the library API). Returns
 * the failure message, or null when the declaration is valid. Reads the candidate
 * defensively — library callers can hand the engine arbitrarily-shaped objects.
 */
export function subjectStateInvalidReason(state: LabSubjectState, env: readonly string[] | undefined): string | null {
  const seed = state.seed;
  const external = state.external;
  const checkpoint = state.checkpoint;
  if ((seed === undefined || seed.length === 0)
    && (external === undefined || external.length === 0)
    && (checkpoint === undefined || checkpoint.length === 0)) {
    return "`subject.state` must declare seed steps, external env names, and/or checkpoints (an empty state block would be inert).";
  }
  if (seed !== undefined) {
    if (!Array.isArray(seed) || seed.length === 0) {
      return "`subject.state.seed` must be a non-empty array of steps when set.";
    }
    const names = new Set<string>();
    for (const [index, step] of seed.entries()) {
      const name = typeof step?.name === "string" ? step.name : "";
      if (!STATE_STEP_NAME_PATTERN.test(name) || name.length > STATE_STEP_NAME_MAX_CHARS) {
        return `subject.state.seed[${index}].name must match ${STATE_STEP_NAME_PATTERN} and be at most ${STATE_STEP_NAME_MAX_CHARS} chars (it names in-sandbox file paths); got "${name}".`;
      }
      if (names.has(name)) {
        return `subject.state.seed step names must be unique (duplicate "${name}").`;
      }
      names.add(name);
      if (typeof step.command !== "string" || step.command.trim().length === 0) {
        return `subject.state.seed[${index}].command is required (the in-sandbox shell command that seeds the state).`;
      }
      if (step.when !== undefined && !STATE_STEP_WHENS.includes(step.when)) {
        return `subject.state.seed[${index}].when must be one of: ${STATE_STEP_WHENS.join(", ")}.`;
      }
      if (step.timeoutMs !== undefined && !(typeof step.timeoutMs === "number" && Number.isSafeInteger(step.timeoutMs) && step.timeoutMs >= 1)) {
        return `subject.state.seed[${index}].timeoutMs must be a positive integer.`;
      }
    }
  }
  if (external !== undefined) {
    if (!Array.isArray(external) || external.length === 0) {
      return "`subject.state.external` must be a non-empty list of env var NAMES when set.";
    }
    for (const name of external) {
      if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
        return "subject.state.external entries must be env var NAMES like DATABASE_URL; values come from the caller's environment and are never persisted.";
      }
      if (!env?.includes(name)) {
        return "subject.state.external names must also be declared in subject.env (the declaration must name a provisioned channel).";
      }
    }
  }
  if (checkpoint !== undefined) {
    if (!Array.isArray(checkpoint) || checkpoint.length === 0) {
      return "`subject.state.checkpoint` must be a non-empty array of probes when set.";
    }
    const names = new Set<string>();
    for (const [index, probe] of checkpoint.entries()) {
      const name = typeof probe?.name === "string" ? probe.name : "";
      if (!STATE_STEP_NAME_PATTERN.test(name) || name.length > STATE_STEP_NAME_MAX_CHARS) {
        return `subject.state.checkpoint[${index}].name must match ${STATE_STEP_NAME_PATTERN} and be at most ${STATE_STEP_NAME_MAX_CHARS} chars (it names in-sandbox file paths); got "${name}".`;
      }
      if (names.has(name)) {
        return `subject.state.checkpoint names must be unique (duplicate "${name}").`;
      }
      names.add(name);
      if (typeof probe.command !== "string" || probe.command.trim().length === 0) {
        return `subject.state.checkpoint[${index}].command is required (the read-only digest probe command).`;
      }
      if (probe.redact !== undefined) {
        if (!Array.isArray(probe.redact) || !probe.redact.every((value) => typeof value === "string" && value.length > 0)) {
          return `subject.state.checkpoint[${index}].redact must be a list of non-empty literal strings when set.`;
        }
      }
    }
  }
  return null;
}

function parseClone(raw: unknown): LabSubjectClone | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const clone: LabSubjectClone = {};
  const depth = posInt(raw.depth);
  if (depth !== undefined) clone.depth = depth;
  const fanout = posInt(raw.fanout);
  if (fanout !== undefined) clone.fanout = fanout;
  if (typeof raw.keep === "boolean") clone.keep = raw.keep;
  return Object.keys(clone).length > 0 ? clone : undefined;
}

/**
 * Structural parse of `subject.localTree`, mirroring parseClone. Unlike parseClone (which
 * silently drops an out-of-range depth/fanout), an invalid exclude/maxArchiveBytes value is
 * REJECTED, never silently dropped: a caller who typed an empty exclude entry or a non-positive
 * maxArchiveBytes almost certainly meant something, and the archive-size cap is a safety knob,
 * not a cosmetic default.
 */
function parseLocalTree(raw: unknown): { ok: true; value: LabSubjectLocalTree | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`subject.localTree` must be an object ({ keep?, exclude?, maxArchiveBytes? }).");
  }
  const localTree: LabSubjectLocalTree = {};
  if (raw.keep !== undefined) {
    if (typeof raw.keep !== "boolean") {
      return invalid("`subject.localTree.keep` must be a boolean (YAML true/false, not a quoted string).");
    }
    localTree.keep = raw.keep;
  }
  if (raw.exclude !== undefined) {
    if (!Array.isArray(raw.exclude) || raw.exclude.some((item) => typeof item !== "string" || item.trim().length === 0)) {
      return invalid("`subject.localTree.exclude` must be a list of non-empty strings (extra archive excludes on top of the always-on denylist).");
    }
    const exclude = strList(raw.exclude);
    if (exclude) {
      // Normalize/validate each entry at parse time so a mis-shaped exclude the
      // author believed in can never silently no-op at packing time: absolute
      // paths and glob syntax are rejected with the packing boundary's own
      // reason; "./prefix" and "prefix/" normalize to the enumeration relPath
      // shape.
      const normalized: string[] = [];
      for (const entry of exclude) {
        try {
          normalized.push(normalizeExtraExcludeEntry(entry));
        } catch (error) {
          return invalid(`\`subject.localTree.exclude\`: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      localTree.exclude = normalized;
    }
  }
  if (raw.maxArchiveBytes !== undefined) {
    const maxArchiveBytes = posInt(raw.maxArchiveBytes);
    if (maxArchiveBytes === undefined) {
      return invalid("`subject.localTree.maxArchiveBytes` must be a positive integer number of bytes when set.");
    }
    localTree.maxArchiveBytes = maxArchiveBytes;
  }
  return { ok: true, value: Object.keys(localTree).length > 0 ? localTree : undefined };
}

function parseActors(raw: unknown): { ok: true; value: LabActor[] } | LabConfigParseFailure {
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid("Lab `actors` must be a non-empty array.");
  }
  // Multi-actor fan-out is not wired yet (only actors[0] is consumed). Fail closed rather than
  // silently ignore actors[1..]; multi-actor support lands in a later slice.
  if (raw.length > 1) {
    return invalid("Multiple actors are not supported yet (only the first actor runs); declare a single actor.");
  }
  const actors: LabActor[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return invalid(`actors[${index}] must be an object.`);
    }
    const type = str(entry.type);
    if (!type) {
      return invalid(`actors[${index}].type is required.`);
    }
    const actor: LabActor = { type };
    const count = posInt(entry.count);
    if (count !== undefined) actor.count = count;
    if (entry.lanes !== undefined && entry.roster !== undefined) {
      return invalid(`actors[${index}].lanes and actors[${index}].roster are mutually exclusive — use explicit lanes OR compact roster groups, not both.`);
    }
    if (entry.roster !== undefined && count !== undefined) {
      return invalid(`actors[${index}].roster and actors[${index}].count are mutually exclusive — use compact differentiated groups OR a homogeneous count, not both.`);
    }
    if (entry.roster !== undefined && entry.laneFocus !== undefined) {
      return invalid(`actors[${index}].roster and actors[${index}].laneFocus are mutually exclusive — a roster group's instruction is the per-lane steer.`);
    }
    const lanesResult = entry.roster !== undefined
      ? parseRosterGroups(entry.roster, index)
      : parseLanes(entry.lanes, index);
    if (!lanesResult.ok) {
      return lanesResult;
    }
    if (lanesResult.value) actor.lanes = lanesResult.value;
    const persona = str(entry.persona);
    if (persona) actor.persona = persona;
    const mission = str(entry.mission);
    if (mission) actor.mission = mission;
    const model = str(entry.model);
    if (model) actor.model = model;
    if (entry.maxOutputTokens !== undefined) {
      if (!isMaxOutputTokens(entry.maxOutputTokens)) return invalid(`actors[${index}].maxOutputTokens must be a positive safe integer.`);
      actor.maxOutputTokens = entry.maxOutputTokens;
    }
    const localAgent = str(entry.localAgent);
    if (entry.localAgent !== undefined) {
      if (localAgent !== "codex" && localAgent !== "claude") {
        return invalid(`actors[${index}].localAgent must be "codex" or "claude" (the locally signed-in CLI that drives the study).`);
      }
      actor.localAgent = localAgent;
    }
    if (entry.reasoningEffort !== undefined) {
      if (!isReasoningEffort(entry.reasoningEffort)) {
        return invalid(`actors[${index}].reasoningEffort must be one of: ${reasoningEffortNames()}. Support is model-dependent, so a level this model does not accept fails on the first turn rather than being silently downgraded.`);
      }
      actor.reasoningEffort = entry.reasoningEffort;
    }
    const stopWhenResult = parseStopWhen(entry.stopWhen, `actors[${index}].stopWhen`);
    if (!stopWhenResult.ok) return stopWhenResult;
    if (stopWhenResult.value !== undefined) actor.stopWhen = stopWhenResult.value;
    const dwellResult = parseDwell(entry.dwell, `actors[${index}].dwell`);
    if (!dwellResult.ok) return dwellResult;
    if (dwellResult.value !== undefined) actor.dwell = dwellResult.value;
    const tasksResult = parseTasks(entry.tasks, `actors[${index}].tasks`);
    if (!tasksResult.ok) return tasksResult;
    if (tasksResult.value !== undefined) actor.tasks = tasksResult.value;
    const laneFocus = parseLaneFocus(entry.laneFocus);
    if (laneFocus) actor.laneFocus = laneFocus;
    actors.push(actor);
  }
  return { ok: true, value: actors };
}

function parseLaneFocus(raw: unknown): LabActorLaneFocus | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const laneFocus: LabActorLaneFocus = {};
  const id = str(raw.id);
  if (id) laneFocus.id = id;
  const label = str(raw.label);
  if (label) laneFocus.label = label;
  const instruction = str(raw.instruction);
  if (instruction) laneFocus.instruction = instruction;
  return Object.keys(laneFocus).length > 0 ? laneFocus : undefined;
}

// Like review fields, a declared lane distinction must not disappear silently (#343).
// The exhaustive records make newly added interface fields require an explicit parser decision.
const LANE_FIELDS: Record<keyof LabActorLane, true> = {
  id: true, actorType: true, surface: true, caseGroup: true, persona: true,
  device: true, instruction: true, stopWhen: true, dwell: true, reasoningEffort: true,
  target: true, entry: true, host: true
};
const ROSTER_GROUP_FIELDS: Record<keyof LabActorRosterGroup, true> = { ...LANE_FIELDS, count: true };
const LANE_KEYS = new Set(Object.keys(LANE_FIELDS));
const ROSTER_GROUP_KEYS = new Set(Object.keys(ROSTER_GROUP_FIELDS));

/**
 * Parse `actors[index].roster` compact groups into concrete lanes. This is authoring sugar for
 * "N users of M adapter-owned types across S surfaces"; the runtime receives only `lanes[]`.
 */
function parseRosterGroups(raw: unknown, actorIndex: number): { ok: true; value: LabActorLane[] | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid(`actors[${actorIndex}].roster must be a non-empty array of group objects ({ id, count, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry? }) when set.`);
  }

  const expanded: LabActorLane[] = [];
  const seenGroupIds = new Set<string>();
  for (const [groupIndex, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return invalid(`actors[${actorIndex}].roster[${groupIndex}] must be an object ({ id, count, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry? }).`);
    }
    const unknownKeys = Object.keys(entry).filter((key) => !ROSTER_GROUP_KEYS.has(key));
    if (unknownKeys.length > 0) {
      return invalid(`Unknown \`actors[${actorIndex}].roster[${groupIndex}]\` field(s): ${unknownKeys.join(", ")}. Known roster group fields: ${[...ROSTER_GROUP_KEYS].join(", ")}.`);
    }
    const groupId = str(entry.id);
    if (groupId === undefined) {
      return invalid(`actors[${actorIndex}].roster[${groupIndex}].id is required and must be a public-safe token matching ${LANE_ID_PATTERN}.`);
    }
    if (!LANE_ID_PATTERN.test(groupId) || groupId.length > LANE_ID_MAX_CHARS - 3) {
      return invalid(`actors[${actorIndex}].roster[${groupIndex}].id must be a public-safe token matching ${LANE_ID_PATTERN} and at most ${LANE_ID_MAX_CHARS - 3} chars (generated lanes use <id>-NN); got "${groupId}".`);
    }
    if (seenGroupIds.has(groupId)) {
      return invalid(`actors[${actorIndex}].roster group ids must be unique (duplicate "${groupId}").`);
    }
    seenGroupIds.add(groupId);
    const count = posInt(entry.count);
    if (count === undefined) {
      return invalid(`actors[${actorIndex}].roster[${groupIndex}].count is required and must be a positive integer.`);
    }
    const groupLaneInput: Record<string, unknown> = { ...entry };
    delete groupLaneInput.id;
    delete groupLaneInput.count;
    for (let i = 1; i <= count; i += 1) {
      expanded.push({
        ...groupLaneInput,
        id: `${groupId}-${String(i).padStart(2, "0")}`
      });
    }
  }

  return parseLanes(expanded, actorIndex);
}

/**
 * Parse `actors[index].lanes` into a fan-out roster (computer-use E2B route). Structural only:
 * each lane is `{ id?, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry? }`.
 * Lane ids (when declared) must be public-safe path tokens and unique; lane grouping metadata
 * must be public-safe tokens; a lane device must be a known preset name. The
 * route-scoped cross-validation (lanes XOR count/laneFocus, device XOR raw resolution, cap 16)
 * runs in parseLabConfig where the route is known.
 */
function parseLanes(raw: unknown, actorIndex: number): { ok: true; value: LabActorLane[] | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid(`actors[${actorIndex}].lanes must be a non-empty array of lane objects ({ id?, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry? }) when set.`);
  }
  const lanes: LabActorLane[] = [];
  const seenIds = new Set<string>();
  for (const [laneIndex, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return invalid(`actors[${actorIndex}].lanes[${laneIndex}] must be an object ({ id?, actorType?, surface?, caseGroup?, persona?, device?, instruction?, target?, entry? }).`);
    }
    const unknownKeys = Object.keys(entry).filter((key) => !LANE_KEYS.has(key));
    if (unknownKeys.length > 0) {
      return invalid(`Unknown \`actors[${actorIndex}].lanes[${laneIndex}]\` field(s): ${unknownKeys.join(", ")}. Known lane fields: ${[...LANE_KEYS].join(", ")}.`);
    }
    const lane: LabActorLane = {};
    const id = str(entry.id);
    if (id !== undefined) {
      if (!LANE_ID_PATTERN.test(id) || id.length > LANE_ID_MAX_CHARS) {
        return invalid(`actors[${actorIndex}].lanes[${laneIndex}].id must be a public-safe token matching ${LANE_ID_PATTERN} and at most ${LANE_ID_MAX_CHARS} chars (it names per-lane evidence paths); got "${id}".`);
      }
      if (seenIds.has(id)) {
        return invalid(`actors[${actorIndex}].lanes ids must be unique (duplicate "${id}").`);
      }
      seenIds.add(id);
      lane.id = id;
    }
    const device = str(entry.device);
    if (device !== undefined) {
      if (!isDevicePresetName(device)) {
        return invalid(`actors[${actorIndex}].lanes[${laneIndex}].device must be one of: ${DEVICE_PRESET_NAMES.join(", ")}.`);
      }
      lane.device = device;
    }
    const persona = str(entry.persona);
    if (persona !== undefined) lane.persona = persona;
    const actorType = parseLaneMetadata(entry.actorType, `actors[${actorIndex}].lanes[${laneIndex}].actorType`);
    if (!actorType.ok) return actorType;
    if (actorType.value !== undefined) lane.actorType = actorType.value;
    const surface = parseLaneMetadata(entry.surface, `actors[${actorIndex}].lanes[${laneIndex}].surface`);
    if (!surface.ok) return surface;
    if (surface.value !== undefined) lane.surface = surface.value;
    const caseGroup = parseLaneMetadata(entry.caseGroup, `actors[${actorIndex}].lanes[${laneIndex}].caseGroup`);
    if (!caseGroup.ok) return caseGroup;
    if (caseGroup.value !== undefined) lane.caseGroup = caseGroup.value;
    const instruction = str(entry.instruction);
    if (instruction !== undefined) lane.instruction = instruction;
    const stopWhenResult = parseStopWhen(entry.stopWhen, `actors[${actorIndex}].lanes[${laneIndex}].stopWhen`);
    if (!stopWhenResult.ok) return stopWhenResult;
    if (stopWhenResult.value !== undefined) lane.stopWhen = stopWhenResult.value;
    const dwellResult = parseDwell(entry.dwell, `actors[${actorIndex}].lanes[${laneIndex}].dwell`);
    if (!dwellResult.ok) return dwellResult;
    if (dwellResult.value !== undefined) lane.dwell = dwellResult.value;
    if (entry.reasoningEffort !== undefined) {
      if (!isReasoningEffort(entry.reasoningEffort)) {
        return invalid(`actors[${actorIndex}].lanes[${laneIndex}].reasoningEffort must be one of: ${reasoningEffortNames()}. Support is model-dependent, so a level this model does not accept fails on the first turn rather than being silently downgraded.`);
      }
      lane.reasoningEffort = entry.reasoningEffort;
    }
    const target = str(entry.target);
    if (target !== undefined) {
      if (!isHttpUrl(target)) {
        return invalid(`actors[${actorIndex}].lanes[${laneIndex}].target must be an absolute http(s) URL.`);
      }
      lane.target = target;
    }
    // `entry` is shape-captured here; the same-origin-with-serve.url check needs serve context, so
    // it runs in sharedWorldValidationReason (where the route + serve.url are known).
    const laneEntry = str(entry.entry);
    if (laneEntry !== undefined) lane.entry = laneEntry;
    // `host` marks the designated host seat on the external-public shared-world route; the
    // exactly-one-host check runs in externalPublicSharedWorldValidationReason (route context).
    if (entry.host !== undefined) {
      if (typeof entry.host !== "boolean") {
        return invalid(`actors[${actorIndex}].lanes[${laneIndex}].host must be a boolean (marks the designated host seat on the external-public shared-world route).`);
      }
      if (entry.host) lane.host = true;
    }
    lanes.push(lane);
  }
  return { ok: true, value: lanes };
}

/**
 * The researcher's protocol. Each task carries what the participant is asked to do and, optionally,
 * the observation that proves it happened — reusing `stopWhen`, so a criterion is exactly as
 * expressive as a stop condition and an author who knows one knows the other.
 *
 * A task with no `success` is allowed on purpose: some things you ask a participant to do (think
 * aloud, say what confused you) are not observable, and the funnel reports them as unmeasurable
 * rather than quietly counting them failed.
 */
function parseTasks(raw: unknown, field: string): { ok: true; value: LabTask[] | undefined } | LabConfigParseFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length === 0) {
    return invalid(`\`${field}\` must be a non-empty list of tasks when set.`);
  }
  const tasks: LabTask[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) return invalid(`each \`${field}\` entry must be a mapping.`);
    const id = str(entry.id);
    if (id === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
      return invalid(`\`${field}[${index}].id\` must be a short id like "sign-up".`);
    }
    if (seen.has(id)) return invalid(`\`${field}\` has a duplicate task id "${id}"; ids appear in evidence and must be unique.`);
    seen.add(id);
    const goal = str(entry.goal);
    if (goal === undefined) {
      return invalid(`\`${field}[${index}].goal\` is required — what the PARTICIPANT is asked to do, in their language.`);
    }
    const successResult = parseStopWhen(entry.success, `${field}[${index}].success`);
    if (!successResult.ok) return successResult;
    tasks.push({ id, goal, ...(successResult.value === undefined ? {} : { success: successResult.value }) });
  }
  return { ok: true, value: tasks };
}

/** The bounds a dwell window (#510) must sit inside: at least one frame, at most an hour. */
export const DWELL_MIN_MS = 1_000;
export const DWELL_MAX_MS = 3_600_000;
export const DWELL_DEFAULT_EVERY_MS = 10_000;

function parseDwell(raw: unknown, field: string): { ok: true; value: DwellWindow | undefined } | LabConfigParseFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid(`${field} must be an object with ms (and optional when, everyMs, then).`);
  const entry = raw as Record<string, unknown>;
  const ms = entry.ms;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < DWELL_MIN_MS || ms > DWELL_MAX_MS) {
    return invalid(`${field}.ms must be an integer between ${DWELL_MIN_MS} and ${DWELL_MAX_MS} milliseconds.`);
  }
  const everyMs = entry.everyMs === undefined ? DWELL_DEFAULT_EVERY_MS : entry.everyMs;
  if (typeof everyMs !== "number" || !Number.isInteger(everyMs) || everyMs < DWELL_MIN_MS || everyMs > ms) {
    return invalid(`${field}.everyMs must be an integer between ${DWELL_MIN_MS} and ${field}.ms.`);
  }
  const then = entry.then === undefined ? "continue" : entry.then;
  if (then !== "continue" && then !== "stop") return invalid(`${field}.then must be "continue" or "stop".`);
  const whenResult = parseStopWhen(entry.when, `${field}.when`);
  if (!whenResult.ok) return whenResult;
  return { ok: true, value: { ...(whenResult.value === undefined ? {} : { when: whenResult.value }), ms, everyMs, then } };
}

function parseStopWhen(raw: unknown, field: string): { ok: true; value: StopWhen | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid(`${field} must be an object ({ any: [{ id?, urlIncludes?, urlPathEquals?, textIncludes?, appStatePathEquals? }] }).`);
  }
  if (!Array.isArray(raw.any) || raw.any.length === 0) {
    return invalid(`${field}.any must be a non-empty array of stop condition rules.`);
  }
  const any: StopWhenRule[] = [];
  for (const [index, entry] of raw.any.entries()) {
    if (!isRecord(entry)) {
      return invalid(`${field}.any[${index}] must be an object ({ id?, urlIncludes?, urlPathEquals?, textIncludes?, appStatePathEquals? }).`);
    }
    const rule: StopWhenRule = {};
    const id = str(entry.id);
    if (id !== undefined) {
      if (!LANE_ID_PATTERN.test(id) || id.length > LANE_METADATA_MAX_CHARS) {
        return invalid(`${field}.any[${index}].id must be a public-safe token matching ${LANE_ID_PATTERN} and at most ${LANE_METADATA_MAX_CHARS} chars; got "${id}".`);
      }
      rule.id = id;
    }
    const urlIncludes = str(entry.urlIncludes);
    if (urlIncludes !== undefined) {
      rule.urlIncludes = urlIncludes;
    }
    const urlPathEquals = str(entry.urlPathEquals);
    if (urlPathEquals !== undefined) {
      if (!urlPathEquals.startsWith("/") || urlPathEquals.startsWith("//")) {
        return invalid(`${field}.any[${index}].urlPathEquals must be an absolute URL path starting with one slash.`);
      }
      rule.urlPathEquals = urlPathEquals;
    }
    const textIncludes = str(entry.textIncludes);
    if (textIncludes !== undefined) {
      rule.textIncludes = textIncludes;
    }
    if (entry.appStatePathEquals !== undefined) {
      const parsed = parseStopWhenAppStatePathEquals(entry.appStatePathEquals, `${field}.any[${index}].appStatePathEquals`);
      if (!parsed.ok) return parsed;
      rule.appStatePathEquals = parsed.value;
    }
    if (rule.urlIncludes === undefined && rule.urlPathEquals === undefined && rule.textIncludes === undefined && rule.appStatePathEquals === undefined) {
      return invalid(`${field}.any[${index}] must declare at least one condition: urlIncludes, urlPathEquals, textIncludes, or appStatePathEquals.`);
    }
    any.push(rule);
  }
  return { ok: true, value: { any } };
}

function parseStopWhenAppStatePathEquals(
  raw: unknown,
  field: string
): { ok: true; value: { path: string; equals: StopConditionPrimitive } } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return invalid(`${field} must be an object ({ path, equals }).`);
  }
  const pathValue = str(raw.path);
  if (pathValue === undefined) {
    return invalid(`${field}.path is required and must be a dot-separated public-safe path.`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(pathValue)) {
    return invalid(`${field}.path must contain only letters, digits, underscore, dash, and dot.`);
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "equals")) {
    return invalid(`${field}.equals is required.`);
  }
  const equals = raw.equals;
  if (equals !== null && typeof equals !== "string" && typeof equals !== "number" && typeof equals !== "boolean") {
    return invalid(`${field}.equals must be a string, number, boolean, or null.`);
  }
  return { ok: true, value: { path: pathValue, equals } };
}

function parseLaneMetadata(raw: unknown, field: string): { ok: true; value: string | undefined } | LabConfigParseFailure {
  const value = str(raw);
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!LANE_ID_PATTERN.test(value) || value.length > LANE_METADATA_MAX_CHARS) {
    return invalid(`${field} must be a public-safe token matching ${LANE_ID_PATTERN} and at most ${LANE_METADATA_MAX_CHARS} chars; got "${value}".`);
  }
  return { ok: true, value };
}

function parseExecution(raw: unknown): { ok: true; value: LabExecution | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`execution` must be an object.");
  }
  const execution: LabExecution = {};
  if (raw.target !== undefined) {
    const target = str(raw.target);
    if (target !== "local" && target !== "e2b-desktop" && target !== "e2b-terminal") {
      return invalid("`execution.target` must be local, e2b-desktop, or e2b-terminal.");
    }
    execution.target = target;
  }
  const timeoutMs = posInt(raw.timeoutMs);
  if (timeoutMs !== undefined) execution.timeoutMs = timeoutMs;
  const completionTimeoutMs = posInt(raw.completionTimeoutMs);
  if (completionTimeoutMs !== undefined) execution.completionTimeoutMs = completionTimeoutMs;
  const concurrency = posInt(raw.concurrency);
  if (concurrency !== undefined) execution.concurrency = concurrency;
  const desktopResult = parseDesktop(raw.desktop);
  if (!desktopResult.ok) {
    return desktopResult;
  }
  if (desktopResult.value) execution.desktop = desktopResult.value;
  // Reuse the terminal lane's caps parser (same shape, not a fork) — a malformed budget is a hard
  // error, never silently dropped (a cap that silently does nothing would be a safety lie).
  const capsResult = parseCaps(raw.caps);
  if (!capsResult.ok) {
    return capsResult;
  }
  if (capsResult.value) execution.caps = capsResult.value;
  const terminalResult = parseTerminal(raw.terminal);
  if (!terminalResult.ok) {
    return terminalResult;
  }
  if (terminalResult.value) execution.terminal = terminalResult.value;
  if (raw.runtime !== undefined) {
    if (!isRecord(raw.runtime) || Object.keys(raw.runtime).some((key) => key !== "version") || !isExactRuntimeVersion(raw.runtime.version)) {
      return invalid("`execution.runtime` must contain only an exact Codex `version` (for example 0.153.3); tags, ranges, URLs, and unknown fields are not accepted.");
    }
    execution.runtime = { version: raw.runtime.version };
  }
  if (raw.runtimeAuth !== undefined) {
    const runtimeAuth = str(raw.runtimeAuth);
    if (runtimeAuth !== "openai-env" && runtimeAuth !== "openai-egress") {
      return invalid("`execution.runtimeAuth` must be openai-env or openai-egress (the terminal agent's runtime-auth channel).");
    }
    execution.runtimeAuth = runtimeAuth;
  }
  if (raw.egressAllow !== undefined) {
    if (!Array.isArray(raw.egressAllow) || raw.egressAllow.some((h) => typeof h !== "string")) {
      return invalid("`execution.egressAllow` must be an array of host strings.");
    }
    const hosts = (raw.egressAllow as string[]).map((h) => h.trim()).filter((h) => h.length > 0);
    if (hosts.length === 0) {
      // An empty list would deny everything including the agent's own model endpoint, which
      // fails as an unexplained hang rather than a refusal. Say so at parse time.
      return invalid(
        "`execution.egressAllow` was declared but empty. Declaring it denies all other egress, so "
        + "an empty list denies everything, including the agent's own provider endpoint. Remove "
        + "the field for unrestricted egress, or list the hosts the run needs."
      );
    }
    execution.egressAllow = hosts;
  }
  return { ok: true, value: Object.keys(execution).length > 0 ? execution : undefined };
}

function parseTerminal(raw: unknown): { ok: true; value: LabExecutionTerminal | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`execution.terminal` must be an object ({ transport?, stdin? }).");
  }
  const terminal: LabExecutionTerminal = {};
  if (raw.transport !== undefined) {
    const transport = str(raw.transport);
    if (transport !== "exec-stream") {
      // "pty" is deliberately rejected: stdin is disabled, so the capture is a non-interactive
      // exec stream — an interactive-PTY label would overstate the mechanism (invariant 6 + the
      // goal packet's PTY ruling). True duplex PTY does not ship.
      return invalid("`execution.terminal.transport` must be exec-stream — captured non-interactive exec output (stdin disabled) is not an interactive PTY; true duplex PTY transport is not supported.");
    }
    terminal.transport = transport;
  }
  if (raw.stdin !== undefined) {
    const stdin = str(raw.stdin);
    if (stdin !== "disabled" && stdin !== "planned" && stdin !== "sent") {
      return invalid("`execution.terminal.stdin` must be disabled, planned, or sent.");
    }
    if (stdin === "sent") {
      // Assisted input is forbidden until the interventions ledger + comparability flag + verify
      // check exist (safety contract item 7) — shipping it now would let an assisted run pose as
      // autonomous green proof.
      return invalid("`execution.terminal.stdin: sent` (assisted input) is not supported — the current route cannot capture assisted input with a non-comparable marker. stdin is disabled by default.");
    }
    terminal.stdin = stdin;
  }
  return { ok: true, value: Object.keys(terminal).length > 0 ? terminal : undefined };
}

function parseDesktop(raw: unknown): { ok: true; value: LabExecutionDesktop | undefined } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return { ok: true, value: undefined };
  }
  const desktop: LabExecutionDesktop = {};
  if (raw.device !== undefined) {
    const device = str(raw.device);
    if (!device || !isDevicePresetName(device)) {
      return invalid(`\`execution.desktop.device\` must be one of: ${DEVICE_PRESET_NAMES.join(", ")}.`);
    }
    desktop.device = device;
  }
  if (raw.resolution !== undefined) {
    const resolution = raw.resolution;
    if (!Array.isArray(resolution) || resolution.length !== 2 || !resolution.every((value) => Number.isInteger(value) && (value as number) > 0)) {
      return invalid("`execution.desktop.resolution` must be two positive integers [width, height].");
    }
    desktop.resolution = [resolution[0] as number, resolution[1] as number];
  }
  const sandboxTimeoutMs = posInt(raw.sandboxTimeoutMs);
  if (sandboxTimeoutMs !== undefined) desktop.sandboxTimeoutMs = sandboxTimeoutMs;
  if (raw.browser !== undefined) {
    const browser = str(raw.browser);
    if (browser !== "default" && browser !== "chrome" && browser !== "chromium" && browser !== "firefox") {
      return invalid("`execution.desktop.browser` must be default, chrome, chromium, or firefox.");
    }
    desktop.browser = browser;
  }
  // A custom E2B desktop template NAME or ID. Trimmed non-empty when present; deliberately NOT
  // allowlisted (any string is a valid template name/id — over-restricting would reject real
  // adopter images). An explicitly-set but blank/whitespace value is a mistake, not a template.
  if (raw.template !== undefined) {
    const template = str(raw.template);
    if (template === undefined) {
      return invalid("`execution.desktop.template` must be a non-empty E2B desktop template NAME or ID when set (any string is accepted; there is no allowlist).");
    }
    desktop.template = template;
  }
  if (typeof raw.codexAppServer === "boolean") desktop.codexAppServer = raw.codexAppServer;
  if (raw.fidelity !== undefined) {
    if (!isRecord(raw.fidelity) || typeof raw.fidelity.mobileEmulation !== "boolean") {
      return invalid("`execution.desktop.fidelity` must be an object with `mobileEmulation: true|false` (optional deviceScaleFactor, touch, userAgent).");
    }
    const fidelity: LabDesktopFidelity = { mobileEmulation: raw.fidelity.mobileEmulation };
    if (raw.fidelity.deviceScaleFactor !== undefined) {
      const scale = raw.fidelity.deviceScaleFactor;
      if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > 4) {
        return invalid("`execution.desktop.fidelity.deviceScaleFactor` must be a number greater than 0 and at most 4.");
      }
      fidelity.deviceScaleFactor = scale;
    }
    if (raw.fidelity.touch !== undefined) {
      if (typeof raw.fidelity.touch !== "boolean") {
        return invalid("`execution.desktop.fidelity.touch` must be true or false.");
      }
      fidelity.touch = raw.fidelity.touch;
    }
    if (raw.fidelity.userAgent !== undefined) {
      const userAgent = str(raw.fidelity.userAgent);
      if (userAgent === undefined) {
        return invalid("`execution.desktop.fidelity.userAgent` must be a non-empty string when set.");
      }
      fidelity.userAgent = userAgent;
    }
    desktop.fidelity = fidelity;
  }
  if (raw.media !== undefined) {
    if (!isRecord(raw.media)) {
      return invalid("`execution.desktop.media` must be an object with `camera` and/or `microphone` ({ source }).");
    }
    const media: LabDesktopMedia = {};
    if (raw.media.camera !== undefined) {
      const source = isRecord(raw.media.camera) ? str(raw.media.camera.source) : undefined;
      if (source === undefined || (source !== "synthetic" && !source.endsWith(".y4m"))) {
        return invalid("`execution.desktop.media.camera.source` must be `synthetic` or a path to a `.y4m` file (Chrome's fake video capture reads Y4M).");
      }
      media.camera = { source };
    }
    if (raw.media.microphone !== undefined) {
      const source = isRecord(raw.media.microphone) ? str(raw.media.microphone.source) : undefined;
      if (source === undefined) {
        return invalid("`execution.desktop.media.microphone.source` must be a non-empty path when set.");
      }
      if (desktop.template === undefined) {
        return invalid("`execution.desktop.media.microphone` needs `execution.desktop.template`: the stock desktop image has no audio stack, so Chrome enumerates no microphone and the participant would report a limitation of the instrument as a finding (#509).");
      }
      media.microphone = { source };
    }
    if (media.camera === undefined && media.microphone === undefined) {
      return invalid("`execution.desktop.media` declares neither `camera` nor `microphone`.");
    }
    desktop.media = media;
  }
  return { ok: true, value: Object.keys(desktop).length > 0 ? desktop : undefined };
}

function parsePersonas(raw: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const personas = raw.filter(isRecord);
  return personas.length > 0 ? personas : undefined;
}

function parseScenario(raw: unknown): { ok: true; value: LabScenario | undefined } | LabConfigParseFailure {
  if (!isRecord(raw)) {
    return { ok: true, value: undefined };
  }
  const scenario: LabScenario = {};
  const ref = str(raw.ref);
  if (ref) scenario.ref = ref;
  if (isRecord(raw.inline)) scenario.inline = raw.inline;
  const mode = str(raw.mode);
  if (mode === "dry-run" || mode === "live") scenario.mode = mode;
  const capsResult = parseCaps(raw.caps);
  if (!capsResult.ok) {
    return capsResult;
  }
  if (capsResult.value) scenario.caps = capsResult.value;
  return { ok: true, value: Object.keys(scenario).length > 0 ? scenario : undefined };
}

/**
 * Parse `scenario.caps`. Returns a parse failure on a malformed value rather than silently
 * dropping a budget declaration (a cap that silently does nothing would be a safety lie —
 * invariant 6). Each cap must be a non-negative finite number.
 */
function parseCaps(raw: unknown): { ok: true; value: LabScenarioCaps | undefined } | LabConfigParseFailure {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalid("`scenario.caps` must be an object ({ maxUsd?, maxTotalUsd?, maxJobs?, maxMinutes? }).");
  }
  const caps: LabScenarioCaps = {};
  for (const key of ["maxUsd", "maxTotalUsd", "maxJobs", "maxMinutes"] as const) {
    if (raw[key] === undefined) continue;
    const value = nonNegNumber(raw[key]);
    if (value === undefined) {
      return invalid(`\`scenario.caps.${key}\` must be a non-negative number.`);
    }
    caps[key] = value;
  }
  return { ok: true, value: Object.keys(caps).length > 0 ? caps : undefined };
}

function parsePolicies(raw: unknown): LabPolicies | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const policies: LabPolicies = {};
  if (typeof raw.redactRepos === "boolean") policies.redactRepos = raw.redactRepos;
  if (typeof raw.redactScreenshots === "boolean") policies.redactScreenshots = raw.redactScreenshots;
  if (typeof raw.allowPublicTargets === "boolean") policies.allowPublicTargets = raw.allowPublicTargets;
  if (raw.mediaPermission === "prompt" || raw.mediaPermission === "granted") policies.mediaPermission = raw.mediaPermission;
  if (typeof raw.allowPrivateRepoAccess === "boolean") policies.allowPrivateRepoAccess = raw.allowPrivateRepoAccess;
  if (typeof raw.allowProviderCredentials === "boolean") policies.allowProviderCredentials = raw.allowProviderCredentials;
  if (typeof raw.allowPaymentCredentials === "boolean") policies.allowPaymentCredentials = raw.allowPaymentCredentials;
  if (typeof raw.allowGitHubMutation === "boolean") policies.allowGitHubMutation = raw.allowGitHubMutation;
  return Object.keys(policies).length > 0 ? policies : undefined;
}

// Fail-LOUD: an unrecognized `review.*` key (e.g. a `scorrer:` typo of `scorer`) is rejected rather
// than silently dropped — a gate you think you declared must not vanish silently (#316).
function parseReview(raw: unknown): { ok: true; value: LabReview | undefined } | LabConfigParseFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) return invalid("`review` must be a mapping.");
  const knownKeys = new Set(["scoring", "milestones", "vocabulary", "scorer"]);
  const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) {
    return invalid(`Unknown \`review\` field(s): ${unknownKeys.join(", ")}. A declared gate must not vanish silently — did you mean \`scorer\`? Known review fields: scoring, milestones, vocabulary, scorer.`);
  }
  const review: LabReview = {};
  const scoring = str(raw.scoring);
  if (scoring) review.scoring = scoring;
  const milestones = str(raw.milestones);
  if (milestones) review.milestones = milestones;
  const vocabulary = str(raw.vocabulary);
  if (vocabulary) review.vocabulary = vocabulary;
  if (raw.scorer !== undefined) {
    const scorer = parseReviewScorer(raw.scorer);
    if (!scorer.ok) return scorer;
    review.scorer = scorer.value;
  }
  return { ok: true, value: Object.keys(review).length > 0 ? review : undefined };
}

function parseReviewScorer(raw: unknown): { ok: true; value: { ref: string } } | LabConfigParseFailure {
  if (!isRecord(raw)) return invalid("`review.scorer` must be a mapping with a `ref` path (e.g. { ref: scorers/product.mjs }).");
  const unknownKeys = Object.keys(raw).filter((key) => key !== "ref");
  if (unknownKeys.length > 0) {
    return invalid(`Unknown \`review.scorer\` field(s): ${unknownKeys.join(", ")}. review.scorer accepts only \`ref\` (a repo-relative scorer-module path).`);
  }
  const ref = str(raw.ref);
  if (!ref) return invalid("`review.scorer.ref` must be a non-empty repo-relative path to a scorer module (.mjs recommended; .js/.cjs accepted).");
  return { ok: true, value: { ref } };
}

function parseDefaults(raw: unknown): LabDefaults | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const defaults: LabDefaults = {};
  if (typeof raw.open === "boolean") defaults.open = raw.open;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

// Fail-loud (never silently swallow a comms setting): a malformed `comms` block returns a parse
// failure rather than being dropped.
function parseComms(raw: unknown): { ok: true; value: LabComms | undefined } | LabConfigParseFailure {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) return invalid("`comms` must be a mapping.");
  const comms: LabComms = {};
  if (raw.email !== undefined) {
    const email = parseCommsEmail(raw.email);
    if (!email.ok) return email;
    comms.email = email.value;
  }
  return { ok: true, value: Object.keys(comms).length > 0 ? comms : undefined };
}

function parseCommsEmail(raw: unknown): { ok: true; value: LabCommsEmail } | LabConfigParseFailure {
  if (!isRecord(raw)) return invalid("`comms.email` must be a mapping.");
  if (raw.kind === "real") {
    return invalid("`comms.email.kind: real` (provider-backed inboxes) is not yet supported — use `fake`.");
  }
  if (raw.kind !== undefined && raw.kind !== "fake") {
    return invalid("`comms.email.kind` must be `fake`.");
  }
  // external ingress (#328): the ADOPTER runs the catch, so there is no subject env for humanish to
  // inject and `injectEnv` becomes meaningless rather than merely unused — the operator points their
  // own app at their own catch. Parse it first so the injectEnv requirement can key off it.
  let external: LabCommsExternal | undefined;
  if (raw.external !== undefined) {
    if (!isRecord(raw.external)) return invalid("`comms.email.external` must be a mapping.");
    const catchBaseUrl = str(raw.external.catchBaseUrl);
    if (catchBaseUrl === undefined) {
      return invalid("`comms.email.external.catchBaseUrl` is required — the base URL of the catch YOU run (humanish reads its GET /deliveries and your app POSTs its sends to it).");
    }
    for (const [field, value] of [["catchBaseUrl", catchBaseUrl], ["inboxBaseUrl", str(raw.external.inboxBaseUrl)]] as const) {
      if (value === undefined) continue;
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return invalid(`\`comms.email.external.${field}\` must be an absolute http(s) URL (got "${value}").`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return invalid(`\`comms.email.external.${field}\` must be an absolute http(s) URL (got "${value}").`);
      }
    }
    const authTokenEnv = str(raw.external.authTokenEnv);
    if (authTokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authTokenEnv)) {
      return invalid(`\`comms.email.external.authTokenEnv\` must be a valid env var NAME (got "${authTokenEnv}"); the value is read at runtime and never persisted.`);
    }
    const inboxBaseUrl = str(raw.external.inboxBaseUrl);
    external = {
      catchBaseUrl,
      ...(inboxBaseUrl === undefined ? {} : { inboxBaseUrl }),
      ...(authTokenEnv === undefined ? {} : { authTokenEnv })
    };
  }

  // SMTP transport, for apps that send mail through SMTP rather than a provider's HTTP API.
  let smtp: LabCommsSmtp | undefined;
  if (raw.smtp !== undefined) {
    if (!isRecord(raw.smtp)) return invalid("`comms.email.smtp` must be a mapping.");
    const envName = (value: unknown, field: string): string | undefined => {
      const name = str(value);
      if (name === undefined) return undefined;
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `__invalid__${field}`;
    };
    const hostEnv = envName(raw.smtp.hostEnv, "hostEnv");
    const portEnv = envName(raw.smtp.portEnv, "portEnv");
    if (hostEnv === undefined || portEnv === undefined) {
      return invalid("`comms.email.smtp` needs both `hostEnv` and `portEnv` — the subject-env vars your app reads for its SMTP host and port. The harness sets them to its own loopback listener.");
    }
    if (hostEnv.startsWith("__invalid__") || portEnv.startsWith("__invalid__")) {
      return invalid("`comms.email.smtp.hostEnv` and `portEnv` must be valid env var names.");
    }
    let smtpPort = 2525;
    if (raw.smtp.port !== undefined) {
      const parsed = posInt(raw.smtp.port);
      if (parsed === undefined || parsed > 65_535) return invalid("`comms.email.smtp.port` must be a positive integer ≤ 65535.");
      smtpPort = parsed;
    }
    const userEnv = envName(raw.smtp.userEnv, "userEnv");
    const passwordEnv = envName(raw.smtp.passwordEnv, "passwordEnv");
    if (userEnv?.startsWith("__invalid__") || passwordEnv?.startsWith("__invalid__")) {
      return invalid("`comms.email.smtp.userEnv` and `passwordEnv` must be valid env var names.");
    }
    smtp = {
      port: smtpPort,
      hostEnv,
      portEnv,
      ...(userEnv === undefined ? {} : { userEnv }),
      ...(passwordEnv === undefined ? {} : { passwordEnv }),
      ...(str(raw.smtp.user) === undefined ? {} : { user: str(raw.smtp.user) as string }),
      ...(str(raw.smtp.password) === undefined ? {} : { password: str(raw.smtp.password) as string })
    };
  }

  const injectEnv = str(raw.injectEnv);
  if (injectEnv === undefined && external === undefined && smtp === undefined) {
    return invalid("`comms.email` needs a transport: `injectEnv` (the subject-env var set to the catch's HTTP base URL, e.g. RESEND_BASE_URL), or `smtp` (host/port env vars, for an app that sends over SMTP), or `external` on an adopter-hosted plane where you run the catch yourself.");
  }
  if (injectEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(injectEnv)) {
    return invalid(`\`comms.email.injectEnv\` must be a valid env var name (got "${injectEnv}").`);
  }
  const email: LabCommsEmail = {
    kind: "fake",
    ...(injectEnv === undefined ? {} : { injectEnv }),
    ...(smtp === undefined ? {} : { smtp }),
    ...(external === undefined ? {} : { external })
  };
  if (raw.port !== undefined) {
    const port = posInt(raw.port);
    if (port === undefined) return invalid("`comms.email.port` must be a positive integer.");
    // Cap at 65534: the catch reserves port+1 for the read-only inbox listener on the shared-world route.
    if (port > 65_534) return invalid("`comms.email.port` must be ≤ 65534 (the catch reserves port+1 for the inbox listener).");
    email.port = port;
  }
  if (raw.recipients !== undefined) {
    if (!Array.isArray(raw.recipients)) return invalid("`comms.email.recipients` must be a list.");
    const recipients: LabCommsRecipient[] = [];
    for (const entry of raw.recipients) {
      if (!isRecord(entry)) return invalid("each `comms.email.recipients` entry must be a mapping.");
      const lane = str(entry.lane);
      if (lane === undefined) return invalid("each `comms.email.recipients` entry needs a `lane`.");
      const address = str(entry.address);
      recipients.push({ lane, ...(address === undefined ? {} : { address }) });
    }
    email.recipients = recipients;
  }
  if (raw.linkOrigin !== undefined) {
    const linkOrigin = str(raw.linkOrigin);
    if (linkOrigin === undefined) return invalid("`comms.email.linkOrigin` must be a string.");
    try {
      new URL(linkOrigin);
    } catch {
      return invalid(`\`comms.email.linkOrigin\` must be an absolute URL origin (got "${linkOrigin}").`);
    }
    email.linkOrigin = linkOrigin;
  }
  return { ok: true, value: email };
}

function invalid(message: string): LabConfigParseFailure {
  return { ok: false, error: { code: "HUMANISH_LAB_INVALID", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStr(key: string, value: unknown): Record<string, string> {
  const parsed = str(value);
  return parsed === undefined ? {} : { [key]: parsed };
}

function strList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const items = value.split(",").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function posInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
  }
  return undefined;
}

/** A non-negative finite number (0 allowed — caps default to 0 = no-spend). Accepts a numeric
 *  string too, since YAML scalars can arrive as strings. */
function nonNegNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}
