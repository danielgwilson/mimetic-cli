// The CONCURRENT shared-world lab backend (#164 phase 2): N persona lanes drive ONE shared,
// mutable service plane SIMULTANEOUSLY — the actual leverage of a sim. A recomposition of shipped
// pieces + the getHost wrapper:
//
//   - ONE SUBJECT sandbox: provisionCloneSubject ONCE (clone+install+build+seed) + serve on
//     0.0.0.0, exposed via getHost(port) → a tokenless reachable URL (the headless service host;
//     no GUI seat).
//   - N ACTOR desktop sandboxes: fan-out's runCuaLane machinery (per-lane device/persona, by-id
//     teardown) bounded by execution.concurrency, each browser pointed at the getHost URL —
//     driving the shared service AT THE SAME TIME. INDEPENDENT (FIX-11): no pipeline gate, no
//     fail-fast — one actor's failure must not block the swarm or corrupt the "M of N" outcomes.
//   - A background prober snapshots the subject DB checkpoint digests on a cadence → a stateSeries
//     of the shared world evolving under load.
//   - ALL N+1 sandboxes torn down BY exact id in a finally — NEVER Sandbox.list.
//
// HONEST ATTRIBUTION (verify-enforced, doctrine-audit fixes incorporated): the bundle declares
// attributionClass: shared-world + a CONCURRENT humanish.shared-world.v1 block (topologyMode
// "concurrent"; laneWindows + stateSeries + outcomes; NO timeline) whose attributionLimits drop
// `sequential-only`/`no-concurrent-races` and add `concurrent`,
// `best-effort-causal-attribution`, `non-deterministic-shared-state`,
// `window-and-snapshot-granularity`, `contention-observed-not-proven-safe`,
// `state-change-not-isolated-to-actors`. laneWindows + stateSeries are INDEPENDENT series with NO
// per-delta→actor field — causation under concurrency is structurally inexpressible.
//
// CAPABILITY vs PROOF (FIX-1): the deterministic $0 gate proves the PLUMBING + the honesty
// contract — the real mapWithConcurrency produces genuinely overlapping laneWindows (a rendezvous
// latch in the fake session forces two lane fns in-flight while the REAL orchestrator clock
// measures the windows). Every generated bundle describes only its own observations; no one run
// establishes scale, repeatability, or adopter-harness replacement.
//
// Synthetic-subject (FIX-3): a getHost URL is internet-reachable for the run, so this route is
// synthetic-seeded-subjects ONLY. Verify fail-closes on subject.state.provenance != "seeded" and
// requires the author attestation subject.exposure: synthetic. This is author-trust + a provenance
// gate, NOT a no-real-data guarantee (Humanish cannot tell synthetic from real data).

