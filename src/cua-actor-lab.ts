// The computer-use lab backend: a subject (an app-url the caller provisioned, or a repo the
// lab clones AND serves in-sandbox) driven by a REGISTRY-RESOLVED computer-use actor inside a
// hosted E2B desktop. This is the path that makes `actors[].type` load-bearing — the
// descriptor returned by the registry runs the session; the lab provisions the desktop and
// subject, composes the prompt from config, persists the evidence bundle, and tears down.
//
// Substrate notes:
// - The desktop is created via the shared loader in e2b-desktop-launch.ts with kill-on-timeout
//   lifecycle, so a dead host process can never orphan a sandbox past its server-side deadline.
// - Env placement follows the doctrine (docs/principles/invariants-and-defaults.md): the
//   ACTOR's key never enters the sandbox (the model drives from outside via the provider API);
//   the SUBJECT's declared env NAMES are provisioned in on the clone route — values come from
//   the caller's environment and are never logged or persisted.
// - The live stream URL is runtime-only (carries an auth key) and is never persisted into run
//   artifacts — only its presence is recorded, mirroring the meta lab's convention.
// - Evidence redaction is mode-aware (docs/principles/invariants-and-defaults.md, the
//   capture-vs-publish rule): screenshots persist RAW (full fidelity) by default into gitignored
//   .humanish/; `policies.redactScreenshots: true` opts into blur-at-capture for a share-as-is
//   bundle. Length-only typed text and text redaction of reasoning/messages are UNCONDITIONAL;
//   harness errors are redacted at THIS boundary; the bundle's `stream.actor` carries the
//   conformant humanish.actor-trace.v1 projection, whose `redaction.screenshots` records the
//   run's actual mode ("raw" | "blurred" | "n/a") — every label downstream derives from it.

import { randomBytes } from "node:crypto";
import { describeMissingKeys } from "./key-resolution.js";
import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { runDesktopCommandOrThrow, toErrorMessage } from "./command-failure.js";
import { pathToFileURL } from "node:url";

import type { ActorCompletionReason, ActorPersonaRef, ActorStatus, ActorTokenUsage, ActorTrace, ActorTraceItem } from "./actor-contract.js";
import { beginRunStatus, type RunLabProvenance, type RunStatusHandle , withRunStatusScope} from "./run-status.js";
import {
  adapterScoreFailureMessage,
  applyBrowserAdapterHooks,
  type BrowserLabAdapterHooks
} from "./adapter-extension.js";
import { actorRegistry, isCuaActorDescriptor, type CuaActorDescriptor } from "./actor-registry.js";
import {
  CHROMIUM_EVIDENCE_HYGIENE_FLAGS,
  chromiumEvidenceProfilePreferencesJson
} from "./browser-evidence-hygiene.js";
import type { CuaActorSessionOptions } from "./computer-use-actor.js";
import type { CuaExecutor, CuaLoopResult, CuaProvider } from "./computer-use.js";
import { DEFAULT_OPENAI_CU_MODEL } from "./openai-responses-cu.js";
import type { ReasoningEffort } from "./reasoning-effort.js";
import { createLocalAgentProvider, detectLocalAgents, type LocalAgentId } from "./local-agent-cli.js";
import { startAppServerSession } from "./local-agent-appserver.js";
import { startClaudeSession } from "./local-agent-claude-session.js";
import type { E2BDesktopLike } from "./e2b-desktop-executor.js";
import {
  createDesktopSandbox,
  withOneRetryOnTransientE2BError,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import {
  probeUrl,
  readDetachedLog,
  runDetachedStep,
  type DetachedStepOptions,
  type DetachedStepResult,
  startDetachedProcess,
  type DetachedTimers
} from "./e2b-detached.js";
import { DEFAULT_SANDBOX_CATCH_PORT, collectCommsThread, collectExternalCommsThread, deployCommsCatch, externalCatchHealthy, externalInboxUrl, refreshInboxSurface, writeInboxSurface, type DeployedCommsCatch } from "./comms-sandbox-catch.js";
import { FakeInbox } from "./comms-fake-inbox.js";
import { buildOriginMap } from "./comms-inbox.js";
import type { CommsAddress } from "./comms-types.js";
import {
  DEFAULT_DEVICE_PRESET,
  isDevicePresetName,
  resolveDevicePreset,
  type DevicePreset
} from "./device-presets.js";
import {
  cuaLaneValidationReason,
  outputTokenLimitValidationReason,
  isHttpUrl,
  isLoopbackUrl,
  MAX_CUA_LANES,
  subjectStateInvalidReason,
  type LabActorLane,
  type LabCommsEmail,
  type LabCommsRecipient,
  type LabConfig,
  type LabDesktopBrowser,
  type LabStateStepWhen,
  type LabSubjectServe,
  type LabSubjectState, type LabDesktopMedia } from "./lab-config.js";
import { mapWithConcurrency } from "./concurrency.js";
import { appendSandboxReceipt } from "./sandbox-receipts.js";
import { assertScreenshotEvidence } from "./image-evidence.js";
import { buildObserverData } from "./observer-data.js";
import { corepackCommandFor, needsNodeRuntime, nodeBootstrapCommand } from "./subject-runtime.js";
import { chromeCdpProbeCommand, parseChromeCdpProbeOutput, type ChromeMobileEmulationRequest } from "./chrome-cdp-probe.js";
import { personaToDirectives, renderPersonaPromptSection, type ResolvedPersona } from "./persona.js";
import { labPersonaIds, resolveCommittedPersonas } from "./persona-resolve.js";
import { renderTaskPrompt, type LabTask, type TaskFunnel } from "./tasks.js";
import {
  attachObserverRuntimeStreamUrls,
  renderObserver,
  type ObserverResult,
  type ObserverRuntimeStreamUrl
} from "./observer.js";
import { containsSensitive, digestText, redactedTail, redactText } from "./redaction.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  prepareContainedOutputDirectory,
  prepareSelectedOutputDirectory,
  type PreparedOutputDirectory,
  writeContainedOutputFile,
  writePreparedRunLatestPointer
} from "./selected-output-paths.js";
import {
  prepareRunArtifactPaths,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths
} from "./run-paths.js";
import { createLocalTreeArchive, type LocalTreeArchive } from "./source-archive.js";
import type { DwellWindow, StopWhen } from "./stop-conditions.js";
import {
  buildRunSource,
  loadRunBundle,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  aggregateTaskFunnels,
  formatParticipantOutcomes,
  formatStudyTaskFunnel,
  tallyParticipantOutcomes,
  type ReviewSummary,
  type RunBundle,
  type RunDesktopGeometry,
  type RunFeedbackCandidate,
  type RunEvent,
  type RunRerunLineage,
  type RunSimulation,
  type RunSimulationStatus,
  type RunStream,
  type RunProviderResource,
  type RunCostLine,
  type RunCostSummary,
  type RunScorerProvenance,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord
} from "./run.js";
import { estimateActorCost, estimateDesktopCost, estimateAllocatedDesktopCost, MODEL_RATES, round6 } from "./pricing.js";
import { observeDesktopResources, type DesktopResourceObservation } from "./e2b-desktop-resources.js";

export const CUA_ACTOR_LAB_SCHEMA = "humanish.cua-lab-result.v2";

// The only fan-out topology this slice ships: N lanes = N independent E2B desktop sandboxes,
// each its own world (clone/serve + subject.state per lane). Shared-world is layer 7 (#164).
export const CUA_FANOUT_STRATEGY = "per-lane-worlds" as const;
// Env override that may only LOWER the effective concurrency (never raise concurrent paid
// desktops — invariant 3). Read names-only into a local; the value never persists.
const CUA_MAX_CONCURRENCY_ENV = "HUMANISH_CUA_MAX_CONCURRENCY";

export const CUA_ACTOR_LAB_PROVIDER_METADATA = {
  mode: "cua-actor-lab",
  tool: "humanish"
} as const;

// The DEFAULT session budget, sized so a study can FINISH (docs/principles/three-roles.md: a
// session ends because the participant is done, not because a timer fired — the time-box is a
// session-level cap a researcher sets generously; spend protection is the dollar caps' job).
// The old 300s default ended real signup studies mid-flow: observed studies run 16-40 turns at
// ~5-6s per turn BEFORE any email wait, so five minutes was the biggest single source of
// budget_reached endings that read as participant failures.
//
// App-url and in-process routes default to 30 minutes. Provisioned routes (clone/local-tree)
// default to whatever the 1-hour sandbox cap leaves after provisioning, declared state seeding,
// and the teardown buffer — 20 minutes on a stateless clone — floored at the old five minutes so
// a state-heavy lab still gets a session at all. An EXPLICIT execution.timeoutMs is never
// adjusted: when it cannot be provisioned, the plan-time cap refusal shows the arithmetic.
const DEFAULT_APP_URL_SESSION_TIMEOUT_MS = 30 * 60_000;
const MIN_DERIVED_SESSION_TIMEOUT_MS = 5 * 60_000;
function defaultSessionTimeoutMs(config: LabConfig): number {
  const provisionedRoute = config.subject.source === "clone" || config.subject.source === "local-tree";
  if (!provisionedRoute) return DEFAULT_APP_URL_SESSION_TIMEOUT_MS;
  const stateBudgetMs = (config.subject.state?.seed ?? []).reduce(
    (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0);
  const room = MAX_SANDBOX_MS - SUBJECT_PROVISION_BUDGET_MS - stateBudgetMs - SANDBOX_TIMEOUT_BUFFER_MS;
  return Math.max(MIN_DERIVED_SESSION_TIMEOUT_MS, Math.min(DEFAULT_APP_URL_SESSION_TIMEOUT_MS, room));
}
// Settle after opening the browser, before the first screenshot — long enough for a cold
// browser + page load to paint (2s captured a blank desktop; the render empirically needs ~6-9s).
const BROWSER_SETTLE_MS = 8_000;

export interface DesktopBrowserEvidence {
  requested: LabDesktopBrowser;
  resolved?: string;
  /** Synthetic media devices the browser was launched with (#509), and how permission is answered. */
  media?: DesktopMediaEvidence;
}

export interface DesktopMediaEvidence {
  camera?: { source: "synthetic" | "file"; file: string };
  permission: "prompt" | "granted";
  flags: string[];
}

/** Where a lane's synthetic camera feed lives inside the sandbox: a tmpfs the sandbox user can
 *  write, and a path that contains neither /tmp/ nor /home/, which the public-safety scan reads
 *  as an operator's local path (this one is the harness's own and belongs in the bundle). */
export const SANDBOX_MEDIA_DIR = "/dev/shm/humanish-media";
export const SANDBOX_CAMERA_PATH = `${SANDBOX_MEDIA_DIR}/camera.y4m`;
/** The synthetic feed: ffmpeg's test pattern, 640x480 at 10 fps, six seconds (about 28 MB of
 *  raw Y4M on the tmpfs), looped by Chrome's fake capture device. */
export const SYNTHETIC_CAMERA_COMMAND =
  `mkdir -p ${SANDBOX_MEDIA_DIR} && ffmpeg -y -loglevel error -f lavfi -i testsrc=size=640x480:rate=10 -t 6 -pix_fmt yuv420p ${SANDBOX_CAMERA_PATH}`;

/**
 * Put the declared camera feed in the sandbox and return the Chromium flags that present it as a
 * capture device (#509). Fails CLOSED: a feed that cannot be produced (no ffmpeg on the image, an
 * unreadable host file) is named before the browser launches, because a participant told it has
 * a camera and finds none reports the instrument's gap as the product's.
 */
export async function prepareDesktopMedia(
  desktop: E2BDesktopSandbox,
  media: LabDesktopMedia,
  permission: "prompt" | "granted",
  cwd: string,
  requestTimeoutMs: number,
  readHostFile: (absolutePath: string) => Promise<Buffer> = (absolutePath) => readFile(absolutePath)
): Promise<DesktopMediaEvidence> {
  const flags: string[] = [];
  let camera: DesktopMediaEvidence["camera"];
  if (media.camera !== undefined) {
    if (media.camera.source === "synthetic") {
      const made = await desktop.commands.run(SYNTHETIC_CAMERA_COMMAND, { requestTimeoutMs, timeoutMs: 60_000 });
      if (made.exitCode !== undefined && made.exitCode !== 0) {
        throw new Error(
          `the synthetic camera feed could not be generated on this desktop image (ffmpeg exited ${made.exitCode}: ${tailOf(made.stderr ?? made.stdout ?? "")}); give execution.desktop.media.camera.source a .y4m file instead`
        );
      }
      camera = { source: "synthetic", file: SANDBOX_CAMERA_PATH };
    } else {
      const absolutePath = path.resolve(cwd, media.camera.source);
      let bytes: Buffer;
      try {
        bytes = await readHostFile(absolutePath);
      } catch (error) {
        throw new Error(`execution.desktop.media.camera.source could not be read (${toErrorMessage(error)})`);
      }
      if (bytes.length > 64 * 1024 * 1024) {
        throw new Error(`execution.desktop.media.camera.source is ${bytes.length} bytes; the camera feed is capped at 64 MiB`);
      }
      await desktop.commands.run(`mkdir -p ${SANDBOX_MEDIA_DIR}`, { requestTimeoutMs, timeoutMs: 15_000 });
      const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await desktop.files.write(SANDBOX_CAMERA_PATH, payload, { requestTimeoutMs, useOctetStream: true });
      camera = { source: "file", file: SANDBOX_CAMERA_PATH };
    }
    flags.push("--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${SANDBOX_CAMERA_PATH}`);
  }
  if (permission === "granted") flags.push("--use-fake-ui-for-media-stream");
  return { ...(camera === undefined ? {} : { camera }), permission, flags };
}

export type DesktopBrowserFamily = "chromium" | "firefox" | "unknown";

/** Runtime-only identity for the exact browser process started by this lane. */
export interface DesktopBrowserLaunchIdentity {
  processId: string;
  profileDir: string;
  targetUrl: string;
  cdpPort?: number;
}

/** Runtime-only launch result. `evidence` preserves the existing public persistence policy. */
export interface DesktopBrowserLaunchResult {
  family: DesktopBrowserFamily;
  identity?: DesktopBrowserLaunchIdentity;
  evidence?: DesktopBrowserEvidence;
}

// Device/screen size comes from the named-preset registry (device-presets.ts), selectable per run
// via execution.desktop.device (default `desktop`=1440x950). NOTE: this is run-wide for now; a
// per-PERSONA device dimension (N personas × devices, as the bespoke sims author) lands with
// fan-out. On this E2B-desktop route only width/height physically render — isMobile/DSF are
// honest metadata + a prompt signal, not rendered (device-presets.ts FIDELITY NOTE) — and the
// rendered WIDTH is floored to MIN_DESKTOP_RENDER_WIDTH (Chrome's ~500px window minimum) so a mobile
// screen the browser can't shrink to does not overflow + clip (see resolveLaneDevice / #221).
// Server-side reclamation buffer past the loop's own wall-clock stop.
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;
// Room the clone route adds to the sandbox deadline for clone/install/build/start/probe.
const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;
/** E2B refuses a sandbox lifetime over one hour ("400: Timeout cannot be greater than 1 hours").
 *  The derived per-lane deadline has to stay under it, and saying so at plan time beats discovering
 *  it from a raw provider 400 after a plan has already printed. */
const MAX_SANDBOX_MS = 60 * 60_000;
export const SUBJECT_DIR = "/home/user/subject";
// Remote path for the once-per-run packed local-tree archive; removed by the extract step
// after it unpacks into SUBJECT_DIR.
const LOCAL_TREE_REMOTE_ARCHIVE_PATH = "/home/user/.humanish-source.tar.gz";
const CLONE_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 180_000;
// Per-step budget for subject.state seed steps; each step's declared (or default) budget is
// also summed into the default sandbox deadline so seeding never eats the session's room.
const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;
// How much of a failing step's log tail rides the (redacted) error message.
const ERROR_TAIL_CHARS = 2000;

/**
 * One phase-boundary event from the shared subject provisioning pipeline (clone or local-tree
 * route): started/completed pairs at each named boundary, never per poll tick (the detached
 * primitive in e2b-detached.ts already polls every 1.5-3s internally; only the boundary itself
 * is surfaced here). Message text is public-safe by construction: no URLs beyond the existing
 * publicAppUrl convention, no paths, no command text. Completed events carry `ok` and
 * `durationMs`; started events (and the fire-and-forget `subject.serve.started`) carry neither.
 */
export interface SubjectPhaseEvent {
  at: string;
  type: string;
  ok?: boolean;
  durationMs?: number;
  message: string;
}

/**
 * Library-level hooks. `prepareDesktop` runs after sandbox creation and before subject
 * provisioning / browser launch — library callers use it for extra in-sandbox setup beyond
 * what `subject.serve` declares (or to provision an app-url subject entirely). The rest are
 * DI seams so CI drives the full path with fakes at zero network/zero spend.
 */
export interface CuaActorLabHooks extends BrowserLabAdapterHooks {
  /**
   * Runs after sandbox creation and before subject provisioning / browser launch. Widened
   * back-compatibly with per-lane context so a library caller can provision the right app-url
   * subject per lane (a one-arg `(desktop) => …` still satisfies the type). Called once per lane.
   */
  prepareDesktop?: (desktop: E2BDesktopSandbox, lane: { laneId: string; laneIndex: number; laneCount: number }) => Promise<void>;
  /**
   * Pre-flight hook: receives the resolved lane plan BEFORE any sandbox or provider call (dry-run
   * AND live). The engine also prints the plan to stderr; this seam lets tests assert it without
   * scraping stderr. Identical plan in dry-run, marked $0.
   */
  onPreflight?: (plan: CuaLanePlan) => void;
  /**
   * Live subject-provisioning phase sink: one call per started/completed boundary (clone,
   * upload/extract, install, build, serve start, ready, and each subject.state seed-step
   * group). Defaults to one stderr line per event, prefixed with the lane id when laneCount > 1
   * (single-lane emission is unconditional: single-lane silence for the whole boot is the bug
   * this event stream closes). Override in tests to capture instead of writing to real stderr.
   */
  onPhase?: (event: SubjectPhaseEvent, ctx: { laneId: string; laneCount: number }) => void;
  /**
   * Runtime-only live desktop stream callback. The URL carries an auth key and must never be
   * persisted into run artifacts; callers use it to hydrate an attached Observer server.
   */
  onRuntimeStreamReady?: (stream: {
    laneId: string;
    sandboxId: string;
    simId: string;
    streamId: string;
    url: string;
  }) => Promise<void> | void;
  /** Fired when a lane's sandbox is gone (finished or torn down): the live stream URL is now a
   *  dead noVNC page, so the watch overlay must stop serving it and let the tile fall back to
   *  recorded evidence (#357). Fired only for lanes whose onRuntimeStreamReady fired. */
  onRuntimeStreamEnded?: (stream: { laneId: string; simId: string; streamId: string }) => Promise<void> | void;
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  runSession?: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  /**
   * Supply a custom executor (e.g. a window.* JS-contract bridge over an already-running local
   * dev server). When present (with `buildProvider`), `runCuaActorLab` takes the IN-PROCESS
   * branch: it NEVER loads the E2B module, creates a sandbox, runs prepareDesktop, provisions a
   * clone, opens a browser, or starts a stream — so `result.sandbox` is omitted, the verifiable
   * "no E2B SDK call" proof. The whole bundle/Observer/redaction composition below the session
   * call is desktop-agnostic and runs unchanged. Receives the resolved config, the
   * registry-resolved descriptor, and the entry appUrl.
   */
  buildExecutor?: (ctx: { config: LabConfig; actor: CuaActorDescriptor; appUrl: string }) => Promise<CuaExecutor>;
  /**
   * Supply a custom provider (a "brain" reasoning over app STATE). REQUIRED alongside
   * `buildExecutor` — the default OpenAI provider is vision-based (requiresFrame) and would fail
   * closed against a state-only executor that returns no screenshot. (`buildProvider` ALONE is
   * allowed — that is just a model swap on the normal E2B route.)
   */
  buildProvider?: (ctx: { config: LabConfig; actor: CuaActorDescriptor }) => Promise<CuaProvider>;
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock (ms) for the host-side E2B desktop create->teardown span measurement that
   *  feeds the desktop-minute cost estimate. Defaults to Date.now; tests inject a frozen/stepped
   *  clock so the desktop-minute line is deterministic. */
  now?: () => number;
  /** Injected clock/sleep for the detached-step polling (tests only). */
  detachedTimers?: DetachedTimers;
  /**
   * Local-tree packing DI seam (tests only, no npm dependency needed to exercise the route):
   * defaults to createLocalTreeArchive(root, opts) plus a host-side read of the produced
   * archive file into an ArrayBuffer. Called ONCE per run, before lane fan-out, on the live
   * local-tree route; the result (archive metadata + bytes) is shared byte-identically across
   * every fan-out lane, so one archiveSha256 describes every lane's packed content.
   */
  packLocalTree?: (args: {
    root: string;
    extraExclude?: string[];
    maxArchiveBytes?: number;
  }) => Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }>;
}

export interface RunCuaActorLabOptions {
  cwd: string;
  config: LabConfig;
  /** Which manifest produced this run (#455); threaded into the run's status record + bundle. */
  lab?: RunLabProvenance;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  /** CLI `--count` override for the homogeneous fan-out lane count (ignored when a `lanes`
   *  roster is declared — a roster's length is authoritative). */
  countOverride?: number;
  /** Explicitly create a new run containing failed or selected lanes from a prior fan-out run. */
  rerun?: {
    sourceRunId: string;
    laneIds?: string[];
  };
  hooks?: CuaActorLabHooks;
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  /** Present only when the browser-route scorer hooks were CONFIG-DECLARED and loaded by the CLI
   *  (#316); core-stamped onto the bundle as evidence. Absent for library callers. */
  scorerProvenance?: RunScorerProvenance;
}

/** A lane's row in the pre-flight plan: identity + the device/persona it will drive. The prompt
 *  text never leaks — only a sha256-16 digest of the composed instructions. */
export interface CuaLanePlanEntry {
  id: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  /** 1-based display index. */
  index: number;
  persona: string;
  device: string;
  /** Requested E2B/X screen resolution. This is not the measured browser CSS viewport. */
  resolution: [number, number];
  instructionDigest: string;
  /** The declared reasoning effort for this lane, when the lab declared one. The plan line is what
   *  you read BEFORE spending money, so a declared per-lane difference has to be visible there. */
  reasoningEffort?: string;
  maxOutputTokens?: number;
  /** Present only when a lane overrides subject.appUrl; digest avoids leaking preview hosts in plan logs. */
  targetDigest?: string;
}

/** The pre-flight spend/lane plan (pure; printed to stderr + recorded as a bundle event before
 *  any sandbox or provider call; identical in dry-run, marked $0). */
export interface CuaLanePlan {
  strategy: typeof CUA_FANOUT_STRATEGY;
  laneCount: number;
  /** Effective in-flight bound (defaults to laneCount — all seats live; a declared
   *  execution.concurrency is a cap; the env override may only LOWER it). */
  concurrency: number;
  /** Present when the env override lowered the bound below the config's value — recorded so the
   *  plan never silently disagrees with the manifest. */
  envLoweredConcurrencyFrom?: number;
  /** ceil(laneCount / concurrency). */
  waves: number;
  /** Per-lane session wall-clock budget (execution.timeoutMs); there is no run-level wall clock. */
  perLaneSessionBudgetMs: number;
  /** Worst-case TOTAL sandbox-minutes across all lanes (each lane's full sandbox deadline). */
  worstCaseSandboxMinutes: number;
  /** True for a dry-run plan (no spend); the same table appears live. */
  dryRun: boolean;
  lanes: CuaLanePlanEntry[];
}

/** One lane's outcome in the result projection. ALWAYS present in `result.lanes` (length 1 at
 *  N=1). A `blocked` lane is one the pipeline-gate / fail-fast skipped before it ran. */
export interface CuaLaneResult {
  id: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  index: number;
  persona: string;
  device: string;
  /** Requested E2B/X screen resolution. See the run stream's desktopGeometry for measurements. */
  resolution: [number, number];
  /** Terminal lane status; "blocked" = skipped (gate/fail-fast); "contract_proof_only" = dry-run. */
  status: ActorStatus | "blocked" | "contract_proof_only";
  ok: boolean;
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
    screenshots: number;
  };
  sandbox?: {
    sandboxId: string;
    killed: boolean;
    streamUrlPresent: boolean;
  };
  subject: CuaSubjectProjection;
  /** Set when the lane was skipped (pinned reason string). */
  skippedReason?: string;
  error?: { code: CuaActorLabErrorCode; message: string };
}

/** Aggregate counts across lanes. */
export interface CuaLaneSummary {
  strategy: typeof CUA_FANOUT_STRATEGY;
  total: number;
  /** Lanes whose own verdict is ok (terminal, engaged, no harness error). */
  passed: number;
  /** Lanes skipped by the pipeline gate / fail-fast. */
  skipped: number;
  /** Lanes that ended in a harness error. */
  harnessErrors: number;
  /** Lanes that returned goal_satisfied with zero engagement (hollow). */
  hollow: number;
  concurrency: number;
  waves: number;
}

export type CuaActorLabErrorCode =
  | "HUMANISH_CUA_LAB_FAILED"
  | "HUMANISH_CUA_LAB_KEYS_MISSING"
  | "HUMANISH_CUA_LAB_SUBJECT_ENV_MISSING"
  | "HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED"
  | "HUMANISH_CUA_LAB_SUBJECT_INVALID"
  | "HUMANISH_CUA_LAB_SUBJECT_UNSAFE"
  | "HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER"
  | "HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR"
  | "HUMANISH_CUA_LAB_FANOUT_INVALID"
  | "HUMANISH_CUA_LAB_RERUN_INVALID"
  | "HUMANISH_CUA_LAB_DEVICE_GEOMETRY"
  // A fail-closed spend cap (execution.caps.maxUsd) was set but src/pricing.ts has no rate for the
  // resolved model, so the cap could not be enforced. Refused at preflight (before any sandbox)
  // rather than run uncapped — an unenforceable cap is more dangerous than none.
  | "HUMANISH_CUA_LAB_UNPRICED_CAP"
  // comms.email.external was declared but its catch did not answer as a humanish comms catch.
  // Refused at preflight (before any sandbox): a comms lab whose catch is unreachable collects
  // nothing while every lane still spends (#380).
  | "HUMANISH_CUA_LAB_COMMS_CATCH_UNREACHABLE"
  // watch --expose (tunnel-edge auth) validation + tunnel-startup failures surfaced by runCuaBackend
  // before or around the run. Carried on the CUA lab envelope so `watch <cua-lab> --expose` refusals
  // render through the same formatter as any other CUA lab failure.
  | "HUMANISH_WATCH_ALLOW_REQUIRES_OAUTH"
  | "HUMANISH_WATCH_OAUTH_REQUIRES_TUNNEL"
  | "HUMANISH_WATCH_OPTION_CONFLICT"
  | "HUMANISH_WATCH_TUNNEL_REQUIRES_EXPOSE"
  | "HUMANISH_WATCH_EXPOSE_REQUIRES_EDGE_AUTH"
  | "HUMANISH_WATCH_EXPOSE_REQUIRES_LIVE_FOLLOW"
  | "HUMANISH_WATCH_SAFE_NOT_APPLICABLE"
  | "HUMANISH_SERVE_TUNNEL_NOT_FOUND"
  | "HUMANISH_SERVE_TUNNEL_START_FAILED";

/** Subject provenance projection (invariant 5): what the actor actually drove. */
export interface CuaSubjectProjection {
  source: "app-url" | "clone" | "local-tree";
  /** Clone-route only: the (possibly redacted) owner/repo slug. */
  repo?: string;
  /** Cloned commit SHA (clone route) or host-side HEAD at pack time (local-tree route, when
   *  the packed root was a git work tree). */
  commit?: string;
  /** Local-tree-route only: 64-hex sha256 over the sorted packed-entries list: the content
   *  pin for a tree that cannot be commit-pinned. Absent on dry-run (nothing was packed). */
  archiveSha256?: string;
  /** Local-tree-route only: host-side porcelain status at pack time (true when the working
   *  tree had uncommitted changes). Absent when the packed root was not a git work tree. */
  dirty?: boolean;
  /** Declared env NAMES provisioned for the subject (values never surface anywhere). */
  envNames?: string[];
  /** The subject's state story (seeded digests / UNPINNED external / declared-not-run /
   *  undeclared): the same block the run bundle records. */
  state: RunSubjectProvenance["state"];
}

/** The provisioned-route-only shape threaded through as buildCuaBundle's subjectProvenance arg
 *  (clone or local-tree; an app-url subject stays undeclared, which buildCuaBundle's own
 *  default branch already handles without this type). */
export type CuaSubjectProvenanceArg =
  | { source: "clone"; repo: string; commit?: string; envNames: string[]; state: RunSubjectProvenance["state"] }
  | {
      source: "local-tree";
      archiveSha256?: string;
      commit?: string;
      dirty?: boolean;
      envNames: string[];
      state: RunSubjectProvenance["state"];
    };

export interface CuaActorLabResult {
  schema: typeof CUA_ACTOR_LAB_SCHEMA;
  /** True when the bundle verified AND (dry-run, or the session reached a terminal verdict
   * without a harness error). The actor's pass/fail is evidence, not the lab's exit code. */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the session. */
  actor: string;
  appUrl: string;
  dryRun: boolean;
  runId: string;
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
    screenshots: number;
  };
  sandbox?: {
    sandboxId: string;
    killed: boolean;
    /** The stream URL itself (carries an auth key) is runtime-only and is deliberately NOT
     * surfaced on the result — the sandbox is already dead by the time the result exists. */
    streamUrlPresent: boolean;
  };
  /** Subject provenance (invariant 5): what the actor actually drove. At N>1 this is the
   *  unanimity-gated aggregate (top-level `commit` only when every lane resolved the same one). */
  subject?: CuaSubjectProjection;
  /** The pre-flight lane plan (present once lanes resolve; absent on early validation errors). */
  plan?: CuaLanePlan;
  /** Per-lane results — ALWAYS present once lanes resolve (length 1 at N=1). */
  lanes?: CuaLaneResult[];
  /** Aggregate lane counts. */
  laneSummary?: CuaLaneSummary;
  /** Present when this run explicitly re-executes selected lanes from a prior CUA fan-out run. */
  rerun?: RunRerunLineage;
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code: CuaActorLabErrorCode;
    message: string;
  };
}

const DEFAULT_MISSION =
  "You are testing a web application. The browser is already open at the subject URL. Explore it, accomplish what the scenario asks, and stop when done.";

/** A fully-resolved fan-out lane: identity, the composed prompt, and the device geometry it
 *  renders at. Internal — the public projection is CuaLanePlanEntry / CuaLaneResult. */
export interface CuaLaneSpec {
  laneId: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  /** 0-based. */
  laneIndex: number;
  simId: string;
  streamId: string;
  persona: ActorPersonaRef;
  instructions: string;
  /** App-url fan-out only: this lane's explicit browser target; absent falls back to deps.appUrl. */
  targetUrl?: string;
  /** Deterministic harness-owned completion guard. Lane-level override, else actor default. */
  stopWhen?: StopWhen;
  /** A declared observation window (#510). Lane-level override, else actor default. */
  dwell?: DwellWindow;
  /**
   * How hard this lane's model is asked to think. Lane-level override, else the actor default,
   * else absent — and absent means the provider's own default, which the trace records as the
   * resolved value rather than as nothing (#497).
   */
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  /** The lab's declared protocol (#414). Every lane runs the SAME protocol — that is what makes the
   *  per-task rates comparable across participants. Goals are already composed into `instructions`;
   *  this carries the full tasks so the loop can corroborate completion, and the criteria never
   *  reach the prompt. */
  tasks?: readonly LabTask[];
  /** Per-lane override of the CUA idle backstop (consecutive screenshot/wait turns before gave_up).
   *  Absent falls back to the loop default. Raised for a lane whose job includes a long LEGITIMATE
   *  wait (e.g. a shared-world HOST idling in the waiting room while followers provision + join). */
  idleSteps?: number;
  /** Per-lane override of the non-idle no-progress backstop; see idleSteps. */
  noProgressSteps?: number;
  deviceName: string;
  devicePreset: DevicePreset;
  resolution: [number, number];
  /** "" for N=1 (screenshots/<name>); the laneId for N>1 (screenshots/<laneId>/<name>). */
  screenshotDir: string;
  /** "actor.json" for N=1; "actors/<streamId>.json" for N>1. */
  traceArtifactPath: string;
}

/**
 * The participant's outcome as ONE fixed first line of its last message (#570, second half). The
 * free-text computer-use provider has no schema to fill; a fixed line is the next best thing, and
 * the loop reads it into the trace's declaredOutcome. Prompt-only control is weak in general, so
 * adherence is measured (declaredOutcome present or absent on the trace) and the regex over the
 * paragraph stays as the fallback when the line is missing. This is a report format, deliberately
 * not a behavioural instruction: it says how to label the ending, never how to act.
 */
export const CLOSING_LINE_DIRECTIVE =
  "When you stop, make the FIRST line of your last message exactly one of these three, on its own line: "
  + "REACHED THE GOAL. / DID NOT REACH THE GOAL. / BLOCKED. "
  + "Then, from the next line, say what you did, what confused you, and where you hesitated.";

/** Compose one lane's actor prompt: persona line + device line + mission + per-lane steer.
 *  At N=1 (homogeneous, no roster) this reproduces the prior composeInstructions byte-for-byte. */
export function composeLaneInstructions(args: {
  mission: string;
  persona?: string;
  instruction?: string;
  /** The lab's declared protocol (#414). Only the participant-facing `goal` halves are rendered
   *  into the prompt; the `success` criteria never appear here. */
  tasks?: readonly LabTask[];
  device: { name: string; preset: DevicePreset };
  /** The COMPILED persona for `args.persona`, when its committed file resolved (#381). Supplying it
   *  makes the persona shape behavior — its traits become directives in the prompt and land in
   *  traitsApplied — instead of appearing as a bare `Persona: <id>.` label. Absent (unsafe id,
   *  no committed file, unparseable YAML) keeps the honest fallback: the bare line and an EMPTY
   *  traitsApplied, never fabricated traits. Resolved by the caller so this stays pure. */
  resolvedPersona?: ResolvedPersona;
  /**
   * desktop-cli (#495): the surface under study is a terminal window, not a page. Said plainly
   * because a participant whose every prior world was a browser will look for one — and because a
   * capability nobody declares is one the recording cannot later be read against. It states that a
   * terminal is open and NOT what to type in it: naming commands would answer the question the
   * study is asking.
   */
  surface?: "desktop-cli";
}): { instructions: string; persona: ActorPersonaRef } {
  const { name, preset } = args.device;
  const deviceLine = preset.isMobile
    ? `You are a mobile user on a ${name} device (${preset.width}x${preset.height} @${preset.deviceScaleFactor}x). Expect a mobile/touch layout.`
    : `You are a desktop user (${name}, ${preset.width}x${preset.height}).`;
  // The protocol as the PARTICIPANT reads it: numbered goals, nothing else. The success criteria
  // are the researcher's instrument and must never reach this prompt — a persona told how it will
  // be measured optimizes for the measurement instead of using the product (src/tasks.ts).
  const taskLines = renderTaskPrompt(args.tasks ?? []);
  // A resolved persona contributes its compiled directives (friction tolerance, skill bias,
  // accessibility behavior, constraints) through the SAME persona.ts compiler the terminal lane
  // uses, so one persona file means one behavior across every route.
  const personaLine = args.resolvedPersona
    ? renderPersonaPromptSection(args.resolvedPersona)
    : args.persona ? `Persona: ${args.persona}.` : undefined;
  const traitsApplied = args.resolvedPersona ? personaToDirectives(args.resolvedPersona).traitsApplied : [];
  const surfaceLine = args.surface === "desktop-cli"
    ? "A terminal window is already open on this desktop, and there is a terminal in the dock at the bottom of the screen if you want another. Everything you need is on this machine; there is no browser task here."
    : undefined;
  const parts = [
    personaLine,
    deviceLine,
    surfaceLine,
    args.mission,
    taskLines,
    args.instruction ? `Lane focus: ${args.instruction}` : undefined,
    CLOSING_LINE_DIRECTIVE
  ].filter((part): part is string => Boolean(part));
  const instructions = parts.join("\n\n");
  return {
    instructions,
    persona: {
      id: args.persona ?? "cua-operator",
      traitsApplied,
      promptDigest: digestText(instructions, 16)
    }
  };
}

/** Runtime-inject the persona inbox instruction into a lane's prompt (#297 slice B). The inbox URL is a
 *  runtime loopback/getHost address (not secret), so — mirroring the lobby-code runtime injection — this
 *  augments only the instructions the model receives; the authored prompt + its digest are unchanged.
 *  Returns a new spec (never mutates). Shared by the CUA + concurrent shared-world routes. */
export function withInboxMission(spec: CuaLaneSpec, inboxUrl: string, address?: string): CuaLaneSpec {
  // The address is half the handoff (#351): the drain matches captured mail against the DECLARED
  // address, so an actor that invents its own at signup gets an inbox that stays empty forever.
  // Telling it which address to use is what makes the funnel deterministic end to end. The
  // wait-steering sentence exists because a mid-flow model treats "we emailed you" as a blocker
  // and ends its session — the exact give-up class a live run documented — unless told the wait
  // is expected and the inbox is the next step.
  const identity = address === undefined ? "" : ` Your email address is ${address} — when the app asks for an email address, enter exactly that.`;
  return {
    ...spec,
    instructions: `${spec.instructions}\n\nEmail inbox:${identity} When the app tells you it has emailed you (a verification link, confirmation code, or magic link), open ${inboxUrl} in the browser to read that email and follow its link or enter its code. All email the app sends you arrives there. Waiting for an email is normal, not a blocker — do not end your session while waiting; open the inbox and refresh it until the email appears.`
  };
}

