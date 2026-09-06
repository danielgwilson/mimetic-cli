import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

// The deterministic browser-persona driver lives in the scripted-browser-actor leaf module
// (moved there so the actor registry can reuse it without a run.ts import cycle). This file
// keeps the `run --app-url` orchestration; behavior is byte-identical.
import {
  browserSurfaces,
  builtinBrowserPersonaJourney,
  captureBrowserSurface,
  normalizeLocalAppUrl,
  parseBrowserPersonaJourneyFromScenario,
  resolveBrowserCommand,
  type BrowserPersonaJourney,
  type BrowserSurfaceCapture
} from "./scripted-browser-actor.js";
import {
  CODEX_APP_SERVER_TRACE_SCHEMA,
  runCodexAppServerSessionInPreparedRoot,
  type CodexAppServerRunResult,
  type CodexAppServerTrace
} from "./codex-app-server.js";
import { getActor } from "./actor-registry.js";
import { artifactReferenceIfWritten, hasWrittenScreenshot } from "./artifact-reference.js";
import { ACTOR_TRACE_SCHEMA, type ActorStatus, type ActorTrace, type ActorTraceItem } from "./actor-contract.js";
import type { TaskFunnel } from "./tasks.js";
import { captureGitState, GIT_STATE_SCHEMA, type CapturedGitState } from "./core/git-state.js";
import { inspectVerifiedGitWorkspace } from "./core/git-workspace.js";
import { mapWithConcurrency } from "./concurrency.js";
import { screenshotEvidenceError } from "./image-evidence.js";
import { buildObserverData } from "./observer-data.js";
import { parseResolvedPersona, personaToDirectives, renderPersonaPromptSection, type ResolvedPersona } from "./persona.js";
import { round6 } from "./pricing.js";
import { containsSensitive, digestText, redactText, redactToSecretLabel, tailText } from "./redaction.js";
import type { E2BDesktopModule } from "./e2b-desktop-launch.js";
import {
  bindExistingRunArtifactPaths,
  RUNS_RELATIVE_ROOT,
  isSafeRunIdSegment,
  prepareRunArtifactPaths,
  resolveExistingRunDirectory,
  resolveLatestRunDirectory,
  resolveRunsRoot,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths
} from "./run-paths.js";
import { probeKeySources } from "./key-resolution.js";
import { beginRunStatus, withRunStatusScope, type RunLabProvenance, type RunStatusHandle } from "./run-status.js";
import { nodeSupportsTui, terminalSurfaceMessage, tuiBundleUrl } from "./tui-contract.js";
import { detectLocalAgents, localAgentDoctorMessage } from "./local-agent-cli.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  bindExistingManagedHumanishOutputDirectory,
  prepareContainedOutputDirectory,
  prepareContainedOutputDirectoryRoot,
  prepareContainedOutputFile,
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  type PreparedSelectedOutputDirectory,
  writeContainedOutputFile,
  writePreparedRunLatestPointer
} from "./selected-output-paths.js";

export const RUN_BUNDLE_SCHEMA = "humanish.run-bundle.v1";
export const SHARED_WORLD_SCHEMA = "humanish.shared-world.v1";
export const REVIEW_SCHEMA = "humanish.review.v1";
export const VERIFY_SCHEMA = "humanish.verify-result.v1";
export const RUNS_SCHEMA = "humanish.runs-result.v1";
export const DOCTOR_SCHEMA = "humanish.doctor-result.v1";
export const CLEANUP_SCHEMA = "humanish.cleanup-result.v1";
export const PUBLIC_TARGET_CWD = "[target-cwd]";
const SAFE_GIT_NOTES = new Set([
  "Git command could not be started.",
  "Git HEAD capture timed out.",
  "Git HEAD command could not be started.",
  "Git metadata could not be inspected safely.",
  "Git status command could not be captured.",
  "Git status command could not be started.",
  "Git status could not be captured.",
  "Git status capture timed out.",
  "Git metadata failed containment validation.",
  "Git ref-state capture timed out.",
  "Git ref-state command could not be started.",
  "Git work-tree detection timed out.",
  "Git work tree had changes; only counts were captured, not branch names, remotes, paths, or file names.",
  "Git work tree was clean; branch names, remotes, paths, and file names were not captured.",
  "No git work tree was detected.",
  "public-safe synthetic fixture",
  "public-safe synthetic OSS meta-lab fixture"
]);

export interface RunOptions {
  /** Which manifest produced this run (#455). */
  lab?: RunLabProvenance;
  cwd: string;
  actor?: string;
  actorCommand?: string[];
  appUrl?: string;
  dryRun?: boolean;
  runId?: string;
  simCount?: number;
  timeoutMs?: number;
}

export type RunStreamKind = "ui" | "browser" | "terminal" | "tui" | "codex-ui" | "artifact" | "summary";

export type RunSimulationStatus =
  | "queued"
  | "preparing"
  | "running"
  | "passed"
  // Participant outcomes, not harness malfunctions (docs/principles/three-roles.md).
  | "abandoned"
  | "incomplete"
  | "complete"
  | "blocked"
  | "timed_out"
  | "failed"
  | "contract_proof_only";

export interface RunStreamCompletion {
  actorLogPath?: string;
  actorLogTail?: string;
  actorLastMessageTail?: string;
  actorPid?: number;
  actorStatus?: "not_started" | "running" | "passed" | "failed" | "blocked" | "timed_out" | "suspended" | "unknown";
  appLogPath?: string;
  appPid?: number;
  appReason?: string;
  appStatus?: "not_started" | "running" | "blocked" | "failed" | "missing" | "unknown";
  appUrl?: string;
  checkedAt: string;
  exitCode?: number;
  logTail?: string;
  nestedObserverPresent?: boolean;
  nestedVerifyPassed?: boolean;
  reason: string;
  status: "running" | "passed" | "failed" | "blocked" | "timed_out";
  visualReason?: string;
  visualStatus?: "not_started" | "visible" | "blocked" | "unknown";
  visualWindowCount?: number;
  meaningfulUse?: RunMeaningfulUseScore;
}

export interface RunSetupQualitySnapshot {
  schema: "humanish.setup-quality.v1";
  generatedAt: string;
  redaction: {
    status: "passed";
    rawPreviews: "included" | "suppressed";
    notes: string;
  };
  summary: string;
  status: "passed" | "needs_review" | "blocked";
  checks: Array<{
    id: string;
    label: string;
    ok: boolean;
    detail: string;
  }>;
  tree: Array<{
    path: string;
    type: "file" | "directory";
    sizeBytes?: number;
  }>;
  previews: Array<{
    path: string;
    language: "json" | "yaml" | "typescript" | "markdown" | "text";
    truncated: boolean;
    text: string;
  }>;
  studyQuality?: {
    schema: "humanish.study-quality.v1";
    rating: "none" | "ceremonial" | "useful" | "high_leverage";
    summary: string;
    checks: Array<{
      id: string;
      label: string;
      ok: boolean;
      detail: string;
    }>;
    signals: {
      appUrlProofBlocked: boolean;
      appUrlProofMentioned: boolean;
      actorInsightCaptured: boolean;
      coverageCustomized: boolean;
      personaCustomized: boolean;
      scenarioCustomized: boolean;
    };
  };
  packageScripts: Record<string, string>;
  humanish: {
    configPresent: boolean;
    personaCount: number;
    scenarioCount: number;
    packageScriptPresent: boolean;
    gitignoreContainsRuntimeIgnore: boolean;
  };
}

/**
 * The CLOSED set of core meaningful-use scoring components. Closed by design: these are the generic
 * dimensions core itself meters (setup/filesystem/nested/actor/product/feedback). A product-specific
 * scorecard does NOT extend this enum (that would be closed-taxonomy rot — every adopter's nouns
 * leaking into core); it ships as a thin in-repo extension that emits a namespaced `RunAdapterScore`
 * via the lane's `score` hook, leaving its own component breakdown in that score's `data`. Exported
 * so a thin adapter can type against core's score shape without forking.
 */
export type RunMeaningfulUseComponentId =
  | "setup-correctness"
  | "filesystem-evidence"
  | "nested-humanish-evidence"
  | "actor-activity"
  | "product-surface"
  | "feedback-quality";

export interface RunMeaningfulUseScore {
  schema: "humanish.meaningful-use-score.v1";
  status: "pass" | "partial" | "fail";
  score: number;
  summary: string;
  hardFailures: string[];
  components: Array<{
    id: RunMeaningfulUseComponentId;
    label: string;
    status: "pass" | "partial" | "fail";
    score: number;
    detail: string;
  }>;
}

/**
 * A namespaced, product-agnostic score a thin adapter attaches to the bundle via the terminal-product
 * lane's `score` hook (the layer-6 extension seam, issue #154 acceptance #8). Core never reads its
 * `data` and knows none of the adopter's nouns — the `namespace` (e.g. `"acme-pixelforge"`) scopes
 * the whole record so core schemas stay product-agnostic and a future inert-field audit does not
 * misfire on a noun core never owned. The adopter's real scorecard (component weights, product
 * rubric) lives in ITS repo and is summarized into the generic status/score/summary; everything
 * product-specific rides under `data`. This is NOT a built-in product scorer — it is the SEAM the
 * adopter's scorer plugs into without forking core.
 */
export interface RunAdapterScore {
  schema: "humanish.adapter-score.v1";
  /** The adapter's namespace — non-core, product-scoped (e.g. an adopter slug). Required + non-empty. */
  namespace: string;
  status: "pass" | "partial" | "fail";
  /** A 0-100 summary the adapter derived from its own (off-core) rubric. */
  score: number;
  summary: string;
  /** Arbitrary product-specific payload (the adopter's component breakdown / nouns). Core never reads it. */
  data?: Record<string, unknown>;
}

export interface RunFeedbackCandidate {
  schema: "humanish.feedback-candidate.v1";
  id: string;
  run_id: string;
  stream_id?: string;
  adapter_id: string;
  scenario_id: string;
  persona_id: string;
  actor: "codex-tui" | "codex-exec" | "codex-app-server" | "computer-use" | "synthetic-dry-run" | "unknown";
  // `e2b-terminal`: the in-sandbox command-scoped terminal-agent substrate (issue #154 / SLICE 4).
  substrate: "e2b-desktop" | "e2b-terminal" | "local-filesystem" | "codex-app-server" | "unknown";
  failure_owner: "harness" | "target-app" | "actor" | "environment" | "unknown";
  summary: string;
  expected: string;
  actual: string;
  evidence: Array<{
    path: string;
    kind: "review" | "state" | "log" | "trace" | "screenshot" | "filesystem";
    note: string;
  }>;
  redaction: {
    status: "passed";
    notes: string;
  };
  idempotency_key: string;
  proposed_next_state: "watch" | "adapter-hardening" | "target-app-setup" | "actor-auth" | "setup-quality-review" | "study-quality-review";
  acceptance_proof: string[];
  /**
   * OPTIONAL, ADAPTER-NAMESPACED product-noun block (the layer-6 extension seam, issue #154
   * acceptance #8 + the "record product-specific concepts as NON-core nouns" list). A thin adapter
   * records product-specific concepts — public CLI/product command observed, hosted product
   * success-or-blocker, feedback id/draft observed, media/job/asset ids, explicit
   * no-media/no-provider-spend proof, defection/friction risk — WITHOUT making any of them core
   * primitives. They ride under a single namespaced field so core's feedback enums
   * (`evidence.kind`, `proposed_next_state`) stay product-agnostic and a future inert-field audit
   * never misfires on a noun core never owned. Core validates only the SHAPE (a non-empty
   * `namespace` + a `data` record); the keys inside `data` are the adapter's, never core's.
   */
  adapter?: {
    /** Non-core, product-scoped namespace (e.g. an adopter slug). Required + non-empty. */
    namespace: string;
    /** The adapter's product nouns. Core never reads these keys — it stays product-agnostic. */
    data: Record<string, unknown>;
  };
}

/**
 * Optional, adapter-namespaced artifact references. These let a thin in-repo
 * adapter attach product/state proof outputs to the Humanish evidence packet
 * without teaching core product nouns or inventing fake streams.
 */
export interface RunAdapterArtifact {
  schema: "humanish.adapter-artifact.v1";
  namespace: string;
  label: string;
  path: string;
  kind: "state" | "review" | "log" | "trace" | "screenshot" | "filesystem" | "summary";
  note: string;
}

/**
 * Provenance for a CONFIG-DECLARED adopter scorer (#316): the repo-relative entry path and a digest
 * of its ENTRY-MODULE bytes, recorded so a `review.scorer.ref`/`--scorer` run honestly states which
 * out-of-tree judgment it attached. Core-computed (path + digest), never adopter-supplied. A LIBRARY
 * caller (hooks passed directly through RunLabOptions) has implicit provenance — their code IS their
 * provenance — so this block is ABSENT there and every pre-#316 bundle stays byte-stable + verifiable.
 *
 * The digest pins the entry file's IDENTITY, not its behavioral closure: a `export { score } from
 * "../outside.mjs"` re-export is not captured, and `import()` re-opens the path (a benign same-author
 * TOCTOU). Treat it as evidence-not-gate, and do NOT extend the loader to less-trusted config.
 */
export interface RunScorerProvenance {
  schema: "humanish.scorer-provenance.v1";
  /** Repo-relative entry path (e.g. "scorers/example.mjs"), clamped inside the target cwd. */
  ref: string;
  /** digestText over the readContainedRegularFile ENTRY bytes — the entry module only, not a lockfile of the executed graph. */
  digest: string;
  /** Which door declared it: the committed manifest, or the CLI `--scorer` override. */
  source: "manifest" | "cli-flag";
  /** The whitelisted hooks actually wired from the module (costProbe is intentionally never loadable). */
  exports: ("score" | "deriveFeedback" | "deriveArtifacts")[];
}

export interface RunSimulation {
  id: string;
  index: number;
  personaId: string;
  scenarioId: string;
  status: RunSimulationStatus;
  streamKind: RunStreamKind;
  mode: "browser-sim" | "cli-sim" | "tui-sim" | "codex-app-sim";
  progress: number;
  currentStep: string;
  summary: string;
  streamIds: string[];
  startedAt: string;
  updatedAt: string;
}

export interface RunDesktopGeometry {
  /** E2B/X display geometry. Requested config and verified runtime evidence stay distinct. */
  screen: {
    requested: { width: number; height: number };
    verified?: { width: number; height: number; source: "xdpyinfo" };
    /**
     * The device preset as DECLARED by the lab, present only when it differs from `requested`
     * because the rendered width was floored to MIN_DESKTOP_RENDER_WIDTH.
     *
     * Without this, a floored run is indistinguishable from a faithful one: `verified` compares
     * the floored number with itself and reports a match, so a reader of the bundle sees
     * requested 500 / verified 500 and reasonably concludes a 500-wide preset was asked for. A
     * `mobile` (414) and a `small-mobile` (360) seat both render at 500 and look identical here.
     * When this field is set, the preset width did NOT render; see #221.
     */
    declared?: { width: number; height: number; preset: string };
  };
  /** Measured browser bounds after the fill attempt. X client bounds take precedence for
   * physical visibility; CDP page-reported outer bounds can reflect mobile emulation. */
  browserWindow?: {
    x: number;
    y: number;
    width: number;
    height: number;
    source: "cdp" | "xdotool";
  };
  /** Browser CSS layout viewport measured from the running page, never copied from config. */
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    source: "cdp";
  };
  /**
   * Mobile fidelity beyond viewport size (#221), present only when the lab asked for it. `requested`
   * is what was applied through CDP; `resolved` is what the page reported about itself afterwards
   * and is the proof, never copied from the request. A run without this block is a
   * responsive-viewport study, whatever its preset is named.
   */
  fidelity?: {
    tier: "mobile-emulated";
    requested: { width: number; height: number; deviceScaleFactor: number; touch: boolean; userAgent: string };
    applied: string[];
    resolved?: {
      userAgent: string;
      devicePixelRatio: number;
      innerWidth: number;
      innerHeight: number;
      maxTouchPoints: number;
      coarsePointer: boolean;
      source: "cdp";
    };
    /**
     * Page targets the participant drove AFTER the launch page (a link that opened in a new tab)
     * whose own read-back reported the requested viewport width (#623). Absent when the
     * participant never left the launch tab; a later tab that did NOT report the width is a lane
     * warning instead.
     */
    laterTargets?: { targetId: string; innerWidth: number; devicePixelRatio: number; maxTouchPoints: number }[];
    /**
     * The emulation holder's log after its announce, one JSON line per later target it attached
     * to (`attached`, `sent`) and per reply that came back as an error (`replyError`), at most 50
     * lines. Absent when no later target appeared.
     */
    holderLog?: string[];
  };
  /** Public-safe geometry measurement/fill warnings retained with the stream evidence. */
  warnings?: string[];
}

export interface RunStream {
  id: string;
  simId: string;
  /** Adapter-owned lane id for fan-out / target-swarm runs. Safe categorical metadata only. */
  laneId?: string;
  /** Adapter-owned actor class for grouping lanes, e.g. viewer/reviewer/admin. */
  actorType?: string;
  /** Adapter-owned product surface label for grouping lanes without parsing URLs. */
  surface?: string;
  /** Adapter-owned scenario/case grouping label. */
  caseGroup?: string;
  kind: RunStreamKind;
  label: string;
  status: RunSimulationStatus;
  transport: "snapshot" | "polling" | "sse" | "pty" | "app-server";
  updatedAt: string;
  url?: string;
  embed?: {
    kind: "iframe" | "terminal" | "screenshot" | "placeholder";
    url?: string;
    title?: string;
  };
  /** Set by the attached watch server when the lane's sandbox is gone (#357): the injected
   *  live URL would render a provider error page, so viewers fall back to recorded evidence.
   *  Runtime-only — never persisted into bundles; declared here because the served
   *  observer-data carries it and the client is typed against this contract. */
  liveEnded?: boolean;
  /**
   * Browser CSS layout viewport. Deterministic browser adapters may declare and render this
   * exactly; hosted-desktop CUA producers set it only from a runtime measurement. Historical
   * hosted CUA bundles may contain the requested screen size here instead.
   */
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
  };
  /** Truthful screen/window/viewport evidence for hosted desktop browser lanes. */
  desktopGeometry?: RunDesktopGeometry;
  terminal?: {
    title: string;
    format: "ansi" | "plain";
    stdin: "disabled" | "planned" | "sent";
    tail: string;
  };
  ui?: {
    actorStatus?: string;
    appStatus?: string;
    appUrl?: string;
    route?: string;
    intent?: string;
    nestedObserverPath?: string;
    nestedObserverUrl?: string;
    screenshotUrl?: string;
    state?: string;
    visualStatus?: string;
  };
  codex?: {
    provider: "codex-app-server";
    eventCount?: number;
    experimentalApi?: boolean;
    model?: string;
    sessionId?: string;
    state: "not_connected" | "connecting" | "watching" | "running" | "completed" | "failed" | "blocked" | "timed_out";
    contract: string;
    threadId?: string;
    trace?: CodexAppServerTrace;
    tracePath?: string;
    turnId?: string;
  };
  // Provider-neutral projection of the actor's evidence (humanish.actor-trace.v1).
  // Populated alongside the raw `codex` evidence; carries persona.traitsApplied.
  actor?: ActorTrace;
  /**
   * Mid-run partial actor evidence (#441): the redacted trace items recorded SO FAR,
   * flushed while a live lane is still running so the attached Observer's timeline can
   * grow. Deliberately NOT an ActorTrace — a running lane has no honest status,
   * completionReason, or completedAt, and this shape cannot claim them. Present ONLY on
   * `inProgress` bundles; the final write replaces it with the real `actor` and never
   * carries it.
   */
  liveActor?: {
    schema: "humanish.live-actor.v1";
    /** When this flush was written (ISO-8601). */
    updatedAt: string;
    items: ActorTraceItem[];
  };
  completion?: RunStreamCompletion;
  artifacts: Array<{
    label: string;
    path: string;
    kind: "bundle" | "review" | "observer" | "events" | "screenshot" | "trace" | "log" | "filesystem";
  }>;
}

export interface RunEvent {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  type: string;
  message: string;
  simId?: string;
  streamId?: string;
}

/**
 * One executed (or declared) subject-state seed step. Live records carry execution fields
 * (ok/exitCode/timedOut/durationMs); dry-run "declared, not run" records carry only the
 * declaration (name, phase, command DIGEST). The command itself never persists — the digest
 * pins "same recipe" across bundles while the lab YAML in the consumer's repo stays the
 * plaintext source of truth (publish-safe by construction).
 */
export interface RunSubjectStateStepRecord {
  name: string;
  when: "before-build" | "before-start" | "after-ready";
  /** sha256 hex of the exact command string, first 16 chars (the promptDigest convention). */
  commandDigest: string;
  /** Absent on declared-not-run records (dry-run; unreached steps are absent entirely). */
  ok?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
}

/**
 * Structured subject provenance (invariant 5): what the subject WAS — code pin (repo/commit,
 * or a local-tree archive digest) AND state story. Optional additive field on
 * humanish.run-bundle.v1; absent on bundles from backends that have not adopted it (and on all
 * pre-existing bundles).
 */
export interface RunSubjectProvenance {
  source: "clone" | "app-url" | "local-tree";
  /** Clone-route only. Honors policies.redactRepos exactly as the provenance event does. */
  repo?: string;
  /** Clone-route: the cloned commit SHA. Local-tree route: the host-side HEAD at pack time,
   *  when the packed root was a git work tree. */
  commit?: string;
  /**
   * Local-tree-route only (additive): 64 lowercase-hex sha256 over the sorted packed-entries
   * list (docs/contracts/schemas.md). This is the provenance PIN for the local-tree route: a
   * dirty working tree cannot be commit-pinned, so the archive content digest stands in for it.
   */
  archiveSha256?: string;
  /**
   * Local-tree-route only (additive): true when the host git work tree had uncommitted changes
   * at pack time. Absent when the packed root was not a git work tree at all.
   */
  dirty?: boolean;
  /** Declared env NAMES provisioned for the subject — names only, values never. */
  envNames?: string[];
  state: {
    /**
     * seeded: live run, steps declared, ALL ran ok, no external state declared.
     * unpinned: external state declared (seed records, if any, still attached — migrating
     *   an external DB is still unpinned overall).
     * declared-not-run: steps declared but not (all) executed ok — dry-run contract bundles
     *   and failed live provisioning.
     * undeclared: no subject.state block (stateless apps, app-url subjects) — the explicit
     *   "absence declared" marker invariant 5 requires.
     * external-public: (#164 phase 2) an operator-DECLARED, operator-OWNED public deployment used
     *   directly as the shared plane — humanish neither provisioned nor seeded it (no getHost, no
     *   clone, no in-sandbox filesystem). NOT "seeded" (nothing was seeded), NOT "unpinned" (this is
     *   an owned target, not an uncontrolled external DB). The honest marker for the external-public
     *   plane class; verify asserts it in place of the getHost seeded gate.
     */
    provenance: "seeded" | "unpinned" | "declared-not-run" | "undeclared" | "external-public";
    seed?: RunSubjectStateStepRecord[];
    externalEnvNames?: string[];
  };
}

/**
 * How well a run attributed INTERACTION between actors — a new, ORTHOGONAL honesty axis to the
 * persona-sampling evidence classes (which answer "how representative is the actor?"). Absent ==
 * `isolated` (every existing bundle byte-stable). `shared-world` means N roles drove ONE mutable
 * plane and their per-role attribution is weaker (its ceiling is pinned in `sharedWorld.attributionLimits`).
 */
export type RunAttributionClass = "isolated" | "shared-world";

/** The ONE shared service-plane provenance for a shared-world run (#164): single commit + a
 *  seed-recipe digest + the provisioned env NAMES (values never). */
export interface SharedWorldPlane {
  /** The cloned commit SHA of the shared plane (when the clone resolved one). */
  commit?: string;
  /** sha256-16 over the ordered seed-step command digests — the seeded-state RECIPE identity
   *  (not the runtime state). Pins "same seed recipe" across bundles. */
  seedDigest: string;
  /** Declared env NAMES provisioned for the shared plane (values never surface). */
  envNames: string[];
  /**
   * CONCURRENT route only (#164 phase 2): sha256-16 of the harness-minted `getHost` URL's ORIGIN
   * (the first-class provisioned-subject target every actor drove — invariant 2). A DIGEST, not the
   * raw URL: a getHost URL embeds the (live) sandbox id and matches the publish-safety e2b-URL
   * redaction, so — like the stream URL and like sandbox ids — it never lands raw in a published
   * bundle (the raw tokenless URL is surfaced only on the ephemeral lab result). The orchestrator
   * confirms the URL is TOKENLESS (no authKey — invariant 1) before digesting. verify proves every
   * actor drove this host by digest equality. Absent on the sequential route.
   */
  hostDigest?: string;
  /**
   * CONCURRENT route only: the author's REQUIRED attestation that the subject behind the
   * internet-reachable getHost URL is synthetic seeded data (FIX-3). This is author-trust + a
   * provenance gate, NOT a no-real-data guarantee. Verify fails closed if absent on the concurrent route.
   *
   * FORBIDDEN on the external-public plane class: claiming synthetic on a real public site the
   * harness neither provisioned nor exposed would be a lie (verify asserts it ABSENT there).
   */
  exposure?: "synthetic";
  /**
   * EXTERNAL-PUBLIC plane class only (#164 phase 2): sha256-16 of the OBSERVED origin the seats
   * CONVERGED on (the honest analog of hostDigest, but WEAKER and disclosed — the harness only
   * OBSERVES that each seat reached this origin; it never MINTED it). It is derived from what the
   * seats actually reached, NOT from the declared appUrl: verify proves every laneWindow.routeHostDigest
   * (that seat's CDP-observed final URL origin) equals it — inter-seat convergence on ONE OBSERVED
   * origin, not harness control of the plane. A digest, not the raw origin (kept consistent with
   * hostDigest hygiene). Absent on getHost.
   */
  publicOriginDigest?: string;
  /**
   * EXTERNAL-PUBLIC plane class only: sha256-16 of the operator-DECLARED origin (from subject.appUrl),
   * recorded for reference/evidence ONLY. It is NEVER asserted equal to publicOriginDigest: a normal
   * cross-origin redirect (apex->www, http->https) makes the OBSERVED origin differ from the declared
   * one, which is expected. Operator OWNERSHIP rests on the subject.publicTarget.authorized attestation
   * + the declared appUrl, NOT on digest equality. A digest, not the raw origin. Absent on getHost.
   */
  declaredOriginDigest?: string;
}

/**
 * CONCURRENT shape (#164 phase 2): one actor's harness-clocked activity window against the ONE
 * shared plane. OVERLAPPING windows mechanically prove ≥2 personas were active simultaneously.
 * `laneWindows` and `stateSeries` are INDEPENDENT series — there is deliberately NO per-delta→actor
 * field (causation under concurrency is structurally inexpressible — FIX-7).
 */
export interface SharedWorldLaneWindow {
  roleId: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  /** Resolves to a real RunSimulation in this bundle. */
  simId: string;
  /** Resolves to a real RunStream (the actor's trace) in this bundle. */
  streamId: string;
  /** ms on the ONE harness clock — the wrapped [start,end] the orchestrator MEASURED (FIX-1). */
  startedAt: number;
  endedAt: number;
  /** The actor's terminal session verdict (per-persona). */
  verdict: string;
  /** sha256-16 of the ORIGIN of the getHost seat URL this actor drove. verify confirms it equals
   *  plane.hostDigest — i.e. the actor drove EXACTLY the harness-minted host (invariant 2; FIX-2).
   *  A digest, not the raw URL (a getHost URL is not publish-safe — see SharedWorldPlane.hostDigest). */
  routeHostDigest: string;
  /** The shared plane's commit this actor observed (omitted when unresolved). */
  commit?: string;
  /** The shared plane's seed-recipe digest this actor observed. */
  seedDigest: string;
}

/** CONCURRENT shape: one cadence checkpoint of the shared world under load. DIGEST-ONLY — the
 *  allowed-keys tripwire (SHARED_WORLD_STATESERIES_KEYS) permits ONLY {timestamp, digest}. */
export interface SharedWorldStateSnapshot {
  /** ms on the ONE harness clock. */
  timestamp: number;
  /** sha256-16 of the (scrubbed, redacted) combined probe output at this snapshot. */
  digest: string;
}

/** CONCURRENT shape: one persona's OUTCOME against the contended world (the "M of N" headline). */
export interface SharedWorldOutcome {
  roleId: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  simId: string;
  streamId: string;
  /** Terminal session status. */
  status: string;
  completionReason?: string;
  /** Reached its goal (terminal, engaged, no harness error). */
  ok: boolean;
}

/** A timeline checkpoint: a read-only digest probe of the shared plane at one moment. Persisted
 *  DIGEST-ONLY — `digest` is sha256-16(scrub+redact(stdout)); no raw value ever lands. */
export interface SharedWorldCheckpoint {
  kind: "checkpoint";
  /** "cp-baseline" for the baseline snapshot; "cp-after-<roleId>" after each role's turn. */
  name: string;
  /** sha256-16 of the (scrubbed, redacted) combined probe output at this snapshot. */
  digest: string;
  /** True when this snapshot's digest differs from the previous checkpoint's — the observed
   *  state changed across the intervening turn (delta attributed to the TURN, not an action). */
  deltaFromPrev: boolean;
}

/** A timeline turn: one role's seat session against the shared plane. Carries the plane
 *  provenance it observed (identical across turns by construction — the single-plane proof). */
export interface SharedWorldTurn {
  kind: "turn";
  roleId: string;
  /** Resolves to a real RunSimulation in this bundle. */
  simId: string;
  /** Resolves to a real RunStream (the role's actor trace) in this bundle. */
  streamId: string;
  /** The shared plane's commit the role observed (omitted when unresolved). */
  commit?: string;
  /** The shared plane's seed-recipe digest the role observed. */
  seedDigest: string;
}

export type SharedWorldTimelineEntry = SharedWorldCheckpoint | SharedWorldTurn;

/**
 * The shared-world evidence block (`humanish.shared-world.v1`). TWO variants discriminated by
 * `topologyMode` (FIX-8 — renamed off `RunBundle.mode` to avoid the dry-run|live collision):
 *
 * - SEQUENTIAL (`topologyMode: "sequential"`, the PoC): `sequence` + an alternating `timeline`
 *   (cp-baseline → turn → cp → … → cp); limits `sequential-only` etc.
 * - CONCURRENT (`topologyMode: "concurrent"`, #164 phase 2): `laneWindows` + `stateSeries` +
 *   `outcomes`; limits `concurrent` etc. NO `timeline`.
 *
 * Additive + optional on `humanish.run-bundle.v1` — absent on every non-shared-world bundle.
 * The mandatory `attributionLimits` are verify-enforced (FAIL CLOSED on a missing required or a
 * present forbidden limit).
 */
export interface SharedWorldEvidence {
  schema: typeof SHARED_WORLD_SCHEMA;
  topology: "shared-world";
  /** The substrate discriminator (FIX-8). Branched on FIRST by validateSharedWorldEvidence. */
  topologyMode: "sequential" | "concurrent";
  /**
   * CONCURRENT route only (#164 phase 2): the PLANE-class discriminator. Absent == the historical
   * "provisioned-getHost" plane (a clone/local-tree subject served + getHost-exposed in-sandbox — the
   * harness MINTED the host; synthetic-seeded attestation + authoritative in-sandbox checkpoint
   * stateSeries). "external-public" == a real operator-owned public deployment used directly as the
   * plane (NO getHost/clone/seed; operator-attested, not harness-controlled; NO authoritative
   * shared-state proof — concurrency evidenced by temporal co-occupancy + observed lobby convergence).
   * verify gates EVERY getHost-specific assertion on this discriminator; existing bundles omit it and
   * default to provisioned-getHost, byte-stable.
   */
  planeClass?: "provisioned-getHost" | "external-public";
  /** The DECLARED number of role seats. */
  roleCount: number;
  plane: SharedWorldPlane;
  /** The pinned, verify-enforced attribution ceiling (the set differs per topologyMode/planeClass). */
  attributionLimits: string[];
  /**
   * EXTERNAL-PUBLIC plane class only (#164 phase 2, optional-but-strong): sha256-16 of the shared
   * `/lobby/CODE` PATH every seat's CDP-observed URL converged on — the concrete "they were in ONE
   * shared world" proof, observation-derived and needing no subject change. Digest-only (the raw
   * 6-char CODE and full URLs are runtime-only and never land). Absent when seats did not converge.
   */
  lobbyConvergenceDigest?: string;
  // --- SEQUENTIAL shape ---
  /** The role ids that actually took a turn, in declared order. */
  sequence?: string[];
  timeline?: SharedWorldTimelineEntry[];
  // --- CONCURRENT shape ---
  /** Per-actor harness-clocked windows (overlap proves simultaneity). */
  laneWindows?: SharedWorldLaneWindow[];
  /** Cadence digests of the shared world under load (baseline + periodic + final). */
  stateSeries?: SharedWorldStateSnapshot[];
  /** Per-persona outcomes (the "M of N succeeded" headline). */
  outcomes?: SharedWorldOutcome[];
}

