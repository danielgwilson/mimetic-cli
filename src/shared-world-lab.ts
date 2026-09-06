// The shared-world lab backend (#164): the SEQUENTIAL deterministic proof-of-concept of the
// shared-world topology. ONE sandbox provisions a mutable service plane ONCE (clone or packed
// working tree + serve + seed), then N role SEATS take turns IN DECLARED ORDER (each an isolated browser
// profile + identity) against the shared loopback app. A read-only state
// CHECKPOINT (digest probe) runs at baseline + after each role's turn, producing a
// harness-clocked timeline that PROVES role B acted on a world already containing role A's
// mutation (the checkpoint after A strictly precedes B's turn in one clock).
//
// Doctrine (docs/goals/shared-world-topology/goal.md): the bundle declares a VERIFIED, weaker
// `attributionClass: shared-world` + a `humanish.shared-world.v1` block whose `attributionLimits`
// pin the attribution ceiling (sequential-only, no-concurrent-races,
// delta-attributed-to-turn-not-action). verifyRun fails closed on any overclaim.
//
// Safety rails (same as the fan-out packet + the 2026-06-16 prod incident): ONE Sandbox.create;
// ONE teardown BY exact sandboxId in a finally — NEVER Sandbox.list (account-wide ops are
// forbidden). Provisioned values are literal-scrubbed before any error/log persists; checkpoints
// persist DIGEST-ONLY. The concurrent (getHost) topology, a handoff/barrier grammar, an onTurn
// hook, and real per-role login are named NON-GOALS (PR2+).
//
// FIDELITY NOTE: one sandbox has ONE screen geometry, so a role's `device` is a PROMPT SIGNAL
// (composed into its persona context) — physical per-role screen geometry is the concurrent
// topology's job. Each role records its measured browser viewport separately from that screen.

import { randomBytes } from "node:crypto";
import { describeMissingKeys } from "./key-resolution.js";
import { beginRunStatus, type RunLabProvenance, type RunStatusHandle , withRunStatusScope} from "./run-status.js";
import path from "node:path";
import { runDesktopCommandOrThrow, toErrorMessage } from "./command-failure.js";