/** The lane's addressed comms recipient, when one exists — the gate AND the address source for the
 *  inbox instruction (#351). A lane told to check an inbox it can never receive into would stall,
 *  so no addressed recipient means no instruction. */
export function inboxRecipientFor(commsEmail: LabCommsEmail, laneId: string): LabCommsRecipient | undefined {
  return (commsEmail.recipients ?? []).find((recipient) => recipient.lane === laneId && recipient.address !== undefined);
}

/** True when a lane has a declared comms recipient WITH an address, so the drain can actually match the
 *  mail the persona will be told to read. Gates the inbox instruction to lanes that can receive mail —
 *  a lane told to check an inbox it can never receive into would just stall. */
export function laneHasInboxRecipient(commsEmail: LabCommsEmail, laneId: string): boolean {
  return inboxRecipientFor(commsEmail, laneId) !== undefined;
}

/** Mid-run inbox-surface render cadence (ms). Coarse enough that the per-tick `cat` + file writes stay
 *  cheap; fine enough that a verification email is visible seconds after the app sends it. */
const INBOX_SURFACE_CADENCE_MS = 2500;

/**
 * The narrowest browser WINDOW Chrome/Chromium will render on the E2B desktop. Chrome refuses to
 * make its window narrower than this (~500 CSS px observed: a 414-wide X screen produced a 500-wide
 * window that OVERFLOWED it, clipping the right edge of the page off-screen). So the physically
 * RENDERED screen width is floored here: a sub-500 mobile preset (mobile 414, small-mobile 360,
 * narrow-mobile 320) gets a 500-wide screen the window fits exactly — no clip. The device PRESET keeps
 * its true identity (isMobile, nominal width) for the persona prompt + metadata; only the rendered
 * screen is floored. True sub-500 CSS-viewport rendering (page laid out at 414 regardless of window
 * width, via CDP device-metric emulation) is the separate #221 upgrade.
 */
export const MIN_DESKTOP_RENDER_WIDTH = 500;

/** Floor a screen resolution's WIDTH to what Chrome can actually render (see MIN_DESKTOP_RENDER_WIDTH). */
export function floorRenderResolution(resolution: readonly [number, number]): [number, number] {
  return [Math.max(resolution[0], MIN_DESKTOP_RENDER_WIDTH), resolution[1]];
}

/**
 * The DECLARED preset to record alongside the rendered screen, or undefined when the preset
 * rendered faithfully.
 *
 * `desktopGeometry.screen.verified` compares the FLOORED number with itself, so on its own a
 * floored run is indistinguishable from a faithful one: a reader sees requested 500 / verified 500
 * and concludes a 500-wide screen was asked for. Recording the declared preset is what makes
 * "the preset width did not render" legible in the bundle.
 */
export function declaredScreenForRender(
  preset: DevicePreset,
  presetName: string,
  rendered: readonly [number, number],
): { width: number; height: number; preset: string } | undefined {
  if (preset.width === rendered[0] && preset.height === rendered[1]) return undefined;
  return { width: preset.width, height: preset.height, preset: presetName };
}

/**
 * Resolve a lane's device + rendered resolution (most-specific wins, exactly as the single-lane
 * path always has): a raw execution.desktop.resolution escape hatch (only legal when no lane
 * sets a device — XOR enforced at parse) → the lane's named device → the run-wide
 * execution.desktop.device → the default preset. A raw resolution is an unnamed custom desktop
 * (non-mobile, DSF 1): we never claim a named preset's mobile/DPR for hand-set geometry. The rendered
 * `resolution` is floored to MIN_DESKTOP_RENDER_WIDTH so the browser window fits its X screen (no clip);
 * `preset` keeps the declared device identity (a mobile preset stays 414/isMobile for the prompt).
 */
export function resolveLaneDevice(config: LabConfig, lane: LabActorLane | undefined): {
  name: string;
  preset: DevicePreset;
  resolution: [number, number];
} {
  const rawResolution = config.execution?.desktop?.resolution;
  if (lane?.device === undefined && rawResolution) {
    const preset: DevicePreset = { width: rawResolution[0], height: rawResolution[1], isMobile: false, deviceScaleFactor: 1 };
    return { name: "custom", preset, resolution: floorRenderResolution([rawResolution[0], rawResolution[1]]) };
  }
  const candidate = lane?.device ?? config.execution?.desktop?.device;
  const presetName = isDevicePresetName(candidate) ? candidate : DEFAULT_DEVICE_PRESET;
  const preset = resolveDevicePreset(presetName);
  return { name: presetName, preset, resolution: floorRenderResolution([preset.width, preset.height]) };
}

/** Per-lane sandbox deadline (each lane owns its own desktop). Mirrors the single-lane formula
 *  verbatim so N=1 stays byte-stable: explicit sandboxTimeoutMs, else session budget + (clone
 *  or local-tree: provision budget + Σ state-step budgets) + the server-side
 *  reclamation buffer. Local-tree shares the clone route's provisioning budget: it swaps a
 *  git clone for an upload+extract, but the shared install/build/state/start/probe pipeline
 *  costs the same wall-clock room either way. */
function resolvePerLaneSandboxMs(config: LabConfig): number {
  const timeoutMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
  const provisionedRoute = config.subject.source === "clone" || config.subject.source === "local-tree";
  const stateBudgetMs = provisionedRoute
    ? (config.subject.state?.seed ?? []).reduce((sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0)
    : 0;
  return config.execution?.desktop?.sandboxTimeoutMs
    ?? timeoutMs + (provisionedRoute ? SUBJECT_PROVISION_BUDGET_MS + stateBudgetMs : 0) + SANDBOX_TIMEOUT_BUFFER_MS;
}

/**
 * Effective in-flight lane bound. Defaults to laneCount — every declared seat runs at once,
 * because a throttle nobody asked for silently turns "N actors live" into waves (#350); total
 * session count and spend are the same either way, only wall-clock and simultaneity differ. A
 * declared execution.concurrency is a CAP, clamped to [1, laneCount]; the env override may only
 * LOWER it (never raise concurrent paid desktops — invariant 3), and a lowering is reported via
 * envLoweredFrom so the plan never silently disagrees with the manifest. Pure given
 * (config, laneCount, env).
 */
function resolveCuaConcurrency(config: LabConfig, laneCount: number, env: Record<string, string | undefined>): { bound: number; envLoweredFrom?: number } {
  const declared = config.execution?.concurrency;
  const base = Math.max(1, declared !== undefined ? Math.min(Math.max(1, declared), laneCount) : laneCount);
  const envLower = readPositiveInt(env[CUA_MAX_CONCURRENCY_ENV], 0);
  if (envLower > 0 && envLower < base) {
    return { bound: Math.max(1, Math.min(base, envLower, laneCount)), envLoweredFrom: base };
  }
  return { bound: base };
}

interface LaneSpecsAndPlan {
  lanes: CuaLaneSpec[];
  plan: CuaLanePlan;
}

/** Build the lane specs AND the public plan from a config (pure). countOverride is the CLI
 *  --count for homogeneous fan-out (ignored when a `lanes` roster is declared). */
function laneSpecsAndPlan(
  config: LabConfig,
  opts: { countOverride?: number; env?: Record<string, string | undefined>; dryRun?: boolean; personas?: Map<string, ResolvedPersona> } = {}
): LaneSpecsAndPlan {
  const env = opts.env ?? {};
  const actor = config.actors[0];
  const mission = actor?.mission ?? DEFAULT_MISSION;
  const tasks = actor?.tasks;
  const roster = actor?.lanes;
  const laneCount = roster ? roster.length : Math.max(1, opts.countOverride ?? actor?.count ?? 1);

  const lanes: CuaLaneSpec[] = [];
  for (let i = 0; i < laneCount; i += 1) {
    const lane = roster?.[i];
    const laneId = lane?.id ?? `lane-${String(i + 1).padStart(2, "0")}`;
    const simId = `sim-${String(i + 1).padStart(3, "0")}`;
    const streamId = `stream-${String(i + 1).padStart(3, "0")}`;
    const device = resolveLaneDevice(config, lane);
    // A lane's persona FALLS BACK to actors[0].persona, matching this field's own doc comment
    // in src/lab-config.ts and its sibling resolutions (stopWhen, reasoningEffort) two lines
    // below. Reading only lane.persona when a roster was present meant every fan-out lane of
    // every lab that declared actors[0].persona ran with no persona at all: no personaLine in
    // the prompt, traitsApplied [], and nothing warned (#512).
    const personaId = (lane?.persona ?? actor?.persona) as string | undefined;
    const resolvedPersona = personaId === undefined ? undefined : opts.personas?.get(personaId);
    const composed = composeLaneInstructions({
      mission,
      ...(tasks === undefined ? {} : { tasks }),
      ...(personaId === undefined ? {} : { persona: personaId }),
      ...(resolvedPersona === undefined ? {} : { resolvedPersona }),
      ...(((roster ? lane?.instruction : actor?.laneFocus?.instruction)) === undefined ? {} : { instruction: (roster ? lane?.instruction : actor?.laneFocus?.instruction) as string }),
      device: { name: device.name, preset: device.preset },
      ...(config.subject.source === "desktop-cli" ? { surface: "desktop-cli" as const } : {})
    });
    lanes.push({
      laneId,
      ...(lane?.actorType === undefined ? {} : { actorType: lane.actorType }),
      ...(lane?.surface === undefined ? {} : { surface: lane.surface }),
      ...(lane?.caseGroup === undefined ? {} : { caseGroup: lane.caseGroup }),
      laneIndex: i,
      simId,
      streamId,
      persona: composed.persona,
      instructions: composed.instructions,
      ...(lane?.target === undefined ? {} : { targetUrl: lane.target }),
      ...((lane?.stopWhen ?? actor?.stopWhen) === undefined ? {} : { stopWhen: (lane?.stopWhen ?? actor?.stopWhen) as StopWhen }),
      ...((lane?.dwell ?? actor?.dwell) === undefined ? {} : { dwell: (lane?.dwell ?? actor?.dwell) as DwellWindow }),
      ...((lane?.reasoningEffort ?? actor?.reasoningEffort) === undefined
        ? {}
        : { reasoningEffort: (lane?.reasoningEffort ?? actor?.reasoningEffort) as ReasoningEffort }),
      ...(actor?.maxOutputTokens === undefined ? {} : { maxOutputTokens: actor.maxOutputTokens }),
      ...(tasks === undefined ? {} : { tasks }),
      deviceName: device.name,
      devicePreset: device.preset,
      resolution: device.resolution,
      screenshotDir: laneCount === 1 ? "" : laneId,
      traceArtifactPath: laneCount === 1 ? "actor.json" : `actors/${streamId}.json`
    });
  }

  const resolved = resolveCuaConcurrency(config, laneCount, env);
  const concurrency = resolved.bound;
  const perLaneSessionBudgetMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
  const perLaneSandboxMs = resolvePerLaneSandboxMs(config);
  const plan: CuaLanePlan = {
    strategy: CUA_FANOUT_STRATEGY,
    laneCount,
    concurrency,
    ...(resolved.envLoweredFrom === undefined ? {} : { envLoweredConcurrencyFrom: resolved.envLoweredFrom }),
    waves: Math.ceil(laneCount / concurrency),
    perLaneSessionBudgetMs,
    worstCaseSandboxMinutes: Math.round((laneCount * perLaneSandboxMs) / 60_000),
    dryRun: opts.dryRun === true,
    lanes: lanes.map((spec) => ({
      id: spec.laneId,
      ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
      ...(spec.surface === undefined ? {} : { surface: spec.surface }),
      ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
      index: spec.laneIndex + 1,
      persona: spec.persona.id,
      device: spec.deviceName,
      resolution: spec.resolution,
      instructionDigest: spec.persona.promptDigest,
      ...(spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort }),
      ...(spec.maxOutputTokens === undefined ? {} : { maxOutputTokens: spec.maxOutputTokens }),
      ...(spec.targetUrl === undefined ? {} : { targetDigest: digestUrl(spec.targetUrl) })
    }))
  };
  return { lanes, plan };
}

async function resolveCuaRerunSelection(args: {
  cwd: string;
  config: LabConfig;
  sourceRunId: string;
  laneIds?: string[];
  laneSpecs: CuaLaneSpec[];
  plan: CuaLanePlan;
}): Promise<
  | { ok: true; laneSpecs: CuaLaneSpec[]; plan: CuaLanePlan; rerun: RunRerunLineage }
  | { ok: false; message: string }
> {
  const source = await loadRunBundle(args.cwd, args.sourceRunId);
  if (!source) {
    return { ok: false, message: `source run not found or invalid: ${args.sourceRunId}` };
  }
  const bundle = source.bundle;
  if (bundle.mode !== "live") {
    return { ok: false, message: `source run ${bundle.runId} is ${bundle.mode}; rerun selection only applies to live CUA fan-out evidence.` };
  }
  const fanoutEvent = bundle.events.some((event) => event.type === "cua-lab.fanout.plan");
  if (!fanoutEvent || bundle.streams.length < 2) {
    return { ok: false, message: `source run ${bundle.runId} is not a CUA fan-out run.` };
  }

  const prior = bundle.streams
    .map(snapshotPriorCuaLane)
    .filter((lane): lane is ReturnType<typeof snapshotPriorCuaLane> & { laneId: string } => lane !== null);
  const priorById = new Map(prior.map((lane) => [lane.laneId, lane]));
  if (priorById.size < 2) {
    return { ok: false, message: `source run ${bundle.runId} does not expose multiple lane ids.` };
  }

  const explicitLaneIds = uniqueLaneIds(args.laneIds ?? []);
  const selectedLaneIds = explicitLaneIds.length > 0
    ? explicitLaneIds
    : prior.filter((lane) => lane.rerunnable).map((lane) => lane.laneId);
  if (selectedLaneIds.length === 0) {
    return { ok: false, message: `source run ${bundle.runId} has no failed, blocked, timed-out, or hollow lanes to rerun.` };
  }

  const missingPrior = selectedLaneIds.filter((laneId) => !priorById.has(laneId));
  if (missingPrior.length > 0) {
    return { ok: false, message: `selected lane id(s) were not present in source run ${bundle.runId}: ${missingPrior.join(", ")}` };
  }

  const specsById = new Map(args.laneSpecs.map((spec) => [spec.laneId, spec]));
  const missingCurrent = selectedLaneIds.filter((laneId) => !specsById.has(laneId));
  if (missingCurrent.length > 0) {
    return { ok: false, message: `selected lane id(s) are not present in the current lab config ${args.config.id}: ${missingCurrent.join(", ")}` };
  }

  const selectedSpecs = selectedLaneIds.map((laneId) => specsById.get(laneId)!);
  const selectedPlanLaneIds = new Set(selectedLaneIds);
  const selectedPlanEntries = args.plan.lanes.filter((lane) => selectedPlanLaneIds.has(lane.id));
  const concurrency = Math.max(1, Math.min(args.plan.concurrency, selectedSpecs.length));
  const plan: CuaLanePlan = {
    ...args.plan,
    laneCount: selectedSpecs.length,
    concurrency,
    waves: Math.ceil(selectedSpecs.length / concurrency),
    worstCaseSandboxMinutes: Math.round((selectedSpecs.length * resolvePerLaneSandboxMs(args.config)) / 60_000),
    lanes: selectedPlanEntries
  };

  const previous = selectedLaneIds.map((laneId) => priorById.get(laneId)!.previous);
  return {
    ok: true,
    laneSpecs: selectedSpecs,
    plan,
    rerun: {
      sourceRunId: bundle.runId,
      selectedLaneIds,
      previous
    }
  };
}

function uniqueLaneIds(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const laneId = value.trim();
    if (!laneId || seen.has(laneId)) continue;
    seen.add(laneId);
    result.push(laneId);
  }
  return result;
}

function snapshotPriorCuaLane(stream: RunStream): { laneId: string; previous: RunRerunLineage["previous"][number]; rerunnable: boolean } | null {
  if (stream.kind !== "browser" || typeof stream.laneId !== "string" || !stream.laneId.trim()) {
    return null;
  }
  const actorStatus = stream.actor?.status;
  const completionReason = stream.actor?.completionReason;
  const reason = stream.ui?.state ?? stream.actor?.reason;
  const actions = stream.actor?.counts.actions ?? 0;
  const messages = stream.actor?.counts.messages ?? 0;
  const hollow = completionReason === "goal_satisfied" && actions === 0 && messages === 0;
  const rerunnable = stream.status !== "passed"
    || actorStatus === "failed"
    || actorStatus === "blocked"
    || actorStatus === "timed_out"
    || completionReason === "harness_error"
    || hollow;
  return {
    laneId: stream.laneId,
    previous: {
      laneId: stream.laneId,
      streamId: stream.id,
      status: stream.status,
      ...(reason === undefined ? {} : { reason }),
      ...(actorStatus === undefined ? {} : { actorStatus }),
      ...(completionReason === undefined ? {} : { completionReason })
    },
    rerunnable
  };
}

/**
 * Pure pre-flight plan resolver (runs in dry-run AND live). Returns the lane table, the
 * effective concurrency, the wave count, the per-lane session budget, and the worst-case total
 * sandbox-minutes — BEFORE any sandbox or provider call. The same plan appears in dry-run,
 * marked $0 (dryRun: true).
 */
export function resolveCuaLanePlan(
  config: LabConfig,
  opts: { countOverride?: number; env?: Record<string, string | undefined>; dryRun?: boolean; personas?: Map<string, ResolvedPersona> } = {}
): CuaLanePlan {
  return laneSpecsAndPlan(config, opts).plan;
}

/** Print the lane plan to stderr BEFORE any sandbox/provider call (public-safe: ids, devices,
 *  digests, and budgets only — no prompt text, no secrets). */