export interface RunBundle {
  schema: typeof RUN_BUNDLE_SCHEMA;
  runId: string;
  mode: "dry-run" | "live";
  simCount: number;
  createdAt: string;
  cwd: string;
  artifactRoot: string;
  source: {
    packageName: string | null;
    humanishSource: "present" | "missing";
    git: CapturedGitState;
  };
  persona: {
    id: string;
    name: string;
    source: string;
    sourceDigest: string;
  };
  scenario: {
    id: string;
    title: string;
    goal: string;
    source: string;
    sourceDigest: string;
  };
  lifecycle: Array<{
    at: string;
    event: string;
    message: string;
  }>;
  simulations: RunSimulation[];
  streams: RunStream[];
  events: RunEvent[];
  redaction: {
    status: "passed";
    notes: string;
  };
  artifacts: {
    run: string;
    reviewJson: string;
    reviewMarkdown: string;
    observerData: string;
    events: string;
  };
  review: ReviewSummary;
  feedbackCandidates: RunFeedbackCandidate[];
  /** Structured subject provenance (invariant 5). Optional and additive: emitted by the
   * computer-use backend; tolerated absent everywhere else. */
  subject?: RunSubjectProvenance;
  /**
   * The custom E2B desktop TEMPLATE (image) the run's sandbox(es) actually launched on, from
   * `execution.desktop.template` — so the evidence shows WHICH image ran (a subject needing
   * runtimes the stock `desktop` image lacks runs on an adopter's template). Optional + additive:
   * present only when a template was configured (absent == the stock `desktop` template, every
   * pre-existing bundle byte-stable). A template name is public-safe (not a secret).
   */
  desktopTemplate?: string;
  /**
   * Browser family requested for hosted desktop actor lanes and the in-sandbox command that opened
   * it, when explicitly configured. Optional + additive; absent means the historical default opener
   * path was used or the backend does not create a headed desktop.
   */
  desktopBrowser?: {
    requested: "default" | "chrome" | "chromium" | "firefox";
    resolved?: string;
    /**
     * Synthetic media devices the browser was launched with (#509): the camera feed's origin and
     * in-sandbox path, how the permission dialog is answered, and the exact flags.
     */
    media?: {
      camera?: { source: "synthetic" | "file"; file: string };
      permission: "prompt" | "granted";
      flags: string[];
    };
  };
  /**
   * Optional lineage for a run that intentionally re-executes selected lanes from a prior
   * multi-lane run. This keeps retry-like workflows explicit: the new run is linked to the old
   * evidence, but it never mutates or silently "fixes" the original verdict.
   */
  rerun?: RunRerunLineage;
  /**
   * The interaction-attribution honesty axis (#164). Absent == `isolated` (every existing bundle
   * byte-stable). Set to `shared-world` by the shared-world backend, paired with `sharedWorld`.
   */
  attributionClass?: RunAttributionClass;
  /**
   * Shared-world evidence block (`humanish.shared-world.v1`). Optional + additive; present only on
   * shared-world runs. Verified fail-closed by validateSharedWorldEvidence.
   */
  sharedWorld?: SharedWorldEvidence;
  /**
   * OPTIONAL, ADAPTER-NAMESPACED product score (the layer-6 extension seam, issue #154 acceptance
   * #8). A thin adapter's `score` hook returns a `RunAdapterScore`; the lane attaches it here
   * WITHOUT core knowing any product noun (the score is namespaced + its breakdown lives in `data`).
   * The default mission-based verdict (`review`) is unchanged when no scorer hook is given.
   */
  adapterScore?: RunAdapterScore;
  /**
   * OPTIONAL provenance for a CONFIG-DECLARED scorer (#316). Present only when the scorer was loaded
   * from `review.scorer.ref` / `--scorer`; absent for library callers and every pre-#316 bundle
   * (tolerated-absent in isRunBundle so those still verify). Evidence, not a gate.
   */
  scorerProvenance?: RunScorerProvenance;
  /**
   * OPTIONAL, ADAPTER-NAMESPACED product/state proof artifacts. Core validates
   * shape and local relative artifact references, then verifies the referenced
   * files exist. The adapter owns the payload schema under `namespace`.
   */
  adapterArtifacts?: RunAdapterArtifact[];
  /**
   * Evidence about mutable provider resources observed during this run. Stored ids
   * are not cleanup authority: automatic provider mutation requires a verified
   * resource lease. Optional + additive; core never enumerates provider accounts.
   */
  providerResources?: RunProviderResource[];
  /**
   * Which lab manifest produced this run (#455). Optional + additive: absent on every bundle
   * written before this contract and on library callers who pass a LabConfig directly (the run is
   * then honestly lab-less rather than guessed). For older bundles a reader may fall back to
   * `inferLegacyLabId`, which reads only the historical `persona.source = "lab:<id>"` convention.
   */
  lab?: RunLabProvenance;
  /**
   * OPTIONAL, ADDITIVE run-level cost ESTIMATE (humanish.run-cost-summary.v1): the sum of every
   * lane's model-token estimate PLUS the E2B desktop-minute estimate, carrying the SAME
   * null-discipline the terminal cost ledger already ships. Absent on every pre-existing bundle
   * and on dry-runs that invent no spend (byte-stable). Every dollar figure here is an ESTIMATE,
   * never an authoritative charge; verify asserts its LABELING/provenance, never its magnitude.
   */
  cost?: RunCostSummary;
}

/**
 * One contributing cost line of a RunCostSummary. A line is PRESENT even when it cannot be priced
 * (records that we TRIED and could not) — an unpriceable line carries estimatedCostUsd: null + a
 * `reason` and contributes NOTHING to the summary total (invariant 5). `estimatedCostUsd` is NEVER
 * coerced to 0.
 */
export interface RunCostLine {
  kind: "model-tokens" | "desktop-minutes";
  laneId?: string;
  modelId?: string;
  /** null = NOT MEASURED / no rate; never coerced to 0. */
  estimatedCostUsd: number | null;
  reason?: "no_rate_for_model" | "no_rate_for_desktop" | "no_token_usage" | "no_duration" | "closing_usage_unreported" | "no_desktop_resources" | "desktop_lifetime_incomplete";
  /** Pricing provenance date; non-null iff estimatedCostUsd is non-null. */
  ratesAsOf: string | null;
  source?: string;
  placeholder?: boolean;
  /** Optional allocation evidence on newer desktop lines; older aggregate lines remain valid. */
  desktop?: {
    minutes: number | null;
    durationBasis: "host-acquired-to-cleanup";
    resources?: { cpuCount: number; memoryMiB: number };
    resourceSource?: "e2b.getInfo";
    resourceUnavailableReason?: "metadata_unavailable" | "metadata_invalid" | "metadata_timeout";
    usdPerSecond?: number;
  };
}

/**
 * The run-level cost ESTIMATE. `estimatedTotalUsd` is the rounded sum of ONLY the non-null
 * `breakdown` lines; it is null iff EVERY line is null (never 0-coerced). `fullyEstimated` is
 * false when any applicable line is null (the total is then a LOWER BOUND). Every non-null dollar
 * figure carries `ratesAsOf`; `placeholder` is true when any contributing rate is a stand-in.
 */
export interface RunCostSummary {
  schema: "humanish.run-cost-summary.v1";
  currency: "usd";
  /** Sum of the KNOWN (non-null) lines; null iff every applicable line is null. */
  estimatedTotalUsd: number | null;
  /** Oldest asOf across contributing rates; null when nothing was priced. */
  ratesAsOf: string | null;
  /** false when any applicable line is null (the total is a lower bound). */
  fullyEstimated: boolean;
  /** true when any contributing rate is a placeholder (a stand-in, not a live sheet). */
  placeholder: boolean;
  breakdown: RunCostLine[];
  tokenUsage: { input: number; output: number; total: number };
  /** Host-side create->teardown span in minutes; null when no sandbox was created. */
  desktopMinutes: number | null;
  /** Honest "estimated; <x> unmeasured" statement. */
  note: string;
}

export interface RunProviderResource {
  schema: "humanish.provider-resource.v1";
  provider: "e2b-desktop";
  kind: "sandbox";
  id: string;
  owner: "humanish";
  status: "running" | "killed" | "unknown";
  simId?: string;
  streamId?: string;
  laneId?: string;
  createdAt?: string;
  cleanup?: {
    killed: boolean;
    reason: string;
  };
}

export interface RunRerunLineage {
  sourceRunId: string;
  selectedLaneIds: string[];
  previous: Array<{
    laneId: string;
    streamId?: string;
    status: string;
    reason?: string;
    actorStatus?: string;
    completionReason?: string;
  }>;
}

/**
 * What happened to the PARTICIPANTS in a study, with the denominator attached.
 *
 * A stakeholder watching through the glass forms conclusions from vivid moments — that is the
 * classic failure of the viewing room, and it is why researchers synthesize rather than letting the
 * room decide. So anything shown to a stakeholder carries its count, or it becomes a machine for
 * manufacturing certainty from n=1 (docs/principles/three-roles.md).
 *
 * These are OUTCOMES, not scores. `abandoned` is the most valuable thing a usability study
 * produces, and `harnessFailed` is the only member that says the instrument, rather than the
 * product, is what went wrong.
 */
export interface ParticipantOutcomes {
  /** Participants whose sessions reached a terminal state — the denominator for every count below. */
  total: number;
  /** Reached the goal. */
  reachedGoal: number;
  /** Stopped trying. A finding about the product. */
  abandoned: number;
  /** Ran out of session or budget before reaching the goal. */
  ranOut: number;
  /** Needed an approval the run could not give. */
  blocked: number;
  /** The harness failed them: a dead sandbox, a provider error, a broken artifact. */
  harnessFailed: number;
  /**
   * Participants who reported friction or a defect on the way, whatever their outcome.
   *
   * This is NOT a failure count and it overlaps the others on purpose — someone can reach the goal
   * and still tell you the road there was broken. A live two-persona run made the case: both
   * participants signed in, so "2/2 reached the goal" was true, and the keyboard-first one also
   * reported that the signature step could not be completed without a mouse. Reporting only the
   * outcome would have buried the single most useful thing that run produced.
   */
  reportedFriction: number;
}

export interface ReviewSummary {
  schema: typeof REVIEW_SCHEMA;
  verdict: "contract_proof_only" | "pass" | "fail" | "blocked" | "timed_out";
  summary: string;
  gaps: string[];
  /**
   * The study result, separate from the verdict above.
   *
   * `verdict` answers a gate-shaped question and has to collapse a run to one word. This answers
   * the research question — what happened to the people in the study — and does not collapse: a run
   * where two of three participants finished is not usefully "fail", and a run where the harness
   * broke is a different thing from one where a persona gave up. Absent on a dry-run contract
   * bundle, which has no participants.
   */
  participants?: ParticipantOutcomes;
  /**
   * The study's per-task completion rates (#414) — present only when the lab declared a protocol
   * and at least one session produced a funnel. Absent means no protocol was measured, never that
   * everyone finished.
   */
  tasks?: StudyTaskFunnel;
}

/** Tally participant outcomes from actor statuses. Statuses this does not recognise are counted in
 *  `total` but nowhere else, so the parts can never exceed the whole. */
export function tallyParticipantOutcomes(
  statuses: readonly ActorStatus[],
  /** Per-participant: did this one report friction or a defect? Same order as `statuses`. */
  reportedFriction: readonly boolean[] = []
): ParticipantOutcomes {
  const tally: ParticipantOutcomes = {
    total: statuses.length,
    reachedGoal: 0,
    abandoned: 0,
    ranOut: 0,
    blocked: 0,
    harnessFailed: 0,
    reportedFriction: reportedFriction.filter(Boolean).length
  };
  for (const status of statuses) {
    if (status === "passed") tally.reachedGoal += 1;
    else if (status === "abandoned") tally.abandoned += 1;
    else if (status === "incomplete" || status === "timed_out") tally.ranOut += 1;
    else if (status === "blocked") tally.blocked += 1;
    else if (status === "failed") tally.harnessFailed += 1;
  }
  return tally;
}

/**
 * The study's task funnel: for each declared task, how many participants completed it, out of how
 * many sessions produced a funnel. This is "where did people get stuck" as data — the number a
 * researcher reads first — where the per-participant funnels answer it one journey at a time.
 *
 * Aggregated by task id in declaration order. Every lane in a run shares the actor's protocol, so
 * ids line up across participants; a funnel missing a task id (a future mixed-protocol route)
 * simply does not count toward that task's denominator.
 */
export interface StudyTaskFunnel {
  /** Sessions that produced a funnel — the denominator for every count below. */
  sessions: number;
  tasks: Array<{
    id: string;
    /** Participants whose sessions corroborated this task complete. */
    completed: number;
    /** Sessions whose protocol declared this task — its denominator. */
    sessions: number;
    /** False when the task declared no success criterion: asked for, never measurable. */
    observable: boolean;
    /** Sessions where this task's criteria were never evaluated, because the observations they
     *  read never arrived. Counted apart from failures: "0/3 completed" with 3 unmeasured is a
     *  statement about our instrument, not about the participants (#514). */
    unmeasured: number;
  }>;
}

/** Roll per-participant funnels up into the study funnel. Undefined when nothing measured one. */
export function aggregateTaskFunnels(funnels: readonly TaskFunnel[]): StudyTaskFunnel | undefined {
  if (funnels.length === 0) return undefined;
  const order: string[] = [];
  const byId = new Map<
    string,
    { completed: number; sessions: number; observable: boolean; unmeasured: number }
  >();
  for (const funnel of funnels) {
    for (const task of funnel.tasks) {
      let entry = byId.get(task.id);
      if (entry === undefined) {
        entry = { completed: 0, sessions: 0, observable: false, unmeasured: 0 };
        byId.set(task.id, entry);
        order.push(task.id);
      }
      entry.sessions += 1;
      if (task.completed) entry.completed += 1;
      if (task.observable) entry.observable = true;
      if (task.inputsObserved === false) entry.unmeasured += 1;
    }
  }
  return {
    sessions: funnels.length,
    tasks: order.map((id) => {
      const entry = byId.get(id)!;
      return {
        id,
        completed: entry.completed,
        sessions: entry.sessions,
        observable: entry.observable,
        unmeasured: entry.unmeasured
      };
    })
  };
}

/** The funnel as one line, denominator on every number: `signup 2/2 · verify-email 1/2`. */
export function formatStudyTaskFunnel(funnel: StudyTaskFunnel): string {
  if (funnel.tasks.length === 0) return "no tasks declared";
  return funnel.tasks
    .map((task) => {
      if (!task.observable) return `${task.id} (no completion criterion)`;
      // A count that is entirely unmeasured must not render as a bare "0/3": that reads as a
      // participant failure when it is our observer that produced nothing (#514).
      if (task.unmeasured === task.sessions) {
        return `${task.id} (never measured in ${task.sessions})`;
      }
      const caveat = task.unmeasured > 0 ? ` (${task.unmeasured} never measured)` : "";
      return `${task.id} ${task.completed}/${task.sessions}${caveat}`;
    })
    .join(" · ");
}

/** One line a stakeholder can read, with the denominator attached to every number. */
export function formatParticipantOutcomes(outcomes: ParticipantOutcomes): string {
  if (outcomes.total === 0) return "no participants reached a terminal state";
  const parts: string[] = [`${outcomes.reachedGoal}/${outcomes.total} reached the goal`];
  if (outcomes.abandoned > 0) parts.push(`${outcomes.abandoned} gave up`);
  if (outcomes.ranOut > 0) parts.push(`${outcomes.ranOut} ran out of session`);
  // "blocked" covers an approval the run could not give AND a blocker the participant reported in
  // its own words (#476); the old "on an approval" read wrongly on a keyboard-first participant who
  // wrote "Blocked before diagram creation" about a mouse-only modal.
  if (outcomes.blocked > 0) parts.push(`${outcomes.blocked} blocked`);
  if (outcomes.harnessFailed > 0) parts.push(`${outcomes.harnessFailed} lost to a harness failure`);
  // Last, and separate, because it cuts across the outcomes rather than partitioning them: someone
  // can reach the goal and still have found the road there broken.
  if (outcomes.reportedFriction > 0) parts.push(`${outcomes.reportedFriction} reported friction`);
  return parts.join(", ");
}

export async function buildRunSource(args: {
  cwd: string;
  capturedAt?: Date | string;
  humanishSource: RunBundle["source"]["humanishSource"];
  packageName: string | null;
}): Promise<RunBundle["source"]> {
  const gitOptions = args.capturedAt === undefined ? {} : { capturedAt: args.capturedAt };
  return {
    packageName: args.packageName,
    humanishSource: args.humanishSource,
    git: await captureGitState(args.cwd, gitOptions)
  };
}

export interface RunResult {
  schema: "humanish.run-result.v1";
  ok: boolean;
  runId?: string;
  mode?: "dry-run" | "live";
  simCount?: number;
  cwd: string;
  artifactRoot?: string;
  bundlePath?: string;
  reviewPath?: string;
  latestPath?: string;
  warnings: string[];
  error?: {
    code:
      | "HUMANISH_ACTOR_FANOUT_UNIMPLEMENTED"
      | "HUMANISH_APP_URL_OPTION_CONFLICT"
      | "HUMANISH_BROWSER_APP_CAPTURE_FAILED"
      | "HUMANISH_CODEX_APP_SERVER_FAILED"
      | "HUMANISH_LIVE_RUN_UNIMPLEMENTED"
      | "HUMANISH_LOCAL_CODEX_EXEC_FAILED"
      | "HUMANISH_LOCAL_CODEX_TUI_FAILED"
      | "HUMANISH_INVALID_APP_URL"
      | "HUMANISH_INVALID_ACTOR_CONCURRENCY"
      | "HUMANISH_INVALID_CWD"
      | "HUMANISH_INVALID_SIM_COUNT"
      | "HUMANISH_INVALID_TIMEOUT"
      | "HUMANISH_INVALID_PORT"
      | "HUMANISH_UNSUPPORTED_ACTOR"
      | "HUMANISH_UNSUPPORTED_RERUN_FLAGS"
      | "HUMANISH_WATCH_OPTION_CONFLICT"
      // #316 CLI-loadable adopter scorer — fail-closed at load, pre-spend.
      | "HUMANISH_LAB_SCORER_BAD_REF"
      | "HUMANISH_LAB_SCORER_NOT_FOUND"
      | "HUMANISH_LAB_SCORER_LOAD_FAILED"
      | "HUMANISH_LAB_SCORER_NO_HOOKS"
      | "HUMANISH_LAB_SCORER_UNSUPPORTED_BACKEND";
    message: string;
  };
}

export interface VerifyResult {
  schema: typeof VERIFY_SCHEMA;
  ok: boolean;
  cwd: string;
  run: string;
  bundlePath?: string;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
  }>;
  shareSafety: {
    status: "share_ready" | "local_only" | "blocked";
    reasons: Array<{
      code:
        | "VERIFY_FAILED"
        | "PUBLIC_SAFETY_FINDINGS"
        | "RAW_SCREENSHOTS";
      message: string;
    }>;
  };
  // Advisory postures the operator must see (e.g. raw full-fidelity screenshots) that never
  // flip ok: overriding a default is supported, but ok: true must not read as "share-ready".
  warnings: string[];
  error?: {
    code: "HUMANISH_RUN_NOT_FOUND" | "HUMANISH_INVALID_RUN_BUNDLE";
    message: string;
  };
}

export interface CleanupResourceResult {
  provider: RunProviderResource["provider"];
  kind: RunProviderResource["kind"];
  id: string;
  status: "killed" | "already_clean" | "failed" | "skipped";
  message: string;
}

export interface CleanupAdapterResult {
  id: string;
  ok: boolean;
  message: string;
}

export interface CleanupResult {
  schema: typeof CLEANUP_SCHEMA;
  ok: boolean;
  cwd: string;
  run: string;
  runId?: string;
  bundlePath?: string;
  cleanupPath?: string;
  checkedAt: string;
  summary: {
    resources: number;
    killed: number;
    alreadyClean: number;
    failed: number;
    skipped: number;
  };
  resources: CleanupResourceResult[];
  adapterResults: CleanupAdapterResult[];
  warnings: string[];
  error?: {
    code: "HUMANISH_RUN_NOT_FOUND" | "HUMANISH_INVALID_RUN_BUNDLE";
    message: string;
  };
}

export interface RunCleanupHooks {
  /** @deprecated Ignored. Stored provider ids are not authority to load or mutate a provider. */
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  cleanupAdapterResources?: (ctx: {
    cwd: string;
    runDir: string;
    bundle: RunBundle;
  }) => Promise<CleanupAdapterResult[]>;
  now?: () => Date;
}

export interface RunsResult {
  schema: typeof RUNS_SCHEMA;
  ok: boolean;
  cwd: string;
  runs: Array<{
    runId: string;
    createdAt: string | null;
    mode: string | null;
    path: string;
  }>;
  latest: string | null;
  error?: {
    code: "HUMANISH_RUNS_UNAVAILABLE";
    message: string;
  };
}

export interface DoctorResult {
  schema: typeof DOCTOR_SCHEMA;
  ok: boolean;
  cwd: string;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
      /**
     * ADDITIVE + OPTIONAL. `false` means the check never ran — the directory could not be read, so
     * there is nothing to report about it either way. Absent means it ran and `ok` is its verdict.
     *
     * It exists because a failed check and an unrun one used to render identically, and the unrun
     * rows carried the SUCCESS text: a participant read `missing package.json: package.json is
     * present and safe to read` off a real screen (labs/tui-self-study.yaml).
     */
    checked?: boolean;
}>;
}

interface RunPointer {
  schema: "humanish.latest-run.v1";
  runId: string;
  path: string;
  updatedAt: string;
}

const CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA = "humanish.codex-app-server-trace.projected.v1";

// 15 minutes (was 240s): a four-minute default refuses real coding-agent work.
const LOCAL_CODEX_TUI_DEFAULT_TIMEOUT_MS = 900_000;
// A 60-minute guard still guards (was 600s, which capped legitimate long sessions).
const LOCAL_CODEX_TUI_MAX_TIMEOUT_MS = 3_600_000;
const LOCAL_ACTOR_TRANSCRIPT_MAX_CHARS = 80_000;
const LOCAL_CODEX_EXEC_DEFAULT_MAX_CONCURRENCY = 4;
const BROWSER_APP_DEFAULT_TIMEOUT_MS = 300_000;

type LocalCodexActor = "codex-tui" | "codex-exec" | "codex-app-server";

const builtinPersona = {
  id: "builtin-synthetic-new-user",
  name: "Built-in Synthetic New User",
  source: "builtin:synthetic-new-user",
  sourceDigest: "builtin"
};

const builtinScenario = {
  id: "builtin-first-run-smoke",
  title: "Built-in First-Run Smoke",
  goal: "Create a public-safe dry-run contract bundle from built-in defaults.",
  source: "builtin:first-run-smoke",
  sourceDigest: "builtin"
};

/**
 * The synthetic/local backends. The body runs inside a status scope so that returning from it —
 * by any of its exits, including the fail-closed ones — finalizes whatever status records it
 * opened. See `withRunStatusScope`.
 */
export async function runDryRun(options: RunOptions): Promise<RunResult> {
  return withRunStatusScope(() => runDryRunInScope(options));
}

async function runDryRunInScope(options: RunOptions): Promise<RunResult> {
  const cwd = path.resolve(options.cwd);
  const cwdError = await validateCwd(cwd);
  const warnings: string[] = [];

  if (cwdError) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: cwdError
    };
  }

  if (options.actor !== undefined && !isLocalCodexActor(options.actor)) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "HUMANISH_UNSUPPORTED_ACTOR",
        message: `Unsupported actor: ${options.actor}`
      }
    };
  }

  const simCount = normalizeSimCount(options.appUrl ? options.simCount ?? 2 : options.simCount);
  if (simCount === null) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "HUMANISH_INVALID_SIM_COUNT",
        message: "--sims must be a positive integer."
      }
    };
  }

  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(cwd), cwd);

  if (options.appUrl !== undefined) {
    if (options.dryRun) {
      return {
        schema: "humanish.run-result.v1",
        ok: false,
        cwd,
        warnings,
        error: {
          code: "HUMANISH_APP_URL_OPTION_CONFLICT",
          message: "Use --app-url for a live browser app proof; remove --dry-run."
        }
      };
    }

    if (simCount > 2) {
      return {
        schema: "humanish.run-result.v1",
        ok: false,
        cwd,
        warnings,
        error: {
          code: "HUMANISH_INVALID_SIM_COUNT",
          message: "--sims must be 1 or 2 when --app-url is used."
        }
      };
    }

    return runBrowserAppProof({ ...options, appUrl: options.appUrl, cwd, projectRoot, simCount });
  }

  if (!options.dryRun) {
    const actor = resolveRequestedLocalCodexActor(options.actor);
    if (actor === "codex-tui") {
      return runLocalCodexTui({ ...options, actor, cwd, projectRoot, simCount });
    }
    if (actor === "codex-exec") {
      return runLocalCodexExec({ ...options, actor, cwd, projectRoot, simCount });
    }
    if (actor === "codex-app-server") {
      return runLocalCodexAppServer({ ...options, actor, cwd, projectRoot, simCount });
    }

    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd,
      warnings,
      error: {
        code: "HUMANISH_LIVE_RUN_UNIMPLEMENTED",
        message: "Only run --dry-run is implemented unless --actor codex-tui, --actor codex-exec, --actor codex-app-server, or the matching HUMANISH_ENABLE_LOCAL_CODEX_* env var is set."
      }
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId = options.runId ?? `dryrun-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const packageName = await readPackageName(projectRoot);
  const humanishSource = await implicitProjectDirectoryExists(projectRoot, "humanish") ? "present" : "missing";
  const source = await buildRunSource({ cwd, capturedAt: createdAt, humanishSource, packageName });
  const selection = await loadDryRunSelection(projectRoot, humanishSource);
  await assertPreparedSelectedOutputDirectory(projectRoot);
  const runPaths = await prepareRunArtifactPaths(cwd, runId);
  // Identity + liveness on disk (#455): uniform across every route, so a reader classifies any
  // run from one small file instead of parsing bundles.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: options.dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab })
  });
  const artifactRoot = runPaths.relativeRunRoot;

  if (humanishSource === "missing") {
    warnings.push("Committed humanish/ source was not found; using built-in synthetic dry-run defaults.");
  }
  warnings.push(...selection.warnings);

  const observerFixtures = buildSyntheticObserverFixtures({
    createdAt,
    personaId: selection.persona.id,
    scenarioId: selection.scenario.id,
    simCount
  });

  const bundle: RunBundle = {
    schema: RUN_BUNDLE_SCHEMA,
    runId,
    mode: "dry-run",
    simCount,
    createdAt,
    cwd,
    artifactRoot,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    source,
    persona: selection.persona,
    scenario: selection.scenario,
    lifecycle: [
      {
        at: createdAt,
        event: "run.created",
        message: `Synthetic dry-run contract bundle created with ${simCount} sim${simCount === 1 ? "" : "s"}.`
      },
      {
        at: createdAt,
        event: "persona.selected",
        message: "Selected public-safe synthetic persona."
      },
      {
        at: createdAt,
        event: "scenario.selected",
        message: "Selected public-safe first-run scenario."
      },
      {
        at: createdAt,
        event: "review.skeleton.created",
        message: "Created review skeleton without claiming product proof."
      }
    ],
    simulations: observerFixtures.simulations,
    streams: observerFixtures.streams,
    events: observerFixtures.events,
    redaction: {
      status: "passed",
      notes: "Dry-run bundle contains synthetic contract proof only."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review: createReviewSummary(),
    feedbackCandidates: []
  };

  await writeRunBundleArtifacts(runPaths, bundle, runStatus);
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId,
      path: artifactRoot,
      updatedAt: createdAt
    } satisfies RunPointer, null, 2)}\n`,
    "utf8"
  );

  return {
    schema: "humanish.run-result.v1",
    ok: true,
    runId,
    mode: "dry-run",
    simCount,
    cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: runPaths.relativeLatestPointer,
    warnings
  };
}

async function runBrowserAppProof(options: RunOptions & {
  appUrl: string;
  cwd: string;
  projectRoot: PreparedSelectedOutputDirectory;
  simCount: number;
}): Promise<RunResult> {
  const warnings: string[] = [];
  const appUrl = normalizeLocalAppUrl(options.appUrl);
  if (!appUrl) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_INVALID_APP_URL",
        message: "--app-url must be an http(s) loopback URL such as http://127.0.0.1:5173."
      }
    };
  }

  const browserCommand = await resolveBrowserCommand();
  if (!browserCommand) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_BROWSER_APP_CAPTURE_FAILED",
        message: "No Chrome/Chromium browser command was found. Set HUMANISH_BROWSER_COMMAND to a browser binary that supports --headless and --screenshot."
      }
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId = options.runId ?? `browser-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const packageName = await readPackageName(options.projectRoot);
  const humanishSource = await implicitProjectDirectoryExists(options.projectRoot, "humanish") ? "present" : "missing";
  const source = await buildRunSource({ cwd: options.cwd, capturedAt: createdAt, humanishSource, packageName });
  const selection = await loadDryRunSelection(options.projectRoot, humanishSource);
  await assertPreparedSelectedOutputDirectory(options.projectRoot);
  const runPaths = await prepareRunArtifactPaths(options.cwd, runId);
  // Identity + liveness on disk (#455): uniform across every route, so a reader classifies any
  // run from one small file instead of parsing bundles.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: options.dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab })
  });
  const artifactRoot = runPaths.relativeRunRoot;
  if (selection.browserJourneyFailure) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings: [...warnings, ...selection.warnings],
      error: {
        code: "HUMANISH_BROWSER_APP_CAPTURE_FAILED",
        message: selection.browserJourneyFailure
      }
    };
  }

  const browserJourney = selection.browserJourney ?? builtinBrowserPersonaJourney();
  if (humanishSource === "missing") {
    warnings.push("Committed humanish/ source was not found; using built-in synthetic browser-app defaults.");
  }
  if (!selection.browserJourney) {
    warnings.push("No executable browser scenario manifest was found; using built-in browser persona two-step journey.");
  }
  warnings.push(...selection.warnings);

  await prepareContainedOutputDirectory(runPaths, "screenshots");
  await prepareContainedOutputDirectory(runPaths, "traces");

  const surfaces = browserSurfaces.slice(0, options.simCount);
  const captures = await Promise.all(surfaces.map((surface) => captureBrowserSurface({
    absoluteArtifactRoot: runPaths,
    appUrl,
    browserCommand,
    browserJourney,
    surface,
    timeoutMs: options.timeoutMs ?? BROWSER_APP_DEFAULT_TIMEOUT_MS
  })));
  await validatePreparedRunArtifactPaths(runPaths);
  const completedAt = new Date().toISOString();
  const events = buildBrowserAppEvents({ appUrl, captures, createdAt });
  const allPassed = captures.every((capture) => capture.ok);
  const review = createBrowserAppReviewSummary({ appUrl, browserJourney, captures });
  const bundle: RunBundle = {
    schema: RUN_BUNDLE_SCHEMA,
    runId,
    mode: "live",
    simCount: captures.length,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    source,
    persona: {
      id: selection.persona.id,
      name: selection.persona.name,
      source: selection.persona.source,
      sourceDigest: selection.persona.sourceDigest
    },
    scenario: {
      id: browserJourney.scenarioId,
      title: browserJourney.scenarioTitle,
      goal: browserJourney.goal,
      source: browserJourney.source,
      sourceDigest: browserJourney.sourceDigest
    },
    lifecycle: [
      {
        at: createdAt,
        event: "run.created",
        message: `Live browser persona proof created for ${appUrl}.`
      },
      {
        at: createdAt,
        event: "app.url.accepted",
        message: "Accepted public-safe loopback app URL for browser persona journey."
      },
      {
        at: completedAt,
        event: "review.created",
        message: allPassed
          ? "Created review from desktop/mobile browser persona step evidence."
          : "Created review with missing or blocked browser persona step evidence."
      }
    ],
    simulations: captures.map((capture, index) => {
      const simId = `browser-${capture.surface.id}`;
      const streamId = `${simId}-stream`;
      return {
        id: simId,
        index: index + 1,
        personaId: selection.persona.id,
        scenarioId: browserJourney.scenarioId,
        status: capture.ok ? "passed" : "blocked",
        streamKind: "browser",
        mode: "browser-sim",
        progress: 100,
        currentStep: capture.ok
          ? `${capture.surface.label} completed ${capture.steps.length} persona steps`
          : `${capture.surface.label} journey blocked`,
        summary: capture.reason,
        streamIds: [streamId],
        startedAt: createdAt,
        updatedAt: capture.capturedAt
      };
    }),
    streams: captures.map((capture) => {
      const simId = `browser-${capture.surface.id}`;
      const streamId = `${simId}-stream`;
      // Never reference a screenshot the producer did not write (artifact-reference.ts).
      // A blocked capture whose evidence IS the failure carries no surface screenshot, so
      // we omit the embed URL + ui.screenshotUrl and keep the stream present with its
      // blocked status — instead of claiming an artifact that verify would fail closed on.
      // A capture that claims success but is missing its screenshot still keeps the
      // reference so missingLocalEvidenceArtifacts can catch the broken producer.
      const surfaceScreenshot = hasWrittenScreenshot(capture) ? capture.screenshotPath : undefined;
      const screenshotUrl = surfaceScreenshot ? `../${surfaceScreenshot}` : undefined;
      return {
        id: streamId,
        simId,
        kind: "browser",
        label: capture.surface.label,
        status: capture.ok ? "passed" : "blocked",
        transport: "snapshot",
        updatedAt: capture.capturedAt,
        embed: screenshotUrl
          ? { kind: "screenshot", url: screenshotUrl, title: capture.surface.label }
          : { kind: "placeholder", title: `${capture.surface.label} (blocked — no screenshot captured)` },
        viewport: capture.surface.viewport,
        ui: {
          appStatus: capture.ok ? "running" : "blocked",
          appUrl,
          route: appUrl,
          intent: browserJourney.goal,
          ...(screenshotUrl ? { screenshotUrl } : {}),
          state: capture.reason,
          visualStatus: capture.ok ? "visible" : "blocked"
        },
        completion: {
          checkedAt: capture.capturedAt,
          exitCode: capture.ok ? 0 : 1,
          reason: capture.reason,
          status: capture.ok ? "passed" : "blocked"
        },
        artifacts: [
          { label: "run bundle", path: "run.json", kind: "bundle" },
          { label: "review", path: "review.md", kind: "review" },
          { label: "event log", path: "events.ndjson", kind: "events" },
          { label: `${capture.surface.id} browser trace`, path: capture.tracePath, kind: "trace" },
          // Per-step screenshot artifacts only for steps whose screenshot was actually
          // written; blocked-not-executed steps recorded no path and claim nothing.
          ...capture.steps.flatMap((step) => {
            const stepScreenshot = artifactReferenceIfWritten(step.screenshotPath, hasWrittenScreenshot(step));
            return stepScreenshot
              ? [{ label: `${capture.surface.id} ${step.id} screenshot`, path: stepScreenshot, kind: "screenshot" as const }]
              : [];
          })
        ]
      } satisfies RunStream;
    }),
    events,
    redaction: {
      status: "passed",
      notes: "Browser persona proof stores loopback app URLs, screenshots, and generated traces only; secret-like text is rejected by verify."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    feedbackCandidates: []
  };

  await writeRunBundleArtifacts(runPaths, bundle, runStatus);
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId,
      path: artifactRoot,
      updatedAt: completedAt
    } satisfies RunPointer, null, 2)}\n`,
    "utf8"
  );

  return {
    schema: "humanish.run-result.v1",
    ok: allPassed,
    runId,
    mode: "live",
    simCount: captures.length,
    cwd: options.cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: runPaths.relativeLatestPointer,
    warnings,
    ...(allPassed
      ? {}
      : {
          error: {
            code: "HUMANISH_BROWSER_APP_CAPTURE_FAILED" as const,
            message: review.summary
          }
      })
  };
}

function buildBrowserAppEvents(args: {
  appUrl: string;
  captures: BrowserSurfaceCapture[];
  createdAt: string;
}): RunEvent[] {
  const events: RunEvent[] = [
    {
      id: "event-001",
      at: args.createdAt,
      level: "info",
      type: "browser-persona.run.created",
      message: "Created live browser persona proof run against a loopback URL."
    }
  ];

  args.captures.forEach((capture) => {
    events.push({
      id: `event-${String(events.length + 1).padStart(3, "0")}`,
      at: capture.capturedAt,
      level: capture.ok ? "info" : "warn",
      type: capture.ok ? "browser-persona.journey.passed" : "browser-persona.journey.blocked",
      message: `${capture.surface.id}: ${capture.reason}`,
      simId: `browser-${capture.surface.id}`,
      streamId: `browser-${capture.surface.id}-stream`
    });
    for (const step of capture.steps) {
      events.push({
        id: `event-${String(events.length + 1).padStart(3, "0")}`,
        at: step.completedAt,
        level: step.status === "passed" ? "info" : "warn",
        type: step.status === "passed" ? "browser-persona.step.passed" : "browser-persona.step.blocked",
        message: `${capture.surface.id} ${step.id}: ${step.reason}`,
        simId: `browser-${capture.surface.id}`,
        streamId: `browser-${capture.surface.id}-stream`
      });
    }
  });

  return events;
}