import type { ActorCompletionReason, ActorPersonaRef, ActorStatus } from "./actor-contract.js";
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
import type { CuaLoopResult } from "./computer-use.js";
import { labPersonaIds, resolveCommittedPersonasForCwd } from "./persona-resolve.js";
import type { ResolvedPersona } from "./persona.js";
import type { ReasoningEffort } from "./reasoning-effort.js";
import {
  commandDigestOf,
  composeLaneInstructions,
  defaultPackLocalTree,
  makeChromeBrowserStateObserver,
  captureDesktopBrowserGeometry,
  inspectDesktopScreenGeometry,
  makeLaneWriteScreenshot,
  provisionCloneSubject,
  provisionLocalTreeSubject,
  resolveLaneDevice,
  resolveSubjectState,
  SUBJECT_DIR,
  type DesktopBrowserEvidence,
  type DesktopBrowserFamily,
  type DesktopBrowserLaunchIdentity,
  type DesktopBrowserLaunchResult,
  desktopBrowserFamily,
  type SubjectPhaseEvent
} from "./cua-actor-lab.js";
import type { E2BDesktopLike } from "./e2b-desktop-executor.js";
import {
  createDesktopSandbox,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import { runDetachedStep, type DetachedTimers } from "./e2b-detached.js";
import type { DevicePreset } from "./device-presets.js";
import {
  resolveSeatUrl,
  sharedWorldValidationReason,
  type LabActorLane,
  type LabConfig,
  type LabDesktopBrowser,
  type LabSubjectStateCheckpoint
} from "./lab-config.js";
import { renderObserver, type ObserverResult } from "./observer.js";
import { redactText } from "./redaction.js";
import { prepareRunArtifactPaths, validatePreparedRunArtifactPaths } from "./run-paths.js";
import { writeContainedOutputFile, writePreparedRunLatestPointer } from "./selected-output-paths.js";
import type { LocalTreeArchive } from "./source-archive.js";
import type { DwellWindow, StopWhen } from "./stop-conditions.js";
import {
  buildRunSource,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  SHARED_WORLD_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunDesktopGeometry,
  type RunEvent,
  type RunScorerProvenance,
  type RunSimulation,
  type RunSimulationStatus,
  type RunStream,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
  type SharedWorldCheckpoint,
  type SharedWorldEvidence,
  type SharedWorldTimelineEntry
} from "./run.js";
import { appendSandboxReceipt } from "./sandbox-receipts.js";

export const SHARED_WORLD_LAB_SCHEMA = "humanish.shared-world-lab-result.v1";

export const SHARED_WORLD_LAB_PROVIDER_METADATA = {
  mode: "shared-world-lab",
  tool: "humanish"
} as const;

// The DEFAULT per-role session budget is DERIVED, not flat: every role's turn shares ONE sandbox
// on this route, so the sandbox deadline is timeoutMs x roleCount plus provisioning, seeding, and
// the teardown buffer — and E2B refuses a sandbox over one hour. A flat raise here would make the
// derived deadline overflow the cap and fail at create. The derivation hands each role the most
// the cap allows (capped at 15 minutes; floored at the historical 300s so a seed-heavy lab never
// gets LESS room than it always had). An explicit execution.timeoutMs is never adjusted.
const MAX_SANDBOX_MS = 60 * 60_000;
const MAX_DERIVED_ROLE_SESSION_MS = 15 * 60_000;
const MIN_DERIVED_ROLE_SESSION_MS = 300_000;
function defaultRoleSessionTimeoutMs(config: LabConfig, roleCount: number): number {
  const stateBudgetMs = (config.subject.state?.seed ?? []).reduce(
    (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0);
  const room = Math.floor(
    (MAX_SANDBOX_MS - SUBJECT_PROVISION_BUDGET_MS - stateBudgetMs - SANDBOX_TIMEOUT_BUFFER_MS)
      / Math.max(1, roleCount)
  );
  return Math.max(MIN_DERIVED_ROLE_SESSION_MS, Math.min(MAX_DERIVED_ROLE_SESSION_MS, room));
}
// Settle after opening a seat's browser, before the session's first screenshot.
const BROWSER_SETTLE_MS = 8_000;
// In-sandbox budget for ending one seat's browser at turn end (TERM, short wait, KILL).
const SEAT_BROWSER_TERMINATION_TIMEOUT_MS = 15_000;
// Server-side reclamation buffer past the loop's own wall-clock stop.
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;
// Room for the one-time clone/install/build/start/probe + the sequential per-role sessions.
const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;
// Per-checkpoint probe budget (read-only aggregate probes are fast).
const CHECKPOINT_TIMEOUT_MS = 60_000;
const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_MISSION =
  "You are testing a shared web application other roles also use. The browser is already open at your entry URL. Accomplish what your role asks, then stop.";

/**
 * Library-level hooks mirroring CuaActorLabHooks — the DI seams that let CI drive the FULL
 * orchestration with fakes at $0/zero-network. The fake desktop module records create/kill BY id
 * and exposes NO `list` method (the by-id teardown rail is then provable by construction).
 */
export interface SharedWorldLabHooks extends BrowserLabAdapterHooks {
  /** Lazy-load the E2B desktop module (tests inject a fake; default loadE2BDesktopModule). */
  loadDesktopModule?: () => Promise<E2BDesktopModule>;
  /** Runs once after sandbox creation, before subject provisioning (library setup seam). */
  prepareDesktop?: (desktop: E2BDesktopSandbox) => Promise<void>;
  /** The per-seat computer-use session runner (default: the resolved actor descriptor's). */
  runSession?: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>;
  /** The operator environment (keys + subject env values). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock/sleep for the detached-step polling (tests only). */
  detachedTimers?: DetachedTimers;
  /**
   * Subject-provisioning phase sink (mirrors CuaActorLabHooks.onPhase): one call per
   * started/completed boundary during the ONE shared-plane provision (clone route: clone, install,
   * build, serve start, ready, subject.state seed-step groups; local-tree route: upload, extract,
   * install, build, serve start, ready, seed-step groups - no clone phase). Defaults to one stderr
   * line per event. Override in tests to capture instead of writing to real stderr.
   */
  onPhase?: (event: SubjectPhaseEvent) => void;
  /**
   * CONCURRENT route only (#164 phase 2): the harness clock used to MEASURE each actor's laneWindow
   * [start,end] (default Date.now). The deterministic heart test does NOT override this — overlap is
   * produced by a rendezvous latch in the fake runSession + measured by the REAL clock (FIX-1), so
   * the windows are real, not injected. (A test may override only for non-overlap assertions.)
   */
  now?: () => number;
  /** CONCURRENT route only: the background stateSeries prober cadence (ms). Default 1000. */
  proberCadenceMs?: number;
  /**
   * EXTERNAL-PUBLIC concurrent route only (#164 phase 2): the host-first handoff barrier deadline
   * (ms). The host seat must surface a shared-session (/lobby/CODE) URL within this budget or the run
   * fails closed with HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT and no follower opens.
   * Default 120000 (also capped by execution.timeoutMs). Tests inject a short value to exercise the
   * fail-closed path deterministically.
   */
  handoffDeadlineMs?: number;
  /**
   * EXTERNAL-PUBLIC concurrent route only: the vision reader that extracts a /lobby/CODE off a seat's
   * screenshot frame (the CDP-independent handoff relay + per-seat convergence observation). Defaults to
   * the real single-frame OpenAI read (readLobbyCodeFromFrame). Tests inject a fake so the barrier's
   * handoff + convergence proof can be exercised deterministically without a live vision call.
   */
  readLobbyCodeFromFrame?: (frame: Buffer, apiKey: string) => Promise<string | undefined>;
  /**
   * Local-tree packing DI seam (tests only, no npm dependency needed to exercise the route):
   * defaults to createLocalTreeArchive(root, opts) plus a host-side read of the produced archive
   * file into an ArrayBuffer (the SAME default cua-actor-lab.ts uses). Called ONCE per run, before
   * the ONE shared-plane sandbox is created, on the live local-tree route.
   */
  packLocalTree?: (args: {
    root: string;
    extraExclude?: string[];
    maxArchiveBytes?: number;
  }) => Promise<{ archive: LocalTreeArchive; buffer: ArrayBuffer }>;
}

export interface RunSharedWorldLabOptions {
  /** Which manifest produced this run (#455); threaded into the status record + bundle. */
  lab?: RunLabProvenance;
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  hooks?: SharedWorldLabHooks;
  /** Present only when the browser-route scorer hooks were CONFIG-DECLARED and loaded by the CLI
   *  (#316); core-stamped onto the bundle as evidence. Absent for library callers. */
  scorerProvenance?: RunScorerProvenance;
}

export type SharedWorldLabErrorCode =
  | "HUMANISH_SHARED_WORLD_LAB_FAILED"
  | "HUMANISH_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED"
  | "HUMANISH_SHARED_WORLD_LAB_INVALID"
  | "HUMANISH_SHARED_WORLD_LAB_KEYS_MISSING"
  | "HUMANISH_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING";

/** One role seat's terminal outcome in the result projection. */
export interface SharedWorldRoleResult {
  id: string;
  index: number;
  persona: string;
  /** Terminal role status; "blocked" = fail-fast skipped it; "contract_proof_only" = dry-run. */
  status: ActorStatus | "blocked" | "contract_proof_only";
  ok: boolean;
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
    screenshots: number;
  };
  /** The user-data-dir profile this seat drove (proves per-seat isolation). */
  profileDir: string;
  /** Set when the role was skipped by fail-fast (a pinned reason string). */
  skippedReason?: string;
  error?: { code: SharedWorldLabErrorCode; message: string };
}

export interface SharedWorldLabResult {
  schema: typeof SHARED_WORLD_LAB_SCHEMA;
  /** True when the bundle verified AND (dry-run, or every role reached a terminal, engaged
   * verdict without a harness error). The roles' pass/fail is evidence, not the lab's exit code. */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the seats. */
  actor: string;
  topology: "shared-world";
  /** The DECLARED number of role seats. */
  roleCount: number;
  /** The role ids that actually took a turn, in declared order. */
  sequence: string[];
  dryRun: boolean;
  runId: string;
  /** Live-only: the ONE shared sandbox's lifecycle proof (the stream/key value is never surfaced). */
  sandbox?: {
    sandboxId: string;
    killed: boolean;
  };
  /** Subject provenance (invariant 5): the ONE shared plane. */
  subject?: RunSubjectProvenance;
  roles: SharedWorldRoleResult[];
  observer?: ObserverResult;
  warnings: string[];
  error?: { code: SharedWorldLabErrorCode; message: string };
}

/** A fully-resolved role seat (internal). */
interface RoleSpec {
  roleId: string;
  /** 0-based. */
  roleIndex: number;
  simId: string;
  streamId: string;
  persona: ActorPersonaRef;
  instructions: string;
  /** The role's declared device (a PROMPT SIGNAL — see the file's FIDELITY NOTE). */
  deviceName: string;
  /** Lane override, then actor default; omitted preserves the provider default. */
  reasoningEffort?: ReasoningEffort;
  /** Deterministic harness-owned completion guard. Lane-level override, else actor default. */
  stopWhen?: StopWhen;
  /** A declared observation window (#510). Lane-level override, else actor default. */
  dwell?: DwellWindow;
  entry?: string;
  seatUrl: string;
  screenshotDir: string;
  traceArtifactPath: string;
  profileDir: string;
}

/** One role seat's end-to-end run outcome (internal; projected into the result + the bundle). */
interface RoleOutcome {
  spec: RoleSpec;
  session?: CuaLoopResult;
  sessionError?: string;
  screenshots: string[];
  desktopBrowser?: DesktopBrowserEvidence;
  desktopGeometry?: RunDesktopGeometry;
  /** Set when fail-fast skipped this role before it ran. */
  skippedReason?: string;
  noEngagement: boolean;
  harnessError: boolean;
  /** The checkpoint snapshot taken AFTER this role's turn (absent for skipped roles). */
  afterCheckpoint?: SharedWorldCheckpoint;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function makeSharedWorldRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `shared-world-${stamp}-${randomBytes(4).toString("hex")}`;
}

/** Single-quote a value for safe interpolation into the seat-launch shell command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Launch ONE seat's browser with its OWN isolated profile — the shared-world topology needs a
 * fresh browser identity boundary per role (cookies/session isolated per seat). Absent/default
 * preserves the historical shared-world opener (Chrome best-effort). A concrete preference is
 * fail-closed and records the resolved in-sandbox command.
 */
async function launchSeatBrowser(
  desktop: E2BDesktopSandbox,
  args: {
    browserPreference?: LabDesktopBrowser;
    profileDir: string;
    requestTimeoutMs: number;
    seatUrl: string;
  }
): Promise<DesktopBrowserLaunchResult> {
  const requested = args.browserPreference ?? "default";
  const chromiumFlags = CHROMIUM_EVIDENCE_HYGIENE_FLAGS.map(shellQuote).join(" ");
  const command = [
    "set -euo pipefail",
    `browser_preference=${shellQuote(requested)}`,
    `profile_dir=${shellQuote(args.profileDir)}`,
    `seat_url=${shellQuote(args.seatUrl)}`,
    `chrome_preferences_json=${shellQuote(chromiumEvidenceProfilePreferencesJson())}`,
    'mkdir -p "$profile_dir"',
    "chrome_debug_flags=(" + chromiumFlags + ")",
    "prepare_chrome_profile() {",
    "  mkdir -p \"$profile_dir/Default\"",
    "  printf '%s\\n' \"$chrome_preferences_json\" > \"$profile_dir/Default/Preferences\"",
    "}",
    "launch_chrome() {",
    "  local label=\"$1\"",
    "  local binary=\"$2\"",
    "  if ! command -v \"$binary\" >/dev/null 2>&1; then return 127; fi",
    "  prepare_chrome_profile",
    "  rm -f \"$profile_dir/DevToolsActivePort\"",
    "  setsid \"$binary\" --new-window --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --user-data-dir=\"$profile_dir\" \"${chrome_debug_flags[@]}\" \"$seat_url\" > /dev/null 2>&1 < /dev/null &",
    "  local launch_pid=$!",
    "  echo \"HUMANISH_BROWSER_RESOLVED=$label\"",
    "  echo \"HUMANISH_BROWSER_PID=$launch_pid\"",
    "  for _ in $(seq 1 30); do",
    "    if [ -s \"$profile_dir/DevToolsActivePort\" ]; then",
    "      head -n 1 \"$profile_dir/DevToolsActivePort\" | sed 's/^/HUMANISH_BROWSER_CDP_PORT=/'",
    "      break",
    "    fi",
    "    sleep 0.1",
    "  done",
    "}",
    "launch_firefox() {",
    "  if ! command -v firefox >/dev/null 2>&1; then return 127; fi",
    "  setsid firefox --new-instance --no-remote --new-window --profile \"$profile_dir\" \"$seat_url\" > /dev/null 2>&1 < /dev/null &",
    "  local launch_pid=$!",
    "  echo \"HUMANISH_BROWSER_RESOLVED=firefox\"",
    "  echo \"HUMANISH_BROWSER_PID=$launch_pid\"",
    "  echo \"HUMANISH_BROWSER_PROFILE_DIR=$profile_dir\"",
    "}",
    "case \"$browser_preference\" in",
    "  chrome)",
    "    launch_chrome google-chrome google-chrome || launch_chrome google-chrome-stable google-chrome-stable",
    "    ;;",
    "  chromium)",
    "    launch_chrome chromium chromium || launch_chrome chromium-browser chromium-browser",
    "    ;;",
    "  firefox)",
    "    launch_firefox",
    "    ;;",
    "  default)",
    "    launch_chrome google-chrome google-chrome || true",
    "    ;;",
    "esac"
  ].join("\n");
  const result = await runDesktopCommandOrThrow(
    () => desktop.commands.run(command, { requestTimeoutMs: args.requestTimeoutMs }),
    (_info, error) =>
      args.browserPreference !== undefined && args.browserPreference !== "default"
        ? new Error(`requested desktop browser "${args.browserPreference}" could not be launched for shared-world seat`)
        : error,
  );
  if (args.browserPreference !== undefined && args.browserPreference !== "default" && result.exitCode !== undefined && result.exitCode !== 0) {
    throw new Error(`requested desktop browser "${args.browserPreference}" could not be launched for shared-world seat`);
  }
  const resolved = (result.stdout ?? "").match(/^HUMANISH_BROWSER_RESOLVED=(\S+)$/m)?.[1];
  const processId = (result.stdout ?? "").match(/^HUMANISH_BROWSER_PID=(\d+)$/m)?.[1];
  const profileDir = (result.stdout ?? "").match(/^HUMANISH_BROWSER_PROFILE_DIR=(\S+)$/m)?.[1] ?? args.profileDir;
  const cdpPortRaw = (result.stdout ?? "").match(/^HUMANISH_BROWSER_CDP_PORT=(\d+)$/m)?.[1];
  const cdpPort = cdpPortRaw === undefined ? undefined : Number(cdpPortRaw);
  return {
    family: desktopBrowserFamily(resolved ?? requested),
    ...(processId === undefined
      ? {}
      : { identity: { processId, profileDir, targetUrl: args.seatUrl, ...(cdpPort === undefined ? {} : { cdpPort }) } }),
    ...(args.browserPreference === undefined
      ? {}
      : { evidence: { requested, ...(resolved === undefined ? {} : { resolved }) } })
  };
}

/**
 * Self-match-proof pkill/pgrep -f pattern for a seat's unique profile dir: bracket the first
 * character so the in-sandbox shell running the termination script (whose own command line
 * carries this pattern) can never match itself. Exported (pure) for contract tests.
 */
export function seatProfilePkillPattern(profileDir: string): string {
  const head = profileDir.slice(0, 1);
  const tail = profileDir.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `[${head}]${tail}`;
}

/**
 * Build the in-sandbox command that ends ONE seat's browser when its turn ends (pure; exported
 * for contract tests). All roles share the ONE desktop, so a prior seat's browser left alive
 * could keep polling/holding websockets and mutating the shared plane during a later role's
 * turn, with its authenticated window one Alt-Tab away from the current actor. The recorded
 * launch PID (a setsid session leader) is the primary kill (its process group takes the whole
 * browser tree); pkill -f on the seat's unique profile dir is the fallback; a short bounded
 * wait escalates to SIGKILL. Exit is always 0: a termination failure degrades to the caller's
 * warning, never a failed run.
 */
export function buildSeatBrowserTerminationCommand(processId: string | undefined, profileDir: string): string {
  return [
    "set -u",
    `launch_pid=${shellQuote(processId ?? "")}`,
    `profile_pattern=${shellQuote(seatProfilePkillPattern(profileDir))}`,
    'if [ -n "$launch_pid" ]; then',
    '  kill -TERM -- "-$launch_pid" 2>/dev/null || kill -TERM "$launch_pid" 2>/dev/null || true',
    "fi",
    'pkill -TERM -f "$profile_pattern" 2>/dev/null || true',
    "for _ in $(seq 1 20); do",
    '  if ! pgrep -f "$profile_pattern" >/dev/null 2>&1; then',
    "    exit 0",
    "  fi",
    "  sleep 0.1",
    "done",
    'pkill -KILL -f "$profile_pattern" 2>/dev/null || true',
    "exit 0"
  ].join("\n");
}

/** Combine a snapshot's per-probe digests into ONE sha256-16 (digest-only; no raw value). */
export function combineCheckpointDigest(parts: string[]): string {
  return commandDigestOf(parts.join("\n"));
}

/**
 * Run ONE checkpoint snapshot LIVE: each declared probe runs read-only via the detached
 * primitive; its stdout is literal-scrubbed (provisioned values + the probe's declared redact
 * literals, folded into `scrub`) then pattern-redacted, then digested. Only the COMBINED digest
 * persists — never the raw value (the seed-step lockdown). Unique step names per snapshot prevent
 * stale-status reuse across snapshots.
 */
export async function runCheckpointSnapshot(args: {
  desktop: E2BDesktopSandbox;
  snapshotIndex: number;
  name: string;
  checkpoints: LabSubjectStateCheckpoint[];
  prevDigest: string | undefined;
  scrub: (text: string) => string;
  requestTimeoutMs: number;
  timers: DetachedTimers;
}): Promise<SharedWorldCheckpoint> {
  const parts: string[] = [];
  for (const probe of args.checkpoints) {
    const result = await runDetachedStep(args.desktop, {
      name: `checkpoint-${args.snapshotIndex}-${probe.name}`,
      command: probe.command,
      cwd: SUBJECT_DIR,
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
      requestTimeoutMs: args.requestTimeoutMs,
      ...args.timers
    });
    const scrubbed = redactText(args.scrub(result.logTail));
    parts.push(`${probe.name}=${commandDigestOf(scrubbed)}`);
  }
  const digest = combineCheckpointDigest(parts);
  return {
    kind: "checkpoint",
    name: args.name,
    digest,
    deltaFromPrev: args.prevDigest !== undefined && digest !== args.prevDigest
  };
}

/** The DECLARED (dry-run) checkpoint snapshot: digest the probe RECIPE (command digests), no run. */
export function declaredCheckpointSnapshot(name: string, checkpoints: LabSubjectStateCheckpoint[]): SharedWorldCheckpoint {
  const parts = checkpoints.map((probe) => `${probe.name}=${commandDigestOf(probe.command)}`);
  return { kind: "checkpoint", name, digest: combineCheckpointDigest(parts), deltaFromPrev: false };
}

/** sha256-16 over the ordered seed-step command digests — the seeded-state RECIPE identity. */
export function seedRecipeDigest(config: LabConfig): string {
  const seed = config.subject.state?.seed ?? [];
  return commandDigestOf(seed.map((step) => `${step.name}:${commandDigestOf(step.command)}`).join("\n"));
}

/** Build the resolved role roster from actors[0].lanes (the role roster). */
function buildRoleSpecs(
  config: LabConfig,
  serveUrl: string,
  personas: Map<string, ResolvedPersona>
): RoleSpec[] {
  const actor = config.actors[0];
  const mission = actor?.mission ?? DEFAULT_MISSION;
  const roster = actor?.lanes ?? [];
  return roster.map((lane: LabActorLane, i): RoleSpec => {
    const roleId = lane.id ?? `role-${String(i + 1).padStart(2, "0")}`;
    const device = resolveLaneDevice(config, lane);
    const resolvedPersona = lane.persona === undefined ? undefined : personas.get(lane.persona);
    const composed = composeLaneInstructions({
      mission,
      ...(lane.persona === undefined ? {} : { persona: lane.persona }),
      ...(resolvedPersona === undefined ? {} : { resolvedPersona }),
      ...(lane.instruction === undefined ? {} : { instruction: lane.instruction }),
      device: { name: device.name, preset: device.preset }
    });
    return {
      roleId,
      roleIndex: i,
      simId: `sim-${String(i + 1).padStart(3, "0")}`,
      streamId: `stream-${String(i + 1).padStart(3, "0")}`,
      persona: composed.persona,
      instructions: composed.instructions,
      deviceName: device.name,
      ...((lane.reasoningEffort ?? actor?.reasoningEffort) === undefined
        ? {}
        : { reasoningEffort: (lane.reasoningEffort ?? actor?.reasoningEffort) as ReasoningEffort }),
      ...((lane.stopWhen ?? actor?.stopWhen) === undefined ? {} : { stopWhen: (lane.stopWhen ?? actor?.stopWhen) as StopWhen }),
      ...((lane.dwell ?? actor?.dwell) === undefined ? {} : { dwell: (lane.dwell ?? actor?.dwell) as DwellWindow }),
      ...(lane.entry === undefined ? {} : { entry: lane.entry }),
      seatUrl: resolveSeatUrl(serveUrl, lane.entry) ?? serveUrl,
      screenshotDir: roleId,
      traceArtifactPath: `actors/${`stream-${String(i + 1).padStart(3, "0")}`}.json`,
      profileDir: `/tmp/seat-${roleId}`
    };
  });
}

/**
 * Wrapped so a DIRECT library caller gets the same status-record lifetime the CLI does: returning
 * from this function finalizes any record the run opened, whichever of its fail-closed exits it
 * took. `runLab` establishes a scope too and nesting is harmless — the inner scope owns what it
 * opened. Without this a test or an adopter calling the backend directly leaves the 5s cadence
 * ticking into a directory something else is deleting, which surfaces as an unrelated ENOTEMPTY.
 */
export async function runSharedWorldLab(options: RunSharedWorldLabOptions): Promise<SharedWorldLabResult> {
  return withRunStatusScope(() => runSharedWorldLabInScope(options));
}

async function runSharedWorldLabInScope(options: RunSharedWorldLabOptions): Promise<SharedWorldLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const render = hooks.renderObserverFn ?? renderObserver;
  const actorType = config.actors[0]?.type ?? "";

  const fail = (code: SharedWorldLabErrorCode, message: string, actorLabel?: string): SharedWorldLabResult => ({
    schema: SHARED_WORLD_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: actorLabel ?? actorType,
    topology: "shared-world",
    roleCount: config.actors[0]?.lanes?.length ?? 0,
    sequence: [],
    dryRun,
    runId: options.runId ?? "not-created",
    roles: [],
    warnings: [],
    error: { code, message }
  });

  // Resolve the actor through the registry — the parser validated this, but the engine fails closed
  // rather than trusting a config that arrived through the library door (this fn is npm surface).
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return fail("HUMANISH_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED", `actors[0].type "${actorType}" is not a registered computer-use actor.`);
  }

  // Re-enforce the shared-world cross-validation (library API surface).
  const invalidReason = sharedWorldValidationReason(config);
  if (invalidReason) {
    return fail("HUMANISH_SHARED_WORLD_LAB_INVALID", invalidReason, descriptor.id);
  }

  const serve = config.subject.serve!;
  const localTreeRoute = config.subject.source === "local-tree";
  const subjectRepo = config.subject.repos?.[0] ?? "";
  const subjectEnvNames = config.subject.env ?? [];
  const checkpoints = config.subject.state?.checkpoint ?? [];
  // Compile committed personas so each seat's prompt carries real behavioral directives (#381).
  const personaResolution = await resolveCommittedPersonasForCwd(cwd, labPersonaIds(config));
  const roleSpecs = buildRoleSpecs(config, serve.url, personaResolution.personas);
  const roleCount = roleSpecs.length;
  const runSession = hooks.runSession ?? descriptor.runSession;

  // Read keys once into locals (names only; values never logged or persisted).
  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";

  // Literal scrubber for every known provisioned value (no secret "shape" to pattern-match):
  // provider/E2B keys, subject env values, AND each checkpoint's declared redact literals.
  const knownSecretValues = [
    openaiApiKey,
    e2bApiKey,
    ...subjectEnvNames.map((name) => env[name] ?? ""),
    ...checkpoints.flatMap((probe) => probe.redact ?? [])
  ].filter((value) => value.length >= 4);
  const scrubKnownValues = (text: string): string =>
    knownSecretValues.reduce((current, value) => current.split(value).join("[REDACTED_SECRET]"), text);

  const redactRepoLabel = config.policies?.redactRepos ?? subjectEnvNames.includes("GITHUB_TOKEN");
  const publicRepo = redactRepoLabel ? "repo-01" : subjectRepo;
  const hasGithubToken = subjectEnvNames.includes("GITHUB_TOKEN");

  if (!dryRun) {
    const missingKeys = [
      ...(openaiApiKey ? [] : ["OPENAI_API_KEY"]),
      ...(e2bApiKey ? [] : ["E2B_API_KEY"])
    ];
    if (missingKeys.length > 0) {
      return fail(
        "HUMANISH_SHARED_WORLD_LAB_KEYS_MISSING",
        `Live shared-world labs need ${missingKeys.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missingKeys, env)}`,
        descriptor.id
      );
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return fail(
        "HUMANISH_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING",
        `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`,
        descriptor.id
      );
    }
  }

  const runId = options.runId ?? makeSharedWorldRunId();
  const runPaths = await prepareRunArtifactPaths(cwd, runId);
  // Identity + liveness on disk (#455): every backend writes this, so a watcher can classify any
  // run without parsing bundles and without depending on the interactive-observer path.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab })
  });
  const physicalArtifactRoot = runPaths.physicalRunRoot;
  const createdAt = new Date().toISOString();
  const timeoutMs = config.execution?.timeoutMs ?? defaultRoleSessionTimeoutMs(config, roleCount);
  const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;
  const timers: DetachedTimers = hooks.detachedTimers ?? {};
  // ONE sandbox geometry for the shared desktop (run-wide; per-role device is a prompt signal).
  const sandboxDevice = resolveLaneDevice(config, undefined);
  const sandboxResolution = sandboxDevice.resolution;
  const sandboxPreset: DevicePreset = sandboxDevice.preset;
  const perRunSandboxMs = config.execution?.desktop?.sandboxTimeoutMs
    ?? timeoutMs * Math.max(1, roleCount)
      + SUBJECT_PROVISION_BUDGET_MS
      + (config.subject.state?.seed ?? []).reduce((sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0)
      + SANDBOX_TIMEOUT_BUFFER_MS;

  // The provider caps a sandbox at MAX_SANDBOX_MS and refuses a longer request at create, after
  // nothing but a paid API call; on 2026-09-04 an explicit 15-minute execution.timeoutMs for two
  // seats did exactly that ("400: Timeout cannot be greater than 1 hours") and the refusal
  // surfaced as a bundle that failed verification. Say the arithmetic here, before any call.
  if (perRunSandboxMs > MAX_SANDBOX_MS) {
    const perRoleCeilingMs = Math.floor(
      (MAX_SANDBOX_MS - SUBJECT_PROVISION_BUDGET_MS - SANDBOX_TIMEOUT_BUFFER_MS
        - (config.subject.state?.seed ?? []).reduce((sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0))
      / Math.max(1, roleCount)
    );
    throw new Error(
      `the sequential shared-world sandbox would need ${Math.round(perRunSandboxMs / 60_000)} minutes `
        + `(${roleCount} role(s) x ${Math.round(timeoutMs / 1000)} s of session budget, plus ${SUBJECT_PROVISION_BUDGET_MS / 60_000} minutes of provisioning `
        + `and a ${SANDBOX_TIMEOUT_BUFFER_MS / 60_000}-minute reclamation buffer), over the provider's ${MAX_SANDBOX_MS / 60_000}-minute sandbox cap; `
        + `set execution.timeoutMs to at most ${perRoleCeilingMs} ms per role, or execution.desktop.sandboxTimeoutMs explicitly`
    );
  }

  const source = await buildRunSource({ capturedAt: createdAt, cwd, humanishSource: "present", packageName: "humanish" });

  const warnings: string[] = [];
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  const roleOutcomes: RoleOutcome[] = [];
  const baselineDeclared = declaredCheckpointSnapshot("cp-baseline", checkpoints);
  let baselineCheckpoint: SharedWorldCheckpoint = baselineDeclared;
  let subjectCommit: string | undefined;
  let sandboxId: string | undefined;
  let killed = false;
  let failFastReason: string | undefined;
  let sharedScreenGeometry: RunDesktopGeometry = {
    screen: { requested: { width: sandboxResolution[0], height: sandboxResolution[1] } }
  };

  // Pack the working tree ONCE per run, on the host, BEFORE any sandbox is created (mirrors the
  // cua route's ordering): a packing failure fails the run closed here, never spending sandbox
  // cost. Dry-run packs nothing (no fs side effects; the contract bundle carries no archiveSha256).
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
      process.stderr.write(
        `humanish shared-world local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}`
        + `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`
      );
    } catch (error) {
      return fail(
        "HUMANISH_SHARED_WORLD_LAB_FAILED",
        `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
        descriptor.id
      );
    }
  }

  if (!dryRun) {
    let desktopModule: E2BDesktopModule | undefined;
    let desktop: E2BDesktopSandbox | undefined;
    let runFailed = false;
    try {
      desktopModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
      // ONE Sandbox.create for the whole run (metadata.topology + roleCount; the SUBJECT env is
      // provisioned here on the clone route — the ACTOR key never enters the sandbox). An optional
      // custom desktop template (image) selects Sandbox.create(template, opts); absent keeps the
      // byte-stable Sandbox.create(opts) default.
      desktop = await createDesktopSandbox(desktopModule, {
        apiKey: e2bApiKey,
        requestTimeoutMs,
        timeoutMs: perRunSandboxMs,
        metadata: {
          ...SHARED_WORLD_LAB_PROVIDER_METADATA,
          labId: config.id,
          topology: "shared-world",
          roleCount: String(roleCount)
        },
        ...(subjectEnvNames.length > 0
          ? { envs: Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])) }
          : {}),
        resolution: sandboxResolution,
        dpi: 96,
        lifecycle: { onTimeout: "kill" }
      }, config.execution?.desktop?.template);
      sandboxId = desktop.sandboxId;
      // #358 salvage: durable id receipt the moment the plane sandbox exists.
      await appendSandboxReceipt(runPaths, { at: new Date().toISOString(), laneId: "subject", sandboxId });

      if (hooks.prepareDesktop) {
        await hooks.prepareDesktop(desktop);
      }

      const screenGeometry = await inspectDesktopScreenGeometry({
        desktop,
        laneId: "shared-world",
        requestedScreen: sandboxResolution,
        requestTimeoutMs
      });
      if (screenGeometry.verified) {
        sharedScreenGeometry = {
          screen: { ...sharedScreenGeometry.screen, verified: screenGeometry.verified }
        };
      }
      if (screenGeometry.warning) {
        warnings.push(screenGeometry.warning);
        sharedScreenGeometry = { ...sharedScreenGeometry, warnings: [screenGeometry.warning] };
      }
      if (screenGeometry.error) throw new Error(screenGeometry.error);

      // Provision the shared plane ONCE: clone + install/build + seed + serve + readiness probe
      // (clone route), or upload/extract the once-per-run packed archive + the SAME shared serve
      // pipeline (local-tree route). One stderr line per phase boundary by default; hooks.onPhase
      // (DI seam, mirrors CuaActorLabHooks) overrides it so tests capture instead of writing to
      // real stderr.
      const onSubjectPhase = hooks.onPhase ?? ((event: SubjectPhaseEvent) => {
        process.stderr.write(
          `humanish shared-world: ${event.message}${event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`}\n`
        );
      });
      if (localTreeRoute) {
        await provisionLocalTreeSubject(desktop, {
          archiveBuffer: localTreeArchiveBuffer!,
          serve,
          ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
          requestTimeoutMs,
          scrub: scrubKnownValues,
          onStateStep: (record) => { stateStepRecords.push(record); },
          onPhase: onSubjectPhase,
          ...timers
        });
      } else {
        subjectCommit = await provisionCloneSubject(desktop, {
          repo: subjectRepo,
          depth: config.subject.clone?.depth ?? 1,
          serve,
          ...(config.subject.state === undefined ? {} : { state: config.subject.state }),
          hasGithubToken,
          requestTimeoutMs,
          scrub: scrubKnownValues,
          onCommit: (commit) => { subjectCommit = commit; },
          onStateStep: (record) => { stateStepRecords.push(record); },
          onPhase: onSubjectPhase,
          ...timers
        });
      }

      // Baseline checkpoint (before any role acts).
      baselineCheckpoint = await runCheckpointSnapshot({
        desktop,
        snapshotIndex: 0,
        name: "cp-baseline",
        checkpoints,
        prevDigest: undefined,
        scrub: scrubKnownValues,
        requestTimeoutMs,
        timers
      });
      let prevDigest = baselineCheckpoint.digest;

      // Sequential per-role loop (DECLARED order). A HARNESS error blocks the REMAINING roles
      // (the shared-state premise is broken); a MISSION failure is data, never trips fail-fast.
      for (const [index, spec] of roleSpecs.entries()) {
        if (failFastReason) {
          roleOutcomes.push({
            spec,
            screenshots: [],
            skippedReason: `skipped: ${failFastReason}`,
            noEngagement: false,
            harnessError: false
          });
          continue;
        }

        const screenshots: string[] = [];
        const writeScreenshot = makeLaneWriteScreenshot(runPaths, { screenshotDir: spec.screenshotDir }, screenshots);
        let session: CuaLoopResult | undefined;
        let sessionError: string | undefined;
        let desktopBrowser: DesktopBrowserEvidence | undefined;
        let launchedBrowserFamily: DesktopBrowserFamily = "unknown";
        let browserLaunchIdentity: DesktopBrowserLaunchIdentity | undefined;
        let browserLaunched = false;
        let initialBrowserGeometry: Awaited<ReturnType<typeof captureDesktopBrowserGeometry>> | undefined;
        let browserWindowId: string | undefined;
        let browserTargetId: string | undefined;
        let desktopGeometry = sharedScreenGeometry;
        try {
          // Fresh isolated browser profile per seat, opened at the role's same-origin loopback entry.
          const browserLaunch = await launchSeatBrowser(desktop, {
            ...(config.execution?.desktop?.browser === undefined ? {} : { browserPreference: config.execution.desktop.browser }),
            profileDir: spec.profileDir,
            seatUrl: spec.seatUrl,
            requestTimeoutMs
          });
          desktopBrowser = browserLaunch.evidence;
          launchedBrowserFamily = browserLaunch.family;
          browserLaunchIdentity = browserLaunch.identity;
          browserLaunched = true;
          await desktop.wait(BROWSER_SETTLE_MS).catch(() => undefined);
          const browserGeometry = await captureDesktopBrowserGeometry({
            desktop,
            browserFamily: launchedBrowserFamily,
            ...(browserLaunchIdentity === undefined ? {} : { launchIdentity: browserLaunchIdentity }),
            laneId: spec.roleId,
            targetUrl: spec.seatUrl,
            requestedScreen: sandboxResolution,
            requestTimeoutMs
          });
          initialBrowserGeometry = browserGeometry;
          browserWindowId = browserGeometry.browserWindowId;
          browserTargetId = browserGeometry.browserTargetId;
          if (browserGeometry.unusable !== undefined) {
            throw new Error(`HUMANISH_CUA_LAB_DEVICE_GEOMETRY: ${browserGeometry.unusable} Participant actions were not started.`);
          }
          const sessionOptions: CuaActorSessionOptions = {
            instructions: spec.instructions,
            persona: spec.persona,
            timeoutMs,
            openai: {
              apiKey: openaiApiKey,
              ...(config.actors[0]?.model ? { model: config.actors[0]!.model } : {}),
              ...(spec.reasoningEffort === undefined ? {} : { reasoningEffort: spec.reasoningEffort })
            },
            desktop: desktop as unknown as E2BDesktopLike,
            ...(launchedBrowserFamily === "chromium"
              ? {
                  executorOptions: {
                    observeBrowserState: makeChromeBrowserStateObserver(
                      desktop,
                      requestTimeoutMs,
                      {
                        ...(browserLaunchIdentity?.cdpPort === undefined ? {} : { cdpPort: browserLaunchIdentity.cdpPort }),
                        ...(browserLaunchIdentity?.profileDir === undefined ? {} : { profileDir: browserLaunchIdentity.profileDir }),
                        targetUrl: spec.seatUrl
                      },
                      browserTargetId
                    )
                  }
                }
              : {}),
            redactScreenshots,
            scrubText: scrubKnownValues,
            writeScreenshot,
            ...(spec.stopWhen === undefined ? {} : { stopWhen: spec.stopWhen }),
            ...(spec.dwell === undefined ? {} : { dwell: spec.dwell })
          };
          session = await runSession(sessionOptions);
        } catch (error) {
          sessionError = redactText(scrubKnownValues(toErrorMessage(error)));
        }

        if (browserLaunched) {
          const finalGeometry: Awaited<ReturnType<typeof captureDesktopBrowserGeometry>> = await captureDesktopBrowserGeometry({
            desktop,
            browserFamily: launchedBrowserFamily,
            ...(browserLaunchIdentity === undefined ? {} : { launchIdentity: browserLaunchIdentity }),
            ...(browserWindowId === undefined ? {} : { browserWindowId }),
            ...(browserTargetId === undefined ? {} : { browserTargetId }),
            laneId: spec.roleId,
            targetUrl: spec.seatUrl,
            requestedScreen: sandboxResolution,
            requestTimeoutMs,
            resize: false
          }).catch((error: unknown) => ({
            warnings: [`Final browser geometry measurement failed for lane ${spec.roleId}: ${redactText(scrubKnownValues(toErrorMessage(error)))}`]
          }));
          // Chosen capture rule (mirrors runCuaLane): seat-end-if-it-measured-anything, else
          // seat-open. A seat-end capture that measured EITHER field wins whole, so a partial
          // seat-end capture omits fields the seat-open capture had (honest omission); only a
          // seat-end capture that measured NOTHING falls back to the seat-open capture.
          const chosenGeometry = finalGeometry.browserWindow !== undefined || finalGeometry.viewport !== undefined
            ? finalGeometry
            : initialBrowserGeometry ?? finalGeometry;
          const geometryWarnings = [...new Set([...(initialBrowserGeometry?.warnings ?? []), ...chosenGeometry.warnings].map((warning) => scrubKnownValues(warning)))];
          warnings.push(...geometryWarnings);
          desktopGeometry = {
            ...sharedScreenGeometry,
            ...(chosenGeometry.browserWindow === undefined ? {} : { browserWindow: chosenGeometry.browserWindow }),
            ...(chosenGeometry.viewport === undefined ? {} : { viewport: chosenGeometry.viewport }),
            ...((sharedScreenGeometry.warnings?.length ?? 0) + geometryWarnings.length === 0
              ? {}
              : { warnings: [...(sharedScreenGeometry.warnings ?? []), ...geometryWarnings] })
          };

          // End THIS seat's browser now that its turn (and its final geometry capture) is done:
          // every role shares the ONE desktop, so this is the per-seat identity boundary. Runs
          // after the final seat too. Bounded + best-effort: a failure degrades to an explicit
          // warning (the run continues), never a hang.
          try {
            await desktop.commands.run(
              buildSeatBrowserTerminationCommand(browserLaunchIdentity?.processId, spec.profileDir),
              { requestTimeoutMs, timeoutMs: SEAT_BROWSER_TERMINATION_TIMEOUT_MS }
            );
          } catch (error) {
            warnings.push(`Seat browser termination failed for role ${spec.roleId} (run continues; the seat's browser may remain open on the shared desktop): ${redactText(scrubKnownValues(toErrorMessage(error)))}`);
          }
        }

        if (session) {
          await writeContainedOutputFile(runPaths, spec.traceArtifactPath, `${JSON.stringify(session.trace, null, 2)}\n`, "utf8");
          if (session.trace.redaction.screenshots === "raw") {
            warnings.push("Screenshots are full-fidelity (raw) for local use — the bundle stays in gitignored .humanish and nothing scans these pixels; review them before sharing anywhere. Set policies.redactScreenshots: true to blur a share-as-is bundle.");
          }
        }

        const noEngagement = session !== undefined
          && session.completionReason === "goal_satisfied"
          && (session.trace.counts.actions ?? 0) === 0
          && (session.trace.counts.messages ?? 0) === 0;
        if (noEngagement) {
          warnings.push(`Role ${spec.roleId} returned goal_satisfied with ZERO actions and ZERO messages — likely a blank/still-loading screen; NOT counted as a pass.`);
        }
        const harnessError = sessionError !== undefined || session?.completionReason === "harness_error";

        // Checkpoint AFTER this role's turn (the interaction-proof snapshot). Runs even on a
        // harness-errored turn (the probe is read-only state, independent of the browser seat).
        const afterCheckpoint = await runCheckpointSnapshot({
          desktop,
          snapshotIndex: index + 1,
          name: `cp-after-${spec.roleId}`,
          checkpoints,
          prevDigest,
          scrub: scrubKnownValues,
          requestTimeoutMs,
          timers
        });
        prevDigest = afterCheckpoint.digest;

        roleOutcomes.push({
          spec,
          ...(session ? { session } : {}),
          ...(sessionError === undefined ? {} : { sessionError }),
          screenshots,
          ...(desktopBrowser === undefined ? {} : { desktopBrowser }),
          desktopGeometry,
          noEngagement,
          harnessError,
          afterCheckpoint
        });

        if (harnessError && !failFastReason) {
          failFastReason = `role "${spec.roleId}" ended in a harness error — the shared-state premise is broken (fail-fast)`;
        }
      }
    } catch (error) {
      runFailed = true;
      warnings.push(`Shared-world run failed before completion: ${redactText(scrubKnownValues(toErrorMessage(error)))}`);
    } finally {
      // ONE teardown BY exact sandboxId — NEVER Sandbox.list (the 2026-06-16 prod-incident rail).
      if (desktop && desktopModule) {
        const anyRoleFailed = runFailed
          || failFastReason !== undefined
          || roleOutcomes.some((outcome) => outcome.harnessError || outcome.sessionError !== undefined);
        // Each route's own keep flag gates its own run only: a clone.keep can never leak into a
        // local-tree run's teardown decision, and vice versa (mirrors runCuaLane's keepReason).
        const keepReason = config.subject.clone?.keep === true
          ? "subject.clone.keep"
          : config.subject.localTree?.keep === true
            ? "subject.localTree.keep"
            : undefined;
        const keepForDebug = keepReason !== undefined && anyRoleFailed;
        if (keepForDebug) {
          warnings.push(`Sandbox ${desktop.sandboxId} kept for debugging (${keepReason} on failure); reclaim it via E2B or it will be killed on its server-side timeout.`);
        } else if (typeof desktopModule.Sandbox.kill === "function") {
          try {
            await desktopModule.Sandbox.kill(desktop.sandboxId, { requestTimeoutMs: 60_000 });
            killed = true;
          } catch (error) {
            warnings.push(`Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrubKnownValues(toErrorMessage(error)))}`);
          }
        } else {
          warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox.");
        }
      }
    }
  }

  // Subject provenance (invariant 5): the ONE shared plane. Local-tree carries archiveSha256 (the
  // pin - one archive, so no per-lane unanimity math is needed, unlike the cua fan-out route) plus
  // the host-side commit/dirty when the packed root was a git work tree; clone carries repo/commit
  // as before. Mirrors laneSubjectProjection's local-tree branch in cua-actor-lab.ts.
  const subjectState = resolveSubjectState({
    declared: config.subject.state,
    dryRun,
    executed: stateStepRecords
  });
  const planeCommit = localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit;
  const subject: RunSubjectProvenance = localTreeRoute
    ? {
        source: "local-tree",
        ...(localTreeArchive === undefined ? {} : { archiveSha256: localTreeArchive.archiveSha256 }),
        ...(planeCommit === undefined ? {} : { commit: planeCommit }),
        ...(localTreeArchive?.git === undefined ? {} : { dirty: localTreeArchive.git.dirty }),
        envNames: subjectEnvNames,
        state: subjectState
      }
    : {
        source: "clone",
        repo: publicRepo,
        ...(subjectCommit === undefined ? {} : { commit: subjectCommit }),
        envNames: subjectEnvNames,
        state: subjectState
      };

  const bundle = buildSharedWorldBundle({
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    config,
    descriptor,
    createdAt,
    dryRun,
    runId,
    source,
    roleSpecs,
    roleOutcomes,
    baselineCheckpoint,
    subject,
    sandboxResolution,
    sandboxPreset,
    desktopGeometry: sharedScreenGeometry,
    seedDigest: seedRecipeDigest(config),
    ...(planeCommit === undefined ? {} : { subjectCommit: planeCommit }),
    ...(failFastReason === undefined ? {} : { failFastReason })
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
      backend: "shared-world",
      dryRun,
      laneCount: roleSpecs.length
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "sharedWorldHooks",
    ...(options.scorerProvenance === undefined ? {} : { scorerProvenance: options.scorerProvenance })
  });

  await validatePreparedRunArtifactPaths(runPaths);
  await writeContainedOutputFile(runPaths, "run.json", `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  // Finalize identity+liveness from the bundle just written; a throw before this leaves the record
  // stale, which reads as interrupted rather than as a false outcome (#455).
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
  await writeContainedOutputFile(runPaths, "review.json", `${JSON.stringify(bundle.review, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "review.md", renderSharedWorldReviewMarkdown(bundle), "utf8");
  await writeContainedOutputFile(runPaths, "events.ndjson", `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({ schema: "humanish.latest-run.v1", runId, path: runPaths.relativeRunRoot, updatedAt: createdAt }, null, 2)}\n`,
    "utf8"
  );

  const observer = await render(cwd, runId, { open: options.open === true });

  const roleOk = (outcome: RoleOutcome | undefined): boolean => {
    return sharedWorldRoleOutcomeOk(outcome, dryRun);
  };
  const allRolesOk = roleSpecs.every((_, index) => roleOk(roleOutcomes[index]));
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok = observer.ok && allRolesOk && failFastReason === undefined && adapterFailure === undefined && scorerResult.declaredVerdictFailure === undefined;
  const allWarnings = [...warnings, ...adapterWarnings, ...observer.warnings];

  const roles: SharedWorldRoleResult[] = roleSpecs.map((spec, index) => {
    const outcome = roleOutcomes[index];
    const base = { id: spec.roleId, index: spec.roleIndex + 1, persona: spec.persona.id, profileDir: spec.profileDir };
    if (dryRun || !outcome) {
      return { ...base, status: "contract_proof_only" as const, ok: dryRun };
    }
    if (outcome.skippedReason !== undefined) {
      return {
        ...base,
        status: "blocked" as const,
        ok: false,
        skippedReason: outcome.skippedReason,
        error: { code: "HUMANISH_SHARED_WORLD_LAB_FAILED" as const, message: outcome.skippedReason }
      };
    }
    const session = outcome.session;
    const thisOk = roleOk(outcome);
    return {
      ...base,
      status: session ? session.status : ("failed" as const),
      ok: thisOk,
      ...(session
        ? { session: { status: session.status, completionReason: session.completionReason, reason: session.reason, screenshots: outcome.screenshots.length } }
        : {}),
      ...(thisOk
        ? {}
        : {
            error: {
              code: "HUMANISH_SHARED_WORLD_LAB_FAILED" as const,
              message: outcome.sessionError
                ?? (outcome.noEngagement
                  ? "Role took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
                  : session?.completionReason === "harness_error"
                    ? `Role seat ended with a harness error: ${session.reason}`
                    : "Role did not produce a terminal session.")
            }
          })
    };
  });

  const sequence = roleOutcomes
    .filter((outcome) => outcome.skippedReason === undefined && outcome.afterCheckpoint !== undefined)
    .map((outcome) => outcome.spec.roleId);

  const errorResult = ((): SharedWorldLabResult["error"] | undefined => {
    if (ok) return undefined;
    if (!observer.ok) {
      return { code: "HUMANISH_SHARED_WORLD_LAB_FAILED", message: observer.error?.message ?? "Observer failed for the shared-world run." };
    }
    if (adapterFailure !== undefined) {
      return { code: "HUMANISH_SHARED_WORLD_LAB_FAILED", message: adapterFailure };
    }
    const passed = roles.filter((role) => role.ok).length;
    return {
      code: "HUMANISH_SHARED_WORLD_LAB_FAILED",
      message: `Shared-world run failed: ${passed}/${roleCount} role(s) passed${failFastReason ? ` (fail-fast: ${failFastReason})` : ""}.`
    };
  })();

  return {
    schema: SHARED_WORLD_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptor.id,
    topology: "shared-world",
    roleCount,
    sequence,
    dryRun,
    runId,
    ...(sandboxId === undefined ? {} : { sandbox: { sandboxId, killed } }),
    subject,
    roles,
    observer,
    warnings: allWarnings,
    ...(errorResult === undefined ? {} : { error: errorResult })
  };
}

/** Project the shared-world run into a humanish.run-bundle.v1 with the sharedWorld evidence block. */
export function buildSharedWorldBundle(args: {
  /** Lab provenance for the bundle\'s own `lab` field (#455). */
  lab?: RunLabProvenance;
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  createdAt: string;
  dryRun: boolean;
  runId: string;
  source: RunBundle["source"];
  roleSpecs: RoleSpec[];
  roleOutcomes: RoleOutcome[];
  baselineCheckpoint: SharedWorldCheckpoint;
  subject: RunSubjectProvenance;
  sandboxResolution: [number, number];
  sandboxPreset: DevicePreset;
  desktopGeometry?: RunDesktopGeometry;
  seedDigest: string;
  subjectCommit?: string;
  failFastReason?: string;
}): RunBundle {
  const { config, descriptor, createdAt, dryRun, roleSpecs, roleOutcomes } = args;
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [];
  const appUrl = config.subject.serve?.url ?? "";

  events.push({
    id: "event-000-created",
    at: createdAt,
    level: "info",
    type: "shared-world.run.created",
    message: `Created shared-world run for ${config.id} (actor ${descriptor.id}, ${roleSpecs.length} role(s), ONE shared plane, sequential turns).`
  });
  // Human-readable plane label, byte-stable for the clone route: "clone of <repo>[@<commit>]".
  // The local-tree route has no repo slug, so it labels the packed archive instead (archiveSha256
  // + dirty/clean when the packed root was a git work tree).
  const dryRunPlaneLabel = args.subject.source === "local-tree"
    ? "packed working tree"
    : `clone of ${args.subject.repo}`;
  const livePlaneLabel = args.subject.source === "local-tree"
    ? (args.subject.archiveSha256
        ? `packed working tree (archiveSha256 ${args.subject.archiveSha256}${args.subject.dirty === true ? ", dirty working tree" : args.subject.dirty === false ? ", clean working tree" : ""})`
        : "packed working tree (archive digest unresolved; provisioning failed before resolution)")
    : `clone of ${args.subject.repo}${args.subjectCommit ? `@${args.subjectCommit}` : ""}`;
  events.push({
    id: "event-001-plane",
    at: createdAt,
    level: "info",
    type: "shared-world.plane.provenance",
    message: dryRun
      ? `Shared plane declared: ${dryRunPlaneLabel}, served at ${appUrl} in-sandbox (dry-run contract; nothing ${args.subject.source === "local-tree" ? "packed" : "cloned"}). Seed recipe ${args.seedDigest}; env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted).`
      : `Shared plane: ${livePlaneLabel}, served at ${appUrl} in-sandbox; seed recipe ${args.seedDigest}; env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted).`,
    simId: roleSpecs[0]?.simId ?? "sim-001",
    streamId: roleSpecs[0]?.streamId ?? "stream-001"
  });

  let eventSeq = 2;
  const nextEventId = (suffix: string): string => `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  roleSpecs.forEach((spec, index) => {
    const outcome = roleOutcomes[index];
    const session = outcome?.session;
    const desktopGeometry = outcome?.desktopGeometry ?? args.desktopGeometry ?? {
      screen: { requested: { width: args.sandboxResolution[0], height: args.sandboxResolution[1] } }
    };
    const screenshots = outcome?.screenshots ?? [];
    const lastScreenshot = screenshots[screenshots.length - 1];
    const status: RunSimulationStatus = outcome?.skippedReason !== undefined
      ? "blocked"
      : session
        ? session.status
        : outcome?.sessionError
          ? "failed"
          : "contract_proof_only";
    const reason = outcome?.skippedReason
      ?? session?.reason
      ?? outcome?.sessionError
      ?? "Contract role only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.";
    const traceScreenshotMode = session?.trace.redaction.screenshots;
    const screenshotMode: "raw" | "blurred" =
      traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
        ? traceScreenshotMode
        : config.policies?.redactScreenshots === true ? "blurred" : "raw";

    simulations.push({
      id: spec.simId,
      index: index + 1,
      personaId: spec.persona.id,
      scenarioId: `shared-world-${config.id}`,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: 100,
      currentStep: reason,
      summary: session
        ? `Role ${spec.roleId} (${spec.persona.id}): drove the shared app; ${session.completionReason}.`
        : outcome?.skippedReason !== undefined
          ? `Role ${spec.roleId} ${outcome.skippedReason}.`
          : outcome?.sessionError
            ? `Role ${spec.roleId} failed before a terminal session verdict: ${outcome.sessionError}`
            : `Contract role ${spec.roleId} (${spec.persona.id}) for ${descriptor.id} against the shared plane at ${appUrl}.`,
      streamIds: [spec.streamId],
      startedAt: createdAt,
      updatedAt: createdAt
    });

    streams.push({
      id: spec.streamId,
      simId: spec.simId,
      kind: "browser",
      label: `Shared-world role ${spec.roleId} — ${config.id}`,
      status,
      transport: "snapshot",
      updatedAt: createdAt,
      embed: lastScreenshot
        ? { kind: "screenshot", url: lastScreenshot, title: `Shared desktop, role ${spec.roleId} (${screenshotMode})` }
        : { kind: "placeholder", title: `Shared desktop, role ${spec.roleId}` },
      ...(desktopGeometry.viewport === undefined
        ? {}
        : {
            viewport: {
              width: desktopGeometry.viewport.width,
              height: desktopGeometry.viewport.height,
              deviceScaleFactor: desktopGeometry.viewport.deviceScaleFactor,
              isMobile: args.sandboxPreset.isMobile
            }
          }),
      desktopGeometry,
      ui: {
        route: spec.seatUrl,
        intent: `Watch role ${spec.roleId} (${spec.persona.id}) drive the SHARED app (one plane; sequential turn).`,
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
          ? [{ label: `role ${spec.roleId} actor trace`, path: spec.traceArtifactPath, kind: "trace" as const }]
          : []),
        ...screenshots.map((screenshot, screenshotIndex) => ({
          label: `role ${spec.roleId} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
          path: screenshot,
          kind: "screenshot" as const
        }))
      ]
    });

    // Per-role session event.
    if (session) {
      events.push({
        id: nextEventId(`session-${spec.roleId}`),
        at: createdAt,
        level: session.status === "passed" ? "info" : "warn",
        type: `shared-world.session.${session.completionReason}`,
        message: `Role ${spec.roleId}: ${session.status} — ${session.reason}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (outcome?.skippedReason !== undefined) {
      events.push({
        id: nextEventId(`blocked-${spec.roleId}`),
        at: createdAt,
        level: "warn",
        type: "shared-world.session.blocked",
        message: `Role ${spec.roleId} ${outcome.skippedReason}.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (outcome?.sessionError) {
      events.push({
        id: nextEventId(`session-error-${spec.roleId}`),
        at: createdAt,
        level: "error",
        type: "shared-world.session.error",
        message: `Role ${spec.roleId}: ${outcome.sessionError}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else {
      events.push({
        id: nextEventId(`contract-${spec.roleId}`),
        at: createdAt,
        level: "info",
        type: "shared-world.contract.ready",
        message: `Role ${spec.roleId}: dry-run contract role ready; switch scenario.mode to live for a real shared-world session.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }

    for (const warning of desktopGeometry.warnings ?? []) {
      events.push({
        id: nextEventId(`geometry-warning-${spec.roleId}`),
        at: createdAt,
        level: "warn",
        type: "shared-world.geometry.warning",
        message: warning,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }
  });

  // Build the shared-world evidence block (the timeline + plane + attribution ceiling).
  const seedDigest = args.seedDigest;
  const planeCommit = dryRun ? undefined : args.subjectCommit;
  const timeline: SharedWorldTimelineEntry[] = [args.baselineCheckpoint];
  const sequence: string[] = [];
  if (dryRun) {
    // Declared (contract) timeline: every role would take a turn; recipe-digest checkpoints, no delta.
    roleSpecs.forEach((spec) => {
      timeline.push({
        kind: "turn",
        roleId: spec.roleId,
        simId: spec.simId,
        streamId: spec.streamId,
        seedDigest
      });
      timeline.push(declaredCheckpointSnapshot(`cp-after-${spec.roleId}`, config.subject.state?.checkpoint ?? []));
      sequence.push(spec.roleId);
    });
  } else {
    // Executed timeline: only roles that took a turn (skipped roles contribute nothing).
    for (const outcome of roleOutcomes) {
      if (outcome.skippedReason !== undefined || outcome.afterCheckpoint === undefined) {
        continue;
      }
      timeline.push({
        kind: "turn",
        roleId: outcome.spec.roleId,
        simId: outcome.spec.simId,
        streamId: outcome.spec.streamId,
        ...(planeCommit === undefined ? {} : { commit: planeCommit }),
        seedDigest
      });
      timeline.push(outcome.afterCheckpoint);
      sequence.push(outcome.spec.roleId);
    }
  }

  const sharedWorld: SharedWorldEvidence = {
    schema: SHARED_WORLD_SCHEMA,
    topology: "shared-world",
    topologyMode: "sequential",
    roleCount: roleSpecs.length,
    plane: {
      ...(planeCommit === undefined ? {} : { commit: planeCommit }),
      seedDigest,
      envNames: args.subject.envNames ?? []
    },
    sequence,
    timeline,
    attributionLimits: ["sequential-only", "no-concurrent-races", "delta-attributed-to-turn-not-action"]
  };

  events.push({
    id: nextEventId("timeline"),
    at: createdAt,
    level: "info",
    type: "shared-world.timeline",
    message: `Interaction timeline: ${timeline.length} entries (${sequence.length} turn(s) interleaved with checkpoints); deltas observed on ${timeline.filter((entry) => entry.kind === "checkpoint" && entry.deltaFromPrev).map((entry) => (entry as SharedWorldCheckpoint).name).join(", ") || "none"}. Attribution ceiling: ${sharedWorld.attributionLimits.join(", ")}.`
  });
  if (args.failFastReason) {
    events.push({
      id: nextEventId("fail-fast"),
      at: createdAt,
      level: "warn",
      type: "shared-world.fail-fast",
      message: `Fail-fast: ${args.failFastReason}. Remaining roles were blocked; completed evidence is retained.`
    });
  }

  // Worst-of review verdict across roles.
  const verdict: ReviewSummary["verdict"] = dryRun
    ? "contract_proof_only"
    : (() => {
        const allPassed = roleOutcomes.length === roleSpecs.length
          && roleOutcomes.every((outcome) => sharedWorldRoleOutcomeOk(outcome, false));
        if (allPassed) return "pass";
        const anyFail = roleOutcomes.some((outcome) =>
          outcome.skippedReason !== undefined
          || outcome.harnessError
          || outcome.noEngagement
          || outcome.sessionError !== undefined
          || outcome.session === undefined
          || outcome.session.status === "failed"
          || outcome.session.status === "blocked");
        if (anyFail) return "fail";
        if (roleOutcomes.some((outcome) => outcome.session?.status === "timed_out")) return "timed_out";
        return "fail";
      })();
  const passedRoles = roleOutcomes.filter((outcome) =>
    sharedWorldRoleOutcomeOk(outcome, dryRun)).length;
  const configuredBrowser = config.execution?.desktop?.browser;
  const resolvedBrowsers = roleOutcomes
    .map((outcome) => outcome.desktopBrowser?.resolved)
    .filter((value): value is string => value !== undefined);
  const unanimousResolvedBrowser = resolvedBrowsers.length > 0 && new Set(resolvedBrowsers).size === 1
    ? resolvedBrowsers[0]
    : undefined;

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict,
    summary: dryRun
      ? `Dry-run shared-world contract: ${roleSpecs.length} role(s) declared against ONE plane (${descriptor.id}) at ${appUrl}; no desktop launched, $0 spend.`
      : `Shared-world run (ONE plane, sequential): ${passedRoles}/${roleSpecs.length} role(s) reached a terminal, engaged verdict; ${timeline.filter((entry) => entry.kind === "checkpoint" && entry.deltaFromPrev).length} checkpoint delta(s) observed.`,
    gaps: dryRun
      ? ["Live shared-world session not yet run (dry-run contract only)."]
      : roleOutcomes
          .filter((outcome) =>
            outcome.skippedReason !== undefined
            || outcome.sessionError !== undefined
            || outcome.noEngagement
            || outcome.session === undefined
            || outcome.session.status !== "passed")
          .map((outcome) => `${outcome.spec.roleId}: ${outcome.skippedReason ?? outcome.sessionError ?? outcome.session?.reason ?? "did not pass"}`)
  };

  const anyRaw = roleOutcomes.some((outcome) => outcome.session?.trace.redaction.screenshots === "raw");
  const ranLive = roleOutcomes.some((outcome) => outcome.session !== undefined || outcome.sessionError !== undefined);

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: dryRun ? "dry-run" : "live",
    simCount: roleSpecs.length,
    createdAt,
    cwd: PUBLIC_TARGET_CWD,
    ...(args.lab === undefined ? {} : { lab: args.lab }),
    artifactRoot: path.join(".humanish", "runs", args.runId),
    source: args.source,
    persona: {
      id: roleSpecs[0]?.persona.id ?? "shared-world-role",
      name: `Shared-world roster (${roleSpecs.length} roles)`,
      source: `lab:${config.id}`,
      sourceDigest: roleSpecs[0]?.persona.promptDigest ?? seedDigest
    },
    scenario: {
      id: `shared-world-${config.id}`,
      title: config.title ?? `Shared-world: ${config.id}`,
      goal: redactText(roleSpecs[0]?.instructions ?? "Shared-world sequential interaction."),
      source: `lab:${config.id}`,
      sourceDigest: roleSpecs[0]?.persona.promptDigest ?? seedDigest
    },
    lifecycle: [
      {
        at: createdAt,
        event: "shared-world.run.created",
        message: `Created shared-world run with ONE shared plane and ${roleSpecs.length} sequential role seats (actor ${descriptor.id}).`
      }
    ],
    simulations,
    streams,
    events,
    redaction: {
      status: "passed",
      notes: ranLive
        ? anyRaw
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Some roles captured FULL-FIDELITY (raw) screenshots, retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle. Checkpoints persist digest-only."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle. Checkpoints persist digest-only."
        : "Dry-run shared-world contract bundle: no desktop launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs. Checkpoints persist digest-only."
    },
    artifacts: {
      run: "run.json",
      reviewJson: "review.json",
      reviewMarkdown: "review.md",
      observerData: "observer/observer-data.json",
      events: "events.ndjson"
    },
    review,
    feedbackCandidates: [],
    // Custom desktop image provenance (the ONE shared plane launched on it); omitted on the default.
    ...(config.execution?.desktop?.template === undefined ? {} : { desktopTemplate: config.execution.desktop.template }),
    ...(configuredBrowser === undefined
      ? {}
      : { desktopBrowser: { requested: configuredBrowser, ...(unanimousResolvedBrowser === undefined ? {} : { resolved: unanimousResolvedBrowser }) } }),
    subject: args.subject,
    attributionClass: "shared-world",
    sharedWorld
  };
}

function sharedWorldRoleOutcomeOk(outcome: RoleOutcome | undefined, dryRun: boolean): boolean {
  if (dryRun) return true;
  if (!outcome || outcome.skippedReason !== undefined) return false;
  return outcome.session !== undefined
    && outcome.session.status === "passed"
    && outcome.session.completionReason !== "harness_error"
    && outcome.sessionError === undefined
    && !outcome.noEngagement;
}

function renderSharedWorldReviewMarkdown(bundle: RunBundle): string {
  const plane = bundle.events.find((event) => event.type === "shared-world.plane.provenance");
  const timeline = bundle.events.find((event) => event.type === "shared-world.timeline");
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- attribution class: ${bundle.attributionClass ?? "isolated"}`,
    `- topology: ${bundle.sharedWorld?.topology ?? "(none)"}`,
    `- roles: ${bundle.sharedWorld?.roleCount ?? 0}; sequence: ${(bundle.sharedWorld?.sequence ?? []).join(" → ") || "(none)"}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    ...(plane ? [`- plane: ${plane.message}`] : []),
    ...(timeline ? [`- timeline: ${timeline.message}`] : []),
    ...(bundle.sharedWorld ? [`- attribution limits: ${bundle.sharedWorld.attributionLimits.join(", ")}`] : []),
    ...(bundle.review.gaps.length > 0 ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)] : []),
    ""
  ].join("\n");
}