function emitPreflightPlan(plan: CuaLanePlan, labId: string): void {
  const lines: string[] = [];
  lines.push(
    `humanish cua fan-out plan (${labId}): ${plan.laneCount} lane(s), strategy ${plan.strategy}, concurrency ${plan.concurrency}${plan.envLoweredConcurrencyFrom === undefined ? "" : ` (lowered from ${plan.envLoweredConcurrencyFrom} by ${CUA_MAX_CONCURRENCY_ENV})`}, ${plan.waves} wave(s).`
  );
  lines.push(
    `  per-lane session budget ${Math.round(plan.perLaneSessionBudgetMs / 1000)}s; worst-case ~${plan.worstCaseSandboxMinutes} sandbox-minutes total${plan.dryRun ? " (dry-run: $0)" : ""}.`
  );
  for (const lane of plan.lanes) {
    lines.push(`  - ${formatLanePlanEntry(lane)}`);
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

function formatLanePlanEntry(lane: CuaLanePlanEntry): string {
  const taxonomy = [
    lane.actorType ? `type=${lane.actorType}` : undefined,
    lane.surface ? `surface=${lane.surface}` : undefined,
    lane.caseGroup ? `case=${lane.caseGroup}` : undefined,
    lane.reasoningEffort ? `effort=${lane.reasoningEffort}` : undefined
  ].filter((part): part is string => part !== undefined);
  return `${lane.id}: persona=${lane.persona}${taxonomy.length > 0 ? ` ${taxonomy.join(" ")}` : ""} device=${lane.device} ${lane.resolution[0]}x${lane.resolution[1]} prompt#${lane.instructionDigest}${lane.targetDigest ? ` target#${lane.targetDigest}` : ""}`;
}

/** ISO timestamp from an injectable clock (tests freeze `now` for deterministic durationMs). */
function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

/** Emit a phase-started event (no ok/durationMs: those belong to the matching completed event). */
/**
 * Run a provisioning step and, when it fails with an EXIT CODE, run it once more (#602). A cold
 * install of 0.74.0 lost its whole first live study to one transient TLS error inside the
 * sandbox's `npm install`; the parallel install twenty seconds later passed, as had the ten
 * before it. One retry clears that class. A TIMEOUT is not retried: its budget is already spent,
 * and a second wait would double it. The retry runs under its own step name so both logs stay.
 */
async function runProvisioningStepWithOneRetry(
  desktop: E2BDesktopSandbox,
  args: {
    name: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    requestTimeoutMs: number;
    timers: Partial<Pick<DetachedStepOptions, "now" | "sleep" | "pollIntervalMs">>;
    /** Phase name for the retry's own started/completed events (`cua-lab.subject.<phase>.*`). */
    retryPhase: string;
    retryMessage: string;
    onPhase: ((event: SubjectPhaseEvent) => void) | undefined;
    now: () => number;
  }
): Promise<DetachedStepResult & { attempts: 1 | 2; firstExitCode?: number }> {
  const first = await runDetachedStep(desktop, {
    name: args.name,
    command: args.command,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    requestTimeoutMs: args.requestTimeoutMs,
    ...args.timers
  });
  if (first.ok || first.timedOut) return { ...first, attempts: 1 };
  const retryStartedAt = args.now();
  emitPhaseStarted(
    args.onPhase,
    args.now,
    args.retryPhase,
    `${args.retryMessage} (first attempt exited ${first.exitCode ?? "null"}; retrying once)`
  );
  const second = await runDetachedStep(desktop, {
    name: `${args.name}-retry`,
    command: args.command,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    requestTimeoutMs: args.requestTimeoutMs,
    ...args.timers
  });
  emitPhaseCompleted(
    args.onPhase,
    args.now,
    retryStartedAt,
    args.retryPhase,
    second.ok,
    second.ok ? `${args.retryMessage}: succeeded on the second attempt` : `${args.retryMessage}: failed twice`
  );
  return { ...second, attempts: 2, ...(first.exitCode === undefined ? {} : { firstExitCode: first.exitCode }) };
}

function emitPhaseStarted(
  onPhase: ((event: SubjectPhaseEvent) => void) | undefined,
  now: () => number,
  phase: string,
  message: string
): void {
  onPhase?.({ at: isoNow(now), type: `cua-lab.subject.${phase}.started`, message });
}

/** Emit the matching phase-completed event: always carries ok and durationMs (>= 0). */
function emitPhaseCompleted(
  onPhase: ((event: SubjectPhaseEvent) => void) | undefined,
  now: () => number,
  startedAt: number,
  phase: string,
  ok: boolean,
  message: string
): void {
  onPhase?.({
    at: isoNow(now),
    type: `cua-lab.subject.${phase}.completed`,
    ok,
    durationMs: Math.max(0, now() - startedAt),
    message
  });
}

/** Default phase-boundary sink (stderr): one line per event, prefixed with the lane id ONLY
 *  when laneCount > 1. Single-lane emission is unconditional: total single-lane silence for the
 *  whole clone/install/build/ready boot is the bug this event stream exists to close.
 *  Overridable via CuaActorLabHooks.onPhase so deterministic tests capture instead of writing to
 *  the real stderr. */
function defaultSubjectPhaseSink(event: SubjectPhaseEvent, ctx: { laneId: string; laneCount: number }): void {
  const durationSuffix = event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`;
  const prefix = ctx.laneCount > 1 ? `humanish cua [${ctx.laneId}]` : "humanish cua";
  process.stderr.write(`${prefix}: ${event.message}${durationSuffix}\n`);
}

/** Short id-safe suffix for a subject-phase RunEvent: drops the shared prefix/suffix so each
 *  phase gets a distinct bundle event id (e.g. "clone", "state-before-build"). */
function phaseEventIdSuffix(type: string): string {
  return type
    .replace(/^cua-lab\.subject\./, "")
    .replace(/\.(started|completed)$/, "")
    .replace(/\./g, "-");
}

/** Shared deps every lane runner needs (resolved once in the engine). */
/**
 * The STUDY's shared spend ledger (#299): one counter across every lane. Each lane notes its own
 * latest running MODEL-spend estimate (monotone per lane — an estimate can only grow) and reads
 * back the run total; the loop stops the lane the moment the total crosses the study budget.
 * Estimated model spend only: desktop-minutes ride the cost summary, not this ledger.
 */
export interface CuaRunBudget {
  maxTotalUsd: number;
  /** Record this lane's latest running estimate (null = unpriceable, ignored) and return the
   *  run's current total across all lanes. */
  note(laneId: string, estimateUsd: number | null): number;
}

export function makeCuaRunBudget(maxTotalUsd: number): CuaRunBudget {
  const laneEstimates = new Map<string, number>();
  return {
    maxTotalUsd,
    note(laneId, estimateUsd) {
      if (estimateUsd !== null) laneEstimates.set(laneId, estimateUsd);
      let total = 0;
      for (const value of laneEstimates.values()) total += value;
      return total;
    }
  };
}

export interface CuaLaneDeps {
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  /** When set, the computer-use brain is this locally-signed-in CLI instead of a keyed API. */
  localAgent?: LocalAgentId;
  cloneRoute: boolean;
  /** desktop-cli (#495): a CLI studied at a desktop. Nothing is cloned and no browser is opened. */
  desktopCliRoute?: boolean;
  /** Optional so out-of-scope callers building CuaLaneDeps directly (other engines reusing
   *  runCuaLane) do not need to know about the local-tree route; undefined behaves as false. */
  localTreeRoute?: boolean;
  serve?: LabSubjectServe;
  subjectRepo?: string;
  subjectEnvNames: string[];
  hasGithubToken: boolean;
  /** Local-tree route only: the once-per-run packed archive bytes, shared byte-identically
   *  across every fan-out lane's upload step. Absent on dry-run and every other route. */
  localTreeArchiveBuffer?: ArrayBuffer;
  env: Record<string, string | undefined>;
  openaiApiKey: string;
  e2bApiKey: string;
  requestTimeoutMs: number;
  perLaneSandboxMs: number;
  timeoutMs: number;
  laneCount: number;
  artifactRoot: PreparedOutputDirectory;
  /** The lab's resolution directory: relative paths in the config (a camera .y4m) resolve here. */
  labCwd: string;
  redactScreenshots: boolean;
  scrubKnownValues: (text: string) => string;
  runSession: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  /** The study's shared spend ledger, present exactly when execution.caps.maxTotalUsd is set on a
   *  live run (#299). Preflight already refused the cap on an unpriced model. */
  runBudget?: CuaRunBudget;
  /** Adopter-hosted comms plane (#380): present on the app-url route when comms.email.external is
   *  declared. Carries the parsed comms block (recipients drive the per-lane inbox instruction)
   *  and the inbox URL the persona opens. The drain runs once at run level, not per lane. */
  externalComms?: { email: LabCommsEmail; inboxUrl: string };
  /** Injected clock (ms). Used to measure the host-side E2B desktop create->teardown span so the
   *  desktop-minute cost estimate is deterministic in tests. Defaults to Date.now. */
  now: () => number;
  hooks: CuaActorLabHooks;
  /** Lane-0 only: signal the pipeline gate after provisioning succeeds (true) or fails (false). */
  signalProvisioned?: (ok: boolean) => void;
  /**
   * How a PARSEABLE requested-vs-verified screen mismatch is treated. Default ("fail-closed"):
   * the lane's device claim is falsified, so the lane fails with DEVICE_GEOMETRY (the
   * single-lane/fan-out contract). "record-evidence" (the concurrent shared-world route):
   * requested and verified stay recorded as separate facts plus an explicit warning, and the
   * lane keeps running, so one seat's screen drift cannot abort a live multi-actor world.
   */
  screenMismatchPolicy?: "fail-closed" | "record-evidence";
  /**
   * RUNTIME-ONLY observed-URL callback (#164 handoff crux): threaded into the lane's session so the
   * orchestrator watches this seat's live location.href mid-run. Never persisted (see
   * CuaLoopOptions.onObservedUrl). The concurrent shared-world barrier passes a host-seat latch here
   * to extract a /lobby/CODE; on ordinary routes it is undefined (no-op).
   */
  onObservedUrl?: (url: string | undefined) => void;
  /** RUNTIME-ONLY per-turn narration callback; see CuaLoopOptions.onMessage. The concurrent
   * shared-world barrier passes a host-seat message scanner here to latch the lobby code. */
  onMessage?: (text: string) => void;
  /** RUNTIME-ONLY per-turn raw-frame callback; see CuaLoopOptions.onScreenshot. The concurrent
   * shared-world barrier passes a host-seat vision reader here to latch the lobby code off-screen. */
  onScreenshot?: (frame: Buffer) => void;
  /** Per-turn trace snapshot from a lane's loop (#441), keyed by lane. The live path wires the
   * incremental in-progress flush here so the attached Observer's timeline grows mid-run. */
  onTrace?: (laneId: string, items: readonly ActorTraceItem[], usage?: ActorTokenUsage) => void;
}

/** One lane's end-to-end run outcome (internal; projected into CuaLaneResult + the bundle). */
export interface LaneRunOutcome {
  spec: CuaLaneSpec;
  session?: CuaLoopResult;
  sessionError?: string;
  sandboxId?: string;
  /** Host-side E2B desktop create->teardown span (ms). An APPROXIMATION of E2B's server-side
   *  billed lifetime (server-side kill-on-timeout can extend it) — so the derived dollar figure is
   *  doubly an estimate. Absent on the in-process route (no sandbox) and on dry-run. */
  desktopDurationMs?: number;
  desktopResources?: DesktopResourceObservation;
  killed: boolean;
  streamUrlPresent: boolean;
  screenshots: string[];
  subjectCommit?: string;
  desktopBrowser?: DesktopBrowserEvidence;
  /** Requested + measured desktop/browser geometry. Viewport is absent when measurement failed. */
  desktopGeometry?: RunDesktopGeometry;
  stateStepRecords: RunSubjectStateStepRecord[];
  /** Completed subject-phase records (clone/upload/extract/install/build/ready/state groups),
   *  folded into bundle.events at build time. Empty on the in-process route (no provisioning). */
  phaseRecords: SubjectPhaseEvent[];
  warnings: string[];
  /** Set when the lane was skipped by the pipeline gate / fail-fast (a pinned reason). */
  skippedReason?: string;
  noEngagement: boolean;
  selfReportedBlocker: boolean;
  /** The inclusive friction read (#453): blocker-shaped narration incl. self-resolved arcs.
   *  Feeds the participants tally and feedback candidates; never the lane verdict. Optional so
   *  external outcome constructors (shared-world, test fakes) stay valid; absent counts as false. */
  reportedFriction?: boolean;
  harnessError: boolean;
  failureCode?: CuaActorLabErrorCode;
  entryKind?: "local-app";
  /** Relative run-dir path of the digest-only comms-thread evidence artifact this lane wrote
   *  (humanish.comms-thread.v1), when a comms lab captured mail into its in-sandbox catch. Registered
   *  in the lane's stream artifacts. Absent when no comms lab ran or nothing was captured. */
  commsArtifactPath?: string;
}

/** Build a lane's writeScreenshot closure: writes under screenshots/<screenshotDir>/ and records
 *  the relative path the trace references (screenshots/<name> at N=1; screenshots/<laneId>/<name>
 *  at N>1). */
export function makeLaneWriteScreenshot(
  artifactRoot: PreparedOutputDirectory,
  spec: { screenshotDir: string },
  screenshots: string[]
): (name: string, bytes: Buffer) => Promise<string> {
  if (spec.screenshotDir) {
    assertSafeOutputPathSegment(spec.screenshotDir, "Screenshot lane id");
  }
  const dirParts = spec.screenshotDir ? ["screenshots", spec.screenshotDir] : ["screenshots"];
  const relPrefix = spec.screenshotDir ? path.posix.join("screenshots", spec.screenshotDir) : "screenshots";
  return async (name: string, bytes: Buffer): Promise<string> => {
    assertSafeOutputPathSegment(name, "Screenshot name");
    const rel = path.posix.join(relPrefix, name);
    assertScreenshotEvidence(rel, bytes);
    await writeContainedOutputFile(artifactRoot, path.join(...dirParts, name), bytes);
    screenshots.push(rel);
    return rel;
  };
}

/**
 * Verify the desktop screen geometry IN-SANDBOX (the per-lane device claim is checked, never
 * assumed). A parseable mismatch fails closed. Unavailable/unparseable evidence is returned as
 * an explicit warning: the lane may still run, but its bundle records only the requested screen
 * and never upgrades that request into a verified measurement.
 */
export async function inspectDesktopScreenGeometry(args: {
  desktop: E2BDesktopSandbox;
  laneId: string;
  requestedScreen: readonly [number, number];
  requestTimeoutMs: number;
}
): Promise<{
  verified?: RunDesktopGeometry["screen"]["verified"];
  error?: string;
  warning?: string;
}> {
  let out = "";
  try {
    const result = await args.desktop.commands.run("xdpyinfo 2>/dev/null | grep -i dimensions || true", { requestTimeoutMs: args.requestTimeoutMs });
    out = (result.stdout ?? "").trim();
  } catch {
    return { warning: `Desktop screen geometry could not be measured for lane ${args.laneId}; requested geometry remains unverified.` };
  }
  const match = out.match(/(\d+)\s*x\s*(\d+)\s*pixels/i);
  if (!match) {
    return { warning: `Desktop screen geometry could not be parsed for lane ${args.laneId}; requested geometry remains unverified.` };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const [expectedWidth, expectedHeight] = args.requestedScreen;
  if (width === expectedWidth && height === expectedHeight) {
    return { verified: { width, height, source: "xdpyinfo" } };
  }
  return {
    verified: { width, height, source: "xdpyinfo" },
    error: `HUMANISH_CUA_LAB_DEVICE_GEOMETRY: lane ${args.laneId} requested a ${expectedWidth}x${expectedHeight} desktop but xdpyinfo reports ${width}x${height} in-sandbox; the per-lane device geometry is unverified (fail-closed).`
  };
}

/** A blocked lane outcome (pipeline gate / fail-fast skipped it before it ran). */
function blockedLaneOutcome(spec: CuaLaneSpec, reason: string): LaneRunOutcome {
  return {
    spec,
    killed: false,
    streamUrlPresent: false,
    screenshots: [],
    stateStepRecords: [],
    phaseRecords: [],
    warnings: [],
    skippedReason: reason,
    noEngagement: false,
    selfReportedBlocker: false,
    reportedFriction: false,
    harnessError: false
  };
}

async function findVisibleBrowserWindowId(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  browserFamily: DesktopBrowserFamily,
  launchIdentity: DesktopBrowserLaunchIdentity | undefined
): Promise<string | undefined> {
  if (browserFamily === "unknown") return undefined;
  // The candidate loop keeps the LAST identity match: with a launch identity the match is
  // unique anyway, and without one every family candidate matches, so the newest visible
  // window of the launched family wins (the window this lane just opened).
  const finder = browserFamily === "firefox"
    ? [
        "find_firefox_window() {",
        "  timeout 2s xdotool search --onlyvisible --class 'firefox|Firefox' 2>/dev/null || true",
        "}",
        "window_id=",
        "for _ in $(seq 1 10); do",
        "  for candidate in $(find_firefox_window); do",
        "    window_pid=\"$(xdotool getwindowpid \"$candidate\" 2>/dev/null || true)\"",
        "    if matches_launch_identity \"$window_pid\"; then window_id=\"$candidate\"; fi",
        "  done",
        "  if [ -n \"$window_id\" ]; then break; fi",
        "  sleep 0.5",
        "done"
      ]
    : [
        "find_chrome_window() {",
        "  timeout 2s xdotool search --onlyvisible --class 'google-chrome|Google-chrome|chromium|Chromium|chrome|Chrome' 2>/dev/null || true",
        "}",
        "window_id=",
        "for _ in $(seq 1 10); do",
        "  for candidate in $(find_chrome_window); do",
        "    window_pid=\"$(xdotool getwindowpid \"$candidate\" 2>/dev/null || true)\"",
        "    if matches_launch_identity \"$window_pid\"; then window_id=\"$candidate\"; fi",
        "  done",
        "  if [ -n \"$window_id\" ]; then break; fi",
        "  sleep 0.5",
        "done"
      ];
  const result = await desktop.commands.run([
    "set -euo pipefail",
    "export DISPLAY=\"${DISPLAY:-:0}\"",
    `launch_pid=${shellSingleQuote(launchIdentity?.processId ?? "")}`,
    `profile_dir=${shellSingleQuote(launchIdentity?.profileDir ?? "")}`,
    "matches_launch_identity() {",
    "  if [ -z \"$launch_pid\" ] && [ -z \"$profile_dir\" ]; then return 0; fi",
    "  local current=\"${1:-}\"",
    "  while [[ \"$current\" =~ ^[0-9]+$ ]] && [ \"$current\" -gt 1 ]; do",
    "    cmdline=\"$(tr '\\0' ' ' < \"/proc/$current/cmdline\" 2>/dev/null || true)\"",
    "    if [ -n \"$profile_dir\" ] && [[ \"$cmdline\" == *\"$profile_dir\"* ]]; then return 0; fi",
    "    if [ \"$current\" = \"$launch_pid\" ]; then return 0; fi",
    "    current=\"$(ps -o ppid= -p \"$current\" 2>/dev/null | tr -d ' ' || true)\"",
    "  done",
    "  return 1",
    "}",
    ...finder,
    "if [ -n \"$window_id\" ]; then printf 'WINDOW_ID=%s\\n' \"$window_id\"; fi"
  ].join("\n"), {
    requestTimeoutMs,
    timeoutMs: 15_000
  });
  return (result.stdout ?? "").match(/^WINDOW_ID=(\S+)$/m)?.[1];
}

/**
 * Build the xdotool command that makes a browser window fill the desktop.
 * Exported (pure) for contract tests. A window manager can ignore Chrome's
 * --window-size, so xdotool is the robust path: move the window to the origin,
 * then size it to the exact desktop resolution so Observer screenshots carry no
 * dead margin around the browser.
 */
export function buildFillDesktopWindowCommand(
  windowId: string,
  width: number,
  height: number,
): string {
  return [
    "set -euo pipefail",
    `win=${shellSingleQuote(windowId)}`,
    `xdotool windowactivate "$win" >/dev/null 2>&1 || true`,
    `xdotool windowmove "$win" 0 0 >/dev/null 2>&1 || true`,
    `xdotool windowsize "$win" ${width} ${height} >/dev/null 2>&1 || true`,
  ].join("\n");
}

/**
 * Best-effort initial fill. A contained smaller window remains usable; the capture
 * below checks for clipping and refuses an uncorrectable window before the actor runs.
 */
async function fillDesktopBrowserWindow(
  desktop: E2BDesktopSandbox,
  windowId: string,
  resolution: readonly [number, number],
  requestTimeoutMs: number,
): Promise<void> {
  const [width, height] = resolution;
  await desktop.commands
    .run(buildFillDesktopWindowCommand(windowId, width, height), {
      requestTimeoutMs,
      timeoutMs: 10_000,
    })
    .catch(() => undefined);
}

async function openDesktopBrowserTarget(
  desktop: E2BDesktopSandbox,
  targetUrl: string,
  requestTimeoutMs: number,
  browserPreference: LabDesktopBrowser | undefined,
  /** Launch-time flags that make mobile fidelity (#221) hold across every tab: the user agent and
   *  touch events are browser-wide here, where the CDP holder covers only the launch page. */
  extraChromiumFlags: readonly string[] = []
): Promise<DesktopBrowserLaunchResult> {
  const requestedBrowser = browserPreference ?? "default";
  if (isHttpUrl(targetUrl)) {
    const chromiumFlags = [...CHROMIUM_EVIDENCE_HYGIENE_FLAGS, ...extraChromiumFlags].map(shellSingleQuote).join(" ");
    const browserLaunchCommand = [
      "set -euo pipefail",
      `target_url=${shellSingleQuote(targetUrl)}`,
      `browser_preference=${shellSingleQuote(requestedBrowser)}`,
      "chrome_profile_dir=",
      `chrome_preferences_json=${shellSingleQuote(chromiumEvidenceProfilePreferencesJson())}`,
      "prepare_chrome_profile() {",
      "  chrome_profile_dir=\"$(mktemp -d /tmp/humanish-chrome-profile.XXXXXX)\"",
      "  mkdir -p \"$chrome_profile_dir/Default\"",
      "  printf '%s\\n' \"$chrome_preferences_json\" > \"$chrome_profile_dir/Default/Preferences\"",
      "}",
      "launch_browser() {",
      "  local label=\"$1\"",
      "  local binary=\"$2\"",
      "  shift 2",
      "  if command -v \"$binary\" >/dev/null 2>&1; then",
      "    nohup \"$binary\" \"$@\" \"$target_url\" >/tmp/humanish-browser-open.log 2>&1 &",
      "    local launch_pid=$!",
      "    printf 'HUMANISH_BROWSER_RESOLVED=%s\\n' \"$label\"",
      "    printf 'HUMANISH_BROWSER_PID=%s\\n' \"$launch_pid\"",
      "    printf 'HUMANISH_BROWSER_PROFILE_DIR=%s\\n' \"$chrome_profile_dir\"",
      "    if [[ \"$label\" =~ ^(google-chrome|google-chrome-stable|chromium|chromium-browser)$ ]]; then",
      "      for _ in $(seq 1 30); do",
      "        if [ -s \"$chrome_profile_dir/DevToolsActivePort\" ]; then",
      "          head -n 1 \"$chrome_profile_dir/DevToolsActivePort\" | sed 's/^/HUMANISH_BROWSER_CDP_PORT=/'",
      "          break",
      "        fi",
      "        sleep 0.1",
      "      done",
      "    fi",
      "    return 0",
      "  fi",
      "  return 1",
      "}",
      // Fixed CDP port (not :0/random): each seat has its OWN desktop sandbox, so a known port
      // cannot conflict, and it makes the observer's port resolution deterministic. With :0 the
      // real port lives only in DevToolsActivePort; when the launch-time capture misses on a cold
      // start the observer falls back to 9222 and — being wrong — every CDP read fails for the
      // whole run (the lobby-code handoff then never sees the host's /lobby URL). 9222 is already
      // the fallback, so making it the actual port aligns launch, capture, and fallback.
      `chrome_debug_flags=(--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 ${chromiumFlags})`,
      "open_target() {",
      "  case \"$browser_preference\" in",
      "    chrome)",
      "      prepare_chrome_profile",
      "      launch_browser google-chrome google-chrome --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser google-chrome-stable google-chrome-stable --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      echo 'requested browser chrome was not found' >&2",
      "      return 127",
      "      ;;",
      "    chromium)",
      "      prepare_chrome_profile",
      "      launch_browser chromium chromium --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser chromium-browser chromium-browser --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      echo 'requested browser chromium was not found' >&2",
      "      return 127",
      "      ;;",
      "    firefox)",
      "      prepare_chrome_profile",
      "      launch_browser firefox firefox --new-instance --no-remote --new-window --profile \"$chrome_profile_dir\" && return 0",
      "      echo 'requested browser firefox was not found' >&2",
      "      return 127",
    "      ;;",
    "    default)",
    "      prepare_chrome_profile",
    "      launch_browser google-chrome google-chrome --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
    "      launch_browser google-chrome-stable google-chrome-stable --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
    "      launch_browser chromium chromium --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
    "      launch_browser chromium-browser chromium-browser --new-window \"--user-data-dir=$chrome_profile_dir\" \"${chrome_debug_flags[@]}\" && return 0",
      "      launch_browser firefox firefox --new-instance --no-remote --new-window --profile \"$chrome_profile_dir\" && return 0",
    "      launch_browser xdg-open xdg-open && return 0",
    "      echo 'no browser opener found' >&2",
    "      return 127",
    "      ;;",
      "  esac",
      "}",
      "open_target"
    ].join("\n");
    const result = await runDesktopCommandOrThrow(
      () =>
        desktop.commands.run(browserLaunchCommand, {
          requestTimeoutMs,
          timeoutMs: 15_000,
        }),
      ({ exitCode, stderrTail }) =>
        new Error(
          `browser launch failed${exitCode === undefined ? "" : ` with exit ${exitCode}`}: ${stderrTail}`,
        ),
    );
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      throw new Error(`browser launch failed with exit ${result.exitCode}: ${tailOf(result.stderr ?? result.stdout ?? "")}`);
    }
    const resolved = (result.stdout ?? "").match(/^HUMANISH_BROWSER_RESOLVED=(\S+)$/m)?.[1];
    const processId = (result.stdout ?? "").match(/^HUMANISH_BROWSER_PID=(\d+)$/m)?.[1];
    const profileDir = (result.stdout ?? "").match(/^HUMANISH_BROWSER_PROFILE_DIR=(\S+)$/m)?.[1];
    const cdpPortRaw = (result.stdout ?? "").match(/^HUMANISH_BROWSER_CDP_PORT=(\d+)$/m)?.[1];
    const cdpPort = cdpPortRaw === undefined ? undefined : Number(cdpPortRaw);
    return {
      family: desktopBrowserFamily(resolved ?? requestedBrowser),
      ...(processId === undefined || profileDir === undefined
        ? {}
        : { identity: { processId, profileDir, targetUrl, ...(cdpPort === undefined ? {} : { cdpPort }) } }),
      ...(browserPreference === undefined
        ? {}
        : { evidence: { requested: requestedBrowser, ...(resolved === undefined ? {} : { resolved }) } })
    };
  }

  if (browserPreference === undefined || browserPreference === "default") {
    if (desktop.open) {
      await desktop.open(targetUrl);
    } else {
      await desktop.launch("google-chrome", targetUrl);
    }
    return {
      family: desktop.open ? "unknown" : "chromium",
      ...(browserPreference === undefined ? {} : { evidence: { requested: requestedBrowser } })
    };
  }

  const launchTarget = requestedBrowser === "chrome" ? "google-chrome"
    : requestedBrowser === "chromium" ? "chromium"
      : requestedBrowser === "firefox" ? "firefox"
        : "google-chrome";
  await desktop.launch(launchTarget, targetUrl);
  return {
    family: desktopBrowserFamily(launchTarget),
    evidence: { requested: requestedBrowser, resolved: launchTarget }
  };
}

export function desktopBrowserFamily(value: string | undefined): DesktopBrowserFamily {
  if (value === "firefox") return "firefox";
  if (value === "chrome" || value === "chromium" || value === "google-chrome" || value === "google-chrome-stable" || value === "chromium-browser") {
    return "chromium";
  }
  return "unknown";
}

/**
 * Runtime-only CDP endpoint attribution for the exact chromium this lane launched. Port
 * resolution at OBSERVE time: the cached launch-time `cdpPort` wins; absent that, the observer
 * probe re-reads `profileDir`'s DevToolsActivePort marker (a slow cold start can publish it
 * AFTER the launch-time poll gave up); absent both it falls back to the legacy fixed 9222,
 * where a dead endpoint degrades into an honest warning that names the cause.
 */
export interface ChromeCdpEndpoint {
  cdpPort?: number;
  /** The launched profile dir; lets observers re-read DevToolsActivePort at observe time. */
  profileDir?: string;
  /** The URL this lane opened; attributes the CDP page when no target id is pinned yet. */
  targetUrl: string;
}

/**
 * The URL / title / page-text / scroll observer behind stopWhen and task criteria. One probe per
 * observation, run on the sandbox's python3 (see chrome-cdp-probe.ts for why not node: #514).
 *
 * "active": follow the participant to whatever tab they are driving now — never pin the state
 * observer to the launch tab (a verification link that opened in a NEW tab left a pinned observer
 * reading the old tab forever).
 *
 * `onUnavailable` fires ONCE, on the first probe that could not read the page, with the reason.
 * The observer still degrades to `{}` for the loop; the callback is how a lane says out loud that
 * url/text criteria are not being measured, instead of letting the funnel report 0/N (#514).
 */
export function makeChromeBrowserStateObserver(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  targetId?: string,
  onUnavailable?: (reason: string) => void,
  /**
   * Mobile emulation on later tabs (#623): the holder attaches to every page target Chrome opens
   * after the launch page, so a tab the participant opens later should lay out at the phone width
   * too. The first observation on each new target reads that page's OWN report; a target that
   * reports the requested width is recorded through `onCovered`, and one that does not (or cannot
   * be read) fires `onDrift` once, so a phone-labelled lane that spent part of its session at
   * desktop layout says so with the number the page gave.
   */
  drift?: {
    emulatedTargetId: string;
    expectedWidth: number;
    expectTouch?: boolean;
    onDrift: (reason: string) => void;
    onCovered?: (targetId: string, read: { innerWidth: number; devicePixelRatio: number; maxTouchPoints: number }) => void;
  }
): () => Promise<{ url?: string; title?: string; text?: string; scrollY?: number }> {
  let reported = false;
  let drifted = false;
  const checkedTargets = new Set<string>(drift === undefined ? [] : [drift.emulatedTargetId]);
  const unavailable = (reason: string): Record<string, never> => {
    if (!reported) {
      reported = true;
      onUnavailable?.(reason);
    }
    return {};
  };
  const checkLaterTarget = async (newTargetId: string): Promise<void> => {
    if (drift === undefined || checkedTargets.has(newTargetId)) return;
    checkedTargets.add(newTargetId);
    const read = await desktop.commands.run(
      chromeCdpProbeCommand({ ...endpoint, targetId: newTargetId, prefer: "pinned", mode: "fidelity" }),
      { requestTimeoutMs, timeoutMs: 5_000 }
    );
    const fidelity = read.exitCode !== undefined && read.exitCode !== 0 ? undefined : parseChromeCdpProbeOutput(read.stdout).fidelity;
    if (fidelity !== undefined && fidelity.innerWidth === drift.expectedWidth) {
      drift.onCovered?.(newTargetId, { innerWidth: fidelity.innerWidth, devicePixelRatio: fidelity.devicePixelRatio, maxTouchPoints: fidelity.maxTouchPoints });
      if (drift.expectTouch === true && fidelity.maxTouchPoints === 0 && !drifted) {
        // The viewport followed; touch did not (yet): the holder reloads a later tab once after its
        // first navigation commits, and this observation may have landed before that reload.
        drifted = true;
        drift.onDrift(`a later page target reports the ${fidelity.innerWidth} px viewport but navigator.maxTouchPoints 0 on its first observation; touch reaches a document only when it loads under the override`);
      }
      return;
    }
    if (drifted) return;
    drifted = true;
    drift.onDrift(
      fidelity === undefined
        ? "the participant drove a page target other than the emulated launch tab and that page's own read-back could not be taken; whether it laid out at the phone width is not known"
        : `the participant drove a page target other than the emulated launch tab and that page reports a ${fidelity.innerWidth} px viewport where ${drift.expectedWidth} px was requested (DPR ${fidelity.devicePixelRatio}); the mobile user agent and touch events are browser-wide, the viewport override was not re-applied to it`
    );
  };
  return async () => {
    const result = await desktop.commands.run(
      chromeCdpProbeCommand({ ...endpoint, ...(targetId === undefined ? {} : { targetId }), prefer: "active", mode: "state" }),
      { requestTimeoutMs, timeoutMs: 5_000 }
    );
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      return unavailable(`probe exited ${result.exitCode}: ${tailOf(result.stderr ?? result.stdout ?? "")}`);
    }
    const parsed = parseChromeCdpProbeOutput(result.stdout);
    if (parsed.unavailable !== undefined) return unavailable(parsed.unavailable);
    if (parsed.targetId !== undefined) await checkLaterTarget(parsed.targetId);
    return {
      ...(parsed.url === undefined ? {} : { url: parsed.url }),
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.text === undefined ? {} : { text: parsed.text }),
      ...(parsed.scrollY === undefined ? {} : { scrollY: parsed.scrollY })
    };
  };
}

/**
 * Read the running browser's actual outer-window bounds and CSS layout viewport through the
 * already-enabled local Chrome DevTools endpoint. The returned values come from `window.*` in
 * the target page; requested E2B resolution is deliberately not an input to this function.
 * `undefined` carries the reason the measurement is missing via `onUnavailable`, so the geometry
 * warning can name the cause (a dead CDP endpoint, no python3) instead of only the symptom.
 */
export function makeChromeDesktopGeometryObserver(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  targetId?: string,
  onUnavailable?: (reason: string) => void
): () => Promise<(Pick<RunDesktopGeometry, "browserWindow" | "viewport"> & { targetId?: string }) | undefined> {
  return async () => {
    const result = await desktop.commands.run(
      chromeCdpProbeCommand({ ...endpoint, ...(targetId === undefined ? {} : { targetId }), prefer: "pinned", mode: "geometry" }),
      { requestTimeoutMs, timeoutMs: 5_000 }
    );
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      onUnavailable?.(`probe exited ${result.exitCode}: ${tailOf(result.stderr ?? result.stdout ?? "")}`);
      return undefined;
    }
    const parsed = parseChromeCdpProbeOutput(result.stdout);
    if (parsed.unavailable !== undefined) {
      onUnavailable?.(parsed.unavailable);
      return undefined;
    }
    if (!isMeasuredRect(parsed.browserWindow) || !isMeasuredViewport(parsed.viewport)) {
      onUnavailable?.("the page reported no usable window or viewport dimensions");
      return undefined;
    }
    return {
      browserWindow: { ...parsed.browserWindow, source: "cdp" },
      viewport: { ...parsed.viewport, source: "cdp" },
      ...(parsed.targetId === undefined ? {} : { targetId: parsed.targetId })
    };
  };
}

/** The user agent a mobile-emulated lane presents unless the lab sets its own. */
export const DEFAULT_MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/**
 * Apply mobile emulation (#221) to the lane's launch page and read back what the page reports.
 * Fails CLOSED: a request that cannot be applied throws, because a desktop run labelled mobile is
 * the over-trust this feature exists to prevent. A read-back that cannot be taken is a warning
 * (the emulation was applied; only the proof is missing).
 */
export async function applyMobileEmulation(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  endpoint: ChromeCdpEndpoint,
  targetId: string | undefined,
  request: ChromeMobileEmulationRequest
): Promise<{ fidelity: NonNullable<RunDesktopGeometry["fidelity"]>; warnings: string[]; targetId?: string; holderName: string }> {
  const command = (mode: "hold" | "fidelity") =>
    chromeCdpProbeCommand({ ...endpoint, ...(targetId === undefined ? {} : { targetId }), prefer: "pinned", mode, emulation: request });
  const read = async () => {
    const result = await desktop.commands.run(command("fidelity"), { requestTimeoutMs, timeoutMs: 15_000 });
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      return { unavailable: `probe exited ${result.exitCode}: ${tailOf(result.stderr ?? result.stdout ?? "")}` };
    }
    return parseChromeCdpProbeOutput(result.stdout);
  };
  // The UA / touch / DPR overrides are bound to the DevTools session that set them and lapse the
  // moment its socket closes (measured: only the viewport width survived a one-shot apply). So the
  // applier stays attached for the lane's whole life as a detached process; the sandbox teardown
  // ends it. Its first stdout line says what was applied.
  const holderName = `mobile-emulation-${Date.now().toString(36)}`;
  await startDetachedProcess(desktop, { name: holderName, command: command("hold"), requestTimeoutMs });
  let announced: ReturnType<typeof parseChromeCdpProbeOutput> | undefined;
  for (let attempt = 0; attempt < 30 && announced === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const log = await readDetachedLog(desktop, holderName, requestTimeoutMs).catch(() => "");
    const line = log.split("\n").find((candidate) => candidate.trim().startsWith("{"));
    if (line !== undefined) announced = parseChromeCdpProbeOutput(line);
  }
  if (announced === undefined) {
    throw new Error("mobile emulation could not be applied: the in-sandbox applier printed nothing within 15 s");
  }
  if (announced.unavailable !== undefined) {
    throw new Error(
      `mobile emulation could not be applied (${announced.unavailable}); applied before failing: ${(announced.applied ?? []).join(", ") || "nothing"}`
    );
  }
  const applied = announced;
  // Viewport/touch read-back proves context settings, not gesture equivalence. Two hosted
  // replicas and a native-X conversion-toggle control reproduced reset click counts (#676).
  const warnings: string[] = request.touch
    ? ["Mobile emulation uses desktop pointer-to-touch conversion, which can differ for repeated taps. Confirm gesture failures with direct or native touch input before attributing them to the app."]
    : [];
  // The reload inside the applier takes a moment; the read-back is retried until the page reports
  // the requested viewport and user agent, so a slow page does not read as "no proof".
  let readBack = await read();
  for (
    let attempt = 0;
    attempt < 20 && (readBack.fidelity === undefined || readBack.fidelity.innerWidth !== request.width || !readBack.fidelity.userAgent.includes(request.userAgent.slice(0, 24)));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    readBack = await read();
  }
  const fidelityRead = readBack;
  const requested = {
    width: request.width,
    height: request.height,
    deviceScaleFactor: request.deviceScaleFactor,
    touch: request.touch,
    userAgent: request.userAgent
  };
  const emulatedTargetId = applied.targetId ?? fidelityRead.targetId;
  if (fidelityRead.fidelity === undefined) {
    warnings.push(`Mobile emulation was applied but the page's own report could not be read (${fidelityRead.unavailable ?? "no fidelity read"}); desktopGeometry.fidelity carries the request without a resolved block.`);
    return { fidelity: { tier: "mobile-emulated", requested, applied: applied.applied ?? [] }, warnings, holderName, ...(emulatedTargetId === undefined ? {} : { targetId: emulatedTargetId }) };
  }
  const resolved = { ...fidelityRead.fidelity, source: "cdp" as const };
  if (resolved.innerWidth !== request.width) {
    warnings.push(`Mobile emulation requested a ${request.width} px viewport; the page reports ${resolved.innerWidth} px.`);
  }
  if (resolved.devicePixelRatio !== request.deviceScaleFactor) {
    warnings.push(`Mobile emulation requested devicePixelRatio ${request.deviceScaleFactor}; the page reports ${resolved.devicePixelRatio}.`);
  }
  if (request.touch && resolved.maxTouchPoints === 0) {
    warnings.push("Mobile emulation requested touch; the page reports navigator.maxTouchPoints 0.");
  }
  if (!resolved.userAgent.includes("Mobile") && !resolved.userAgent.includes("Android") && !resolved.userAgent.includes("iPhone")) {
    warnings.push("Mobile emulation requested a mobile user agent; the page reports a desktop one.");
  }
  return { fidelity: { tier: "mobile-emulated", requested, applied: applied.applied ?? [], resolved }, warnings, holderName, ...(emulatedTargetId === undefined ? {} : { targetId: emulatedTargetId }) };
}

function isMeasuredRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Number.isFinite(record.x)
    && Number.isFinite(record.y)
    && isPositiveMeasurement(record.width)
    && isPositiveMeasurement(record.height);
}

function isMeasuredViewport(value: unknown): value is { width: number; height: number; deviceScaleFactor: number } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isPositiveMeasurement(record.width)
    && isPositiveMeasurement(record.height)
    && isPositiveMeasurement(record.deviceScaleFactor);
}