function createBrowserAppReviewSummary(args: {
  appUrl: string;
  browserJourney: BrowserPersonaJourney;
  captures: BrowserSurfaceCapture[];
}): ReviewSummary {
  const passed = args.captures.filter((capture) => capture.ok).length;
  const allPassed = passed === args.captures.length;
  const usedBuiltinFallback = args.browserJourney.source.startsWith("builtin:");
  return {
    schema: REVIEW_SCHEMA,
    verdict: allPassed ? "pass" : "blocked",
    summary: allPassed
      ? `Completed ${passed}/${args.captures.length} live browser persona journey${args.captures.length === 1 ? "" : "s"} from ${args.appUrl} using ${args.browserJourney.scenarioId}.`
      : `Completed ${passed}/${args.captures.length} live browser persona journeys from ${args.appUrl} using ${args.browserJourney.scenarioId}; at least one required journey was blocked.`,
    gaps: [
      usedBuiltinFallback
        ? "This proof used the built-in two-step fallback because no executable browser scenario manifest was found."
        : `This proof used executable browser steps from ${args.browserJourney.source}.`,
      "Only loopback app URLs are accepted so generated bundles do not preserve private external targets.",
      ...args.captures
        .filter((capture) => !capture.ok)
        .map((capture) => `${capture.surface.id}: ${capture.reason}`)
    ]
  };
}

function isLocalCodexActor(value: string): value is LocalCodexActor {
  return value === "codex-tui" || value === "codex-exec" || value === "codex-app-server";
}

function resolveRequestedLocalCodexActor(actor: string | undefined): LocalCodexActor | undefined {
  if (actor && isLocalCodexActor(actor)) {
    return actor;
  }

  if (process.env.HUMANISH_ENABLE_LOCAL_CODEX_TUI === "1") {
    return "codex-tui";
  }

  if (process.env.HUMANISH_ENABLE_LOCAL_CODEX_EXEC === "1") {
    return "codex-exec";
  }

  if (process.env.HUMANISH_ENABLE_LOCAL_CODEX_APP_SERVER === "1") {
    return "codex-app-server";
  }

  return undefined;
}

async function runLocalCodexTui(options: RunOptions & {
  actor: "codex-tui";
  cwd: string;
  projectRoot: PreparedSelectedOutputDirectory;
  simCount: number;
}): Promise<RunResult> {
  const warnings: string[] = [];

  if (options.simCount !== 1) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_ACTOR_FANOUT_UNIMPLEMENTED",
        message: "Local Codex TUI actor support is currently single-lane because it owns one PTY/UI session. Use codex-exec for bounded-concurrency fanout."
      }
    };
  }

  const timeoutMs = normalizeActorTimeout(options.timeoutMs ?? readEnvInteger("HUMANISH_CODEX_ACTOR_TIMEOUT_MS") ?? LOCAL_CODEX_TUI_DEFAULT_TIMEOUT_MS);
  if (timeoutMs === null) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_INVALID_TIMEOUT",
        message: `--timeout-ms must be an integer between 1 and ${LOCAL_CODEX_TUI_MAX_TIMEOUT_MS}.`
      }
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId = options.runId ?? `codex-tui-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const usesDefaultCodexCommand = options.actorCommand === undefined && process.env.HUMANISH_CODEX_ACTOR_COMMAND === undefined;
  const trustPreflight = usesDefaultCodexCommand ? await checkCodexWorkspaceTrust(options.cwd) : { ok: true as const };
  const packageName = await readPackageName(options.projectRoot);
  const humanishSource = await implicitProjectDirectoryExists(options.projectRoot, "humanish") ? "present" : "missing";
  const source: RunBundle["source"] = !trustPreflight.ok && trustPreflight.unsafeMetadata
    ? {
        packageName,
        humanishSource,
        git: {
          schema: GIT_STATE_SCHEMA,
          status: "unavailable",
          capturedAt: createdAt,
          head: { shortSha: null, refState: "unknown" },
          changes: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
          note: "Git metadata failed containment validation."
        }
      }
    : await buildRunSource({ cwd: options.cwd, capturedAt: createdAt, humanishSource, packageName });
  const selection = await loadDryRunSelection(options.projectRoot, humanishSource);
  await assertPreparedSelectedOutputDirectory(options.projectRoot);
  const runPaths = await prepareRunArtifactPaths(options.cwd, runId);
  // Identity + liveness on disk (#455): uniform across every route, so a reader classifies any
  // run from one small file instead of parsing bundles.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: options.dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab })
  });
  const artifactRoot = runPaths.relativeRunRoot;
  if (humanishSource === "missing") {
    warnings.push("Committed humanish/ source was not found; using built-in synthetic local actor defaults.");
  }
  warnings.push(...selection.warnings);
  const verdictNonce = randomUUID().slice(0, 12);
  const prompt = buildLocalCodexTuiPrompt(selection, verdictNonce);
  const promptDigest = digestText(prompt);
  const command = resolveLocalCodexTuiCommand(options.cwd, prompt, options.actorCommand);
  const simId = "sim-01";
  const streamId = "sim-01-codex-tui";
  const events: RunEvent[] = [];
  const appendEvent = async (
    type: string,
    message: string,
    level: RunEvent["level"] = "info"
  ): Promise<void> => {
    events.push({
      id: `event-${String(events.length + 1).padStart(3, "0")}`,
      at: new Date().toISOString(),
      level,
      type,
      message,
      simId,
      streamId
    });
    await writeContainedOutputFile(runPaths, "events.ndjson", `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  };

  let actor: LocalActorCommandResult;
  if (!trustPreflight.ok) {
    actor = {
      durationMs: 0,
      reason: trustPreflight.message,
      status: "blocked",
      transcript: `${trustPreflight.message}\nRecovery: ${trustPreflight.recoveryCommand}\n`,
      transcriptBytes: Buffer.byteLength(trustPreflight.message)
    };
    await appendEvent("actor.preflight.blocked", redactSensitiveText(trustPreflight.message), "warn");
  } else {
    await appendEvent(
      "actor.spawned",
      `Spawned local Codex TUI actor command ${command.name} in explicit opt-in mode.`
    );
    await appendEvent(
      "actor.prompt.submitted",
      `Submitted bounded public-safe dogfood prompt digest ${promptDigest}; raw prompt omitted from event log.`
    );
    await appendEvent(
      "actor.running",
      "Published local Codex TUI running snapshot for Observer polling."
    );

    const runningAt = new Date().toISOString();
    const runningBundle: RunBundle = {
      schema: RUN_BUNDLE_SCHEMA,
      runId,
      mode: "live",
      simCount: 1,
      createdAt,
      cwd: options.cwd,
      artifactRoot,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
      source,
      persona: selection.persona,
      scenario: selection.scenario,
      lifecycle: [
        {
          at: createdAt,
          event: "run.created",
          message: "Live local Codex TUI run created with one explicit opt-in actor."
        },
        {
          at: createdAt,
          event: "actor.selected",
          message: "Selected local codex-tui actor."
        },
        {
          at: runningAt,
          event: "actor.running",
          message: "Local Codex TUI actor is running; Observer data will refresh with sanitized evidence after completion."
        }
      ],
      simulations: [
        {
          id: simId,
          index: 1,
          personaId: selection.persona.id,
          scenarioId: selection.scenario.id,
          status: "running",
          streamKind: "tui",
          mode: "tui-sim",
          progress: 35,
          currentStep: "Local Codex TUI actor running",
          summary: "Local Codex TUI actor is running.",
          streamIds: [streamId],
          startedAt: createdAt,
          updatedAt: runningAt
        }
      ],
      streams: [
        {
          id: streamId,
          simId,
          kind: "tui",
          label: "Local Codex TUI actor",
          status: "running",
          transport: "pty",
          updatedAt: runningAt,
          embed: {
            kind: "terminal",
            title: "Local Codex TUI actor"
          },
          terminal: {
            title: "Local Codex TUI actor",
            format: "ansi",
            stdin: "sent",
            tail: "Codex TUI actor is running; sanitized transcript evidence will be linked after completion."
          },
          completion: {
            checkedAt: runningAt,
            reason: "actor process is still running",
            status: "running"
          },
          artifacts: [
            { label: "run bundle", path: "run.json", kind: "bundle" },
            { label: "review", path: "review.md", kind: "review" },
            { label: "event log", path: "events.ndjson", kind: "events" }
          ]
        }
      ],
      events,
      redaction: {
        status: "passed",
        notes: "Running TUI bundle contains no raw transcript yet; final actor output will be redacted before persistence."
      },
      artifacts: {
        run: "run.json",
        reviewJson: "review.json",
        reviewMarkdown: "review.md",
        observerData: "observer/observer-data.json",
        events: "events.ndjson"
      },
      review: createLocalActorRunningReviewSummary("Codex TUI"),
      feedbackCandidates: []
    };
    await writeRunBundleArtifacts(runPaths, runningBundle);
    await writePreparedRunLatestPointer(
      runPaths,
      `${JSON.stringify({
        schema: "humanish.latest-run.v1",
        runId,
        path: artifactRoot,
        updatedAt: runningAt
      } satisfies RunPointer, null, 2)}\n`,
      "utf8"
    );

    actor = await executeLocalActorCommand(command, {
      cwd: options.cwd,
      timeoutMs,
      verdictNonce
    });
  }
  await validatePreparedRunArtifactPaths(runPaths);
  const completedAt = new Date().toISOString();
  const redactedTranscript = redactSensitiveText(actor.transcript);
  const tail = tailText(redactedTranscript, 6_000);
  const status = actor.status;
  // Redact the reason before it flows into the persisted event, simulation
  // summary, completion reason, review, and lifecycle. For a trust-preflight
  // block the reason embeds the absolute workspace path; the live CLI reason can
  // still show the real path, but the public-safe bundle must not.
  const verdictReason = redactSensitiveText(actor.reason);

  await writeContainedOutputFile(
    runPaths,
    "transcripts/codex-tui-sanitized.txt",
    redactedTranscript.length > 0 ? redactedTranscript : "No transcript output captured.\n",
    "utf8"
  );
  await writeContainedOutputFile(runPaths, "actor.json", `${JSON.stringify({
    schema: "humanish.local-codex-tui-actor.v1",
    actor: "codex-tui",
    commandName: command.name,
    promptDigest,
    verdictNonce,
    startedAt: createdAt,
    completedAt,
    durationMs: actor.durationMs,
    exitCode: actor.exitCode,
    signal: actor.signal,
    status,
    timeoutMs,
    transcriptBytes: actor.transcriptBytes,
    transcriptPath: "transcripts/codex-tui-sanitized.txt",
    redaction: "passed"
  }, null, 2)}\n`, "utf8");

  await appendEvent(
    "actor.observation",
    `Captured ${actor.transcriptBytes} output byte${actor.transcriptBytes === 1 ? "" : "s"}; sanitized transcript tail recorded with redaction=passed.`
  );
  await appendEvent(
    "actor.artifact",
    "Wrote sanitized Codex TUI transcript and actor trace artifacts under the ignored run directory."
  );
  await appendEvent(
    "actor.verdict",
    `Local Codex TUI actor verdict ${status}: ${verdictReason}`,
    status === "passed" ? "info" : status === "timed_out" ? "warn" : "error"
  );
  await appendEvent(
    status === "timed_out" ? "actor.timeout" : status === "blocked" && !trustPreflight.ok ? "actor.blocked" : "actor.exited",
    status === "timed_out"
      ? `Actor timed out after ${timeoutMs}ms; last safe observation retained.`
      : status === "blocked" && !trustPreflight.ok
        ? "Actor launch was blocked by preflight before spawn."
        : `Actor exited with code ${actor.exitCode ?? "null"}${actor.signal ? ` and signal ${actor.signal}` : ""}.`,
    status === "passed" ? "info" : "warn"
  );

  const bundle: RunBundle = {
    schema: RUN_BUNDLE_SCHEMA,
    runId,
    mode: "live",
    simCount: 1,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    source,
    persona: selection.persona,
    scenario: selection.scenario,
    lifecycle: [
      {
        at: createdAt,
        event: "run.created",
        message: "Live local Codex TUI run created with one explicit opt-in actor."
      },
      {
        at: createdAt,
        event: "actor.selected",
        message: "Selected local codex-tui actor."
      },
      {
        at: completedAt,
        event: "review.skeleton.created",
        message: "Created review skeleton from sanitized actor lifecycle evidence."
      }
    ],
    simulations: [
      {
        id: simId,
        index: 1,
        personaId: selection.persona.id,
        scenarioId: selection.scenario.id,
        status,
        streamKind: "tui",
        mode: "tui-sim",
        progress: 100,
        currentStep: status === "passed" ? "Local Codex TUI actor completed" : "Local Codex TUI actor needs review",
        summary: `Local Codex TUI actor ${status}: ${verdictReason}`,
        streamIds: [streamId],
        startedAt: createdAt,
        updatedAt: completedAt
      }
    ],
    streams: [
      {
        id: streamId,
        simId,
        kind: "tui",
        label: "Local Codex TUI actor",
        status,
        transport: "pty",
        updatedAt: completedAt,
        embed: {
          kind: "terminal",
          title: "Local Codex TUI actor"
        },
        terminal: {
          title: "Local Codex TUI actor",
          format: "ansi",
          stdin: "sent",
          tail
        },
        completion: {
          checkedAt: completedAt,
          ...(actor.exitCode === undefined ? {} : { exitCode: actor.exitCode }),
          logTail: tail,
          reason: verdictReason,
          status
        },
        artifacts: [
          { label: "run bundle", path: "run.json", kind: "bundle" },
          { label: "review", path: "review.md", kind: "review" },
          { label: "event log", path: "events.ndjson", kind: "events" },
          { label: "sanitized transcript", path: "transcripts/codex-tui-sanitized.txt", kind: "log" },
          { label: "actor trace", path: "actor.json", kind: "trace" }
        ]
      }
    ],
    events,
    redaction: {
      status: "passed",
      notes: "Actor output was redacted before transcript and bundle persistence; raw prompt is omitted from event log."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review: createLocalActorReviewSummary("Codex TUI", status, verdictReason),
    feedbackCandidates: []
  };

  await writeRunBundleArtifacts(runPaths, bundle, runStatus);
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId,
      path: artifactRoot,
      updatedAt: completedAt
    } satisfies RunPointer, null, 2)}\n`,
    "utf8"
  );

  return {
    schema: "humanish.run-result.v1",
    ok: status === "passed",
    runId,
    mode: "live",
    simCount: 1,
    cwd: options.cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: runPaths.relativeLatestPointer,
    warnings,
    ...(status === "passed"
      ? {}
      : {
          error: {
            code: "HUMANISH_LOCAL_CODEX_TUI_FAILED" as const,
            message: `Local Codex TUI actor ${status}: ${verdictReason}`
          }
      })
  };
}

interface LocalCodexExecLaneBundleInput {
  completion?: RunStreamCompletion;
  currentStep: string;
  focus: LocalCodexExecFocus;
  progress: number;
  simId: string;
  status: RunSimulationStatus;
  streamId: string;
  summary: string;
  terminalTail: string;
  tracePath?: string;
  transcriptPath?: string;
  updatedAt: string;
}

function buildLocalCodexExecBundle(args: {
  artifactRoot: string;
  createdAt: string;
  cwd: string;
  events: RunEvent[];
  lanes: LocalCodexExecLaneBundleInput[];
  lifecycle: RunBundle["lifecycle"];
  humanishSource: RunBundle["source"]["humanishSource"];
  packageName: string | null;
  review: ReviewSummary;
  runId: string;
  scenario: RunBundle["scenario"];
  persona: RunBundle["persona"];
  simCount: number;
  source: RunBundle["source"];
}): RunBundle {
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: "live",
    simCount: args.simCount,
    createdAt: args.createdAt,
    cwd: args.cwd,
    artifactRoot: args.artifactRoot,
    source: args.source,
    persona: args.persona,
    scenario: args.scenario,
    lifecycle: args.lifecycle,
    simulations: args.lanes.map((lane, index): RunSimulation => ({
      id: lane.simId,
      index: index + 1,
      personaId: `codex-exec-${lane.focus.id}`,
      scenarioId: args.scenario.id,
      status: lane.status,
      streamKind: "terminal",
      mode: "cli-sim",
      progress: lane.progress,
      currentStep: lane.currentStep,
      summary: lane.summary,
      streamIds: [lane.streamId],
      startedAt: args.createdAt,
      updatedAt: lane.updatedAt
    })),
    streams: args.lanes.map((lane): RunStream => {
      const artifacts: RunStream["artifacts"] = [
        { label: "run bundle", path: "run.json", kind: "bundle" },
        { label: "review", path: "review.md", kind: "review" },
        { label: "event log", path: "events.ndjson", kind: "events" },
        ...(lane.transcriptPath ? [{ label: "sanitized transcript", path: lane.transcriptPath, kind: "log" as const }] : []),
        ...(lane.tracePath ? [{ label: "actor trace", path: lane.tracePath, kind: "trace" as const }] : [])
      ];

      return {
        id: lane.streamId,
        simId: lane.simId,
        kind: "terminal",
        label: `Local Codex exec - ${lane.focus.label}`,
        status: lane.status,
        transport: "snapshot",
        updatedAt: lane.updatedAt,
        embed: {
          kind: "terminal",
          title: `Local Codex exec - ${lane.focus.label}`
        },
        terminal: {
          title: `Local Codex exec - ${lane.focus.label}`,
          format: "plain",
          stdin: "sent",
          tail: lane.terminalTail
        },
        ...(lane.completion ? { completion: lane.completion } : {}),
        artifacts
      };
    }),
    events: args.events,
    redaction: {
      status: "passed",
      notes: "Actor output was redacted before transcript and bundle persistence; raw prompt is omitted from event log."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review: args.review,
    feedbackCandidates: []
  };
}

async function runLocalCodexExec(options: RunOptions & {
  actor: "codex-exec";
  cwd: string;
  projectRoot: PreparedSelectedOutputDirectory;
  simCount: number;
}): Promise<RunResult> {
  const warnings: string[] = [];

  const timeoutMs = normalizeActorTimeout(options.timeoutMs ?? readEnvInteger("HUMANISH_CODEX_ACTOR_TIMEOUT_MS") ?? LOCAL_CODEX_TUI_DEFAULT_TIMEOUT_MS);
  if (timeoutMs === null) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_INVALID_TIMEOUT",
        message: `--timeout-ms must be an integer between 1 and ${LOCAL_CODEX_TUI_MAX_TIMEOUT_MS}.`
      }
    };
  }
  const maxConcurrency = normalizePositiveInteger(
    readEnvInteger("HUMANISH_LOCAL_CODEX_EXEC_MAX_CONCURRENCY") ?? LOCAL_CODEX_EXEC_DEFAULT_MAX_CONCURRENCY
  );
  if (maxConcurrency === null) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_INVALID_ACTOR_CONCURRENCY",
        message: "HUMANISH_LOCAL_CODEX_EXEC_MAX_CONCURRENCY must be a positive integer."
      }
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId = options.runId ?? `codex-exec-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const packageName = await readPackageName(options.projectRoot);
  const humanishSource = await implicitProjectDirectoryExists(options.projectRoot, "humanish") ? "present" : "missing";
  const source = await buildRunSource({ cwd: options.cwd, capturedAt: createdAt, humanishSource, packageName });
  const selection = await loadDryRunSelection(options.projectRoot, humanishSource);
  await assertPreparedSelectedOutputDirectory(options.projectRoot);
  const runPaths = await prepareRunArtifactPaths(options.cwd, runId);
  // Identity + liveness on disk (#455): uniform across every route, so a reader classifies any
  // run from one small file instead of parsing bundles.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: options.dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab })
  });
  const artifactRoot = runPaths.relativeRunRoot;
  if (humanishSource === "missing") {
    warnings.push("Committed humanish/ source was not found; using built-in synthetic local actor defaults.");
  }
  warnings.push(...selection.warnings);
  const verdictNonce = randomUUID().slice(0, 12);
  const events: RunEvent[] = [];
  const pushEvent = (
    type: string,
    message: string,
    level: RunEvent["level"] = "info",
    simId?: string,
    streamId?: string
  ): void => {
    events.push({
      id: `event-${String(events.length + 1).padStart(3, "0")}`,
      at: new Date().toISOString(),
      level,
      type,
      message,
      ...(simId === undefined ? {} : { simId }),
      ...(streamId === undefined ? {} : { streamId })
    });
  };

  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId,
      path: artifactRoot,
      updatedAt: createdAt
    } satisfies RunPointer, null, 2)}\n`,
    "utf8"
  );

  interface ExecLaneResult {
    actor: LocalActorCommandResult;
    command: LocalActorCommand;
    focus: LocalCodexExecFocus;
    promptDigest: string;
    redactedTranscript: string;
    simId: string;
    streamId: string;
    tail: string;
    tracePath: string;
    transcriptPath: string;
  }

  const lanes = Array.from({ length: options.simCount }, (_, index) => {
    const focus = localCodexExecFocus(index);
    const simId = `sim-${String(index + 1).padStart(2, "0")}`;
    const streamId = `${simId}-codex-exec`;
    const prompt = buildLocalCodexExecPrompt(selection, verdictNonce, {
      focus,
      index: index + 1,
      total: options.simCount
    });
    const promptDigest = digestText(prompt);
    const command = resolveLocalCodexExecCommand(options.cwd, prompt, options.actorCommand);
    pushEvent(
      "actor.spawned",
      `Spawned local Codex exec actor lane ${index + 1}/${options.simCount} (${focus.label}) command ${command.name} in explicit opt-in mode.`,
      "info",
      simId,
      streamId
    );
    pushEvent(
      "actor.prompt.submitted",
      `Submitted bounded public-safe dogfood prompt digest ${promptDigest}; raw prompt omitted from event log.`,
      "info",
      simId,
      streamId
    );

    return { command, focus, promptDigest, simId, streamId };
  });

  for (const lane of lanes) {
    pushEvent(
      "actor.running",
      "Published local Codex exec running snapshot for Observer polling.",
      "info",
      lane.simId,
      lane.streamId
    );
  }
  await writeContainedOutputFile(runPaths, "events.ndjson", `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const baseLifecycle: RunBundle["lifecycle"] = [
    {
      at: createdAt,
      event: "run.created",
      message: `Live local Codex exec run created with ${options.simCount} explicit opt-in actor${options.simCount === 1 ? "" : "s"} and max concurrency ${maxConcurrency}.`
    },
    {
      at: createdAt,
      event: "actor.selected",
      message: "Selected local codex-exec actor."
    }
  ];
  const runningAt = new Date().toISOString();
  const runningBundle = buildLocalCodexExecBundle({
    runId,
    simCount: options.simCount,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    packageName,
    humanishSource,
    source,
    persona: selection.persona,
    scenario: selection.scenario,
    lifecycle: [
      ...baseLifecycle,
    {
      at: runningAt,
      event: "actor.running",
      message: `Local Codex exec actor lanes are running with max concurrency ${maxConcurrency}; Observer data will refresh as sanitized evidence arrives.`
    }
    ],
    lanes: lanes.map((lane): LocalCodexExecLaneBundleInput => ({
      focus: lane.focus,
      simId: lane.simId,
      streamId: lane.streamId,
      status: "running",
      progress: 35,
      currentStep: "Local Codex exec actor running",
      summary: `Local Codex exec actor ${lane.focus.label} is running.`,
      terminalTail: "Codex exec actor is running; sanitized transcript evidence will be linked after completion.",
      updatedAt: runningAt,
      completion: {
        checkedAt: runningAt,
        reason: "actor process is still running",
        status: "running"
      }
    })),
    events,
    review: createLocalActorRunningReviewSummary(options.simCount === 1 ? "Codex exec" : "Codex exec fanout")
  });
  await writeRunBundleArtifacts(runPaths, runningBundle);

  const laneResults = await mapWithConcurrency(lanes, maxConcurrency, async (lane): Promise<ExecLaneResult> => {
    const actor = await executeLocalActorCommand(lane.command, {
      cwd: options.cwd,
      timeoutMs,
      verdictNonce
    });
    const redactedTranscript = redactSensitiveText(actor.transcript);
    const tail = tailText(redactedTranscript, 6_000);
    const transcriptPath = options.simCount === 1
      ? "transcripts/codex-exec-sanitized.jsonl"
      : `transcripts/${lane.streamId}-sanitized.jsonl`;
    const tracePath = options.simCount === 1 ? "actor.json" : `actors/${lane.streamId}.json`;
    return {
      actor,
      command: lane.command,
      focus: lane.focus,
      promptDigest: lane.promptDigest,
      redactedTranscript,
      simId: lane.simId,
      streamId: lane.streamId,
      tail,
      tracePath,
      transcriptPath
    };
  });

  const completedAt = new Date().toISOString();
  await validatePreparedRunArtifactPaths(runPaths);
  for (const result of laneResults) {
    await writeContainedOutputFile(
      runPaths,
      result.transcriptPath,
      result.redactedTranscript.length > 0 ? result.redactedTranscript : "No transcript output captured.\n",
      "utf8"
    );
    await writeContainedOutputFile(runPaths, result.tracePath, `${JSON.stringify({
      schema: "humanish.local-codex-exec-actor.v1",
      actor: "codex-exec",
      commandName: result.command.name,
      focusId: result.focus.id,
      promptDigest: result.promptDigest,
      verdictNonce,
      startedAt: createdAt,
      completedAt,
      durationMs: result.actor.durationMs,
      exitCode: result.actor.exitCode,
      signal: result.actor.signal,
      status: result.actor.status,
      timeoutMs,
      transcriptBytes: result.actor.transcriptBytes,
      transcriptPath: result.transcriptPath,
      redaction: "passed"
    }, null, 2)}\n`, "utf8");
  }
  const laneStatuses = laneResults.map((result) => result.actor.status);
  const status = aggregateActorStatus(laneStatuses);
  const verdictReason = options.simCount === 1
    ? laneResults[0]?.actor.reason ?? "actor did not return a result"
    : summarizeExecFanout(laneStatuses);
  for (const result of laneResults) {
    pushEvent(
      "actor.observation",
      `Captured ${result.actor.transcriptBytes} output byte${result.actor.transcriptBytes === 1 ? "" : "s"}; sanitized transcript tail recorded with redaction=passed.`,
      "info",
      result.simId,
      result.streamId
    );
    pushEvent(
      "actor.artifact",
      "Wrote sanitized Codex exec transcript and actor trace artifacts under the ignored run directory.",
      "info",
      result.simId,
      result.streamId
    );
    pushEvent(
      "actor.verdict",
      `Local Codex exec actor lane ${result.focus.label} verdict ${result.actor.status}: ${result.actor.reason}`,
      result.actor.status === "passed" ? "info" : result.actor.status === "timed_out" ? "warn" : "error",
      result.simId,
      result.streamId
    );
    pushEvent(
      result.actor.status === "timed_out" ? "actor.timeout" : "actor.exited",
      result.actor.status === "timed_out"
        ? `Actor timed out after ${timeoutMs}ms; last safe observation retained.`
        : `Actor exited with code ${result.actor.exitCode ?? "null"}${result.actor.signal ? ` and signal ${result.actor.signal}` : ""}.`,
      result.actor.status === "passed" ? "info" : "warn",
      result.simId,
      result.streamId
    );
  }
  await writeContainedOutputFile(runPaths, "events.ndjson", `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const bundle = buildLocalCodexExecBundle({
    runId,
    simCount: options.simCount,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    packageName,
    humanishSource,
    source,
    persona: selection.persona,
    scenario: selection.scenario,
    lifecycle: [
      ...baseLifecycle,
      {
        at: completedAt,
        event: "review.skeleton.created",
        message: "Created review skeleton from sanitized actor lifecycle evidence."
      }
    ],
    lanes: laneResults.map((result): LocalCodexExecLaneBundleInput => ({
      focus: result.focus,
      simId: result.simId,
      streamId: result.streamId,
      status: result.actor.status,
      progress: 100,
      currentStep: result.actor.status === "passed" ? "Local Codex exec actor completed" : "Local Codex exec actor needs review",
      summary: `Local Codex exec actor ${result.focus.label} ${result.actor.status}: ${result.actor.reason}`,
      terminalTail: result.tail,
      updatedAt: completedAt,
      transcriptPath: result.transcriptPath,
      tracePath: result.tracePath,
      completion: {
        checkedAt: completedAt,
        ...(result.actor.exitCode === undefined ? {} : { exitCode: result.actor.exitCode }),
        logTail: result.tail,
        reason: result.actor.reason,
        status: result.actor.status
      }
    })),
    events,
    review: createLocalActorReviewSummary(options.simCount === 1 ? "Codex exec" : "Codex exec fanout", status, verdictReason)
  });

  await writeRunBundleArtifacts(runPaths, bundle, runStatus);
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId,
      path: artifactRoot,
      updatedAt: completedAt
    } satisfies RunPointer, null, 2)}\n`,
    "utf8"
  );

  return {
    schema: "humanish.run-result.v1",
    ok: status === "passed",
    runId,
    mode: "live",
    simCount: options.simCount,
    cwd: options.cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: runPaths.relativeLatestPointer,
    warnings,
    ...(status === "passed"
      ? {}
      : {
          error: {
            code: "HUMANISH_LOCAL_CODEX_EXEC_FAILED" as const,
            message: `Local Codex exec actor ${status}: ${verdictReason}`
          }
        })
  };
}

interface LocalCodexAppServerLane {
  focus: LocalCodexExecFocus;
  prefix: string;
  prompt: string;
  promptDigest: string;
  simId: string;
  streamId: string;
}

interface LocalCodexAppServerLaneBundleInput {
  completion?: RunStreamCompletion;
  currentStep: string;
  focus: LocalCodexExecFocus;
  progress: number;
  result?: CodexAppServerRunResult;
  simId: string;
  status: RunSimulationStatus;
  streamId: string;
  summary: string;
  terminalTail: string;
  updatedAt: string;
}

function buildLocalCodexAppServerBundle(args: {
  artifactRoot: string;
  createdAt: string;
  cwd: string;
  events: RunEvent[];
  lanes: LocalCodexAppServerLaneBundleInput[];
  lifecycle: RunBundle["lifecycle"];
  humanishSource: RunBundle["source"]["humanishSource"];
  packageName: string | null;
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  review: ReviewSummary;
  runId: string;
  scenario: RunBundle["scenario"];
  simCount: number;
  source: RunBundle["source"];
}): RunBundle {
  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: "live",
    simCount: args.simCount,
    createdAt: args.createdAt,
    cwd: args.cwd,
    artifactRoot: args.artifactRoot,
    source: args.source,
    persona: args.persona,
    scenario: args.scenario,
    lifecycle: args.lifecycle,
    simulations: args.lanes.map((lane, index): RunSimulation => ({
      id: lane.simId,
      index: index + 1,
      personaId: `codex-app-server-${lane.focus.id}`,
      scenarioId: args.scenario.id,
      status: lane.status,
      streamKind: "codex-ui",
      mode: "codex-app-sim",
      progress: lane.progress,
      currentStep: lane.currentStep,
      summary: lane.summary,
      streamIds: [lane.streamId],
      startedAt: args.createdAt,
      updatedAt: lane.updatedAt
    })),
    streams: args.lanes.map((lane): RunStream => {
      const result = lane.result;
      // Provider-neutral projection of the actor evidence, with the persona's
      // applied traits threaded in. Only present once the lane has a result.
      const actor: ActorTrace | undefined = result
        ? getActor("codex-app-server").toActorTrace(result, {
            id: args.persona.id,
            traitsApplied: personaToDirectives(args.resolvedPersona).traitsApplied,
            promptDigest: result.trace.promptDigest
          })
        : undefined;
      const artifacts: RunStream["artifacts"] = [
        { label: "run bundle", path: "run.json", kind: "bundle" },
        { label: "review", path: "review.md", kind: "review" },
        { label: "event log", path: "events.ndjson", kind: "events" },
        ...(result ? [
          { label: "codex app-server trace", path: result.tracePath, kind: "trace" as const },
          { label: "codex app-server events", path: result.eventsPath, kind: "events" as const },
          { label: "codex app-server transcript", path: result.transcriptPath, kind: "log" as const }
        ] : [])
      ];

      return {
        id: lane.streamId,
        simId: lane.simId,
        kind: "codex-ui",
        label: `Codex app-server - ${lane.focus.label}`,
        status: lane.status,
        transport: "app-server",
        updatedAt: lane.updatedAt,
        embed: {
          kind: "placeholder",
          title: `Codex app-server - ${lane.focus.label}`
        },
        terminal: {
          title: `Codex app-server - ${lane.focus.label}`,
          format: "plain",
          stdin: "sent",
          tail: lane.terminalTail
        },
        codex: {
          provider: "codex-app-server",
          contract: "Humanish captures Codex app-server Thread, Turn, Item, approval, command, file, tool, message, and reasoning evidence as redacted local artifacts.",
          state: codexStateForStream(lane.status),
          ...(result?.experimentalApi === undefined ? {} : { experimentalApi: result.experimentalApi }),
          ...(result?.counts === undefined ? {} : { eventCount: result.counts.envelopes }),
          ...(result?.model === undefined ? {} : { model: result.model }),
          ...(result?.sessionId === undefined ? {} : { sessionId: result.sessionId }),
          ...(result?.threadId === undefined ? {} : { threadId: result.threadId }),
          ...(result?.trace === undefined ? {} : { trace: result.trace }),
          ...(result?.tracePath === undefined ? {} : { tracePath: result.tracePath }),
          ...(result?.turnId === undefined ? {} : { turnId: result.turnId })
        },
        ...(actor === undefined ? {} : { actor }),
        ...(lane.completion ? { completion: lane.completion } : {}),
        artifacts
      };
    }),
    events: args.events,
    redaction: {
      status: "passed",
      notes: "Codex app-server envelopes and transcript summaries were redacted before persistence; raw prompts and secret-bearing fields are not stored in run events."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review: args.review,
    feedbackCandidates: []
  };
}