import { randomBytes } from "node:crypto";
import { describeMissingKeys } from "./key-resolution.js";
import { beginRunStatus, type RunLabProvenance, type RunStatusHandle , withRunStatusScope} from "./run-status.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  adapterScoreFailureMessage,
  applyBrowserAdapterHooks
} from "./adapter-extension.js";
import { DEFAULT_OPENAI_CU_MODEL } from "./openai-responses-cu.js";
import { MODEL_RATES } from "./pricing.js";
import { actorRegistry, isCuaActorDescriptor, type CuaActorDescriptor } from "./actor-registry.js";
import { toErrorMessage } from "./command-failure.js";
import { mapWithConcurrency } from "./concurrency.js";
import { appendSandboxReceipt } from "./sandbox-receipts.js";
import { labPersonaIds, resolveCommittedPersonasForCwd } from "./persona-resolve.js";
import type { ResolvedPersona } from "./persona.js";
import {
  commandDigestOf,
  composeLaneInstructions,
  defaultPackLocalTree,
  provisionCloneSubject,
  provisionLocalTreeSubject,
  declaredScreenForRender,
  inboxRecipientFor,
  laneHasInboxRecipient,
  resolveLaneDevice,
  resolveSubjectState,
  runCuaLane,
  makeCuaRunBudget,
  withInboxMission,
  type CuaActorLabHooks,
  type CuaLaneDeps,
  type CuaLaneSpec,
  type LaneRunOutcome,
  type SubjectPhaseEvent
} from "./cua-actor-lab.js";
import { DEFAULT_SANDBOX_CATCH_PORT, collectCommsThread, collectExternalCommsThread, deployCommsCatch, externalCatchHealthy, externalInboxUrl, refreshInboxSurface, writeInboxSurface, type DeployedCommsCatch } from "./comms-sandbox-catch.js";
import { FakeInbox } from "./comms-fake-inbox.js";
import { buildOriginMap, type OriginMap } from "./comms-inbox.js";
import type { CommsAddress } from "./comms-types.js";
import {
  createDesktopSandbox,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import type { DetachedTimers } from "./e2b-detached.js";
import {
  concurrentSharedWorldValidationReason,
  outputTokenLimitValidationReason,
  externalPublicSharedWorldValidationReason,
  type LabActorLane,
  type LabConfig
} from "./lab-config.js";
import { buildObserverData } from "./observer-data.js";
import {
  attachObserverRuntimeStreamUrls,
  renderObserver,
  type ObserverResult,
  type ObserverRuntimeStreamUrl
} from "./observer.js";
import { redactText } from "./redaction.js";
import {
  prepareRunArtifactPaths,
  validatePreparedRunArtifactPaths,
  type PreparedRunArtifactPaths
} from "./run-paths.js";
import { writeContainedOutputFile, writePreparedRunLatestPointer } from "./selected-output-paths.js";
import {
  combineCheckpointDigest,
  runCheckpointSnapshot,
  seedRecipeDigest,
  type SharedWorldLabHooks
} from "./shared-world-lab.js";
import type { LocalTreeArchive } from "./source-archive.js";
import {
  buildRunSource,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  SHARED_WORLD_SCHEMA,
  type ReviewSummary,
  type RunBundle,
  type RunEvent,
  type RunScorerProvenance,
  type RunSimulation,
  type RunSimulationStatus,
  type RunStream,
  type RunSubjectProvenance,
  type RunSubjectStateStepRecord,
  type SharedWorldEvidence,
  type SharedWorldLaneWindow,
  type SharedWorldOutcome,
  type SharedWorldPlane,
  type SharedWorldStateSnapshot
} from "./run.js";

export const CONCURRENT_SHARED_WORLD_LAB_SCHEMA = "humanish.concurrent-shared-world-lab-result.v1";

export const CONCURRENT_SHARED_WORLD_PROVIDER_METADATA = {
  mode: "concurrent-shared-world-lab",
  tool: "humanish"
} as const;

// The verify-enforced CONCURRENT attribution ceiling (FIX-5). Mirrored in run.ts's required set.
export const CONCURRENT_ATTRIBUTION_LIMITS = [
  "concurrent",
  "best-effort-causal-attribution",
  "non-deterministic-shared-state",
  "window-and-snapshot-granularity",
  "contention-observed-not-proven-safe",
  "state-change-not-isolated-to-actors"
] as const;

// The DEFAULT per-seat session budget is DERIVED, not flat. On a provisioned route the binding
// constraint is the SUBJECT sandbox (it must outlive every seat: timeoutMs + provisioning +
// seeding + teardown buffer, and E2B refuses a sandbox over one hour), so the derivation hands
// each seat the most that cap allows — capped at 15 minutes, floored at the historical 300s so a
// seed-heavy lab never gets LESS room than it always had. App-url seats have no subject sandbox
// and default to 30 minutes (seat sandbox: 30m + 10m buffer stays well under the hour). An
// explicit execution.timeoutMs is never adjusted. The handoff latch scales off this (40%).
const MAX_SANDBOX_MS = 60 * 60_000;
const MAX_DERIVED_SEAT_SESSION_MS = 15 * 60_000;
const MIN_DERIVED_SEAT_SESSION_MS = 300_000;
const DEFAULT_APP_URL_SEAT_SESSION_MS = 30 * 60_000;
function defaultSeatSessionTimeoutMs(config: LabConfig): number {
  const provisionedRoute = config.subject.source === "clone" || config.subject.source === "local-tree";
  if (!provisionedRoute) return DEFAULT_APP_URL_SEAT_SESSION_MS;
  const stateBudgetMs = (config.subject.state?.seed ?? []).reduce(
    (sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0);
  const room = MAX_SANDBOX_MS - SUBJECT_PROVISION_BUDGET_MS - stateBudgetMs - SANDBOX_TIMEOUT_BUFFER_MS;
  return Math.max(MIN_DERIVED_SEAT_SESSION_MS, Math.min(MAX_DERIVED_SEAT_SESSION_MS, room));
}
const SANDBOX_TIMEOUT_BUFFER_MS = 10 * 60_000;
const SUBJECT_PROVISION_BUDGET_MS = 30 * 60_000;
const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PROBER_CADENCE_MS = 1000;

const DEFAULT_MISSION =
  "You are one of MANY users hitting a shared web application at the same time. The browser is already open at the app. Accomplish your role's task, then stop.";

export interface RunConcurrentSharedWorldLabOptions {
  /** Which manifest produced this run (#455); threaded into the status record + bundle. */
  lab?: RunLabProvenance;
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  hooks?: SharedWorldLabHooks;
  /** Present only when the browser-route scorer hooks were CONFIG-DECLARED and loaded by the CLI
   *  (#316); core-stamped onto the bundle as evidence. Absent for library callers. */
  scorerProvenance?: RunScorerProvenance;
}

export type ConcurrentSharedWorldLabErrorCode =
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_GETHOST_UNAVAILABLE"
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT"
  /** A declared adopter-hosted comms catch (#328) did not answer as a humanish catch — fail closed
   *  BEFORE any actor spend, since the funnel would silently collect nothing. */
  | "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_CATCH_UNREACHABLE";

/** The two plane classes of the concurrent shared-world route (#164 phase 2). */
export type ConcurrentSharedWorldPlaneClass = "provisioned-getHost" | "external-public";

// EXTERNAL-PUBLIC plane class: the honest-downgrade attribution ceiling. The concurrent family
// (an honest ceiling) PLUS the mandatory external-public disclosures — mirrored in run.ts's required
// set (CONCURRENT_ATTRIBUTION_LIMITS + EXTERNAL_PUBLIC_EXTRA_LIMITS). Verify fails closed on a missing one.
export const EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS = [
  ...CONCURRENT_ATTRIBUTION_LIMITS,
  "external-public-plane",
  "operator-attested-target-not-harness-controlled",
  "no-synthetic-attestation",
  "no-authoritative-shared-state-proof",
  "concurrency-by-temporal-co-occupancy-only"
] as const;

// The FLOOR for the host-first handoff barrier deadline (ms). The host seat must surface a
// shared-session (/lobby/CODE) URL within the deadline or the run fails closed and no follower
// opens. The effective deadline SCALES with the per-seat run budget (execution.timeoutMs): a fixed
// 2 min is too tight for a real create-a-lobby flow on a mobile-layout seat once you subtract the
// seat's own desktop provisioning — the host reaches /lobby/CODE, but after the followers already
// gave up. So use max(FLOOR, 40% of the budget), capped at the budget. The latch resolves the
// instant the host actually reaches /lobby, so a generous ceiling only affects the fail-closed case.
const DEFAULT_HANDOFF_DEADLINE_MS = 120_000;
const HANDOFF_DEADLINE_BUDGET_FRACTION = 0.4;
// Per-seat runaway backstop for the vision-off-frame lobby-code read (used by the host to LATCH the
// handoff code, and by each follower to independently OBSERVE its own code for the convergence proof):
// at most this many single-frame reads before the seat is assumed to be somewhere without a code. Each
// reader stops the instant it has what it needs, so in practice only a handful fire (a seat reaches its
// /lobby within a few turns). NOTE: these reads are out-of-band OpenAI calls (external-public route
// only) and are NOT counted against execution.caps.maxUsd — this hard cap is what bounds their spend
// instead (each read is one cheap single-frame OCR call). If this route ever runs under a strict
// budget, fold the estimate in.
const MAX_LOBBY_CODE_VISION_READS = 30;
// Idle/no-progress backstop for the HOST lane specifically (default is 6/8). The host legitimately sits
// on an unchanging waiting-room screen while followers provision and join; it must not give up first.
const HOST_WAIT_IDLE_STEPS = 80;
const FOLLOWER_WAIT_IDLE_STEPS = 40;

/**
 * The lobby-trivia (and general "/lobby/CODE") shared-session URL matcher. A code is exactly 6 chars of
 * the [A-Z2-9] class; a locale prefix (/en/lobby/…) and a query/hash suffix are tolerated. RUNTIME-ONLY
 * input (a live location.href); only the extracted CODE is used, and it lands only as a digest.
 */
export const LOBBY_CODE_PATTERN = /\/lobby\/([A-Z2-9]{6})(?:$|[/?#])/;

/** Extract the shared-session CODE from a (runtime-only) observed URL, or undefined. Exported for the
 *  handoff regex table test — pure, no side effects, never persists its input. */
export function extractLobbyCode(url: string | undefined): string | undefined {
  if (typeof url !== "string") return undefined;
  const match = url.match(LOBBY_CODE_PATTERN);
  return match ? match[1] : undefined;
}

/**
 * Extract a lobby CODE from free-form ACTOR NARRATION (the host's reasoning/message where it states
 * the lobby URL it sees), where the /lobby/CODE is followed by arbitrary prose (a space, backtick,
 * newline) rather than end-of-string or /?# — so the strict LOBBY_CODE_PATTERN would miss it. Uses a
 * negative-lookahead boundary (exactly 6 code chars). This is the CDP-INDEPENDENT handoff path: the
 * host reads the code on screen and states it, and this reads it from the model's own text. Pure;
 * input is runtime-only; only the code is used (as a digest).
 */
const LOBBY_CODE_IN_TEXT = /\/lobby\/([A-Z2-9]{6})(?![A-Z2-9])/;
export function extractLobbyCodeFromNarration(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const inUrl = text.match(LOBBY_CODE_IN_TEXT);
  if (inUrl) return inUrl[1];
  // Fallback: an explicitly-labeled bare code (e.g. "LOBBY_CODE=ABC123"), which the host may state
  // if it copied the code rather than the URL. The label is matched case-insensitively, but the CODE
  // itself must be UPPERCASE [A-Z2-9] — a real lobby code always renders uppercase, whereas an /i match
  // on the code class would also grab an ordinary lowercase word after "lobby code " (e.g. "the lobby
  // code screen") and latch a WRONG code. Precision-first, matching parseLobbyCodeReply's rationale.
  const labeled = text.match(/lobby[ _-]?code[=:\s]+([A-Z2-9]{6})(?![A-Za-z2-9])/i);
  return labeled && labeled[1] && /^[A-Z2-9]{6}$/.test(labeled[1]) ? labeled[1] : undefined;
}

/** Pull the assistant's plain text out of an OpenAI Responses API body (`output_text` convenience
 *  field, else the concatenated `output[].content[].text`). Tolerant of shape drift; pure. */
export function extractResponsesOutputText(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.output_text === "string" && obj.output_text.length > 0) return obj.output_text;
  const out = obj.output;
  if (!Array.isArray(out)) return undefined;
  const parts: string[] = [];
  for (const item of out) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      if (typeof chunk === "object" && chunk !== null && typeof (chunk as Record<string, unknown>).text === "string") {
        parts.push((chunk as Record<string, unknown>).text as string);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Parse a vision reply into a lobby CODE. PRECISION-FIRST: accept ONLY when the whole reply IS the
 *  six-character code, or when it echoes an explicit /lobby/CODE — never a bare 6-letter token buried in
 *  prose (e.g. "I see a home SCREEN"), because a wrong latch fails the entire run, whereas a miss just
 *  retries on the next frame while the host keeps waiting. NONE (the instructed "no code" reply) is
 *  rejected. Pure. */
export function parseLobbyCodeReply(reply: string | undefined): string | undefined {
  if (typeof reply !== "string") return undefined;
  const up = reply.trim().toUpperCase();
  if (up.length === 0 || /\bNONE\b/.test(up)) return undefined;
  if (/^[A-Z2-9]{6}$/.test(up)) return up; // the well-behaved "code only" reply
  const inUrl = up.match(/\/LOBBY\/([A-Z2-9]{6})(?![A-Z2-9])/); // model echoed the invite link
  return inUrl ? inUrl[1] : undefined;
}

const LOBBY_CODE_VISION_PROMPT =
  "This is a screenshot of a the example multiplayer app multiplayer lobby. If a waiting-room / invite screen is " +
  "shown, read the 6-character lobby code (characters A-Z and 2-9 only) — it appears near a 'lobby " +
  "code'/'room code' label or inside an invite link of the form /lobby/CODE. Your entire reply MUST be " +
  "exactly those 6 characters in uppercase and NOTHING else (no words, no punctuation). If no lobby " +
  "code is visible on this screen (e.g. it is the home screen or a game round), reply exactly NONE.";

const LOBBY_CODE_VISION_ENDPOINT = "https://api.openai.com/v1/responses";
// A single-frame OCR-style read. gpt-5.5 (the CU default) is used deliberately: it reliably reads the
// 6-char code off a dense MOBILE-viewport waiting room — a smaller/cheaper model (gpt-4.1-mini) was
// tried and could NOT read it. reasoning.effort stays "low" (minimal) and the output budget is small
// but comfortably clear of the "incomplete on reasoning overflow" edge. Kept on the same account/key
// as the actor; the same full-fidelity frame is already sent to this API by the CU provider, so this
// adds no new data-exposure surface. See onScreenshot in runHostLane.
const LOBBY_CODE_VISION_MODEL = "gpt-5.5";
// Output-token budget for the read. The answer is 6 chars, but leave clear margin over any low-effort
// reasoning tokens so the response never comes back status:"incomplete" with empty output.
const LOBBY_CODE_VISION_MAX_OUTPUT_TOKENS = 64;
// Per-read wall-clock cap. Without it a stalled fetch (Node fetch has no default timeout) would leave
// visionInFlight pinned true and silently kill the relay for the rest of the host run.
const LOBBY_CODE_VISION_TIMEOUT_MS = 15_000;

export interface ReadLobbyCodeOptions {
  model?: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Vision-read a lobby CODE straight off a host waiting-room FRAME (the robust, CDP-independent handoff
 * relay). Fail-soft: any network/HTTP/parse problem returns undefined so the caller simply retries on
 * the next frame. The frame is runtime-only; only the extracted code is used (as a digest downstream).
 */
export async function readLobbyCodeFromFrame(
  frame: Buffer,
  apiKey: string,
  options: ReadLobbyCodeOptions = {}
): Promise<string | undefined> {
  if (typeof apiKey !== "string" || apiKey.length === 0 || frame.length === 0) return undefined;
  const fetchFn = options.fetchFn ?? fetch;
  // Default a wall-clock timeout so a stalled request can't wedge the caller's in-flight guard. An
  // explicit signal (e.g. run abort) takes precedence when provided.
  const signal = options.signal ?? AbortSignal.timeout(LOBBY_CODE_VISION_TIMEOUT_MS);
  const body = {
    model: options.model ?? LOBBY_CODE_VISION_MODEL,
    reasoning: { effort: "low" },
    max_output_tokens: LOBBY_CODE_VISION_MAX_OUTPUT_TOKENS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: LOBBY_CODE_VISION_PROMPT },
          { type: "input_image", image_url: `data:image/png;base64,${frame.toString("base64")}` }
        ]
      }
    ]
  };
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchFn(options.endpoint ?? LOBBY_CODE_VISION_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch {
    return undefined; // transient network error: skip this frame, next turn retries
  }
  if (!res.ok) return undefined; // never read a non-ok body (it can echo the frame/input)
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return undefined;
  }
  return parseLobbyCodeReply(extractResponsesOutputText(parsed));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: () => boolean;
}

/** A minimal resolve-once latch for the host-first handoff barrier. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let done = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value: T) => { if (!done) { done = true; res(value); } };
    reject = (reason: unknown) => { if (!done) { done = true; rej(reason); } };
  });
  return { promise, resolve, reject, settled: () => done };
}

/** Marker error the host-first barrier rejects with when the deadline elapses (fail-closed). */
class HandoffTimeoutError extends Error {
  constructor(deadlineMs: number) {
    super(`the host never produced a /lobby/CODE URL within the ${deadlineMs}ms handoff deadline`);
    this.name = "HandoffTimeoutError";
  }
}

/** One persona's OUTCOME against the contended world (the "M of N" headline). */
export interface ConcurrentSharedWorldRoleResult {
  id: string;
  index: number;
  persona: string;
  status: string;
  ok: boolean;
  /** The harness-clocked [start,end] window the orchestrator measured (live). */
  window?: { startedAt: number; endedAt: number };
  session?: { status: string; completionReason: string; reason: string; screenshots: number };
  /** The actor sandbox lifecycle proof (the getHost/key value is never surfaced here). */
  sandbox?: { sandboxId: string; killed: boolean };
  error?: { code: ConcurrentSharedWorldLabErrorCode; message: string };
}

export interface ConcurrentSharedWorldLabResult {
  schema: typeof CONCURRENT_SHARED_WORLD_LAB_SCHEMA;
  ok: boolean;
  cwd: string;
  labId: string;
  actor: string;
  topology: "shared-world";
  topologyMode: "concurrent";
  /** The DECLARED number of persona seats. */
  roleCount: number;
  /** Effective in-flight bound (execution.concurrency). */
  concurrency: number;
  dryRun: boolean;
  runId: string;
  /** The harness-minted getHost URL the actors drove (tokenless; live only). */
  host?: string;
  /** The ONE subject sandbox lifecycle proof. */
  subjectSandbox?: { sandboxId: string; killed: boolean };
  /** Whether ≥2 actor windows overlapped in time (proven concurrency; live only). */
  overlapProven?: boolean;
  /** Max lanes observed live at the same instant (live only) — the honest simultaneity number; a
   *  6-lane run capped at 3 reports 3 here, never 6 (#350). */
  maxSimultaneousLanes?: number;
  /** Subject provenance (invariant 5): the ONE shared plane. */
  subject?: RunSubjectProvenance;
  roles: ConcurrentSharedWorldRoleResult[];
  observer?: ObserverResult;
  warnings: string[];
  error?: { code: ConcurrentSharedWorldLabErrorCode; message: string };
}

/** One actor lane's measured run (internal). */
interface ActorLaneResult {
  spec: CuaLaneSpec;
  outcome: LaneRunOutcome;
  startedAt: number;
  endedAt: number;
  route: string;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `concurrent-shared-world-${stamp}-${randomBytes(4).toString("hex")}`;
}

/** Extract the in-sandbox port from the (loopback) serve.url so getHost can expose it. */
function servePort(serveUrl: string): number {
  const url = new URL(serveUrl);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** Resolve an actor's seat URL against the harness-minted getHost base (entry is a same-origin
 *  relative path, validated at parse against serve.url). */
function resolveActorSeatUrl(baseUrl: string, entry: string | undefined): string {
  if (!entry) return baseUrl;
  try {
    return new URL(entry, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

/** A getHost URL must be TOKENLESS (no userinfo, no query — no authKey; invariant 1). */
function isTokenlessHost(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "";
  } catch {
    return false;
  }
}

/** sha256-16 of a URL's ORIGIN — the publish-safe host identity persisted in the bundle (the raw
 *  getHost URL embeds the live sandbox id + matches the e2b-URL redaction, so it never lands raw). */
function hostOriginDigest(url: string): string {
  try {
    return commandDigestOf(new URL(url).origin);
  } catch {
    return commandDigestOf(url);
  }
}

/** A public-safe, human-readable route label for the bundle (host redacted to a placeholder; the
 *  entry path kept). Never contains the raw getHost URL. */
function publicSafeRouteLabel(entry: string | undefined): string {
  return `[provisioned-subject]${entry ?? "/"}`;
}

/**
 * Build the ONE subject sandbox's provenance (invariant 5): clone (repo + optional commit) or
 * local-tree (archiveSha256 + optional commit/dirty from the once-per-run host-packed archive -
 * archiveSha256 IS the pin; there is only ONE archive, so no per-lane unanimity math applies,
 * unlike the cua fan-out route). Used for both the in-progress and final bundle: the archive
 * never changes mid-run (packed before any sandbox exists).
 */
function buildSubjectProvenance(args: {
  localTreeRoute: boolean;
  publicRepo: string;
  subjectCommit: string | undefined;
  localTreeArchive: LocalTreeArchive | undefined;
  subjectEnvNames: string[];
  state: RunSubjectProvenance["state"];
}): RunSubjectProvenance {
  if (args.localTreeRoute) {
    return {
      source: "local-tree",
      ...(args.localTreeArchive === undefined ? {} : { archiveSha256: args.localTreeArchive.archiveSha256 }),
      ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
      ...(args.localTreeArchive?.git === undefined ? {} : { dirty: args.localTreeArchive.git.dirty }),
      envNames: args.subjectEnvNames,
      state: args.state
    };
  }
  return {
    source: "clone",
    repo: args.publicRepo,
    ...(args.subjectCommit === undefined ? {} : { commit: args.subjectCommit }),
    envNames: args.subjectEnvNames,
    state: args.state
  };
}

function laneTaxonomyLabel(spec: Pick<CuaLaneSpec, "actorType" | "surface" | "caseGroup">): string {
  const parts = [
    spec.actorType ? `type:${spec.actorType}` : undefined,
    spec.surface ? `surface:${spec.surface}` : undefined,
    spec.caseGroup ? `case:${spec.caseGroup}` : undefined
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? ` (${parts.join(" / ")})` : "";
}

/** Build one actor lane's CuaLaneSpec from a roster role (per-actor device IS honored here — each
 *  actor has its OWN desktop, unlike the sequential one-sandbox PoC). */
function buildActorSpec(
  config: LabConfig,
  role: LabActorLane,
  index: number,
  personas: Map<string, ResolvedPersona>
): CuaLaneSpec {
  const mission = config.actors[0]?.mission ?? DEFAULT_MISSION;
  const device = resolveLaneDevice(config, role);
  const resolvedPersona = role.persona === undefined ? undefined : personas.get(role.persona);
  const composed = composeLaneInstructions({
    mission,
    ...(role.persona === undefined ? {} : { persona: role.persona }),
    ...(resolvedPersona === undefined ? {} : { resolvedPersona }),
    ...(role.instruction === undefined ? {} : { instruction: role.instruction }),
    device: { name: device.name, preset: device.preset }
  });
  const roleId = role.id ?? `role-${String(index + 1).padStart(2, "0")}`;
  const streamId = `stream-${String(index + 1).padStart(3, "0")}`;
  return {
    laneId: roleId,
    ...(role.actorType === undefined ? {} : { actorType: role.actorType }),
    ...(role.surface === undefined ? {} : { surface: role.surface }),
    ...(role.caseGroup === undefined ? {} : { caseGroup: role.caseGroup }),
    laneIndex: index,
    simId: `sim-${String(index + 1).padStart(3, "0")}`,
    streamId,
    persona: composed.persona,
    instructions: composed.instructions,
    ...((role.stopWhen ?? config.actors[0]?.stopWhen) === undefined ? {} : { stopWhen: (role.stopWhen ?? config.actors[0]?.stopWhen)! }),
    ...((role.dwell ?? config.actors[0]?.dwell) === undefined ? {} : { dwell: (role.dwell ?? config.actors[0]?.dwell)! }),
    deviceName: device.name,
    devicePreset: device.preset,
    resolution: device.resolution,
    screenshotDir: roleId,
    traceArtifactPath: `actors/${streamId}.json`
  };
}

/** Thread the host-yielded lobby CODE into a follower's mission at runtime (external-public route).
 *  The CODE flows into the follower's join instruction; it is persisted only as the composed prompt
 *  the model reads (never a raw bundle field), and the lab scrubs the CODE from all narration. The
 *  follower joins through the real UI (a direct /lobby/CODE visit does not auto-join a non-member). */
function withLobbyCodeMission(spec: CuaLaneSpec, code: string): CuaLaneSpec {
  return {
    ...spec,
    instructions: `${spec.instructions}\n\nThe multiplayer lobby code is ${code}. On the home screen choose Join, enter this lobby code, enter your name, and submit to join the shared game (do not open a lobby URL directly — go through the Join flow).`
  };
}

/** A follower blocked by an expired deadline or an ended host. It never opened a browser;
 * keep the actual reason rather than turning every upstream failure into a timeout. */
function makeBlockedFollowerOutcome(spec: CuaLaneSpec, reason: string, timedOut: boolean): LaneRunOutcome {
  return {
    spec,
    sessionError: `handoff barrier: ${reason}; this follower failed closed WITHOUT opening (no wasted turns).`,
    killed: false,
    streamUrlPresent: false,
    screenshots: [],
    stateStepRecords: [],
    phaseRecords: [],
    warnings: [],
    noEngagement: true,
    selfReportedBlocker: false,
    harnessError: false,
    skippedReason: timedOut ? "handoff-timeout" : "host-ended-before-handoff"
  };
}

async function writeConcurrentRunArtifacts(
  bundle: RunBundle,
  preparedRunPaths: PreparedRunArtifactPaths
): Promise<void> {
  const runPaths = await validatePreparedRunArtifactPaths(preparedRunPaths);
  const publicBundle: RunBundle = {
    ...bundle,
    cwd: PUBLIC_TARGET_CWD
  };
  await writeContainedOutputFile(runPaths, "run.json", `${JSON.stringify(publicBundle, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "review.json", `${JSON.stringify(publicBundle.review, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "review.md", renderConcurrentReviewMarkdown(publicBundle), "utf8");
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
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
}

function observerResultForConcurrentArtifacts(
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

/**
 * Wrapped so a DIRECT library caller gets the same status-record lifetime the CLI does: returning
 * from this function finalizes any record the run opened, whichever of its fail-closed exits it
 * took. `runLab` establishes a scope too and nesting is harmless — the inner scope owns what it
 * opened. Without this a test or an adopter calling the backend directly leaves the 5s cadence
 * ticking into a directory something else is deleting, which surfaces as an unrelated ENOTEMPTY.
 */
export async function runConcurrentSharedWorld(options: RunConcurrentSharedWorldLabOptions): Promise<ConcurrentSharedWorldLabResult> {
  return withRunStatusScope(() => runConcurrentSharedWorldInScope(options));
}

async function runConcurrentSharedWorldInScope(options: RunConcurrentSharedWorldLabOptions): Promise<ConcurrentSharedWorldLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const render = hooks.renderObserverFn ?? renderObserver;
  const actorType = config.actors[0]?.type ?? "";
  const roles = config.actors[0]?.lanes ?? [];
  // All-parallel default (#350): the parser fills concurrency for multi-seat labs, so this
  // fallback serves only library callers constructing configs directly — same meaning: every
  // declared seat runs at once unless the author declared a cap.
  const concurrency = config.execution?.concurrency ?? Math.max(1, roles.length);

  const fail = (code: ConcurrentSharedWorldLabErrorCode, message: string, actorLabel?: string): ConcurrentSharedWorldLabResult => ({
    schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: actorLabel ?? actorType,
    topology: "shared-world",
    topologyMode: "concurrent",
    roleCount: roles.length,
    concurrency,
    dryRun,
    runId: options.runId ?? "not-created",
    roles: [],
    warnings: [],
    error: { code, message }
  });

  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isCuaActorDescriptor(descriptor)) {
    return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_ACTOR_UNSUPPORTED", `actors[0].type "${actorType}" is not a registered computer-use actor.`);
  }

  // The PLANE-class discriminator (#164 phase 2): an app-url subject is the EXTERNAL-PUBLIC plane (a
  // real operator-owned public deployment used directly as the shared plane — NO getHost, clone,
  // subject sandbox, or seed); everything else is the historical provisioned-getHost plane.
  const planeClass: ConcurrentSharedWorldPlaneClass =
    config.subject.source === "app-url" ? "external-public" : "provisioned-getHost";

  // Re-enforce the cross-validation (library API surface). The external-public branch NEVER touches
  // the getHost synthetic gate — that gate exists because getHost is internet-reachable AND
  // harness-owned; a public site the harness neither provisioned nor exposed has neither property.
  const invalidReason = outputTokenLimitValidationReason(config) ?? (planeClass === "external-public"
    ? externalPublicSharedWorldValidationReason(config)
    : concurrentSharedWorldValidationReason(config));
  if (invalidReason) {
    return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", invalidReason, descriptor.id);
  }
  if (config.actors[0]?.maxOutputTokens !== undefined && hooks.runSession) {
    return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", "maxOutputTokens cannot be enforced by a custom runSession.", descriptor.id);
  }

  const caps = config.execution?.caps;
  if (!dryRun && (caps?.maxUsd !== undefined || caps?.maxTotalUsd !== undefined)) {
    const model = (config.actors[0]?.model ?? DEFAULT_OPENAI_CU_MODEL).trim().toLowerCase();
    if (!MODEL_RATES[model]) {
      return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", `The declared spend cap cannot be enforced for unpriced model "${model}".`, descriptor.id);
    }
  }
  const runBudget = !dryRun && caps?.maxTotalUsd !== undefined ? makeCuaRunBudget(caps.maxTotalUsd) : undefined;

  // provisioned-getHost fields (all absent on the external-public plane — forbidden at validation).
  const serve = config.subject.serve;
  const localTreeRoute = config.subject.source === "local-tree";
  const subjectRepo = config.subject.repos?.[0] ?? "";
  const subjectEnvNames = config.subject.env ?? [];
  const checkpoints = config.subject.state?.checkpoint ?? [];
  const runSession = hooks.runSession ?? descriptor.runSession;
  // The per-seat vision lobby-code reader (default: the real single-frame OpenAI read). Injectable so the
  // barrier's handoff + convergence proof are testable without a live vision call.
  const readLobbyCode = hooks.readLobbyCodeFromFrame ?? readLobbyCodeFromFrame;

  const openaiApiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
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
      return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_KEYS_MISSING", `Live concurrent shared-world labs need ${missingKeys.join(" and ")} in the environment (values are never persisted). ${describeMissingKeys(missingKeys, env)}`, descriptor.id);
    }
    const missingSubjectEnv = subjectEnvNames.filter((name) => !env[name]?.trim());
    if (missingSubjectEnv.length > 0) {
      return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_SUBJECT_ENV_MISSING", `subject.env declares ${missingSubjectEnv.join(", ")} but the environment does not provide ${missingSubjectEnv.length === 1 ? "it" : "them"} (pass via --env-file; values are never persisted).`, descriptor.id);
    }
  }

  const runId = options.runId ?? makeRunId();
  const runPaths = await prepareRunArtifactPaths(cwd, runId);
  // Identity + liveness on disk (#455): every backend writes this, so a watcher can classify any
  // run without parsing bundles and without depending on the interactive-observer path.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab })
  });
  const artifactRoot = runPaths.absoluteRunRoot;
  const physicalArtifactRoot = runPaths.physicalRunRoot;
  const createdAt = new Date().toISOString();
  const timeoutMs = config.execution?.timeoutMs ?? defaultSeatSessionTimeoutMs(config);
  const requestTimeoutMs = readPositiveInt(env.HUMANISH_E2B_REQUEST_TIMEOUT_MS, 60_000);
  const redactScreenshots = config.policies?.redactScreenshots === true;
  const timers: DetachedTimers = hooks.detachedTimers ?? {};
  const now = hooks.now ?? Date.now;
  const proberCadenceMs = hooks.proberCadenceMs ?? DEFAULT_PROBER_CADENCE_MS;
  const seedDigest = seedRecipeDigest(config);

  const source = await buildRunSource({ capturedAt: createdAt, cwd, humanishSource: "present", packageName: "humanish" });

  const warnings: string[] = [];
  const stateStepRecords: RunSubjectStateStepRecord[] = [];
  const stateSnapshots: SharedWorldStateSnapshot[] = [];
  // Compile committed personas so each seat's prompt carries real behavioral directives (#381).
  const personaResolution = await resolveCommittedPersonasForCwd(cwd, labPersonaIds(config));
  const actorSpecs = roles.map((role, i) => buildActorSpec(config, role, i, personaResolution.personas));
  let actorResults: ActorLaneResult[] = [];
  let subjectCommit: string | undefined;
  let subjectSandboxId: string | undefined;
  let subjectKilled = false;
  let getHostUrl: string | undefined;
  // Persona inbox SURFACE (#297 slice B, shared-world): the getHost-exposed inbox URL a persona (in a
  // DIFFERENT sandbox) opens, the serve->getHost origin-rewrite map (REQUIRED here so the app's loopback
  // verify links resolve to a reachable host), and the dedicated surface channel + render loop.
  let commsInboxUrl: string | undefined;
  let commsOriginMap: OriginMap = [];
  let surfaceRenderedCount = 0;
  let surfaceLoop: Promise<void> | undefined;
  let runError: string | undefined;
  let snapshotIndex = 0;
  let liveObserver: (ObserverResult & { ok: true }) | undefined;
  const runtimeStreamUrls: ObserverRuntimeStreamUrl[] = [];

  // Off-app comms (#297): on the provisioned-getHost plane the harness owns the ONE subject sandbox, so
  // it can redirect the app's email-API sends into an in-sandbox catch and evidence them. Gated ENTIRELY
  // on config.comms — no comms declared → zero change. The base-URL env is injected into the subject
  // sandbox at create (fixed port known up front); the catch is deployed before serve; the drain + digest
  // evidence run at subject teardown, then register run-level in the bundle. NOT available on the
  // external-public plane (the app is an operator-owned deployment the harness never provisions).
  const commsEmail = planeClass === "provisioned-getHost" ? config.comms?.email : undefined;
  const commsPort = commsEmail ? (commsEmail.port ?? DEFAULT_SANDBOX_CATCH_PORT) : undefined;
  // injectEnv is absent on an adopter-hosted plane (#328): there is no subject env to inject
  // because the operator points their own app at their own catch.
  const commsEnv: Record<string, string> = commsEmail?.injectEnv !== undefined && commsPort !== undefined
    ? { [commsEmail.injectEnv]: `http://127.0.0.1:${commsPort}` }
    : {};
  let commsArtifactPath: string | undefined;
  // ADOPTER-HOSTED ingress (#328): on the external-public plane the harness provisions nothing, so
  // it cannot host a catch — but the OPERATOR can, and then humanish still does every other part of
  // the funnel: it tells each persona its address and inbox URL, drains the declared catch over
  // HTTP at teardown, and writes the same digest-only evidence. Declaring `external` is what turns
  // the previously-inert block into a working one.
  const externalComms = planeClass === "external-public" ? config.comms?.email?.external : undefined;
  const externalCommsEmail = externalComms ? config.comms?.email : undefined;
  if (config.comms?.email && planeClass === "external-public" && externalComms === undefined) {
    warnings.push("comms.email is declared but this is the external-public plane (the shared plane is an operator-owned public deployment the harness does not provision) — the in-sandbox email catch cannot be deployed and no comms evidence is collected. Declare `comms.email.external` to host the catch yourself (#328).");
  }

  if (externalComms) {
    commsInboxUrl = externalInboxUrl(externalComms);
    // Fail closed BEFORE any actor sandbox is created: a comms lab whose catch is unreachable
    // collects nothing while every lane still spends. The probe asserts OUR service marker in
    // /health, so an adopter's proxy answering 200 for everything cannot pass for a catch.
    if (!dryRun && !(await externalCatchHealthy(externalComms))) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_COMMS_CATCH_UNREACHABLE",
        `comms.email.external.catchBaseUrl is not reachable as a humanish comms catch (GET /health must return the humanish-comms-catch service marker). Start it with \`humanish comms catch\` on that host, or drop comms.email to run without the inbox funnel.`
      );
    }
  }

  // EXTERNAL-PUBLIC plane state (#164 phase 2). publicAppUrl is the operator-declared shared plane;
  // its ORIGIN is persisted digest-only (publicOriginDigest), never raw (the raw URL + the runtime
  // observed lobby CODE never land — TENSION 3). The latch code is scrubbed from all narration.
  const publicAppUrl = config.subject.appUrl ?? "";
  // The operator-DECLARED origin (from subject.appUrl) — recorded for evidence/reference ONLY. The
  // operator-OWNERSHIP claim rests on the subject.publicTarget.authorized attestation + this declared
  // appUrl, NOT on digest equality (blocker 2): a normal cross-origin redirect (apex->www, http->https;
  // lobby-trivia.example.test 307-redirects) makes the seats' OBSERVED origin differ from the declared one, which
  // is expected and MUST NOT fail the run. Persisted digest-only (never the raw origin).
  const declaredOriginDigest = planeClass === "external-public" && publicAppUrl
    ? hostOriginDigest(publicAppUrl)
    : undefined;
  // The OBSERVED convergence origin — computed AFTER fan-out from what the seats ACTUALLY reached (the
  // convergence proof is what the seats OBSERVED, not what was declared). Set iff every observing seat
  // agrees on ONE origin; that agreement IS the convergence proof and becomes plane.publicOriginDigest.
  let publicOriginDigest: string | undefined;
  // Per-lane runtime-only observed state (never persisted raw): the last observed URL and the last
  // observed /lobby/CODE per seat, fed by onObservedUrl. The URL is digested to ORIGIN for each seat's
  // routeHostDigest (no code leaks); the codes drive the cross-seat lobby-convergence digest.
  const observedFinalUrls: (string | undefined)[] = new Array(roles.length);
  const observedLobbyCodes: (string | undefined)[] = new Array(roles.length);
  let lobbyConvergenceDigest: string | undefined;
  let handoffTimedOut = false;
  let hostHandoffFailure: string | undefined;
  // A closure that scrubs the latched lobby CODE from ANY persisted narration once the host resolves
  // it (the 6-char code has no detectable secret shape, so shape-only redaction cannot catch it).
  let latchedLobbyCode: string | undefined;
  const scrubKnownValuesWithLobbyCode = (text: string): string => {
    const base = scrubKnownValues(text);
    return latchedLobbyCode && latchedLobbyCode.length > 0
      ? base.split(latchedLobbyCode).join("[REDACTED_LOBBY_CODE]")
      : base;
  };

  // Pack the working tree ONCE per run, on the host, BEFORE the subject sandbox is created
  // (mirrors the sequential route + the cua route's ordering): a packing failure fails the run
  // closed here, never spending sandbox cost. Dry-run packs nothing.
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
        `humanish concurrent shared-world local-tree: packed ${packed.archive.fileCount} entries, ${packed.archive.totalBytes} bytes, archiveSha256 ${packed.archive.archiveSha256}`
        + `${packed.archive.git ? ` (commit ${packed.archive.git.commit.slice(0, 12)}, ${packed.archive.git.dirty ? "dirty" : "clean"} working tree)` : " (not a git work tree)"}\n`
      );
    } catch (error) {
      return fail(
        "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED",
        `local-tree packing failed: ${redactText(scrubKnownValues(toErrorMessage(error)))}`,
        descriptor.id
      );
    }
  }

  if (!dryRun && planeClass === "provisioned-getHost") {
    if (!serve) {
      // Defense-in-depth: concurrentSharedWorldValidationReason already required serve above.
      return fail("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID", "the provisioned-getHost concurrent shared-world route requires `subject.serve`.", descriptor.id);
    }
    let subjectModule: E2BDesktopModule | undefined;
    let subjectDesktop: E2BDesktopSandbox | undefined;
    // The in-sandbox email catch on the ONE subject sandbox (#297); drained at teardown. Undefined
    // unless a comms lab declared it. Hoisted so the finally can drain before the subject is killed.
    let deployedComms: DeployedCommsCatch | undefined;
    // Background prober dispose signal (FIX-9: cleared in finally).
    let proberDisposed = false;
    let releaseDispose: () => void = () => {};
    const disposeSignal = new Promise<void>((resolve) => { releaseDispose = resolve; });
    let proberLoop: Promise<void> | undefined;

    const proberSnapshot = async (): Promise<void> => {
      if (!subjectDesktop) return;
      const timestamp = now();
      const idx = snapshotIndex;
      snapshotIndex += 1;
      const snapshot = await runCheckpointSnapshot({
        desktop: subjectDesktop,
        snapshotIndex: idx,
        name: `state-${idx}`,
        checkpoints,
        prevDigest: undefined,
        scrub: scrubKnownValues,
        requestTimeoutMs,
        timers
      });
      stateSnapshots.push({ timestamp, digest: snapshot.digest });
    };

    try {
      subjectModule = await (hooks.loadDesktopModule ?? loadE2BDesktopModule)();
      // The ONE subject sandbox: headless service host (no GUI seat). The SUBJECT env is provisioned
      // HERE; the actor sandboxes get NONE of it (FIX-10). A custom desktop template (image) is
      // honored on BOTH the subject sandbox (here) and every actor sandbox (via runCuaLane, which
      // reads the same config); absent keeps the byte-stable Sandbox.create(opts) default.
      subjectDesktop = await createDesktopSandbox(subjectModule, {
        apiKey: e2bApiKey,
        requestTimeoutMs,
        timeoutMs: timeoutMs + SUBJECT_PROVISION_BUDGET_MS
          + (config.subject.state?.seed ?? []).reduce((sum, step) => sum + (step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS), 0)
          + SANDBOX_TIMEOUT_BUFFER_MS,
        metadata: {
          ...CONCURRENT_SHARED_WORLD_PROVIDER_METADATA,
          labId: config.id,
          topology: "shared-world",
          topologyMode: "concurrent",
          role: "subject",
          roleCount: String(roles.length)
        },
        ...(subjectEnvNames.length > 0 || Object.keys(commsEnv).length > 0
          ? { envs: { ...Object.fromEntries(subjectEnvNames.map((name) => [name, env[name] as string])), ...commsEnv } }
          : {}),
        dpi: 96,
        lifecycle: { onTimeout: "kill" }
      }, config.execution?.desktop?.template);
      subjectSandboxId = subjectDesktop.sandboxId;
      // #358 salvage: durable id receipt the moment the subject sandbox exists.
      await appendSandboxReceipt(runPaths, { at: new Date().toISOString(), laneId: "subject", sandboxId: subjectSandboxId });

      if (hooks.prepareDesktop) {
        await hooks.prepareDesktop(subjectDesktop);
      }

      // Start the in-sandbox email catch BEFORE the subject serve, so the app's send-API base URL
      // (injected into its env at create) resolves the moment it boots. Fail closed if the catch can't
      // stand up rather than let a comms-declared app silently send real mail to the internet.
      if (commsEmail && commsPort !== undefined) {
        // A SECOND (0.0.0.0) read-only inbox listener on commsPort+1 so the persona — which lives in a
        // DIFFERENT sandbox here — can reach the inbox surface via getHost; capture stays loopback.
        deployedComms = await deployCommsCatch(subjectDesktop, { port: commsPort, inboxPort: commsPort + 1, requestTimeoutMs, timers });
        if (!deployedComms.ready) {
          throw new Error(`comms email catch did not become ready in the subject sandbox (loopback capture ${commsPort} / inbox ${commsPort + 1})`);
        }
      }

      // Provision the ONE shared plane: clone + install/build + seed + serve on 0.0.0.0 + probe
      // (clone route), or upload/extract the once-per-run packed archive + the SAME shared serve
      // pipeline (local-tree route).
      const onSubjectPhase = hooks.onPhase ?? ((event: SubjectPhaseEvent) => {
        process.stderr.write(
          `humanish shared-world (concurrent): ${event.message}${event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`}\n`
        );
      });
      if (localTreeRoute) {
        await provisionLocalTreeSubject(subjectDesktop, {
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
        subjectCommit = await provisionCloneSubject(subjectDesktop, {
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

      // Expose the served port via getHost (FIX-2). Fail closed if the SDK lacks it.
      if (typeof subjectDesktop.getHost !== "function") {
        throw new Error("the installed @e2b/desktop SDK does not expose getHost(port); the concurrent shared-world route requires it to reach the subject plane");
      }
      // getHost returns a BARE host (e.g. "3000-<sandboxId>.e2b.app", no scheme); e2b exposes the
      // port over https. Normalize to a full URL before the tokenless check + before persisting.
      const rawHost = subjectDesktop.getHost(servePort(serve.url));
      const hostUrl = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;
      if (!isTokenlessHost(hostUrl)) {
        throw new Error("getHost returned a non-tokenless URL; refusing to persist a host URL that may carry a credential (invariant 1)");
      }
      getHostUrl = hostUrl;

      // Persona inbox SURFACE (#297 slice B, shared-world): getHost-expose the read-only inbox listener so
      // a persona in a DIFFERENT sandbox can open it; build the serve->getHost origin map (REQUIRED here —
      // the app's loopback verify links must be rewritten to a reachable host); provision the surface
      // channel; write the EMPTY inbox up front (so /inbox never 404s); and start a render loop that drains
      // + re-renders on a cadence. The loop shares the prober's dispose signal (disposed together, before
      // the teardown evidence drain), and uses a DEDICATED FakeInbox + cursor (independent of that drain).
      if (commsEmail && deployedComms?.inboxPort !== undefined) {
        const rawInboxHost = subjectDesktop.getHost(deployedComms.inboxPort);
        const inboxHostUrl = /^https?:\/\//i.test(rawInboxHost) ? rawInboxHost : `https://${rawInboxHost}`;
        if (!isTokenlessHost(inboxHostUrl)) {
          throw new Error("getHost returned a non-tokenless URL for the comms inbox; refusing to advertise it (invariant 1)");
        }
        commsInboxUrl = `${inboxHostUrl}/inbox`;
        commsOriginMap = buildOriginMap({
          internalServeUrl: serve.url,
          reachableBaseUrl: getHostUrl,
          ...(commsEmail.linkOrigin === undefined ? {} : { linkOrigin: commsEmail.linkOrigin })
        });
        const surfaceRecipients = (commsEmail.recipients ?? [])
          .filter((recipient): recipient is { lane: string; address: string } => recipient.address !== undefined)
          .map((recipient) => ({ lane: recipient.lane, address: recipient.address }));
        await writeInboxSurface(subjectDesktop, deployedComms.surfaceDir, [], { originMap: commsOriginMap, requestTimeoutMs });
        const surfaceDeployed = deployedComms;
        const surfaceCadenceMs = 2500;
        surfaceLoop = (async () => {
          // Full, idempotent rebuild each tick; surfaceRenderedCount advances only on a successful render,
          // so a transient failure retries cleanly. Real timer (dispose-interruptible + cleared) — an
          // unbounded loop must not busy-spin on the injected instant clock.
          for (;;) {
            try {
              const refreshed = await refreshInboxSurface({
                desktop: subjectDesktop!,
                deployed: surfaceDeployed,
                recipients: surfaceRecipients,
                sinceCount: surfaceRenderedCount,
                originMap: commsOriginMap,
                requestTimeoutMs
              });
              if (refreshed.rendered) surfaceRenderedCount = refreshed.count;
            } catch {
              // Never throw into the render loop; the teardown drain + by-id teardown must still run.
            }
            if (proberDisposed) break;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, surfaceCadenceMs);
              void disposeSignal.then(() => { clearTimeout(timer); resolve(); });
            });
            if (proberDisposed) break;
          }
        })();
      }

      // Baseline state snapshot, then start the background cadence prober.
      await proberSnapshot();
      if (options.onObserverReady) {
        const inProgressPlaneCommit = localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit;
        const inProgressSubject = buildSubjectProvenance({
          localTreeRoute,
          publicRepo,
          subjectCommit: inProgressPlaneCommit,
          localTreeArchive,
          subjectEnvNames,
          state: resolveSubjectState({ declared: config.subject.state, dryRun: false, executed: stateStepRecords })
        });
        const inProgressBundle = buildConcurrentSharedWorldBundle({
          config,
          descriptor,
          createdAt,
          dryRun: false,
          inProgress: true,
          runId,
          source,
          roles,
          actorSpecs,
          actorResults: [],
          stateSnapshots,
          subject: inProgressSubject,
          seedDigest,
          ...(inProgressPlaneCommit === undefined ? {} : { subjectCommit: inProgressPlaneCommit }),
          hostDigest: hostOriginDigest(getHostUrl!)
        });
        await writeConcurrentRunArtifacts(inProgressBundle, runPaths);
        liveObserver = observerResultForConcurrentArtifacts(cwd, runId, artifactRoot, [
          "Live concurrent shared-world Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted."
        ]);
        await options.onObserverReady(liveObserver);
      }
      proberLoop = (async () => {
        while (!proberDisposed) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            new Promise<void>((resolve) => { timer = setTimeout(resolve, proberCadenceMs); }),
            disposeSignal
          ]);
          if (timer) clearTimeout(timer); // FIX-9: no dangling prober timer.
          if (proberDisposed) break;
          await proberSnapshot().catch(() => undefined);
        }
      })();

      // Launch N actor sandboxes CONCURRENTLY, INDEPENDENT (FIX-11: runCuaLane + mapWithConcurrency,
      // NOT runCuaLanes — no pipeline gate / fail-fast). Each actor's window is measured on the ONE
      // orchestrator clock (FIX-1). cloneRoute=false + subjectEnvNames=[] keep subject creds out of
      // every actor sandbox (FIX-10).
      const cuaHooks: CuaActorLabHooks = {
        ...(hooks.loadDesktopModule ? { loadDesktopModule: hooks.loadDesktopModule } : {}),
        ...(hooks.detachedTimers ? { detachedTimers: hooks.detachedTimers } : {}),
        ...(hooks.env ? { env: hooks.env } : {}),
        ...(hooks.prepareDesktop ? { prepareDesktop: (desktop: E2BDesktopSandbox) => hooks.prepareDesktop!(desktop) } : {}),
        onRuntimeStreamReady: (stream) => {
          runtimeStreamUrls.push({ streamId: stream.streamId, url: stream.url });
          if (liveObserver) {
            attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
          }
        },
        onRuntimeStreamEnded: (stream) => {
          // Mark, never remove (#357): the tile falls back to recorded evidence and says why.
          for (const entry of runtimeStreamUrls) {
            if (entry.streamId === stream.streamId) entry.ended = true;
          }
          if (liveObserver) {
            attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
          }
        }
      };
      const baseActorDeps: Omit<CuaLaneDeps, "signalProvisioned" | "appUrl"> = {
        config,
        descriptor,
        cloneRoute: false,
        subjectEnvNames: [],
        hasGithubToken: false,
        env,
        openaiApiKey,
        e2bApiKey,
        requestTimeoutMs,
        perLaneSandboxMs: timeoutMs + SANDBOX_TIMEOUT_BUFFER_MS,
        timeoutMs,
        laneCount: roles.length,
        artifactRoot: runPaths,
        labCwd: cwd,
        redactScreenshots,
        scrubKnownValues,
        runSession,
        now,
        hooks: cuaHooks,
        ...(runBudget === undefined ? {} : { runBudget }),
        // Concurrent lanes are independent evidence seats: a requested-vs-verified screen
        // mismatch is recorded as separate facts + a warning instead of failing the lane's
        // device claim closed, so one seat's window-manager drift cannot abort the whole
        // live multi-actor world (the single-lane/fan-out routes keep fail-closed).
        screenMismatchPolicy: "record-evidence"
      };

      actorResults = await mapWithConcurrency(actorSpecs, Math.max(1, concurrency), async (spec, i) => {
        const route = resolveActorSeatUrl(getHostUrl!, roles[i]?.entry);
        // Tell this persona its (getHost-reachable) inbox URL — but only when comms is live AND this lane
        // has a declared recipient it can actually receive mail into (else it would stall on an empty
        // inbox). Only the in-sandbox catch exists on this plane; the adopter-hosted catch is the
        // external-public plane's, wired in ITS execution block below (#387).
        const laneSpec = commsEmail && commsInboxUrl && laneHasInboxRecipient(commsEmail, spec.laneId)
          ? withInboxMission(spec, commsInboxUrl, inboxRecipientFor(commsEmail, spec.laneId)?.address)
          : spec;
        const startedAt = now();
        const outcome = await runCuaLane(laneSpec, { ...baseActorDeps, appUrl: route });
        const endedAt = now();
        return { spec, outcome, startedAt, endedAt, route };
      });
    } catch (error) {
      runError = redactText(scrubKnownValues(toErrorMessage(error)));
      warnings.push(`Concurrent shared-world run failed before completion: ${runError}`);
    } finally {
      // FIX-9: stop the prober, take a final snapshot while the subject is still alive, then tear
      // down the ONE subject sandbox BY id (the actor sandboxes are torn down inside runCuaLane).
      proberDisposed = true;
      releaseDispose();
      if (proberLoop) {
        await proberLoop.catch(() => undefined);
      }
      // Stop the inbox-surface render loop too (shares the prober's dispose signal), before the teardown
      // evidence drain below — so the two in-sandbox reads never overlap and the surface state is final.
      if (surfaceLoop) {
        await surfaceLoop.catch(() => undefined);
      }
      if (subjectDesktop && getHostUrl) {
        await proberSnapshot().catch(() => undefined);
      }
      // Off-app comms evidence (#297): drain everything the in-sandbox catch captured, route it into a
      // host fake inbox addressed to the declared recipients, and write the run-level digest-only thread
      // artifact — while the subject is STILL alive, before it is killed below. Wrapped so a drain error
      // never blocks teardown (invariant: all sandboxes torn down by id in this finally).
      if (commsEmail && deployedComms?.ready && subjectDesktop) {
        try {
          const commsChannel = new FakeInbox();
          const commsInboxes: CommsAddress[] = [];
          for (const recipient of commsEmail.recipients ?? []) {
            if (recipient.address !== undefined) {
              commsInboxes.push(await commsChannel.provisionAddress(recipient.lane, recipient.address));
            }
          }
          const collected = await collectCommsThread({
            desktop: subjectDesktop,
            deployed: deployedComms,
            channel: commsChannel,
            inboxes: commsInboxes,
            requestTimeoutMs
          });
          if (collected.artifact) {
            await writeContainedOutputFile(runPaths, "comms/thread.json", `${JSON.stringify(collected.artifact, null, 2)}\n`, "utf8");
            commsArtifactPath = "comms/thread.json";
          } else if (collected.captured > 0) {
            warnings.push(`Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`);
          } else {
            // Zero captures is the silent-broken shape (#351): the app never posted to the catch.
            warnings.push(`Comms catch captured ZERO email sends — the app never delivered mail through the catch. Verify the app reads ${commsEmail.injectEnv} for its email API base URL (an SDK that ignores it sends real mail or throws) and that the flow reached an email step.`);
          }
        } catch (error) {
          warnings.push(`Comms evidence collection failed (run continues; subject still torn down): ${redactText(scrubKnownValues(toErrorMessage(error)))}`);
        }
      }
      if (subjectDesktop && subjectModule) {
        if (typeof subjectModule.Sandbox.kill === "function") {
          try {
            await subjectModule.Sandbox.kill(subjectDesktop.sandboxId, { requestTimeoutMs: 60_000 });
            subjectKilled = true;
          } catch (error) {
            warnings.push(`Subject sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${redactText(scrubKnownValues(toErrorMessage(error)))}`);
          }
        } else {
          warnings.push("Installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the subject sandbox.");
        }
      }
    }
  }

  // EXTERNAL-PUBLIC plane (#164 phase 2): NO subject sandbox, NO getHost, NO prober. The shared plane
  // is the operator-declared public deployment (publicAppUrl); each seat opens it directly and reaches
  // the shared session through the real UI. A host-first barrier extracts the /lobby/CODE from the host
  // seat's CDP-observed URL (onObservedUrl) and threads it into the follower missions; a follower fails
  // closed WITHOUT opening if the host never yields a code within the handoff deadline.
  if (!dryRun && planeClass === "external-public") {
    const cuaHooks: CuaActorLabHooks = {
      ...(hooks.loadDesktopModule ? { loadDesktopModule: hooks.loadDesktopModule } : {}),
      ...(hooks.detachedTimers ? { detachedTimers: hooks.detachedTimers } : {}),
      ...(hooks.env ? { env: hooks.env } : {}),
      ...(hooks.prepareDesktop ? { prepareDesktop: (desktop: E2BDesktopSandbox) => hooks.prepareDesktop!(desktop) } : {}),
      onRuntimeStreamReady: (stream) => {
        runtimeStreamUrls.push({ streamId: stream.streamId, url: stream.url });
        if (liveObserver) {
          attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
        }
      },
      onRuntimeStreamEnded: (stream) => {
        // Mark, never remove (#357): the tile falls back to recorded evidence and says why.
        for (const entry of runtimeStreamUrls) {
          if (entry.streamId === stream.streamId) entry.ended = true;
        }
        if (liveObserver) {
          attachObserverRuntimeStreamUrls(liveObserver, runtimeStreamUrls);
        }
      }
    };
    const baseActorDeps: Omit<CuaLaneDeps, "signalProvisioned" | "appUrl" | "onObservedUrl"> = {
      config,
      descriptor,
      cloneRoute: false,
      subjectEnvNames: [],
      hasGithubToken: false,
      env,
      openaiApiKey,
      e2bApiKey,
      requestTimeoutMs,
      perLaneSandboxMs: timeoutMs + SANDBOX_TIMEOUT_BUFFER_MS,
      timeoutMs,
      laneCount: roles.length,
      artifactRoot: runPaths,
        labCwd: cwd,
      redactScreenshots,
      // Scrub the latched lobby CODE (known once the host resolves it) from ALL narration.
      scrubKnownValues: scrubKnownValuesWithLobbyCode,
      runSession,
      now,
      hooks: cuaHooks,
      ...(runBudget === undefined ? {} : { runBudget }),
      screenMismatchPolicy: "record-evidence"
    };

    // Publish an attached live Observer BEFORE fan-out (mirrors the provisioned path).
    if (options.onObserverReady) {
      const inProgressBundle = buildConcurrentSharedWorldBundle({
        config,
        descriptor,
        createdAt,
        dryRun: false,
        inProgress: true,
        runId,
        source,
        roles,
        actorSpecs,
        actorResults: [],
        stateSnapshots: [],
        subject: { source: "app-url", envNames: [], state: { provenance: "external-public" } },
        seedDigest,
        planeClass: "external-public",
        // Pre-fan-out snapshot: no seat has observed an origin yet, so the OBSERVED publicOriginDigest
        // is not available; surface the DECLARED origin for the live Observer's reference.
        ...(declaredOriginDigest === undefined ? {} : { declaredOriginDigest })
      });
      await writeConcurrentRunArtifacts(inProgressBundle, runPaths);
      liveObserver = observerResultForConcurrentArtifacts(cwd, runId, artifactRoot, [
        "Live external-public concurrent shared-world Observer is attached before final verification; stream auth URLs are runtime-only and are not persisted."
      ]);
      await options.onObserverReady(liveObserver);
    }

    // The host-first handoff barrier.
    //
    // TEMPORARY SHIM (tracked by #296): this CDP URL-relay handoff — reading the host's /lobby/CODE off
    // its own browser and threading it into the follower missions — is a temporary coordination shim.
    // It is to be augmented/replaced by the actor message bus (fake SMS/email invite) in #297: the
    // human-realistic version is the HOST SENDING the invite link and followers RECEIVING and tapping
    // it, rather than the orchestrator relaying the code out-of-band.
    const lobbyCodeLatch = deferred<string>();
    const handoffDeadlineMs = hooks.handoffDeadlineMs
      ?? Math.min(timeoutMs, Math.max(DEFAULT_HANDOFF_DEADLINE_MS, Math.floor(timeoutMs * HANDOFF_DEADLINE_BUDGET_FRACTION)));
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => reject(new HandoffTimeoutError(handoffDeadlineMs)), handoffDeadlineMs);
    });
    deadline.catch(() => undefined); // never an unhandled rejection

    // Resolve the host->follower handoff latch from WHICHEVER path sees the code first (CDP url-read,
    // host narration, or vision-off-frame). Idempotent: only the first code wins, and it is also stashed
    // as latchedLobbyCode so it gets scrubbed from any later narration. The latched code and observed URLs
    // are runtime-only and land in persisted METADATA only as digests (origin + convergence). (The code
    // is a shareable game code, not a secret, and it still renders in the host's screenshots, which are
    // full-fidelity unless redactScreenshots is set — the digesting is about narration/URL metadata.)
    const latchLobbyCode = (code: string, laneIndex: number): void => {
      if (latchedLobbyCode !== undefined) return;
      observedLobbyCodes[laneIndex] = code;
      latchedLobbyCode = code;
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = undefined; }
      lobbyCodeLatch.resolve(code);
    };

    // Build an onScreenshot handler that vision-reads the lobby code off THIS seat's own frame (the
    // CDP-independent observation). `done()` short-circuits once this seat has what it needs (the host
    // once latched; a follower once it has recorded its own observed code), `onCode` records/latches the
    // result. One read in flight at a time, bounded by MAX_LOBBY_CODE_VISION_READS so a seat that never
    // reaches a lobby can't rack up unbounded calls (fire-and-forget; the loop never awaits it).
    const makeLobbyCodeVisionReader = (done: () => boolean, onCode: (code: string) => void): ((frame: Buffer) => void) => {
      let inFlight = false;
      let reads = 0;
      return (frame: Buffer): void => {
        if (done() || inFlight || reads >= MAX_LOBBY_CODE_VISION_READS) return;
        inFlight = true;
        reads += 1;
        void readLobbyCode(frame, openaiApiKey)
          .then((code) => {
            if (code !== undefined && !done()) onCode(code);
          })
          .catch(() => undefined)
          .finally(() => {
            inFlight = false;
          });
      };
    };

    const makeLaneObservedUrl = (laneIndex: number, isHost: boolean) => (url: string | undefined): void => {
      if (typeof url !== "string" || url.length === 0) return;
      observedFinalUrls[laneIndex] = url; // runtime-only; digested to origin, never persisted raw
      const code = extractLobbyCode(url);
      if (code !== undefined) {
        observedLobbyCodes[laneIndex] = code;
        if (isHost) latchLobbyCode(code, laneIndex);
      }
    };

    // The HOST lane (which yields the /lobby/CODE the followers wait on) runs on its OWN dedicated
    // slot, and the FOLLOWERS run through a bounded pool of size concurrency-1 (blockers 1 & 4):
    // followers block on `Promise.race([lobbyCodeLatch.promise, deadline])` while holding a worker
    // slot, so if the host lane were scheduled INSIDE the same bounded pool it could be starved (never
    // scheduled among the first `concurrency` workers) and the run would die with a spurious
    // HANDOFF_TIMEOUT (e.g. lanes [p2,p3,host] with concurrency 2). Giving the host its own slot,
    // started IMMEDIATELY and OUTSIDE the follower pool, guarantees it is ALWAYS schedulable regardless
    // of its roster position or of concurrency vs lane count — while total in-flight paid desktops stay
    // ≤ the declared concurrency (host + up to concurrency-1 followers), preserving the spend cap.
    const runHostLane = async (spec: CuaLaneSpec, laneIndex: number): Promise<ActorLaneResult> => {
      const onObservedUrl = makeLaneObservedUrl(laneIndex, true);
      // CDP-INDEPENDENT handoff paths (the E2B-desktop CDP url-read the onObservedUrl path relies on is
      // unreliable in practice). Two backups, both resolving the SAME latch; whichever sees the code first
      // wins, all digest-only:
      //   (1) onMessage — scan the host's own narration IF it happens to state the lobby URL; and
      //   (2) onScreenshot — vision-read the code straight off the host's waiting-room frame. This is the
      //       robust one: the code is rendered on screen even when CDP fails AND when the host never
      //       narrates it, and — crucially — the host is NOT asked to announce anything, so it keeps
      //       running (create -> wait for players -> Start -> play) instead of ending on a stray message.
      const onMessage = (text: string): void => {
        if (latchedLobbyCode !== undefined) return;
        const code = extractLobbyCodeFromNarration(text);
        if (code !== undefined) latchLobbyCode(code, laneIndex);
      };
      // Vision-read the host's waiting-room frame and LATCH the code for the followers (stops once latched).
      const onScreenshot = makeLobbyCodeVisionReader(
        () => latchedLobbyCode !== undefined,
        (code) => latchLobbyCode(code, laneIndex)
      );
      // The host's job includes a long LEGITIMATE idle wait — sitting in the waiting room while the
      // followers provision their own desktops and walk the Join flow (easily 15-30 turns of an
      // unchanging "waiting for players" screen). At the default idle backstop (6) the host would give up
      // before anyone arrives, orphaning the lobby (exactly the earlier failure). Raise the host's idle /
      // no-progress tolerance so it waits patiently; the per-seat timeout still bounds a truly stuck host.
      // Adopter-hosted inbox (#387): the persona is told its address and inbox URL on THIS plane —
      // previously only the provisioned plane's seats ever got the instruction, so external comms
      // ran on no route at all.
      const hostInboxSpec = externalCommsEmail && commsInboxUrl && laneHasInboxRecipient(externalCommsEmail, spec.laneId)
        ? withInboxMission(spec, commsInboxUrl, inboxRecipientFor(externalCommsEmail, spec.laneId)?.address)
        : spec;
      const hostSpec: CuaLaneSpec = {
        ...hostInboxSpec,
        idleSteps: spec.idleSteps ?? HOST_WAIT_IDLE_STEPS,
        noProgressSteps: spec.noProgressSteps ?? HOST_WAIT_IDLE_STEPS
      };
      const startedAt = now();
      let outcome: LaneRunOutcome | undefined;
      try {
        outcome = await runCuaLane(hostSpec, { ...baseActorDeps, appUrl: publicAppUrl, onObservedUrl, onMessage, onScreenshot });
      } finally {
        // If the host finished without ever surfacing a code, release followers to fail closed
        // immediately rather than wait the full deadline (a no-op if it already resolved).
        if (!lobbyCodeLatch.settled()) {
          const reason = outcome?.sessionError ?? outcome?.session?.reason ?? "no terminal host outcome was recorded";
          hostHandoffFailure = scrubKnownValuesWithLobbyCode(`Host seat ended before producing a lobby URL: ${reason}`);
          lobbyCodeLatch.reject(new Error(hostHandoffFailure));
        }
      }
      const endedAt = now();
      return { spec, outcome, startedAt, endedAt, route: observedFinalUrls[laneIndex] ?? publicAppUrl };
    };
    const runFollowerLane = async (spec: CuaLaneSpec, laneIndex: number): Promise<ActorLaneResult> => {
      const onObservedUrl = makeLaneObservedUrl(laneIndex, false);
      // FOLLOWER: do NOT compose a mission or open the target until the host yields a lobby code.
      let code: string;
      try {
        code = await Promise.race([lobbyCodeLatch.promise, deadline]);
      } catch (error) {
        // An ended host is not a deadline expiry. Preserve its actual failure.
        const timedOut = error instanceof HandoffTimeoutError;
        handoffTimedOut ||= timedOut;
        const reason = scrubKnownValuesWithLobbyCode(toErrorMessage(error));
        const at = now();
        return { spec, outcome: makeBlockedFollowerOutcome(spec, reason, timedOut), startedAt: at, endedAt: at, route: publicAppUrl };
      }
      // Followers also idle-wait — in the waiting room until the host starts, and between rounds. Raise
      // their idle backstop too (less than the host's: they wait less), so a follower that joins ahead of
      // the other does not give up before the game begins. Per-seat timeout still bounds a stuck follower.
      const followerInboxSpec = externalCommsEmail && commsInboxUrl && laneHasInboxRecipient(externalCommsEmail, spec.laneId)
        ? withInboxMission(spec, commsInboxUrl, inboxRecipientFor(externalCommsEmail, spec.laneId)?.address)
        : spec;
      const followerSpec: CuaLaneSpec = {
        ...withLobbyCodeMission(followerInboxSpec, code),
        idleSteps: spec.idleSteps ?? FOLLOWER_WAIT_IDLE_STEPS,
        noProgressSteps: spec.noProgressSteps ?? FOLLOWER_WAIT_IDLE_STEPS
      };
      // Independently OBSERVE this follower's own lobby code by vision-reading its waiting-room frame,
      // and record it for the cross-seat convergence proof. This does NOT latch anything (followers gate
      // on the HOST's code, not their own) — it just fills this seat's observedLobbyCodes slot from a
      // reliable signal instead of the flaky CDP url-read, so lobbyConvergenceDigest can prove all seats
      // reached the SAME /lobby/CODE. If a follower somehow joined a DIFFERENT lobby, it reads a different
      // code and convergence correctly fails (no false proof); if it never reads one, the seat stays a
      // hole and convergence is honestly "not observed" for that seat.
      const onScreenshot = makeLobbyCodeVisionReader(
        () => observedLobbyCodes[laneIndex] !== undefined,
        (observed) => { observedLobbyCodes[laneIndex] = observed; }
      );
      const startedAt = now();
      const outcome = await runCuaLane(followerSpec, { ...baseActorDeps, appUrl: publicAppUrl, onObservedUrl, onScreenshot });
      const endedAt = now();
      return { spec, outcome, startedAt, endedAt, route: observedFinalUrls[laneIndex] ?? publicAppUrl };
    };

    // Split the roster into the designated host lane and the followers, preserving each follower's
    // ORIGINAL lane index so results land back in lane order (validation guarantees EXACTLY ONE host).
    const hostLaneIndex = roles.findIndex((role) => role.host === true);
    const followerEntries = actorSpecs
      .map((spec, index) => ({ spec, index }))
      .filter(({ index }) => index !== hostLaneIndex);
    const laneResults: ActorLaneResult[] = new Array(actorSpecs.length);
    try {
      const hostPromise = hostLaneIndex >= 0 && actorSpecs[hostLaneIndex] !== undefined
        ? runHostLane(actorSpecs[hostLaneIndex]!, hostLaneIndex)
        : undefined;
      const followerResultsPromise = mapWithConcurrency(
        followerEntries,
        Math.max(1, concurrency - 1),
        ({ spec, index }) => runFollowerLane(spec, index)
      );
      const [hostResult, followerResults] = await Promise.all([hostPromise, followerResultsPromise]);
      if (hostResult !== undefined && hostLaneIndex >= 0) {
        laneResults[hostLaneIndex] = hostResult;
      }
      followerEntries.forEach((entry, i) => { laneResults[entry.index] = followerResults[i]!; });
      actorResults = laneResults;
    } catch (error) {
      runError = redactText(scrubKnownValuesWithLobbyCode(toErrorMessage(error)));
      warnings.push(`External-public concurrent shared-world run failed before completion: ${runError}`);
    } finally {
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = undefined; }
      // Adopter-hosted drain (#328/#387): same routing and digest-only artifact as the in-sandbox
      // catch — only the transport differs (HTTP GET /deliveries against the catch the operator
      // runs). In the finally so the evidence survives a failed run; a drain error never masks
      // the run's own outcome.
      if (externalComms && externalCommsEmail) {
        try {
          const commsChannel = new FakeInbox();
          const commsInboxes: CommsAddress[] = [];
          for (const recipient of externalCommsEmail.recipients ?? []) {
            if (recipient.address !== undefined) {
              commsInboxes.push(await commsChannel.provisionAddress(recipient.lane, recipient.address));
            }
          }
          const authToken = externalComms.authTokenEnv === undefined ? undefined : env[externalComms.authTokenEnv];
          const collected = await collectExternalCommsThread({
            external: { ...externalComms, ...(authToken === undefined ? {} : { authToken }) },
            channel: commsChannel,
            inboxes: commsInboxes
          });
          if (collected.artifact) {
            const path = "comms/thread.json";
            await writeContainedOutputFile(runPaths, path, `${JSON.stringify(collected.artifact, null, 2)}\n`, "utf8");
            commsArtifactPath = path;
          } else if (collected.captured > 0) {
            warnings.push(`Comms catch captured ${collected.captured} email send(s) but none matched a declared recipient inbox — no comms evidence written. Declare comms.email.recipients[].address to match the address the app sends to.`);
          } else {
            warnings.push(`Comms catch captured ZERO email sends — your app never delivered mail through the catch at ${externalComms.catchBaseUrl}. Verify the app's email-API base URL points at it and that the flow reached an email step.`);
          }
        } catch (error) {
          warnings.push(`Comms evidence collection failed against the adopter-hosted catch (run continues): ${redactText(toErrorMessage(error))}`);
        }
      }
    }

    // Observed-origin convergence proof (blocker 2): the convergence claim is about what the seats
    // OBSERVED, not what was DECLARED. Digest each observing seat's origin and require they AGREE on
    // ONE — that agreement IS the convergence proof and becomes plane.publicOriginDigest. A normal
    // cross-origin redirect (declared apex -> observed www) is therefore tolerated: the seats still
    // converge on ONE observed origin. Leave it undefined (verify fails closed) only if the seats did
    // not converge on a single observed origin (or none observed one).
    const observedOriginDigests = observedFinalUrls
      .filter((url): url is string => typeof url === "string" && url.length > 0)
      .map((url) => hostOriginDigest(url));
    const distinctObservedOrigins = new Set(observedOriginDigests);
    publicOriginDigest = distinctObservedOrigins.size === 1
      ? [...distinctObservedOrigins][0]
      // NOTHING observed (e.g. a handoff-timeout run where no seat ever navigated): fall back to the
      // DECLARED origin so a FAILED run's bundle stays structurally valid (every seat's route then
      // digests to the declared origin too). The run still fails closed for its own reason (HANDOFF_
      // TIMEOUT / no lobby convergence / no overlap-on-pass). GENUINE divergence (≥2 distinct observed
      // origins) leaves it undefined so verify fails closed on the non-convergence.
      : distinctObservedOrigins.size === 0
        ? declaredOriginDigest
        : undefined;

    // Lobby-convergence proof: a digest of the shared /lobby/CODE path iff EVERY seat converged on the
    // SAME code (a follower stuck on "/" yields no code → no false convergence). Digest-only. NOTE:
    // observedLobbyCodes may be a SPARSE array (a seat that never observed a code leaves a hole), and
    // Array.prototype.every SKIPS holes — so count the DEFINED codes explicitly, never rely on every().
    const definedCodes = observedLobbyCodes.filter((code): code is string => code !== undefined);
    const distinctCodes = new Set(definedCodes);
    if (distinctCodes.size === 1 && definedCodes.length === roles.length) {
      lobbyConvergenceDigest = commandDigestOf(`/lobby/${[...distinctCodes][0]}`);
    }
    if (handoffTimedOut && runError === undefined) {
      runError = `The host seat never produced a /lobby/CODE URL within the ${handoffDeadlineMs}ms handoff deadline; follower seats failed closed without opening.`;
    }
  }

  // Subject provenance: external-public is the operator-declared, operator-owned public deployment
  // (neither provisioned nor seeded); the provisioned path builds clone/local-tree provenance.
  const subject: RunSubjectProvenance = planeClass === "external-public"
    ? { source: "app-url", envNames: [], state: { provenance: "external-public" } }
    : buildSubjectProvenance({
        localTreeRoute,
        publicRepo,
        subjectCommit: localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit,
        localTreeArchive,
        subjectEnvNames,
        state: resolveSubjectState({ declared: config.subject.state, dryRun, executed: stateStepRecords })
      });
  const planeCommit = localTreeRoute ? localTreeArchive?.git?.commit : subjectCommit;

  // Collect per-actor warnings (each lane's own teardown/raw-screenshot notes).
  for (const result of actorResults) {
    warnings.push(...result.outcome.warnings);
  }

  const bundle = buildConcurrentSharedWorldBundle({
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    config,
    descriptor,
    createdAt,
    dryRun,
    runId,
    source,
    roles,
    actorSpecs,
    actorResults,
    stateSnapshots,
    subject,
    seedDigest,
    planeClass,
    ...(planeCommit === undefined ? {} : { subjectCommit: planeCommit }),
    ...(getHostUrl === undefined ? {} : { hostDigest: hostOriginDigest(getHostUrl) }),
    ...(publicOriginDigest === undefined ? {} : { publicOriginDigest }),
    ...(declaredOriginDigest === undefined ? {} : { declaredOriginDigest }),
    ...(lobbyConvergenceDigest === undefined ? {} : { lobbyConvergenceDigest }),
    ...(commsArtifactPath === undefined ? {} : { commsArtifactPath }),
    ...(runError === undefined ? {} : { runError })
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
      backend: "concurrent-shared-world",
      dryRun,
      laneCount: roles.length
    },
    sanitize: (text) => redactText(scrubKnownValues(text)),
    warnings: adapterWarnings,
    hookLabel: "sharedWorldHooks",
    ...(options.scorerProvenance === undefined ? {} : { scorerProvenance: options.scorerProvenance })
  });

  await writeConcurrentRunArtifacts(bundle, runPaths);
  // Finalize identity+liveness from the bundle just written. Deliberately here and not inside
  // writeConcurrentRunArtifacts — that writer is shared with the mid-run in-progress flushes, and
  // finalizing there would declare the run finished while it is still going (#455).
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
  if (observer.ok && liveObserver) {
    attachObserverRuntimeStreamUrls(observer as ObserverResult & { ok: true }, runtimeStreamUrls);
  }

  const roleOk = (result: ActorLaneResult | undefined): boolean => {
    if (dryRun) return true;
    return actorLanePassed(result);
  };
  // Concurrent "ok": every actor must produce a terminal, engaged PASSED session. This is a
  // harness/session-credibility gate, not mission-completion proof; a failed actor trace cannot
  // make the route green just because the harness got a terminal.
  const swarmRan = !dryRun && actorResults.length === roles.length
    && actorResults.every(actorLanePassed);
  const adapterFailure = adapterScoreFailureMessage(bundle);
  const ok = observer.ok && runError === undefined && (dryRun || swarmRan) && adapterFailure === undefined && scorerResult.declaredVerdictFailure === undefined;

  const overlapProven = !dryRun && actorWindowsOverlap(actorResults);

  const roleResults: ConcurrentSharedWorldRoleResult[] = actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const base = { id: spec.laneId, index: index + 1, persona: spec.persona.id };
    if (dryRun || !result) {
      return { ...base, status: "contract_proof_only", ok: dryRun };
    }
    const session = result.outcome.session;
    const thisOk = roleOk(result);
    return {
      ...base,
      status: session ? session.status : "failed",
      ok: thisOk,
      window: { startedAt: result.startedAt, endedAt: result.endedAt },
      ...(session
        ? { session: { status: session.status, completionReason: session.completionReason, reason: session.reason, screenshots: result.outcome.screenshots.length } }
        : {}),
      ...(result.outcome.sandboxId === undefined
        ? {}
        : { sandbox: { sandboxId: result.outcome.sandboxId, killed: result.outcome.killed } }),
      ...(thisOk
        ? {}
        : {
            error: {
              code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED" as const,
              message: result.outcome.sessionError
                ?? (result.outcome.noEngagement
                  ? "Actor took no actions and produced no message (likely a blank/still-loading screen); not a credible goal_satisfied."
                  : result.outcome.selfReportedBlocker
                    ? "Actor reported goal_satisfied while its final message described a blocker or asked for missing instructions; not a credible pass."
                  : session?.completionReason === "harness_error"
                    ? `Actor seat ended with a harness error: ${session.reason}`
                    : "Actor did not produce a terminal session.")
            }
          })
    };
  });

  const errorResult = ((): ConcurrentSharedWorldLabResult["error"] | undefined => {
    if (ok) return undefined;
    if (handoffTimedOut) {
      // Checked BEFORE the observer failure: the host never yielded a /lobby/CODE within the
      // deadline (followers failed closed without opening), which is the ROOT CAUSE — and it can
      // itself make the Observer unable to render a coherent run. Report the distinct, honest
      // handoff-timeout code rather than a generic observer/run failure.
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT", message: runError ?? "The host seat never produced a /lobby/CODE URL within the handoff deadline." };
    }
    if (hostHandoffFailure !== undefined) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: hostHandoffFailure };
    }
    if (!observer.ok) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: observer.error?.message ?? "Observer failed for the concurrent shared-world run." };
    }
    if (runError) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: runError };
    }
    if (adapterFailure !== undefined) {
      return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: adapterFailure };
    }
    const passed = roleResults.filter((role) => role.ok).length;
    return { code: "HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED", message: `Concurrent shared-world run did not run coherently: ${passed}/${roles.length} actor(s) reached a terminal, engaged passed session.` };
  })();

  return {
    schema: CONCURRENT_SHARED_WORLD_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptor.id,
    topology: "shared-world",
    topologyMode: "concurrent",
    roleCount: roles.length,
    concurrency,
    dryRun,
    runId,
    ...(getHostUrl === undefined ? {} : { host: getHostUrl }),
    ...(subjectSandboxId === undefined ? {} : { subjectSandbox: { sandboxId: subjectSandboxId, killed: subjectKilled } }),
    ...(dryRun ? {} : { overlapProven }),
    ...(dryRun ? {} : { maxSimultaneousLanes: maxSimultaneousWindows(actorResults) }),
    subject,
    roles: roleResults,
    observer,
    warnings: [...warnings, ...adapterWarnings, ...observer.warnings],
    ...(errorResult === undefined ? {} : { error: errorResult })
  };
}