function isPositiveMeasurement(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function measureBrowserWindowWithXdotool(
  desktop: E2BDesktopSandbox,
  windowId: string,
  requestTimeoutMs: number
): Promise<RunDesktopGeometry["browserWindow"] | undefined> {
  const result = await desktop.commands.run([
    "set -euo pipefail",
    `win=${shellSingleQuote(windowId)}`,
    "xdotool getwindowgeometry --shell \"$win\" 2>/dev/null || true"
  ].join("\n"), { requestTimeoutMs, timeoutMs: 5_000 });
  const output = result.stdout ?? "";
  const read = (name: string): number | undefined => {
    const raw = output.match(new RegExp(`^${name}=(-?\\d+)$`, "m"))?.[1];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const x = read("X");
  const y = read("Y");
  const width = read("WIDTH");
  const height = read("HEIGHT");
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) {
    return undefined;
  }
  return { x, y, width, height, source: "xdotool" };
}

/** Physical X client bounds, never the page's emulated window.outerWidth/Height. */
function isBrowserWindowContained(
  bounds: NonNullable<RunDesktopGeometry["browserWindow"]>,
  [width, height]: readonly [number, number]
): boolean {
  return bounds.x >= 0 && bounds.y >= 0
    && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height;
}

/** One bounded repair. Window-manager decorations may keep the client origin below (0, 0),
 * so a full-screen client height can clip the bottom even after windowmove succeeds. */
async function fitBrowserWindowWithinDesktop(
  desktop: E2BDesktopSandbox,
  windowId: string,
  resolution: readonly [number, number],
  requestTimeoutMs: number
): Promise<RunDesktopGeometry["browserWindow"] | undefined> {
  const run = (command: string) => desktop.commands.run([
    "set -euo pipefail",
    `win=${shellSingleQuote(windowId)}`,
    command
  ].join("\n"), { requestTimeoutMs, timeoutMs: 5_000 }).catch(() => undefined);
  await run('xdotool windowmove "$win" 0 0');
  await desktop.wait(250).catch(() => undefined);
  const moved = await measureBrowserWindowWithXdotool(desktop, windowId, requestTimeoutMs).catch(() => undefined);
  // A failed move cannot be repaired by resizing a window whose origin is offscreen.
  if (moved === undefined || moved.x < 0 || moved.y < 0) return moved;
  const width = resolution[0] - moved.x;
  const height = resolution[1] - moved.y;
  if (width <= 0 || height <= 0) return moved;
  await run(`xdotool windowsize "$win" ${width} ${height}`);
  await desktop.wait(250).catch(() => undefined);
  return measureBrowserWindowWithXdotool(desktop, windowId, requestTimeoutMs).catch(() => undefined);
}

/** Shared hosted-browser geometry capture used by per-lane and sequential shared-world routes. */
export async function captureDesktopBrowserGeometry(args: {
  desktop: E2BDesktopSandbox;
  browserFamily: DesktopBrowserFamily;
  launchIdentity?: DesktopBrowserLaunchIdentity;
  browserTargetId?: string;
  browserWindowId?: string;
  laneId: string;
  /** Runtime-only lane target URL (attributes the CDP page); never persisted by this capture. */
  targetUrl: string;
  requestedScreen: readonly [number, number];
  requestTimeoutMs: number;
  resize?: boolean;
}): Promise<{
  /** Known physical clipping (or unverified repair of it); startup must stop before actions. */
  unusable?: string;
  browserWindowId?: string;
  browserTargetId?: string;
  browserWindow?: RunDesktopGeometry["browserWindow"];
  viewport?: RunDesktopGeometry["viewport"];
  warnings: string[];
}> {
  const warnings: string[] = [];
  let browserWindowId = args.browserWindowId;
  if (browserWindowId === undefined && args.browserFamily !== "unknown") {
    browserWindowId = await findVisibleBrowserWindowId(
      args.desktop,
      args.requestTimeoutMs,
      args.browserFamily,
      args.launchIdentity
    ).catch((error: unknown) => {
      warnings.push(`Browser window lookup failed for lane ${args.laneId}: ${redactText(toErrorMessage(error))}`);
      return undefined;
    });
  }

  let xdotoolWindow: RunDesktopGeometry["browserWindow"] | undefined;
  if (browserWindowId !== undefined) {
    if (args.resize !== false) {
      await fillDesktopBrowserWindow(args.desktop, browserWindowId, args.requestedScreen, args.requestTimeoutMs);
      // Let the window manager apply the resize before querying both X and page layout geometry.
      await args.desktop.wait(250).catch(() => undefined);
    }
    xdotoolWindow = await measureBrowserWindowWithXdotool(args.desktop, browserWindowId, args.requestTimeoutMs)
      .catch(() => undefined);
  } else {
    warnings.push(`Browser window bounds could not be measured for lane ${args.laneId}; the live stream will use the full desktop.`);
  }

  let unusable: string | undefined;
  if (xdotoolWindow !== undefined && !isBrowserWindowContained(xdotoolWindow, args.requestedScreen)) {
    const before = xdotoolWindow;
    if (args.resize !== false && browserWindowId !== undefined) {
      xdotoolWindow = await fitBrowserWindowWithinDesktop(args.desktop, browserWindowId, args.requestedScreen, args.requestTimeoutMs);
      if (xdotoolWindow === undefined) {
        // Keep the last measured bad state; a missing observation cannot prove a successful fix.
        xdotoolWindow = before;
        unusable = `Physical browser containment could not be verified after correction for lane ${args.laneId}; the last measured window was clipped.`;
      } else if (isBrowserWindowContained(xdotoolWindow, args.requestedScreen)) {
        warnings.push(`Browser window clipping corrected for lane ${args.laneId}; physical bounds are ${xdotoolWindow.width}x${xdotoolWindow.height} at (${xdotoolWindow.x}, ${xdotoolWindow.y}).`);
      }
    }
    if (unusable === undefined && !isBrowserWindowContained(xdotoolWindow, args.requestedScreen)) {
      unusable = `Browser window is outside the captured ${args.requestedScreen[0]}x${args.requestedScreen[1]} desktop for lane ${args.laneId}: physical bounds ${xdotoolWindow.width}x${xdotoolWindow.height} at (${xdotoolWindow.x}, ${xdotoolWindow.y}), right=${xdotoolWindow.x + xdotoolWindow.width}, bottom=${xdotoolWindow.y + xdotoolWindow.height}.`;
    }
    if (unusable !== undefined) warnings.push(unusable);
  }
  if (xdotoolWindow === undefined) {
    warnings.push(`Physical browser containment is unverified for lane ${args.laneId}; X window bounds could not be measured. Page-reported outer dimensions can be emulated and do not prove physical visibility.`);
  }

  let cdpUnavailable: string | undefined;
  const chromeGeometry = args.browserFamily === "chromium"
    ? await makeChromeDesktopGeometryObserver(
        args.desktop,
        args.requestTimeoutMs,
        {
          ...(args.launchIdentity?.cdpPort === undefined ? {} : { cdpPort: args.launchIdentity.cdpPort }),
          ...(args.launchIdentity?.profileDir === undefined ? {} : { profileDir: args.launchIdentity.profileDir }),
          targetUrl: args.targetUrl
        },
        args.browserTargetId,
        (reason) => {
          cdpUnavailable = reason;
        }
      )().catch((error: unknown) => {
        cdpUnavailable = toErrorMessage(error);
        return undefined;
      })
    : undefined;
  const browserWindow = xdotoolWindow ?? chromeGeometry?.browserWindow;
  const viewport = chromeGeometry?.viewport;
  // The fill check reads the X window when it was measured: under mobile emulation (#221) the
  // page's window.outerWidth reports the EMULATED screen (414), which is not a fill failure.
  const fillBounds = xdotoolWindow;
  if (!browserWindow) {
    warnings.push(`Browser outer bounds could not be measured for lane ${args.laneId}.`);
  } else if (unusable === undefined && fillBounds !== undefined && (fillBounds.x !== 0 || fillBounds.y !== 0 || fillBounds.width !== args.requestedScreen[0] || fillBounds.height !== args.requestedScreen[1])) {
    warnings.push(`Browser window fill did not reach the requested ${args.requestedScreen[0]}x${args.requestedScreen[1]} screen for lane ${args.laneId}; measured physical bounds are ${fillBounds.width}x${fillBounds.height} at (${fillBounds.x}, ${fillBounds.y}).`);
  }
  if (!viewport) {
    // Name the cause, not only the symptom: the same dead DevTools channel that loses the viewport
    // loses every url/text observation, and a reader of the bundle should learn that here (#514).
    const cause = cdpUnavailable === undefined ? "" : ` DevTools probe: ${redactText(cdpUnavailable)}.`;
    warnings.push(args.browserFamily === "firefox"
      ? `Browser CSS viewport measurement is unavailable for Firefox on lane ${args.laneId}; stream.viewport is omitted instead of reading a different browser's CDP endpoint.`
      : `Browser CSS viewport could not be measured for lane ${args.laneId}; stream.viewport is omitted instead of copying the requested screen resolution.${cause}`);
  }
  return {
    ...(unusable === undefined ? {} : { unusable }),
    ...(browserWindowId === undefined ? {} : { browserWindowId }),
    ...(chromeGeometry?.targetId === undefined ? {} : { browserTargetId: chromeGeometry.targetId }),
    ...(browserWindow === undefined ? {} : { browserWindow }),
    ...(viewport === undefined ? {} : { viewport }),
    warnings
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Put a CLI on the desktop before the participant arrives (#495).
 *
 * The install runs UNKEYED and before the session starts, for the same reason the clone route
 * provisions its subject first: what is being studied begins when the participant looks at the
 * screen, and making them fight an install first would be a study of the install.
 */
async function provisionDesktopCli(
  desktop: E2BDesktopSandbox,
  args: {
    product: string;
    install?: string;
    requestTimeoutMs: number;
    scrub: (value: string) => string;
    onPhase?: (event: SubjectPhaseEvent) => void;
  }
): Promise<void> {
  const install = args.install;
  if (install === undefined) return;
  const now = (): number => Date.now();
  if (needsNodeRuntime([install])) {
    const startedAt = now();
    emitPhaseStarted(args.onPhase, now, "runtime", "providing the Node runtime the install needs");
    const bootstrap = await runDetachedStep(desktop, {
      name: "desktop-cli-runtime-node",
      command: nodeBootstrapCommand(),
      cwd: "/home/user",
      timeoutMs: INSTALL_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs
    });
    emitPhaseCompleted(args.onPhase, now, startedAt, "runtime", bootstrap.ok, bootstrap.ok
      ? "Node runtime ready"
      : "Node runtime bootstrap failed");
    if (!bootstrap.ok) {
      throw new Error(`desktop-cli runtime bootstrap failed for "${args.product}"`);
    }
  }
  const startedAt = now();
  emitPhaseStarted(args.onPhase, now, "install", `installing ${args.product} on the desktop`);
  const result = await runDetachedStep(desktop, {
    name: "desktop-cli-install",
    command: install,
    cwd: "/home/user",
    timeoutMs: INSTALL_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs
  });
  emitPhaseCompleted(args.onPhase, now, startedAt, "install", result.ok, result.ok
    ? `${args.product} installed`
    : `installing ${args.product} failed`);
  if (!result.ok) {
    // Fail closed: a participant handed a desktop where the product is not installed would produce
    // a transcript about a missing command, and that finding belongs to the harness, not the tool.
    // The tail rides along, scrubbed before truncation like every other provisioning failure — a
    // bare "install failed" is unactionable to whoever wrote the command.
    throw new Error(args.scrub(
      `desktop-cli install failed for "${args.product}" (${result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`}): ${tailOf(args.scrub(result.logTail))}`
    ));
  }
}

/**
 * Open a terminal window on the desktop.
 *
 * The stock template is XFCE and ships xfce4-terminal (also aliased x-terminal-emulator), verified
 * live before this route was built. `x-terminal-emulator` is tried first so a template that swaps
 * the emulator still works; a desktop with neither is a template problem and fails closed rather
 * than handing a participant an empty screen and calling it a study.
 */
async function openDesktopTerminal(
  desktop: E2BDesktopSandbox,
  requestTimeoutMs: number,
  workdir: string | undefined
): Promise<void> {
  const dir = workdir ?? "/home/user";
  const result = await runDetachedStep(desktop, {
    name: "desktop-cli-terminal",
    command: [
      "for candidate in x-terminal-emulator xfce4-terminal gnome-terminal konsole xterm; do",
      '  if command -v "$candidate" >/dev/null 2>&1; then',
      // LANG is set on the terminal we open, not globally: the stock image declares no locale, and
      // a study that measures our own mojibake against an unconfigured template would be measuring
      // the template. The PRODUCT-side fix (an ASCII fallback when the locale is not UTF-8) is in
      // src/terminal-encoding.ts, and it is the one that matters for real users.
      `    (cd ${shellSingleQuote(dir)} 2>/dev/null || cd /home/user; DISPLAY=:0 LANG=C.UTF-8 LC_ALL=C.UTF-8 HUMANISH_STUDY_PARTICIPANT=1 nohup "$candidate" >/dev/null 2>&1 &)`,
      "    sleep 3",
      '    echo "humanish: opened $candidate"',
      "    exit 0",
      "  fi",
      "done",
      "echo 'humanish: no terminal emulator on this desktop template' >&2",
      "exit 1"
    ].join("\n"),
    cwd: "/home/user",
    timeoutMs: 60_000,
    requestTimeoutMs
  });
  if (!result.ok) {
    throw new Error("desktop-cli lane could not open a terminal on this desktop template");
  }
}

async function startDesktopStream(
  desktop: E2BDesktopSandbox,
  browserWindowId: string | undefined
): Promise<void> {
  if (!browserWindowId) {
    await desktop.stream.start({ requireAuth: true });
    return;
  }

  try {
    await desktop.stream.start({ requireAuth: true, windowId: browserWindowId });
  } catch {
    await desktop.stream.start({ requireAuth: true });
  }
}

// "can't" followed by a PERCEPTION verb describes what the screen showed, not an inability to
// proceed: "the canvas truncates it so you can't even read the whole thing", "I can't tell from
// the screen whether the rename is persisted", "so I could not read its full description". Five
// of five completed live runs on 2026-09-01 (two on drawDB, three on the planted benchmark app)
// were refused as "not a credible pass" on exactly these sentences, every one a defect report
// written AFTER the participant reached the goal. The more precisely a participant describes a
// display defect, the more likely the scan was to refuse the run — the incentive inversion #453
// fixed for resolved arcs, back in a new shape. "could not complete", "could not connect",
// "unable to get focus" still count: those name an inability to act.
const PERCEPTION_AFTER_MODAL =
  /\b(can'?t|cannot|could ?not|couldn'?t|unable to|wasn'?t able to)\s+(even\s+|quite\s+|really\s+|fully\s+)?(read|see|tell|view|make out|verify|confirm|be sure|be certain|judge|know)\b/g;

function hasBlockerLanguage(text: string): boolean {
  return /\b(can'?t|cannot|could not|unable|blocked|blocker|failed|invalid|not set)\b/.test(text)
    || /\b(shows|showing|hit|encountered|returned|got)\b.{0,80}\berror\b/.test(text)
    || /\berror[:.]/.test(text)
    || /what would you like me to do|please tell me|need (the )?(task|credentials|instructions)/.test(text);
}

/** The friction scan (inclusive): does the narrative report ANY blocker-shaped language,
 *  resolved or not? Feeds the participants `reportedFriction` tally and feedback candidates. */
// Report-shaped language: what a participant writes when it finished AND has something to say.
// Every one of the day's eleven drawDB reports (2026-09-01) opened a section "What confused me"
// or "Accessibility defects:"; none contained a blocker word, so none became a feedback candidate
// and a lane that had just replicated a keyboard-accessibility defect three times drafted "Live
// study completed without a participant-reported finding". Friction is the INCLUSIVE scan; a
// false positive here adds a candidate a person then reads, which is the cheap direction.
const REPORTED_DEFECT_LANGUAGE =
  /\b(defects?|bugs?|accessibilit(y|ies)|inaccessible|not (keyboard|screen.?reader)[- ]?accessible|confus(ed|ing)|hesitat(ed|ion)|unexpected(ly)?|unclear|hard to (find|tell|see|read|reach)|no (visible )?focus|overlap(ped|ping|s)?|truncat(ed|es|ion)|cut off|did nothing|nothing happened|no effect)\b/;

// The friction scan's own negations (#614). "Nothing was confusing", "no defects", "not unclear"
// are what a participant writes when it has NOTHING to report, and until 2026-09-03 each of them
// counted as reported friction and became a feedback candidate whose "actual" was a sentence
// reporting no problem. Only the report-shaped adjectives are negatable here: "no visible focus",
// "not keyboard-accessible" and "did nothing" are defects and stay.
const NEGATED_REPORT_ITEM = String.raw`(?:confus(?:ed|ing|ion)|unclear(?:\s+error\s+output)?|unexpected(?:ly)?|hesitat(?:ed|ion|ions)|surpris(?:ed|ing|es)|defects?|bugs?|overlap(?:ped|ping|s)?|truncat(?:ed|es|ion)|hard to (?:find|tell|see|read|reach)|blockers?|blocking issues?|errors?(?:\s+output)?|failures?|problems?|issues?)`;
const NEGATED_REPORT_QUALIFIERS = String.raw`(?:(?:really|particularly|especially|major|minor|real|actual|remaining|functional|obvious|noticeable|significant|any|a|an)\s+)*`;
const NEGATED_REPORT_MODIFIERS = String.raw`(?:(?:was|were|felt|seemed|really|particularly|especially|major|minor|real|actual|remaining|functional|obvious|noticeable|significant|any|a|an|encounter(?:ed)?|experience(?:d)?|notice(?:d)?|observe(?:d)?|feel|find|found|have|had)\s+)*`;
const NEGATED_REPORT_LANGUAGE = new RegExp(
  String.raw`\b(?:nothing|no|not|never|without|none|(?:did|do|does|was|were|has|have|had)n['’]t)\s+${NEGATED_REPORT_MODIFIERS}${NEGATED_REPORT_ITEM}\b`
    // Negation scopes over a coordinated report list, not the rest of the sentence. In
    // particular, leave "but the label was confusing" and "and Save did nothing" intact.
    + String.raw`(?:\s*,?\s+(?:or|nor|and)\s+${NEGATED_REPORT_QUALIFIERS}${NEGATED_REPORT_ITEM}\b)*`
    // Keep the predicate inside its negation: "No errors blocked me" reports no blocker.
    + String.raw`(?:\s+(?:blocked|stopped|prevented)\s+(?:me|us|it)\b)?`,
  "g"
);

function stripNegatedReportLanguage(text: string): string {
  // "Not without hesitation" reports hesitation; do not let the inner "without" erase it.
  return text.replace(/\b(?:not|never)\s+without\b/g, "with").replace(NEGATED_REPORT_LANGUAGE, " ");
}

function completionReasonContradictsGoal(reason: string): boolean {
  // Preserve the full negated list before the older blocker-specific rules remove its first
  // noun ("no issues or hesitation"). Matching reports first also avoids their broad encounter
  // clause rule swallowing a genuine subsequent observation.
  const text = stripQuotedSpans(stripNegatedNonBlockerPhrases(stripNegatedReportLanguage(stripCodeExamples(reason).toLowerCase())));
  return hasBlockerLanguage(text) || REPORTED_DEFECT_LANGUAGE.test(text);
}

/** Code/documentation excerpts are quoted material, not participant observations. */
function stripCodeExamples(text: string): string {
  return text
    // Include an unterminated fence: copied text is not promoted just because its closing fence
    // was omitted. Match the same marker so backticks inside a tilde fence cannot end it early.
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, " ")
    .replace(/(`+)[^`\n]*\1/g, " ");
}

/** Interim messages also contain plans and hypotheses. Admit observed-report clauses only;
 * the established closing-report scan remains separate. This is a conservative text heuristic,
 * not an assertion that every mention of a defect is evidence that one happened. */
function interimMessageReportsFriction(message: string): boolean {
  const prose = stripQuotedSpans(stripCodeExamples(message).toLowerCase());
  const clauses = prose.split(/(?<=[.!?])\s+|[;\n]+|,\s*(?:but|so|however|yet)\s+|\s+so\s+(?=i\b|we\b)/);
  return clauses.some((clause) => {
    // A condition, question, intention, or conjecture does not assert an observed result.
    // Clause splitting above keeps "Save did nothing, so I will try Enter" observable.
    if (/\?|\b(?:if|unless|whether|maybe|perhaps|suppose|hypothetically|might|may|would|should)\b|\bcould\b(?!\s+not\b)/.test(clause)
      || /\b(?:i|we)(?:['’]ll|\s+(?:will|plan|intend|want|hope|suspect|wonder))\b|\bgoing to\b|\blet['’]s\b/.test(clause)
      || /\b(?:task|goal|mission|objective|plan)\s+(?:(?:is|was)\s+)?to\b|^\s*(?:check|test|look|checking|testing)\b/.test(clause)) return false;

    // A topic is not a defect ("the accessibility guide is open", "shows error-handling docs").
    // Actual friction in those surfaces still qualifies: "the error guide was confusing".
    const observation = clause
      .replace(/\baccessibilit(?:y|ies)\b/g, " ")
      .replace(/\berror[- ]handling\b|\berror\s+(?:documentation|docs?|guides?|reference|examples?)\b/g, " ");
    const assertsObservation = /\b(?:is|are|was|were|has|had|did|does|shows?|showed|seems?|seemed|looks?|looked|found|noticed|saw|hit|encountered|felt|got|failed|returned|cannot|can['’]?t|unable|could not)\b|\b(?:overlap(?:ped|ping|s)?|truncat(?:ed|es)|cut off|nothing happened|no (?:visible )?focus)\b/.test(observation);
    return assertsObservation && completionReasonContradictsGoal(observation);
  });
}

/** The verdict scan (strict): like the friction scan, but resolved-arc segments are stripped
 *  first — failure narration the participant itself reports as overcome is friction on the
 *  road, not a blocker at the destination (#453). */
function completionReasonBlocksVerdict(reason: string): boolean {
  // Perception phrases are stripped for the VERDICT only: "I could not read the full description"
  // is friction worth a tally count and a feedback candidate (the friction scan above keeps it),
  // and it is not a reason to refuse the pass.
  return hasBlockerLanguage(
    stripResolvedArcSegments(stripQuotedSpans(stripNegatedNonBlockerPhrases(reason.toLowerCase())))
      .replace(PERCEPTION_AFTER_MODAL, "")
  );
}

// A failure segment counts as a resolved arc when the recovery is self-reported either in the
// SAME segment ("the import failed but then went through") or — the common report shape — in the
// immediately FOLLOWING segment as a retry/alternative that succeeded ("my first import failed
// with a parser error. A simpler SQL import succeeded."). The lookahead demands the retry flavor
// on purpose: unrelated praise ("Separately, the search box worked") must never launder an
// unresolved failure. "Login failed so I gave up" has no recovery anywhere and stays a blocker.
// (#453 — the run-1 false negative: a defect report after demonstrated success failed the lane,
// an incentive inversion against exactly the participant behavior a study wants most.)
const RESOLUTION_TERMS =
  /\b(succeed(?:ed|s)?|success(?:ful|fully)?|worked|works around|then worked|now works?|resolved|fixed|recovered|got it working|went through)\b/;
const RETRY_RESOLUTION =
  /\b(simpler|simplified|retry(?:ing)?|retried|second (?:attempt|try)|another (?:attempt|try|approach)|different (?:approach|way|route)|instead|then|eventually|after that)\b[^.!?\n]{0,80}\b(succeed(?:ed|s)?|success(?:ful|fully)?|worked|went through|completed|passed)\b/;

/** Drop sentence/bullet segments whose failure language is part of a self-reported RESOLVED arc. */
function stripResolvedArcSegments(text: string): string {
  const segments = text.split(/(?<=[.!?])\s+|\n+/);
  return segments
    .filter((segment, index) => {
      if (!hasBlockerLanguage(segment)) return true;
      if (RESOLUTION_TERMS.test(segment)) return false;
      const next = segments[index + 1];
      return !(next !== undefined && RETRY_RESOLUTION.test(next));
    })
    .join(" ");
}

// Negations that DESCRIBE a defect rather than deny one. Kept out of every clause drop below.
const DEFECT_SHAPED_NEGATION =
  /\bno\s+(?:visible\s+)?focus\b|\bno\s+(?:keyboard|screen.?reader)[- ]?(?:access|path|route|way|alternative|equivalent)|\bnot\s+(?:keyboard|screen.?reader)[- ]?accessible\b|\bno\s+(?:effect|feedback|response)\b|\b(?:did|does)\s+nothing\b|\bnothing\s+happened\b/;

function stripNegatedNonBlockerPhrases(text: string): string {
  return text
    // FIRST, before the narrower rules eat the "no blockers" and leave "encountered ... error"
    // behind: "I encountered no blockers or unclear error output." refused a clean passing run on
    // 2026-09-01. A verb of encounter followed by "no" negates the whole clause, so drop the clause.
    // ... unless the clause names a DEFECT: "the delete control had no visible focus" is a
    // finding, and the verb it happens to use must not decide whether it counts (#622).
    .replace(/\b(?:encountered|hit|saw|found|met|had|got|ran into)\s+no\s+[^.!?\n]*/g, (clause) =>
      DEFECT_SHAPED_NEGATION.test(clause) ? clause : " ")
    .replace(/\bno\s+(?:real\s+|remaining\s+|actual\s+)?(?:blocker|blockers|blocking issue|blocking issues|error|errors|failure|failures)\s+(?:was\s+|were\s+)?(?:encountered|observed|found|hit|seen|reported|detected)\b/g, "")
    .replace(/\bwithout\s+(?:a\s+|any\s+)?(?:real\s+|remaining\s+|actual\s+)?(?:blocker|blockers|blocking issue|blocking issues|error|errors|failure|failures)\b/g, "")
    .replace(/\bnot\s+(?:blocked|a blocker|an error|failed)\b/g, "")
    // "No functional failures blocked me" downgraded a clean passing run to a lab failure on
    // 2026-09-01. The adjective list above is closed (real|remaining|actual), so an ordinary
    // qualifier like "functional" slipped through and the trailing verb "blocked" tripped the
    // scan. Allow up to two intervening words, and cover the verb form directly.
    .replace(
      /\bno\s+(?:\w+\s+){0,2}(?:blocker|blockers|blocking issues?|errors?|failures?|problems?|issues?)\b(?:\s+(?:blocked|stopped|prevented)\s+(?:me|us|it))?/g,
      " "
    )
    .replace(/\bnothing\s+(?:\w+\s+){0,2}(?:blocked|stopped|prevented)\s+(?:me|us|it)\b/g, " ");
}

/**
 * Remove double-quoted spans and markdown blockquote lines before the blocker scan, so a persona
 * that faithfully QUOTES the subject app's own copy (e.g. a banner reading "cannot be undone") is
 * not misread as the actor reporting its OWN blocker. Only double quotes (straight and smart) and
 * `>` blockquotes are stripped — never single quotes, which would mangle contractions like `can't`.
 */
function stripQuotedSpans(text: string): string {
  return text
    .replace(/"[^"]*"/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/^\s*>.*$/gm, " ");
}

function traceHasStopWhenMatch(session: CuaLoopResult): boolean {
  return session.trace.items.some((item) =>
    item.kind === "notice"
      && item.status === "matched"
      // A dwell window that ended the session (then: stop) is the same class of harness-owned,
      // structured completion as a matched stopWhen (#510).
      && (item.title.startsWith("stopWhen matched") || item.title === "dwell window complete"));
}

/**
 * A goal_satisfied lane counts as a self-reported blocker ONLY when its final narrative contradicts
 * the goal AND the run's own stop predicate did NOT fire. A matched stopWhen is independent,
 * structured completion evidence, so it overrides a text scan of the free-form narrative — which can
 * otherwise trip on the subject app's OWN quoted copy (e.g. a relayed "cannot be undone" banner).
 * Resolved-arc segments never block the verdict (#453). Returns the offending reason, or undefined
 * when the lane is a clean pass. Exported for testing.
 */
export function resolveSelfReportedBlocker(session: CuaLoopResult | undefined): string | undefined {
  // The participant's own word wins when it gave one (#570): a declared "reached" is not re-read
  // for blocker-shaped phrases, and a declared "blocked" is a blocker whatever the paragraph says.
  const declared = session?.trace.declaredOutcome;
  if (session !== undefined && declared !== undefined) {
    return declared === "blocked" && session.completionReason === "goal_satisfied" ? session.reason : undefined;
  }
  return session?.completionReason === "goal_satisfied"
    && completionReasonBlocksVerdict(session.reason)
    && !traceHasStopWhenMatch(session)
    ? session.reason
    : undefined;
}

/**
 * Friction is independent of how a completed session ended (#657). Read the participant's
 * redacted messages, including earlier reports, rather than the harness-owned reason that
 * stopWhen/dwell writes. Reasoning, observations, and notices are not participant reports.
 * Resolved arcs still count (#453); quoted copy and negated reports still do not. This read
 * never changes the verdict. Exported for testing.
 */
export function resolveSelfReportedFriction(session: CuaLoopResult | undefined): string | undefined {
  if (session?.completionReason !== "goal_satisfied") return undefined;
  // Friction stays a read of the narrative even when the outcome was declared: a participant who
  // reached the goal and described what was hard on the way has reported friction.
  if (session.trace.declaredOutcome === "blocked") return session.reason;
  const messages = session.trace.items
    .filter((item) => item.kind === "message" && item.id !== session.trace.debrief?.messageId)
    .map((item) => item.text?.trim() ?? "")
    .filter((text) => text.length > 0);
  // A custom session may keep its closing report only in reason even when earlier messages exist.
  // Structured stop/dwell reasons are controller text and never enter this closing-report path.
  const closingReport = traceHasStopWhenMatch(session) ? undefined : session.reason.trim();
  // One candidate per participant, with exact repeats removed (the closing report often repeats
  // a prior turn). Earlier turns require observed-report clauses, not arbitrary defect mentions.
  const typedReports = session.trace.debrief?.status === "completed"
    ? session.trace.debrief.report?.frictionReports ?? [] : [];
  const reports = [...new Set([...typedReports, ...messages.filter((message) => message === closingReport
    ? completionReasonContradictsGoal(message)
    : interimMessageReportsFriction(message))])];
  if (closingReport && completionReasonContradictsGoal(closingReport) && !reports.includes(closingReport)) {
    reports.push(closingReport);
  }
  if (reports.length > 0) return reports.join("\n\n");
  return undefined;
}

/**
 * Run ONE E2B desktop lane end-to-end: create the sandbox (per-lane metadata + the lane's device
 * resolution), prepareDesktop, verify geometry, (clone+serve+seed the subject per lane), open the
 * browser, run the session, and ALWAYS tear down THIS lane's sandbox BY ID in a finally. Never
 * enumerates sandboxes. Extracted from the former single-lane block; at N=1 it writes the exact
 * same artifacts (actor.json, screenshots/<name>) the bundle has always referenced.
 */
export async function runCuaLane(spec: CuaLaneSpec, deps: CuaLaneDeps): Promise<LaneRunOutcome> {
  const { config, appUrl, cloneRoute, localTreeRoute, serve, subjectRepo, subjectEnvNames } = deps;
  const desktopCliRoute = deps.desktopCliRoute === true;
  // The local brain, when there is one. `appServer` / `claudeSession` own a process, so the lane
  // closes it.
  let appServer: Awaited<ReturnType<typeof startAppServerSession>> | undefined;
  let claudeSession: Awaited<ReturnType<typeof startClaudeSession>> | undefined;
  let localAgentProvider: CuaProvider | undefined;
  const subjectEnvValues = config.subject.envValues ?? {};
  const targetUrl = spec.targetUrl ?? appUrl;
  const env = deps.env;
  // Off-app comms (#297): on an in-sandbox subject route, redirect the app's email-API sends into an
  // in-sandbox catch (loopback) so its verification mail is CAPTURED, not sent to the internet. Gated
  // ENTIRELY on config.comms — no comms declared → zero change. The base-URL env is injected at
  // sandbox-create (below, so the app reads it at boot); the catch is started right after create.
  const commsEmail = (cloneRoute || localTreeRoute) ? config.comms?.email : undefined;
  const commsPort = commsEmail ? (commsEmail.port ?? DEFAULT_SANDBOX_CATCH_PORT) : undefined;
  // Hoisted so the finally can drain the catch before teardown; `commsArtifactPath` is the written
  // evidence path folded into the lane outcome.
  let deployedComms: DeployedCommsCatch | undefined;
  let commsArtifactPath: string | undefined;
  // injectEnv is absent on an adopter-hosted plane (#328): there is no subject env to inject
  // because the operator points their own app at their own catch.
  const commsEnv: Record<string, string> = commsEmail?.injectEnv !== undefined && commsPort !== undefined
    ? { [commsEmail.injectEnv]: `http://127.0.0.1:${commsPort}` }
    : {};
  // SMTP transport: the same idea as injectEnv, but an app that speaks SMTP needs a host and a port
  // rather than a base URL. The catch accepts any credentials (loopback only), yet many apps refuse
  // to boot unless the user/password vars exist at all, so those are injected when declared.
  const commsSmtpPort = commsEmail?.smtp?.port;
  if (commsEmail?.smtp && commsSmtpPort !== undefined) {
    commsEnv[commsEmail.smtp.hostEnv] = "127.0.0.1";
    commsEnv[commsEmail.smtp.portEnv] = String(commsSmtpPort);
    if (commsEmail.smtp.userEnv) commsEnv[commsEmail.smtp.userEnv] = commsEmail.smtp.user ?? "humanish";
    if (commsEmail.smtp.passwordEnv) commsEnv[commsEmail.smtp.passwordEnv] = commsEmail.smtp.password ?? "humanish";
  }
  // Persona inbox SURFACE (#297 slice B): the loopback URL the persona opens to read captured mail; the
  // origin-rewrite map (identity on this same-sandbox route, but covers localhost/0.0.0.0 alias skew + an
  // operator-declared linkOrigin); and a disposable background loop that renders the surface DURING the
  // session so the inbox is live when the persona checks. The surface uses its OWN FakeInbox + cursor,
  // independent of the teardown evidence drain (two readers of the append-only NDJSON — no double-count).
  const commsInboxUrl = commsEmail && commsPort !== undefined ? `http://127.0.0.1:${commsPort}/inbox` : undefined;
  const commsOriginMap = commsEmail
    ? buildOriginMap({
        ...(config.subject.serve?.url === undefined ? {} : { internalServeUrl: config.subject.serve.url }),
        reachableBaseUrl: targetUrl,
        ...(commsEmail.linkOrigin === undefined ? {} : { linkOrigin: commsEmail.linkOrigin })
      })
    : [];
  const surfaceRecipients = (commsEmail?.recipients ?? [])
    .filter((recipient): recipient is { lane: string; address: string } => recipient.address !== undefined)
    .map((recipient) => ({ lane: recipient.lane, address: recipient.address }));
  let surfaceRenderedCount = 0;
  let surfaceDisposed = false;
  let releaseSurface: () => void = () => {};
  const surfaceDispose = new Promise<void>((resolve) => { releaseSurface = resolve; });
  let surfaceLoop: Promise<void> | undefined;
  const warnings: string[] = [];
  const screenshots: string[] = [];
  const writeScreenshot = makeLaneWriteScreenshot(deps.artifactRoot, spec, screenshots);
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  // Completed-only trail (durationMs/ok are set on completed events, never on started ones):
  // this is what survives into bundle.events. The default/injected sink below sees EVERY event,
  // started and completed alike, so an operator watching stderr sees both halves of each phase.
  const phaseRecords: SubjectPhaseEvent[] = [];
  const onSubjectPhase = (event: SubjectPhaseEvent): void => {
    if (event.ok !== undefined) {
      phaseRecords.push(event);
    }
    (deps.hooks.onPhase ?? defaultSubjectPhaseSink)(event, { laneId: spec.laneId, laneCount: deps.laneCount });
  };
  let session: CuaLoopResult | undefined;
  let sessionError: string | undefined;
  let failureCode: CuaActorLabErrorCode | undefined;
  let sandboxId: string | undefined;
  // Host-side E2B desktop billed-span endpoints, measured via the injected clock. Captured right
  // after create() succeeds and again in the finally after teardown resolves (both the killed and
  // kept-for-debug paths). This measured span excludes allocation before the acquired handle;
  // a kept/unconfirmed allocation gets an extra unknown lifetime cost line.
  let sandboxCreatedAtMs: number | undefined;
  let sandboxTornDownAtMs: number | undefined;
  let desktopResources: DesktopResourceObservation | undefined;
  let killed = false;
  let streamUrl: string | undefined;
  let subjectCommit: string | undefined;
  let desktopBrowser: DesktopBrowserEvidence | undefined;
  let launchedBrowserFamily: DesktopBrowserFamily = "unknown";
  let browserLaunchIdentity: DesktopBrowserLaunchIdentity | undefined;
  let browserLaunched = false;
  let initialBrowserGeometry: Awaited<ReturnType<typeof captureDesktopBrowserGeometry>> | undefined;
  let appliedFidelity: RunDesktopGeometry["fidelity"] | undefined;
  let emulatedTargetId: string | undefined;
  let emulationHolderName: string | undefined;
  let browserWindowId: string | undefined;
  let browserTargetId: string | undefined;
  const declaredScreen = declaredScreenForRender(spec.devicePreset, spec.deviceName, spec.resolution);
  let desktopGeometry: RunDesktopGeometry = {
    screen: {
      requested: { width: spec.resolution[0], height: spec.resolution[1] },
      ...(declaredScreen ? { declared: declaredScreen } : {})
    }
  };
  let provisioned = false;
  let signaled = false;
  const signal = (ok: boolean): void => {
    if (!signaled && deps.signalProvisioned) {
      signaled = true;
      deps.signalProvisioned(ok);
    }
  };

  let desktopModule: E2BDesktopModule | undefined;
  let desktop: E2BDesktopSandbox | undefined;
  try {
    desktopModule = await (deps.hooks.loadDesktopModule ?? loadE2BDesktopModule)();
    // Optional custom desktop template (image): present → Sandbox.create(template, opts); absent →
    // the byte-stable Sandbox.create(opts) default (stock `desktop` template).
    desktop = await createDesktopSandbox(desktopModule, {
      apiKey: deps.e2bApiKey,
      requestTimeoutMs: deps.requestTimeoutMs,
      timeoutMs: deps.perLaneSandboxMs,
      metadata: {
        ...CUA_ACTOR_LAB_PROVIDER_METADATA,
        labId: config.id,
        simId: spec.simId,
        laneId: spec.laneId,
        laneIndex: String(spec.laneIndex),
        laneCount: String(deps.laneCount)
      },
      // Env placement per the doctrine: the ACTOR's key never enters the sandbox (the model drives
      // from outside). The SUBJECT's declared env NAMES are provisioned here on the clone route.
      // Three sources, in precedence order: committed non-secret config (subject.envValues), then
      // secret values forwarded from the caller's environment (subject.env), then the harness's own
      // comms wiring, which must win because only it knows the catch's address.
      ...(subjectEnvNames.length > 0 || Object.keys(subjectEnvValues).length > 0 || Object.keys(commsEnv).length > 0
        ? {
            envs: {
              ...subjectEnvValues,
              ...Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])),
              ...commsEnv
            }
          }
        : {}),
      resolution: spec.resolution,
      dpi: 96,
      lifecycle: { onTimeout: "kill" }
    }, config.execution?.desktop?.template, {
      // The default loader reclaims an acquired handle before retrying failed desktop startup.
      // Its error names the cleanup outcome; pre-construction allocation failures remain unowned.
      onRetry: (reason) => {
        const named = redactText(deps.scrubKnownValues(reason));
        warnings.push(
          `Sandbox create for lane ${spec.laneId} retried once after a transient provider error (${named}).`
        );
        onSubjectPhase({ at: new Date(deps.now()).toISOString(), type: "cua-lab.sandbox.create.retry", message: `sandbox create retried once (${named})` });
      }
    });
    sandboxId = desktop.sandboxId;
    // #358 salvage: journal the id to disk before any work — an interrupted run reclaims by
    // exact recorded id (`humanish reclaim`), never by enumerating the account.
    await appendSandboxReceipt(deps.artifactRoot, { at: new Date(deps.now()).toISOString(), laneId: spec.laneId, sandboxId, timeoutMs: deps.perLaneSandboxMs });
    // The billed span starts the instant the sandbox exists.
    sandboxCreatedAtMs = deps.now();
    desktopResources = await observeDesktopResources(desktop);
    if ("reason" in desktopResources) {
      warnings.push(`Desktop resource size unavailable (${desktopResources.reason}); compute cost remains unpriced.`);
    }

    if (deps.hooks.prepareDesktop) {
      await deps.hooks.prepareDesktop(desktop, { laneId: spec.laneId, laneIndex: spec.laneIndex, laneCount: deps.laneCount });
    }

    // Start the in-sandbox email catch BEFORE the subject serve, so the app's send-API base URL (injected
    // into its env at create) resolves the moment it boots. A comms-declared lab that can't stand the
    // catch up is a setup failure (fail closed) rather than silently sending real mail.
    if (commsEmail && commsPort !== undefined) {
      deployedComms = await deployCommsCatch(desktop, {
        port: commsPort,
        ...(commsSmtpPort === undefined ? {} : { smtpPort: commsSmtpPort }),
        requestTimeoutMs: deps.requestTimeoutMs
      });
      if (!deployedComms.ready) {
        throw new Error(`comms email catch did not become ready on 127.0.0.1:${commsPort} in the subject sandbox`);
      }
      // Write the EMPTY inbox once up front so the persona's /inbox always resolves to the "No messages
      // yet." page — never a bare 404 — the instant it navigates there, even before any mail arrives OR if
      // the app sends to an address no declared recipient matches (the loop only re-renders on new mail).
      await writeInboxSurface(desktop, deployedComms.surfaceDir, [], { originMap: commsOriginMap, requestTimeoutMs: deps.requestTimeoutMs });
      const deployedRef = deployedComms;
      surfaceLoop = (async () => {
        // Render-first (so even a short session gets a populated inbox), then refresh on a cadence. The
        // cadence uses a REAL timer, NOT the injected instant clock: this loop is unbounded, so an instant
        // sleep would busy-spin and starve the session's own timers. The wait is interruptible by
        // surfaceDispose (and the timer cleared) so teardown never blocks for a full cadence. Each refresh
        // is a full, idempotent rebuild; `surfaceRenderedCount` only advances on a SUCCESSFUL render so a
        // transient failure retries cleanly (no duplicate emails).
        for (;;) {
          try {
            const refreshed = await refreshInboxSurface({
              desktop,
              deployed: deployedRef,
              recipients: surfaceRecipients,
              sinceCount: surfaceRenderedCount,
              originMap: commsOriginMap,
              requestTimeoutMs: deps.requestTimeoutMs
            });
            if (refreshed.rendered) surfaceRenderedCount = refreshed.count;
          } catch {
            // Never throw into the render loop; the teardown drain + by-id teardown must still run.
          }
          if (surfaceDisposed) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, INBOX_SURFACE_CADENCE_MS);
            void surfaceDispose.then(() => { clearTimeout(timer); resolve(); });
          });
          if (surfaceDisposed) break;
        }
      })();
    }

    // Per-lane geometry assertion (fail-closed) — the device claim is verified in-sandbox.
    const screenGeometry = await inspectDesktopScreenGeometry({
      desktop,
      laneId: spec.laneId,
      requestedScreen: spec.resolution,
      requestTimeoutMs: deps.requestTimeoutMs
    });
    if (screenGeometry.verified) {
      desktopGeometry = {
        ...desktopGeometry,
        screen: { ...desktopGeometry.screen, verified: screenGeometry.verified }
      };
    }
    if (screenGeometry.warning) {
      warnings.push(screenGeometry.warning);
      desktopGeometry = { ...desktopGeometry, warnings: [screenGeometry.warning] };
    }
    if (screenGeometry.error && deps.screenMismatchPolicy !== "record-evidence") {
      sessionError = screenGeometry.error;
      failureCode = "HUMANISH_CUA_LAB_DEVICE_GEOMETRY";
    } else {
      if (screenGeometry.error && screenGeometry.verified) {
        // record-evidence policy: the bundle keeps requested vs verified as separate facts and
        // discloses the divergence instead of failing this lane's world mid-flight.
        const mismatchWarning = deps.scrubKnownValues(
          `Lane ${spec.laneId} requested a ${spec.resolution[0]}x${spec.resolution[1]} screen but xdpyinfo reports ${screenGeometry.verified.width}x${screenGeometry.verified.height}; recording requested vs verified separately instead of failing the lane closed.`
        );
        warnings.push(mismatchWarning);
        desktopGeometry = {
          ...desktopGeometry,
          warnings: [...(desktopGeometry.warnings ?? []), mismatchWarning]
        };
      }
      if (desktopCliRoute) {
        // Put the product on the desktop before the participant sees it. UNKEYED, like every other
        // provisioning step: the participant's world is prepared by the harness, and what is being
        // studied starts at the moment they look at the screen.
        await provisionDesktopCli(desktop, {
          product: config.subject.product?.name ?? "",
          ...(config.subject.product?.install === undefined ? {} : { install: config.subject.product.install }),
          requestTimeoutMs: deps.requestTimeoutMs,
          scrub: deps.scrubKnownValues,
          onPhase: onSubjectPhase
        });
      }
      if (cloneRoute && serve && subjectRepo) {
        subjectCommit = await provisionCloneSubject(desktop, {
          repo: subjectRepo,
          depth: config.subject.clone?.depth ?? 1,
          serve,
          ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
          hasGithubToken: deps.hasGithubToken,
          requestTimeoutMs: deps.requestTimeoutMs,
          scrub: deps.scrubKnownValues,
          onCommit: (commit) => {
            subjectCommit = commit;
          },
          onStateStep: (record) => {
            stateStepRecords.push(record);
          },
          onPhase: onSubjectPhase,
          ...(deps.hooks.detachedTimers ?? {})
        });
      } else if (localTreeRoute && serve && deps.localTreeArchiveBuffer) {
        await provisionLocalTreeSubject(desktop, {
          archiveBuffer: deps.localTreeArchiveBuffer,
          serve,
          ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
          requestTimeoutMs: deps.requestTimeoutMs,
          scrub: deps.scrubKnownValues,
          onStateStep: (record) => {
            stateStepRecords.push(record);
          },
          onPhase: onSubjectPhase,
          ...(deps.hooks.detachedTimers ?? {})
        });
      }

      if (!desktopCliRoute) {
        const requestedFidelity = config.execution?.desktop?.fidelity;
        // A declared camera (#509) is in place before the browser starts: the feed is generated or
        // uploaded first, and a feed that cannot be produced fails the lane closed here.
        const requestedMedia = config.execution?.desktop?.media;
        const mediaEvidence = requestedMedia === undefined
          ? undefined
          : await prepareDesktopMedia(desktop, requestedMedia, config.policies?.mediaPermission ?? "prompt", deps.labCwd, deps.requestTimeoutMs);
        const browserLaunch = await openDesktopBrowserTarget(
          desktop,
          targetUrl,
          deps.requestTimeoutMs,
          config.execution?.desktop?.browser,
          [
            ...(requestedFidelity?.mobileEmulation && spec.devicePreset.isMobile
              ? [
                  `--user-agent=${requestedFidelity.userAgent ?? DEFAULT_MOBILE_USER_AGENT}`,
                  ...(requestedFidelity.touch === false ? [] : ["--touch-events=enabled"])
                ]
              : []),
            ...(mediaEvidence?.flags ?? [])
          ]
        );
        desktopBrowser = mediaEvidence === undefined
          ? browserLaunch.evidence
          : { requested: config.execution?.desktop?.browser ?? "default", ...(browserLaunch.evidence ?? {}), media: mediaEvidence };
        if (mediaEvidence !== undefined && browserLaunch.family !== "chromium") {
          throw new Error(
            `execution.desktop.media needs Chrome or Chromium on lane ${spec.laneId} (the fake-device flags are Chromium's); the launched browser family is ${browserLaunch.family}. Set execution.desktop.browser: chrome.`
          );
        }
        launchedBrowserFamily = browserLaunch.family;
        browserLaunchIdentity = browserLaunch.identity;
        browserLaunched = true;
        await desktop.wait(BROWSER_SETTLE_MS).catch(() => undefined);
        // Mobile fidelity beyond viewport size (#221): applied to the launch page before the
        // geometry capture and the participant's first observation, OUTSIDE the stream/geometry
        // try below (whose catch degrades to a warning): a request that cannot be applied fails
        // the lane closed with the reason.
        // Only lanes on a mobile preset are emulated: a run-wide flag must not hand a desktop or
        // tablet lane an iPhone user agent (the first live proof did exactly that to the desktop
        // newcomer beside the phone lane). Those lanes carry no fidelity block, which is honest.
        const fidelityRequest = config.execution?.desktop?.fidelity;
        if (fidelityRequest?.mobileEmulation && spec.devicePreset.isMobile) {
          if (launchedBrowserFamily !== "chromium") {
            throw new Error(
              `execution.desktop.fidelity.mobileEmulation needs Chrome or Chromium on lane ${spec.laneId}; the launched browser family is ${launchedBrowserFamily}. Set execution.desktop.browser: chrome.`
            );
          }
          const applied = await applyMobileEmulation(
            desktop,
            deps.requestTimeoutMs,
            {
              ...(browserLaunchIdentity?.cdpPort === undefined ? {} : { cdpPort: browserLaunchIdentity.cdpPort }),
              ...(browserLaunchIdentity?.profileDir === undefined ? {} : { profileDir: browserLaunchIdentity.profileDir }),
              targetUrl
            },
            browserTargetId,
            {
              width: spec.devicePreset.width,
              height: spec.devicePreset.height,
              deviceScaleFactor: fidelityRequest.deviceScaleFactor ?? spec.devicePreset.deviceScaleFactor,
              touch: fidelityRequest.touch ?? true,
              userAgent: fidelityRequest.userAgent ?? DEFAULT_MOBILE_USER_AGENT
            }
          );
          appliedFidelity = applied.fidelity;
          emulatedTargetId = applied.targetId;
          emulationHolderName = applied.holderName;
          warnings.push(...applied.warnings);
        }
      } else {
        // A terminal window, opened the way the browser is opened on every other route: the
        // participant arrives at a desktop with the thing they were asked to use already in front
        // of them. They can still open another from the dock — that is the point of a desktop.
        await openDesktopTerminal(desktop, deps.requestTimeoutMs, config.subject.product?.workdir);
        await desktop.wait(BROWSER_SETTLE_MS).catch(() => undefined);
      }

      // Start the brain BEFORE the first screenshot: the app-server handshake is ~500ms, and it
      // is paid here, while the sandbox is still settling, rather than inside turn one.
      if (deps.localAgent === "codex") {
        appServer = await startAppServerSession({
          ...(spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort }),
          ...(config.actors[0]?.model === undefined ? {} : { model: config.actors[0].model }),
          // The persona lives on the THREAD, so it is stated once instead of re-sent every turn.
          baseInstructions: spec.instructions
        });
        localAgentProvider = appServer.provider;
      } else if (deps.localAgent === "claude") {
        // One session for the whole run, like the codex thread above (#520). The one-shot
        // provider (createLocalAgentProvider) spawned `claude -p` per turn, and every turn
        // started with no memory of the last. HUMANISH_LOCAL_AGENT_ONE_SHOT=1 keeps that path
        // reachable as a MEASUREMENT switch: MemTrapBench (2026-08) reports memory frameworks
        // degrading agent performance by 10-40% on some tasks, so "remembers" has to be measured
        // against "does not" on the same lab, not assumed. The trace records which one ran.
        const oneShot = env.HUMANISH_LOCAL_AGENT_ONE_SHOT !== undefined
          && env.HUMANISH_LOCAL_AGENT_ONE_SHOT !== ""
          && env.HUMANISH_LOCAL_AGENT_ONE_SHOT !== "0";
        if (oneShot) {
          localAgentProvider = createLocalAgentProvider({
            agent: "claude",
            ...(spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort }),
            ...(config.actors[0]?.model === undefined ? {} : { model: config.actors[0].model })
          });
        } else {
          claudeSession = await startClaudeSession({
            ...(spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort }),
            ...(config.actors[0]?.model === undefined ? {} : { model: config.actors[0].model })
          });
          localAgentProvider = claudeSession.provider;
        }
      }

      // World is ready: release the pipeline gate so the remaining lanes may start.
      provisioned = true;
      signal(true);

      try {
        // No browser means no browser geometry, and none is invented: the CSS-viewport facts a
        // browser reports have no counterpart in a terminal window, and an empty record shaped like
        // a measurement would read as one. The screen geometry above is still verified.
        if (!desktopCliRoute) {
          const browserGeometry = await captureDesktopBrowserGeometry({
            desktop,
            browserFamily: launchedBrowserFamily,
            ...(browserLaunchIdentity === undefined ? {} : { launchIdentity: browserLaunchIdentity }),
            laneId: spec.laneId,
            targetUrl,
            requestedScreen: spec.resolution,
            requestTimeoutMs: deps.requestTimeoutMs
          });
          initialBrowserGeometry = browserGeometry;
          browserWindowId = browserGeometry.browserWindowId;
          browserTargetId = browserGeometry.browserTargetId;

        }
        // The WHOLE desktop, not one window: a person studying a terminal app opens other windows,
        // and a stream bound to the first one would quietly stop being evidence.
        await startDesktopStream(desktop, browserWindowId);
        const candidateStreamUrl: unknown = desktop.stream.getUrl({
          authKey: desktop.stream.getAuthKey(),
          autoConnect: true,
          viewOnly: true,
          resize: "scale"
        });
        if (typeof candidateStreamUrl === "string" && candidateStreamUrl.trim().length > 0) {
          streamUrl = candidateStreamUrl;
          await deps.hooks.onRuntimeStreamReady?.({
            laneId: spec.laneId,
            sandboxId: desktop.sandboxId,
            simId: spec.simId,
            streamId: spec.streamId,
            url: streamUrl
          });
        } else {
          warnings.push("Live desktop stream started but did not return a usable watch URL; Observer will fall back to screenshots.");
        }
      } catch (error) {
        warnings.push(`Live desktop stream unavailable (run continues; evidence still captured): ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`);
      }

      // This is outside the stream's best-effort catch: unusable geometry is a harness failure,
      // never a participant finding about missing controls. Both per-lane and concurrent seats
      // use this route; sequential seats enforce the same capture result in shared-world-lab.
      if (initialBrowserGeometry?.unusable !== undefined) {
        failureCode = "HUMANISH_CUA_LAB_DEVICE_GEOMETRY";
        throw new Error(`${failureCode}: ${initialBrowserGeometry.unusable} Participant actions were not started.`);
      }

      // The FAIL-CLOSED spend cap (execution.caps.maxUsd) is wired into the loop as maxUsd + an
      // injected pure per-turn estimator keyed on the resolved model. Preflight already refused a
      // cap on an unpriced model, so the estimate is measurable whenever a cap is in force. The
      // model id here matches provider.version (openai-responses-cu resolves the default when unset).
      const capModelId = config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL;
      const maxUsd = config.execution?.caps?.maxUsd;
      const sessionOptions: CuaActorSessionOptions = {
        // Tell the persona where its inbox is — but only when comms is live AND this lane has a declared
        // recipient it can actually receive mail into (else it would stall on an inbox that stays
        // empty). Two comms planes, mutually exclusive by parse: the in-sandbox catch humanish
        // deployed, or the adopter-hosted one (#380).
        instructions: commsEmail && commsInboxUrl && deployedComms?.ready && laneHasInboxRecipient(commsEmail, spec.laneId)
          ? withInboxMission(spec, commsInboxUrl, inboxRecipientFor(commsEmail, spec.laneId)?.address).instructions
          : deps.externalComms && laneHasInboxRecipient(deps.externalComms.email, spec.laneId)
            ? withInboxMission(spec, deps.externalComms.inboxUrl, inboxRecipientFor(deps.externalComms.email, spec.laneId)?.address).instructions
            : spec.instructions,
        persona: spec.persona,
        timeoutMs: deps.timeoutMs,
        // The brain is either a keyed API client or a CLI the operator is already signed in to.
        // Everything below this line — loop, executor, trace, affordances — is identical either
        // way, which is what makes a local-agent run comparable to an API one.
        ...(localAgentProvider === undefined ? {} : { provider: localAgentProvider }),
        openai: {
          apiKey: deps.openaiApiKey,
          ...(config.actors[0]?.model ? { model: config.actors[0]!.model } : {}),
          // Per-LANE, not per-actor: two lanes at different efforts is the control this exists for.
          ...(spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort }),
          ...(spec.maxOutputTokens === undefined ? {} : { maxOutputTokens: spec.maxOutputTokens })
        },
        ...(maxUsd === undefined
          ? {}
          : {
              maxUsd,
              estimateTurnCostUsd: (usage: ActorTokenUsage): number | null =>
                estimateActorCost(usage, capModelId).estimatedCostUsd
            }),
        desktop: desktop as unknown as E2BDesktopLike,
        ...(launchedBrowserFamily === "chromium"
          ? {
              executorOptions: {
                observeBrowserState: makeChromeBrowserStateObserver(
                  desktop,
                  deps.requestTimeoutMs,
                  {
                    ...(browserLaunchIdentity?.cdpPort === undefined ? {} : { cdpPort: browserLaunchIdentity.cdpPort }),
                    ...(browserLaunchIdentity?.profileDir === undefined ? {} : { profileDir: browserLaunchIdentity.profileDir }),
                    targetUrl
                  },
                  browserTargetId,
                  // Once per lane: a dark observation channel is a gap in the instrument, and the
                  // funnel's NEVER MEASURED count needs this line to explain itself (#514).
                  (reason) => {
                    warnings.push(
                      `Browser-state observer unavailable for lane ${spec.laneId} (${redactText(deps.scrubKnownValues(reason))}); ` +
                        "urlIncludes/urlPathEquals/textIncludes stop conditions and task criteria are NOT being measured this session."
                    );
                  },
                  emulatedTargetId === undefined
                    ? undefined
                    : {
                        emulatedTargetId,
                        expectedWidth: spec.devicePreset.width,
                        expectTouch: appliedFidelity?.requested.touch === true,
                        onDrift: (reason) => {
                          warnings.push(`Mobile emulation drift on lane ${spec.laneId}: ${reason} (#623).`);
                        },
                        onCovered: (coveredTargetId, read) => {
                          // A later tab the page itself reported at the phone width: evidence that
                          // the emulation followed the participant (#623), kept on the bundle.
                          if (appliedFidelity === undefined) return;
                          appliedFidelity = {
                            ...appliedFidelity,
                            laterTargets: [...(appliedFidelity.laterTargets ?? []), { targetId: coveredTargetId, ...read }]
                          };
                        }
                      }
                )
              }
            }
          : {}),
        redactScreenshots: deps.redactScreenshots,
        scrubText: deps.scrubKnownValues,
        writeScreenshot,
        ...(spec.idleSteps === undefined ? {} : { idleSteps: spec.idleSteps }),
        ...(spec.noProgressSteps === undefined ? {} : { noProgressSteps: spec.noProgressSteps }),
        ...(spec.stopWhen === undefined ? {} : { stopWhen: spec.stopWhen }),
        ...(spec.dwell === undefined ? {} : { dwell: spec.dwell }),
        ...(spec.tasks === undefined ? {} : { tasks: spec.tasks }),
        // The STUDY budget (#299): this lane notes its own running estimate on the shared ledger
        // and stops when the RUN total crosses the cap — independent of the per-lane maxUsd above.
        ...(deps.runBudget === undefined
          ? {}
          : {
              overRunBudget: (usage: ActorTokenUsage): string | null => {
                const estimate = estimateActorCost(usage, capModelId).estimatedCostUsd;
                const totalUsd = deps.runBudget!.note(spec.laneId, estimate);
                return totalUsd > deps.runBudget!.maxTotalUsd
                  ? `study budget reached: the run's estimated model spend $${round6(totalUsd)} crossed execution.caps.maxTotalUsd=$${deps.runBudget!.maxTotalUsd}; this lane stops here and sibling lanes stop at their next turn`
                  : null;
              }
            }),
        ...(deps.onObservedUrl === undefined ? {} : { onObservedUrl: deps.onObservedUrl }),
        ...(deps.onMessage === undefined ? {} : { onMessage: deps.onMessage }),
        ...(deps.onScreenshot === undefined ? {} : { onScreenshot: deps.onScreenshot }),
        ...(deps.onTrace === undefined
          ? {}
          : {
              // Forwards the RUNNING usage as well: the lane is where both are known, and usage
              // without it never reaches the flush — which is how the live cost stayed unknown.
              onTrace: (items: readonly ActorTraceItem[], usage: ActorTokenUsage): void =>
                deps.onTrace?.(spec.laneId, items, usage)
            })
      };
      session = await deps.runSession(sessionOptions);
    }
  } catch (error) {
    sessionError = redactText(deps.scrubKnownValues(toErrorMessage(error)));
  } finally {
    // The local brain owns a process. Close it before anything else can throw: a leaked
    // app-server per lane would outlive the run and keep a thread open on the operator's plan.
    appServer?.close();
    await claudeSession?.close();
    // Stop the mid-run inbox-surface loop FIRST — before the teardown evidence drain below — so the two
    // `cat`s never overlap and the final surface state is deterministic. A surface failure can never
    // block teardown (the loop body is fully try/caught and this await is on its already-caught promise).
    surfaceDisposed = true;
    releaseSurface();
    if (surfaceLoop) await surfaceLoop.catch(() => undefined);
    if (!provisioned) {
      signal(false);
    }
    if (desktop && desktopModule) {
      if (browserLaunched) {
        const finalGeometry: Awaited<ReturnType<typeof captureDesktopBrowserGeometry>> = await captureDesktopBrowserGeometry({
          desktop,
          browserFamily: launchedBrowserFamily,
          ...(browserLaunchIdentity === undefined ? {} : { launchIdentity: browserLaunchIdentity }),
          ...(browserWindowId === undefined ? {} : { browserWindowId }),
          ...(browserTargetId === undefined ? {} : { browserTargetId }),
          laneId: spec.laneId,
          targetUrl,
          requestedScreen: spec.resolution,
          requestTimeoutMs: deps.requestTimeoutMs,
          resize: false
        }).catch((error: unknown) => ({
          warnings: [`Final browser geometry measurement failed for lane ${spec.laneId}: ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`]
        }));
        // Chosen capture rule: final-if-it-measured-anything, else launch-time. A final capture
        // that measured EITHER field wins whole, so a partial final capture omits fields the
        // launch-time capture had (honest omission); only a final capture that measured NOTHING
        // falls back to the launch-time capture.
        const chosenGeometry = finalGeometry.browserWindow !== undefined || finalGeometry.viewport !== undefined
          ? finalGeometry
          : initialBrowserGeometry ?? finalGeometry;
        const geometryWarnings = [...new Set([...(initialBrowserGeometry?.warnings ?? []), ...chosenGeometry.warnings].map((warning) => deps.scrubKnownValues(warning)))];
        warnings.push(...geometryWarnings);
        // The emulation holder's own log, after its announce line: which later targets it
        // attached to, what it sent, and any reply that came back as an error (#623). Read while
        // the sandbox is alive; the first live proof had no way to say what the holder did.
        if (appliedFidelity !== undefined && emulationHolderName !== undefined) {
          const holderLog = await readDetachedLog(desktop, emulationHolderName, deps.requestTimeoutMs).catch(() => "");
          const lines = holderLog.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{")).slice(1, 51);
          if (lines.length > 0) appliedFidelity = { ...appliedFidelity, holderLog: lines.map((line) => deps.scrubKnownValues(line)) };
        }
        desktopGeometry = {
          screen: desktopGeometry.screen,
          ...(chosenGeometry.browserWindow === undefined ? {} : { browserWindow: chosenGeometry.browserWindow }),
          ...(chosenGeometry.viewport === undefined ? {} : { viewport: chosenGeometry.viewport }),
          ...(appliedFidelity === undefined ? {} : { fidelity: appliedFidelity }),
          ...((desktopGeometry.warnings?.length ?? 0) + geometryWarnings.length === 0
            ? {}
            : { warnings: [...(desktopGeometry.warnings ?? []), ...geometryWarnings] })
        };
      }
      // Off-app comms evidence (#297): before this lane's sandbox is torn down, drain everything the
      // in-sandbox catch captured, route it into a host fake inbox addressed to the declared
      // recipients, and write the digest-only thread artifact. Wrapped so a drain failure NEVER
      // breaks teardown — the sandbox must still be killed either way. Runs only for a ready catch.
      if (commsEmail && deployedComms?.ready) {
        try {
          const commsChannel = new FakeInbox();
          const commsInboxes: CommsAddress[] = [];
          for (const recipient of commsEmail.recipients ?? []) {
            if (recipient.address !== undefined) {
              commsInboxes.push(await commsChannel.provisionAddress(recipient.lane, recipient.address));
            }
          }
          const collected = await collectCommsThread({
            desktop,
            deployed: deployedComms,
            channel: commsChannel,
            inboxes: commsInboxes,
            requestTimeoutMs: deps.requestTimeoutMs
          });
          if (collected.artifact) {
            const path = deps.laneCount === 1 ? "comms/thread.json" : `comms/${spec.streamId}.thread.json`;
            await writeContainedOutputFile(deps.artifactRoot, path, `${JSON.stringify(collected.artifact, null, 2)}\n`, "utf8");
            commsArtifactPath = path;
          } else if (collected.captured > 0) {
            // Captured mail that matched no declared recipient must not vanish silently (invariant 6:
            // honest signals): tell the operator to declare comms.email.recipients[].address to match
            // the address the app actually sends to (e.g. the one the persona surface will sign up with).
            warnings.push(`Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`);
          } else {
            // Zero captures is the silent-broken shape (#351): the app never posted to the catch at
            // all, so the personas stared at an empty inbox. Most common cause: the app does not
            // actually read the declared injectEnv var for its email API base URL.
            const transportHint = commsEmail.smtp
              ? `Verify the app reads ${commsEmail.smtp.hostEnv}/${commsEmail.smtp.portEnv} for its SMTP host and port`
              : `Verify the app reads ${commsEmail.injectEnv} for its email API base URL (an SDK that ignores it sends real mail or throws)`;
            warnings.push(`Comms catch captured ZERO email sends — the app never delivered mail through the catch. ${transportHint} and that the flow reached an email step.`);
          }
        } catch (error) {
          warnings.push(`Comms evidence collection failed (run continues; sandbox still torn down): ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`);
        }
      }

      const failed = sessionError !== undefined || session === undefined;
      // Each route's own keep flag gates its own lane only: a clone.keep can never leak into
      // a local-tree lane's teardown decision, and vice versa.
      const keepReason = cloneRoute && config.subject.clone?.keep === true
        ? "subject.clone.keep"
        : localTreeRoute && config.subject.localTree?.keep === true
          ? "subject.localTree.keep"
          : undefined;
      const keepForDebug = keepReason !== undefined && failed;
      if (keepForDebug) {
        warnings.push(`Sandbox ${desktop.sandboxId} kept for debugging (${keepReason} on failure); reclaim it via E2B or it will be killed on its server-side timeout.`);
      } else if (typeof desktopModule.Sandbox.kill === "function") {
        try {
          await desktopModule.Sandbox.kill(desktop.sandboxId, { requestTimeoutMs: 60_000 });
          killed = true;
        } catch (error) {
          warnings.push(`Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(deps.scrubKnownValues(toErrorMessage(error)))}`);
        }
      } else {
        warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox.");
      }
      // Close the observed span. A kept or unconfirmed sandbox can still accrue compute cost;
      // the summary records that remaining lifetime as unknown instead of calling this complete.
      sandboxTornDownAtMs = deps.now();
      // The lane's live stream is now a dead page whichever teardown path ran (killed, kept, or
      // kill-failed-awaiting-TTL) — tell the watch overlay so the tile falls back to recorded
      // evidence instead of "sandbox not found" (#357). Guarded: a viewer callback must never
      // break teardown.
      if (streamUrl !== undefined) {
        try {
          await deps.hooks.onRuntimeStreamEnded?.({ laneId: spec.laneId, simId: spec.simId, streamId: spec.streamId });
        } catch {
          // viewer-side only; nothing to record
        }
      }
    }
  }

  // Host-side approximation of the E2B desktop's billed lifetime; feeds the desktop-minute cost
  // estimate. Never negative.
  const desktopDurationMs = sandboxCreatedAtMs !== undefined && sandboxTornDownAtMs !== undefined
    ? Math.max(0, sandboxTornDownAtMs - sandboxCreatedAtMs)
    : undefined;

  if (session) {
    // Per-lane model-token cost ESTIMATE, attached to the trace before it is persisted (the model
    // id is authoritative here — provider.version). Kept at the lab boundary so the pure loop
    // never depends on the operator rate table. estimateActorCost declares absent (null) for an
    // unknown rate / missing usage rather than guessing.
    session.trace.estimatedCost = estimateActorCost(session.trace.tokenUsage, session.trace.ids.model);
    await writeContainedOutputFile(deps.artifactRoot, spec.traceArtifactPath, `${JSON.stringify(session.trace, null, 2)}\n`, "utf8");
    if (session.trace.redaction.screenshots === "raw") {
      warnings.push("Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .humanish and nothing scans these pixels; review them before sharing anywhere. Set policies.redactScreenshots: true to blur a share-as-is bundle.");
    }
  }

  const noEngagement = session !== undefined
    && session.completionReason === "goal_satisfied"
    && (session.trace.counts.actions ?? 0) === 0
    && (session.trace.counts.messages ?? 0) === 0
    && !traceHasStopWhenMatch(session);
  if (noEngagement) {
    warnings.push("Actor returned goal_satisfied with ZERO actions and ZERO messages — it likely saw a blank or still-loading screen and stopped without engaging. NOT counted as a pass. Check the screenshot; raise execution.timeoutMs or confirm the subject painted before the first turn.");
  }

  const blockerReason = resolveSelfReportedBlocker(session);
  const selfReportedBlocker = blockerReason !== undefined;
  const reportedFriction = resolveSelfReportedFriction(session) !== undefined;
  if (selfReportedBlocker) {
    warnings.push(`Actor returned goal_satisfied while its final message describes a blocker or asks for missing instructions — NOT counted as a pass: ${redactText(deps.scrubKnownValues(blockerReason))}`);
  }

  const harnessError = sessionError !== undefined || session?.completionReason === "harness_error";

  return {
    spec,
    ...(session ? { session } : {}),
    ...(sessionError === undefined ? {} : { sessionError }),
    ...(sandboxId === undefined ? {} : { sandboxId }),
    ...(desktopDurationMs === undefined ? {} : { desktopDurationMs }),
    ...(desktopResources === undefined ? {} : { desktopResources }),
    killed,
    streamUrlPresent: streamUrl !== undefined,
    screenshots,
    ...(subjectCommit === undefined ? {} : { subjectCommit }),
    ...(desktopBrowser === undefined ? {} : { desktopBrowser }),
    desktopGeometry,
    stateStepRecords,
    phaseRecords,
    warnings,
    noEngagement,
    selfReportedBlocker,
    reportedFriction,
    harnessError,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(commsArtifactPath === undefined ? {} : { commsArtifactPath })
  };
}