async function runLocalCodexAppServer(options: RunOptions & {
  actor: "codex-app-server";
  cwd: string;
  projectRoot: PreparedSelectedOutputDirectory;
  simCount: number;
}): Promise<RunResult> {
  const warnings: string[] = [];
  const timeoutMs = normalizeActorTimeout(options.timeoutMs ?? readEnvInteger("HUMANISH_CODEX_ACTOR_TIMEOUT_MS") ?? LOCAL_CODEX_TUI_DEFAULT_TIMEOUT_MS);
  if (timeoutMs === null) {
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: options.cwd,
      warnings,
      error: {
        code: "HUMANISH_INVALID_TIMEOUT",
        message: `--timeout-ms must be an integer between 1 and ${LOCAL_CODEX_TUI_MAX_TIMEOUT_MS}.`
      }
    };
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const runId = options.runId ?? `codex-app-server-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const packageName = await readPackageName(options.projectRoot);
  const humanishSource = await implicitProjectDirectoryExists(options.projectRoot, "humanish") ? "present" : "missing";
  const source = await buildRunSource({ cwd: options.cwd, capturedAt: createdAt, humanishSource, packageName });
  const selection = await loadDryRunSelection(options.projectRoot, humanishSource);
  await assertPreparedSelectedOutputDirectory(options.projectRoot);
  const runPaths = await prepareRunArtifactPaths(options.cwd, runId);
  // Identity + liveness on disk (#455): uniform across every route, so a reader classifies any
  // run from one small file instead of parsing bundles.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: options.dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab })
  });
  const artifactRoot = runPaths.relativeRunRoot;
  if (humanishSource === "missing") {
    warnings.push("Committed humanish/ source was not found; using built-in synthetic Codex app-server actor defaults.");
  }
  warnings.push(...selection.warnings);

  const events: RunEvent[] = [];
  const pushEvent = (
    type: string,
    message: string,
    level: RunEvent["level"] = "info",
    simId?: string,
    streamId?: string
  ): void => {
    events.push({
      id: `event-${String(events.length + 1).padStart(3, "0")}`,
      at: new Date().toISOString(),
      level,
      type,
      message,
      ...(simId === undefined ? {} : { simId }),
      ...(streamId === undefined ? {} : { streamId })
    });
  };

  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId,
      path: artifactRoot,
      updatedAt: createdAt
    } satisfies RunPointer, null, 2)}\n`,
    "utf8"
  );

  const lanes: LocalCodexAppServerLane[] = Array.from({ length: options.simCount }, (_, index) => {
    const focus = localCodexExecFocus(index);
    const simId = `sim-${String(index + 1).padStart(2, "0")}`;
    const streamId = `${simId}-codex-app-server`;
    const prompt = buildLocalCodexAppServerPrompt(selection, {
      focus,
      index: index + 1,
      total: options.simCount
    });
    const promptDigest = digestText(prompt);
    pushEvent(
      "codex-app-server.spawned",
      `Spawned Codex app-server lane ${index + 1}/${options.simCount} (${focus.label}) in explicit opt-in mode.`,
      "info",
      simId,
      streamId
    );
    pushEvent(
      "codex-app-server.prompt.submitted",
      `Submitted bounded public-safe app-server prompt digest ${promptDigest}; raw prompt omitted from event log.`,
      "info",
      simId,
      streamId
    );
    return {
      focus,
      prefix: options.simCount === 1 ? "" : `actors/${streamId}/`,
      prompt,
      promptDigest,
      simId,
      streamId
    };
  });

  for (const lane of lanes) {
    pushEvent(
      "codex-app-server.running",
      "Published Codex app-server running snapshot for Observer polling.",
      "info",
      lane.simId,
      lane.streamId
    );
  }
  await writeContainedOutputFile(runPaths, "events.ndjson", `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const baseLifecycle: RunBundle["lifecycle"] = [
    {
      at: createdAt,
      event: "run.created",
      message: `Live Codex app-server run created with ${options.simCount} explicit opt-in lane${options.simCount === 1 ? "" : "s"}.`
    },
    {
      at: createdAt,
      event: "actor.selected",
      message: "Selected local codex-app-server actor."
    }
  ];
  const runningAt = new Date().toISOString();
  const runningBundle = buildLocalCodexAppServerBundle({
    runId,
    simCount: options.simCount,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    packageName,
    humanishSource,
    source,
    persona: selection.persona,
    resolvedPersona: selection.resolvedPersona,
    scenario: selection.scenario,
    lifecycle: [
      ...baseLifecycle,
      {
        at: runningAt,
        event: "codex-app-server.running",
        message: "Codex app-server lanes are running; Observer data will refresh as redacted app-server evidence arrives."
      }
    ],
    lanes: lanes.map((lane): LocalCodexAppServerLaneBundleInput => ({
      focus: lane.focus,
      simId: lane.simId,
      streamId: lane.streamId,
      status: "running",
      progress: 35,
      currentStep: "Codex app-server actor running",
      summary: `Codex app-server actor ${lane.focus.label} is running.`,
      terminalTail: "Codex app-server actor is running; redacted Thread/Turn/Item trace evidence will be linked after completion.",
      updatedAt: runningAt,
      completion: {
        checkedAt: runningAt,
        reason: "Codex app-server turn is still running",
        status: "running"
      }
    })),
    events,
    review: createLocalActorRunningReviewSummary("Codex app-server")
  });
  await writeRunBundleArtifacts(runPaths, runningBundle);

  const laneResults = await mapWithConcurrency(lanes, options.simCount, async (lane) => {
    const laneRunRoot = lane.prefix
      ? await prepareContainedOutputDirectoryRoot(runPaths, lane.prefix)
      : runPaths;
    const sessionOptions: import("./codex-app-server.js").CodexAppServerRunOptions = {
      cwd: options.cwd,
      prompt: lane.prompt,
      runRoot: "physicalRunRoot" in laneRunRoot ? laneRunRoot.physicalRunRoot : laneRunRoot.physicalPath,
      timeoutMs,
      ...(options.actorCommand === undefined ? {} : { actorCommand: options.actorCommand }),
      approvalPolicy: "never",
      experimentalApi: process.env.HUMANISH_CODEX_APP_SERVER_EXPERIMENTAL === "1",
      ...(process.env.HUMANISH_CODEX_APP_SERVER_MODEL ? { model: process.env.HUMANISH_CODEX_APP_SERVER_MODEL } : {}),
      sandbox: readCodexAppServerSandboxFromEnv(),
      serviceName: "humanish"
    };
    const result = await runCodexAppServerSessionInPreparedRoot(sessionOptions, laneRunRoot);
    return {
      lane,
      result: prefixCodexAppServerResultPaths(result, lane.prefix)
    };
  });

  await validatePreparedRunArtifactPaths(runPaths);
  const completedAt = new Date().toISOString();
  const statuses = laneResults.map((entry) => entry.result.status);
  const status = aggregateActorStatus(statuses);
  const verdictReason = options.simCount === 1
    ? laneResults[0]?.result.reason ?? "Codex app-server actor did not return a result"
    : summarizeExecFanout(statuses);
  for (const entry of laneResults) {
    pushEvent(
      "codex-app-server.artifact",
      `Captured ${entry.result.counts.envelopes} app-server envelope${entry.result.counts.envelopes === 1 ? "" : "s"}; trace summary and transcript were redacted before persistence.`,
      "info",
      entry.lane.simId,
      entry.lane.streamId
    );
    pushEvent(
      "codex-app-server.verdict",
      `Codex app-server actor lane ${entry.lane.focus.label} verdict ${entry.result.status}: ${entry.result.reason}`,
      entry.result.status === "passed" ? "info" : entry.result.status === "timed_out" ? "warn" : "error",
      entry.lane.simId,
      entry.lane.streamId
    );
  }
  await writeContainedOutputFile(runPaths, "events.ndjson", `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const bundle = buildLocalCodexAppServerBundle({
    runId,
    simCount: options.simCount,
    createdAt,
    cwd: options.cwd,
    artifactRoot,
    packageName,
    humanishSource,
    source,
    persona: selection.persona,
    resolvedPersona: selection.resolvedPersona,
    scenario: selection.scenario,
    lifecycle: [
      ...baseLifecycle,
      {
        at: completedAt,
        event: "review.skeleton.created",
        message: "Created review skeleton from redacted Codex app-server lifecycle evidence."
      }
    ],
    lanes: laneResults.map((entry): LocalCodexAppServerLaneBundleInput => ({
      focus: entry.lane.focus,
      simId: entry.lane.simId,
      streamId: entry.lane.streamId,
      status: entry.result.status,
      progress: 100,
      currentStep: entry.result.status === "passed" ? "Codex app-server actor completed" : "Codex app-server actor needs review",
      summary: `Codex app-server actor ${entry.lane.focus.label} ${entry.result.status}: ${entry.result.reason}`,
      terminalTail: entry.result.tail,
      updatedAt: completedAt,
      result: entry.result,
      completion: {
        checkedAt: completedAt,
        ...(entry.result.exitCode === undefined ? {} : { exitCode: entry.result.exitCode }),
        logTail: entry.result.tail,
        reason: entry.result.reason,
        status: entry.result.status
      }
    })),
    events,
    review: createLocalActorReviewSummary(options.simCount === 1 ? "Codex app-server" : "Codex app-server fanout", status, verdictReason)
  });

  await writeRunBundleArtifacts(runPaths, bundle, runStatus);
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId,
      path: artifactRoot,
      updatedAt: completedAt
    } satisfies RunPointer, null, 2)}\n`,
    "utf8"
  );

  return {
    schema: "humanish.run-result.v1",
    ok: status === "passed",
    runId,
    mode: "live",
    simCount: options.simCount,
    cwd: options.cwd,
    artifactRoot,
    bundlePath: path.join(artifactRoot, "run.json"),
    reviewPath: path.join(artifactRoot, "review.md"),
    latestPath: runPaths.relativeLatestPointer,
    warnings,
    ...(status === "passed"
      ? {}
      : {
          error: {
            code: "HUMANISH_CODEX_APP_SERVER_FAILED" as const,
            message: `Codex app-server actor ${status}: ${verdictReason}`
          }
        })
  };
}

function buildSyntheticObserverFixtures(args: {
  createdAt: string;
  personaId: string;
  scenarioId: string;
  simCount: number;
}): {
  events: RunEvent[];
  simulations: RunSimulation[];
  streams: RunStream[];
} {
  const templates = [
    {
      kind: "ui" as const,
      mode: "browser-sim" as const,
      label: "UI journey",
      currentStep: "Route and viewport contract captured",
      summary: "Browser lane reserved for VNC playback, screenshots, route state, and interaction trace.",
      tail: "open target app\nresolve first-run route\ncapture viewport state\nrecord interaction trace",
      viewport: { width: 1440, height: 960, deviceScaleFactor: 1 }
    },
    {
      kind: "terminal" as const,
      mode: "cli-sim" as const,
      label: "CLI actor",
      currentStep: "Command transcript contract captured",
      summary: "CLI lane reserved for command-by-command persona runs with stdout/stderr and artifact links.",
      // Every command in a shipped sample tail must be one the CLI actually accepts. This one
      // advertised a `--scenario` flag on `run` for months. That flag has never existed, and a
      // computer-use participant hit it in the first Observer it ever saw (#516).
      // tests/shipped-command-strings.test.ts now checks this against the real command table.
      tail: "$ humanish doctor\nok target cwd\nok humanish source\n$ humanish run first-run\ncontract proof emitted",
      viewport: undefined
    },
    {
      kind: "tui" as const,
      mode: "tui-sim" as const,
      label: "TUI actor",
      currentStep: "Terminal UI frame contract captured",
      summary: "TUI lane reserved for PTY bytes, ANSI rendering, focus replay, and optional assisted attach.",
      tail: "\u001b[2mHumanish TUI frame\u001b[0m\n> persona: skeptical-power-user\n> scenario: onboarding-regression\nstatus: awaiting live PTY transport",
      viewport: undefined
    },
    {
      kind: "codex-ui" as const,
      mode: "codex-app-sim" as const,
      label: "Codex UI",
      currentStep: "App-server embed contract captured",
      summary: "Codex UI lane reserved for app-server sessions that can be watched beside terminal evidence.",
      tail: "codex-app-server session contract\nstate: not_connected\nembed: pending provider URL\nreceipts: planned",
      viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }
    }
  ];

  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [
    {
      id: "event-000",
      at: args.createdAt,
      level: "info",
      type: "observer.contract.created",
      message: "Created public-safe observer stream contract."
    }
  ];

  for (let index = 0; index < args.simCount; index += 1) {
    const template = templates[index % templates.length];
    if (!template) {
      throw new Error("Synthetic observer template missing.");
    }
    const simId = `sim-${String(index + 1).padStart(2, "0")}`;
    const streamId = `${simId}-${template.kind}`;
    const status: RunSimulationStatus = "contract_proof_only";

    simulations.push({
      id: simId,
      index: index + 1,
      personaId: args.personaId,
      scenarioId: args.scenarioId,
      status,
      streamKind: template.kind,
      mode: template.mode,
      progress: 100,
      currentStep: template.currentStep,
      summary: template.summary,
      streamIds: [streamId],
      startedAt: args.createdAt,
      updatedAt: args.createdAt
    });

    streams.push({
      id: streamId,
      simId,
      kind: template.kind,
      label: template.label,
      status,
      transport: streamTransport(template.kind),
      updatedAt: args.createdAt,
      embed: {
        kind: template.kind === "terminal" || template.kind === "tui" ? "terminal" : "placeholder",
        title: template.label
      },
      ...(template.viewport ? { viewport: template.viewport } : {}),
      terminal: {
        title: template.label,
        format: template.kind === "tui" ? "ansi" : "plain",
        stdin: "disabled",
        tail: template.tail
      },
      ...(template.kind === "ui" || template.kind === "codex-ui"
        ? {
            ui: {
              route: template.kind === "ui" ? "/first-run" : "/codex/session",
              intent: template.summary,
              state: "contract-only"
            }
          }
        : {}),
      ...(template.kind === "codex-ui"
        ? {
            codex: {
              provider: "codex-app-server" as const,
              state: "not_connected" as const,
              contract: "Observer accepts an app-server embed URL, session id, status feed, terminal receipt feed, and artifact links."
            }
          }
        : {}),
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" },
        { label: "review", path: "review.md", kind: "review" },
        { label: "event log", path: "events.ndjson", kind: "events" }
      ]
    });

    events.push(
      {
        id: `event-${String(index + 1).padStart(3, "0")}-a`,
        at: args.createdAt,
        level: "info",
        type: "sim.contract.ready",
        message: `${template.label} stream contract ready.`,
        simId,
        streamId
      },
      {
        id: `event-${String(index + 1).padStart(3, "0")}-b`,
        at: args.createdAt,
        level: "warn",
        type: "sim.live-substrate.missing",
        message: "No live actor launched in dry-run mode; observer lane is ready for real substrate evidence.",
        simId,
        streamId
      }
    );
  }

  return { events, simulations, streams };
}

function streamTransport(kind: RunStreamKind): RunStream["transport"] {
  if (kind === "tui") return "pty";
  if (kind === "codex-ui") return "app-server";
  if (kind === "ui" || kind === "browser") return "polling";
  return "snapshot";
}

interface LocalActorCommand {
  args: string[];
  command: string;
  name: string;
}

interface LocalActorCommandResult {
  durationMs: number;
  exitCode?: number;
  reason: string;
  signal?: NodeJS.Signals;
  status: LocalActorTerminalStatus;
  transcript: string;
  transcriptBytes: number;
}

type LocalActorTerminalStatus = Extract<RunSimulationStatus, "passed" | "failed" | "blocked" | "timed_out">;

interface LocalCodexExecFocus {
  id: string;
  label: string;
  instruction: string;
  suggestedCommands: [string, string];
}

type CodexTrustPreflight =
  | { ok: true }
  | {
      ok: false;
      message: string;
      recoveryCommand: string;
      trustRoot: string;
      unsafeMetadata?: true;
    };

function resolveLocalCodexTuiCommand(
  cwd: string,
  prompt: string,
  overrideCommand: string[] | undefined
): LocalActorCommand {
  const envCommand = process.env.HUMANISH_CODEX_ACTOR_COMMAND;
  const commandParts = overrideCommand && overrideCommand.length > 0
    ? overrideCommand
    : envCommand
      ? parseCommandLine(envCommand)
      : defaultLocalCodexTuiCommand(cwd, prompt);
  const [command, ...args] = commandParts;

  if (!command) {
    const [fallbackCommand, ...fallbackArgs] = defaultLocalCodexTuiCommand(cwd, prompt);
    return {
      command: fallbackCommand ?? "codex",
      args: fallbackArgs,
      name: fallbackCommand ? path.basename(fallbackCommand) : "codex"
    };
  }

  return {
    command,
    args,
    name: path.basename(command)
  };
}

function defaultLocalCodexTuiCommand(cwd: string, prompt: string): string[] {
  const codexParts = [
    "codex",
    "--no-alt-screen",
    "-C",
    cwd,
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    prompt
  ];

  if (process.platform === "linux") {
    return ["script", "-qfec", shellJoin(codexParts), "/dev/null"];
  }

  return codexParts;
}

function resolveLocalCodexExecCommand(
  cwd: string,
  prompt: string,
  overrideCommand: string[] | undefined
): LocalActorCommand {
  const envCommand = process.env.HUMANISH_CODEX_ACTOR_COMMAND;
  const commandParts = overrideCommand && overrideCommand.length > 0
    ? overrideCommand
    : envCommand
      ? parseCommandLine(envCommand)
      : defaultLocalCodexExecCommand(cwd, prompt);
  const [command, ...args] = commandParts;

  if (!command) {
    const [fallbackCommand, ...fallbackArgs] = defaultLocalCodexExecCommand(cwd, prompt);
    return {
      command: fallbackCommand ?? "codex",
      args: fallbackArgs,
      name: fallbackCommand ? path.basename(fallbackCommand) : "codex"
    };
  }

  return {
    command,
    args,
    name: path.basename(command)
  };
}

function defaultLocalCodexExecCommand(cwd: string, prompt: string): string[] {
  return [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--ephemeral",
    "-C",
    cwd,
    "--sandbox",
    "read-only",
    "--json",
    prompt
  ];
}

function executeLocalActorCommand(
  command: LocalActorCommand,
  options: {
    cwd: string;
    timeoutMs: number;
    verdictNonce: string;
  }
): Promise<LocalActorCommandResult> {
  const startedAt = Date.now();
  let transcript = "";
  let transcriptBytes = 0;
  let terminalQueryBuffer = "";
  let observedMarkerStatus: LocalActorTerminalStatus | null = null;
  let stoppingAfterMarker = false;
  let timedOut = false;
  let settled = false;
  let timer: NodeJS.Timeout;
  let markerKillTimer: NodeJS.Timeout | undefined;

  return new Promise((resolve) => {
    const finish = (result: Omit<LocalActorCommandResult, "durationMs" | "transcript" | "transcriptBytes">): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(markerKillTimer);
      const normalizedTranscript = normalizeLocalActorTranscript(transcript);
      resolve({
        ...result,
        durationMs: Date.now() - startedAt,
        transcript: redactSensitiveText(normalizedTranscript),
        transcriptBytes
      });
    };

    const child = spawn(command.command, command.args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        TERM: process.env.TERM ?? "xterm-256color",
        COLUMNS: process.env.COLUMNS ?? "120",
        LINES: process.env.LINES ?? "40",
        HUMANISH_ACTOR_VERDICT_NONCE: options.verdictNonce
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (timedOut) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }, options.timeoutMs);
    timer.unref();

    const capture = (chunk: Buffer): void => {
      transcriptBytes += chunk.byteLength;
      transcript = limitTranscript(transcript + chunk.toString("utf8"));
      terminalQueryBuffer = respondToTerminalQueries(terminalQueryBuffer, chunk, child.stdin);
      const markerStatus = observedMarkerStatus ?? extractLocalActorVerdict(
        normalizeLocalActorTranscript(transcript),
        options.verdictNonce
      );
      if (markerStatus && !observedMarkerStatus) {
        observedMarkerStatus = markerStatus;
        stoppingAfterMarker = true;
        child.kill("SIGTERM");
        markerKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2_000);
        markerKillTimer.unref();
      }
    };

    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", (error) => {
      finish({
        status: "blocked",
        reason: `actor command could not start: ${error.message}`
      });
    });
    child.once("close", (code, signal) => {
      if (timedOut || (Date.now() - startedAt >= options.timeoutMs && code === null)) {
        timedOut = false;
        finish({
          status: "timed_out",
          reason: `actor exceeded ${options.timeoutMs}ms timeout`,
          ...(signal === null ? {} : { signal })
        });
        return;
      }

      const markerStatus = observedMarkerStatus ?? extractLocalActorVerdict(
        normalizeLocalActorTranscript(transcript),
        options.verdictNonce
      );
      const processFailed = code !== 0 && !(stoppingAfterMarker && markerStatus);
      const status = processFailed
        ? markerStatus === "blocked" ? "blocked" : "failed"
        : markerStatus ?? "passed";
      finish({
        status,
        reason: processFailed
          ? markerStatus === "blocked"
            ? `actor reported blocked verdict marker and exited with code ${code ?? "null"}`
            : `actor process exited with code ${code ?? "null"}`
          : markerStatus
            ? `actor reported ${markerStatus} verdict marker`
            : "actor process exited successfully",
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal })
      });
    });
  });
}

function respondToTerminalQueries(
  currentBuffer: string,
  chunk: Buffer,
  stdin: NodeJS.WritableStream | null
): string {
  if (!stdin || !stdin.writable) {
    return "";
  }

  let buffer = `${currentBuffer}${chunk.toString("latin1")}`;

  while (true) {
    const cprIndex = buffer.indexOf("\x1b[6n");
    const oscMatch = /\x1b\](10|11|12);\?(?:\x07|\x1b\\)/.exec(buffer);
    const oscIndex = oscMatch?.index ?? -1;

    if (cprIndex === -1 && oscIndex === -1) {
      break;
    }

    if (cprIndex !== -1 && (oscIndex === -1 || cprIndex < oscIndex)) {
      stdin.write("\x1b[24;120R");
      buffer = buffer.slice(cprIndex + "\x1b[6n".length);
      continue;
    }

    const colorSlot = oscMatch?.[1] ?? "10";
    stdin.write(terminalColorResponse(colorSlot));
    buffer = buffer.slice((oscIndex === -1 ? 0 : oscIndex) + (oscMatch?.[0].length ?? 0));
  }

  return buffer.slice(-128);
}

function terminalColorResponse(slot: string): string {
  if (slot === "11") {
    return "\x1b]11;rgb:0000/0000/0000\x07";
  }

  return `\x1b]${slot};rgb:ffff/ffff/ffff\x07`;
}

/**
 * Strip ANSI/control noise from a captured terminal transcript into stable, scannable text.
 * Pure (no IO). Exported so the terminal-product lane (src/e2b-terminal-lab.ts) normalizes its
 * captured exec stream EXACTLY as the local-actor lanes do — the verdict-nonce scorer is only
 * sound against the same normalization the marker is matched on, so the logic must not diverge.
 */
export function normalizeLocalActorTranscript(transcript: string): string {
  return transcript
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[78=>]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Extract the per-run verdict from a normalized transcript: the agent must print exactly
 * `HUMANISH_ACTOR_VERDICT=<status> HUMANISH_ACTOR_NONCE=<nonce>`, and the nonce is mandatory so a
 * bare marker (echoed or replayed from untrusted text) can never forge a verdict. Pure (no IO).
 * Exported so the terminal-product lane scores its in-sandbox `codex exec` run by the SAME marker
 * — divergent verdict logic would let the two lanes disagree about what "passed" means.
 */
export function extractLocalActorVerdict(transcript: string, verdictNonce: string): LocalActorTerminalStatus | null {
  const compactTranscript = transcript.replace(/\s+/g, "");
  // The per-run nonce is mandatory: a bare HUMANISH_ACTOR_VERDICT=<status>
  // marker echoed by an actor (or replayed from untrusted text) must never
  // satisfy verdict extraction.
  const match = new RegExp(
    `HUMANISH_ACTOR_VERDICT=(passed|blocked|failed)HUMANISH_ACTOR_NONCE=${escapeRegExp(verdictNonce)}`,
    "i"
  ).exec(compactTranscript);
  if (!match) {
    return null;
  }

  return match[1]?.toLowerCase() as LocalActorTerminalStatus;
}

async function checkCodexWorkspaceTrust(cwd: string): Promise<CodexTrustPreflight> {
  if (process.env.HUMANISH_SKIP_CODEX_TRUST_PREFLIGHT === "1") {
    return { ok: true };
  }

  const detected = await detectCodexTrustRoot(cwd);
  if (!detected) {
    return { ok: true };
  }
  if (detected.unsafe) {
    return {
      ok: false,
      trustRoot: detected.worktreeRoot,
      unsafeMetadata: true,
      message: `Codex workspace trust preflight blocked local TUI launch; Git worktree metadata failed containment validation: ${detected.worktreeRoot}`,
      recoveryCommand: `codex --no-alt-screen -C ${shellQuote(detected.worktreeRoot)}`
    };
  }
  const trustRoot = detected.trustRoot;

  const configPath = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
  const configText = await readTextIfExists(configPath);

  if (configText && await codexConfigTrustsProject(configText, trustRoot)) {
    return { ok: true };
  }

  return {
    ok: false,
    trustRoot,
    message: `Codex workspace trust preflight blocked local TUI launch; trust root is not explicitly trusted as an exact Codex project root: ${trustRoot}`,
    recoveryCommand: `codex --no-alt-screen -C ${shellQuote(trustRoot)}`
  };
}

async function detectCodexTrustRoot(cwd: string): Promise<
  | { unsafe: false; trustRoot: string }
  | { unsafe: true; worktreeRoot: string }
  | null
> {
  const inspection = await inspectVerifiedGitWorkspace(cwd);
  if (inspection.status === "missing") {
    return null;
  }
  if (inspection.status === "unsafe") {
    return { unsafe: true, worktreeRoot: inspection.worktreeRoot };
  }
  return { unsafe: false, trustRoot: inspection.workspace.trustRoot };
}

async function codexConfigTrustsProject(configText: string, trustRoot: string): Promise<boolean> {
  const sectionPattern = /^\[projects\."((?:\\.|[^"\\])*)"\]\s*$/gm;
  let sectionMatch: RegExpExecArray | null;

  while ((sectionMatch = sectionPattern.exec(configText)) !== null) {
    const projectPath = unescapeTomlString(sectionMatch[1] ?? "");
    const afterSection = configText.slice(sectionMatch.index + sectionMatch[0].length);
    const nextSectionIndex = afterSection.search(/^\[/m);
    const sectionBody = nextSectionIndex === -1 ? afterSection : afterSection.slice(0, nextSectionIndex);

    if (/^trust_level\s*=\s*"trusted"\s*$/m.test(sectionBody) && await isSamePhysicalPath(projectPath, trustRoot)) {
      return true;
    }
  }

  return false;
}

function unescapeTomlString(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

async function isSamePhysicalPath(candidatePath: string, targetPath: string): Promise<boolean> {
  try {
    const [candidate, target] = await Promise.all([
      realpath(path.resolve(candidatePath)),
      realpath(path.resolve(targetPath))
    ]);
    return candidate === target;
  } catch {
    return false;
  }
}

function normalizeActorTimeout(value: number | undefined): number | null {
  if (normalizePositiveInteger(value) === null || value === undefined || value > LOCAL_CODEX_TUI_MAX_TIMEOUT_MS) {
    return null;
  }

  return value;
}

function normalizePositiveInteger(value: number | undefined): number | null {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return null;
  }

  return value;
}

function readEnvInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
}

function personaPromptLine(selection: { resolvedPersona: ResolvedPersona }): string {
  return renderPersonaPromptSection(selection.resolvedPersona);
}

function buildLocalCodexTuiPrompt(selection: {
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  scenario: RunBundle["scenario"];
}, verdictNonce: string): string {
  return [
    "You are a Humanish local Codex TUI dogfood actor.",
    personaPromptLine(selection),
    `Scenario: ${selection.scenario.title}.`,
    "Inspect this public repository's Humanish setup, run evidence, and Observer affordances.",
    "Run at most two read-only inspection commands; prefer file reads, `node dist/cli.js --help`, or `pnpm typecheck` when available.",
    "Do not run commands that write runtime artifacts or temp config, including `pnpm humanish`, `humanish watch`, `humanish feedback`, `humanish init`, tests, builds, installs, or commands that write `.humanish/`.",
    "If the strongest proof would require writes in this read-only sandbox, inspect existing artifacts instead and name the write-required proof as a follow-up.",
    "Use passed when read-only inspection confirms the committed harness and existing evidence contract; write-required follow-ups alone are not blockers.",
    "Do not print secrets, do not commit, do not push, do not open GitHub issues, and do not use private data.",
    "Finish by summarizing one public-safe harness improvement.",
    `Then print exactly one final machine-readable line in this format: HUMANISH_ACTOR_VERDICT=<status> HUMANISH_ACTOR_NONCE=${verdictNonce}.`,
    "Replace <status> with exactly one lowercase word: passed, blocked, or failed."
  ].join(" ");
}

function localCodexExecFocus(index: number): LocalCodexExecFocus {
  const focuses = [
    {
      id: "install-readability",
      label: "install/readability",
      instruction: "audit whether a new user can understand the committed Humanish dogfood setup quickly",
      suggestedCommands: [
        "test -r humanish/README.md && sed -n '1,40p' humanish/README.md",
        "test -r humanish/config.ts && wc -l humanish/config.ts"
      ]
    },
    {
      id: "public-safety-trust",
      label: "public-safety/trust",
      instruction: "check the local actor boundaries, public-safety claims, and trust-bootstrap language",
      suggestedCommands: [
        "test -r humanish/coverage-map.md && sed -n '1,80p' humanish/coverage-map.md",
        "test -r docs/architecture/local-codex-tui-actor.md && sed -n '1,80p' docs/architecture/local-codex-tui-actor.md"
      ]
    },
    {
      id: "observer-evidence",
      label: "Observer/evidence",
      instruction: "inspect whether run evidence and Observer expectations are easy to verify",
      suggestedCommands: [
        "test -r humanish/coverage-matrix.md && sed -n '1,80p' humanish/coverage-matrix.md",
        "test -r humanish/scenarios/onboarding-regression.yaml && sed -n '1,120p' humanish/scenarios/onboarding-regression.yaml"
      ]
    },
    {
      id: "verification-release",
      label: "verification/release",
      instruction: "inspect the verification and release-gate promises exposed to local dogfood actors",
      suggestedCommands: [
        "test -r package.json && node -e \"const p=require('./package.json'); console.log(p.scripts.check); console.log(p.scripts['public-surface:scan']);\"",
        "test -r humanish/README.md && sed -n '1,80p' humanish/README.md"
      ]
    }
  ] satisfies [LocalCodexExecFocus, LocalCodexExecFocus, LocalCodexExecFocus, LocalCodexExecFocus];

  return focuses[index % focuses.length] ?? focuses[0];
}

function aggregateActorStatus(statuses: LocalActorTerminalStatus[]): LocalActorTerminalStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("timed_out")) return "timed_out";
  if (statuses.includes("blocked")) return "blocked";
  return statuses.length > 0 && statuses.every((status) => status === "passed") ? "passed" : "failed";
}

function summarizeExecFanout(statuses: LocalActorTerminalStatus[]): string {
  if (statuses.length === 1) {
    return statuses[0] === "passed" ? "actor process exited successfully" : `actor lane ${statuses[0]}`;
  }

  const counts = statuses.reduce<Record<LocalActorTerminalStatus, number>>(
    (current, status) => ({ ...current, [status]: current[status] + 1 }),
    { passed: 0, failed: 0, blocked: 0, timed_out: 0 }
  );
  const summary = (Object.keys(counts) as LocalActorTerminalStatus[])
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(", ");

  return statuses.every((status) => status === "passed")
    ? `all ${statuses.length} Codex exec lanes passed`
    : `${statuses.length} Codex exec lanes completed with ${summary}`;
}

function buildLocalCodexExecPrompt(selection: {
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  scenario: RunBundle["scenario"];
}, verdictNonce: string, lane?: {
  focus: LocalCodexExecFocus;
  index: number;
  total: number;
}): string {
  const suggestedCommands: [string, string] = lane?.focus.suggestedCommands ?? [
    "test -r humanish/config.ts && wc -l humanish/config.ts",
    "test -r humanish/README.md && sed -n '1,40p' humanish/README.md"
  ];

  return [
    "You are a Humanish local Codex exec dogfood actor running noninteractively.",
    personaPromptLine(selection),
    `Scenario: ${selection.scenario.title}.`,
    ...(lane ? [`Fanout lane ${lane.index}/${lane.total}. Focus: ${lane.focus.instruction}.`] : []),
    "Run at most two read-only local inspection commands.",
    `Suggested commands: \`${suggestedCommands[0]}\` and \`${suggestedCommands[1]}\`.`,
    "Do not edit files, do not run network commands, do not commit, do not push, do not open GitHub issues, and do not print secrets.",
    "Do not inspect additional files unless one suggested command fails.",
    "Finish within three public-safe sentences.",
    `Then print exactly one final machine-readable line in this format: HUMANISH_ACTOR_VERDICT=<status> HUMANISH_ACTOR_NONCE=${verdictNonce}.`,
    "Replace <status> with exactly one lowercase word: passed, blocked, or failed."
  ].join(" ");
}

// The app-server lane intentionally carries no verdict nonce: its verdict
// comes from the structured turn/completed status on the app-server JSON-RPC
// channel (see codex-app-server.ts), never from HUMANISH_ACTOR_VERDICT marker
// extraction, so transcript text cannot set the run verdict on that lane.
function buildLocalCodexAppServerPrompt(selection: {
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  scenario: RunBundle["scenario"];
}, lane: {
  focus: LocalCodexExecFocus;
  index: number;
  total: number;
}): string {
  return [
    "You are a Humanish Codex app-server dogfood actor running through the official Codex app-server protocol.",
    personaPromptLine(selection),
    `Scenario: ${selection.scenario.title}.`,
    `Fanout lane ${lane.index}/${lane.total}. Focus: ${lane.focus.instruction}.`,
    "Work read-only unless the host explicitly configured a stronger sandbox.",
    "Inspect the current repository's Humanish setup, Observer proof contract, and public-safety posture.",
    "Use at most two lightweight local commands or file reads.",
    `Suggested commands: \`${lane.focus.suggestedCommands[0]}\` and \`${lane.focus.suggestedCommands[1]}\`.`,
    "Do not print secrets, keys, raw private transcripts, private screenshots, or private source snippets.",
    "Do not commit, push, open GitHub issues, mutate remote systems, or run provider-spend-heavy commands.",
    "End with one concise public-safe recommendation for improving Humanish as a closed-loop user-study harness."
  ].join(" ");
}

function readCodexAppServerSandboxFromEnv(): "read-only" | "workspace-write" | "danger-full-access" {
  const value = process.env.HUMANISH_CODEX_APP_SERVER_SANDBOX;
  if (value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return "read-only";
}

function codexStateForStream(status: RunSimulationStatus): NonNullable<RunStream["codex"]>["state"] {
  if (status === "running" || status === "preparing" || status === "queued") {
    return "running";
  }
  if (status === "passed" || status === "complete") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "timed_out") {
    return "timed_out";
  }
  if (status === "blocked") {
    return "blocked";
  }
  return "watching";
}

function prefixCodexAppServerResultPaths(result: CodexAppServerRunResult, prefix: string): CodexAppServerRunResult {
  if (!prefix) {
    return result;
  }

  return {
    ...result,
    eventsPath: `${prefix}${result.eventsPath}`,
    tracePath: `${prefix}${result.tracePath}`,
    transcriptPath: `${prefix}${result.transcriptPath}`
  };
}

function parseCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current !== "") {
    tokens.push(current);
  }

  return quote ? [] : tokens;
}