/** Max windows live at the same instant (sweep over start/end points). The honest simultaneity
 *  count: lane COUNT says how many seats existed; this says how many ever ran at once. */
function maxSimultaneousWindows(windows: Array<{ startedAt: number; endedAt: number }>): number {
  const points = windows
    .filter((w) => w.endedAt > w.startedAt)
    .flatMap((w) => [{ at: w.startedAt, delta: 1 }, { at: w.endedAt, delta: -1 }]);
  points.sort((a, b) => a.at - b.at || a.delta - b.delta); // end before start at the same instant
  let live = 0;
  let max = 0;
  for (const point of points) {
    live += point.delta;
    if (live > max) max = live;
  }
  return max;
}

/** True when ≥2 actor windows overlap in time (the proven-concurrency signal). */
function actorWindowsOverlap(results: ActorLaneResult[]): boolean {
  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      const a = results[i]!;
      const b = results[j]!;
      if (a.startedAt < b.endedAt && b.startedAt < a.endedAt) {
        return true;
      }
    }
  }
  return false;
}

function actorLanePassed(result: ActorLaneResult | undefined): boolean {
  if (!result) return false;
  const session = result.outcome.session;
  return session !== undefined
    && session.status === "passed"
    && session.completionReason !== "harness_error"
    && result.outcome.sessionError === undefined
    && !result.outcome.noEngagement
    && !result.outcome.selfReportedBlocker;
}