/** Run the single IN-PROCESS lane (a custom executor + provider; NO E2B). Always one lane. */
async function runInProcessLane(spec: CuaLaneSpec, deps: CuaLaneDeps): Promise<LaneRunOutcome> {
  const warnings: string[] = [];
  const screenshots: string[] = [];
  const writeScreenshot = makeLaneWriteScreenshot(deps.artifactRoot, spec, screenshots);
  let session: CuaLoopResult | undefined;
  let sessionError: string | undefined;
  try {
    const executor = await deps.hooks.buildExecutor!({ config: deps.config, actor: deps.descriptor, appUrl: deps.appUrl });
    const provider = await deps.hooks.buildProvider!({ config: deps.config, actor: deps.descriptor });
    const sessionOptions: CuaActorSessionOptions = {
      instructions: spec.instructions,
      persona: spec.persona,
      timeoutMs: deps.timeoutMs,
      provider,
      executor,
      redactScreenshots: deps.redactScreenshots,
      scrubText: deps.scrubKnownValues,
      writeScreenshot,
      ...(spec.stopWhen === undefined ? {} : { stopWhen: spec.stopWhen }),
      ...(spec.dwell === undefined ? {} : { dwell: spec.dwell }),
      ...(spec.tasks === undefined ? {} : { tasks: spec.tasks })
    };
    session = await deps.runSession(sessionOptions);
  } catch (error) {
    sessionError = redactText(deps.scrubKnownValues(toErrorMessage(error)));
  }

  if (session) {
    await writeContainedOutputFile(deps.artifactRoot, spec.traceArtifactPath, `${JSON.stringify(session.trace, null, 2)}\n`, "utf8");
    if (session.trace.redaction.screenshots === "raw") {
      warnings.push("Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .humanish and nothing scans these pixels; review them before sharing anywhere. Set policies.redactScreenshots: true to blur a share-as-is bundle.");
    }
  }

  const noEngagement = session !== undefined
    && session.completionReason === "goal_satisfied"
    && (session.trace.counts.actions ?? 0) === 0
    && (session.trace.counts.messages ?? 0) === 0
    && !traceHasStopWhenMatch(session);
  if (noEngagement) {
    warnings.push("Actor returned goal_satisfied with ZERO actions and ZERO messages — it likely saw a blank or still-loading screen and stopped without engaging. NOT counted as a pass. Check the screenshot; raise execution.timeoutMs or confirm the subject painted before the first turn.");
  }
  const blockerReason = resolveSelfReportedBlocker(session);
  const selfReportedBlocker = blockerReason !== undefined;
  const reportedFriction = resolveSelfReportedFriction(session) !== undefined;
  if (selfReportedBlocker) {
    warnings.push(`Actor returned goal_satisfied while its final message describes a blocker or asks for missing instructions — NOT counted as a pass: ${blockerReason}`);
  }

  return {
    spec,
    ...(session ? { session } : {}),
    ...(sessionError === undefined ? {} : { sessionError }),
    killed: false,
    streamUrlPresent: false,
    screenshots,
    stateStepRecords: [],
    phaseRecords: [],
    warnings,
    noEngagement,
    selfReportedBlocker,
    reportedFriction,
    harnessError: sessionError !== undefined || session?.completionReason === "harness_error",
    entryKind: "local-app"
  };
}

/**
 * Run N>1 E2B lanes with bounded concurrency, a pipeline gate (lane 1 provisions before the rest
 * start), and session fail-fast on HARNESS errors only (queued lanes become `blocked` with a
 * pinned reason + a fail-fast event; mission verdicts never trip it). Each lane tears down ITS
 * OWN sandbox by id; nothing here ever enumerates.
 */
/** Exported for the #342 total-runner tests: the injectable runner lets a test make one lane
 *  THROW (the exact class the guard exists for) without a live sandbox. Production always uses
 *  the default. */
export async function runCuaLanes(
  laneSpecs: CuaLaneSpec[],
  deps: Omit<CuaLaneDeps, "signalProvisioned">,
  concurrency: number,
  runLane: typeof runCuaLane = runCuaLane
): Promise<{ outcomes: LaneRunOutcome[]; failFastReason?: string }> {
  const failFast: { tripped: boolean; reason: string } = { tripped: false, reason: "" };
  let resolveGate: (() => void) | undefined;
  let rejectGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = () => reject(new Error("gate"));
  });
  // The gate is rejected on lane-0 provisioning failure; swallow the unhandled rejection if no
  // later lane ever awaits it (concurrency could let lane 0 finish alone).
  gate.catch(() => undefined);

  const outcomes = await mapWithConcurrency(laneSpecs, concurrency, async (spec, index): Promise<LaneRunOutcome> => {
    if (index > 0) {
      try {
        await gate;
      } catch {
        return blockedLaneOutcome(spec, `skipped: lane ${laneSpecs[0]?.laneId ?? "lane-01"} failed to provision its world (pipeline gate)`);
      }
    }
    if (failFast.tripped) {
      return blockedLaneOutcome(spec, `skipped: ${failFast.reason}`);
    }
    // The lane runner is TOTAL (#342): every exit path returns a recorded outcome. Without this
    // guard, one lane's late throw (e.g. its trace write hitting ENOSPC after its own sandbox was
    // already torn down) rejected the whole map while sibling workers kept launching sandboxes
    // nobody would ever record — the run spent money and then reported nothing.
    let outcome: LaneRunOutcome;
    try {
      outcome = await runLane(spec, {
        ...deps,
        ...(index === 0
          ? {
              signalProvisioned: (ok: boolean) => {
                if (ok) {
                  resolveGate?.();
                } else {
                  rejectGate?.();
                }
              }
            }
          : {})
      });
    } catch (error) {
      // Lane 0 may have thrown before signaling the provisioning gate — release the followers as
      // blocked rather than leaving them awaiting a gate that will never settle.
      if (index === 0) rejectGate?.();
      const detail = redactText(toErrorMessage(error));
      outcome = {
        spec,
        killed: false,
        streamUrlPresent: false,
        screenshots: [],
        stateStepRecords: [],
        phaseRecords: [],
        warnings: [],
        noEngagement: false,
        selfReportedBlocker: false,
        reportedFriction: false,
        harnessError: true,
        sessionError: `lane runner threw outside the session guard: ${detail}`
      };
    }
    if (outcome.harnessError && !failFast.tripped) {
      failFast.tripped = true;
      failFast.reason = `a prior lane (${outcome.spec.laneId}) ended in a harness error (fail-fast)`;
    }
    return outcome;
  });

  return { outcomes, ...(failFast.tripped ? { failFastReason: failFast.reason } : {}) };
}

/** Project one lane outcome (or a dry-run contract spec) into the public CuaLaneResult. */
function toLaneResult(spec: CuaLaneSpec, outcome: LaneRunOutcome | undefined, subject: CuaSubjectProjection, dryRun: boolean): CuaLaneResult {
  const base = {
    id: spec.laneId,
    ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
    ...(spec.surface === undefined ? {} : { surface: spec.surface }),
    ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
    index: spec.laneIndex + 1,
    persona: spec.persona.id,
    device: spec.deviceName,
    resolution: spec.resolution,
    subject
  };
  if (!outcome || dryRun) {
    return { ...base, status: "contract_proof_only", ok: dryRun };
  }
  if (outcome.skippedReason !== undefined) {
    return {
      ...base,
      status: "blocked",
      ok: false,
      skippedReason: outcome.skippedReason,
      error: { code: "HUMANISH_CUA_LAB_FAILED", message: outcome.skippedReason }
    };
  }
  const session = outcome.session;
  const laneOk = laneOutcomeOk(outcome, dryRun);
  const status: CuaLaneResult["status"] = session ? session.status : "failed";
  return {
    ...base,
    status,
    ok: laneOk,
    ...(session
      ? {
          session: {
            status: session.status,
            completionReason: session.completionReason,
            reason: session.reason,
            screenshots: outcome.screenshots.length
          }
        }
      : {}),
    ...(outcome.sandboxId === undefined
      ? {}
      : { sandbox: { sandboxId: outcome.sandboxId, killed: outcome.killed, streamUrlPresent: outcome.streamUrlPresent } }),
    ...(laneOk
      ? {}
      : {
          error: {
            code: outcome.failureCode ?? "HUMANISH_CUA_LAB_FAILED",
            message: outcome.sessionError
              ?? (outcome.noEngagement
                ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
                : outcome.selfReportedBlocker
                  ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
                : session?.completionReason === "harness_error"
                  ? `Computer-use session ended with a harness error: ${session.reason}`
                  : session?.status !== "passed"
                  ? `Computer-use session ended with ${session?.status ?? "unknown"}: ${session?.reason ?? "no terminal reason"}`
                  : "Computer-use lab did not produce a terminal session.")
          }
        })
  };
}

function laneOutcomeOk(outcome: LaneRunOutcome | undefined, dryRun: boolean): boolean {
  if (dryRun) return true;
  if (!outcome || outcome.skippedReason !== undefined) return false;
  return outcome.session !== undefined
    && outcome.session.status === "passed"
    && outcome.session.completionReason !== "harness_error"
    && outcome.sessionError === undefined
    && !outcome.noEngagement
    && !outcome.selfReportedBlocker;
}

function fanoutReviewVerdict(args: {
  dryRun: boolean;
  expectedLaneCount: number;
  outcomes: LaneRunOutcome[] | undefined;
}): ReviewSummary["verdict"] {
  if (args.dryRun) return "contract_proof_only";
  const outcomes = args.outcomes ?? [];
  if (outcomes.length !== args.expectedLaneCount) return "fail";
  if (outcomes.some((outcome) => !laneOutcomeOk(outcome, false))) {
    return outcomes.some((outcome) => outcome.session?.status === "timed_out")
      ? "timed_out"
      : "fail";
  }
  return "pass";
}

/** Build the per-lane subject projection (invariant 5). Local-tree lanes all share ONE
 *  host-packed archive, so every lane's projection carries the identical archiveSha256/
 *  commit/dirty (no per-lane divergence is possible, unlike the clone route's per-lane
 *  in-sandbox commit). */
function laneSubjectProjection(args: {
  cloneRoute: boolean;
  localTreeRoute: boolean;
  publicRepo?: string;
  subjectEnvNames: string[];
  subjectCommit?: string;
  localTreeArchive?: LocalTreeArchive;
  subjectState: RunSubjectProvenance["state"];
}): CuaSubjectProjection {
  if (args.cloneRoute && args.publicRepo) {
    return {
      source: "clone",
      repo: args.publicRepo,
      ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
      envNames: args.subjectEnvNames,
      state: args.subjectState
    };
  }
  if (args.localTreeRoute) {
    const archive = args.localTreeArchive;
    return {
      source: "local-tree",
      ...(archive === undefined ? {} : { archiveSha256: archive.archiveSha256 }),
      ...(archive?.git === undefined ? {} : { commit: archive.git.commit, dirty: archive.git.dirty }),
      envNames: args.subjectEnvNames,
      state: args.subjectState
    };
  }
  return { source: "app-url", state: args.subjectState };
}

/** Narrow a resolved CuaSubjectProjection into the shape buildCuaBundle/buildSingleLaneBundle's
 *  subjectProvenance param wants (provisioned-route sources only; app-url stays undeclared, the
 *  default branch buildCuaBundle already handles). */
function subjectProvenanceArg(
  subject: CuaSubjectProjection,
  publicRepo: string | undefined,
  subjectEnvNames: string[]
): CuaSubjectProvenanceArg | undefined {
  if (subject.source === "clone" && publicRepo) {
    return {
      source: "clone",
      repo: publicRepo,
      ...(subject.commit === undefined ? {} : { commit: subject.commit }),
      envNames: subjectEnvNames,
      state: subject.state
    };
  }
  if (subject.source === "local-tree") {
    return {
      source: "local-tree",
      ...(subject.archiveSha256 === undefined ? {} : { archiveSha256: subject.archiveSha256 }),
      ...(subject.commit === undefined ? {} : { commit: subject.commit }),
      ...(subject.dirty === undefined ? {} : { dirty: subject.dirty }),
      envNames: subjectEnvNames,
      state: subject.state
    };
  }
  return undefined;
}

/**
 * Wrapped so a DIRECT library caller gets the same status-record lifetime the CLI does: returning
 * from this function finalizes any record the run opened, whichever of its fail-closed exits it
 * took. `runLab` establishes a scope too and nesting is harmless — the inner scope owns what it
 * opened. Without this a test or an adopter calling the backend directly leaves the 5s cadence
 * ticking into a directory something else is deleting, which surfaces as an unrelated ENOTEMPTY.
 */
export async function runCuaActorLab(options: RunCuaActorLabOptions): Promise<CuaActorLabResult> {
  return withRunStatusScope(() => runCuaActorLabInScope(options));
}