function shellJoin(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function limitTranscript(value: string): string {
  if (value.length <= LOCAL_ACTOR_TRANSCRIPT_MAX_CHARS) {
    return value;
  }

  return `[...sanitized transcript truncated to last ${LOCAL_ACTOR_TRANSCRIPT_MAX_CHARS} characters...]\n${value.slice(-LOCAL_ACTOR_TRANSCRIPT_MAX_CHARS)}`;
}

function normalizeSimCount(value: number | undefined): number | null {
  if (value === undefined) {
    return 1;
  }

  if (!Number.isSafeInteger(value) || value < 1) {
    return null;
  }

  return value;
}

export async function verifyRun(cwdInput: string, runInput: string): Promise<VerifyResult> {
  const cwd = path.resolve(cwdInput);
  let runPaths: PreparedRunArtifactPaths | null;
  try {
    runPaths = await resolveRunPath(cwd, runInput);
  } catch {
    return invalidRunStorageVerifyResult(cwd, runInput);
  }
  return verifyPreparedRun(cwd, runInput, runPaths);
}

function invalidRunStorageVerifyResult(cwd: string, runInput: string): VerifyResult {
  return {
    schema: VERIFY_SCHEMA,
    ok: false,
    cwd,
    run: runInput,
    checks: [{
      name: "run storage containment",
      ok: false,
      message: "run storage must contain only identity-bound directories and single-link regular files"
    }],
    shareSafety: {
      status: "blocked",
      reasons: [{ code: "VERIFY_FAILED", message: "Run storage failed containment validation." }]
    },
    warnings: [],
    error: {
      code: "HUMANISH_INVALID_RUN_BUNDLE",
      message: "Run storage failed containment validation."
    }
  };
}

async function verifyPreparedRun(
  cwd: string,
  runInput: string,
  runPaths: PreparedRunArtifactPaths | null
): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];

  if (!runPaths) {
    return {
      schema: VERIFY_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      checks,
      shareSafety: {
        status: "blocked",
        reasons: [
          {
            code: "VERIFY_FAILED",
            message: `Run not found: ${runInput}`
          }
        ]
      },
      warnings: [],
      error: {
        code: "HUMANISH_RUN_NOT_FOUND",
        message: `Run not found: ${runInput}`
      }
    };
  }

  const bundlePath = path.join(runPaths.absoluteRunRoot, "run.json");
  const bundle = await readRunJsonIfExists(runPaths, "run.json");
  const cleanupJson = await readRunJsonIfExists(runPaths, "cleanup.json");
  const reviewJson = await readRunJsonIfExists(runPaths, "review.json");
  const reviewMarkdown = await readRunTextIfExists(runPaths, "review.md");

  checks.push({
    name: "run.json exists",
    ok: bundle !== null,
    message: bundle === null ? "run.json missing" : "run.json present"
  });
  checks.push({
    name: "run schema",
    ok: isRecord(bundle) && bundle.schema === RUN_BUNDLE_SCHEMA,
    message: "run bundle schema is humanish.run-bundle.v1"
  });
  checks.push({
    name: "run bundle shape",
    ok: isRunBundle(bundle),
    message: "run bundle must include source, persona, scenario, lifecycle, simulations, streams, events, artifacts, review, and feedback candidates"
  });
  checks.push({
    name: "redaction passed",
    ok: isRecord(bundle) && isRecord(bundle.redaction) && bundle.redaction.status === "passed",
    message: "redaction status must be passed"
  });
  checks.push({
    name: "review artifacts exist",
    ok: reviewJson !== null && reviewMarkdown !== null,
    message: "review.json and review.md must exist"
  });
  const publicSafetyFindings = await scanRunPublicSafetyArtifacts(runPaths);
  checks.push({
    name: "public-safety scan",
    ok: publicSafetyFindings.length === 0,
    message: publicSafetyFindings.length === 0
      ? "run text artifacts and public-proof paths must not match known secret or browser-profile patterns"
      : `public-safety findings: ${publicSafetyFindings.slice(0, 5).join(", ")}`
  });
  const missingEvidenceArtifacts = isRunBundle(bundle)
    ? await missingLocalEvidenceArtifacts(runPaths, bundle)
    : [];
  const invalidEvidenceReferences = isRunBundle(bundle)
    ? invalidRunEvidenceReferences(bundle)
    : [];
  checks.push({
    name: "local evidence artifacts exist",
    ok: missingEvidenceArtifacts.length === 0 && invalidEvidenceReferences.length === 0,
    message: missingEvidenceArtifacts.length === 0 && invalidEvidenceReferences.length === 0
      ? "referenced local screenshot/trace/log/filesystem artifacts are present"
      : invalidEvidenceReferences.length > 0
      ? `invalid evidence artifact references: ${invalidEvidenceReferences.join(", ")}`
      : `missing local evidence artifacts: ${missingEvidenceArtifacts.join(", ")}`
  });
  const terminalProductFindings = isRunBundle(bundle)
    ? await validateTerminalProductEvidence(runPaths, bundle)
    : [];
  checks.push({
    name: "terminal-product evidence",
    ok: terminalProductFindings.length === 0,
    message: terminalProductFindings.length === 0
      ? "live terminal-product streams either are absent or carry the substrate/cleanup/interventions/cost ledgers + a ledger-derived no-spend proof + redacted terminal evidence, with proven teardown and known spend within the declared cap"
      : `terminal-product findings: ${terminalProductFindings.join(", ")}`
  });
  const codexAppServerFindings = isRunBundle(bundle)
    ? await validateCodexAppServerEvidence(runPaths, bundle)
    : [];
  checks.push({
    name: "codex app-server evidence",
    ok: codexAppServerFindings.length === 0,
    message: codexAppServerFindings.length === 0
      ? "live Codex app-server streams either are absent or include valid redacted trace evidence"
      : `codex app-server findings: ${codexAppServerFindings.join(", ")}`
  });
  const noEngagementFindings = isRunBundle(bundle) ? noEngagementActorFindings(bundle) : [];
  checks.push({
    name: "actor engagement",
    ok: noEngagementFindings.length === 0,
    message: noEngagementFindings.length === 0
      ? "live actor traces that claim goal_satisfied carry at least one action or message"
      : `no-engagement findings: ${noEngagementFindings.join(", ")} — a hollow run is not credible evidence`
  });
  const actorVerdictFindings = isRunBundle(bundle) ? actorVerdictConsistencyFindings(bundle) : [];
  checks.push({
    name: "actor verdict consistency",
    ok: actorVerdictFindings.length === 0,
    message: actorVerdictFindings.length === 0
      ? "live pass verdicts do not hide failed, blocked, or timed-out actor traces"
      : `actor verdict findings: ${actorVerdictFindings.join(", ")}`
  });
  const stateFindings = isRunBundle(bundle) ? subjectStateFindings(bundle) : [];
  checks.push({
    name: "subject state provenance",
    ok: stateFindings.length === 0,
    message: stateFindings.length === 0
      ? "subject state claims match the recorded seed/external evidence (or the subject block is honestly absent)"
      : `subject state findings: ${stateFindings.join(", ")}`
  });
  const sharedWorldFindings = isRunBundle(bundle) ? sharedWorldEvidenceFindings(bundle) : [];
  checks.push({
    name: "shared-world evidence",
    ok: sharedWorldFindings.length === 0,
    message: sharedWorldFindings.length === 0
      ? "live shared-world runs either are absent or carry a well-formed alternating timeline (cp-baseline → turn → cp), single-plane provenance, digest-only checkpoints, the mandatory attributionLimits, and a checkpoint delta on a passed run"
      : `shared-world findings: ${sharedWorldFindings.join(", ")}`
  });
  checks.push({
    name: "cleanup receipt",
    ok: cleanupJson === null || (isCleanupResult(cleanupJson) && cleanupJson.ok),
    message: cleanupJson === null
      ? "cleanup receipt not present; cleanup was not requested"
      : isCleanupResult(cleanupJson) && cleanupJson.ok
        ? "cleanup receipt is present and successful"
        : "cleanup receipt is present but malformed or failed"
  });
  const rerunFindings = isRunBundle(bundle) ? rerunLineageFindings(bundle) : [];
  checks.push({
    name: "rerun lineage",
    ok: rerunFindings.length === 0,
    message: rerunFindings.length === 0
      ? "rerun bundles either are absent or link selected lanes to prior lane status and a fan-out rerun event"
      : `rerun lineage findings: ${rerunFindings.join(", ")}`
  });
  // Cost is ADVISORY on magnitude, FAIL-CLOSED on labeling/provenance (claims match mechanism).
  // Absence PASSES (fail-open on display); a claimed dollar figure without its ratesAsOf date +
  // source, or a total that does not match its known lines, FAILS. Magnitude is never inspected —
  // a correctly-labeled huge estimate still passes.
  const costFindings = isRunBundle(bundle) ? costLabelingFindings(bundle) : [];
  checks.push({
    name: "cost estimate labeling",
    ok: costFindings.length === 0,
    message: costFindings.length === 0
      ? "cost figures are absent, or every claimed estimate carries its ratesAsOf date + source and the total matches its known lines (estimates never presented as exact)"
      : `cost labeling findings: ${costFindings.join(", ")}`
  });

  const ok = checks.every((check) => check.ok);
  const warnings = isRunBundle(bundle)
    ? [...rawScreenshotPostureWarnings(bundle), ...undeclaredSubjectStateWarnings(bundle), ...desktopGeometryWarnings(bundle)]
    : [];
  const shareSafety = isRunBundle(bundle)
    ? buildShareSafety({ ok, bundle, publicSafetyFindings })
    : {
        status: "blocked" as const,
        reasons: [
          {
            code: "VERIFY_FAILED" as const,
            message: "Run bundle failed verification."
          }
        ]
      };

  return {
    schema: VERIFY_SCHEMA,
    ok,
    cwd,
    run: runInput,
    bundlePath: path.relative(cwd, bundlePath),
    checks,
    shareSafety,
    warnings,
    ...(ok
      ? {}
      : {
          error: {
            code: "HUMANISH_INVALID_RUN_BUNDLE" as const,
            message: "Run bundle failed verification."
          }
        })
  };
}

export async function cleanupRun(cwdInput: string, runInput: string, hooks: RunCleanupHooks = {}): Promise<CleanupResult> {
  const cwd = path.resolve(cwdInput);
  const checkedAt = (hooks.now ?? (() => new Date()))().toISOString();
  let resolved: PreparedRunArtifactPaths | null;
  try {
    resolved = await resolveRunPath(cwd, runInput);
  } catch {
    return {
      schema: CLEANUP_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      checkedAt,
      summary: { resources: 0, killed: 0, alreadyClean: 0, failed: 0, skipped: 0 },
      resources: [],
      adapterResults: [],
      warnings: [],
      error: {
        code: "HUMANISH_INVALID_RUN_BUNDLE",
        message: "Run storage failed containment validation."
      }
    };
  }

  if (!resolved) {
    return {
      schema: CLEANUP_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      checkedAt,
      summary: { resources: 0, killed: 0, alreadyClean: 0, failed: 0, skipped: 0 },
      resources: [],
      adapterResults: [],
      warnings: [],
      error: {
        code: "HUMANISH_RUN_NOT_FOUND",
        message: `Run not found: ${runInput}`
      }
    };
  }

  const runPaths = resolved;
  const bundlePath = path.join(runPaths.absoluteRunRoot, "run.json");
  const cleanupPath = path.join(runPaths.absoluteRunRoot, "cleanup.json");
  await prepareContainedOutputFile(runPaths, "cleanup.json");
  const bundleBytes = await readContainedRegularFile(runPaths, "run.json");
  let bundle: unknown = null;
  if (bundleBytes) {
    try {
      bundle = JSON.parse(bundleBytes.toString("utf8")) as unknown;
    } catch {
      bundle = null;
    }
  }

  if (!isRunBundle(bundle)) {
    return {
      schema: CLEANUP_SCHEMA,
      ok: false,
      cwd,
      run: runInput,
      bundlePath: path.relative(cwd, bundlePath),
      checkedAt,
      summary: { resources: 0, killed: 0, alreadyClean: 0, failed: 0, skipped: 0 },
      resources: [],
      adapterResults: [],
      warnings: [],
      error: {
        code: "HUMANISH_INVALID_RUN_BUNDLE",
        message: "Run bundle failed cleanup shape validation."
      }
    };
  }

  const resources: CleanupResourceResult[] = [];
  const warnings: string[] = [];
  const providerResources = bundle.providerResources ?? [];

  for (const resource of providerResources) {
    if (resource.provider !== "e2b-desktop" || resource.kind !== "sandbox") {
      resources.push({
        provider: resource.provider,
        kind: resource.kind,
        id: resource.id,
        status: "skipped",
        message: "cleanup only supports e2b-desktop sandbox resources"
      });
      continue;
    }

    if (resource.status === "killed" || resource.cleanup?.killed === true) {
      resources.push({
        provider: resource.provider,
        kind: resource.kind,
        id: resource.id,
        status: "already_clean",
        message: "resource was already recorded as killed"
      });
      continue;
    }

    resources.push({
      provider: resource.provider,
      kind: resource.kind,
      id: resource.id,
      status: "failed",
      message: "automatic provider cleanup requires a verified resource lease"
    });
  }

  let adapterResults: CleanupAdapterResult[] = [];
  if (hooks.cleanupAdapterResources) {
    try {
      adapterResults = await hooks.cleanupAdapterResources({
        cwd,
        runDir: runPaths.physicalRunRoot,
        bundle
      });
    } catch (error) {
      adapterResults = [{
        id: "adapter-cleanup",
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }];
    }
    await validatePreparedRunArtifactPaths(runPaths);
  }

  if (providerResources.length === 0 && adapterResults.length === 0) {
    warnings.push("Run bundle recorded no provider resource evidence; nothing to inspect.");
  }

  const summary = {
    resources: resources.length,
    killed: resources.filter((resource) => resource.status === "killed").length,
    alreadyClean: resources.filter((resource) => resource.status === "already_clean").length,
    failed: resources.filter((resource) => resource.status === "failed").length + adapterResults.filter((result) => !result.ok).length,
    skipped: resources.filter((resource) => resource.status === "skipped").length
  };
  const ok = summary.failed === 0;
  const result: CleanupResult = {
    schema: CLEANUP_SCHEMA,
    ok,
    cwd: PUBLIC_TARGET_CWD,
    run: runInput,
    runId: bundle.runId,
    bundlePath: path.relative(cwd, bundlePath),
    cleanupPath: path.relative(cwd, cleanupPath),
    checkedAt,
    summary,
    resources,
    adapterResults,
    warnings
  };
  await validatePreparedRunArtifactPaths(runPaths);
  await writeContainedOutputFile(runPaths, "cleanup.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

export async function loadRunBundle(
  cwdInput: string,
  runInput: string
): Promise<{ bundle: RunBundle; bundlePath: string; runDir: string } | null> {
  const cwd = path.resolve(cwdInput);
  const runPaths = await resolveRunPath(cwd, runInput).catch(() => null);

  if (!runPaths) {
    return null;
  }

  return loadRunBundlePrepared(cwd, runPaths);
}

/** Internal continuity seam for callers that already bound one run identity. */
export async function loadRunBundlePrepared(
  cwdInput: string,
  runPaths: PreparedRunArtifactPaths
): Promise<{ bundle: RunBundle; bundlePath: string; runDir: string } | null> {
  const cwd = path.resolve(cwdInput);
  await validatePreparedRunArtifactPaths(runPaths);
  const bundlePath = path.join(runPaths.absoluteRunRoot, "run.json");
  const bundle = await readRunJsonIfExists(runPaths, "run.json");

  if (!isRunBundle(bundle)) {
    return null;
  }

  return {
    bundle,
    bundlePath: path.relative(cwd, bundlePath),
    runDir: runPaths.absoluteRunRoot
  };
}

/** Internal continuity seam for callers that already bound one run identity. */
export async function verifyRunPrepared(
  cwdInput: string,
  runInput: string,
  runPaths: PreparedRunArtifactPaths
): Promise<VerifyResult> {
  const cwd = path.resolve(cwdInput);
  try {
    await validatePreparedRunArtifactPaths(runPaths);
  } catch {
    return invalidRunStorageVerifyResult(cwd, runInput);
  }
  return verifyPreparedRun(cwd, runInput, runPaths);
}

export async function listRuns(cwdInput: string): Promise<RunsResult> {
  const cwd = path.resolve(cwdInput);
  const runsRootPath = resolveRunsRoot(cwd);

  // ENOENT (no .humanish/runs yet) is a normal empty state: ok:true, no runs. Any
  // other readdir failure (e.g. permission denied) is a real I/O failure and must
  // not be swallowed into a false "no runs" report.
  let entries: string[];
  let runsRoot: import("./selected-output-paths.js").PreparedSelectedOutputDirectory | null = null;
  try {
    runsRoot = await bindExistingManagedHumanishOutputDirectory(cwd, "runs");
    entries = runsRoot ? await readdir(runsRoot.physicalPath) : [];
    if (runsRoot) {
      await assertPreparedSelectedOutputDirectory(runsRoot);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      entries = [];
    } else {
      return runsUnavailableResult(cwd, error);
    }
  }

  let latest: RunPointer | null;
  try {
    latest = runsRoot ? await readLatest(runsRoot) : null;
  } catch (error) {
    return runsUnavailableResult(cwd, error);
  }

  const runs = [];
  for (const entryName of entries) {
    if (entryName === "latest.json" || !isSafeRunIdSegment(entryName)) {
      continue;
    }
    const entryPath = path.join(runsRootPath, entryName);
    const entryStats = await lstat(entryPath, { bigint: true }).catch(() => null);
    if (!entryStats) {
      continue;
    }
    if (entryStats.isSymbolicLink() || (!entryStats.isDirectory() && !entryStats.isFile()) || (entryStats.isFile() && entryStats.nlink > 1n)) {
      return runsUnavailableResult(cwd, new Error(`Unsafe Humanish runs entry: ${entryName}`));
    }
    if (!entryStats.isDirectory()) {
      continue;
    }
    let entryRunPaths: PreparedRunArtifactPaths;
    try {
      entryRunPaths = await bindExistingRunArtifactPaths(cwd, entryName);
    } catch (error) {
      return runsUnavailableResult(cwd, error);
    }
    if (runsRoot && entryRunPaths.physicalRunsRoot !== runsRoot.physicalPath) {
      return runsUnavailableResult(cwd, new Error("Humanish runs root changed physical destination."));
    }
    const bundle = await readRunJsonIfExists(entryRunPaths, "run.json");
    runs.push({
      runId: entryName,
      createdAt: isRecord(bundle) && typeof bundle.createdAt === "string" ? bundle.createdAt : null,
      mode: isRecord(bundle) && typeof bundle.mode === "string" ? bundle.mode : null,
      path: path.join(RUNS_RELATIVE_ROOT, entryName)
    });
  }

  if (runsRoot) {
    try {
      await assertPreparedSelectedOutputDirectory(runsRoot);
    } catch (error) {
      return runsUnavailableResult(cwd, error);
    }
  }

  return {
    schema: RUNS_SCHEMA,
    ok: true,
    cwd,
    runs: runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    latest: latest?.runId ?? null
  };
}

function runsUnavailableResult(cwd: string, error: unknown): RunsResult {
  return {
    schema: RUNS_SCHEMA,
    ok: false,
    cwd,
    runs: [],
    latest: null,
    error: {
      code: "HUMANISH_RUNS_UNAVAILABLE",
      message: redactText(error instanceof Error ? error.message : String(error))
    }
  };
}

export async function readReview(cwdInput: string, runInput: string): Promise<VerifyResult | (ReviewSummary & { path: string; runId: string })> {
  const cwd = path.resolve(cwdInput);
  let runPaths: PreparedRunArtifactPaths | null;
  try {
    runPaths = await resolveRunPath(cwd, runInput);
  } catch {
    return invalidRunStorageVerifyResult(cwd, runInput);
  }
  const verified = await verifyPreparedRun(cwd, runInput, runPaths);

  if (!verified.ok || !verified.bundlePath) {
    return verified;
  }

  const review = runPaths ? await readRunJsonIfExists(runPaths, "review.json") : null;

  if (!isReviewSummary(review)) {
    return {
      ...verified,
      ok: false,
      error: {
        code: "HUMANISH_INVALID_RUN_BUNDLE",
        message: "review.json is missing or invalid."
      }
    };
  }

  return {
    ...review,
    path: path.relative(cwd, path.join(runPaths!.absoluteRunRoot, "review.json")),
    runId: path.basename(runPaths!.absoluteRunRoot)
  };
}

/**
 * The @e2b/desktop release that stopped holding a background command's event stream open after
 * the command was launched (its 2.3.1 changelog, 2026-06-08). On older releases the CLI process
 * stayed alive minutes past a run's written result on one socket to the provider (#581, measured
 * 2026-09-04 on 2.2.3: twelve minutes).
 */
export const DESKTOP_SDK_FLOOR = "2.3.1";

/** The advisory `doctor` attaches to an installed desktop SDK older than the floor, else undefined. */
export function desktopSdkAdvisory(version: string | undefined): string | undefined {
  if (version === undefined) return undefined;
  const parse = (value: string): number[] => value.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const have = parse(version);
  const floor = parse(DESKTOP_SDK_FLOOR);
  if (have.length < 3 || have.some((part) => !Number.isFinite(part))) return undefined;
  const older = have[0]! < floor[0]!
    || (have[0] === floor[0] && (have[1]! < floor[1]! || (have[1] === floor[1] && have[2]! < floor[2]!)));
  return older
    ? `@e2b/desktop ${version} is older than ${DESKTOP_SDK_FLOOR}, which stopped holding a background command stream open after a run (the CLI stayed alive minutes past its result, #581). Update with \`npm i -D @e2b/desktop@latest\`.`
    : undefined;
}

/** The version of the @e2b/desktop that `import("@e2b/desktop")` resolves to from here, if readable. */
async function installedDesktopSdkVersion(): Promise<string | undefined> {
  try {
    const { createRequire } = await import("node:module");
    const manifest = createRequire(import.meta.url).resolve("@e2b/desktop/package.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export async function doctor(cwdInput: string): Promise<DoctorResult> {
  const cwd = path.resolve(cwdInput);
  const cwdOk = await validateCwd(cwd).then((error) => error === null).catch(() => false);
  if (!cwdOk) {
    const checks = [
      { name: "target cwd", ok: false, message: "this directory does not exist, or humanish cannot read it" },
      { name: "package.json", ok: false, checked: false, message: "not checked — the target directory could not be read" },
      { name: "humanish source", ok: false, checked: false, message: "not checked — the target directory could not be read" },
      { name: "runtime ignore", ok: false, checked: false, message: "not checked — the target directory could not be read" }
    ];
    return { schema: DOCTOR_SCHEMA, ok: false, cwd, checks };
  }

  let projectRoot: PreparedSelectedOutputDirectory;
  try {
    projectRoot = await prepareSelectedOutputDirectory(path.dirname(cwd), cwd);
  } catch {
    const checks = [
      { name: "target cwd", ok: false, message: "target directory failed containment validation" },
      { name: "package.json", ok: false, checked: false, message: "not checked — containment validation failed first" },
      { name: "humanish source", ok: false, checked: false, message: "not checked — containment validation failed first" },
      { name: "runtime ignore", ok: false, checked: false, message: "not checked — containment validation failed first" }
    ];
    return { schema: DOCTOR_SCHEMA, ok: false, cwd, checks };
  }

  const safeCheck = async (check: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await check();
    } catch {
      return false;
    }
  };
  const checks = [
    {
      name: "target cwd",
      ok: true,
      message: "target directory exists"
    },
    {
      name: "package.json",
      ok: await safeCheck(async () => await readImplicitProjectFile(projectRoot, "package.json") !== null),
      message: "package.json is present and safe to read"
    },
    {
      name: "humanish source",
      ok: await safeCheck(() => implicitProjectDirectoryExists(projectRoot, "humanish")),
      message: "committed humanish/ source directory is present and safe to read"
    },
    {
      name: "runtime ignore",
      ok: await safeCheck(async () => (await readImplicitProjectFile(projectRoot, ".gitignore"))?.includes(".humanish/") ?? false),
      message: ".gitignore safely contains .humanish/"
    },
    // The optional peer dep every live browser and terminal lane needs (#346). `npx -y humanish`
    // does not pull optional peers, so an adopter's FIRST live run used to fail on it — safely and
    // at $0, but as a burned first impression on the flagship path. Answering it here means the
    // readiness command actually answers readiness.
    await (async () => {
      const present = await safeCheck(async () => {
        try {
          await import("@e2b/desktop");
          return true;
        } catch {
          return false;
        }
      });
      const version = present ? await installedDesktopSdkVersion() : undefined;
      const advisory = desktopSdkAdvisory(version);
      return {
        name: "e2b desktop sdk",
        ok: present,
        message: present
          ? `optional peer @e2b/desktop ${version ?? "(version unread)"} is installed; live desktop lanes can launch${advisory === undefined ? "" : `. ${advisory}`}`
          : "optional peer @e2b/desktop is NOT installed — dry runs work, but any live desktop lane will fail closed. Install it with `npm i -D @e2b/desktop`."
      };
    })(),
    // The stakeholder surface (#455). Reported as capability, never as a gate: the TUI is optional,
    // and `doctor` is itself mostly run by agents through a pipe, where a TTY requirement says
    // nothing about whether the PROJECT is ready. So this row is always ok.
    //
    // WHO IS READING decides the wording, and a real first-contact study
    // (labs/first-contact.yaml) is why. An agent evaluating humanish read
    // "`humanish tui` is available in an interactive terminal", correctly concluded it was not in
    // one, and dropped it — then wrote a report FOR A HUMAN that never mentioned the human
    // surface at all. Discovery worked; handoff did not. A capability described to a reader who
    // cannot use it has to be phrased as something to PASS ON, or it reads as "not for you" and
    // dies there.
    (() => {
      const supported = nodeSupportsTui();
      const bundlePresent = existsSync(tuiBundleUrl(import.meta.url));
      return {
        name: "terminal surface",
        ok: true,
        message: terminalSurfaceMessage({
          supported,
          bundlePresent,
          interactive: process.stdout.isTTY === true,
          nodeVersion: process.version
        })
      };
    })(),
    // The operator's own signed-in coding agent, reported as a CAPABILITY and never a gate: a
    // machine with none is not broken, it just needs a provider key. This row exists because
    // "go make an API key" is where most people trying humanish stop, and a developer very often
    // already has one of these signed in.
    ...await (async () => {
      const found = await detectLocalAgents();
      return [{ name: "local agents", ok: true, message: localAgentDoctorMessage(found) }];
    })(),
    // Provider-key discovery (#436): which source supplies each live-run key, through the same
    // chain a live command resolves (env/--env-file, project overlay, vendor stores, the
    // humanish user store). Values never appear; sources and fill commands do.
    ...await (async () => {
      const probes = await probeKeySources(["OPENAI_API_KEY", "E2B_API_KEY", "GH_TOKEN"], {
        cwd,
        env: process.env
      });
      return probes.map((probe) => {
        const present = probe.source !== null;
        // GH_TOKEN is needed only for private clone subjects, so its absence is informational.
        const required = probe.name !== "GH_TOKEN";
        return {
          name: `key ${probe.name}`,
          ok: present || !required,
          message: present
            ? `supplied by ${probe.source}`
            : required
              ? `missing from every source — ${probe.hint}`
              : `missing (needed only for private clone subjects) — ${probe.hint}`
        };
      });
    })()
  ];

  return {
    schema: DOCTOR_SCHEMA,
    ok: checks.every((check) => check.ok),
    cwd,
    checks
  };
}

function createReviewSummary(): ReviewSummary {
  return {
    schema: REVIEW_SCHEMA,
    verdict: "contract_proof_only",
    summary: "Synthetic dry-run bundle was generated. This proves Humanish artifact plumbing, not product behavior.",
    gaps: [
      "No browser was launched.",
      "No product state was verified.",
      "No model, provider, or E2B substrate was used."
    ]
  };
}

function createLocalActorRunningReviewSummary(actorLabel: string): ReviewSummary {
  return {
    schema: REVIEW_SCHEMA,
    verdict: "contract_proof_only",
    summary: `Live local ${actorLabel} actor is running. This is an in-progress Observer snapshot; final verdict will be written after sanitized actor evidence is captured.`,
    gaps: [
      "Final actor verdict and transcript artifacts are not available until the run completes.",
      "Live Observer follow depends on polling observer/observer-data.json while this run is active.",
      "No GitHub mutation, target OSS mutation, E2B substrate, or production data is used by this local actor contract."
    ]
  };
}

function createLocalActorReviewSummary(actorLabel: string, status: LocalActorTerminalStatus, reason: string): ReviewSummary {
  const verdict = status === "passed"
    ? "pass"
    : status === "timed_out"
      ? "timed_out"
      : status === "blocked"
        ? "blocked"
        : "fail";
  const isTui = actorLabel.toLowerCase().includes("tui");
  const isFanout = actorLabel.toLowerCase().includes("fanout");

  return {
    schema: REVIEW_SCHEMA,
    verdict,
    summary: `Live local ${actorLabel} actor ${status}: ${reason}. This proves the local actor lifecycle and sanitized evidence path${isFanout ? " across requested fanout lanes" : ""}, not target product behavior.`,
    gaps: [
      isTui
        ? "Only one local Codex TUI actor is supported in this slice."
        : "Codex TUI trust bootstrap, PTY rendering, and keyboard-focus proof remain separate from the noninteractive exec actor.",
      "Live follow uses polling Observer snapshots; raw interactive terminal streaming remains a follow-up hardening step.",
      "No GitHub mutation, target OSS mutation, E2B substrate, or production data was used by this local actor contract."
    ]
  };
}

async function inspectImplicitProjectPath(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string
) {
  const segments = relativePath.replace(/\\/g, "/").split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new Error("Implicit project path must be a non-empty relative path.");
  }
  await assertPreparedSelectedOutputDirectory(projectRoot);
  let current = projectRoot.physicalPath;
  for (const [index, segment] of segments.entries()) {
    assertSafeOutputPathSegment(segment, "Implicit project path segment");
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Implicit project path must not contain symbolic links: ${relativePath}`);
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(`Implicit project path must contain only regular files and directories: ${relativePath}`);
    }
    if (stats.isFile() && stats.nlink > 1n) {
      throw new Error(`Implicit project files must be single-link regular files: ${relativePath}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`Implicit project path parent must be a directory: ${relativePath}`);
    }
    if (index === segments.length - 1) {
      await assertPreparedSelectedOutputDirectory(projectRoot);
      return stats;
    }
  }
  return null;
}