/**
 * Keep three different claims separate in the stakeholder roll-up:
 *
 * - `outcome.ok` says the actor session passed the harness's credibility checks;
 * - `completionReason` says how the participant session ended;
 * - shared-world convergence is reported by the plane-specific summary alongside this line.
 *
 * None of those is adopter-scored proof that the mission text was completed. In particular, a
 * productive `budget_reached` session can coexist with lobby convergence without becoming a
 * `goal_satisfied` result (#364).
 */
function formatSharedWorldActorOutcomes(outcomes: SharedWorldOutcome[], expectedCount: number): string {
  const passedSessions = outcomes.filter((outcome) => outcome.ok).length;
  const goalSatisfiedSessions = outcomes.filter(
    (outcome) => outcome.ok && outcome.completionReason === "goal_satisfied"
  ).length;
  const completionReasonCounts = new Map<string, number>();
  for (const outcome of outcomes) {
    const reason = outcome.completionReason ?? "not_recorded";
    completionReasonCounts.set(reason, (completionReasonCounts.get(reason) ?? 0) + 1);
  }
  for (let missing = outcomes.length; missing < expectedCount; missing += 1) {
    completionReasonCounts.set("not_recorded", (completionReasonCounts.get("not_recorded") ?? 0) + 1);
  }
  const completionReasons = [...completionReasonCounts.entries()]
    // ASCII contract tokens: compare directly so bundle text is byte-stable across host locales.
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([reason, count]) => `${reason} ${count}/${expectedCount}`)
    .join(", ");

  return `${passedSessions}/${expectedCount} actor session(s) passed credibility checks; mission endpoint: ${goalSatisfiedSessions}/${expectedCount} ended goal_satisfied; completion reasons: ${completionReasons}`;
}