async function runCuaActorLabInScope(options: RunCuaActorLabOptions): Promise<CuaActorLabResult> {
  const { config, dryRun } = options;
  // Capture the physical project before reading or invoking any caller hook. A supported
  // symlink cwd remains valid, but retargeting that alias from a hook cannot redirect source
  // reads, local-tree packing, managed run storage, or Observer output into another project.
  const physicalCwd = await realpath(path.resolve(options.cwd));
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const cwd = projectRoot.physicalPath;
  const hooks = options.hooks ?? {};
  let liveObserver: (ObserverResult & { ok: true }) | undefined;
  const runtimeStreamUrls: ObserverRuntimeStreamUrl[] = [];
  const liveHooks: CuaActorLabHooks = {
    ...hooks,
    onRuntimeStreamReady: async (stream) => {
      await hooks.onRuntimeStreamReady?.(stream);
      runtimeStreamUrls.push({ streamId: stream.streamId, url: stream.url });
      if (liveObserver) {
        attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
      }
    },
    onRuntimeStreamEnded: async (stream) => {
      await hooks.onRuntimeStreamEnded?.(stream);
      // Mark, never remove: the tile needs to KNOW the live view ended (and say so) rather than
      // have the stream silently vanish from the overlay (#357).
      for (const entry of runtimeStreamUrls) {
        if (entry.streamId === stream.streamId) entry.ended = true;
      }
      if (liveObserver) {
        attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
      }
    }
  };
  const env = hooks.env ?? process.env;
  const render = hooks.renderObserverFn ?? renderObserver;

  const cloneRoute = config.subject.source === "clone";
  // A CLI studied at a desktop (#495): nothing cloned, no browser, a terminal instead.
  const desktopCliRoute = config.subject.source === "desktop-cli";
  const localTreeRoute = config.subject.source === "local-tree";
  // Both routes provision the subject in-sandbox (clone via git, local-tree via pack+upload)
  // and then share the identical install/build/state/start/probe pipeline, so every seam that
  // gates on "does this route provision a subject" is keyed on this union, not on cloneRoute
  // alone.
  const provisionedRoute = cloneRoute || localTreeRoute;
  const serve = config.subject.serve;
  const appUrl = (provisionedRoute ? serve?.url : config.subject.appUrl) ?? "";
  const subjectRepo = cloneRoute ? config.subject.repos?.[0] ?? "" : undefined;
  const subjectEnvNames = provisionedRoute ? config.subject.env ?? [] : [];
  const actor = config.actors[0];
  const actorType = actor?.type ?? "";

  const fail = (code: CuaActorLabErrorCode, message: string, actorLabel?: string): CuaActorLabResult => ({
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: actorLabel ?? actorType,
    appUrl,
    dryRun,
    runId: options.runId ?? "not-created",
    lanes: [],
    warnings: [],
    error: { code, message }
  });

  // Resolve the actor through the registry — the parse layer validated this, but the engine fails
  // closed rather than trusting a config that arrived through another door.
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return fail("HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED", `actors[0].type "${actorType}" is not a registered computer-use actor.`);
  }
  const runSession = hooks.runSession ?? descriptor.runSession;
  const outputLimitReason = outputTokenLimitValidationReason(config);
  if (outputLimitReason) return fail("HUMANISH_CUA_LAB_SUBJECT_INVALID", outputLimitReason, descriptor.id);
  if (actor?.maxOutputTokens !== undefined && (hooks.runSession || hooks.buildProvider || hooks.buildExecutor)) {
    return fail("HUMANISH_CUA_LAB_SUBJECT_INVALID", "maxOutputTokens cannot be enforced by a custom runSession/provider/executor route.", descriptor.id);
  }
  const inProcessRoute = hooks.buildExecutor !== undefined;
  const localAppSubject = config.subject.source === "local-app";
  // Adopter-hosted comms plane on the app-url route (#380): humanish provisions no subject here,
  // so it cannot host a catch — the OPERATOR runs one, and humanish still does every other part
  // of the funnel: tells each persona its address and inbox URL, drains the catch over HTTP after
  // the lanes, and writes the same digest-only evidence. Declaring `external` previously did
  // nothing on this route (and, per #387, on every other) while its docs said otherwise.
  const externalCommsConfig = !cloneRoute && !localTreeRoute && !inProcessRoute
    ? config.comms?.email?.external
    : undefined;
  const externalCommsEmail = externalCommsConfig ? config.comms?.email : undefined;

  // Engine re-enforcement of the clone-route structure (library API surface).
  if (cloneRoute && (!serve || !subjectRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(subjectRepo))) {
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      !serve
        ? "clone subjects on the computer-use route require `subject.serve` (start + url) — the lab serves the app in-sandbox."
        : `subject.repos[0] must be an owner/repo slug (got "${subjectRepo ?? ""}").`,
      descriptor.id
    );
  }

  // Engine re-enforcement of the local-tree-route structure (library API surface): a caller
  // driving this function directly (bypassing parseLabConfig) still gets the same fail-closed
  // shape the parser enforces, naming which requirement is missing.
  if (localTreeRoute && (!serve || config.execution?.target !== "e2b-desktop")) {
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      !serve
        ? "local-tree subjects on the computer-use route require `subject.serve` (start + url): the lab packs and serves the working tree in-sandbox."
        : "local-tree subjects require `execution.target: e2b-desktop`: the packed working tree is provisioned and served inside a hosted desktop sandbox.",
      descriptor.id
    );
  }

  // Engine re-enforcement of the state declaration (library API surface).
  if (config.subject.state) {
    const stateReason = !provisionedRoute
      ? "`subject.state` applies only to clone subjects or local-tree subjects (the lab seeds the state it serves)."
      : subjectStateInvalidReason(config.subject.state, config.subject.env);
    if (stateReason) {
      return fail("HUMANISH_CUA_LAB_SUBJECT_INVALID", stateReason, descriptor.id);
    }
  }

  // Re-enforce the entry-target boundary (library API surface). A desktop-cli study has no entry
  // target at all — the subject is a program on the machine, not an address — so the boundary is
  // vacuous there rather than violated by an empty string.
  const allowPublicTargets = config.policies?.allowPublicTargets === true;
  const declaredTargets = [appUrl, ...(actor?.lanes ?? []).map((lane) => lane.target).filter((target): target is string => target !== undefined)];
  const entryTargetSafe = desktopCliRoute || declaredTargets.every((target) =>
    provisionedRoute || localAppSubject
      ? isLoopbackUrl(target)
      : allowPublicTargets
        ? isHttpUrl(target)
        : isLoopbackUrl(target));
  if (!entryTargetSafe) {
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_UNSAFE",
      provisionedRoute || localAppSubject || !allowPublicTargets
        ? "subject.appUrl and any actors[0].lanes[].target entries must be loopback (127.0.0.1 or localhost) unless policies.allowPublicTargets is set for an app-url subject."
        : "subject.appUrl and actors[0].lanes[].target entries must be valid http(s) URLs.",
      descriptor.id
    );
  }

  // In-process route pairing guard (boot-time, BEFORE key-gating): a custom executor needs a
  // custom provider too (the default OpenAI provider is vision-based and would fail closed).
  if (hooks.buildExecutor !== undefined && hooks.buildProvider === undefined) {
    return fail(
      "HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER",
      "cuaHooks.buildExecutor requires cuaHooks.buildProvider — a state-driven executor returns no screenshot, so it must be paired with a NON-vision provider (the default OpenAI computer-use provider is vision-based and would fail closed).",
      descriptor.id
    );
  }

  // local-app fail-closed (BEFORE key-gating): there is no built-in in-process driver.
  if (localAppSubject && !inProcessRoute) {
    return fail(
      "HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR",
      "subject.source: local-app requires a library caller to supply cuaHooks.buildExecutor + buildProvider; there is no built-in driver for an in-process JS contract. (Drive the app via runLab(..., { cuaHooks: { buildExecutor, buildProvider } }).)",
      descriptor.id
    );
  }

  // Re-enforce the fan-out cross-validation (library API surface): lanes XOR count/laneFocus,
  // device XOR raw resolution, cap, unique ids, allowPublicTargets+N>1, clone.fanout.
  const fanoutReason = cuaLaneValidationReason(config);
  if (fanoutReason) {
    return fail("HUMANISH_CUA_LAB_FANOUT_INVALID", fanoutReason, descriptor.id);
  }

  // The sandbox deadline is DERIVED from the session budget, so a lab can ask for a session that
  // cannot legally be provisioned. Catch it here, before anything is created, and show the
  // arithmetic — the provider's own error names a limit but not which knob produced it.
  const derivedSandboxMs = resolvePerLaneSandboxMs(config);
  if (derivedSandboxMs > MAX_SANDBOX_MS) {
    const provisionedRoute = config.subject.source === "clone" || config.subject.source === "local-tree";
    const sessionMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
    const headroomMs = derivedSandboxMs - sessionMs;
    return fail(
      "HUMANISH_CUA_LAB_SUBJECT_INVALID",
      `execution.timeoutMs ${Math.round(sessionMs / 60_000)}m derives a ${Math.round(derivedSandboxMs / 60_000)}m sandbox deadline, and a sandbox may not live longer than ${MAX_SANDBOX_MS / 60_000}m. The deadline is the session budget plus ${Math.round(headroomMs / 60_000)}m of provisioning and teardown headroom${provisionedRoute ? " (this route clones, installs, builds and serves the subject before the actor starts)" : ""}. Lower execution.timeoutMs to at most ${Math.round((MAX_SANDBOX_MS - headroomMs) / 60_000)}m, or set execution.desktop.sandboxTimeoutMs explicitly.`,
      descriptor.id
    );
  }

  // Compile any committed personas BEFORE planning, so the plan builder stays pure and each lane's
  // prompt carries real behavioral directives rather than a bare `Persona: <id>.` label (#381).
  const personaResolution = await resolveCommittedPersonas(projectRoot, labPersonaIds(config));
  for (const warning of personaResolution.warnings) {
    process.stderr.write(`humanish: ${warning}\n`);
  }

  // Resolve the lane plan (pure) — the SAME table for dry-run and live.
  let { lanes: laneSpecs, plan } = laneSpecsAndPlan(config, {
    ...(options.countOverride === undefined ? {} : { countOverride: options.countOverride }),
    env,
    dryRun,
    personas: personaResolution.personas
  });
  let laneCount = laneSpecs.length;

  if (laneCount > MAX_CUA_LANES) {
    return fail(
      "HUMANISH_CUA_LAB_FANOUT_INVALID",
      `Computer-use fan-out is capped at ${MAX_CUA_LANES} lanes (resolved ${laneCount}); N concurrent paid desktops is real spend.`,
      descriptor.id
    );
  }
  if (inProcessRoute && laneCount > 1) {
    return fail(
      "HUMANISH_CUA_LAB_FANOUT_INVALID",
      "Multi-lane fan-out is not supported on the in-process route (cuaHooks.buildExecutor) — fan-out provisions one independent E2B desktop per lane, which the in-process route deliberately skips. Run a single in-process lane, or fan out on the E2B route.",
      descriptor.id
    );
  }

  let rerunLineage: RunRerunLineage | undefined;
  if (options.rerun) {
    const selected = await resolveCuaRerunSelection({
      cwd,
      config,
      sourceRunId: options.rerun.sourceRunId,
      ...(options.rerun.laneIds === undefined ? {} : { laneIds: options.rerun.laneIds }),
      laneSpecs,
      plan
    });
    if (!selected.ok) {
      return fail("HUMANISH_CUA_LAB_RERUN_INVALID", selected.message, descriptor.id);
    }
    laneSpecs = selected.laneSpecs;
    plan = selected.plan;
    laneCount = laneSpecs.length;
    rerunLineage = selected.rerun;
  }

  // Pre-flight plan: BEFORE any sandbox or provider call (dry-run AND live). The hook fires for
  // every N (observable + testable); the stderr table prints for fan-out (N>1) so single-lane
  // runs stay as quiet as they always were.
  if (laneCount > 1) {
    emitPreflightPlan(plan, config.id);
  }
  hooks.onPreflight?.(plan);
  await assertPreparedSelectedOutputDirectory(projectRoot);

  // Read keys once into locals (names only; values never logged or persisted).
  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";

  // Literal scrubber for every known provisioned value (no secret "shape" to pattern-match).
  const knownSecretValues = [
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? "")
  ].filter((value) => value.length >= 4);
  const scrubKnownValues = (text: string): string =>
    knownSecretValues.reduce((current, value) => current.split(value).join("[REDACTED_SECRET]"), text);

  const redactRepoLabel = config.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo = cloneRoute && subjectRepo ? (redactRepoLabel ? "repo-01" : subjectRepo) : undefined;
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");

  // The operator's own signed-in coding agent is the brain, so there is no provider key to ask
  // for — the entire point of the actor. E2B is still required: the persona needs a machine.
  const localAgentRoute = actorType === "local-agent";
  // Which local CLI, from its OWN field: `model` means the model, so that "Claude Code running
  // Opus" is sayable. Preflight below refuses when the chosen one is missing or signed out — that
  // news is worthless after a sandbox is paid for.
  const preferredLocalAgent: LocalAgentId = config.actors[0]?.localAgent ?? "codex";
  // Key-gating is route-aware: the in-process route uses the caller's OWN model + executor, and
  // the local-agent route uses a CLI the operator has already signed in to.
  if (!dryRun && !inProcessRoute) {
    const missingKeys = [
      ...(openaiApiKey || localAgentRoute ? [] : ["OPENAI_API_KEY"]),
      ...(e2bApiKey ? [] : ["E2B_API_KEY"])
    ];
    if (missingKeys.length > 0) {
      // The moment someone new actually hits the wall. If a signed-in coding agent is sitting
      // right there, say so HERE rather than making them go and find an API key — that detour is
      // where most people trying humanish stop.
      const suggestion = missingKeys.includes("OPENAI_API_KEY")
        ? await (async () => {
            const ready = (await detectLocalAgents()).filter((agent) => agent.credentialsPresent);
            return ready.length === 0
              ? ""
              : ` You have ${ready.map((agent) => agent.label).join(" and ")} signed in on this machine`
                + ` — set actors[0].type: local-agent to use ${ready.length === 1 ? "it" : "one"} instead of a key.`;
          })()
        : "";
      return fail(
        "HUMANISH_CUA_LAB_KEYS_MISSING",
        `Live computer-use labs need ${missingKeys.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missingKeys, env)}${suggestion}`,
        descriptor.id
      );
    }
    if (localAgentRoute) {
      // Refuse HERE, before a sandbox exists. "codex is not installed" discovered after the
      // machine is paid for is the same information delivered at the worst possible moment.
      const available = await detectLocalAgents();
      const chosen = available.find((agent) => agent.id === preferredLocalAgent);
      if (chosen === undefined) {
        return fail(
          "HUMANISH_CUA_LAB_KEYS_MISSING",
          `actors[0].type: local-agent needs the ${preferredLocalAgent} CLI on PATH and signed in. `
            + `Install it, or set OPENAI_API_KEY and use actors[0].type: openai-computer-use instead.`,
          descriptor.id
        );
      }
      if (!chosen.credentialsPresent) {
        return fail(
          "HUMANISH_CUA_LAB_KEYS_MISSING",
          `${chosen.label} is installed but not signed in — run \`${chosen.bin}\` once to log in. `
            + "humanish never reads its credentials; it only checks that the file exists.",
          descriptor.id
        );
      }
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return fail(
        "HUMANISH_CUA_LAB_SUBJECT_ENV_MISSING",
        `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
        descriptor.id
      );
    }
    // FAIL-CLOSED CAP TENSION (discipline #3): a maxUsd cap needs a MEASURABLE per-turn estimate.
    // If the operator set execution.caps.maxUsd but src/pricing.ts has no rate for the resolved
    // model, the loop could not enforce the cap — and silently running uncapped would break the
    // runaway-retry protection. Refuse at PREFLIGHT (before any sandbox/spend) rather than run
    // uncapped: an unenforceable cap is more dangerous than none. The operator adds a rate to
    // src/pricing.ts (the honest place) or removes the cap.
    if (config.execution?.caps?.maxUsd !== undefined || config.execution?.caps?.maxTotalUsd !== undefined) {
      const capModelId = (config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL).trim().toLowerCase();
      if (!MODEL_RATES[capModelId]) {
        return fail(
          "HUMANISH_CUA_LAB_UNPRICED_CAP",
          `execution.caps declares a spend cap (maxUsd/maxTotalUsd) but src/pricing.ts has no rate for model "${config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL}"; add a rate or remove the cap — an unenforceable cap is refused rather than run uncapped.`,
          descriptor.id
        );
      }
    }
    // Adopter-hosted comms catch (#380): fail closed BEFORE any sandbox is created — a comms lab
    // whose catch is unreachable collects nothing while every lane still spends. The probe asserts
    // OUR service marker in /health, so an adopter's proxy answering 200 for everything cannot
    // pass for a catch.
    if (externalCommsConfig && !(await externalCatchHealthy(externalCommsConfig))) {
      return fail(
        "HUMANISH_CUA_LAB_COMMS_CATCH_UNREACHABLE",
        "comms.email.external.catchBaseUrl is not reachable as a humanish comms catch (GET /health must return the humanish-comms-catch service marker). Start it with `humanish comms catch` on that host, or drop comms.email to run without the inbox funnel.",
        descriptor.id
      );
    }
  }

  const runId = options.runId ?? makeCuaRunId();
  const runPaths = await prepareRunArtifactPaths(cwd, runId);
  // Identity + liveness on disk from the first moment (#455): anything watching the runs
  // directory — the TUI, another terminal, an agent — can now tell which lab this is and that
  // it is alive, without waiting for the interactive observer flush that used to be the only
  // mid-run write. The success path finalizes it with the real outcome; the fail-closed returns
  // below do not, so `runLab`'s status scope finalizes those with no outcome. A crash reaches
  // neither and leaves the record stale, which reads as interrupted rather than as a lie.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab })
  });
  const artifactRoot = runPaths.absoluteRunRoot;
  const physicalArtifactRoot = runPaths.physicalRunRoot;
  const createdAt = new Date().toISOString();
  const timeoutMs = config.execution?.timeoutMs ?? defaultSessionTimeoutMs(config);
  const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;

  await prepareContainedOutputDirectory(runPaths, "screenshots");
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd,
    humanishSource: "present",
    packageName: "humanish"
  });

  // Pack the working tree ONCE per run, on the host, BEFORE any sandbox or provider call: every
  // fan-out lane below uploads this SAME archive, so one archiveSha256 describes every lane's
  // digest. Dry-run packs nothing (no fs side effects; the contract bundle carries no
  // archiveSha256). A packing failure fails the run closed here, before createDesktopSandbox is
  // ever reached.
  let localTreeArchive: LocalTreeArchive | undefined;
  let localTreeArchiveBuffer: ArrayBuffer | undefined;
  if (localTreeRoute && !dryRun) {
    const packLocalTree = hooks.packLocalTree ?? defaultPackLocalTree;
    try {
      const packed = await packLocalTree({
        root: cwd,
        ...(config.subject.localTree?.exclude === undefined ? {} : { extraExclude: config.subject.localTree.exclude }),
        ...(config.subject.localTree?.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: config.subject.localTree.maxArchiveBytes })
      });
      localTreeArchive = packed.archive;
      localTreeArchiveBuffer = packed.buffer;
      // One operator-facing line (stderr, same channel as emitPreflightPlan): what left the
      // host, by counts and digest only, never paths or file names.
      process.stderr.write(
        `humanish local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}`
        + `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`
      );
    } catch (error) {
      return fail(
        "HUMANISH_CUA_LAB_SUBJECT_INVALID",
        `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
        descriptor.id
      );
    }
  }

  // Live-trace flush seam (#441): assigned by the attached-Observer block below when a live
  // run has an in-progress bundle to grow; lanes call it through deps.onTrace. Declared here
  // (before deps) so deps can reference it as a stable indirection.
  let flushLiveTrace: ((laneId: string, items: readonly ActorTraceItem[], usage?: ActorTokenUsage) => void) | undefined;
  let stopLiveFlush: (() => Promise<void>) | undefined;

  const deps: Omit<CuaLaneDeps, "signalProvisioned"> = {
    onTrace: (laneId, items, usage) => flushLiveTrace?.(laneId, items, usage),
    config,
    descriptor,
    appUrl,
    ...(localAgentRoute ? { localAgent: preferredLocalAgent } : {}),
    cloneRoute,
    desktopCliRoute,
    localTreeRoute,
    ...(serve === undefined ? {} : { serve }),
    ...(subjectRepo === undefined ? {} : { subjectRepo }),
    subjectEnvNames,
    hasGithubToken,
    ...(localTreeArchiveBuffer === undefined ? {} : { localTreeArchiveBuffer }),
    env,
    openaiApiKey,
    e2bApiKey,
    requestTimeoutMs,
    perLaneSandboxMs: resolvePerLaneSandboxMs(config),
    timeoutMs,
    laneCount,
    artifactRoot: runPaths,
    labCwd: options.cwd,
    redactScreenshots,
    scrubKnownValues,
    runSession,
    // The study-level ledger exists once per RUN, shared by every lane (#299). Dry runs never
    // spend, so they carry none.
    ...(dryRun || config.execution?.caps?.maxTotalUsd === undefined
      ? {}
      : { runBudget: makeCuaRunBudget(config.execution.caps.maxTotalUsd) }),
    ...(externalCommsConfig === undefined || externalCommsEmail === undefined
      ? {}
      : { externalComms: { email: externalCommsEmail, inboxUrl: externalInboxUrl(externalCommsConfig) } }),
    now: hooks.now ?? Date.now,
    hooks: liveHooks
  };

  const inProgressLaneSubjects = laneSpecs.map(() =>
    laneSubjectProjection({
      cloneRoute,
      localTreeRoute,
      ...(publicRepo === undefined ? {} : { publicRepo }),
      subjectEnvNames,
      ...(localTreeArchive === undefined ? {} : { localTreeArchive }),
      subjectState: resolveSubjectState({
        declared: provisionedRoute ? config.subject.state : undefined,
        dryRun: false,
        executed: []
      })
    })
  );
  const inProgressAggregateSubject = inProgressLaneSubjects[0]!;
  const inProgressProvenance = subjectProvenanceArg(inProgressAggregateSubject, publicRepo, subjectEnvNames);

  // A live run writes what it is doing AS IT DOES IT, whether or not anyone is currently watching.
  // This used to be gated on `options.onObserverReady` — the interactive Observer callback — so a
  // run launched by an agent (`lab run --json`), detached, or from the terminal surface recorded
  // nothing at all until it completed, and anything asking "what is this participant doing right
  // now" got silence for the whole run. Who reads the evidence is not the run's business; the
  // callback below stays conditional, the writing does not.
  if (!dryRun) {
    const inProgressBundle = laneCount === 1 && rerunLineage === undefined
      ? buildSingleLaneBundle({
          ...(options.lab === undefined ? {} : { lab: options.lab }),
          spec: laneSpecs[0]!,
          outcome: undefined,
          descriptor,
          appUrl: laneSpecs[0]!.targetUrl ?? appUrl,
          createdAt,
          dryRun: false,
          config,
          runId,
          source,
          redactScreenshots,
          inProgress: true,
          ...(inProgressProvenance === undefined ? {} : { subjectProvenance: inProgressProvenance }),
          inProcessRoute,
          localAppSubject
        })
      : buildCuaFanoutBundle({
          ...(options.lab === undefined ? {} : { lab: options.lab }),
          specs: laneSpecs,
          laneSubjects: inProgressLaneSubjects,
          aggregateSubject: inProgressAggregateSubject,
          descriptor,
          appUrl,
          createdAt,
          dryRun: false,
          config,
          runId,
          source,
          plan,
          ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
          cloneRoute,
          localTreeRoute,
          ...(publicRepo === undefined ? {} : { publicRepo }),
          subjectEnvNames,
          inProgress: true
        });
    await writeCuaRunArtifacts(inProgressBundle, createdAt, runPaths);
    liveObserver = observerResultForCuaArtifacts(cwd, runId, artifactRoot, [
      "Live CUA Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted."
    ]);
    if (options.onObserverReady) await options.onObserverReady(liveObserver);

    // Incremental live flush (#441): as each lane's loop reports its recorded-so-far items,
    // rewrite the in-progress bundle with per-stream `liveActor` partials so the attached
    // Observer's 5s poll sees the timeline grow. Throttled (one write per interval, trailing
    // write guaranteed), serialized (never two writers), and CLOSED before the final artifact
    // write so a stale flush can never resurrect the in-progress bundle. A flush failure is
    // swallowed: mid-run observability must never break the run itself.
    const streamIdByLane = new Map(laneSpecs.map((spec) => [spec.laneId, spec.streamId]));
    // The persona each lane is running, so the live flush can say who is in it.
    const personaByStream = new Map(
      laneSpecs
        .map((spec) => [spec.streamId, spec.persona?.id] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string")
    );
    const liveItemsByStream = new Map<string, ActorTraceItem[]>();
    // Running token usage per lane, so a run in flight can price itself instead of reporting the
    // cost as unknown until the moment it ends.
    const liveUsageByStream = new Map<string, ActorTokenUsage>();
    // The rate the running usage prices at. Usage without its model is not a cost, so both travel
    // together or neither does.
    const modelForLiveCost = config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL;
    let flushWriting: Promise<void> | undefined;
    let flushDirty = false;
    let flushClosed = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let lastFlushAtMs = 0;
    const FLUSH_MIN_INTERVAL_MS = 2_000;
    const flushNow = async (): Promise<void> => {
      while (flushDirty && !flushClosed) {
        flushDirty = false;
        lastFlushAtMs = Date.now();
        const updatedAt = new Date(lastFlushAtMs).toISOString();
        const patched: RunBundle = {
          ...inProgressBundle,
          streams: inProgressBundle.streams.map((stream) => {
            const liveItems = liveItemsByStream.get(stream.id);
            return liveItems === undefined
              ? stream
              : {
                  ...stream,
                  liveActor: {
                    schema: "humanish.live-actor.v1" as const,
                    updatedAt,
                    // WHO is in this lane, carried while the run is live. Without it a surface
                    // watching a live run can only name the lane, and "CUA browser — observer-live-
                    // check" is the harness talking about itself where the participant should be.
                    ...(personaByStream.get(stream.id) === undefined
                      ? {}
                      : { persona: { id: personaByStream.get(stream.id)! } }),
                    ...(liveUsageByStream.get(stream.id) === undefined
                      ? {}
                      : {
                          tokenUsage: liveUsageByStream.get(stream.id)!,
                          // The model too: usage without the rate it prices at is not a cost.
                          ids: { model: modelForLiveCost }
                        }),
                    items: [...liveItems]
                  }
                };
          })
        };
        try {
          await writeCuaRunArtifacts(patched, createdAt, runPaths);
        } catch {
          // Swallowed by design; the final write is the evidence of record.
        }
      }
      flushWriting = undefined;
    };
    const scheduleFlush = (): void => {
      if (flushClosed || flushWriting !== undefined) return;
      const sinceMs = Date.now() - lastFlushAtMs;
      if (sinceMs >= FLUSH_MIN_INTERVAL_MS) {
        flushWriting = flushNow();
        return;
      }
      if (flushTimer === undefined) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          scheduleFlush();
        }, FLUSH_MIN_INTERVAL_MS - sinceMs);
        flushTimer.unref?.();
      }
    };
    flushLiveTrace = (laneId, items, usage) => {
      // An empty snapshot (the initial observation on a frameless route) carries no
      // evidence worth a disk write; the first real item triggers the first flush.
      if (items.length === 0) return;
      const streamId = streamIdByLane.get(laneId);
      if (streamId === undefined) return;
      liveItemsByStream.set(streamId, items.slice());
      if (usage !== undefined) liveUsageByStream.set(streamId, usage);
      flushDirty = true;
      scheduleFlush();
    };
    stopLiveFlush = async () => {
      flushClosed = true;
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      await flushWriting;
    };
  }

  // Run lanes (dry-run runs none). In-process is always one lane.
  let outcomes: LaneRunOutcome[] | undefined;
  let failFastReason: string | undefined;
  if (!dryRun) {
    if (inProcessRoute) {
      outcomes = [await runInProcessLane(laneSpecs[0]!, deps)];
    } else if (laneCount === 1) {
      outcomes = [await runCuaLane(laneSpecs[0]!, deps)];
    } else {
      const ran = await runCuaLanes(laneSpecs, deps, plan.concurrency);
      outcomes = ran.outcomes;
      failFastReason = ran.failFastReason;
    }
  }
  // Close the live flush BEFORE any final artifact work: no new flush may start, and an
  // in-flight one is awaited, so the final bundle write can never race a stale in-progress
  // rewrite (which would resurrect `liveActor` after completion).
  await stopLiveFlush?.();

  const externalCommsWarnings: string[] = [];
  // Adopter-hosted drain (#380): once per RUN, after every lane finished — the catch is one
  // shared external endpoint, not a per-sandbox file. Same routing and digest-only artifact as
  // the in-sandbox drain; the artifact is registered on every lane that declared a recipient
  // address, since the thread carries each inbox's mail. A drain failure never fails the run.
  if (!dryRun && externalCommsConfig && externalCommsEmail && outcomes !== undefined) {
    try {
      const commsChannel = new FakeInbox();
      const commsInboxes: CommsAddress[] = [];
      for (const recipient of externalCommsEmail.recipients ?? []) {
        if (recipient.address !== undefined) {
          commsInboxes.push(await commsChannel.provisionAddress(recipient.lane, recipient.address));
        }
      }
      const authToken = externalCommsConfig.authTokenEnv === undefined ? undefined : env[externalCommsConfig.authTokenEnv];
      const collected = await collectExternalCommsThread({
        external: { ...externalCommsConfig, ...(authToken === undefined ? {} : { authToken }) },
        channel: commsChannel,
        inboxes: commsInboxes
      });
      if (collected.artifact) {
        const commsPath = "comms/thread.json";
        await writeContainedOutputFile(runPaths, commsPath, `${JSON.stringify(collected.artifact, null, 2)}\n`, "utf8");
        for (const [index, outcome] of outcomes.entries()) {
          const laneId = laneSpecs[index]?.laneId;
          if (laneId !== undefined && outcome.commsArtifactPath === undefined && laneHasInboxRecipient(externalCommsEmail, laneId)) {
            outcome.commsArtifactPath = commsPath;
          }
        }
      } else if (collected.captured > 0) {
        externalCommsWarnings.push(`Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`);
      } else {
        externalCommsWarnings.push(`Comms catch captured ZERO email sends — your app never delivered mail through the catch at ${externalCommsConfig.catchBaseUrl}. Verify the app's email-API base URL points at it and that the flow reached an email step.`);
      }
    } catch (error) {
      externalCommsWarnings.push(`Comms evidence collection failed against the adopter-hosted catch (run continues): ${redactText(scrubKnownValues(toErrorMessage(error)))}`);
    }
  }

  // Per-lane subject projections (invariant 5).
  const laneSubjects = laneSpecs.map((_spec, index) => {
    const outcome = outcomes?.[index];
    const subjectState = resolveSubjectState({
      declared: provisionedRoute ? config.subject.state : undefined,
      dryRun,
      executed: outcome?.stateStepRecords ?? []
    });
    return laneSubjectProjection({
      cloneRoute,
      localTreeRoute,
      ...(publicRepo === undefined ? {} : { publicRepo }),
      subjectEnvNames,
      ...(outcome?.subjectCommit === undefined ? {} : { subjectCommit: outcome.subjectCommit }),
      ...(localTreeArchive === undefined ? {} : { localTreeArchive }),
      subjectState
    });
  });

  // Aggregate subject (top-level + bundle): unanimity-gated commit (+ divergence warning) on
  // the clone route. Local-tree lanes all pack from the SAME once-per-run archive, so every
  // lane's projection already carries the identical archiveSha256/commit/dirty: the
  // `first.source !== "clone"` branch below returns it directly, with no unanimity math needed
  // (there is nothing that could diverge).
  const aggregateWarnings: string[] = [...externalCommsWarnings];
  // execution.caps.maxUsd is a PER-LANE cap: it is enforced INSIDE each lane's loop independently,
  // so an N-lane fan-out can spend up to N × maxUsd before any lane aborts, while the run cost
  // summary reports the (larger) aggregate. Warn at run level so the operator sees the true
  // ceiling — unless the study declared the shared budget (#299), which caps the run as a whole.
  const perLaneCapUsd = config.execution?.caps?.maxUsd;
  if (perLaneCapUsd !== undefined && laneCount > 1 && config.execution?.caps?.maxTotalUsd === undefined) {
    aggregateWarnings.push(
      `execution.caps.maxUsd ($${perLaneCapUsd}) is a PER-LANE cap; ${laneCount} lanes may spend up to ${laneCount} × $${perLaneCapUsd} (~$${round6(perLaneCapUsd * laneCount)} total) before any lane aborts. Set execution.caps.maxTotalUsd for a shared study budget.`
    );
  }
  const aggregateSubject = ((): CuaSubjectProjection => {
    const first = laneSubjects[0]!;
    if (first.source !== "clone") {
      return first;
    }
    const commits = (outcomes ?? []).map((outcome) => outcome.subjectCommit).filter((commit): commit is string => commit !== undefined);
    const unanimous = !dryRun && commits.length === laneCount && new Set(commits).size === 1;
    if (!dryRun && laneCount > 1 && new Set(commits).size > 1) {
      aggregateWarnings.push("Fan-out lanes resolved DIVERGENT subject commits — the top-level subject.commit is omitted; see per-lane provenance in result.lanes for each lane's pinned commit.");
    }
    // Build without commit, then add it only when unanimous (avoids an explicit commit:undefined
    // under exactOptionalPropertyTypes).
    return {
      source: "clone",
      ...(first.repo === undefined ? {} : { repo: first.repo }),
      ...(first.envNames === undefined ? {} : { envNames: first.envNames }),
      state: first.state,
      ...(unanimous && commits[0] !== undefined ? { commit: commits[0] } : {})
    };
  })();
  const finalProvenance = subjectProvenanceArg(aggregateSubject, publicRepo, subjectEnvNames);

  const bundle = laneCount === 1 && rerunLineage === undefined
    ? buildSingleLaneBundle({
        ...(options.lab === undefined ? {} : { lab: options.lab }),
        spec: laneSpecs[0]!,
        outcome: outcomes?.[0],
        descriptor,
        appUrl: laneSpecs[0]!.targetUrl ?? appUrl,
        createdAt,
        dryRun,
        config,
        runId,
        source,
        redactScreenshots,
        ...(finalProvenance === undefined ? {} : { subjectProvenance: finalProvenance }),
        inProcessRoute,
        localAppSubject
      })
    : buildCuaFanoutBundle({
        ...(options.lab === undefined ? {} : { lab: options.lab }),
        specs: laneSpecs,
        ...(outcomes === undefined ? {} : { outcomes }),
        laneSubjects,
        aggregateSubject,
        descriptor,
        appUrl,
        createdAt,
        dryRun,
        config,
        runId,
        source,
        plan,
        ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
        ...(failFastReason === undefined ? {} : { failFastReason }),
        cloneRoute,
        localTreeRoute,
        ...(publicRepo === undefined ? {} : { publicRepo }),
        subjectEnvNames
      });

  const adapterWarnings: string[] = [];
  const scorerResult = await applyBrowserAdapterHooks({
    hooks,
    bundle,
    context: {
      bundle,
      runDir: physicalArtifactRoot,
      labId: config.id,
      runId,
      actor: descriptor.id,
      backend: "cua",
      dryRun,
      laneCount
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "cuaHooks",
    ...(options.scorerProvenance === undefined ? {} : { scorerProvenance: options.scorerProvenance })
  });

  await writeCuaRunArtifacts(bundle, createdAt, runPaths);
  // Finalize the status record from the bundle that was just written, so the index can never
  // claim an outcome the evidence does not carry. A run that throws before reaching here leaves
  // its record `running` and goes stale — read as interrupted, which is the truth.
  await runStatus.finish({
    ...(bundle.review?.verdict === undefined ? {} : { verdict: bundle.review.verdict }),
    ...(bundle.review?.participants === undefined
      ? {}
      : {
          participants: {
            total: bundle.review.participants.total,
            reachedGoal: bundle.review.participants.reachedGoal,
            ...(bundle.review.participants.reportedFriction === undefined
              ? {}
              : { reportedFriction: bundle.review.participants.reportedFriction })
          }
        }),
    ...(bundle.cost?.estimatedTotalUsd === undefined ? {} : { estimatedCostUsd: bundle.cost.estimatedTotalUsd })
  });

  const observer = await render(cwd, runId, { open: options.open === true });
  if (observer.ok && runtimeStreamUrls.length > 0) {
    attachObserverRuntimeStreamUrls(observer as ObserverResult & { ok: true }, runtimeStreamUrls);
  }

  // Lane-level pass: dry-run lanes are contract-ok; live lanes need a passed, engaged session.
  const laneOk = (outcome: LaneRunOutcome | undefined): boolean => laneOutcomeOk(outcome, dryRun);
  const allLanesOk = laneSpecs.every((_, index) => laneOk(outcomes?.[index]));
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok = observer.ok && allLanesOk && adapterFailure === undefined && scorerResult.declaredVerdictFailure === undefined;

  const laneWarnings = (outcomes ?? []).flatMap((outcome) => outcome.warnings);
  const warnings = [...laneWarnings, ...aggregateWarnings, ...adapterWarnings, ...observer.warnings];

  const laneResults = laneSpecs.map((spec, index) => toLaneResult(spec, outcomes?.[index], laneSubjects[index]!, dryRun));
  const laneSummary = buildLaneSummary(outcomes, laneCount, plan, dryRun);
  const firstOutcome = outcomes?.[0];

  const errorResult = ((): CuaActorLabResult["error"] | undefined => {
    if (ok) return undefined;
    if (adapterFailure !== undefined) {
      return {
        code: "HUMANISH_CUA_LAB_FAILED",
        message: adapterFailure
      };
    }
    if (laneCount === 1) {
      const outcome = firstOutcome;
      return {
        code: outcome?.failureCode ?? "HUMANISH_CUA_LAB_FAILED",
        message: outcome?.sessionError
          ?? (outcome?.noEngagement
            ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
            // The lane result (toLaneResult) named this refusal; the N=1 envelope fell through to
            // "did not produce a terminal session", which is false — it produced one and refused it.
            : outcome?.selfReportedBlocker
            ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
            : observer.ok
              ? outcome?.session?.completionReason === "harness_error"
                ? `Computer-use session ended with a harness error: ${outcome.session.reason}`
                : outcome?.session?.status !== "passed"
                ? `Computer-use session ended with ${outcome?.session?.status ?? "unknown"}: ${outcome?.session?.reason ?? "no terminal reason"}`
                : "Computer-use lab did not produce a terminal session."
              : observer.error?.message ?? "Observer failed for the computer-use lab run.")
      };
    }
    const failingLane = (outcomes ?? []).find((outcome) => !laneOk(outcome));
    const geometryLane = (outcomes ?? []).find((outcome) => outcome.failureCode === "HUMANISH_CUA_LAB_DEVICE_GEOMETRY");
    const code: CuaActorLabErrorCode = geometryLane?.failureCode ?? "HUMANISH_CUA_LAB_FAILED";
    return {
      code,
      message: observer.ok
        ? `Fan-out run failed: ${laneSummary.passed}/${laneCount} lane(s) passed (${laneSummary.skipped} skipped, ${laneSummary.harnessErrors} harness error(s), ${laneSummary.hollow} hollow)${failingLane?.sessionError ? `; first failure: ${failingLane.sessionError}` : ""}.`
        : observer.error?.message ?? "Observer failed for the computer-use fan-out run."
    };
  })();

  return {
    schema: CUA_ACTOR_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptor.id,
    appUrl,
    dryRun,
    runId,
    ...(firstOutcome?.session
      ? {
          session: {
            status: firstOutcome.session.status,
            completionReason: firstOutcome.session.completionReason,
            reason: firstOutcome.session.reason,
            screenshots: firstOutcome.screenshots.length
          }
        }
      : {}),
    ...(firstOutcome?.sandboxId
      ? { sandbox: { sandboxId: firstOutcome.sandboxId, killed: firstOutcome.killed, streamUrlPresent: firstOutcome.streamUrlPresent } }
      : {}),
    subject: aggregateSubject,
    plan,
    lanes: laneResults,
    laneSummary,
    ...(rerunLineage === undefined ? {} : { rerun: rerunLineage }),
    observer,
    warnings,
    ...(errorResult === undefined ? {} : { error: errorResult })
  };
}

/** Aggregate lane counts for the result projection. */
function buildLaneSummary(outcomes: LaneRunOutcome[] | undefined, laneCount: number, plan: CuaLanePlan, dryRun: boolean): CuaLaneSummary {
  if (dryRun || !outcomes) {
    return {
      strategy: CUA_FANOUT_STRATEGY,
      total: laneCount,
      passed: 0,
      skipped: 0,
      harnessErrors: 0,
      hollow: 0,
      concurrency: plan.concurrency,
      waves: plan.waves
    };
  }
  let passed = 0;
  let skipped = 0;
  let harnessErrors = 0;
  let hollow = 0;
  for (const outcome of outcomes) {
    if (outcome.skippedReason !== undefined) {
      skipped += 1;
      continue;
    }
    if (outcome.harnessError) harnessErrors += 1;
    if (outcome.noEngagement) hollow += 1;
    if (laneOutcomeOk(outcome, dryRun)) passed += 1;
  }
  return {
    strategy: CUA_FANOUT_STRATEGY,
    total: laneCount,
    passed,
    skipped,
    harnessErrors,
    hollow,
    concurrency: plan.concurrency,
    waves: plan.waves
  };
}