async function implicitProjectDirectoryExists(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string
): Promise<boolean> {
  const stats = await inspectImplicitProjectPath(projectRoot, relativePath);
  if (!stats) {
    return false;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Implicit project directory has the wrong type: ${relativePath}`);
  }
  return true;
}

async function readImplicitProjectFile(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string
): Promise<string | null> {
  const stats = await inspectImplicitProjectPath(projectRoot, relativePath);
  if (!stats) {
    return null;
  }
  if (!stats.isFile() || stats.nlink !== 1n) {
    throw new Error(`Implicit project file must be a single-link regular file: ${relativePath}`);
  }
  const bytes = await readContainedRegularFile(projectRoot, relativePath.replace(/\\/g, "/"));
  if (!bytes) {
    throw new Error(`Implicit project file changed while it was being read: ${relativePath}`);
  }
  return bytes.toString("utf8");
}

async function listImplicitProjectDirectory(
  projectRoot: PreparedSelectedOutputDirectory,
  relativePath: string
): Promise<string[]> {
  if (!await implicitProjectDirectoryExists(projectRoot, relativePath)) {
    return [];
  }
  const directory = path.join(projectRoot.physicalPath, ...relativePath.replace(/\\/g, "/").split("/"));
  const names = await readdir(directory);
  await assertPreparedSelectedOutputDirectory(projectRoot);
  for (const name of names) {
    assertSafeOutputPathSegment(name, "Implicit project directory entry");
    await inspectImplicitProjectPath(projectRoot, `${relativePath.replace(/\\/g, "/")}/${name}`);
  }
  return names;
}

async function loadDryRunSelection(
  projectRoot: PreparedSelectedOutputDirectory,
  humanishSource: "present" | "missing"
): Promise<{
  browserJourney?: BrowserPersonaJourney;
  browserJourneyFailure?: string;
  persona: RunBundle["persona"];
  resolvedPersona: ResolvedPersona;
  scenario: RunBundle["scenario"];
  warnings: string[];
}> {
  const warnings: string[] = [];

  if (humanishSource === "missing") {
    return {
      persona: builtinPersona,
      resolvedPersona: parseResolvedPersona({}, { id: builtinPersona.id, name: builtinPersona.name }),
      scenario: builtinScenario,
      warnings
    };
  }

  const personaPath = "humanish/personas/synthetic-new-user.yaml";
  const scenarioPath = "humanish/scenarios/first-run-smoke.yaml";
  const personaText = await readImplicitProjectFile(projectRoot, personaPath);
  const scenarioText = await readImplicitProjectFile(projectRoot, scenarioPath);
  const browserJourneySelection = await loadBrowserPersonaJourneySelection(projectRoot);

  if (personaText === null) {
    warnings.push(`${personaPath} was not found; using built-in persona defaults.`);
  }

  if (scenarioText === null) {
    warnings.push(`${scenarioPath} was not found; using built-in scenario defaults.`);
  }

  let resolvedPersona: ResolvedPersona;
  if (personaText === null) {
    resolvedPersona = parseResolvedPersona({}, { id: builtinPersona.id, name: builtinPersona.name });
  } else {
    const parsedPersona = parsePersonaYaml(personaText);
    if (parsedPersona.failed) {
      warnings.push(`${personaPath} could not be parsed as YAML; using built-in persona trait defaults.`);
    }
    resolvedPersona = parseResolvedPersona(parsedPersona.value, {
      id: "synthetic-new-user",
      name: "Synthetic New User"
    });
  }

  return {
    ...(browserJourneySelection.journey ? { browserJourney: browserJourneySelection.journey } : {}),
    ...(browserJourneySelection.failure ? { browserJourneyFailure: browserJourneySelection.failure } : {}),
    persona: personaText === null
      ? builtinPersona
      : {
          id: readYamlScalar(personaText, "id") ?? "synthetic-new-user",
          name: readYamlScalar(personaText, "name") ?? "Synthetic New User",
          source: personaPath,
          sourceDigest: digestText(personaText)
        },
    resolvedPersona,
    scenario: scenarioText === null
      ? builtinScenario
      : {
          id: readYamlScalar(scenarioText, "id") ?? "first-run-smoke",
          title: readYamlScalar(scenarioText, "title") ?? "First-run smoke",
          goal: readYamlScalar(scenarioText, "goal") ?? "Run a public-safe first-run smoke scenario.",
          source: scenarioPath,
          sourceDigest: digestText(scenarioText)
        },
    warnings: [...warnings, ...browserJourneySelection.warnings]
  };
}

async function loadBrowserPersonaJourneySelection(projectRoot: PreparedSelectedOutputDirectory): Promise<{
  failure?: string;
  journey?: BrowserPersonaJourney;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const names = await listImplicitProjectDirectory(projectRoot, "humanish/scenarios");
  const files = names
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort((left, right) => {
      if (left === "first-run-smoke.yaml") return -1;
      if (right === "first-run-smoke.yaml") return 1;
      return left.localeCompare(right);
    });

  for (const name of files) {
    const relativePath = path.join("humanish", "scenarios", name);
    const text = await readImplicitProjectFile(projectRoot, relativePath);
    if (text === null) {
      continue;
    }
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (error) {
      return {
        failure: `${relativePath} could not be parsed as YAML; browser persona journey failed closed.`,
        warnings
      };
    }

    const parsed = parseBrowserPersonaJourneyFromScenario({
      raw,
      relativePath,
      sourceDigest: digestText(text)
    });
    if (parsed.failure) {
      return {
        failure: parsed.failure,
        warnings
      };
    }
    if (parsed.journey) {
      return {
        journey: parsed.journey,
        warnings
      };
    }
  }

  return { warnings };
}

function renderReviewMarkdown(bundle: RunBundle): string {
  return `# Humanish Run Review

Run: ${bundle.runId}

Mode: ${bundle.mode}

Verdict: ${bundle.review.verdict}

${bundle.review.summary}

## Public-Safety

- Redaction: ${bundle.redaction.status}
- Notes: ${bundle.redaction.notes}

## Gaps

${bundle.review.gaps.map((gap) => `- ${gap}`).join("\n")}
`;
}

function readYamlScalar(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+?)\\s*$`, "m"));
  if (!match?.[1]) {
    return null;
  }

  return match[1].replace(/^["']|["']$/g, "");
}

function parsePersonaYaml(text: string): { value: unknown; failed: boolean } {
  try {
    return { value: parseYaml(text), failed: false };
  } catch {
    return { value: {}, failed: true };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve "latest" or an explicit run id to its prepared artifact paths. Exported for the
 *  reclaim command (#358), which must locate a run WITHOUT trusting anything but the managed dir. */
export async function resolveRunPath(cwd: string, runInput: string): Promise<PreparedRunArtifactPaths | null> {
  if (runInput === "latest") {
    const runsRoot = await bindExistingManagedHumanishOutputDirectory(cwd, "runs");
    if (!runsRoot) {
      return null;
    }
    const latest = await readLatest(runsRoot);
    const expected = latest ? resolveLatestRunDirectory(cwd, latest) : null;
    if (!latest || !expected) {
      return null;
    }
    const runPaths = await bindExistingRunArtifactPaths(cwd, latest.runId);
    if (
      runPaths.absoluteRunRoot !== expected
      || runPaths.physicalRunsRoot !== runsRoot.physicalPath
    ) {
      throw new Error("Latest run pointer changed physical runs root.");
    }
    await assertPreparedSelectedOutputDirectory(runsRoot);
    return runPaths;
  }

  if (!isSafeRunIdSegment(runInput) || !await resolveExistingRunDirectory(cwd, runInput)) {
    return null;
  }
  return bindExistingRunArtifactPaths(cwd, runInput);
}

async function readLatest(runsRoot: import("./selected-output-paths.js").PreparedSelectedOutputDirectory): Promise<RunPointer | null> {
  const latestPath = path.join(runsRoot.physicalPath, "latest.json");
  let latestStats;
  try {
    latestStats = await lstat(latestPath, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (latestStats.isSymbolicLink() || !latestStats.isFile() || latestStats.nlink !== 1n) {
    throw new Error("Latest run pointer must be a single-link regular file.");
  }
  const bytes = await readContainedRegularFile(runsRoot, "latest.json");
  if (!bytes) {
    throw new Error("Latest run pointer changed while it was being read.");
  }
  let latest: unknown;
  try {
    latest = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }

  return isRunPointer(latest) ? latest : null;
}

async function readPackageName(projectRoot: PreparedSelectedOutputDirectory): Promise<string | null> {
  const text = await readImplicitProjectFile(projectRoot, "package.json");
  if (text === null) {
    return null;
  }
  try {
    const packageJson = JSON.parse(text) as unknown;
    return isRecord(packageJson) && typeof packageJson.name === "string" ? packageJson.name : null;
  } catch {
    return null;
  }
}

async function readRunJsonIfExists(runPaths: PreparedRunArtifactPaths, ...segments: string[]): Promise<unknown | null> {
  const text = await readRunTextIfExists(runPaths, ...segments);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readRunTextIfExists(runPaths: PreparedRunArtifactPaths, ...segments: string[]): Promise<string | null> {
  const bytes = await readContainedRegularFile(runPaths, segments.join("/"));
  return bytes?.toString("utf8") ?? null;
}

async function readSafeRunArtifactBytes(
  runPaths: PreparedRunArtifactPaths,
  relativePath: string
): Promise<Buffer | null> {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || segments.length === 0
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }
  return readContainedRegularFile(runPaths, normalized);
}

async function readSafeRunArtifactJson(
  runPaths: PreparedRunArtifactPaths,
  relativePath: string
): Promise<unknown | null> {
  const bytes = await readSafeRunArtifactBytes(runPaths, relativePath);
  if (!bytes) {
    return null;
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeRunBundleArtifacts(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
  /** Pass ONLY when this write is the run's final one: the shared writer is also used for
   *  mid-run in-progress snapshots, and finalizing there would declare a live run finished (#455). */
  finalizeStatus?: RunStatusHandle
): Promise<void> {
  const publicBundle: RunBundle = {
    ...bundle,
    cwd: PUBLIC_TARGET_CWD
  };
  await writeContainedOutputFile(runPaths, "run.json", `${JSON.stringify(publicBundle, null, 2)}\n`, "utf8");
  await finalizeStatus?.finish({
    ...(publicBundle.review?.verdict === undefined ? {} : { verdict: publicBundle.review.verdict }),
    ...(publicBundle.review?.participants === undefined
      ? {}
      : {
          participants: {
            total: publicBundle.review.participants.total,
            reachedGoal: publicBundle.review.participants.reachedGoal,
            ...(publicBundle.review.participants.reportedFriction === undefined
              ? {}
              : { reportedFriction: publicBundle.review.participants.reportedFriction })
          }
        }),
    ...(publicBundle.cost?.estimatedTotalUsd === undefined ? {} : { estimatedCostUsd: publicBundle.cost.estimatedTotalUsd })
  });
  await writeContainedOutputFile(runPaths, "review.json", `${JSON.stringify(publicBundle.review, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "review.md", renderReviewMarkdown(publicBundle), "utf8");
  await writeContainedOutputFile(runPaths, "events.ndjson", `${publicBundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "observer/observer-data.json", `${JSON.stringify(buildObserverData(publicBundle), null, 2)}\n`, "utf8");
}

async function missingLocalEvidenceArtifacts(runPaths: PreparedRunArtifactPaths, bundle: RunBundle): Promise<string[]> {
  const requiredPaths = new Map<string, { screenshot: boolean }>();
  const addRequiredPath = (artifactPath: string, options: { screenshot?: boolean } = {}): void => {
    const existing = requiredPaths.get(artifactPath);
    requiredPaths.set(artifactPath, { screenshot: Boolean(existing?.screenshot || options.screenshot) });
  };

  for (const stream of bundle.streams) {
    for (const artifact of stream.artifacts) {
      if (isLocalEvidenceArtifactPath(artifact.path)) {
        addRequiredPath(artifact.path, { screenshot: artifact.kind === "screenshot" });
      }
    }

    const embedPath = normalizeLocalEvidenceReference(stream.embed?.kind === "screenshot" ? stream.embed.url : undefined);
    if (embedPath) {
      addRequiredPath(embedPath, { screenshot: true });
    }

    const uiScreenshotPath = normalizeLocalEvidenceReference(stream.ui?.screenshotUrl);
    if (uiScreenshotPath) {
      addRequiredPath(uiScreenshotPath, { screenshot: true });
    }

    if (stream.ui?.nestedObserverPath && isLocalEvidenceArtifactPath(stream.ui.nestedObserverPath)) {
      addRequiredPath(stream.ui.nestedObserverPath);
    }
  }

  for (const artifact of bundle.adapterArtifacts ?? []) {
    if (isLocalEvidenceArtifactPath(artifact.path)) {
      addRequiredPath(artifact.path, { screenshot: artifact.kind === "screenshot" });
    }
  }

  const missing: string[] = [];
  for (const [artifactPath, requirements] of requiredPaths) {
    const bytes = await readSafeRunArtifactBytes(runPaths, artifactPath);
    if (!bytes || bytes.length === 0) {
      missing.push(artifactPath);
      continue;
    }

    if (requirements.screenshot) {
      const imageError = screenshotEvidenceError(artifactPath, bytes);
      if (imageError) {
        missing.push(`${artifactPath} (${imageError})`);
      }
    }
  }

  return missing;
}

function invalidRunEvidenceReferences(bundle: RunBundle): string[] {
  const findings: string[] = [];
  if (path.isAbsolute(bundle.cwd)) {
    findings.push(`run bundle persists absolute cwd ${bundle.cwd}`);
  }
  const adapterArtifactKeys = new Set<string>();
  for (const artifact of bundle.adapterArtifacts ?? []) {
    const key = `${artifact.namespace}:${artifact.kind}:${artifact.path}`;
    if (adapterArtifactKeys.has(key)) {
      findings.push(`adapter artifact duplicate ${artifact.namespace}:${artifact.kind}:${artifact.path}`);
    }
    adapterArtifactKeys.add(key);
    if (!isLocalEvidenceArtifactPath(artifact.path)) {
      findings.push(`adapter artifact ${artifact.namespace}:${artifact.kind} nonlocal artifact ${artifact.path}`);
    }
  }
  for (const stream of bundle.streams) {
    const seen = new Set<string>();
    for (const artifact of stream.artifacts) {
      const key = `${artifact.kind}:${artifact.path}`;
      if (seen.has(key)) {
        findings.push(`${stream.id} duplicate artifact ${artifact.kind}:${artifact.path}`);
      }
      seen.add(key);
      if (!isLocalEvidenceArtifactPath(artifact.path)) {
        findings.push(`${stream.id} nonlocal artifact ${artifact.kind}:${artifact.path}`);
      }
    }

    if (stream.ui?.nestedObserverPath && !isLocalEvidenceArtifactPath(stream.ui.nestedObserverPath)) {
      findings.push(`${stream.id} nonlocal nested observer reference ${stream.ui.nestedObserverPath}`);
    }
    if (stream.embed?.kind === "screenshot" && stream.embed.url && !normalizeLocalEvidenceReference(stream.embed.url)) {
      findings.push(`${stream.id} nonlocal screenshot embed ${stream.embed.url}`);
    }
    if (stream.ui?.screenshotUrl && !normalizeLocalEvidenceReference(stream.ui.screenshotUrl)) {
      findings.push(`${stream.id} nonlocal screenshot reference ${stream.ui.screenshotUrl}`);
    }
  }
  return findings.slice(0, 50);
}

// The fixed artifact filenames the terminal-product lane (src/e2b-terminal-lab.ts) persists.
// Kept in sync with TERMINAL_LEDGERS_ARTIFACT / TERMINAL_EVENTS_ARTIFACT / TERMINAL_TRANSCRIPT_ARTIFACT.
const TERMINAL_LEDGERS_FILE = "terminal-ledgers.json";
const TERMINAL_EVENTS_FILE = "terminal-events.ndjson";
const TERMINAL_TRANSCRIPT_FILE = "terminal-transcript.txt";

/**
 * Verifier for the terminal-product real-agent lane (issue #154, the in-sandbox command-scoped
 * key route). A LIVE terminal stream must carry the durable proof the safety contract requires,
 * and must FAIL CLOSED when any of it is missing — a blocked/failed agent run stays structurally
 * verifiable (the failure is the evidence) ONLY when the substrate/cleanup/interventions ledgers
 * are present; it must never become a hollow pass. Credential-shape leakage across every artifact
 * file is already caught by scanRunPublicSafetyArtifacts; this check enforces the STRUCTURAL
 * evidence + the proven-teardown invariant. Dry-run/contract bundles are exempt (mode !== live).
 */
async function validateTerminalProductEvidence(runPaths: PreparedRunArtifactPaths, bundle: RunBundle): Promise<string[]> {
  if (bundle.mode !== "live") {
    return [];
  }
  const findings: string[] = [];
  // Detect the terminal-PRODUCT lane by its unique actor-trace protocol ("terminal-exec"), NOT by
  // the broad stream.kind "terminal" — the existing local codex-exec/TUI lanes also use terminal
  // streams (with a different protocol) and must not be held to this lane's ledger contract.
  const terminalStreams = bundle.streams.filter(
    (stream) => stream.actor?.protocol === "terminal-exec" && stream.status !== "contract_proof_only"
  );
  if (terminalStreams.length === 0) {
    return findings;
  }

  // The lane writes exactly one terminal run's ledgers/evidence at fixed paths in the run root.
  const ledgers = await readSafeRunArtifactJson(runPaths, TERMINAL_LEDGERS_FILE);
  if (!isRecord(ledgers) || ledgers.schema !== "humanish.terminal-ledgers.v1") {
    findings.push(`missing or malformed ${TERMINAL_LEDGERS_FILE} (humanish.terminal-ledgers.v1)`);
    return findings;
  }

  // Substrate lifecycle ledger: must record at least sandbox creation AND teardown.
  const lifecycle = Array.isArray(ledgers.lifecycle) ? ledgers.lifecycle : [];
  if (lifecycle.length === 0) {
    findings.push("substrate lifecycle ledger is empty (expected create -> ready -> exec -> cleanup events)");
  }

  // Command log: present (an array; empty is allowed only if the session never reached exec, which
  // the lifecycle/cleanup records still cover).
  if (!Array.isArray(ledgers.commandLog)) {
    findings.push("command log ledger is missing or not an array");
  }

  // Interventions ledger: must be PRESENT (an array). Empty is valid and expected (stdin disabled,
  // no assisted-input path) — but absent fails, so an assisted run can never masquerade as one
  // without an interventions record.
  if (!Array.isArray(ledgers.interventions)) {
    findings.push("interventions ledger is missing (an empty array is required-present, not optional)");
  }

  // Cleanup proof: the sandbox must be killed and proven reclaimed BY EXACT ID (remaining===0).
  // humanish never calls Sandbox.list to derive this field; a live run that cannot prove teardown
  // fails closed (remaining===1 still-present-unconfirmed, remaining===-1 kill(id) itself
  // failed -- the server-side kill-on-timeout is the backstop for both).
  const cleanup = isRecord(ledgers.cleanup) ? ledgers.cleanup : undefined;
  if (!cleanup) {
    findings.push("cleanup proof is missing");
  } else if (cleanup.killed !== true || cleanup.remaining !== 0) {
    findings.push(
      `cleanup not proven by id (killed=${String(cleanup.killed)}, remaining=${String(cleanup.remaining)}); a run that cannot prove sandbox teardown fails closed`
    );
  }

  // The redacted exec-stream + normalized transcript artifacts must be WRITTEN (the producer
  // always writes them on the live path, even empty for a no-output blocked run — so absence is a
  // real evidence gap, while emptiness is legitimate and keeps blocked runs verifiable).
  if (!(await readSafeRunArtifactBytes(runPaths, TERMINAL_EVENTS_FILE))) {
    findings.push(`missing terminal event stream artifact (${TERMINAL_EVENTS_FILE})`);
  }
  if (!(await readSafeRunArtifactBytes(runPaths, TERMINAL_TRANSCRIPT_FILE))) {
    findings.push(`missing normalized terminal transcript artifact (${TERMINAL_TRANSCRIPT_FILE})`);
  }

  // The provider-neutral actor trace must be on the terminal lane with redaction passed.
  for (const stream of terminalStreams) {
    const traceArtifact = stream.artifacts.find((artifact) => artifact.kind === "trace");
    const tracePath = traceArtifact?.path ?? "actor.json";
    const trace = await readSafeRunArtifactJson(runPaths, tracePath);
    if (!isRecord(trace) || trace.lane !== "terminal") {
      findings.push(`${stream.id} missing terminal-lane actor trace`);
      continue;
    }
    if (!isRecord(trace.redaction) || trace.redaction.status !== "passed") {
      findings.push(`${stream.id} actor trace redaction status must be passed`);
    }
  }

  // --- SLICE 3: the cost ledger + no-spend proof must be present + internally honest. ---
  findings.push(...validateTerminalCostEvidence(ledgers));

  return findings;
}

// The four cost categories the no-spend proof + cost ledger reason over. Kept in sync with
// e2b-terminal-lab.ts COST_CATEGORIES (a missing category on either side is a finding).
const TERMINAL_COST_CATEGORIES = ["product", "media", "payment", "provider"] as const;

/**
 * Verifier for the SLICE-3 cost ledger + no-spend proof (issue #154's cost/no-spend asks). A LIVE
 * terminal-product bundle MUST carry both (fail closed if absent on a live run). The load-bearing
 * honesty check: the no-spend proof may NOT claim zero on a line the ledger marks `null`
 * (UNMEASURED) — a proof can never claim more than the ledger measured. And the observed KNOWN
 * spend may not exceed the declared cap (the proof's own maxUsd) — fail-closed, not advisory.
 * The null discipline is enforced here too: a present line's `usd` must be a number OR literally
 * null (never undefined/omitted), so "not measured" can never be silently dropped.
 */
function validateTerminalCostEvidence(ledgers: Record<string, unknown>): string[] {
  const findings: string[] = [];

  const cost = isRecord(ledgers.cost) ? ledgers.cost : undefined;
  if (!cost || cost.schema !== "humanish.terminal-cost-ledger.v1") {
    findings.push("missing or malformed cost ledger (humanish.terminal-cost-ledger.v1) — a live terminal-product run must derive a cost ledger");
    return findings;
  }
  const lines = isRecord(cost.lines) ? cost.lines : undefined;
  if (!lines) {
    findings.push("cost ledger has no lines block");
    return findings;
  }

  // The null discipline: every applicable category line must be PRESENT with `usd` as a number or
  // literally null. `undefined`/omitted is forbidden — that would silently lose the "not measured"
  // distinction. Track which categories the ledger marks null so the no-spend proof cannot lie about them.
  const nullCategories = new Set<string>();
  for (const category of TERMINAL_COST_CATEGORIES) {
    const line = isRecord(lines[category]) ? (lines[category] as Record<string, unknown>) : undefined;
    if (!line || !("usd" in line)) {
      findings.push(`cost ledger line "${category}" is missing its usd field (unknowns must be explicit null, never omitted)`);
      continue;
    }
    const usd = line.usd;
    if (usd === null) {
      nullCategories.add(category);
    } else if (typeof usd !== "number") {
      findings.push(`cost ledger line "${category}" usd must be a number or null (got ${typeof usd})`);
    }
  }

  const proof = isRecord(ledgers.noSpendProof) ? ledgers.noSpendProof : undefined;
  if (!proof || proof.schema !== "humanish.terminal-no-spend-proof.v1") {
    findings.push("missing or malformed no-spend proof (humanish.terminal-no-spend-proof.v1) — the no-spend proof must be derived from the ledger");
    return findings;
  }

  // HONESTY CHECK: the no-spend proof must NOT claim zero on a line the ledger marks `null`. A
  // knownZeroLines entry that is actually unmeasured in the ledger means the proof claimed more than
  // it measured — fail closed.
  const knownZeroLines = Array.isArray(proof.knownZeroLines) ? proof.knownZeroLines : [];
  for (const category of knownZeroLines) {
    if (nullCategories.has(String(category))) {
      findings.push(`no-spend proof claims zero on line "${String(category)}" but the cost ledger marks it null (UNMEASURED); a proof may not claim zero on a line it did not measure`);
    }
  }

  // FAIL-CLOSED CAP: observed KNOWN spend may not exceed the declared cap (the proof's maxUsd). The
  // ledger's knownTotalUsd is the measured spend; null lines do not count toward it (and the proof
  // reports them as unmeasured). A satisfied proof whose known total exceeds its cap is contradictory.
  const knownTotalUsd = typeof cost.knownTotalUsd === "number" ? cost.knownTotalUsd : Number.NaN;
  const maxUsd = typeof proof.maxUsd === "number" ? proof.maxUsd : null;
  if (maxUsd !== null && Number.isFinite(knownTotalUsd) && knownTotalUsd > maxUsd) {
    findings.push(`observed KNOWN spend ${knownTotalUsd} USD exceeds the declared cap maxUsd=${maxUsd}; the run must fail closed, not verify green`);
  }
  // A proof that asserts `satisfied:true` while a known line is non-zero (knownNonZeroLines) is
  // self-contradictory — reject it (the proof's own derived state must be internally consistent).
  const knownNonZeroLines = Array.isArray(proof.knownNonZeroLines) ? proof.knownNonZeroLines : [];
  if (proof.satisfied === true && knownNonZeroLines.length > 0) {
    findings.push(`no-spend proof claims satisfied:true but reports known non-zero spend lines (${knownNonZeroLines.map(String).join(", ")})`);
  }

  return findings;
}

async function validateCodexAppServerEvidence(runPaths: PreparedRunArtifactPaths, bundle: RunBundle): Promise<string[]> {
  if (bundle.mode !== "live") {
    return [];
  }

  const findings: string[] = [];
  const appServerStreams = bundle.streams.filter((stream) =>
    stream.status !== "contract_proof_only"
    && (
      stream.codex?.provider === "codex-app-server"
      || stream.artifacts.some((artifact) => artifact.path.includes("codex-app-server"))
    )
  );

  for (const stream of appServerStreams) {
    if (stream.codex?.provider !== "codex-app-server") {
      findings.push(`${stream.id} missing first-class codex app-server metadata`);
    }
    if (stream.status === "running" || stream.codex?.state === "connecting" || stream.codex?.state === "running") {
      continue;
    }
    const traceArtifact = stream.artifacts.find((artifact) =>
      artifact.kind === "trace"
      && artifact.path.includes("codex-app-server")
    );
    const eventsArtifact = stream.artifacts.find((artifact) =>
      artifact.kind === "events"
      && artifact.path.includes("codex-app-server")
    );
    const logArtifact = stream.artifacts.find((artifact) =>
      artifact.kind === "log"
      && artifact.path.includes("codex-app-server")
    );

    if (!traceArtifact) {
      findings.push(`${stream.id} missing codex app-server trace artifact`);
      continue;
    }

    const trace = await readSafeRunArtifactJson(runPaths, traceArtifact.path);
    if (!isRecord(trace) || ![CODEX_APP_SERVER_TRACE_SCHEMA, CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA].includes(String(trace.schema))) {
      findings.push(`${stream.id} trace artifact must use ${CODEX_APP_SERVER_TRACE_SCHEMA} or ${CODEX_APP_SERVER_PROJECTED_TRACE_SCHEMA}`);
    }
    if (!isRecord(trace) || !isRecord(trace.redaction) || trace.redaction.status !== "passed") {
      findings.push(`${stream.id} trace redaction status must be passed`);
    }
    if (!eventsArtifact) {
      findings.push(`${stream.id} missing codex app-server event envelope log`);
    }
    if (!logArtifact) {
      findings.push(`${stream.id} missing codex app-server transcript summary log`);
    }
  }

  return findings;
}

// Trace item kinds that show the actor DID something (drove UI, ran a command, called a tool,
// changed a file). reasoning/screenshot/plan/notice items are observation, not engagement.
const ACTION_BEARING_ACTOR_ITEM_KINDS = new Set(["ui_action", "command", "tool_call", "file_change"]);

/**
 * Independent mirror of the producer-side no-engagement guard (cua-actor-lab.ts): a LIVE actor
 * trace claiming goal_satisfied while carrying zero action-bearing items AND zero message items
 * is a hollow run — the actor neither did nor said anything — and must not verify as evidence
 * (invariant 4: evidence verifies fail-closed). Live-vs-dry-run is judged exactly as the
 * producer judges it, from bundle.mode alone; dry-run/contract bundles legitimately carry no
 * actions and stay exempt. Engagement is accepted from EITHER surface — itemized trace items or
 * the producer's counts — because providers differ in what they itemize; the hollow-run
 * regression class (the 0.3.0–0.6.0 CUA parser bug) reports zero on both. The trace is read
 * defensively: isRunStream does not validate the actor seam, and verify must not throw on a
 * malformed one.
 */
function noEngagementActorFindings(bundle: RunBundle): string[] {
  if (bundle.mode !== "live") {
    return [];
  }

  const findings: string[] = [];
  for (const stream of bundle.streams) {
    const trace: unknown = stream.actor;
    if (!isRecord(trace) || trace.schema !== ACTOR_TRACE_SCHEMA || trace.completionReason !== "goal_satisfied") {
      continue;
    }
    const items = Array.isArray(trace.items) ? trace.items : [];
    const counts = isRecord(trace.counts) ? trace.counts : {};
    const countOf = (key: string): number => {
      const value = counts[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    const engaged = countOf("actions") > 0
      || countOf("messages") > 0
      || hasStopWhenObservationEvidence(items, countOf("screenshots"))
      || items.some((item) =>
        isRecord(item)
        && typeof item.kind === "string"
        && (item.kind === "message" || ACTION_BEARING_ACTOR_ITEM_KINDS.has(item.kind)));
    if (!engaged) {
      const provider = typeof trace.provider === "string" ? trace.provider : "unknown provider";
      findings.push(`${stream.id} live actor trace (${provider}) claims goal_satisfied with zero actions and zero messages`);
    }
  }

  return findings;
}

function hasStopWhenObservationEvidence(items: unknown[], screenshotCount: number): boolean {
  const hasScreenshot = screenshotCount > 0 || items.some((item) =>
    isRecord(item)
      && item.kind === "screenshot"
      && isRecord(item.screenshotRef)
      && typeof item.screenshotRef.path === "string"
      && item.screenshotRef.path.length > 0);
  if (!hasScreenshot) return false;
  // A matched stopWhen, or a declared dwell window that ended the session (#510): both are
  // structured, harness-owned completion, with frames behind them.
  return items.some((item) =>
    isRecord(item)
      && item.kind === "notice"
      && item.status === "matched"
      && typeof item.title === "string"
      && (item.title.startsWith("stopWhen matched") || item.title === "dwell window complete"));
}

function actorVerdictConsistencyFindings(bundle: RunBundle): string[] {
  if (bundle.mode !== "live" || bundle.review.verdict !== "pass") {
    return [];
  }

  const findings: string[] = [];
  for (const stream of bundle.streams) {
    const trace: unknown = stream.actor;
    if (!isRecord(trace) || trace.schema !== ACTOR_TRACE_SCHEMA) {
      continue;
    }
    if (trace.status !== "passed") {
      const provider = typeof trace.provider === "string" ? trace.provider : "unknown provider";
      const reason = typeof trace.reason === "string" ? trace.reason : "no actor reason";
      findings.push(`${stream.id} live actor trace (${provider}) has status ${String(trace.status)} under a pass review verdict: ${reason}`);
    }
  }

  return findings;
}

/**
 * redaction.screenshots: "raw" is the SUPPORTED local default (full-fidelity frames in
 * gitignored .humanish), not a verify failure — but ok: true must never read as "share-ready",
 * so verify surfaces the posture as a warning in both human and JSON output. Read defensively
 * for the same reason as noEngagementActorFindings.
 */
function rawScreenshotPostureWarnings(bundle: RunBundle): string[] {
  const rawStreamIds = rawScreenshotStreamIds(bundle);

  if (rawStreamIds.length === 0) {
    return [];
  }

  return [
    `Screenshots are FULL-FIDELITY (raw) on ${rawStreamIds.join(", ")} — supported for local use, NOT publish-safe as-is. Verify ok does not mean share-ready; set policies.redactScreenshots: true to blur a share-as-is bundle.`
  ];
}

function rawScreenshotStreamIds(bundle: RunBundle): string[] {
  const rawStreamIds: string[] = [];
  for (const stream of bundle.streams) {
    const trace: unknown = stream.actor;
    if (isRecord(trace) && isRecord(trace.redaction) && trace.redaction.screenshots === "raw") {
      rawStreamIds.push(stream.id);
    }
  }
  return rawStreamIds;
}

/** Non-fatal hosted-desktop geometry disclosures, deduplicated across shared-screen streams. */
function desktopGeometryWarnings(bundle: RunBundle): string[] {
  return [...new Set(bundle.streams.flatMap((stream) => stream.desktopGeometry?.warnings ?? []))];
}

function buildShareSafety(args: {
  ok: boolean;
  bundle: RunBundle;
  publicSafetyFindings: string[];
}): VerifyResult["shareSafety"] {
  const reasons: VerifyResult["shareSafety"]["reasons"] = [];

  if (!args.ok) {
    reasons.push({
      code: "VERIFY_FAILED",
      message: "The run bundle is not valid enough to promote into public feedback."
    });
  }

  if (args.publicSafetyFindings.length > 0) {
    reasons.push({
      code: "PUBLIC_SAFETY_FINDINGS",
      message: "Text artifacts or public-proof paths matched known secret, token, local-path, browser-profile, or hosted-substrate URL patterns."
    });
  }

  const rawStreamIds = rawScreenshotStreamIds(args.bundle);
  if (rawStreamIds.length > 0) {
    reasons.push({
      code: "RAW_SCREENSHOTS",
      message: `Full-fidelity screenshots are present on ${rawStreamIds.join(", ")}. This is valid local evidence, but not share-ready as-is.`
    });
  }

  if (reasons.some((reason) => reason.code === "VERIFY_FAILED" || reason.code === "PUBLIC_SAFETY_FINDINGS")) {
    return { status: "blocked", reasons };
  }

  if (reasons.length > 0) {
    return { status: "local_only", reasons };
  }

  return { status: "share_ready", reasons: [] };
}

// The promptDigest convention: sha256 hex, first 16 chars. A "seeded" record without a real
// digest cannot pin "same recipe" across bundles, so verify treats it as a hollow claim.
const COMMAND_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
// Env var NAME shape (mirrors lab-config's ENV_NAME_PATTERN). externalEnvNames must hold
// NAMES only — a value sneaking into the list trips this check (a free secret tripwire).
const SUBJECT_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * The `subject state provenance` check (invariant 5 + invariant 4): a bundle's subject CLAIM
 * must match its recorded evidence. Bundles without a subject block (all pre-existing and
 * non-cua bundles) pass untouched. Live-vs-dry-run is judged from bundle.mode, exactly like
 * noEngagementActorFindings. Covers both the state story (seed/external) and, for the
 * local-tree route, the archive content pin.
 */
function subjectStateFindings(bundle: RunBundle): string[] {
  const subject = bundle.subject;
  if (subject === undefined) {
    return [];
  }

  const findings: string[] = [];
  const state = subject.state;
  const seed = state.seed ?? [];
  const live = bundle.mode === "live";

  // Local-tree fail-closed pin: a LIVE local-tree subject must carry a well-formed archive
  // digest -- a dirty tree cannot be commit-pinned, so archiveSha256 is the only content pin
  // this route has. Mirrors the seeded-on-dry-run discriminator immediately below: judged by
  // bundle.mode, never by the presence/shape of other fields. Never echoes the malformed value
  // (it could itself be a leaked value, same discipline as the externalEnvNames check below).
  if (live && subject.source === "local-tree") {
    // Note: a malformed-but-present string is already rejected upstream by the
    // isRunSubjectProvenance shape gate, so in practice this branch fires for the
    // MISSING case; the pattern re-check stays as defense in depth for callers
    // that bypass the schema gate.
    const pin = (subject as { archiveSha256?: unknown }).archiveSha256;
    if (typeof pin !== "string" || !ARCHIVE_SHA256_PATTERN.test(pin)) {
      findings.push("subject.source is local-tree on a live run but archiveSha256 is missing or malformed (a local-tree subject must carry a well-formed 64-hex archive digest)");
    }
  }

  // Marker-independent rule: a passed LIVE run can never ride on a seed step that did not
  // complete ok (closes the hollow-seeded × unpinned hole — an unpinned bundle still carries
  // its seed records, and a failed migration must not hide behind the external marker).
  if (live && bundle.review.verdict === "pass" && seed.some((record) => record.ok !== true)) {
    findings.push("review verdict is pass but a recorded seed step did not complete ok — a passed live run cannot carry failed or unexecuted state steps");
  }

  switch (state.provenance) {
    case "seeded": {
      if (!live) {
        findings.push('state marker "seeded" on a dry-run bundle — a contract bundle cannot claim executed state');
      }
      if (seed.length === 0) {
        findings.push('state marker "seeded" with zero seed step records is a hollow state claim');
      }
      for (const record of seed) {
        if (!COMMAND_DIGEST_PATTERN.test(record.commandDigest)) {
          findings.push(`seed step "${record.name}" lacks a sha256-16 commandDigest`);
        }
        if (live && record.ok !== true) {
          findings.push(`state marker "seeded" but step "${record.name}" did not complete ok`);
        }
      }
      break;
    }
    case "unpinned": {
      const externalEnvNames = state.externalEnvNames ?? [];
      if (externalEnvNames.length === 0) {
        findings.push('state marker "unpinned" requires non-empty externalEnvNames (the declaration must name the external channel)');
      }
      for (const name of externalEnvNames) {
        if (!SUBJECT_ENV_NAME_PATTERN.test(name)) {
          // Deliberately does NOT echo the entry: a malformed entry may BE a value.
          findings.push("externalEnvNames carries an entry that is not an env var NAME shape (values must never appear in evidence)");
        }
      }
      break;
    }
    case "declared-not-run": {
      if (live && bundle.review.verdict === "pass") {
        findings.push("a passed live run cannot claim its declared seed steps did not run (state marker \"declared-not-run\")");
      }
      break;
    }
    case "undeclared":
      break;
    case "external-public": {
      // #164 phase 2: an operator-declared, operator-owned public deployment humanish neither
      // provisioned nor seeded. There is no in-sandbox state story — a seed record or an external
      // channel here would contradict the "no subject sandbox" invariant of this plane class.
      if (subject.source !== "app-url") {
        findings.push('state marker "external-public" requires subject.source "app-url" — the external-public plane is a real public deployment, not a clone/local-tree subject');
      }
      if (seed.length > 0) {
        findings.push('state marker "external-public" cannot carry seed step records — the external-public plane is neither provisioned nor seeded by the harness');
      }
      if ((state.externalEnvNames ?? []).length > 0) {
        findings.push('state marker "external-public" cannot carry externalEnvNames — the plane is operator-owned, not an uncontrolled external channel');
      }
      break;
    }
    default:
      findings.push("unknown subject state provenance marker");
  }

  return findings;
}

function rerunLineageFindings(bundle: RunBundle): string[] {
  const rerun = bundle.rerun;
  if (!rerun) {
    return [];
  }

  const findings: string[] = [];
  const selectedLaneIds = rerun.selectedLaneIds;
  const selectedSet = new Set(selectedLaneIds);
  const previousLaneIds = rerun.previous.map((entry) => entry.laneId);
  const previousSet = new Set(previousLaneIds);
  const currentLaneIds = bundle.streams.map((stream) => stream.laneId);
  const currentConcreteLaneIds = currentLaneIds.filter((laneId): laneId is string =>
    typeof laneId === "string" && laneId.trim().length > 0
  );
  const currentSet = new Set(currentConcreteLaneIds);

  if (selectedSet.size !== selectedLaneIds.length) {
    findings.push("selectedLaneIds contains duplicate lane ids");
  }
  if (previousSet.size !== previousLaneIds.length) {
    findings.push("previous contains duplicate lane ids");
  }
  if (currentConcreteLaneIds.length !== bundle.streams.length) {
    findings.push("every rerun stream must carry a laneId");
  }
  for (const laneId of selectedLaneIds) {
    if (!previousSet.has(laneId)) {
      findings.push(`selected lane ${laneId} is missing prior status`);
    }
    if (!currentSet.has(laneId)) {
      findings.push(`selected lane ${laneId} is missing from current streams`);
    }
  }
  for (const laneId of previousLaneIds) {
    if (!selectedSet.has(laneId)) {
      findings.push(`previous lane ${laneId} was not selected`);
    }
  }
  for (const laneId of currentConcreteLaneIds) {
    if (!selectedSet.has(laneId)) {
      findings.push(`current stream lane ${laneId} was not selected`);
    }
  }
  if (!bundle.events.some((event) => event.type === "cua-lab.fanout.rerun")) {
    findings.push("missing cua-lab.fanout.rerun event");
  }

  return findings;
}

/**
 * Verify the LABELING/provenance of any cost figure a bundle CLAIMS — never its magnitude. Returns
 * [] (pass) unless a dollar claim lacks its provenance (invariant 6) or a total misreports its
 * known lines. ABSENCE always passes (fail-open on display, discipline #3): a bundle with no cost,
 * a null estimate, or a lane without estimatedCost is fine. A NON-NULL figure must carry its
 * ratesAsOf date + source; a NUMBER total must equal round6(sum of ONLY the non-null lines) and a
 * null line may never be coerced to 0. A null estimate must be declared honestly (a reason + null
 * ratesAsOf), mirroring the terminal no-spend proof's null-discipline.
 */
function costLabelingFindings(bundle: RunBundle): string[] {
  const findings: string[] = [];

  const cost = bundle.cost;
  if (cost) {
    if (cost.schema !== "humanish.run-cost-summary.v1") {
      findings.push(`run cost summary schema is ${String(cost.schema)}, expected humanish.run-cost-summary.v1`);
    }
    let knownSum = 0;
    let anyKnown = false;
    for (const [index, line] of (cost.breakdown ?? []).entries()) {
      if (line.estimatedCostUsd === null) {
        continue;
      }
      anyKnown = true;
      knownSum += line.estimatedCostUsd;
      if (typeof line.ratesAsOf !== "string" || line.ratesAsOf.length === 0) {
        findings.push(`cost breakdown line ${index} (${line.kind}) claims $${line.estimatedCostUsd} without a ratesAsOf date`);
      }
      if (typeof line.source !== "string" || line.source.length === 0) {
        findings.push(`cost breakdown line ${index} (${line.kind}) claims $${line.estimatedCostUsd} without a pricing source`);
      }
    }
    if (cost.estimatedTotalUsd !== null) {
      if (typeof cost.ratesAsOf !== "string" || cost.ratesAsOf.length === 0) {
        findings.push("run cost summary claims a number estimatedTotalUsd without a ratesAsOf date");
      }
      if (round6(cost.estimatedTotalUsd) !== round6(knownSum)) {
        findings.push(`run cost estimatedTotalUsd ${cost.estimatedTotalUsd} does not equal the sum of its known breakdown lines (${round6(knownSum)})`);
      }
    } else if (anyKnown) {
      // Every-line-null is the only honest null total; a null total beside a known line hides spend.
      findings.push("run cost estimatedTotalUsd is null but a breakdown line carries a known (non-null) cost");
    }
  }

  for (const stream of bundle.streams) {
    const estimate = stream.actor?.estimatedCost;
    if (!estimate) {
      continue;
    }
    const laneLabel = stream.laneId ?? stream.id;
    if (estimate.schema !== "humanish.actor-estimated-cost.v1") {
      findings.push(`lane ${laneLabel} actor estimatedCost schema is ${String(estimate.schema)}, expected humanish.actor-estimated-cost.v1`);
    }
    if (estimate.estimatedCostUsd !== null) {
      if (typeof estimate.ratesAsOf !== "string" || estimate.ratesAsOf.length === 0) {
        findings.push(`lane ${laneLabel} claims a model-token cost $${estimate.estimatedCostUsd} without a ratesAsOf date`);
      }
      if (typeof estimate.source !== "string" || estimate.source.length === 0) {
        findings.push(`lane ${laneLabel} claims a model-token cost $${estimate.estimatedCostUsd} without a pricing source`);
      }
    } else {
      // Declared-absent honesty (invariant 5): a null estimate must say WHY and carry null ratesAsOf.
      if (estimate.reason === undefined) {
        findings.push(`lane ${laneLabel} records a null cost estimate without a reason`);
      }
      if (estimate.ratesAsOf !== null) {
        findings.push(`lane ${laneLabel} records a null cost estimate but carries a non-null ratesAsOf`);
      }
    }
  }

  return findings;
}

// SEQUENTIAL: the three disclosures a sequential shared-world bundle MUST pin (verify fails closed
// if any is absent — omission overclaims): sequential turns only, no concurrency/races handled, and
// a checkpoint delta is attributed to the TURN it followed, not a specific action (correlation).
const MANDATORY_ATTRIBUTION_LIMITS = [
  "sequential-only",
  "no-concurrent-races",
  "delta-attributed-to-turn-not-action"
] as const;

// CONCURRENT (#164 phase 2, FIX-5): the REQUIRED set (all must be present) AND a FORBIDDEN set (any
// present == a sequential claim leaking into a concurrent bundle == overclaim). verify needs BOTH
// checks — presence-only would let an incoherent union pass.
const CONCURRENT_REQUIRED_LIMITS = [
  "concurrent",
  "best-effort-causal-attribution",
  "non-deterministic-shared-state",
  "window-and-snapshot-granularity",
  "contention-observed-not-proven-safe",
  "state-change-not-isolated-to-actors"
] as const;
const CONCURRENT_FORBIDDEN_LIMITS = ["sequential-only", "no-concurrent-races"] as const;

// EXTERNAL-PUBLIC plane class (#164 phase 2): the honest-downgrade required set. Keeps the concurrent
// family (an honest ceiling) AND adds the mandatory disclosures for a plane the harness does NOT own:
// the operator-attested (not harness-controlled) target, the ABSENCE of a synthetic attestation (you
// cannot claim synthetic on a real site), the ABSENCE of an authoritative shared-state proof (no
// in-sandbox filesystem to digest), and concurrency evidenced by temporal co-occupancy ONLY. Verify
// FAILS CLOSED if any is missing (an absent honest-downgrade limit overclaims) — invariant 5.
const EXTERNAL_PUBLIC_EXTRA_LIMITS = [
  "external-public-plane",
  "operator-attested-target-not-harness-controlled",
  "no-synthetic-attestation",
  "no-authoritative-shared-state-proof",
  "concurrency-by-temporal-co-occupancy-only"
] as const;
// Any seeded/synthetic limit on this class is a getHost claim leaking onto a real public site — forbid
// it alongside the sequential family. (A synthetic attestation on a plane the harness did not seed is a lie.)
const EXTERNAL_PUBLIC_FORBIDDEN_LIMITS = ["sequential-only", "no-concurrent-races", "seeded", "synthetic"] as const;

// A shared-world checkpoint record persists DIGEST-ONLY: exactly these keys, nothing value-shaped.
const SHARED_WORLD_CHECKPOINT_KEYS = new Set(["kind", "name", "digest", "deltaFromPrev"]);
// CONCURRENT stateSeries record is DIGEST-ONLY too (FIX-7): permit ONLY a numeric timestamp + the
// sha256-16 digest; any other key is a value-shaped leak / a smuggled per-delta→actor field.
const SHARED_WORLD_STATESERIES_KEYS = new Set(["timestamp", "digest"]);

/**
 * The `shared-world evidence` check (#164; invariant 4 + invariant 6): a LIVE shared-world bundle's
 * interaction CLAIM must match its recorded timeline + plane provenance, and its attribution
 * ceiling must be pinned. Mirrors validateTerminalProductEvidence: live-only (dry-run contract
 * bundles are skipped, exactly like the other live-only checks). Fail-closed on every overclaim.
 */
function sharedWorldEvidenceFindings(bundle: RunBundle): string[] {
  if (bundle.mode !== "live") {
    return [];
  }
  const sw = bundle.sharedWorld;
  if (!sw) {
    // A live bundle that DECLARES shared-world attribution but carries no evidence block is a
    // hollow claim — fail closed. (Absent attributionClass + absent block == an ordinary bundle.)
    return bundle.attributionClass === "shared-world"
      ? ["attributionClass is shared-world but the sharedWorld evidence block is missing"]
      : [];
  }
  // FIX-8: dispatch on topologyMode FIRST; unknown/missing → fail closed.
  const topologyMode = (sw as { topologyMode?: unknown }).topologyMode;
  if (topologyMode === "sequential") {
    return sequentialSharedWorldFindings(bundle, sw);
  }
  if (topologyMode === "concurrent") {
    return concurrentSharedWorldFindings(bundle, sw);
  }
  return ['sharedWorld.topologyMode must be "sequential" or "concurrent" (missing/unknown → fail closed)'];
}

/** Common shape findings shared by both topologyMode branches. */
function sharedWorldCommonFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = [];
  if (sw.schema !== SHARED_WORLD_SCHEMA) {
    findings.push(`sharedWorld.schema must be ${SHARED_WORLD_SCHEMA}`);
  }
  if (bundle.attributionClass !== "shared-world") {
    findings.push("a sharedWorld evidence block requires attributionClass: shared-world");
  }
  const plane = sw.plane;
  if (!isRecord(plane) || typeof plane.seedDigest !== "string" || !COMMAND_DIGEST_PATTERN.test(plane.seedDigest)) {
    findings.push("sharedWorld.plane.seedDigest must be a sha256-16 value");
  }
  if (isRecord(plane) && Array.isArray(plane.envNames)) {
    for (const name of plane.envNames) {
      if (typeof name !== "string" || !SUBJECT_ENV_NAME_PATTERN.test(name)) {
        // Does NOT echo the entry: a malformed entry may BE a value.
        findings.push("sharedWorld.plane.envNames carries an entry that is not an env var NAME shape (values must never appear in evidence)");
      }
    }
  }
  return findings;
}

/**
 * SEQUENTIAL branch (the PoC #164): the alternating timeline must be well-formed, single-plane,
 * digest-only, and carry the sequential attributionLimits. FIX-8: a sequential bundle must NOT
 * carry concurrent fields (laneWindows).
 */
function sequentialSharedWorldFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);
  // Read the raw record so an injected value-shaped field on a checkpoint is visible (the typed
  // view would hide unexpected keys).
  const rawTimeline: unknown[] = Array.isArray((sw as { timeline?: unknown }).timeline)
    ? ((sw as { timeline: unknown[] }).timeline)
    : [];
  if (!Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push("a sequential shared-world bundle must carry a timeline");
  }
  if (Array.isArray((sw as { laneWindows?: unknown }).laneWindows)) {
    findings.push("a sequential shared-world bundle must NOT carry concurrent laneWindows (topologyMode mismatch)");
  }
  const sequence = Array.isArray(sw.sequence) ? sw.sequence : [];

  // Attribution ceiling: every mandatory limit MUST be present (omission overclaims → fail).
  const limits = Array.isArray(sw.attributionLimits) ? sw.attributionLimits : [];
  for (const required of MANDATORY_ATTRIBUTION_LIMITS) {
    if (!limits.includes(required)) {
      findings.push(`attributionLimits is missing the mandatory disclosure "${required}" — an absent ceiling overclaims`);
    }
  }

  const checkpoints = rawTimeline.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.kind === "checkpoint");
  const turns = rawTimeline.filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.kind === "turn");

  // Phantom/dropped role: sequence length == roleCount == executed-turn count.
  if (!(sequence.length === sw.roleCount && turns.length === sw.roleCount)) {
    findings.push(`phantom/dropped role: sequence length (${sequence.length}), roleCount (${sw.roleCount}), and timeline turn count (${turns.length}) must all match`);
  }

  // Timeline well-formed: starts with cp-baseline, strictly alternates checkpoint → turn →
  // checkpoint, ends on a checkpoint, and turn order == sequence.
  if (rawTimeline.length === 0) {
    findings.push("timeline is empty");
  } else {
    const first = rawTimeline[0];
    if (!isRecord(first) || first.kind !== "checkpoint" || first.name !== "cp-baseline") {
      findings.push('timeline must start with the "cp-baseline" checkpoint');
    }
    const last = rawTimeline[rawTimeline.length - 1];
    if (!isRecord(last) || last.kind !== "checkpoint") {
      findings.push("timeline must end on a checkpoint");
    }
    rawTimeline.forEach((entry, index) => {
      const expected = index % 2 === 0 ? "checkpoint" : "turn";
      if (!isRecord(entry) || entry.kind !== expected) {
        findings.push(`timeline must strictly alternate checkpoint → turn → checkpoint (index ${index} is not a ${expected})`);
      }
    });
    if (rawTimeline.length !== 1 + 2 * turns.length) {
      findings.push("timeline length must be 1 baseline checkpoint + 2 entries (turn + checkpoint) per role");
    }
  }
  turns.forEach((turn, index) => {
    if (turn.roleId !== sequence[index]) {
      findings.push(`turn order does not match the declared sequence at position ${index} (turn "${String(turn.roleId)}" vs sequence "${String(sequence[index])}")`);
    }
  });

  // Checkpoints: digest is sha256-16 and the record carries NO value-shaped field (digest-only).
  for (const checkpoint of checkpoints) {
    const name = typeof checkpoint.name === "string" ? checkpoint.name : "(unnamed)";
    if (typeof checkpoint.digest !== "string" || !COMMAND_DIGEST_PATTERN.test(checkpoint.digest)) {
      findings.push(`checkpoint "${name}" digest is not a sha256-16 value (a value-shaped checkpoint field is rejected)`);
    }
    for (const key of Object.keys(checkpoint)) {
      if (!SHARED_WORLD_CHECKPOINT_KEYS.has(key)) {
        findings.push(`checkpoint "${name}" carries an unexpected field "${key}" — checkpoints persist digest-only`);
      }
    }
  }

  // Turns: simId/streamId resolve to a real sim/stream.
  for (const turn of turns) {
    const roleId = typeof turn.roleId === "string" ? turn.roleId : "(unnamed)";
    if (!bundle.simulations.some((sim) => sim.id === turn.simId)) {
      findings.push(`turn "${roleId}" references unknown simId "${String(turn.simId)}"`);
    }
    if (!bundle.streams.some((stream) => stream.id === turn.streamId)) {
      findings.push(`turn "${roleId}" references unknown streamId "${String(turn.streamId)}"`);
    }
  }

  // Single-plane provenance: every turn shares ONE (commit, seedDigest), matching sharedWorld.plane.
  // (plane.seedDigest + plane.envNames shape are checked in sharedWorldCommonFindings.)
  const plane = sw.plane;
  const planeKeys = new Set(turns.map((turn) => `${String(turn.commit ?? "")}::${String(turn.seedDigest ?? "")}`));
  if (planeKeys.size > 1) {
    findings.push("turns reference divergent plane provenance (commit/seedDigest) — a shared-world run drives ONE plane");
  }
  if (isRecord(plane)) {
    for (const turn of turns) {
      if (String(turn.seedDigest ?? "") !== String(plane.seedDigest ?? "")
        || String(turn.commit ?? "") !== String(plane.commit ?? "")) {
        const roleId = typeof turn.roleId === "string" ? turn.roleId : "(unnamed)";
        findings.push(`turn "${roleId}" plane provenance diverges from sharedWorld.plane`);
        break;
      }
    }
  }

  // The delta-on-pass gate: a PASSED shared-world run MUST show at least one checkpoint delta —
  // otherwise the roles never interacted through shared state and the claim is hollow.
  if (bundle.review.verdict === "pass" && !checkpoints.some((checkpoint) => checkpoint.deltaFromPrev === true)) {
    findings.push("review verdict is pass but no checkpoint shows deltaFromPrev — the interaction is hollow (no observed shared-state change)");
  }

  return findings;
}

/**
 * CONCURRENT branch (#164 phase 2): N personas drove ONE getHost-exposed plane at once. Verify
 * fail-closed: the shape (laneWindows + stateSeries + outcomes, NO timeline — FIX-8); the
 * corrected required + forbidden attributionLimits (FIX-5); the harness-minted getHost target every
 * actor drove (FIX-2); the synthetic-subject provenance gate (FIX-3); digest-only state series with
 * the allowed-keys tripwire (FIX-7); single-plane provenance; and the concurrency-on-pass gate
 * (genuine overlap + a state delta AT/AFTER an overlap start — FIX-6).
 */
function concurrentSharedWorldFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  // The PLANE-class discriminator (#164 phase 2). Absent == the historical provisioned-getHost plane
  // (byte-stable). EVERY getHost-specific assertion (hostDigest, exposure: synthetic, seeded
  // provenance, state-delta on pass) is gated on this — it never leaks onto the external-public class,
  // and the external-public assertions never leak onto getHost.
  const planeClass = (sw as { planeClass?: unknown }).planeClass;
  if (planeClass === "external-public") {
    return externalPublicConcurrentFindings(bundle, sw);
  }
  if (planeClass !== undefined && planeClass !== "provisioned-getHost") {
    return [
      ...sharedWorldCommonFindings(bundle, sw),
      `sharedWorld.planeClass must be "provisioned-getHost" or "external-public" (got "${String(planeClass)}")`
    ];
  }
  return provisionedGetHostConcurrentFindings(bundle, sw);
}

/**
 * PROVISIONED-getHost concurrent branch (the historical plane; #164 phase 2): a clone/local-tree
 * subject served + getHost-exposed in-sandbox — the harness MINTED the host, so it asserts the
 * synthetic-seeded attestation, the harness-minted host identity, and an authoritative in-sandbox
 * checkpoint state-delta on pass. UNCHANGED from the pre-external-public verify (byte-stable).
 */
function provisionedGetHostConcurrentFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);

  // FIX-8: shape coherence — concurrent carries laneWindows/stateSeries/outcomes, NOT a timeline.
  if (Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push("a concurrent shared-world bundle must NOT carry a sequential timeline (topologyMode mismatch)");
  }
  const laneWindows = Array.isArray(sw.laneWindows) ? (sw.laneWindows as unknown[]).filter(isRecord) : null;
  const stateSeries = Array.isArray(sw.stateSeries) ? (sw.stateSeries as unknown[]).filter(isRecord) : null;
  const outcomes = Array.isArray(sw.outcomes) ? (sw.outcomes as unknown[]).filter(isRecord) : null;
  if (laneWindows === null) findings.push("a concurrent shared-world bundle must carry laneWindows");
  if (stateSeries === null) findings.push("a concurrent shared-world bundle must carry stateSeries");
  if (outcomes === null) findings.push("a concurrent shared-world bundle must carry outcomes");
  if (laneWindows === null || stateSeries === null || outcomes === null) {
    return findings; // can't reason further without the core series
  }

  // FIX-5: required limits all present AND forbidden limits all absent.
  const limits = Array.isArray(sw.attributionLimits) ? sw.attributionLimits : [];
  for (const required of CONCURRENT_REQUIRED_LIMITS) {
    if (!limits.includes(required)) {
      findings.push(`attributionLimits is missing the mandatory concurrent disclosure "${required}" — an absent ceiling overclaims`);
    }
  }
  for (const forbidden of CONCURRENT_FORBIDDEN_LIMITS) {
    if (limits.includes(forbidden)) {
      findings.push(`attributionLimits carries the forbidden disclosure "${forbidden}" — a concurrent run cannot claim a sequential guarantee`);
    }
  }

  // Phantom/dropped role: laneWindows + outcomes each cover exactly roleCount (actors are
  // INDEPENDENT — none are blocked by another, so all N produce a window + outcome).
  if (laneWindows.length !== sw.roleCount) {
    findings.push(`phantom/dropped role: laneWindows count (${laneWindows.length}) must equal roleCount (${sw.roleCount})`);
  }
  if (outcomes.length !== sw.roleCount) {
    findings.push(`phantom/dropped role: outcomes count (${outcomes.length}) must equal roleCount (${sw.roleCount})`);
  }

  // laneWindows: numeric well-ordered windows; sim/stream resolve; route-host digest present.
  for (const window of laneWindows) {
    const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
    const startedAt = window.startedAt;
    const endedAt = window.endedAt;
    if (typeof startedAt !== "number" || typeof endedAt !== "number" || !(startedAt <= endedAt)) {
      findings.push(`laneWindow "${roleId}" must carry numeric startedAt <= endedAt on one clock`);
    }
    if (typeof window.routeHostDigest !== "string" || !COMMAND_DIGEST_PATTERN.test(window.routeHostDigest)) {
      findings.push(`laneWindow "${roleId}" must record a sha256-16 routeHostDigest of the host it drove`);
    }
    if (!bundle.simulations.some((sim) => sim.id === window.simId)) {
      findings.push(`laneWindow "${roleId}" references unknown simId "${String(window.simId)}"`);
    }
    if (!bundle.streams.some((stream) => stream.id === window.streamId)) {
      findings.push(`laneWindow "${roleId}" references unknown streamId "${String(window.streamId)}"`);
    }
  }

  // FIX-2: the harness-minted getHost target. plane.hostDigest present (sha256-16) + every actor's
  // routeHostDigest equals it (every actor drove EXACTLY the harness-minted host — invariant 2).
  const plane: Record<string, unknown> = isRecord(sw.plane) ? sw.plane : {};
  const hostDigest = typeof plane.hostDigest === "string" ? plane.hostDigest : undefined;
  if (!hostDigest || !COMMAND_DIGEST_PATTERN.test(hostDigest)) {
    findings.push("sharedWorld.plane.hostDigest (sha256-16 of the harness-minted getHost origin) is required on the concurrent route");
  } else {
    for (const window of laneWindows) {
      const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
      if (typeof window.routeHostDigest === "string" && window.routeHostDigest !== hostDigest) {
        findings.push(`laneWindow "${roleId}" drove a host that differs from the harness-minted plane.hostDigest (invariant 2)`);
      }
    }
  }

  // FIX-3: synthetic-subject provenance gate (a getHost URL is internet-reachable; real/external
  // data behind it is the hazard). Author attestation + a seeded provenance check.
  if (plane.exposure !== "synthetic") {
    findings.push('sharedWorld.plane.exposure must be "synthetic" — the getHost route requires the author attestation that the subject is synthetic seeded data (author-trust + provenance gate, not a no-real-data guarantee)');
  }
  if (bundle.subject?.state.provenance !== "seeded") {
    findings.push(`the concurrent getHost route requires subject.state.provenance == "seeded" (got "${bundle.subject?.state.provenance ?? "absent"}") — external/unpinned/undeclared data behind an internet-reachable URL is rejected`);
  }

  // Single-plane provenance: every laneWindow shares ONE (commit, seedDigest) matching plane.
  const planeKeys = new Set(laneWindows.map((window) => `${String(window.commit ?? "")}::${String(window.seedDigest ?? "")}`));
  if (planeKeys.size > 1) {
    findings.push("laneWindows reference divergent plane provenance (commit/seedDigest) — a concurrent run drives ONE plane");
  }
  for (const window of laneWindows) {
    if (String(window.seedDigest ?? "") !== String(plane.seedDigest ?? "")
      || String(window.commit ?? "") !== String(plane.commit ?? "")) {
      const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
      findings.push(`laneWindow "${roleId}" plane provenance diverges from sharedWorld.plane`);
      break;
    }
  }

  // FIX-7: stateSeries is DIGEST-ONLY with the allowed-keys tripwire (no per-delta→actor field).
  for (const snapshot of stateSeries) {
    if (typeof snapshot.timestamp !== "number") {
      findings.push("a stateSeries snapshot must carry a numeric timestamp");
    }
    if (typeof snapshot.digest !== "string" || !COMMAND_DIGEST_PATTERN.test(snapshot.digest)) {
      findings.push("a stateSeries snapshot digest is not a sha256-16 value (a value-shaped field is rejected)");
    }
    for (const key of Object.keys(snapshot)) {
      if (!SHARED_WORLD_STATESERIES_KEYS.has(key)) {
        findings.push(`a stateSeries snapshot carries an unexpected field "${key}" — the series is digest-only (no per-delta attribution)`);
      }
    }
  }

  // The concurrency-on-pass gate (FIX-6): a PASSED concurrent run MUST show genuine overlap (≥2
  // laneWindows overlapping in time) AND a stateSeries delta whose timestamp is AT/AFTER the start
  // of an overlap interval — otherwise it was not actually concurrent, or the world never changed
  // under contention (a hollow concurrent claim).
  if (bundle.review.verdict === "pass") {
    const overlapStarts: number[] = [];
    for (let i = 0; i < laneWindows.length; i += 1) {
      for (let j = i + 1; j < laneWindows.length; j += 1) {
        const a = laneWindows[i]!;
        const b = laneWindows[j]!;
        const aStart = a.startedAt as number;
        const aEnd = a.endedAt as number;
        const bStart = b.startedAt as number;
        const bEnd = b.endedAt as number;
        if (typeof aStart === "number" && typeof aEnd === "number" && typeof bStart === "number" && typeof bEnd === "number"
          && aStart < bEnd && bStart < aEnd) {
          overlapStarts.push(Math.max(aStart, bStart));
        }
      }
    }
    if (overlapStarts.length === 0) {
      findings.push("review verdict is pass but no two laneWindows overlap in time — the run was not actually concurrent");
    } else {
      const earliestOverlapStart = Math.min(...overlapStarts);
      const sorted = [...stateSeries]
        .map((snapshot) => ({ timestamp: snapshot.timestamp as number, digest: String(snapshot.digest) }))
        .filter((snapshot) => typeof snapshot.timestamp === "number")
        .sort((x, y) => x.timestamp - y.timestamp);
      let deltaInWindow = false;
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i]!.digest !== sorted[i - 1]!.digest && sorted[i]!.timestamp >= earliestOverlapStart) {
          deltaInWindow = true;
          break;
        }
      }
      if (!deltaInWindow) {
        findings.push("review verdict is pass but no stateSeries delta occurs at/after an overlap interval start — the shared world did not change under concurrent load (hollow concurrent claim)");
      }
    }
  }

  return findings;
}