/** Project the concurrent run into a humanish.run-bundle.v1 with the CONCURRENT shared-world block. */
export function buildConcurrentSharedWorldBundle(args: {
  /** Lab provenance for the bundle\'s own `lab` field (#455). */
  lab?: RunLabProvenance;
  config: LabConfig;
  descriptor: CuaActorDescriptor;
  createdAt: string;
  dryRun: boolean;
  inProgress?: boolean;
  runId: string;
  source: RunBundle["source"];
  roles: LabActorLane[];
  actorSpecs: CuaLaneSpec[];
  actorResults: ActorLaneResult[];
  stateSnapshots: SharedWorldStateSnapshot[];
  subject: RunSubjectProvenance;
  seedDigest: string;
  subjectCommit?: string;
  hostDigest?: string;
  /** Run-level digest-only comms-thread evidence path (humanish.comms-thread.v1), when a comms lab
   *  captured mail into the subject sandbox's catch. Registered on the first persona stream (it is a
   *  property of the ONE shared app, not of any single persona). */
  commsArtifactPath?: string;
  /** #164 phase 2: the plane-class discriminator (default provisioned-getHost, byte-stable). */
  planeClass?: ConcurrentSharedWorldPlaneClass;
  /** external-public only: sha256-16 of the OBSERVED origin the seats converged on (the convergence
   *  proof — what the seats actually reached, tolerant of a declared->observed redirect). */
  publicOriginDigest?: string;
  /** external-public only: sha256-16 of the operator-DECLARED plane origin (evidence/reference only;
   *  NOT asserted equal to the observed origin — a cross-origin redirect is normal and expected). */
  declaredOriginDigest?: string;
  /** external-public only: sha256-16 of the shared /lobby/CODE path all seats converged on. */
  lobbyConvergenceDigest?: string;
  runError?: string;
}): RunBundle {
  const { config, descriptor, createdAt, dryRun, actorSpecs, actorResults, roles } = args;
  const inProgress = args.inProgress === true;
  const external = (args.planeClass ?? "provisioned-getHost") === "external-public";
  const simulations: RunSimulation[] = [];
  const streams: RunStream[] = [];
  const events: RunEvent[] = [];
  // Public-safe label only — neither the raw getHost URL (provisioned) nor the raw public origin
  // (external-public) lands in the bundle. The plane identity is a DIGEST (plane.hostDigest on
  // getHost; plane.publicOriginDigest on external-public).
  const appUrl = external ? "[external-public-plane]" : "[provisioned-subject]";
  const planeCommit = external ? undefined : dryRun ? undefined : args.subjectCommit;

  events.push({
    id: "event-000-created",
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.run.created",
    message: `Created CONCURRENT shared-world run for ${config.id} (actor ${descriptor.id}, ${actorSpecs.length} persona(s) vs ONE shared plane, max ${config.execution?.concurrency ?? actorSpecs.length} concurrent).`
  });
  // Human-readable plane label, byte-stable for the clone route (see shared-world-lab.ts's
  // buildSharedWorldBundle for the same pattern). local-tree has no repo slug: it labels the
  // packed archive instead (archiveSha256 + dirty/clean when the packed root was a git work tree).
  const dryRunPlaneLabel = args.subject.source === "local-tree"
    ? "packed working tree"
    : `clone of ${args.subject.repo}`;
  const livePlaneLabel = args.subject.source === "local-tree"
    ? (args.subject.archiveSha256
        ? `packed working tree (archiveSha256 ${args.subject.archiveSha256}${args.subject.dirty === true ? ", dirty working tree" : args.subject.dirty === false ? ", clean working tree" : ""})`
        : "packed working tree (archive digest unresolved; provisioning failed before resolution)")
    : `clone of ${args.subject.repo}${args.subjectCommit ? `@${args.subjectCommit}` : ""}`;
  // External-public plane provenance is HONESTLY different: an operator-declared, operator-OWNED
  // public deployment humanish neither provisioned nor seeded — NO getHost, NO clone, NO synthetic
  // attestation (claiming synthetic on a real site is a lie). The origin persists digest-only.
  const externalPlaneOwner = config.subject.publicTarget?.owner ?? "(operator-declared)";
  events.push({
    id: "event-001-plane",
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.plane.provenance",
    message: external
      ? `Shared plane: an EXTERNAL-PUBLIC deployment (operator-attested owner ${externalPlaneOwner}, authorized) used DIRECTLY as the shared plane — NO getHost, clone, subject sandbox, or seed. The harness OBSERVES that each seat reached the operator-declared origin (publicOriginDigest); it did NOT mint or control the plane. Author-trust ownership attestation, NOT a synthetic-data claim.`
      : dryRun
      ? `Shared plane declared: ${dryRunPlaneLabel}, served + getHost-exposed in-sandbox (dry-run contract; nothing ${args.subject.source === "local-tree" ? "packed" : "cloned"}). Seed recipe ${args.seedDigest}; SYNTHETIC subject (author-attested); env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted).`
      : `Shared plane: ${livePlaneLabel}, served + exposed at the harness-minted getHost URL; seed recipe ${args.seedDigest}; SYNTHETIC subject (author-attested); env names: ${args.subject.envNames?.join(", ") || "none"} (values never persisted).`,
    simId: actorSpecs[0]?.simId ?? "sim-001",
    streamId: actorSpecs[0]?.streamId ?? "stream-001"
  });

  let eventSeq = 2;
  const nextEventId = (suffix: string): string => `event-${String(eventSeq++).padStart(3, "0")}-${suffix}`;

  actorSpecs.forEach((spec, index) => {
    const taxonomy = laneTaxonomyLabel(spec);
    const result = actorResults[index];
    const outcome = result?.outcome;
    const session = outcome?.session;
    const screenshots = outcome?.screenshots ?? [];
    const lastScreenshot = screenshots[screenshots.length - 1];
    // public-safe (origin redacted): external-public seats open the public plane; getHost seats a seat path.
    const route = external ? "[external-public-plane]" : publicSafeRouteLabel(roles[index]?.entry);
    const status: RunSimulationStatus = session
      ? session.status
      : outcome?.sessionError
        ? "failed"
        : inProgress
          ? "running"
          : "contract_proof_only";
    const reason = session?.reason
      ?? outcome?.sessionError
      ?? (inProgress
        ? "Actor desktop is running; the attached Observer hydrates the runtime stream URL without persisting it."
        : "Contract actor only: dry-run produced the evidence shape without launching a desktop or spending provider tokens.");
    const traceScreenshotMode = session?.trace.redaction.screenshots;
    // Include `declared` on the no-outcome fallback too (dry-run, skipped lane): otherwise an
    // ABSENT declared means either "the preset rendered faithfully" or "there was no live
    // outcome", and a dry-run bundle keeps the self-confirming shape this field exists to kill.
    const fallbackDeclared = declaredScreenForRender(spec.devicePreset, spec.deviceName, spec.resolution);
    const desktopGeometry = outcome?.desktopGeometry ?? {
      screen: {
        requested: { width: spec.resolution[0], height: spec.resolution[1] },
        ...(fallbackDeclared ? { declared: fallbackDeclared } : {})
      }
    };
    const screenshotMode: "raw" | "blurred" =
      traceScreenshotMode === "raw" || traceScreenshotMode === "blurred"
        ? traceScreenshotMode
        : config.policies?.redactScreenshots === true ? "blurred" : "raw";

    simulations.push({
      id: spec.simId,
      index: index + 1,
      personaId: spec.persona.id,
      scenarioId: `concurrent-shared-world-${config.id}`,
      status,
      streamKind: "browser",
      mode: "browser-sim",
      progress: inProgress ? 35 : 100,
      currentStep: reason,
      summary: session
        ? `Persona ${spec.laneId}${taxonomy} (${spec.persona.id}): drove the shared plane concurrently; ${session.completionReason}.`
        : outcome?.sessionError
          ? `Persona ${spec.laneId}${taxonomy} failed before a terminal session verdict: ${outcome.sessionError}`
          : inProgress
            ? `Persona ${spec.laneId}${taxonomy} (${spec.persona.id}) is running against the shared plane.`
          : `Contract persona ${spec.laneId}${taxonomy} (${spec.persona.id}) for ${descriptor.id} against the shared plane at ${appUrl}.`,
      streamIds: [spec.streamId],
      startedAt: createdAt,
      updatedAt: createdAt
    });

    streams.push({
      id: spec.streamId,
      simId: spec.simId,
      kind: "browser",
      label: `Concurrent persona ${spec.laneId}${taxonomy} — ${config.id}`,
      status,
      transport: "snapshot",
      updatedAt: createdAt,
      embed: lastScreenshot
        ? { kind: "screenshot", url: lastScreenshot, title: `Shared plane, persona ${spec.laneId} (${screenshotMode})` }
        : { kind: "placeholder", title: `Shared plane, persona ${spec.laneId}` },
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
        route,
        intent: `Watch persona ${spec.laneId}${taxonomy} (${spec.persona.id}) drive the SHARED plane concurrently with the other personas.`,
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
          ? [{ label: `persona ${spec.laneId} actor trace`, path: spec.traceArtifactPath, kind: "trace" as const }]
          : []),
        // Run-level comms evidence belongs to the ONE shared app, not a persona — register it once, on
        // the first stream, so the bundle's existence-verify + public-safety scan cover it without
        // double-counting across seats.
        ...(index === 0 && args.commsArtifactPath
          ? [{ label: "comms thread", path: args.commsArtifactPath, kind: "log" as const }]
          : []),
        ...screenshots.map((screenshot, screenshotIndex) => ({
          label: `persona ${spec.laneId} screenshot ${String(screenshotIndex + 1).padStart(2, "0")} (${screenshotMode})`,
          path: screenshot,
          kind: "screenshot" as const
        }))
      ]
    });

    for (const warning of outcome?.warnings ?? []) {
      events.push({
        id: nextEventId(`warning-${spec.laneId}`),
        at: createdAt,
        level: "warn",
        type: "concurrent-shared-world.actor.warning",
        message: `Persona ${spec.laneId}: ${warning}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }

    if (session) {
      events.push({
        id: nextEventId(`session-${spec.laneId}`),
        at: createdAt,
        level: session.status === "passed" ? "info" : "warn",
        type: `concurrent-shared-world.session.${session.completionReason}`,
        message: `Persona ${spec.laneId}: ${session.status} — ${session.reason}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (outcome?.sessionError) {
      events.push({
        id: nextEventId(`session-error-${spec.laneId}`),
        at: createdAt,
        level: "error",
        type: "concurrent-shared-world.session.error",
        message: `Persona ${spec.laneId}: ${outcome.sessionError}`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else if (inProgress) {
      events.push({
        id: nextEventId(`running-${spec.laneId}`),
        at: createdAt,
        level: "info",
        type: "actor.running",
        message: `Persona ${spec.laneId}: desktop actor is running; live stream URL is runtime-only and not persisted.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    } else {
      events.push({
        id: nextEventId(`contract-${spec.laneId}`),
        at: createdAt,
        level: "info",
        type: "concurrent-shared-world.contract.ready",
        message: `Persona ${spec.laneId}: dry-run contract actor ready; switch scenario.mode to live for a real concurrent session.`,
        simId: spec.simId,
        streamId: spec.streamId
      });
    }
  });

  // Build the concurrent shared-world evidence block. routeHostDigest is sha256-16 of the ORIGIN each
  // seat reached: on getHost the seat URL the actor drove (verify confirms == plane.hostDigest); on
  // external-public the seat's CDP-OBSERVED URL origin (verify confirms == plane.publicOriginDigest).
  const fallbackHostDigest = external
    ? (args.publicOriginDigest ?? commandDigestOf("[external-public-plane]"))
    : (args.hostDigest ?? commandDigestOf("[provisioned-subject]"));
  const laneWindows: SharedWorldLaneWindow[] = actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const session = result?.outcome.session;
    const routeHostDigest = result ? hostOriginDigest(result.route) : fallbackHostDigest;
    return {
      roleId: spec.laneId,
      ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
      ...(spec.surface === undefined ? {} : { surface: spec.surface }),
      ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
      simId: spec.simId,
      streamId: spec.streamId,
      startedAt: result?.startedAt ?? 0,
      endedAt: result?.endedAt ?? 0,
      verdict: session ? session.status : result?.outcome.sessionError ? "failed" : inProgress ? "running" : "contract_proof_only",
      routeHostDigest,
      ...(planeCommit === undefined ? {} : { commit: planeCommit }),
      seedDigest: args.seedDigest
    };
  });

  // Option A (external-public): NO authoritative shared-state proof — OMIT stateSeries entirely (there
  // is no in-sandbox filesystem to digest; concurrency is proven by temporal co-occupancy + lobby
  // convergence). The provisioned-getHost plane keeps its authoritative in-sandbox checkpoint series.
  const stateSeries: SharedWorldStateSnapshot[] | undefined = external
    ? undefined
    : dryRun
      ? [{ timestamp: 0, digest: declaredStateDigest(config) }]
      : [...args.stateSnapshots].sort((a, b) => a.timestamp - b.timestamp);

  const outcomes: SharedWorldOutcome[] = actorSpecs.map((spec, index) => {
    const result = actorResults[index];
    const session = result?.outcome.session;
    const ok = !dryRun && actorLanePassed(result);
    return {
      roleId: spec.laneId,
      ...(spec.actorType === undefined ? {} : { actorType: spec.actorType }),
      ...(spec.surface === undefined ? {} : { surface: spec.surface }),
      ...(spec.caseGroup === undefined ? {} : { caseGroup: spec.caseGroup }),
      simId: spec.simId,
      streamId: spec.streamId,
      status: session ? session.status : result?.outcome.sessionError ? "failed" : inProgress ? "running" : "contract_proof_only",
      ...(session ? { completionReason: session.completionReason } : {}),
      ok
    };
  });

  // The plane block is plane-class-specific. getHost: harness-minted hostDigest + synthetic
  // attestation. external-public: operator-declared publicOriginDigest, NO hostDigest, NO exposure
  // (claiming synthetic on a real site would be a lie — verify asserts both ABSENT there).
  const plane: SharedWorldPlane = external
    ? {
        seedDigest: args.seedDigest,
        envNames: [],
        // publicOriginDigest is the OBSERVED convergence origin; declaredOriginDigest records the
        // operator-declared origin for reference (a redirect makes them differ — not a failure).
        ...(args.publicOriginDigest === undefined ? {} : { publicOriginDigest: args.publicOriginDigest }),
        ...(args.declaredOriginDigest === undefined ? {} : { declaredOriginDigest: args.declaredOriginDigest })
      }
    : {
        ...(planeCommit === undefined ? {} : { commit: planeCommit }),
        seedDigest: args.seedDigest,
        envNames: args.subject.envNames ?? [],
        ...(args.hostDigest === undefined ? {} : { hostDigest: args.hostDigest }),
        exposure: "synthetic"
      };

  const sharedWorld: SharedWorldEvidence = {
    schema: SHARED_WORLD_SCHEMA,
    topology: "shared-world",
    topologyMode: "concurrent",
    // Byte-stable: the provisioned-getHost plane omits planeClass (absent == provisioned-getHost).
    ...(external ? { planeClass: "external-public" as const } : {}),
    roleCount: actorSpecs.length,
    plane,
    attributionLimits: external ? [...EXTERNAL_PUBLIC_ATTRIBUTION_LIMITS] : [...CONCURRENT_ATTRIBUTION_LIMITS],
    laneWindows,
    // Option A: external-public carries NO stateSeries.
    ...(stateSeries === undefined ? {} : { stateSeries }),
    outcomes,
    ...(args.lobbyConvergenceDigest === undefined ? {} : { lobbyConvergenceDigest: args.lobbyConvergenceDigest })
  };

  const overlaps = actorWindowsOverlap(actorResults);
  const deltas = (stateSeries ?? []).filter((snapshot, i) => i > 0 && snapshot.digest !== (stateSeries ?? [])[i - 1]!.digest).length;
  const stateSeriesLabel = external
    ? "stateSeries omitted (no authoritative shared-state proof on the external-public plane)"
    : `stateSeries ${(stateSeries ?? []).length} snapshot(s), ${deltas} delta(s)`;
  const convergenceLabel = external
    ? `; lobby convergence ${args.lobbyConvergenceDigest ? "PROVEN (all seats reached one /lobby/CODE)" : "not observed"}`
    : "";
  // The count that matters is how many lanes were LIVE AT ONCE, not how many lanes exist — a
  // 6-lane run capped at 3 must never read as 6-wide concurrency (#350, the field failure).
  const capForReport = config.execution?.concurrency ?? laneWindows.length;
  const maxLive = maxSimultaneousWindows(laneWindows);
  events.push({
    id: nextEventId("concurrency"),
    at: createdAt,
    level: "info",
    type: "concurrent-shared-world.concurrency",
    message: `Concurrency: ${laneWindows.length} lane(s)${dryRun ? " (dry-run contract; $0)" : `, up to ${maxLive} live at once (cap ${capForReport}), overlap ${overlaps ? "PROVEN" : "not observed"}`}; ${stateSeriesLabel}${convergenceLabel}. Attribution ceiling: ${sharedWorld.attributionLimits.join(", ")}. ${dryRun ? "This contract-only run proves no live concurrency, scale, or adoption." : "This run reports only its own observed overlap and state changes; it does not prove scale, repeatability, or adopter-harness replacement."}`
  });

  // Concurrent verdict: dryRun → contract; else every actor produced a terminal, engaged PASSED
  // session → pass; otherwise fail. Mission endpoint and completion reasons are reported
  // separately below; `outcomes[].ok` is not renamed into mission success (#364).
  const verdict: ReviewSummary["verdict"] = dryRun
    ? "contract_proof_only"
    : inProgress
      ? "contract_proof_only"
    : (actorResults.length === actorSpecs.length
        && actorResults.every(actorLanePassed)
        ? "pass"
        : "fail");
  const actorOutcomeSummary = formatSharedWorldActorOutcomes(outcomes, actorSpecs.length);

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict,
    // Plane-class-aware: the external-public plane has NO getHost/clone/seed and carries NO
    // authoritative state series, so its summary must not claim a getHost-exposed plane (dry-run) nor
    // report "state delta(s) under load" (live) — it reports lobby convergence instead.
    summary: dryRun
      ? external
        ? `Dry-run concurrent shared-world contract: ${actorSpecs.length} persona(s) declared against ONE external-public shared plane (a real public deployment used directly; no getHost/clone/seed); no sandboxes launched, $0 spend.`
        : `Dry-run concurrent shared-world contract: ${actorSpecs.length} persona(s) declared against ONE getHost-exposed plane (${descriptor.id}); no sandboxes launched, $0 spend.`
      : inProgress
        ? `In-progress concurrent shared-world Observer snapshot: ${actorSpecs.length} persona(s) running against ONE shared plane; final verification is pending.`
      : external
        ? `Concurrent shared-world (ONE external-public plane, ${actorSpecs.length} simultaneous personas): swarm ${verdict === "pass" ? "ran coherently" : "did not run coherently"}; ${actorOutcomeSummary}; overlap ${overlaps ? "proven" : "not observed"}; ${args.lobbyConvergenceDigest ? `${actorSpecs.length} seats converged on one lobby` : "lobby convergence not observed"}.`
        : `Concurrent shared-world (ONE plane, ${actorSpecs.length} simultaneous personas): swarm ${verdict === "pass" ? "ran coherently" : "did not run coherently"}; ${actorOutcomeSummary}; overlap ${overlaps ? "proven" : "not observed"}; ${deltas} state delta(s) under load.`,
    gaps: dryRun
      ? ["This dry-run launched no concurrent shared-world session; it proves contract shape only, not live behavior, scale, or adopter-harness replacement."]
      : inProgress
        ? ["Final actor traces, screenshots, state deltas, and verification are pending; this Observer is for live watch only."]
      : actorResults
          .filter((result) =>
            result.outcome.sessionError !== undefined
            || result.outcome.noEngagement
            || result.outcome.selfReportedBlocker
            || result.outcome.session === undefined
            || result.outcome.session.status !== "passed")
          .map((result) => `${result.spec.laneId}: ${result.outcome.sessionError ?? result.outcome.session?.reason ?? "did not pass"}`)
  };

  const anyRaw = actorResults.some((result) => result.outcome.session?.trace.redaction.screenshots === "raw");
  const ranLive = actorResults.some((result) => result.outcome.session !== undefined || result.outcome.sessionError !== undefined);

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: dryRun ? "dry-run" : "live",
    simCount: actorSpecs.length,
    createdAt,
    cwd: PUBLIC_TARGET_CWD,
    ...(args.lab === undefined ? {} : { lab: args.lab }),
    artifactRoot: path.join(".humanish", "runs", args.runId),
    source: args.source,
    persona: {
      id: actorSpecs[0]?.persona.id ?? "concurrent-persona",
      name: `Concurrent shared-world swarm (${actorSpecs.length} personas)`,
      source: `lab:${config.id}`,
      sourceDigest: actorSpecs[0]?.persona.promptDigest ?? args.seedDigest
    },
    scenario: {
      id: `concurrent-shared-world-${config.id}`,
      title: config.title ?? `Concurrent shared-world: ${config.id}`,
      goal: redactText(actorSpecs[0]?.instructions ?? "Concurrent shared-world interaction."),
      source: `lab:${config.id}`,
      sourceDigest: actorSpecs[0]?.persona.promptDigest ?? args.seedDigest
    },
    lifecycle: [
      {
        at: createdAt,
        event: "concurrent-shared-world.run.created",
        message: `Created concurrent shared-world run with ONE shared plane and ${actorSpecs.length} simultaneous actor seats (actor ${descriptor.id}).`
      }
    ],
    simulations,
    streams,
    events,
    redaction: {
      status: "passed",
      notes: ranLive
        ? anyRaw
          ? "Typed text recorded as length only and reasoning/messages pass through text redaction. Some personas captured FULL-FIDELITY (raw) screenshots, retained for local use — NOT redacted for publishing; set policies.redactScreenshots: true to blur a share-as-is bundle. stateSeries persists digest-only."
          : "Typed text recorded as length only and reasoning/messages pass through text redaction. Screenshots are blurred at capture (policies.redactScreenshots: true) for a share-as-is bundle. stateSeries persists digest-only."
        : inProgress
          ? "In-progress live Observer snapshot: runtime stream auth URLs are process-local only and are not persisted. Final typed text, traces, and screenshots are pending. stateSeries persists digest-only."
        : "Dry-run concurrent shared-world contract bundle: no sandboxes launched and no screenshots captured. Typed text is recorded as length only and reasoning/messages pass through text redaction whenever a session runs. stateSeries persists digest-only."
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
    // Custom desktop image provenance (subject + every actor sandbox launched on it); omitted on the default.
    ...(config.execution?.desktop?.template === undefined ? {} : { desktopTemplate: config.execution.desktop.template }),
    subject: args.subject,
    attributionClass: "shared-world",
    sharedWorld
  };
}

/** The declared (dry-run) state digest: the probe RECIPE (command digests), no run. */
function declaredStateDigest(config: LabConfig): string {
  const probes = config.subject.state?.checkpoint ?? [];
  return combineCheckpointDigest(probes.map((probe) => `${probe.name}=${commandDigestOf(probe.command)}`));
}

function renderConcurrentReviewMarkdown(bundle: RunBundle): string {
  const plane = bundle.events.find((event) => event.type === "concurrent-shared-world.plane.provenance");
  const concurrency = bundle.events.find((event) => event.type === "concurrent-shared-world.concurrency");
  const sw = bundle.sharedWorld;
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- attribution class: ${bundle.attributionClass ?? "isolated"}`,
    `- topology: ${sw?.topology ?? "(none)"} / ${sw?.topologyMode ?? "(none)"}`,
    `- personas: ${sw?.roleCount ?? 0}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    ...(plane ? [`- plane: ${plane.message}`] : []),
    ...(concurrency ? [`- concurrency: ${concurrency.message}`] : []),
    ...(sw ? [`- attribution limits: ${sw.attributionLimits.join(", ")}`] : []),
    ...(bundle.review.gaps.length > 0 ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)] : []),
    ""
  ].join("\n");
}