async function writeCuaRunArtifacts(
  bundle: RunBundle,
  updatedAt: string,
  preparedRunPaths: PreparedRunArtifactPaths
): Promise<void> {
  const runPaths = await validatePreparedRunArtifactPaths(preparedRunPaths);
  const publicBundle: RunBundle = {
    ...bundle,
    cwd: PUBLIC_TARGET_CWD
  };
  await writeContainedOutputFile(runPaths, "run.json", `${JSON.stringify(publicBundle, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "review.json", `${JSON.stringify(publicBundle.review, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "review.md", renderCuaReviewMarkdown(publicBundle), "utf8");
  await writeContainedOutputFile(runPaths, "events.ndjson", `${publicBundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeContainedOutputFile(
    runPaths,
    "observer/observer-data.json",
    `${JSON.stringify(buildObserverData(publicBundle), null, 2)}\n`,
    "utf8"
  );
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId: publicBundle.runId,
      path: runPaths.relativeRunRoot,
      updatedAt
    }, null, 2)}\n`,
    "utf8"
  );
}

function observerResultForCuaArtifacts(
  cwd: string,
  runId: string,
  artifactRoot: string,
  warnings: string[] = []
): ObserverResult & { ok: true } {
  const observerPath = path.join(artifactRoot, "observer", "index.html");
  const observerDataPath = path.join(artifactRoot, "observer", "observer-data.json");
  const eventsPath = path.join(artifactRoot, "events.ndjson");
  return {
    schema: "humanish.observer-result.v1",
    ok: true,
    cwd,
    run: runId,
    observerPath: path.relative(cwd, observerPath),
    observerDataPath: path.relative(cwd, observerDataPath),
    eventsPath: path.relative(cwd, eventsPath),
    observerUrl: pathToFileURL(observerPath).href,
    bundlePath: path.join(artifactRoot, "run.json"),
    opened: false,
    warnings
  };
}

/** Build the N=1 bundle via the unchanged buildCuaBundle (byte-stable). */
function buildSingleLaneBundle(args: {
  lab?: RunLabProvenance;
  spec: CuaLaneSpec;
  outcome: LaneRunOutcome | undefined;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  createdAt: string;
  dryRun: boolean;
  config: LabConfig;
  runId: string;
  source: RunBundle["source"];
  redactScreenshots: boolean;
  subjectProvenance?: CuaSubjectProvenanceArg;
  inProcessRoute: boolean;
  localAppSubject: boolean;
  inProgress?: boolean;
}): RunBundle {
  const { spec, outcome, config } = args;
  return buildCuaBundle({
    ...(args.lab === undefined ? {} : { lab: args.lab }),
    actorId: args.descriptor.id,
    appUrl: args.appUrl,
    laneId: spec.laneId,
    ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
    ...(spec.surface === undefined ? {} : { surface: spec.surface }),
    ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
    createdAt: args.createdAt,
    dryRun: args.dryRun,
    labId: config.id,
    ...(config.title ? { labTitle: config.title } : {}),
    mission: spec.instructions,
    persona: spec.persona,
    resolution: spec.resolution,
    desktopRoute: !args.inProcessRoute,
    ...(outcome?.desktopGeometry === undefined ? {} : { desktopGeometry: outcome.desktopGeometry }),
    isMobile: spec.devicePreset.isMobile,
    runId: args.runId,
    screenshots: outcome?.screenshots ?? [],
    captureRedaction: args.redactScreenshots ? "blurred" : "raw",
    ...(outcome?.session ? { session: outcome.session } : {}),
    ...(outcome?.sessionError ? { sessionError: outcome.sessionError } : {}),
    ...(outcome === undefined
      ? {}
      : {
          credibility: {
            noEngagement: outcome.noEngagement === true,
            selfReportedBlocker: outcome.selfReportedBlocker === true,
            reportedFriction: outcome.reportedFriction === true
          }
        }),
    source: args.source,
    ...(args.inProgress === undefined ? {} : { inProgress: args.inProgress }),
    ...(args.subjectProvenance === undefined ? {} : { subjectProvenance: args.subjectProvenance }),
    ...(config.execution?.desktop?.template === undefined ? {} : { desktopTemplate: config.execution.desktop.template }),
    ...(outcome?.desktopBrowser === undefined ? {} : { desktopBrowser: outcome.desktopBrowser }),
    providerResources: providerResourcesForOutcome({
      outcome,
      createdAt: args.createdAt,
      simId: spec.simId,
      streamId: spec.streamId,
      laneId: spec.laneId
    }),
    ...(args.localAppSubject || args.inProcessRoute ? { entryKind: "local-app" as const } : {}),
    ...(outcome?.session ? { traceArtifactPath: spec.traceArtifactPath } : {}),
    ...(outcome?.commsArtifactPath === undefined ? {} : { commsArtifactPath: outcome.commsArtifactPath }),
    ...(desktopSpanToMinutes(outcome?.desktopDurationMs) === undefined
      ? {}
      : { desktopMinutes: desktopSpanToMinutes(outcome?.desktopDurationMs)! }),
    ...(outcome?.sandboxId === undefined ? {} : { desktopUsage: {
      laneId: spec.laneId,
      minutes: desktopSpanToMinutes(outcome.desktopDurationMs),
      observation: outcome.desktopResources,
      lifetimeComplete: outcome.killed
    } }),
    phaseEvents: outcome?.phaseRecords ?? []
  });
}


/**
 * Shared post-populate provisioning pipeline (clone AND local-tree routes): (install) ->
 * state(before-build) -> (build) -> state(before-start) -> detached start -> readiness probe ->
 * state(after-ready). Both provisioning routes populate SUBJECT_DIR by different means (git
 * clone vs. upload+extract) and then run this identical pipeline unchanged.
 *
 * State steps run through the same detached primitive as serve steps (author-trusted, the
 * "serve commands are author-trusted" corollary) under the reserved `subject-state-<name>`
 * label prefix, so a step name can never collide with subject-clone/subject-extract/install/
 * build/start. after-ready steps complete BEFORE the caller opens the browser: the actor never
 * drives a half-seeded subject and seeding never eats the session budget.
 */
async function runSubjectServePipeline(
  desktop: E2BDesktopSandbox,
  args: {
    serve: LabSubjectServe;
    /** Declared subject state (seed steps; external declaration is provenance-only). */
    state?: LabSubjectState;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment each state step finishes, success or failure. */
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
    /** Called at each phase boundary (started/completed): install, build, serve start, ready,
     *  and each subject.state seed-step group (one pair per group, never per step). */
    onPhase?: (event: SubjectPhaseEvent) => void;
    /** Called after every phase completes. The clone route re-resolves HEAD here; the
     *  local-tree route omits this entirely (identity is the host-side archive digest, never
     *  an in-sandbox git refresh, because the archive excludes .git). */
    onPhaseComplete?: () => Promise<void>;
  } & DetachedTimers
): Promise<void> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep })
  };
  const now = args.now ?? Date.now;
  const refresh = args.onPhaseComplete ?? ((): Promise<void> => Promise.resolve());
  const stateSteps = args.state?.seed ?? [];
  const runStateSteps = async (when: LabStateStepWhen): Promise<void> => {
    const steps = stateSteps.filter((step) => (step.when ?? "before-start") === when);
    if (steps.length === 0) {
      // No declared steps for this group: no boundary to report (avoids empty-group noise on
      // every run, since before-build/before-start/after-ready are always called).
      return;
    }
    const groupStartedAt = now();
    emitPhaseStarted(args.onPhase, now, `state.${when}`, `running subject state seed steps (${when})`);
    for (const step of steps) {
      const stepTimeoutMs = step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS;
      const startedAt = now();
      const result = await runDetachedStep(desktop, {
        name: `subject-state-${step.name}`,
        command: step.command,
        cwd: SUBJECT_DIR,
        timeoutMs: stepTimeoutMs,
        requestTimeoutMs: args.requestTimeoutMs,
        ...timers
      });
      args.onStateStep?.({
        name: step.name,
        when,
        // Digest only (sha256-16): the command text never persists: the lab YAML in the
        // consumer's repo is the plaintext source of truth.
        commandDigest: commandDigestOf(step.command),
        ok: result.ok,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.timedOut ? { timedOut: true } : {}),
        durationMs: Math.max(0, now() - startedAt)
      });
      if (!result.ok) {
        emitPhaseCompleted(args.onPhase, now, groupStartedAt, `state.${when}`, false, `subject state seed steps failed (${when})`);
        // Fail closed with the existing scrub-before-truncate tail chain: literal scrub of
        // every provisioned value PRE-truncation, then pattern redaction + cap in tailOf.
        throw new Error(`subject state step "${step.name}" ${result.timedOut ? `timed out after ${stepTimeoutMs}ms` : `failed (exit ${result.exitCode})`}: ${tailOf(args.scrub(result.logTail))}`);
      }
    }
    emitPhaseCompleted(args.onPhase, now, groupStartedAt, `state.${when}`, true, `subject state seed steps complete (${when})`);
  };

  // Provide the runtime the pipeline needs before running it (#371). The stock desktop template
  // ships python3 and curl but no Node, so an `npm install` here used to die at exit 127 after the
  // sandbox was already paid for. Probe-first, so a template that ships its own Node pays nothing.
  const serveCommands = [args.serve.install, args.serve.build, args.serve.start];
  if (needsNodeRuntime(serveCommands)) {
    const runtimeStartedAt = now();
    emitPhaseStarted(args.onPhase, now, "runtime", "providing the Node runtime the serve pipeline needs");
    const bootstrap = await runProvisioningStepWithOneRetry(desktop, {
      name: "subject-runtime-node",
      command: nodeBootstrapCommand(),
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      timers,
      retryPhase: "runtime-retry",
      retryMessage: "Node runtime bootstrap",
      onPhase: args.onPhase,
      now
    });
    let ok = bootstrap.ok;
    const corepack = ok ? corepackCommandFor(serveCommands) : undefined;
    if (corepack) {
      const pm = await runDetachedStep(desktop, {
        name: "subject-runtime-pm",
        command: corepack,
        cwd: SUBJECT_DIR,
        timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
        requestTimeoutMs: args.requestTimeoutMs,
        ...timers
      });
      ok = pm.ok;
    }
    emitPhaseCompleted(
      args.onPhase,
      now,
      runtimeStartedAt,
      "runtime",
      ok,
      ok ? "Node runtime ready" : "could not provide a Node runtime"
    );
    if (!ok) {
      throw new Error(
        `the subject's serve pipeline needs a Node runtime and this desktop template has none, and bootstrapping one failed${bootstrap.attempts === 2 ? " twice" : ""}: ${tailOf(args.scrub(bootstrap.logTail))}. Use execution.desktop.template with an image that ships Node, or change serve.install to a runtime the template provides.`
      );
    }
  }

  if (args.serve.install) {
    const installStartedAt = now();
    emitPhaseStarted(args.onPhase, now, "install", "installing subject dependencies");
    const install = await runProvisioningStepWithOneRetry(desktop, {
      name: "subject-install",
      command: args.serve.install,
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      timers,
      retryPhase: "install-retry",
      retryMessage: "subject install",
      onPhase: args.onPhase,
      now
    });
    emitPhaseCompleted(
      args.onPhase,
      now,
      installStartedAt,
      "install",
      install.ok,
      install.ok
        ? install.attempts === 2
          ? "subject dependencies installed (on the second attempt)"
          : "subject dependencies installed"
        : install.attempts === 2
          ? "subject install failed twice"
          : "subject install failed"
    );
    if (!install.ok) {
      // Lead with the line a person can act on; npm's own trace follows it (#602).
      const headline = install.timedOut
        ? `subject install timed out after ${args.serve.installTimeoutMs ?? INSTALL_TIMEOUT_MS}ms`
        : install.attempts === 2
          ? `subject install failed twice (exit ${install.firstExitCode ?? "null"}, then exit ${install.exitCode ?? "null"}); the sandbox could not complete serve.install`
          : `subject install failed (exit ${install.exitCode ?? "null"})`;
      throw new Error(`${headline}: ${tailOf(args.scrub(install.logTail))}`);
    }
    await refresh();
  }

  // before-build: after install, before build (builds that read seeded state, e.g. SSG).
  // When no build is declared this simply precedes start: equivalent to before-start.
  await runStateSteps("before-build");
  await refresh();

  if (args.serve.build) {
    const buildStartedAt = now();
    emitPhaseStarted(args.onPhase, now, "build", "building subject");
    const build = await runDetachedStep(desktop, {
      name: "subject-build",
      command: args.serve.build,
      cwd: SUBJECT_DIR,
      timeoutMs: args.serve.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      ...timers
    });
    emitPhaseCompleted(args.onPhase, now, buildStartedAt, "build", build.ok, build.ok ? "subject build complete" : "subject build failed");
    if (!build.ok) {
      throw new Error(`subject build ${build.timedOut ? "timed out" : `failed (exit ${build.exitCode})`}: ${tailOf(args.scrub(build.logTail))}`);
    }
    await refresh();
  }

  // before-start (the default phase): migrations, SQL/file fixtures, an in-sandbox DB server
  // (`sudo service postgresql start && pg_isready` is a bounded step; the daemon it forks is
  // reclaimed by the sandbox lifecycle like everything else).
  await runStateSteps("before-start");
  await refresh();

  await startDetachedProcess(desktop, {
    name: "subject-start",
    command: args.serve.start,
    cwd: SUBJECT_DIR,
    requestTimeoutMs: args.requestTimeoutMs
  });
  // Fire-and-forget: startDetachedProcess never waits for the long-lived server to exit, so
  // there is no matching completed event here (no ok/durationMs to report yet); readiness is
  // the next boundary.
  args.onPhase?.({ at: isoNow(now), type: "cua-lab.subject.serve.started", message: "subject server launched (detached)" });

  const readyStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "ready", "waiting for subject to become ready");
  const ready = await probeUrl(desktop, args.serve.url, {
    timeoutMs: args.serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers
  });
  emitPhaseCompleted(args.onPhase, now, readyStartedAt, "ready", ready, ready ? "subject is ready" : "subject did not become ready in time");
  if (!ready) {
    const startLog = await readDetachedLog(desktop, "subject-start", args.requestTimeoutMs).catch(() => "");
    throw new Error(`subject did not answer at ${args.serve.url} within ${args.serve.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms; server log tail: ${tailOf(args.scrub(startLog))}`);
  }

  // after-ready: fixture loading through the RUNNING app (loopback curl from in-sandbox:
  // steps are author-trusted provisioning, not actors, so no new URL policy surface). These
  // complete before the caller opens the browser and the session timer starts.
  await runStateSteps("after-ready");
  await refresh();
}

/**
 * Provision a clone subject inside the sandbox: clone → the shared serve pipeline
 * (install → state(before-build) → build → state(before-start) → start → readiness
 * probe → state(after-ready)). Returns the latest subject HEAD after successful
 * provisioning. Throws (with a capped log tail for the caller to redact) on any failing step:
 * the lab persists that as a failed-evidence bundle.
 *
 * Auth: when GITHUB_TOKEN is among the declared subject env names, the clone authenticates
 * via an Authorization header computed IN-SANDBOX from the provisioned env: the token never
 * appears in the script text, the process argv beyond the transient git call, the clone URL,
 * or .git/config.
 */
export async function provisionCloneSubject(
  desktop: E2BDesktopSandbox,
  args: {
    repo: string;
    depth: number;
    serve: LabSubjectServe;
    /** Declared subject state (seed steps; external declaration is provenance-only). */
    state?: LabSubjectState;
    hasGithubToken: boolean;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment the cloned commit resolves, so provenance survives later failures. */
    onCommit?: (commit: string) => void;
    /** Called the moment each state step finishes (mirrors onCommit), success or failure. */
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
    /** Called at each phase boundary (started/completed): clone, install, build, serve start,
     *  ready, and each subject.state seed-step group. */
    onPhase?: (event: SubjectPhaseEvent) => void;
  } & DetachedTimers
): Promise<string | undefined> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep })
  };
  const now = args.now ?? Date.now;
  let latestCommit: string | undefined;
  const refreshCommit = async (): Promise<void> => {
    const head = await desktop.commands.run(
      `git -C ${SUBJECT_DIR} rev-parse HEAD 2>/dev/null || true`,
      { requestTimeoutMs: args.requestTimeoutMs }
    );
    const commit = (head.stdout ?? "").trim() || undefined;
    if (commit) {
      latestCommit = commit;
      args.onCommit?.(commit);
    }
  };

  const cloneCommand = args.hasGithubToken
    ? `auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0) && git -c http.extraHeader="Authorization: Basic $auth" clone --depth ${args.depth} https://github.com/${args.repo}.git ${SUBJECT_DIR}`
    : `git clone --depth ${args.depth} https://github.com/${args.repo}.git ${SUBJECT_DIR}`;

  const cloneStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "clone", "cloning subject repository");
  const clone = await runDetachedStep(desktop, {
    name: "subject-clone",
    command: cloneCommand,
    timeoutMs: CLONE_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers
  });
  emitPhaseCompleted(args.onPhase, now, cloneStartedAt, "clone", clone.ok, clone.ok ? "subject repository cloned" : "subject clone failed");
  if (!clone.ok) {
    throw new Error(`subject clone ${clone.timedOut ? "timed out" : `failed (exit ${clone.exitCode})`}: ${tailOf(args.scrub(clone.logTail))}`);
  }

  await refreshCommit();

  await runSubjectServePipeline(desktop, {
    serve: args.serve,
    ...(args.state === undefined ? {} : { state: args.state }),
    requestTimeoutMs: args.requestTimeoutMs,
    scrub: args.scrub,
    ...(args.onStateStep === undefined ? {} : { onStateStep: args.onStateStep }),
    ...(args.onPhase === undefined ? {} : { onPhase: args.onPhase }),
    onPhaseComplete: refreshCommit,
    ...timers
  });

  return latestCommit;
}

/**
 * Provision a local-tree subject inside the sandbox: upload the once-per-run packed archive
 * (identical bytes across every fan-out lane) → extract it into SUBJECT_DIR → the
 * same shared serve pipeline provisionCloneSubject uses. Unlike the clone route there is no
 * in-sandbox git refresh: the archive excludes .git entirely (see source-archive.ts), so
 * subject identity is the host-side LocalTreeArchive captured at pack time, never anything
 * resolved in-sandbox.
 */
export async function provisionLocalTreeSubject(
  desktop: E2BDesktopSandbox,
  args: {
    /** The once-per-run packed archive bytes (shared byte-identically across every lane). */
    archiveBuffer: ArrayBuffer;
    serve: LabSubjectServe;
    /** Declared subject state (seed steps; external declaration is provenance-only). */
    state?: LabSubjectState;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    /** Called the moment each state step finishes, success or failure. */
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
    /** Called at each phase boundary (started/completed): upload, extract, install, build,
     *  serve start, ready, and each subject.state seed-step group. */
    onPhase?: (event: SubjectPhaseEvent) => void;
  } & DetachedTimers
): Promise<void> {
  const timers: DetachedTimers = {
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.sleep === undefined ? {} : { sleep: args.sleep })
  };
  const now = args.now ?? Date.now;

  const uploadStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "upload", "uploading packed local-tree archive");
  try {
    await withOneRetryOnTransientE2BError(
      () =>
        desktop.files.write(LOCAL_TREE_REMOTE_ARCHIVE_PATH, args.archiveBuffer, {
          requestTimeoutMs: args.requestTimeoutMs,
          useOctetStream: true
        }),
      {
        onRetry: (reason) => emitPhaseStarted(args.onPhase, now, "upload-retry", `local-tree archive upload retried once (${tailOf(args.scrub(reason))})`),
        ...(args.sleep === undefined ? {} : { sleep: args.sleep })
      }
    );
  } catch (error) {
    emitPhaseCompleted(args.onPhase, now, uploadStartedAt, "upload", false, "local-tree archive upload failed");
    throw new Error(`subject-upload failed: ${tailOf(args.scrub(toErrorMessage(error)))}`);
  }
  emitPhaseCompleted(args.onPhase, now, uploadStartedAt, "upload", true, "local-tree archive uploaded");

  const extractCommand = `rm -rf ${SUBJECT_DIR} && mkdir -p ${SUBJECT_DIR} && tar -xzf ${LOCAL_TREE_REMOTE_ARCHIVE_PATH} -C ${SUBJECT_DIR} && rm -f ${LOCAL_TREE_REMOTE_ARCHIVE_PATH}`;
  const extractStartedAt = now();
  emitPhaseStarted(args.onPhase, now, "extract", "extracting local-tree archive");
  const extract = await runDetachedStep(desktop, {
    name: "subject-extract",
    command: extractCommand,
    timeoutMs: CLONE_TIMEOUT_MS,
    requestTimeoutMs: args.requestTimeoutMs,
    ...timers
  });
  emitPhaseCompleted(args.onPhase, now, extractStartedAt, "extract", extract.ok, extract.ok ? "local-tree archive extracted" : "local-tree archive extraction failed");
  if (!extract.ok) {
    throw new Error(`subject extract ${extract.timedOut ? "timed out" : `failed (exit ${extract.exitCode})`}: ${tailOf(args.scrub(extract.logTail))}`);
  }

  await runSubjectServePipeline(desktop, {
    serve: args.serve,
    ...(args.state === undefined ? {} : { state: args.state }),
    requestTimeoutMs: args.requestTimeoutMs,
    scrub: args.scrub,
    ...(args.onStateStep === undefined ? {} : { onStateStep: args.onStateStep }),
    ...(args.onPhase === undefined ? {} : { onPhase: args.onPhase }),
    ...timers
  });
}

/**
 * Default local-tree packing implementation: createLocalTreeArchive(root, opts) on the host,
 * then a single read of the produced archive file into an ArrayBuffer for upload. The DI seam
 * (CuaActorLabHooks.packLocalTree) overrides this in deterministic tests so they never require
 * tar/git.
 */
export async function defaultPackLocalTree(args: {
  root: string;
  extraExclude?: string[];
  maxArchiveBytes?: number;
}): Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }> {
  const archive = createLocalTreeArchive(args.root, {
    ...(args.extraExclude === undefined ? {} : { extraExclude: args.extraExclude }),
    ...(args.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: args.maxArchiveBytes })
  });
  const bytes = await readFile(archive.archivePath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  // The archive was written to a fresh mkdtemp dir (no outputPath passed above); once the
  // bytes are buffered the on-disk copy is pure residue, and a packed working tree left in
  // the host tmpdir is itself a small leak surface. Best-effort removal.
  await rm(path.dirname(archive.archivePath), { recursive: true, force: true }).catch(() => undefined);
  return { archive, buffer };
}

/** sha256 hex of the exact command string, first 16 chars (the promptDigest convention). */
export function commandDigestOf(command: string): string {
  return digestText(command, 16);
}

/**
 * Resolve the bundle's state marker from the declaration and what actually ran.
 * Precedence: external declared → "unpinned" (seed records, if any, stay attached — a
 * migrated external DB is still unpinned overall); else seed declared → "seeded" only when
 * every declared step executed ok on a live run, otherwise "declared-not-run" (dry-run
 * contract bundles and failed live provisioning); no declaration → "undeclared".
 */
export function resolveSubjectState(args: {
  declared: LabSubjectState | undefined;
  dryRun: boolean;
  executed: RunSubjectStateStepRecord[];
}): RunSubjectProvenance["state"] {
  const declared = args.declared;
  if (!declared) {
    return { provenance: "undeclared" };
  }
  const declaredSeed = declared.seed ?? [];
  const external = declared.external ?? [];
  // Dry-run: nothing executes (no sandbox) — record the DECLARED recipe: name, phase, and
  // command digest only, with NO execution fields.
  const seed: RunSubjectStateStepRecord[] = args.dryRun
    ? declaredSeed.map((step) => ({
        name: step.name,
        when: step.when ?? "before-start",
        commandDigest: commandDigestOf(step.command)
      }))
    : args.executed;
  const allRanOk = !args.dryRun
    && declaredSeed.length > 0
    && seed.length === declaredSeed.length
    && seed.every((record) => record.ok === true);
  const provenance: RunSubjectProvenance["state"]["provenance"] = external.length > 0
    ? "unpinned"
    : declaredSeed.length === 0
      ? "undeclared"
      : allRanOk
        ? "seeded"
        : "declared-not-run";
  return {
    provenance,
    ...(seed.length > 0 ? { seed } : {}),
    ...(external.length > 0 ? { externalEnvNames: external } : {})
  };
}

/** The human-readable state story appended to the provenance event (and review.md via it). */
function describeSubjectState(state: RunSubjectProvenance["state"], dryRun: boolean): string {
  switch (state.provenance) {
    case "seeded":
      return `seeded (${state.seed?.length ?? 0} step(s): ${(state.seed ?? []).map((record) => record.name).join(", ")})`;
    case "unpinned":
      return `UNPINNED (external: ${(state.externalEnvNames ?? []).join(", ")})`;
    case "declared-not-run":
      return `declared, not run (${dryRun ? "dry-run contract" : "provisioning did not complete"})`;
    case "undeclared":
      return "undeclared";
    case "external-public":
      return "external-public (operator-declared, operator-owned public deployment; neither provisioned nor seeded)";
  }
}

// The in-sandbox `tail -c` upstream is a fundamental log-tail limit we cannot redact past.
function tailOf(log: string): string {
  return redactedTail(log, ERROR_TAIL_CHARS);
}

/**
 * Project a computer-use session into a humanish.run-bundle.v1. The load-bearing line is
 * `stream.actor = session.trace` — the provider-neutral ActorTrace seam the Observer renders.
 * Exported for the bundle-builder tests.
 */
/**
 * Assemble the run-level cost ESTIMATE from each lane's persisted per-actor estimate
 * (trace.estimatedCost, set at the lab boundary) plus each observed E2B allocation's resources/span.
 * Returns undefined (cost OMITTED) when nothing was priceable AND no sandbox ran — a pure dry-run
 * or an in-process lane (no trace.estimatedCost, no desktop) stays byte-stable with no cost block.
 * The null-discipline mirrors the terminal ledger: a present-but-unpriceable line is null + a
 * reason and contributes NOTHING to estimatedTotalUsd (never coerced to 0); an all-null summary
 * has a null total. Every non-null figure carries its ratesAsOf date + source (invariant 6).
 */
export interface CuaDesktopUsage {
  laneId?: string;
  minutes: number | undefined;
  observation: DesktopResourceObservation | undefined;
  lifetimeComplete: boolean;
}

export function buildCuaCostSummary(args: {
  lanes: Array<{ laneId?: string; trace: ActorTrace }>;
  /** Legacy library input: uses a labeled planning assumption; live routes use desktops. */
  desktopMinutes?: number | undefined;
  desktops?: CuaDesktopUsage[];
}): RunCostSummary | undefined {
  const breakdown: RunCostLine[] = [];
  let sumInput = 0;
  let sumOutput = 0;

  for (const lane of args.lanes) {
    const usage = lane.trace.tokenUsage;
    if (usage) {
      sumInput += usage.input ?? 0;
      sumOutput += usage.output ?? 0;
    }
    // An attempted closing request can fail after provider work without reporting usage.
    // Keep the known interaction estimate and make the additional unknown explicit.
    if (lane.trace.debrief?.usageReported === false) {
      breakdown.push({
        kind: "model-tokens",
        ...(lane.laneId === undefined ? {} : { laneId: lane.laneId }),
        ...(lane.trace.providerVersion === undefined ? {} : { modelId: lane.trace.providerVersion }),
        estimatedCostUsd: null,
        reason: "closing_usage_unreported",
        ratesAsOf: null
      });
    }
    const est = lane.trace.estimatedCost;
    if (!est) {
      continue;
    }
    breakdown.push({
      kind: "model-tokens",
      ...(lane.laneId === undefined ? {} : { laneId: lane.laneId }),
      ...(est.modelId === undefined ? {} : { modelId: est.modelId }),
      estimatedCostUsd: est.estimatedCostUsd,
      ...(est.reason === undefined ? {} : { reason: est.reason }),
      ratesAsOf: est.ratesAsOf,
      ...(est.source === undefined ? {} : { source: est.source }),
      ...(est.placeholder ? { placeholder: true } : {})
    });
  }

  for (const usage of args.desktops ?? []) {
    const observation = usage.observation;
    const resources = observation && "resources" in observation ? observation.resources : undefined;
    const estimate = estimateAllocatedDesktopCost(usage.minutes, resources);
    breakdown.push({
      kind: "desktop-minutes",
      ...(usage.laneId === undefined ? {} : { laneId: usage.laneId }),
      estimatedCostUsd: estimate.estimatedCostUsd,
      ...(estimate.reason === undefined ? {} : { reason: estimate.reason }),
      ratesAsOf: estimate.ratesAsOf,
      ...(estimate.source === undefined ? {} : { source: estimate.source }),
      desktop: {
        minutes: estimate.minutes,
        durationBasis: "host-acquired-to-cleanup",
        ...(resources === undefined ? {} : { resources, resourceSource: "e2b.getInfo" }),
        ...(observation && "reason" in observation ? { resourceUnavailableReason: observation.reason } : {}),
        ...(estimate.usdPerSecond === undefined ? {} : { usdPerSecond: estimate.usdPerSecond })
      }
    });
    if (!usage.lifetimeComplete) {
      breakdown.push({ kind: "desktop-minutes", ...(usage.laneId === undefined ? {} : { laneId: usage.laneId }),
        estimatedCostUsd: null, reason: "desktop_lifetime_incomplete", ratesAsOf: null });
    }
  }

  if (args.desktops === undefined && args.desktopMinutes !== undefined) {
    const desktop = estimateDesktopCost(args.desktopMinutes);
    breakdown.push({
      kind: "desktop-minutes",
      estimatedCostUsd: desktop.estimatedCostUsd,
      ...(desktop.reason === undefined ? {} : { reason: desktop.reason }),
      ratesAsOf: desktop.ratesAsOf,
      ...(desktop.source === undefined ? {} : { source: desktop.source }),
      ...(desktop.placeholder ? { placeholder: true } : {})
    });
  }

  if (breakdown.length === 0) {
    return undefined;
  }

  let knownSum = 0;
  let anyKnown = false;
  let anyNull = false;
  let placeholder = false;
  // Aggregate freshness is CONSERVATIVE: an aggregate estimate is only as current as its OLDEST
  // contributing rate, so ratesAsOf takes the MIN (oldest) asOf — MAX would overclaim freshness the
  // moment operator-edited rates in src/pricing.ts diverge. Each breakdown line keeps its own true asOf.
  let minRatesAsOf: string | null = null;
  for (const line of breakdown) {
    if (line.estimatedCostUsd === null) {
      anyNull = true;
      continue;
    }
    anyKnown = true;
    knownSum += line.estimatedCostUsd;
    if (line.placeholder) placeholder = true;
    if (line.ratesAsOf !== null && (minRatesAsOf === null || line.ratesAsOf < minRatesAsOf)) {
      minRatesAsOf = line.ratesAsOf;
    }
  }
  const estimatedTotalUsd = anyKnown ? round6(knownSum) : null;
  const estimateNote = estimatedTotalUsd === null
    ? `No priced spend lines this run — every cost line is DECLARED ABSENT (unknown rate / no usage / no duration); nothing is guessed. Add a rate to src/pricing.ts to estimate this model.`
    : `Estimated ${estimatedTotalUsd} USD total${anyNull ? " (LOWER BOUND — some lines unmeasured/unpriced)" : ""}${placeholder ? "; includes PLACEHOLDER rate(s) — confirm before trusting the magnitude" : ""}. Every figure is an ESTIMATE (rates as of ${minRatesAsOf} — the OLDEST contributing rate, since an aggregate is only as fresh as its stalest input), a rate-table multiply, NOT an authoritative provider charge.`;
  const note = estimateNote + ((args.desktops?.length ?? 0) > 0
    ? " Desktop compute uses observed CPU/RAM and a host-acquired-to-cleanup span; pre-handle startup, plan fees, credits, and negotiated pricing are excluded."
    : "");

  return {
    schema: "humanish.run-cost-summary.v1",
    currency: "usd",
    estimatedTotalUsd,
    ratesAsOf: minRatesAsOf,
    fullyEstimated: !anyNull,
    placeholder,
    breakdown,
    tokenUsage: { input: sumInput, output: sumOutput, total: sumInput + sumOutput },
    desktopMinutes: args.desktops === undefined ? args.desktopMinutes ?? null
      : args.desktops.some(usage => usage.minutes !== undefined)
        ? round6(args.desktops.reduce((sum, usage) => sum + (usage.minutes ?? 0), 0)) : null,
    note
  };
}

// Convert a host-side desktop span (ms) into billed minutes, or undefined when no sandbox ran.
function desktopSpanToMinutes(desktopDurationMs: number | undefined): number | undefined {
  return desktopDurationMs === undefined ? undefined : desktopDurationMs / 60_000;
}

/**
 * Feedback candidates derived from what LIVE participants actually reported (#392).
 *
 * A live run's feedback draft used to fall through to a dry-run template, because no browser route
 * ever built a candidate. The candidate worth filing is the one the study produced: a participant
 * who reported friction on the way (the most valuable thing a run captures), or one who stopped
 * trying. A clean pass files nothing here — feedback exists to carry findings, and a run without
 * any falls back to an honest live summary in the draft layer instead of a template.
 *
 * Everything quoted is already scrub+redacted — participant messages and `session.reason` pass
 * through redactNarration in the loop — and passes redactText again here as defense-in-depth.
 */
export function participantFeedbackCandidates(args: {
  runId: string;
  scenarioId: string;
  adapterId: string;
  /** The already-redacted study goal (what bundle.scenario.goal carries). */
  goal: string;
  substrate: RunFeedbackCandidate["substrate"];
  lanes: Array<{
    laneId: string;
    streamId: string;
    personaId: string;
    session?: CuaLoopResult;
    traceArtifactPath?: string;
    screenshots: string[];
    commsArtifactPath?: string;
  }>;
}): RunFeedbackCandidate[] {
  const candidates: RunFeedbackCandidate[] = [];
  for (const lane of args.lanes) {
    const session = lane.session;
    if (session === undefined) continue;
    const friction = resolveSelfReportedFriction(session);
    const abandoned = session.status === "abandoned";
    if (friction === undefined && !abandoned) continue;
    const summary = friction !== undefined
      ? `Participant ${lane.personaId} (${lane.laneId}) reported friction on the way through the study goal`
      : `Participant ${lane.personaId} (${lane.laneId}) stopped before completing the study goal`;
    const lastScreenshot = lane.screenshots[lane.screenshots.length - 1];
    candidates.push({
      schema: "humanish.feedback-candidate.v1",
      id: `participant-report-${lane.laneId}`,
      run_id: args.runId,
      stream_id: lane.streamId,
      adapter_id: args.adapterId,
      scenario_id: args.scenarioId,
      persona_id: lane.personaId,
      actor: "computer-use",
      substrate: args.substrate,
      // The participant is reporting on the PRODUCT: friction and abandonment are target-app
      // findings by the three-roles rule. A harness failure never reaches this builder — it is
      // not a participant report.
      failure_owner: "target-app",
      summary,
      expected: args.goal,
      actual: redactText(friction ?? session.reason),
      evidence: [
        ...(lane.traceArtifactPath === undefined ? [] : [{
          path: lane.traceArtifactPath,
          kind: "trace" as const,
          note: "Full actor trace: turns, actions, and the participant's own report."
        }]),
        ...(lastScreenshot === undefined ? [] : [{
          path: lastScreenshot,
          kind: "screenshot" as const,
          note: "Final screenshot at the moment the session ended."
        }]),
        ...(lane.commsArtifactPath === undefined ? [] : [{
          path: lane.commsArtifactPath,
          kind: "log" as const,
          note: "Digest-only comms thread captured in-sandbox."
        }])
      ],
      redaction: {
        status: "passed",
        notes: "Quoted participant text passed the loop's known-value scrub and pattern redaction before persisting, and redactText again here."
      },
      idempotency_key: `humanish:${args.runId}:${lane.laneId}:participant-report`,
      proposed_next_state: "study-quality-review",
      acceptance_proof: [
        `pnpm humanish -- verify --run ${args.runId} --json`,
        `pnpm humanish -- watch --run ${args.runId} --no-open`
      ]
    });
  }
  return candidates;
}