/**
 * EXTERNAL-PUBLIC concurrent branch (#164 phase 2): N seats drove ONE real operator-owned public
 * deployment at once. The honest evidence class for a plane the harness does NOT own. Verify
 * fail-closed on the honest DOWNGRADES (asserted-absent, never silently dropped): provenance is
 * "external-public" (NOT seeded), exposure is ABSENT (claiming synthetic on a real site is a lie),
 * plane control is operator-attested (publicOriginDigest, not a harness-minted hostDigest), there is
 * NO authoritative shared-state proof (stateSeries omitted — option A), and concurrency is proven by
 * temporal co-occupancy ONLY (relaxed concurrency-on-pass: ≥2 overlapping windows, no state delta).
 * Every getHost-only claim (exposure: synthetic / plane.hostDigest / seeded / synthetic limit)
 * appearing here FAILS CLOSED.
 */
function externalPublicConcurrentFindings(bundle: RunBundle, sw: SharedWorldEvidence): string[] {
  const findings: string[] = sharedWorldCommonFindings(bundle, sw);

  // Shape coherence: concurrent carries laneWindows + outcomes, NOT a timeline. stateSeries is
  // deliberately OMITTED on this class (no in-sandbox filesystem to authoritatively digest).
  if (Array.isArray((sw as { timeline?: unknown }).timeline)) {
    findings.push("an external-public concurrent bundle must NOT carry a sequential timeline (topologyMode mismatch)");
  }
  const laneWindows = Array.isArray(sw.laneWindows) ? (sw.laneWindows as unknown[]).filter(isRecord) : null;
  const outcomes = Array.isArray(sw.outcomes) ? (sw.outcomes as unknown[]).filter(isRecord) : null;
  if (laneWindows === null) findings.push("an external-public concurrent bundle must carry laneWindows");
  if (outcomes === null) findings.push("an external-public concurrent bundle must carry outcomes");
  // Option A: NO authoritative shared-state proof — a non-empty stateSeries would falsely imply the
  // harness digested the plane's backend state (it cannot; there is no in-sandbox filesystem).
  const stateSeries = (sw as { stateSeries?: unknown }).stateSeries;
  if (Array.isArray(stateSeries) && stateSeries.length > 0) {
    findings.push("an external-public concurrent bundle must NOT carry a stateSeries — the harness cannot authoritatively digest a real public plane's backend state (no in-sandbox filesystem); concurrency is proven by temporal co-occupancy, not a state series");
  }
  if (laneWindows === null || outcomes === null) {
    return findings; // can't reason further without the core series
  }

  // Attribution ceiling: the concurrent family AND every external-public honest-downgrade disclosure
  // must be present; the sequential family + any seeded/synthetic limit must be absent.
  const limits = Array.isArray(sw.attributionLimits) ? sw.attributionLimits : [];
  for (const required of [...CONCURRENT_REQUIRED_LIMITS, ...EXTERNAL_PUBLIC_EXTRA_LIMITS]) {
    if (!limits.includes(required)) {
      findings.push(`attributionLimits is missing the mandatory external-public disclosure "${required}" — an absent honest-downgrade ceiling overclaims`);
    }
  }
  for (const forbidden of EXTERNAL_PUBLIC_FORBIDDEN_LIMITS) {
    if (limits.includes(forbidden)) {
      findings.push(`attributionLimits carries the forbidden disclosure "${forbidden}" — the external-public plane cannot claim a sequential guarantee or a seeded/synthetic attestation on a real site`);
    }
  }

  // Phantom/dropped role: laneWindows + outcomes each cover exactly roleCount.
  if (laneWindows.length !== sw.roleCount) {
    findings.push(`phantom/dropped role: laneWindows count (${laneWindows.length}) must equal roleCount (${sw.roleCount})`);
  }
  if (outcomes.length !== sw.roleCount) {
    findings.push(`phantom/dropped role: outcomes count (${outcomes.length}) must equal roleCount (${sw.roleCount})`);
  }

  // laneWindows: numeric well-ordered windows; sim/stream resolve; route-host digest present.
  for (const window of laneWindows) {
    const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
    if (typeof window.startedAt !== "number" || typeof window.endedAt !== "number" || !((window.startedAt as number) <= (window.endedAt as number))) {
      findings.push(`laneWindow "${roleId}" must carry numeric startedAt <= endedAt on one clock`);
    }
    if (typeof window.routeHostDigest !== "string" || !COMMAND_DIGEST_PATTERN.test(window.routeHostDigest)) {
      findings.push(`laneWindow "${roleId}" must record a sha256-16 routeHostDigest of the origin it reached`);
    }
    if (!bundle.simulations.some((sim) => sim.id === window.simId)) {
      findings.push(`laneWindow "${roleId}" references unknown simId "${String(window.simId)}"`);
    }
    if (!bundle.streams.some((stream) => stream.id === window.streamId)) {
      findings.push(`laneWindow "${roleId}" references unknown streamId "${String(window.streamId)}"`);
    }
  }

  // Plane identity (the honest analog of invariant 2, WEAKER + disclosed): the convergence proof is
  // about what the seats OBSERVED, not what was DECLARED. plane.publicOriginDigest is the OBSERVED
  // origin the seats converged on; verify requires every seat's CDP-OBSERVED routeHostDigest to agree
  // on ONE origin, and that publicOriginDigest BE that origin. Convergence on one observed origin proves
  // inter-seat co-location — NOT harness control of the plane. IMPORTANT: operator OWNERSHIP rests on
  // the subject.publicTarget.authorized attestation + the declared appUrl, NOT on digest equality — a
  // normal cross-origin redirect (apex->www, http->https) makes the observed origin differ from the
  // DECLARED one, which is expected and must NEVER fail verify (declaredOriginDigest is evidence-only).
  const plane: Record<string, unknown> = isRecord(sw.plane) ? sw.plane : {};
  const publicOriginDigest = typeof plane.publicOriginDigest === "string" ? plane.publicOriginDigest : undefined;
  if (!publicOriginDigest || !COMMAND_DIGEST_PATTERN.test(publicOriginDigest)) {
    findings.push("sharedWorld.plane.publicOriginDigest (sha256-16 of the OBSERVED origin the seats converged on) is required on the external-public plane class");
  }
  // The observed origins across seats must agree on exactly ONE (that agreement IS the convergence).
  const observedOrigins = laneWindows
    .map((window) => (typeof window.routeHostDigest === "string" ? window.routeHostDigest : undefined))
    .filter((digest): digest is string => digest !== undefined);
  const distinctObserved = [...new Set(observedOrigins)];
  if (distinctObserved.length > 1) {
    findings.push(`the seats did not converge on ONE OBSERVED origin — distinct observed origin digests: ${distinctObserved.join(", ")}`);
  } else if (publicOriginDigest && distinctObserved.length === 1 && distinctObserved[0] !== publicOriginDigest) {
    findings.push(`sharedWorld.plane.publicOriginDigest (${publicOriginDigest}) must equal the single OBSERVED origin the seats converged on (${distinctObserved[0]})`);
  }
  // declaredOriginDigest is recorded for evidence ONLY. Validate its shape when present, but NEVER
  // assert it equals the observed origin — a cross-origin redirect is normal and expected.
  if (plane.declaredOriginDigest !== undefined
    && (typeof plane.declaredOriginDigest !== "string" || !COMMAND_DIGEST_PATTERN.test(plane.declaredOriginDigest))) {
    findings.push("sharedWorld.plane.declaredOriginDigest, when present, must be a sha256-16 digest of the operator-declared origin (evidence-only; not asserted equal to the observed origin)");
  }

  // INVERT the getHost gate: exposure MUST be absent (claiming synthetic on a real site is a lie) and
  // the harness-minted hostDigest MUST be absent (the harness minted no host here).
  if (plane.exposure !== undefined) {
    findings.push('sharedWorld.plane.exposure must be ABSENT on the external-public plane class — the harness neither provisioned nor exposed the plane, so it cannot attest "synthetic" on a real site');
  }
  if (plane.hostDigest !== undefined) {
    findings.push("sharedWorld.plane.hostDigest must be ABSENT on the external-public plane class — a harness-minted host identity is a getHost claim; this plane is operator-attested, not harness-minted");
  }
  // Provenance is the NEW external-public marker — NOT seeded (nothing was seeded), NOT unpinned.
  if (bundle.subject?.state.provenance !== "external-public") {
    findings.push(`the external-public plane class requires subject.state.provenance == "external-public" (got "${bundle.subject?.state.provenance ?? "absent"}") — a seeded/unpinned/undeclared claim on an operator-owned public deployment is dishonest`);
  }
  if (bundle.subject?.source !== "app-url") {
    findings.push('the external-public plane class requires subject.source == "app-url" — the plane is a real public deployment, not a provisioned subject');
  }

  // Single-plane provenance: every laneWindow shares ONE (commit, seedDigest) matching plane. commit
  // is absent on this class (nothing cloned); seedDigest is the constant empty-recipe digest.
  const planeKeys = new Set(laneWindows.map((window) => `${String(window.commit ?? "")}::${String(window.seedDigest ?? "")}`));
  if (planeKeys.size > 1) {
    findings.push("laneWindows reference divergent plane provenance (commit/seedDigest) — a shared-world run drives ONE plane");
  }
  for (const window of laneWindows) {
    if (String(window.seedDigest ?? "") !== String(plane.seedDigest ?? "")
      || String(window.commit ?? "") !== String(plane.commit ?? "")) {
      const roleId = typeof window.roleId === "string" ? window.roleId : "(unnamed)";
      findings.push(`laneWindow "${roleId}" plane provenance diverges from sharedWorld.plane`);
      break;
    }
  }

  // The lobby-convergence proof (optional-but-strong): if present it must be a sha256-16 digest of the
  // shared /lobby/CODE path all seats converged on (digest-only; the raw CODE never lands).
  const lobbyConvergenceDigest = (sw as { lobbyConvergenceDigest?: unknown }).lobbyConvergenceDigest;
  if (lobbyConvergenceDigest !== undefined
    && (typeof lobbyConvergenceDigest !== "string" || !COMMAND_DIGEST_PATTERN.test(lobbyConvergenceDigest))) {
    findings.push("sharedWorld.lobbyConvergenceDigest must be a sha256-16 digest (digest-only; the raw lobby code never lands)");
  }

  // The RELAXED concurrency-on-pass gate: a PASSED external-public run MUST show genuine temporal
  // co-occupancy (≥2 laneWindows overlapping in time). There is NO state-delta requirement — the
  // observed co-occupancy of one declared origin (plus the optional lobby convergence) carries the
  // "they shared a world" claim, disclosed as concurrency-by-temporal-co-occupancy-only.
  if (bundle.review.verdict === "pass") {
    let overlap = false;
    for (let i = 0; i < laneWindows.length && !overlap; i += 1) {
      for (let j = i + 1; j < laneWindows.length; j += 1) {
        const a = laneWindows[i]!;
        const b = laneWindows[j]!;
        const aStart = a.startedAt as number;
        const aEnd = a.endedAt as number;
        const bStart = b.startedAt as number;
        const bEnd = b.endedAt as number;
        if (typeof aStart === "number" && typeof aEnd === "number" && typeof bStart === "number" && typeof bEnd === "number"
          && aStart < bEnd && bStart < aEnd) {
          overlap = true;
          break;
        }
      }
    }
    if (!overlap) {
      findings.push("review verdict is pass but no two laneWindows overlap in time — the external-public run was not actually concurrent (concurrency is proven by temporal co-occupancy on this class)");
    }
  }

  return findings;
}

/**
 * Advisory (never flips ok): a LIVE clone bundle whose subject env is provisioned while its
 * state story is undeclared probably points at state the lab does not control. Emitted at
 * most ONCE per bundle (the subject block is bundle-level, never per stream). GITHUB_TOKEN
 * is mechanically excluded: the harness consumes that name for clone auth — it carries no
 * state implication.
 */
function undeclaredSubjectStateWarnings(bundle: RunBundle): string[] {
  const subject = bundle.subject;
  if (subject === undefined || bundle.mode !== "live" || subject.source !== "clone") {
    return [];
  }
  if (subject.state.provenance !== "undeclared") {
    return [];
  }
  const stateRelevantEnvNames = (subject.envNames ?? []).filter((name) => name !== "GITHUB_TOKEN");
  if (stateRelevantEnvNames.length === 0) {
    return [];
  }
  return [
    `Subject env is provisioned (${stateRelevantEnvNames.join(", ")}) but no state story is declared; if any name points at external state, declare subject.state.external (recorded UNPINNED) or seed in-sandbox state with subject.state.seed.`
  ];
}

const riskyPublicArtifactPathSegments = new Set([
  ".git",
  "Cookies",
  "Login Data",
  "Local Storage",
  "Preferences",
  "Secure Preferences",
  "profiles"
]);

async function scanRunPublicSafetyArtifacts(runPaths: PreparedRunArtifactPaths): Promise<string[]> {
  const findings: string[] = [];
  await validatePreparedRunArtifactPaths(runPaths);
  await scanRunPublicSafetyDirectory(runPaths, "", findings);
  await validatePreparedRunArtifactPaths(runPaths);
  return findings;
}

async function scanRunPublicSafetyDirectory(
  runPaths: PreparedRunArtifactPaths,
  relativeDirectory: string,
  findings: string[]
): Promise<void> {
  if (findings.length >= 50) {
    return;
  }

  const current = relativeDirectory
    ? path.join(runPaths.physicalRunRoot, ...relativeDirectory.split("/"))
    : runPaths.physicalRunRoot;
  const entries = await readdir(current).catch(() => []);
  for (const entryName of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entryName}` : entryName;
    if (isRiskyPublicArtifactPath(relativePath) || containsSensitivePattern(relativePath)) {
      findings.push(`risky artifact path ${relativePath}`);
      if (findings.length >= 50) return;
    }

    const stats = await lstat(path.join(current, entryName), { bigint: true }).catch(() => null);
    if (!stats || stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) || (stats.isFile() && stats.nlink > 1n)) {
      findings.push(`unsafe artifact leaf ${relativePath}`);
      if (findings.length >= 50) return;
      continue;
    }

    if (stats.isDirectory()) {
      await scanRunPublicSafetyDirectory(runPaths, relativePath, findings);
      if (findings.length >= 50) return;
      continue;
    }

    if (!shouldScanTextArtifact(relativePath)) {
      continue;
    }

    const bytes = await readSafeRunArtifactBytes(runPaths, relativePath);
    const text = bytes?.toString("utf8") ?? null;
    if (text !== null && containsSensitivePattern(text)) {
      findings.push(`sensitive text ${relativePath}`);
      if (findings.length >= 50) return;
    }
  }
}

function isRiskyPublicArtifactPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => riskyPublicArtifactPathSegments.has(segment));
}

function shouldScanTextArtifact(relativePath: string): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  return ![".png", ".jpg", ".jpeg", ".webp", ".gif", ".tgz", ".gz", ".zip"].includes(extension);
}

function isLocalEvidenceArtifactPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return value.length > 0
    && !/^\[[a-z0-9._-]+\]$/i.test(normalized)
    && !path.isAbsolute(normalized)
    && !normalized.includes("://")
    && !normalized.startsWith("..")
    && !normalized.split("/").includes("..")
    && !isRiskyPublicArtifactPath(normalized);
}

function normalizeLocalEvidenceReference(value: string | undefined): string | null {
  if (!value || value.includes("://") || path.isAbsolute(value)) {
    return null;
  }

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("../")) {
    return isLocalEvidenceArtifactPath(normalized.slice(3)) ? normalized.slice(3) : null;
  }

  return isLocalEvidenceArtifactPath(normalized) ? normalized : null;
}

async function validateCwd(cwd: string): Promise<RunResult["error"] | null> {
  try {
    const stats = await stat(cwd);

    if (!stats.isDirectory()) {
      return {
        code: "HUMANISH_INVALID_CWD",
        message: `Target cwd is not a directory: ${cwd}`
      };
    }

    return null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        code: "HUMANISH_INVALID_CWD",
        message: `Target cwd does not exist: ${cwd}`
      };
    }

    throw error;
  }
}

function containsSensitivePattern(text: string): boolean {
  return containsSensitive(text);
}

function redactSensitiveText(text: string): string {
  return redactToSecretLabel(text);
}

function isRunBundle(value: unknown): value is RunBundle {
  return isRecord(value)
    && value.schema === RUN_BUNDLE_SCHEMA
    && typeof value.runId === "string"
    && (value.mode === "dry-run" || value.mode === "live")
    && isPositiveSafeInteger(value.simCount)
    && typeof value.createdAt === "string"
    && value.cwd === PUBLIC_TARGET_CWD
    && typeof value.artifactRoot === "string"
    && isRunSource(value.source)
    && isPersonaSummary(value.persona)
    && isScenarioSummary(value.scenario)
    && Array.isArray(value.lifecycle)
    && value.lifecycle.every(isLifecycleEvent)
    && Array.isArray(value.simulations)
    && value.simulations.length === value.simCount
    && value.simulations.every(isRunSimulation)
    && Array.isArray(value.streams)
    && value.streams.every(isRunStream)
    && hasConsistentSimulationStreams(value.simulations, value.streams)
    && Array.isArray(value.events)
    && value.events.every(isRunEvent)
    && isRunArtifactIndex(value.artifacts)
    && isRecord(value.review)
    && isReviewSummary(value.review)
    && isRecord(value.redaction)
    && value.redaction.status === "passed"
    && Array.isArray(value.feedbackCandidates)
    && value.feedbackCandidates.every(isRunFeedbackCandidate)
    // Optional and additive: pre-existing bundles (and non-cua backends) carry no subject
    // block; when present it must be well-shaped (semantics are the verify check's job).
    && (value.subject === undefined || isRunSubjectProvenance(value.subject))
    && (value.desktopBrowser === undefined || isDesktopBrowserEvidence(value.desktopBrowser))
    && (value.rerun === undefined || isRunRerunLineage(value.rerun))
    // Optional + additive shared-world fields (#164). Tolerant SHAPE guard only — the interaction
    // semantics (timeline well-formedness, single-plane, delta-on-pass) are the verify check's job.
    && (value.attributionClass === undefined || value.attributionClass === "isolated" || value.attributionClass === "shared-world")
    && (value.sharedWorld === undefined || isSharedWorldEvidence(value.sharedWorld))
    // Optional, adapter-namespaced product score (the extension seam). When present, validate only
    // its SHAPE; core never reads the adapter's `data` payload.
    && (value.adapterScore === undefined || isRunAdapterScore(value.adapterScore))
    // Optional + additive scorer provenance (#316). Tolerated-absent so pre-#316 and library-caller
    // bundles still verify; when present it must be well-shaped.
    && (value.scorerProvenance === undefined || isRunScorerProvenance(value.scorerProvenance))
    && (value.adapterArtifacts === undefined
      || (Array.isArray(value.adapterArtifacts) && value.adapterArtifacts.every(isRunAdapterArtifact)))
    && (value.providerResources === undefined
      || (Array.isArray(value.providerResources) && value.providerResources.every(isRunProviderResource)));
}

function isRunProviderResource(value: unknown): value is RunProviderResource {
  return isRecord(value)
    && value.schema === "humanish.provider-resource.v1"
    && value.provider === "e2b-desktop"
    && value.kind === "sandbox"
    && typeof value.id === "string"
    && value.id.trim().length > 0
    && value.owner === "humanish"
    && (value.status === "running" || value.status === "killed" || value.status === "unknown")
    && (value.simId === undefined || typeof value.simId === "string")
    && (value.streamId === undefined || typeof value.streamId === "string")
    && (value.laneId === undefined || typeof value.laneId === "string")
    && (value.createdAt === undefined || typeof value.createdAt === "string")
    && (value.cleanup === undefined
      || (isRecord(value.cleanup)
        && typeof value.cleanup.killed === "boolean"
        && typeof value.cleanup.reason === "string"));
}

function isCleanupResult(value: unknown): value is CleanupResult {
  return isRecord(value)
    && value.schema === CLEANUP_SCHEMA
    && typeof value.ok === "boolean"
    && typeof value.cwd === "string"
    && typeof value.run === "string"
    && typeof value.checkedAt === "string"
    && (value.runId === undefined || typeof value.runId === "string")
    && (value.bundlePath === undefined || typeof value.bundlePath === "string")
    && (value.cleanupPath === undefined || typeof value.cleanupPath === "string")
    && isRecord(value.summary)
    && isNonNegativeSafeInteger(value.summary.resources)
    && isNonNegativeSafeInteger(value.summary.killed)
    && isNonNegativeSafeInteger(value.summary.alreadyClean)
    && isNonNegativeSafeInteger(value.summary.failed)
    && isNonNegativeSafeInteger(value.summary.skipped)
    && Array.isArray(value.resources)
    && value.resources.every(isCleanupResourceResult)
    && Array.isArray(value.adapterResults)
    && value.adapterResults.every(isCleanupAdapterResult)
    && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === "string");
}

function isCleanupResourceResult(value: unknown): value is CleanupResourceResult {
  return isRecord(value)
    && value.provider === "e2b-desktop"
    && value.kind === "sandbox"
    && typeof value.id === "string"
    && value.id.trim().length > 0
    && (value.status === "killed" || value.status === "already_clean" || value.status === "failed" || value.status === "skipped")
    && typeof value.message === "string";
}

function isCleanupAdapterResult(value: unknown): value is CleanupAdapterResult {
  return isRecord(value)
    && typeof value.id === "string"
    && value.id.trim().length > 0
    && typeof value.ok === "boolean"
    && typeof value.message === "string";
}

function isRunRerunLineage(value: unknown): value is RunRerunLineage {
  return isRecord(value)
    && typeof value.sourceRunId === "string"
    && value.sourceRunId.trim().length > 0
    && Array.isArray(value.selectedLaneIds)
    && value.selectedLaneIds.length > 0
    && value.selectedLaneIds.every((laneId) => typeof laneId === "string" && laneId.trim().length > 0)
    && Array.isArray(value.previous)
    && value.previous.length > 0
    && value.previous.every((entry) =>
      isRecord(entry)
      && typeof entry.laneId === "string"
      && entry.laneId.trim().length > 0
      && (entry.streamId === undefined || typeof entry.streamId === "string")
      && typeof entry.status === "string"
      && entry.status.trim().length > 0
      && (entry.reason === undefined || typeof entry.reason === "string")
      && (entry.actorStatus === undefined || typeof entry.actorStatus === "string")
      && (entry.completionReason === undefined || typeof entry.completionReason === "string"));
}

function isDesktopBrowserEvidence(value: unknown): value is RunBundle["desktopBrowser"] {
  return isRecord(value)
    && (value.requested === "default" || value.requested === "chrome" || value.requested === "chromium" || value.requested === "firefox")
    && (value.resolved === undefined || typeof value.resolved === "string");
}

/** Short lowercase-hex content digest (digestText default is 12 chars; tolerate longer future digests). */
const SCORER_DIGEST_PATTERN = /^[a-f0-9]{12,64}$/;

/** Shape guard for RunScorerProvenance (#316), mirroring isRunSubjectProvenance: tolerated-absent in
 *  isRunBundle, well-shaped when present. Semantics (does the digest still match the file) are not a
 *  verify concern — the block is core-stamped evidence of what was loaded, not a re-execution proof. */
function isRunScorerProvenance(value: unknown): value is RunScorerProvenance {
  return isRecord(value)
    && value.schema === "humanish.scorer-provenance.v1"
    && typeof value.ref === "string"
    && value.ref.trim().length > 0
    && typeof value.digest === "string"
    && SCORER_DIGEST_PATTERN.test(value.digest)
    && (value.source === "manifest" || value.source === "cli-flag")
    && Array.isArray(value.exports)
    && value.exports.length > 0
    && value.exports.every((name) => name === "score" || name === "deriveFeedback" || name === "deriveArtifacts");
}

function isRunAdapterScore(value: unknown): value is RunAdapterScore {
  return isRecord(value)
    && value.schema === "humanish.adapter-score.v1"
    && typeof value.namespace === "string"
    && value.namespace.trim().length > 0
    && (value.status === "pass" || value.status === "partial" || value.status === "fail")
    && typeof value.score === "number"
    && Number.isFinite(value.score)
    && typeof value.summary === "string"
    && (value.data === undefined || isRecord(value.data));
}

/**
 * Tolerant SHAPE guard for the shared-world evidence block (#164). Validates required fields +
 * types but TOLERATES extra keys (additive): the strict value-shape/timeline checks are
 * sharedWorldEvidenceFindings' job (an injected value-shaped checkpoint field must pass the shape
 * guard so verify can catch it fail-closed, not silently bounce off isRunBundle).
 */
function isSharedWorldEvidence(value: unknown): value is SharedWorldEvidence {
  if (!isRecord(value)) return false;
  if (value.schema !== SHARED_WORLD_SCHEMA) return false;
  if (value.topology !== "shared-world") return false;
  if (!isNonNegativeSafeInteger(value.roleCount)) return false;
  const plane = value.plane;
  if (!isRecord(plane)) return false;
  if (plane.commit !== undefined && typeof plane.commit !== "string") return false;
  if (typeof plane.seedDigest !== "string") return false;
  if (!(Array.isArray(plane.envNames) && plane.envNames.every((name) => typeof name === "string"))) return false;
  if (plane.hostDigest !== undefined && typeof plane.hostDigest !== "string") return false;
  if (plane.exposure !== undefined && typeof plane.exposure !== "string") return false;
  if (plane.publicOriginDigest !== undefined && typeof plane.publicOriginDigest !== "string") return false;
  if (plane.declaredOriginDigest !== undefined && typeof plane.declaredOriginDigest !== "string") return false;
  if (value.planeClass !== undefined && typeof value.planeClass !== "string") return false;
  if (value.lobbyConvergenceDigest !== undefined && typeof value.lobbyConvergenceDigest !== "string") return false;
  if (!(Array.isArray(value.attributionLimits) && value.attributionLimits.every((limit) => typeof limit === "string"))) return false;
  // Tolerant: validate the TYPE of each present field only (the coherence + topologyMode dispatch
  // are validateSharedWorldEvidence's job — an injected value-shaped field must pass this guard so
  // verify catches it fail-closed). A bundle must carry at least one of the two shapes.
  if (value.sequence !== undefined && !(Array.isArray(value.sequence) && value.sequence.every((id) => typeof id === "string"))) return false;
  if (value.timeline !== undefined && !(Array.isArray(value.timeline) && value.timeline.every(isSharedWorldTimelineEntry))) return false;
  if (value.laneWindows !== undefined && !(Array.isArray(value.laneWindows) && value.laneWindows.every(isSharedWorldLaneWindow))) return false;
  if (value.stateSeries !== undefined && !(Array.isArray(value.stateSeries) && value.stateSeries.every(isSharedWorldStateSnapshot))) return false;
  if (value.outcomes !== undefined && !(Array.isArray(value.outcomes) && value.outcomes.every(isSharedWorldOutcome))) return false;
  if (value.timeline === undefined && value.laneWindows === undefined) return false;
  return true;
}

function isSharedWorldTimelineEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "checkpoint") {
    return typeof value.name === "string"
      && typeof value.digest === "string"
      && typeof value.deltaFromPrev === "boolean";
  }
  if (value.kind === "turn") {
    return typeof value.roleId === "string"
      && typeof value.simId === "string"
      && typeof value.streamId === "string"
      && typeof value.seedDigest === "string"
      && (value.commit === undefined || typeof value.commit === "string");
  }
  return false;
}

// Tolerant shape guards for the CONCURRENT series (extra keys tolerated — the digest-only /
// allowed-keys tripwires are validateSharedWorldEvidence's strict job).
function isSharedWorldLaneWindow(value: unknown): boolean {
  return isRecord(value)
    && typeof value.roleId === "string"
    && (value.actorType === undefined || typeof value.actorType === "string")
    && (value.surface === undefined || typeof value.surface === "string")
    && (value.caseGroup === undefined || typeof value.caseGroup === "string")
    && typeof value.simId === "string"
    && typeof value.streamId === "string"
    && typeof value.startedAt === "number"
    && typeof value.endedAt === "number"
    && typeof value.verdict === "string"
    && typeof value.routeHostDigest === "string"
    && typeof value.seedDigest === "string"
    && (value.commit === undefined || typeof value.commit === "string");
}

function isSharedWorldStateSnapshot(value: unknown): boolean {
  return isRecord(value) && typeof value.timestamp === "number" && typeof value.digest === "string";
}

function isSharedWorldOutcome(value: unknown): boolean {
  return isRecord(value)
    && typeof value.roleId === "string"
    && (value.actorType === undefined || typeof value.actorType === "string")
    && (value.surface === undefined || typeof value.surface === "string")
    && (value.caseGroup === undefined || typeof value.caseGroup === "string")
    && typeof value.simId === "string"
    && typeof value.streamId === "string"
    && typeof value.status === "string"
    && typeof value.ok === "boolean";
}

// The local-tree archive content pin: sha256 hex, full 64 chars (NOT the repo's 16-char
// display-digest convention -- this value is the provenance pin itself, persisted in full).
const ARCHIVE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isRunSubjectProvenance(value: unknown): value is RunSubjectProvenance {
  if (!isRecord(value)) return false;
  if (value.source !== "clone" && value.source !== "app-url" && value.source !== "local-tree") return false;
  if (value.repo !== undefined && typeof value.repo !== "string") return false;
  if (value.commit !== undefined && typeof value.commit !== "string") return false;
  if (value.archiveSha256 !== undefined
    && (typeof value.archiveSha256 !== "string" || !ARCHIVE_SHA256_PATTERN.test(value.archiveSha256))) {
    return false;
  }
  if (value.dirty !== undefined && typeof value.dirty !== "boolean") return false;
  if (value.envNames !== undefined
    && !(Array.isArray(value.envNames) && value.envNames.every((name) => typeof name === "string"))) {
    return false;
  }
  const state = value.state;
  if (!isRecord(state)) return false;
  if (state.provenance !== "seeded" && state.provenance !== "unpinned"
    && state.provenance !== "declared-not-run" && state.provenance !== "undeclared"
    && state.provenance !== "external-public") {
    return false;
  }
  if (state.seed !== undefined
    && !(Array.isArray(state.seed) && state.seed.every(isRunSubjectStateStepRecord))) {
    return false;
  }
  if (state.externalEnvNames !== undefined
    && !(Array.isArray(state.externalEnvNames) && state.externalEnvNames.every((name) => typeof name === "string"))) {
    return false;
  }
  return true;
}

function isRunSubjectStateStepRecord(value: unknown): value is RunSubjectStateStepRecord {
  return isRecord(value)
    && typeof value.name === "string"
    && (value.when === "before-build" || value.when === "before-start" || value.when === "after-ready")
    && typeof value.commandDigest === "string"
    && (value.ok === undefined || typeof value.ok === "boolean")
    && (value.exitCode === undefined || typeof value.exitCode === "number")
    && (value.timedOut === undefined || typeof value.timedOut === "boolean")
    && (value.durationMs === undefined || typeof value.durationMs === "number");
}

function isRunSource(value: unknown): value is RunBundle["source"] {
  return isRecord(value)
    && (typeof value.packageName === "string" || value.packageName === null)
    && (value.humanishSource === "present" || value.humanishSource === "missing")
    && isCapturedGitState(value.git);
}

function isCapturedGitState(value: unknown): value is CapturedGitState {
  return isRecord(value)
    && value.schema === GIT_STATE_SCHEMA
    && (value.status === "clean" || value.status === "dirty" || value.status === "missing" || value.status === "unavailable")
    && typeof value.capturedAt === "string"
    && isRecord(value.head)
    && (isSafeGitShortSha(value.head.shortSha) || value.head.shortSha === null)
    && (value.head.refState === "attached" || value.head.refState === "detached" || value.head.refState === "unborn" || value.head.refState === "unknown")
    && isRecord(value.changes)
    && isNonNegativeSafeInteger(value.changes.staged)
    && isNonNegativeSafeInteger(value.changes.unstaged)
    && isNonNegativeSafeInteger(value.changes.untracked)
    && isNonNegativeSafeInteger(value.changes.total)
    && typeof value.note === "string"
    && SAFE_GIT_NOTES.has(value.note);
}

function isPersonaSummary(value: unknown): value is RunBundle["persona"] {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.source === "string"
    && typeof value.sourceDigest === "string";
}

function isScenarioSummary(value: unknown): value is RunBundle["scenario"] {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.goal === "string"
    && typeof value.source === "string"
    && typeof value.sourceDigest === "string";
}

function isLifecycleEvent(value: unknown): value is RunBundle["lifecycle"][number] {
  return isRecord(value)
    && typeof value.at === "string"
    && typeof value.event === "string"
    && typeof value.message === "string";
}

function isRunSimulation(value: unknown): value is RunSimulation {
  return isRecord(value)
    && typeof value.id === "string"
    && isPositiveSafeInteger(value.index)
    && typeof value.personaId === "string"
    && typeof value.scenarioId === "string"
    && isRunSimulationStatus(value.status)
    && isRunStreamKind(value.streamKind)
    && (value.mode === "browser-sim" || value.mode === "cli-sim" || value.mode === "tui-sim" || value.mode === "codex-app-sim")
    && typeof value.progress === "number"
    && typeof value.currentStep === "string"
    && typeof value.summary === "string"
    && Array.isArray(value.streamIds)
    && value.streamIds.every((streamId) => typeof streamId === "string")
    && typeof value.startedAt === "string"
    && typeof value.updatedAt === "string";
}

function isRunStream(value: unknown): value is RunStream {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.simId === "string"
    && isRunStreamKind(value.kind)
    && typeof value.label === "string"
    && isRunSimulationStatus(value.status)
    && (value.transport === "snapshot" || value.transport === "polling" || value.transport === "sse" || value.transport === "pty" || value.transport === "app-server")
    && typeof value.updatedAt === "string"
    && (value.viewport === undefined || isRunViewport(value.viewport))
    && (value.desktopGeometry === undefined || isRunDesktopGeometry(value.desktopGeometry))
    && hasConsistentStreamGeometry(value)
    && Array.isArray(value.artifacts)
    && value.artifacts.every(isRunStreamArtifact);
}

function isRunViewport(value: unknown): value is NonNullable<RunStream["viewport"]> {
  return isRecord(value)
    && isPositiveFiniteNumber(value.width)
    && isPositiveFiniteNumber(value.height)
    && (value.deviceScaleFactor === undefined || isPositiveFiniteNumber(value.deviceScaleFactor))
    && (value.isMobile === undefined || typeof value.isMobile === "boolean");
}

function isRunDesktopGeometry(value: unknown): value is RunDesktopGeometry {
  if (!isRecord(value) || !isRecord(value.screen) || !isMeasuredSize(value.screen.requested)) {
    return false;
  }
  const verified = value.screen.verified;
  if (verified !== undefined) {
    if (!isRecord(verified)) return false;
    const source = verified.source;
    if (!isMeasuredSize(verified) || source !== "xdpyinfo") return false;
  }
  const declared = value.screen.declared;
  if (declared !== undefined) {
    if (!isRecord(declared)) return false;
    // read before isMeasuredSize narrows `declared` to {width, height}
    const preset = declared.preset;
    if (!isMeasuredSize(declared) || typeof preset !== "string") return false;
  }
  const browserWindow = value.browserWindow;
  if (browserWindow !== undefined && (
    !isRecord(browserWindow)
    || !isFiniteNumber(browserWindow.x)
    || !isFiniteNumber(browserWindow.y)
    || !isPositiveFiniteNumber(browserWindow.width)
    || !isPositiveFiniteNumber(browserWindow.height)
    || (browserWindow.source !== "cdp" && browserWindow.source !== "xdotool")
  )) {
    return false;
  }
  const viewport = value.viewport;
  if (!(viewport === undefined || (
    isRecord(viewport)
    && isPositiveFiniteNumber(viewport.width)
    && isPositiveFiniteNumber(viewport.height)
    && isPositiveFiniteNumber(viewport.deviceScaleFactor)
    && viewport.source === "cdp"
  ))) return false;
  return value.warnings === undefined || (
    Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === "string" && warning.length > 0)
  );
}

function hasConsistentStreamGeometry(value: Record<string, unknown>): boolean {
  if (value.desktopGeometry === undefined) return true;
  if (!isRunDesktopGeometry(value.desktopGeometry)) return false;
  const measured = value.desktopGeometry.viewport;
  if (measured === undefined) return value.viewport === undefined;
  if (!isRunViewport(value.viewport)) return false;
  return value.viewport.width === measured.width
    && value.viewport.height === measured.height
    && value.viewport.deviceScaleFactor === measured.deviceScaleFactor;
}

function isMeasuredSize(value: unknown): value is { width: number; height: number } {
  return isRecord(value)
    && isPositiveFiniteNumber(value.width)
    && isPositiveFiniteNumber(value.height);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRunStreamArtifact(value: unknown): value is RunStream["artifacts"][number] {
  return isRecord(value)
    && typeof value.label === "string"
    && typeof value.path === "string"
    && (
      value.kind === "bundle"
      || value.kind === "review"
      || value.kind === "observer"
      || value.kind === "events"
      || value.kind === "screenshot"
      || value.kind === "trace"
      || value.kind === "log"
      || value.kind === "filesystem"
    );
}

function isRunAdapterArtifact(value: unknown): value is RunAdapterArtifact {
  return isRecord(value)
    && value.schema === "humanish.adapter-artifact.v1"
    && typeof value.namespace === "string"
    && value.namespace.trim().length > 0
    && typeof value.label === "string"
    && value.label.trim().length > 0
    && typeof value.path === "string"
    && value.path.trim().length > 0
    && isLocalEvidenceArtifactPath(value.path)
    && (
      value.kind === "state"
      || value.kind === "review"
      || value.kind === "log"
      || value.kind === "trace"
      || value.kind === "screenshot"
      || value.kind === "filesystem"
      || value.kind === "summary"
    )
    && typeof value.note === "string"
    && value.note.trim().length > 0;
}

function isRunEvent(value: unknown): value is RunEvent {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.at === "string"
    && (value.level === "info" || value.level === "warn" || value.level === "error")
    && typeof value.type === "string"
    && typeof value.message === "string";
}

function isRunArtifactIndex(value: unknown): value is RunBundle["artifacts"] {
  return isRecord(value)
    && typeof value.run === "string"
    && typeof value.reviewJson === "string"
    && typeof value.reviewMarkdown === "string"
    && typeof value.observerData === "string"
    && typeof value.events === "string";
}

function isRunFeedbackCandidate(value: unknown): value is RunFeedbackCandidate {
  return isRecord(value)
    && value.schema === "humanish.feedback-candidate.v1"
    && typeof value.id === "string"
    && typeof value.run_id === "string"
    && (typeof value.stream_id === "string" || value.stream_id === undefined)
    && typeof value.adapter_id === "string"
    && typeof value.scenario_id === "string"
    && typeof value.persona_id === "string"
    && isFeedbackActor(value.actor)
    && isFeedbackSubstrate(value.substrate)
    && isFeedbackFailureOwner(value.failure_owner)
    && typeof value.summary === "string"
    && typeof value.expected === "string"
    && typeof value.actual === "string"
    && Array.isArray(value.evidence)
    && value.evidence.every(isRunFeedbackEvidence)
    && isRecord(value.redaction)
    && value.redaction.status === "passed"
    && typeof value.redaction.notes === "string"
    && typeof value.idempotency_key === "string"
    && isFeedbackNextState(value.proposed_next_state)
    && Array.isArray(value.acceptance_proof)
    && value.acceptance_proof.every((item) => typeof item === "string")
    // Optional, adapter-namespaced product-noun block: when present, validate only its SHAPE
    // (a non-empty namespace + a data record). Core never inspects the keys inside `data`.
    && (value.adapter === undefined || isFeedbackAdapterBlock(value.adapter));
}

function isFeedbackAdapterBlock(value: unknown): value is NonNullable<RunFeedbackCandidate["adapter"]> {
  return isRecord(value)
    && typeof value.namespace === "string"
    && value.namespace.trim().length > 0
    && isRecord(value.data);
}

function isRunFeedbackEvidence(value: unknown): value is RunFeedbackCandidate["evidence"][number] {
  return isRecord(value)
    && typeof value.path === "string"
    && value.path.length > 0
    && !path.isAbsolute(value.path)
    && !value.path.includes("://")
    && !value.path.includes("..")
    && (
      value.kind === "review"
      || value.kind === "state"
      || value.kind === "log"
      || value.kind === "trace"
      || value.kind === "screenshot"
      || value.kind === "filesystem"
    )
    && typeof value.note === "string";
}

function hasConsistentSimulationStreams(
  simulations: unknown[],
  streams: unknown[]
): boolean {
  const simIds = new Set<string>();
  const expectedStreamSimIds = new Map<string, string>();
  const streamById = new Map<string, RunStream>();

  for (const simulation of simulations) {
    if (!isRunSimulation(simulation)) {
      return false;
    }

    simIds.add(simulation.id);
    for (const streamId of simulation.streamIds) {
      if (expectedStreamSimIds.has(streamId)) {
        return false;
      }

      expectedStreamSimIds.set(streamId, simulation.id);
    }
  }

  for (const stream of streams) {
    if (!isRunStream(stream) || !simIds.has(stream.simId) || streamById.has(stream.id)) {
      return false;
    }

    const expectedSimId = expectedStreamSimIds.get(stream.id);
    if (expectedSimId === undefined || stream.simId !== expectedSimId) {
      return false;
    }

    streamById.set(stream.id, stream);
  }

  return streamById.size === expectedStreamSimIds.size;
}

function isRunSimulationStatus(value: unknown): value is RunSimulationStatus {
  return value === "queued"
    || value === "preparing"
    || value === "running"
    || value === "passed"
    // Participant outcomes (docs/principles/three-roles.md). This runtime allowlist is the actual
    // gate — the TS union alone does not validate a bundle read back from disk.
    || value === "abandoned"
    || value === "incomplete"
    || value === "complete"
    || value === "blocked"
    || value === "timed_out"
    || value === "failed"
    || value === "contract_proof_only";
}

function isRunStreamKind(value: unknown): value is RunStreamKind {
  return value === "ui"
    || value === "browser"
    || value === "terminal"
    || value === "tui"
    || value === "codex-ui"
    || value === "artifact"
    || value === "summary";
}

function isSafeGitShortSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,12}$/.test(value);
}

function isFeedbackActor(value: unknown): value is RunFeedbackCandidate["actor"] {
  return value === "codex-tui"
    || value === "codex-exec"
    || value === "codex-app-server"
    || value === "computer-use"
    || value === "synthetic-dry-run"
    || value === "unknown";
}

function isFeedbackSubstrate(value: unknown): value is RunFeedbackCandidate["substrate"] {
  return value === "e2b-desktop"
    || value === "e2b-terminal"
    || value === "local-filesystem"
    || value === "codex-app-server"
    || value === "unknown";
}

function isFeedbackFailureOwner(value: unknown): value is RunFeedbackCandidate["failure_owner"] {
  return value === "harness"
    || value === "target-app"
    || value === "actor"
    || value === "environment"
    || value === "unknown";
}

function isFeedbackNextState(value: unknown): value is RunFeedbackCandidate["proposed_next_state"] {
  return value === "watch"
    || value === "adapter-hardening"
    || value === "target-app-setup"
    || value === "actor-auth"
    || value === "setup-quality-review"
    || value === "study-quality-review";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isReviewSummary(value: unknown): value is ReviewSummary {
  return isRecord(value)
    && value.schema === REVIEW_SCHEMA
    && (
      value.verdict === "contract_proof_only"
      || value.verdict === "pass"
      || value.verdict === "fail"
      || value.verdict === "blocked"
      || value.verdict === "timed_out"
    )
    && typeof value.summary === "string"
    && Array.isArray(value.gaps)
    && value.gaps.every((gap) => typeof gap === "string");
}

function isRunPointer(value: unknown): value is RunPointer {
  return isRecord(value)
    && value.schema === "humanish.latest-run.v1"
    && typeof value.runId === "string"
    && typeof value.path === "string"
    && typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