export function buildCuaBundle(args: {
  /** Lab provenance for the bundle's own `lab` field (#455). */
  lab?: RunLabProvenance;
  actorId: string;
  appUrl: string;
  laneId?: string;
  actorType?: string;
  surface?: string;
  caseGroup?: string;
  createdAt: string;
  dryRun: boolean;
  labId: string;
  labTitle?: string;
  mission: string;
  persona: ActorPersonaRef;
  resolution: [number, number];
  /** False only for the custom in-process route, which has no hosted screen/window to claim. */
  desktopRoute?: boolean;
  /** Runtime screen/window/viewport evidence. `viewport` inside this object must be measured. */
  desktopGeometry?: RunDesktopGeometry;
  /** Device-preset touch metadata echoed on the measured stream viewport (a prompt signal on
   *  this route, never a rendered claim); the measured width/height/DPR stay authoritative. */
  isMobile?: boolean;
  runId: string;
  screenshots: string[];
  /** Relative run-dir path of the digest-only comms-thread evidence artifact (humanish.comms-thread.v1),
   *  when a comms lab captured mail; registered as a "log" stream artifact. */
  commsArtifactPath?: string;
  /**
   * Capture-time screenshot policy ("blurred" when policies.redactScreenshots, else "raw").
   * When a session ran, its trace's `redaction.screenshots` is the evidence-of-record and
   * wins; this fallback keeps labels honest for frames written before a mid-session failure
   * (no trace exists to testify then). Defaults to "raw" — the engine default.
   */
  captureRedaction?: "raw" | "blurred";
  session?: CuaLoopResult;
  sessionError?: string;
  /**
   * The lane's own credibility read of a goal_satisfied session (#476). The actor's status is
   * evidence of what it CLAIMED; whether the harness counts the claim is decided by the lane
   * (zero engagement, a final message that describes a blocker). The review has to say the same
   * thing the lane's exit code says, or the durable bundle reports a participant reaching the
   * goal on a run the harness refused to count.
   */
  credibility?: { noEngagement: boolean; selfReportedBlocker: boolean; reportedFriction: boolean };
  source: RunBundle["source"];
  /** Provisioned-route provenance (clone or local-tree): what the actor actually drove (names
   * + digests only, never values or command text), including the subject's state story. */
  subjectProvenance?: CuaSubjectProvenanceArg;
  /**
   * Entry kind for the non-clone subject.declared event (invariant 5 — declare what the subject
   * WAS). "local-app": an already-running LOCAL dev server driven in-process, un-pinnable —
   * declared honestly as caller-provisioned/unpinned with no E2B. Absent: a plain app-url entry.
   */
  entryKind?: "local-app";
  /** The custom E2B desktop template (image) this lane launched on, when configured (provenance). */
  desktopTemplate?: string;
  /** The configured browser choice and the command that opened, when explicitly configured. */
  desktopBrowser?: DesktopBrowserEvidence;
  traceArtifactPath?: string;
  providerResources?: RunProviderResource[];
  inProgress?: boolean;
  /** Completed subject-phase records (clone/upload/extract/install/build/ready/state groups)
   *  to fold into bundle.events, so run.json carries real phase timing after the fact. */
  phaseEvents?: SubjectPhaseEvent[];
  /** Host-side E2B desktop billed span for this lane, in minutes (from LaneRunOutcome
   *  desktopDurationMs). Absent when no sandbox ran (in-process/dry-run) → no desktop cost line. */
  desktopMinutes?: number;
  desktopUsage?: CuaDesktopUsage;
}): RunBundle {
  const publicAppUrl = publicSafeAppUrlLabel(args.appUrl);
  // Run-level cost ESTIMATE (advisory; omitted when nothing was priced and no sandbox ran).
  const cost = buildCuaCostSummary({
    lanes: args.session ? [{ ...(args.laneId === undefined ? {} : { laneId: args.laneId }), trace: args.session.trace }] : [],
    desktopMinutes: args.desktopMinutes,
    ...(args.desktopUsage === undefined ? {} : { desktops: [args.desktopUsage] })
  });
  const status: RunSimulationStatus = args.inProgress === true
    ? "running"
    : args.session
    ? args.session.status
    : args.sessionError
      ? "failed"
      : "contract_proof_only";
  const reason = args.inProgress === true
    ? "Live computer-use session is running; stream auth URL is available only through the attached Observer server."
    : args.session?.reason
    ?? args.sessionError
    ?? "Contract bundle only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.";
  const lastScreenshot = args.screenshots[args.screenshots.length - 1];
  const desktopGeometry = args.desktopRoute === false
    ? undefined
    : args.desktopGeometry ?? {
        screen: { requested: { width: args.resolution[0], height: args.resolution[1] } }
      };

  // Honest labels (invariant 6: claims match mechanism): every screenshot label names the
  // run's ACTUAL mode. The session trace is the evidence-of-record; the capture policy covers
  // frames written before a mid-session failure produced a trace.
  const traceScreenshotMode = args.session?.trace.redaction.screenshots;
  const screenshotMode: "raw" | "blurred" =
    traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
      ? traceScreenshotMode
      : args.captureRedaction ?? "raw";

  const simulation: RunSimulation = {
    id: "sim-001",
    index: 1,
    personaId: args.persona.id,
    scenarioId: `cua-${args.labId}`,
    status,
    streamKind: "browser",
    mode: "browser-sim",
    progress: args.inProgress === true ? 20 : 100,
    currentStep: reason,
    summary: args.session
      ? `Computer-use actor (${args.actorId}) drove the subject app in a hosted desktop browser; ${args.session.completionReason}.`
      : args.inProgress === true
        ? `Computer-use actor (${args.actorId}) is driving the subject app in a hosted desktop browser.`
      : args.sessionError
        ? `Computer-use lab failed before a terminal session verdict: ${args.sessionError}`
        : `Contract lane for the computer-use actor (${args.actorId}) against ${publicAppUrl}.`,
    streamIds: ["stream-001"],
    startedAt: args.createdAt,
    updatedAt: args.createdAt
  };

  const stream: RunStream = {
    id: "stream-001",
    simId: "sim-001",
    laneId: args.laneId ?? "lane-01",
    ...(args.actorType === undefined ? {} : { actorType: args.actorType }),
    ...(args.surface === undefined ? {} : { surface: args.surface }),
    ...(args.caseGroup === undefined ? {} : { caseGroup: args.caseGroup }),
    kind: "browser",
    label: `CUA browser — ${args.labId}`,
    status,
    transport: "snapshot",
    updatedAt: args.createdAt,
    embed: lastScreenshot
      ? { kind: "screenshot", url: lastScreenshot, title: `CUA desktop (${screenshotMode})` }
      : { kind: "placeholder", title: "CUA desktop" },
    ...(desktopGeometry?.viewport === undefined
      ? {}
      : {
          viewport: {
            width: desktopGeometry.viewport.width,
            height: desktopGeometry.viewport.height,
            deviceScaleFactor: desktopGeometry.viewport.deviceScaleFactor,
            ...(args.isMobile === undefined ? {} : { isMobile: args.isMobile })
          }
        }),
    ...(desktopGeometry === undefined ? {} : { desktopGeometry }),
    ui: {
      route: publicAppUrl,
      intent: "Watch the computer-use actor drive the subject app in a hosted desktop browser.",
      state: reason,
      ...(args.session ? { actorStatus: args.session.status } : {}),
      ...(lastScreenshot ? { screenshotUrl: lastScreenshot } : {})
    },
    // The seam this lab exists to fill: the provider-neutral actor evidence projection.
    ...(args.session ? { actor: args.session.trace } : {}),
    artifacts: [
      { label: "run bundle", path: "run.json", kind: "bundle" as const },
      { label: "review", path: "review.md", kind: "review" as const },
      { label: "events", path: "events.ndjson", kind: "events" as const },
      ...(args.traceArtifactPath
        ? [{ label: "actor trace", path: args.traceArtifactPath, kind: "trace" as const }]
        : []),
      ...(args.commsArtifactPath
        ? [{ label: "comms thread", path: args.commsArtifactPath, kind: "log" as const }]
        : []),
      ...args.screenshots.map((screenshot, index) => ({
        label: `screenshot ${String(index + 1).padStart(2, "0")} (${screenshotMode})`,
        path: screenshot,
        kind: "screenshot" as const
      }))
    ]
  };

  const events: RunEvent[] = [
    {
      id: "event-000-created",
      at: args.createdAt,
      level: "info",
      type: "cua-lab.run.created",
      message: `Created computer-use lab run for ${args.labId} (actor ${args.actorId}).`
    },
    args.subjectProvenance
      ? {
          id: "event-001-subject",
          at: args.createdAt,
          level: "info" as const,
          type: "cua-lab.subject.provenance",
          // HONEST WORDING: claim "cloned/packed and served" only when it actually happened.
          message: `${subjectProvenanceMessage(args.subjectProvenance, publicAppUrl, args.dryRun, args.session !== undefined)} (subject env names: ${args.subjectProvenance.envNames.length > 0 ? args.subjectProvenance.envNames.join(", ") : "none"}; values never persisted); state: ${describeSubjectState(args.subjectProvenance.state, args.dryRun)}.`,
          simId: "sim-001",
          streamId: "stream-001"
        }
      : {
          id: "event-001-subject",
          at: args.createdAt,
          level: "info" as const,
          type: "cua-lab.subject.declared",
          // Invariant 5: declare what the subject WAS, including the ABSENCE of a pin. A
          // local-app / in-process subject is an already-running LOCAL dev server the caller
          // provisioned; it cannot be commit-pinned, so its provenance is honestly UNPINNED and
          // no E2B desktop was created. A plain app-url entry runs inside the desktop sandbox.
          message: args.entryKind === "local-app"
            ? `Subject app declared at ${publicAppUrl} (already-running LOCAL dev server driven in-process; NO clone, NO E2B desktop). Provenance: caller-provisioned and UNPINNED — a running dev server cannot be commit-pinned.`
            : `Subject app declared at ${publicAppUrl} (loopback inside the desktop sandbox).`,
          simId: "sim-001",
          streamId: "stream-001"
        },
    args.session
      ? {
          id: "event-002-session",
          at: args.createdAt,
          level: args.session.status === "passed" ? "info" : "warn",
          type: `cua-lab.session.${args.session.completionReason}`,
          message: `${args.session.status}: ${args.session.reason}`,
          simId: "sim-001",
          streamId: "stream-001"
        }
      : args.inProgress === true
        ? {
            id: "event-002-running",
            at: args.createdAt,
            level: "info" as const,
            type: "cua-lab.session.running",
            message: "Live computer-use session is running; terminal evidence has not been written yet.",
            simId: "sim-001",
            streamId: "stream-001"
          }
      : args.sessionError
        ? {
            id: "event-002-session",
            at: args.createdAt,
            level: "error" as const,
            type: "cua-lab.session.error",
            message: args.sessionError,
            simId: "sim-001",
            streamId: "stream-001"
          }
        : {
            id: "event-002-contract",
            at: args.createdAt,
            level: "info" as const,
            type: "cua-lab.contract.ready",
            message: "Dry-run contract bundle ready; switch scenario.mode to live for a real desktop session.",
            simId: "sim-001",
            streamId: "stream-001"
          }
  ];

  // Persisted phase trail (real boot timing, not just a coarse provenance sentence): one
  // RunEvent per COMPLETED phase boundary (started events never persist here; they carry no
  // durationMs). ok:false phases warn rather than error, since the failing phase's own thrown
  // error already becomes the terminal cua-lab.session.error event above.
  let phaseEventSeq = 3;
  for (const phase of args.phaseEvents ?? []) {
    events.push({
      id: `event-${String(phaseEventSeq++).padStart(3, "0")}-phase-${phaseEventIdSuffix(phase.type)}`,
      at: phase.at,
      level: phase.ok === false ? "warn" : "info",
      type: phase.type,
      message: phase.durationMs === undefined ? phase.message : `${phase.message} (${phase.durationMs}ms)`,
      simId: "sim-001",
      streamId: "stream-001"
    });
  }
  for (const warning of desktopGeometry?.warnings ?? []) {
    events.push({
      id: `event-${String(phaseEventSeq++).padStart(3, "0")}-geometry-warning`,
      at: args.createdAt,
      level: "warn",
      type: "cua-lab.geometry.warning",
      message: warning,
      simId: "sim-001",
      streamId: "stream-001"
    });
  }

  // A funnel with a denominator of one is still the funnel — and its absence stays honest: no
  // declared protocol (or a dry run) means no `tasks` field, never an empty one.
  const singleStudyTasks = args.inProgress !== true && args.session?.trace.taskFunnel !== undefined
    ? aggregateTaskFunnels([args.session.trace.taskFunnel])
    : undefined;
  // What happened to the participant, as the LANE judged it — the same rule the fan-out roll-up
  // applies (participantStatusForOutcome). Before #476 this read the actor's own status, so a
  // run the lane refused as "not a credible pass" was written up as verdict pass, 1/1 reached
  // the goal, and every projection of the bundle (Observer tally, `runs`, the status index)
  // repeated it. Found on a real drawDB run whose participant wrote "Blocked after partial
  // completion".
  const participantStatus: ActorStatus | undefined = args.session === undefined
    ? undefined
    : participantStatusForCredibility(args.session.status, args.credibility);
  const credibilityNote = args.session === undefined || participantStatus === args.session.status
    ? undefined
    : args.credibility?.noEngagement === true
      ? "Not counted as a pass: the participant took no actions and said nothing."
      : "Not counted as a pass: the participant's final message described a blocker.";
  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict: args.inProgress === true
      ? "contract_proof_only"
      : participantStatus !== undefined
        ? verdictForStatus(participantStatus)
        : args.sessionError
          ? "fail"
          : "contract_proof_only",
    // One lane is still a study with a denominator of one, and saying so keeps a single-lane
    // result from being read as though it generalized.
    ...(participantStatus !== undefined && args.inProgress !== true
      ? { participants: tallyParticipantOutcomes([participantStatus], [args.credibility?.reportedFriction === true]) }
      : {}),
    ...(singleStudyTasks === undefined ? {} : { tasks: singleStudyTasks }),
    summary: credibilityNote === undefined ? reason : `${credibilityNote} ${reason}`,
    gaps: args.session || args.sessionError
      ? []
      : args.inProgress === true
        ? ["Live desktop session is still running."]
        : ["Live desktop session not yet run (dry-run contract only)."]
  };

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: 1,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".humanish", "runs", args.runId),
    ...(args.lab === undefined ? {} : { lab: args.lab }),
    source: args.source,
    persona: {
      id: args.persona.id,
      name: `Computer-use operator (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    scenario: {
      id: `cua-${args.labId}`,
      title: args.labTitle ?? `Computer-use lab: ${args.labId}`,
      goal: redactText(args.mission),
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "cua-lab.run.created",
        message: `Created computer-use lab run with one desktop browser lane (actor ${args.actorId}).`
      }
    ],
    simulations: [simulation],
    streams: [stream],
    events,
    redaction: {
      status: "passed",
      notes: traceScreenshotMode === "raw"
        ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are FULL-FIDELITY (raw), retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle."
        : traceScreenshotMode === "blurred"
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle."
          : args.screenshots.length > 0
            ? `Session ended before a trace was recorded; ${args.screenshots.length} already-written frame(s) follow the capture policy (${screenshotMode}). Typed text is recorded as length only and reasoning/messages pass through text redaction.`
            : "No screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    // What the participant reported, when it reported anything (#392). Dry-run and in-progress
    // bundles carry none — there is no participant yet to quote.
    feedbackCandidates: args.dryRun || args.inProgress === true
      ? []
      : participantFeedbackCandidates({
          runId: args.runId,
          scenarioId: `cua-${args.labId}`,
          adapterId: args.labId,
          goal: redactText(args.mission),
          substrate: args.desktopRoute === false ? "local-filesystem" : "e2b-desktop",
          lanes: [{
            laneId: args.laneId ?? "lane-01",
            streamId: "stream-001",
            personaId: args.persona.id,
            ...(args.session === undefined ? {} : { session: args.session }),
            ...(args.traceArtifactPath === undefined ? {} : { traceArtifactPath: args.traceArtifactPath }),
            screenshots: args.screenshots,
            ...(args.commsArtifactPath === undefined ? {} : { commsArtifactPath: args.commsArtifactPath })
          }]
        }),
    // Custom desktop image provenance (omitted on the stock-template default → byte-stable).
    ...(args.desktopTemplate === undefined ? {} : { desktopTemplate: args.desktopTemplate }),
    ...(args.desktopBrowser === undefined ? {} : { desktopBrowser: args.desktopBrowser }),
    ...(args.providerResources === undefined || args.providerResources.length === 0 ? {} : { providerResources: args.providerResources }),
    // Structured subject provenance (invariant 5): code pin + state story. Uniform and
    // honest on app-url bundles too — the caller minted the URL, its state is the caller's.
    // CuaSubjectProvenanceArg's two variants (clone, local-tree) are already RunSubjectProvenance-
    // shaped, so no reconstruction is needed beyond the app-url fallback.
    subject: args.subjectProvenance ?? { source: "app-url", state: { provenance: "undeclared" } },
    ...(cost === undefined ? {} : { cost })
  };
}

/** Human-readable provenance line for the single-lane subject.provenance event (invariant 5):
 *  claims "cloned/packed and served" ONLY when it actually happened. */
function subjectProvenanceMessage(
  provenance: CuaSubjectProvenanceArg,
  publicAppUrl: string,
  dryRun: boolean,
  hasSession: boolean
): string {
  if (provenance.source === "clone") {
    if (dryRun) {
      return `Subject declared: clone of ${provenance.repo}, to be served at ${publicAppUrl} in-sandbox (dry-run contract; nothing cloned)`;
    }
    if (provenance.commit) {
      return hasSession
        ? `Subject cloned from ${provenance.repo}@${provenance.commit} and served at ${publicAppUrl} in-sandbox`
        : `Subject cloned from ${provenance.repo}@${provenance.commit}; serving at ${publicAppUrl} did not complete (see session error)`;
    }
    return `Subject clone attempted from ${provenance.repo}; commit unresolved (provisioning failed before resolution)`;
  }
  if (dryRun) {
    return `Subject declared: local working tree, to be packed and served at ${publicAppUrl} in-sandbox (dry-run contract; nothing packed)`;
  }
  if (provenance.archiveSha256) {
    const dirtyLabel = provenance.dirty === true ? ", dirty working tree" : provenance.dirty === false ? ", clean working tree" : "";
    return hasSession
      ? `Subject packed (archiveSha256 ${provenance.archiveSha256}${dirtyLabel}) and served at ${publicAppUrl} in-sandbox`
      : `Subject packed (archiveSha256 ${provenance.archiveSha256}${dirtyLabel}); serving at ${publicAppUrl} did not complete (see session error)`;
  }
  return "Subject local-tree packing attempted; archive digest unresolved (provisioning failed before resolution)";
}

/**
 * Project N>1 fan-out lanes into a humanish.run-bundle.v1 (the evidence schema is unchanged; this
 * is a new producer for the multi-stream shape). One sim + one stream per lane; per-lane
 * provenance/session events; a recorded `cua-lab.fanout.plan` event (and a `cua-lab.fanout.fail-fast`
 * event when a harness error skipped queued lanes). N-ary verify/Observer already handle multiple
 * streams. The N=1 path NEVER reaches here (buildCuaBundle owns it, byte-stable).
 */
export function buildCuaFanoutBundle(args: {
  /** Lab provenance for the bundle's own `lab` field (#455). */
  lab?: RunLabProvenance;
  specs: CuaLaneSpec[];
  outcomes?: LaneRunOutcome[];
  laneSubjects: CuaSubjectProjection[];
  aggregateSubject: CuaSubjectProjection;
  descriptor: CuaActorDescriptor;
  appUrl: string;
  createdAt: string;
  dryRun: boolean;
  config: LabConfig;
  runId: string;
  source: RunBundle["source"];
  plan: CuaLanePlan;
  rerun?: RunRerunLineage;
  failFastReason?: string;
  cloneRoute: boolean;
  localTreeRoute?: boolean;
  publicRepo?: string;
  subjectEnvNames: string[];
  inProgress?: boolean;
}): RunBundle {
  const { specs, outcomes, config } = args;
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [];

  events.push({
    id: "event-000-created",
    at: args.createdAt,
    level: "info",
    type: "cua-lab.run.created",
    message: `Created computer-use fan-out run for ${config.id} (actor ${args.descriptor.id}, ${specs.length} lanes, per-lane worlds).`
  });
  events.push({
    id: "event-001-fanout-plan",
    at: args.createdAt,
    level: "info",
    type: "cua-lab.fanout.plan",
    message: `Fan-out plan: ${args.plan.laneCount} lane(s) (${args.plan.strategy}), concurrency ${args.plan.concurrency}, ${args.plan.waves} wave(s); per-lane session budget ${Math.round(args.plan.perLaneSessionBudgetMs / 1000)}s; worst-case ~${args.plan.worstCaseSandboxMinutes} sandbox-minutes${args.dryRun ? " (dry-run: $0)" : ""}. Lanes: ${args.plan.lanes.map(formatLanePlanEntry).join(", ")}.`
  });

  let eventSeq = 2;
  const nextEventId = (suffix: string): string => `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  if (args.rerun) {
    events.push({
      id: nextEventId("fanout-rerun"),
      at: args.createdAt,
      level: "info",
      type: "cua-lab.fanout.rerun",
      message: `Rerun selected ${args.rerun.selectedLaneIds.length} lane(s) from ${args.rerun.sourceRunId}: ${args.rerun.previous.map((lane) => `${lane.laneId} was ${lane.status}${lane.completionReason ? `/${lane.completionReason}` : ""}`).join(", ")}. This is a new linked run; the source run verdict is unchanged.`
    });
  }

  specs.forEach((spec, index) => {
    const outcome = outcomes?.[index];
    const laneAppUrl = spec.targetUrl ?? args.appUrl;
    const publicLaneAppUrl = publicSafeAppUrlLabel(laneAppUrl);
    const subject = args.laneSubjects[index]!;
    const session = outcome?.session;
    const fallbackDeclared = declaredScreenForRender(spec.devicePreset, spec.deviceName, spec.resolution);
    const desktopGeometry: RunDesktopGeometry = outcome?.desktopGeometry ?? {
      screen: {
        requested: { width: spec.resolution[0], height: spec.resolution[1] },
        ...(fallbackDeclared ? { declared: fallbackDeclared } : {})
      }
    };
    const screenshots = outcome?.screenshots ?? [];
    const lastScreenshot = screenshots[screenshots.length - 1];
    const status: RunSimulationStatus = args.inProgress === true && outcome === undefined
      ? "running"
      : outcome?.skippedReason !== undefined
      ? "blocked"
      : session
        ? session.status
        : outcome?.sessionError
          ? "failed"
          : "contract_proof_only";
    const reason = args.inProgress === true && outcome === undefined
      ? "Live computer-use lane is running; stream auth URL is available only through the attached Observer server."
      : outcome?.skippedReason
      ?? session?.reason
      ?? outcome?.sessionError
      ?? "Contract bundle only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.";

    const traceScreenshotMode = session?.trace.redaction.screenshots;
    const screenshotMode: "raw" | "blurred" =
      traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
        ? traceScreenshotMode
        : config.policies?.redactScreenshots === true ? "blurred" : "raw";

    simulations.push({
      id: spec.simId,
      index: index + 1,
      personaId: spec.persona.id,
      scenarioId: `cua-${config.id}`,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: args.inProgress === true && outcome === undefined ? 20 : 100,
      currentStep: reason,
      summary: session
        ? `Lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}): computer-use actor (${args.descriptor.id}) drove the subject app; ${session.completionReason}.`
        : args.inProgress === true && outcome === undefined
          ? `Lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}): computer-use actor (${args.descriptor.id}) is driving the subject app.`
        : outcome?.skippedReason !== undefined
          ? `Lane ${spec.laneId} ${outcome.skippedReason}.`
          : outcome?.sessionError
            ? `Lane ${spec.laneId} failed before a terminal session verdict: ${outcome.sessionError}`
            : `Contract lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}) for ${args.descriptor.id} against ${publicLaneAppUrl}.`,
      streamIds: [spec.streamId],
      startedAt: args.createdAt,
      updatedAt: args.createdAt
    });

    streams.push({
      id: spec.streamId,
      simId: spec.simId,
      laneId: spec.laneId,
      ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
      ...(spec.surface === undefined ? {} : { surface: spec.surface }),
      ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
      kind: "browser",
      label: `CUA lane ${spec.laneId} — ${config.id}`,
      status,
      transport: "snapshot",
      updatedAt: args.createdAt,
      embed: lastScreenshot
        ? { kind: "screenshot", url: lastScreenshot, title: `CUA desktop ${spec.laneId} (${screenshotMode})` }
        : { kind: "placeholder", title: `CUA desktop ${spec.laneId}` },
      ...(desktopGeometry.viewport === undefined
        ? {}
        : {
            viewport: {
              width: desktopGeometry.viewport.width,
              height: desktopGeometry.viewport.height,
              deviceScaleFactor: desktopGeometry.viewport.deviceScaleFactor,
              isMobile: spec.devicePreset.isMobile
            }
          }),
      desktopGeometry,
      ui: {
        route: publicLaneAppUrl,
        intent: `Watch lane ${spec.laneId} (${spec.persona.id}/${spec.deviceName}) drive the subject app in its own hosted desktop.`,
        state: reason,
        ...(session ? { actorStatus: session.status } : {}),
        ...(lastScreenshot ? { screenshotUrl: lastScreenshot } : {})
      },
      ...(session ? { actor: session.trace } : {}),
      artifacts: [
        { label: "run bundle", path: "run.json", kind: "bundle" as const },
        { label: "review", path: "review.md", kind: "review" as const },
        { label: "events", path: "events.ndjson", kind: "events" as const },
        ...(session
          ? [{ label: `lane ${spec.laneId} actor trace`, path: spec.traceArtifactPath, kind: "trace" as const }]
          : []),
        ...(outcome?.commsArtifactPath
          ? [{ label: `lane ${spec.laneId} comms thread`, path: outcome.commsArtifactPath, kind: "log" as const }]
          : []),
        ...screenshots.map((screenshot, screenshotIndex) => ({
          label: `lane ${spec.laneId} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
          path: screenshot,
          kind: "screenshot" as const
        }))
      ]
    });

    // Per-lane subject provenance (invariant 5).
    if (args.cloneRoute && args.publicRepo) {
      events.push({
        id: nextEventId(`subject-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.subject.provenance",
        message: `Lane ${spec.laneId}: ${args.dryRun
          ? `subject declared — clone of ${args.publicRepo}, served at ${publicLaneAppUrl} in-sandbox (dry-run contract; nothing cloned)`
          : subject.commit
            ? session
              ? `subject cloned from ${args.publicRepo}@${subject.commit} and served at ${publicLaneAppUrl} in-sandbox`
              : `subject cloned from ${args.publicRepo}@${subject.commit}; serving did not complete (see session error)`
            : `subject clone attempted from ${args.publicRepo}; commit unresolved`
        } (subject env names: ${args.subjectEnvNames.length > 0 ? args.subjectEnvNames.join(", ") : "none"}; values never persisted); state: ${describeSubjectState(subject.state, args.dryRun)}.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (subject.source === "local-tree") {
      events.push({
        id: nextEventId(`subject-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.subject.provenance",
        message: `Lane ${spec.laneId}: ${args.dryRun
          ? `subject declared: local working tree, to be packed and served at ${publicLaneAppUrl} in-sandbox (dry-run contract; nothing packed)`
          : subject.archiveSha256
            ? session
              ? `subject packed (archiveSha256 ${subject.archiveSha256}${subject.dirty === true ? ", dirty working tree" : subject.dirty === false ? ", clean working tree" : ""}) and served at ${publicLaneAppUrl} in-sandbox`
              : `subject packed (archiveSha256 ${subject.archiveSha256}); serving did not complete (see session error)`
            : "subject local-tree packing attempted; archive digest unresolved"
        } (subject env names: ${args.subjectEnvNames.length > 0 ? args.subjectEnvNames.join(", ") : "none"}; values never persisted); state: ${describeSubjectState(subject.state, args.dryRun)}.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else {
      events.push({
        id: nextEventId(`subject-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.subject.declared",
        message: `Lane ${spec.laneId}: subject app declared at ${publicLaneAppUrl} (loopback inside the lane's own desktop sandbox).`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }

    // Per-lane session event.
    if (session) {
      events.push({
        id: nextEventId(`session-${spec.laneId}`),
        at: args.createdAt,
        level: session.status === "passed" ? "info" : "warn",
        type: `cua-lab.session.${session.completionReason}`,
        message: `Lane ${spec.laneId}: ${session.status} — ${session.reason}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (args.inProgress === true && outcome === undefined) {
      events.push({
        id: nextEventId(`running-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.session.running",
        message: `Lane ${spec.laneId}: live computer-use session is running; terminal evidence has not been written yet.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (outcome?.skippedReason !== undefined) {
      events.push({
        id: nextEventId(`blocked-${spec.laneId}`),
        at: args.createdAt,
        level: "warn",
        type: "cua-lab.session.blocked",
        message: `Lane ${spec.laneId} ${outcome.skippedReason}.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (outcome?.sessionError) {
      events.push({
        id: nextEventId(`session-error-${spec.laneId}`),
        at: args.createdAt,
        level: "error",
        type: "cua-lab.session.error",
        message: `Lane ${spec.laneId}: ${outcome.sessionError}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else {
      events.push({
        id: nextEventId(`contract-${spec.laneId}`),
        at: args.createdAt,
        level: "info",
        type: "cua-lab.contract.ready",
        message: `Lane ${spec.laneId}: dry-run contract lane ready; switch scenario.mode to live for a real desktop session.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }

    for (const warning of desktopGeometry.warnings ?? []) {
      events.push({
        id: nextEventId(`geometry-warning-${spec.laneId}`),
        at: args.createdAt,
        level: "warn",
        type: "cua-lab.geometry.warning",
        message: warning,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }

    // Persisted per-lane phase trail (real boot timing): one RunEvent per COMPLETED phase
    // boundary this lane recorded (started events never persist here; they carry no durationMs).
    for (const phase of outcome?.phaseRecords ?? []) {
      events.push({
        id: nextEventId(`phase-${spec.laneId}-${phaseEventIdSuffix(phase.type)}`),
        at: phase.at,
        level: phase.ok === false ? "warn" : "info",
        type: phase.type,
        message: phase.durationMs === undefined
          ? `Lane ${spec.laneId}: ${phase.message}`
          : `Lane ${spec.laneId}: ${phase.message} (${phase.durationMs}ms)`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }
  });

  if (args.failFastReason) {
    events.push({
      id: nextEventId("fanout-fail-fast"),
      at: args.createdAt,
      level: "warn",
      type: "cua-lab.fanout.fail-fast",
      message: `Fan-out fail-fast: ${args.failFastReason}. In-flight lanes finished; queued lanes were skipped (blocked) — completed evidence is retained.`
    });
  }

  // Worst-of review verdict across lanes; live fan-out must prove every lane.
  const verdict = args.inProgress === true
    ? "contract_proof_only"
    : fanoutReviewVerdict({
        dryRun: args.dryRun,
        expectedLaneCount: specs.length,
        outcomes
      });

  const passedLanes = (outcomes ?? []).filter((outcome) =>
    outcome.skippedReason === undefined
    && outcome.session !== undefined
    && outcome.session.status === "passed"
    && outcome.session.completionReason !== "harness_error"
    && outcome.sessionError === undefined
    && !outcome.noEngagement
    && !outcome.selfReportedBlocker).length;
  // What happened to the PARTICIPANTS, with the denominator attached. The verdict above has to
  // collapse the run to one word; this does not (docs/principles/three-roles.md).
  const terminalOutcomes = (outcomes ?? []).filter(
    (outcome): outcome is NonNullable<typeof outcome> & { session: { status: ActorStatus } } =>
      outcome?.session?.status !== undefined
  );
  const participants = terminalOutcomes.length > 0
    ? tallyParticipantOutcomes(
        // A NO-ENGAGEMENT lane is not a participant who reached the goal. It said "done" having
        // taken zero actions and said nothing, and `passedLanes` below already refuses to count
        // it — but `reachedGoal` was reading the trace status directly, so one run could be both
        // "not a passed lane" AND "1/1 reached the goal". The headline number a researcher reads
        // first was the dishonest one. Found by a provider bug that ended a study on turn one.
        terminalOutcomes.map((outcome) => participantStatusForCredibility(outcome.session.status, {
          noEngagement: outcome.noEngagement === true,
          selfReportedBlocker: outcome.selfReportedBlocker === true
        })),
        // A participant who reached the goal AND told you the road there was broken is the most
        // useful result a study produces; reporting only the outcome would bury it.
        terminalOutcomes.map((outcome) => outcome.reportedFriction === true)
      )
    : undefined;
  // The study funnel: per-task completion rates across every session that measured one. This is
  // "where did people get stuck" as data, next to WHO got stuck (participants) above.
  const participantFunnels = (outcomes ?? [])
    .map((outcome) => outcome?.session?.trace.taskFunnel)
    .filter((funnel): funnel is TaskFunnel => funnel !== undefined);
  const studyTasks = args.inProgress === true ? undefined : aggregateTaskFunnels(participantFunnels);
  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict,
    ...(participants === undefined ? {} : { participants }),
    ...(studyTasks === undefined ? {} : { tasks: studyTasks }),
    summary: args.inProgress === true
      ? `Live computer-use fan-out is running (${specs.length} per-lane worlds); terminal lane evidence has not been written yet.`
      : args.dryRun
      ? `${args.rerun ? `Rerun contract from ${args.rerun.sourceRunId}: ` : ""}Dry-run fan-out contract: ${specs.length} per-lane-world lanes composed for ${args.descriptor.id} against ${args.appUrl}; no desktops launched, $0 spend.`
      : `${args.rerun ? `Rerun from ${args.rerun.sourceRunId}: ` : ""}Computer-use fan-out (${specs.length} per-lane worlds): ${passedLanes}/${specs.length} lane(s) reached a terminal, engaged verdict${participants ? ` — ${formatParticipantOutcomes(participants)}` : ""}${studyTasks ? `; tasks: ${formatStudyTaskFunnel(studyTasks)}` : ""}.`,
    gaps: args.inProgress === true
      ? ["Live fan-out session is still running."]
      : args.dryRun
      ? ["Live fan-out session not yet run (dry-run contract only)."]
      : specs
          .map((spec, index) => ({ spec, outcome: outcomes?.[index] }))
          .filter(({ outcome }) =>
            outcome === undefined
            || outcome.skippedReason !== undefined
            || outcome.sessionError !== undefined
            || outcome.noEngagement
            || outcome.selfReportedBlocker
            || outcome.session === undefined
            || outcome.session.status !== "passed")
          .map(({ spec, outcome }) => `${spec.laneId}: ${outcome?.skippedReason ?? outcome?.sessionError ?? outcome?.session?.reason ?? "did not pass"}`)
  };

  const anyRaw = (outcomes ?? []).some((outcome) => outcome.session?.trace.redaction.screenshots === "raw");
  const ranLive = (outcomes ?? []).some((outcome) => outcome.session !== undefined || outcome.sessionError !== undefined);
  const configuredBrowser = config.execution?.desktop?.browser;
  const resolvedBrowsers = (outcomes ?? [])
    .map((outcome) => outcome.desktopBrowser?.resolved)
    .filter((value): value is string => value !== undefined);
  const unanimousResolvedBrowser = resolvedBrowsers.length > 0 && new Set(resolvedBrowsers).size === 1
    ? resolvedBrowsers[0]
    : undefined;
  const providerResources = (outcomes ?? []).flatMap((outcome) =>
    providerResourcesForOutcome({
      outcome,
      createdAt: args.createdAt,
      simId: outcome.spec.simId,
      streamId: outcome.spec.streamId,
      laneId: outcome.spec.laneId
    }));

  // Run-level cost ESTIMATE: one model-token line per lane that ran a session (from its persisted
  // trace.estimatedCost) + a desktop line per owned allocation, priced at its observed resources.
  // Per-lane worlds have no shared provisioning to double-count. Omitted on a pure dry-run.
  const costLanes = specs
    .map((spec, index) => ({ laneId: spec.laneId, outcome: outcomes?.[index] }))
    .filter((entry): entry is { laneId: string; outcome: LaneRunOutcome } => entry.outcome?.session !== undefined)
    .map((entry) => ({ laneId: entry.laneId, trace: entry.outcome.session!.trace }));
  const desktops = (outcomes ?? []).filter(outcome => outcome.sandboxId !== undefined).map(outcome => ({
    laneId: outcome.spec.laneId, minutes: desktopSpanToMinutes(outcome.desktopDurationMs),
    observation: outcome.desktopResources, lifetimeComplete: outcome.killed
  }));
  const cost = buildCuaCostSummary({ lanes: costLanes, desktops });

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: specs.length,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    artifactRoot: path.join(".humanish", "runs", args.runId),
    ...(args.lab === undefined ? {} : { lab: args.lab }),
    source: args.source,
    persona: {
      id: specs[0]!.persona.id,
      name: `Computer-use fan-out (${specs.length} lanes)`,
      source: `lab:${config.id}`,
      sourceDigest: specs[0]!.persona.promptDigest
    },
    scenario: {
      id: `cua-${config.id}`,
      title: config.title ?? `Computer-use fan-out: ${config.id}`,
      // Redacted at WRITE time, like every other raw-text surface in the bundle. Lane records are
      // digest-only by design, but scenario.goal keeps one lane's composed instructions verbatim —
      // and an adopter whose authored lane text must name a runtime world URL (an inbox on a route
      // where the harness does not inject one) put an *.e2b.app address in it. That landed raw here
      // and in observer-data.json, the sensitive-text scanner matched it, and verify failed a bundle
      // this writer produced. The only adopter-side workaround was scanner evasion (#412).
      //
      // The instructions the model actually receives are untouched; only the persisted copy changes.
      goal: redactText(specs[0]!.instructions),
      source: `lab:${config.id}`,
      sourceDigest: specs[0]!.persona.promptDigest
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "cua-lab.run.created",
        message: `Created computer-use fan-out run with ${specs.length} per-lane desktop browser lanes (actor ${args.descriptor.id}).`
      }
    ],
    simulations,
    streams,
    events,
    ...(args.rerun === undefined ? {} : { rerun: args.rerun }),
    redaction: {
      status: "passed",
      notes: ranLive
        ? anyRaw
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Some lanes captured FULL-FIDELITY (raw) screenshots, retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle."
        : "Dry-run fan-out contract bundle: no desktops launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    // What the participants reported, when any reported anything (#392). Dry-run and in-progress
    // bundles carry none — there is no participant yet to quote.
    feedbackCandidates: args.dryRun || args.inProgress === true
      ? []
      : participantFeedbackCandidates({
          runId: args.runId,
          scenarioId: `cua-${config.id}`,
          adapterId: config.id,
          goal: redactText(specs[0]!.instructions),
          substrate: "e2b-desktop",
          lanes: specs.map((spec, index) => {
            const outcome = outcomes?.[index];
            return {
              laneId: spec.laneId,
              streamId: spec.streamId,
              personaId: spec.persona.id,
              ...(outcome?.session === undefined ? {} : { session: outcome.session }),
              ...(outcome?.session === undefined ? {} : { traceArtifactPath: spec.traceArtifactPath }),
              screenshots: outcome?.screenshots ?? [],
              ...(outcome?.commsArtifactPath === undefined ? {} : { commsArtifactPath: outcome.commsArtifactPath })
            };
          })
        }),
    // Custom desktop image provenance (every lane launched on it); omitted on the stock default.
    ...(config.execution?.desktop?.template === undefined ? {} : { desktopTemplate: config.execution.desktop.template }),
    ...(configuredBrowser === undefined
      ? {}
      : { desktopBrowser: { requested: configuredBrowser, ...(unanimousResolvedBrowser === undefined ? {} : { resolved: unanimousResolvedBrowser }) } }),
    ...(providerResources.length === 0 ? {} : { providerResources }),
    subject: args.aggregateSubject,
    ...(cost === undefined ? {} : { cost })
  };
}

function providerResourcesForOutcome(args: {
  outcome: LaneRunOutcome | undefined;
  createdAt: string;
  simId: string;
  streamId: string;
  laneId: string;
}): RunProviderResource[] {
  if (args.outcome?.sandboxId === undefined) {
    return [];
  }

  return [{
    schema: "humanish.provider-resource.v1",
    provider: "e2b-desktop",
    kind: "sandbox",
    id: args.outcome.sandboxId,
    owner: "humanish",
    status: args.outcome.killed ? "killed" : "running",
    simId: args.simId,
    streamId: args.streamId,
    laneId: args.laneId,
    createdAt: args.createdAt,
    cleanup: {
      killed: args.outcome.killed,
      reason: args.outcome.killed
        ? "killed during normal lane teardown"
        : "not killed during normal lane teardown; cleanup may reclaim by exact recorded id"
    }
  }];
}

/**
 * The status a participant is TALLIED under, given what the lane made of the session. A
 * goal_satisfied claim with zero engagement is a session that ran out before anything happened;
 * one whose final message describes a blocker is a participant who could not proceed and said so.
 * Both keep their trace status (the claim is evidence); neither is a participant who reached the
 * goal. One rule for the single lane and the fan-out roll-up (#476).
 */
export function participantStatusForCredibility(
  status: ActorStatus,
  credibility: { noEngagement: boolean; selfReportedBlocker: boolean } | undefined
): ActorStatus {
  if (status !== "passed" || credibility === undefined) return status;
  if (credibility.noEngagement) return "incomplete";
  if (credibility.selfReportedBlocker) return "blocked";
  return status;
}

function verdictForStatus(status: ActorStatus): ReviewSummary["verdict"] {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "blocked":
      return "blocked";
    case "timed_out":
      return "timed_out";
    // A participant who abandoned, or a session that ran out before the goal, did not pass — but the
    // harness did not fail either. The run reports what happened rather than a verdict on the tool.
    case "abandoned":
    case "incomplete":
      return "fail";
  }
}

function renderCuaReviewMarkdown(bundle: RunBundle): string {
  const trace: ActorTrace | undefined = bundle.streams[0]?.actor;
  const provenance = bundle.events.find((event) => event.type === "cua-lab.subject.provenance");
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    ...(provenance ? [`- subject: ${provenance.message}`] : []),
    ...(trace
      ? [
          `- actor: ${trace.provider} (${trace.lane}/${trace.protocol})`,
          // Honest count: name the trace's actual screenshot mode ("raw" | "blurred"); say
          // nothing when no frames exist ("n/a") rather than claim a redaction that never ran.
          `- evidence: ${trace.items.length} trace item(s), ${trace.counts.screenshots ?? 0} ${
            trace.redaction.screenshots === "raw" || trace.redaction.screenshots === "blurred"
              ? `${trace.redaction.screenshots} screenshot(s)`
              : "screenshot(s)"
          }`
        ]
      : []),
    ...(bundle.review.gaps.length > 0 ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)] : []),
    ""
  ].join("\n");
}

function makeCuaRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `cua-${stamp}-${randomBytes(4).toString("hex")}`;
}

function publicSafeAppUrlLabel(url: string): string {
  return containsSensitive(url) ? `[target-url:${digestUrl(url)}]` : url;
}

function digestUrl(url: string): string {
  return digestText(url, 16);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
