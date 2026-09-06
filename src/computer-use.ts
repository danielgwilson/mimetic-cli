import {
  ACTOR_TRACE_SCHEMA,
  type ActorCapabilities,
  type ActorCompletionReason,
  type ActorPersonaRef,
  type ActorStatus,
  type ActorTokenUsage,
  type ActorTrace,
  type ActorTraceItem,
  type ParticipantDeclaredOutcome,
  type ParticipantClosingReport
} from "./actor-contract.js";
import { classifyCuaAction, summarizeAffordanceUse, type AffordanceObservation } from "./affordance.js";
import { commandFailureInfo, isCommandExitError } from "./command-failure.js";
import type { RedactionHooks } from "./redaction.js";
import {
  evaluateStopWhen,
  type DwellWindow,
  type StopConditionMatch,
  type StopConditionObservation,
  type StopWhen
} from "./stop-conditions.js";
import { TaskTracker, type LabTask } from "./tasks.js";
import type { ReasoningEffort } from "./reasoning-effort.js";

// The computer-use (CUA) loop engine.
//
// This is a public-safe re-derivation of the proven loop semantics from a
// private single-actor reference implementation: drive a model over a real
// desktop turn by turn, observe the screen, act, and stop on a NATURAL endpoint
// or an unambiguous friction signal. It is deliberately provider- and
// substrate-agnostic: the model lives behind a CuaProvider port and the desktop
// behind a CuaExecutor port, so the engine is fully testable with fakes (no key,
// no spend, no SDK). The real OpenAI Responses provider and E2B desktop executor
// land behind these ports in a following slice.
//
// Stopping (Daniel 2026-06-06, decision locked in actor-contract.md): abandonment
// is persona-judged PRIMARY (the model decides it reached a natural endpoint and
// returns no further action -> goal_satisfied) with a harness-corroborated
// BACKSTOP that force-ends only on unambiguous pathology. The backstop is
// friction/progress-based, NEVER a turn budget: an idle streak (turns that take
// no material action) or a no-progress streak (turns that do not change the UI
// state). There is intentionally no maxSteps cap: turns are a terrible proxy for
// "stop". The only count-free hard stop is the wall-clock timeoutMs, and it is
// enforced as a deadline race on EVERY model and desktop await (raceSettle), so a
// hung provider or executor call cannot stall the loop forever; the abort signal
// is likewise honored before each action so a cancel cannot actuate the desktop.

export type CuaAction =
  | { kind: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "double_click"; x: number; y: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "type"; text: string }
  | { kind: "keypress"; keys: string[] }
  | { kind: "drag"; path: Array<{ x: number; y: number }> }
  | { kind: "wait"; ms?: number }
  | { kind: "screenshot" };

/** A captured desktop state: the (optional) frame plus a coarse signature for progress. */
export interface CuaObservation {
  /**
   * Raw PNG bytes of the current desktop. Redacted by the engine before persisting.
   * OPTIONAL: a non-vision (state-driven) executor omits it, and the loop persists no
   * screenshot that turn (counts.screenshots stays 0 → redaction.screenshots resolves to
   * "n/a", no Buffer.alloc(0) ever reaches disk). A VISION provider REQUIRES it — see
   * CuaProvider.requiresFrame, which trips a per-turn fail-closed harness_error when a frame
   * is required but absent.
   */
  screenshot?: Buffer;
  /**
   * A coarse, quantized signature of the visible UI used for no-progress
   * detection. Two observations with the same signature are "no progress". The
   * executor owns how it is computed (url, title, quantized scroll, focused
   * element, visible controls, etc.). STILL REQUIRED — the canonical fallback progress key
   * when appState is absent.
   */
  stateSignature: string;
  /**
   * Structured app state (e.g. a window.app.getState() projection). When present, friction
   * detection prefers a stable, deterministic, sorted-key JSON projection of it
   * (stableProgressKey) as the progress key, so route/turn/modal deltas drive progress more
   * reliably than a quantized screenshot signature can on a pixel-dense UI.
   *
   * RUNTIME-ONLY in this slice: appState is NEVER copied into any ActorTraceItem, reason, id,
   * or count, and is NEVER persisted to the trace — only the in-memory progress key is derived
   * from it and discarded. A structured app blob has no detectable secret "shape" (the
   * published-evidence scan catches only secret-shaped patterns), so it is treated exactly like
   * stateSignature, which is itself never written as text. A future "appState in evidence"
   * slice must route a stringified projection through redaction.redactText (and the lab's
   * scrubText) AND cap/whitelist fields before persisting — pattern+literal redaction alone
   * cannot sanitize an arbitrary blob.
   */
  appState?: Record<string, unknown>;
  /**
   * Optional browser state captured by an executor that can inspect the driven browser
   * deterministically (for example via Chrome DevTools Protocol). These fields are runtime-only:
   * they may drive stopWhen and progress decisions, but the loop never persists raw URL/title/text
   * into the trace. Persisting arbitrary DOM text would make private-data leakage too easy.
   */
  url?: string;
  /**
   * The page's vertical scroll offset (window.scrollY), when the executor can read it. Scroll
   * position IS state (#393): inside a scroll-pinned (scrollytelling) section the viewport stays
   * visually fixed while the participant advances, so the frame hash reads "no change" and the
   * no-progress backstop ended working reading sessions as gave_up. Runtime-only, like url/text —
   * it feeds the progress key (bucketed) and is never persisted.
   */
  scrollY?: number;
  title?: string;
  text?: string;
}

/**
 * A safety check the model raised. The triple is preserved verbatim from the
 * wire: providers match acknowledgements on `id`, so fabricating or collapsing
 * these fields would break the proceed path.
 */
export interface CuaSafetyCheck {
  /** Wire id the provider matches acknowledgements on. */
  id: string;
  /** Provider-defined category code (e.g. "malicious_instructions"). */
  code: string;
  /** Human-readable explanation from the model. */
  message: string;
}

export interface CuaTurnRequest {
  /** Persona + task instruction, sent as the system-level steer (first turn). */
  instructions: string;
  /** The latest observation for the model to react to. */
  observation: CuaObservation;
  /** Opaque continuation handle from the previous turn (provider-specific). */
  previousResponseId?: string;
  /** Safety checks the harness chose to acknowledge, passed back to the model. */
  acknowledgedSafetyChecks?: CuaSafetyCheck[];
  /** A nudge injected by the backstop before it trips, summarizing the stall. */
  contextHint?: string;
}

export interface CuaTurn {
  /** Continuation handle for the next turn. */
  responseId?: string;
  /** Model chain-of-thought summary, if the provider surfaces it. */
  reasoning?: string;
  /** Natural-language message (often the final summary on completion). */
  message?: string;
  /** Actions to perform this turn. Empty means the model is done. */
  actions: CuaAction[];
  /** Safety checks the provider flagged this turn. Non-empty pauses the run. */
  pendingSafetyChecks: CuaSafetyCheck[];
  /** Token accounting for this turn, if available. */
  usage?: { input?: number; output?: number; cachedInput?: number; cacheWriteInput?: number };
  /** True when the model reported a natural endpoint (no further action). */
  done: boolean;
  /** Explicit provider interruption, independent of actions or participant intent. */
  interruption?: "token_limit" | "incomplete" | "unexpected_status";
  /** The participant's own word for how it ended, when its reply format carries one (#570). */
  outcome?: ParticipantDeclaredOutcome;
  /** Present only for an accepted structured closing account. */
  closingReport?: ParticipantClosingReport;
}

/** The model side of the loop. Self-describes its identity and capabilities. */
export interface CuaProvider {
  readonly id: string;
  readonly version?: string;
  /**
   * The request settings this provider will actually send, for the trace to record. `version` says
   * WHICH model; this says how it was asked to run. Optional: a provider with no such settings
   * records none, and absence stays absence rather than becoming a default nobody chose.
   */
  readonly modelSettings?: { readonly reasoningEffort: ReasoningEffort; readonly maxOutputTokens?: number };
  readonly capabilities: ActorCapabilities;
  /**
   * True when nextTurn requires `observation.screenshot` to be present (a VISION model that
   * reasons over pixels). The OpenAI computer-use provider sets this; a state-reasoning
   * provider omits it (defaults falsey).
   *
   * PROVIDER-AUTHORING CONTRACT: a vision provider MUST set `requiresFrame: true`. The loop
   * uses it to convert what would otherwise be a silent blank-frame crash into a structured
   * per-turn fail-closed `harness_error` when a screenshot-less executor is paired with a
   * vision provider. Default-false is a known third-party-author footgun this slice accepts
   * (only one vision provider exists today) but records — see
   * docs/architecture/state-driven-executor.md.
   */
  readonly requiresFrame?: boolean;
  nextTurn(req: CuaTurnRequest, signal: AbortSignal): Promise<CuaTurn>;
  /** Optional read-only closing report. Implementations must disable tools and make no retries. */
  debrief?: ((req: CuaTurnRequest, signal: AbortSignal) => Promise<CuaTurn>) | undefined;
}

/** The desktop side of the loop. */
export interface CuaExecutor {
  /** Capture the current desktop frame and its state signature. */
  observe(): Promise<CuaObservation>;
  /**
   * Perform one action. The optional signal ends with this action's loop wait; honor it
   * before dispatching after async preparation. Wrappers must forward it. Cancellation
   * does not imply an already-dispatched desktop operation can be stopped.
   */
  execute(action: CuaAction, signal?: AbortSignal): Promise<void>;
}

export interface CuaLoopOptions {
  instructions: string;
  provider: CuaProvider;
  executor: CuaExecutor;
  persona: ActorPersonaRef;
  redaction: RedactionHooks;
  /** Hard wall-clock runaway guard. The only count-free hard stop. */
  timeoutMs: number;
  /**
   * Per-turn bound on the provider call (#469). Without it a single hung HTTP request was
   * indistinguishable from "the participant is still thinking" and cost the lane its whole
   * remaining budget: three lanes of one run stalled within seven seconds of each other and were
   * closed 36 minutes later as budget_reached with nothing in the trace to say why. A stalled
   * turn is retried once with a notice; a second stall ends the lane as harness_error, named.
   */
  turnTimeoutMs?: number;
  /**
   * Per-call bound on observation work (#480): executor.observe(), and the idle actions
   * (`wait`, `screenshot`, `move`) whose only job is to look. A default `wait` hung for ~90 s
   * inside the desktop SDK and ended a lane as actor_error after twelve turns of ordinary work.
   * A stalled observe is retried once; a stalled idle action is skipped with a notice.
   */
  observationTimeoutMs?: number;
  /** Injected clock (ms). Lets tests drive deadlines deterministically. */
  now: () => number;
  /** Cancellation. The loop checks it each turn and after each action batch. */
  signal?: AbortSignal;
  /** Idle streak (no material action) that trips the backstop. Default 6. */
  idleSteps?: number;
  /** Non-idle no-progress streak that trips the backstop. Default 8. */
  noProgressSteps?: number;
  /**
   * If the model flags safety checks, decide which to acknowledge. Returning the
   * list proceeds (the acks are echoed back on the next turn's request); returning
   * null/[] pauses the run (blocked_approval). Default: pause on any safety check
   * (fail-closed; real approval policy wires in later).
   */
  acknowledgeSafetyChecks?: (checks: CuaSafetyCheck[]) => CuaSafetyCheck[] | null;
  /**
   * Redact (blur+downscale) persisted screenshots. Default FALSE — full-fidelity frames are
   * retained, because the common case is a developer watching a sim of their OWN app locally
   * (gitignored .humanish), where blur destroys the core deliverable. Set true for unowned
   * subjects or when the bundle is meant to be shared as-is. The frame sent to the PROVIDER is
   * always full-resolution regardless (the model must see the screen to act); this flag only
   * governs what is PERSISTED. Publish-safety belongs at the publish boundary (commit scan / redactScreenshots), not capture.
   */
  redactScreenshots?: boolean;
  /**
   * Extra literal scrub for KNOWN provisioned values (which have no detectable "shape", so
   * pattern redaction cannot catch them), composed BEFORE redactText on every model-authored
   * text item (reasoning, message, completion summary) and the loop error. The lab passes the
   * env-value scrubber here so a value the MODEL narrates can never land raw in the trace.
   * Default: identity (the loop is shape-only on its own).
   */
  scrubText?: (text: string) => string;
  /** Persist a screenshot (raw or redacted per redactScreenshots), returning the trace ref path. */
  writeScreenshot?: (name: string, bytes: Buffer) => Promise<string>;
  /**
   * Deterministic harness-owned success guards. Evaluated after the initial observation and after
   * every post-action observation, before another model turn is requested. This keeps a lane from
   * wandering after the product already reached an app-visible endpoint.
   */
  stopWhen?: StopWhen;
  /**
   * A declared observation window (#510): once its condition matches (or after the first
   * observation when it has none) the loop holds the page for the window, captures a frame on the
   * cadence, takes no action and requests no model turn, then hands control back or ends. Runs at
   * most once per session and never past the session budget.
   */
  dwell?: DwellWindow;
  /** Injected pause for the dwell window's cadence; tests advance their clock through it. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The lab's declared protocol (#414): discrete tasks whose completion is corroborated by the
   * same observations stopWhen reads, on the same cadence. The tracker never influences the loop's
   * control flow — a completed task list does not stop a session (that is stopWhen's job); it only
   * records the funnel that lands on the trace. The participant-facing halves of these tasks are
   * already IN `instructions` (composed upstream); the loop reads only the `success` criteria,
   * which never reach the prompt.
   */
  tasks?: readonly LabTask[];
  /**
   * FAIL-CLOSED spend cap (USD). When set, the loop aborts (completionReason "budget_reached")
   * the moment the running ESTIMATED spend crosses it, BEFORE the next provider turn — the
   * runaway-retry-loop guard. Absent = uncapped (the historical CUA behavior). maxUsd: 0 means
   * no-spend (any measurable estimate > 0 aborts). Enforcement needs a measurable estimate, so
   * the lab refuses a cap on an unpriced model at PREFLIGHT rather than running uncapped.
   */
  maxUsd?: number;
  /**
   * Injected PURE per-turn cost estimator (keeps the loop free of the operator rate table and
   * makes the cap deterministic in tests). Given running (input, output) token totals, returns the
   * estimated USD, or null when unpriceable. Only consulted when `maxUsd` is set. A null estimate
   * mid-run cannot trip the cap — preflight already guaranteed a rate exists, so a null here is a
   * vanished-rate harness condition, not a silent uncapped pass.
   */
  estimateTurnCostUsd?: (usage: ActorTokenUsage) => number | null;
  /**
   * RUN-LEVEL spend guard (#299): called with this lane's running usage each turn, at the same
   * point the per-lane cap is checked. Returns a human-readable reason when the STUDY's shared
   * budget is exhausted, else null. On a non-null return the loop stops with `budget_reached`
   * regardless of material progress — a study-level stop is a recruiting decision hitting its
   * limit, not this participant's runaway, so it never reads as `gave_up`.
   */
  overRunBudget?: (usage: ActorTokenUsage) => string | null;
  /**
   * RUNTIME-ONLY observed-URL callback (#164 handoff crux): invoked with `observation.url` right
   * after EVERY executor.observe() (the initial observe and each post-action observe), so the
   * orchestrator can watch a seat's live `location.href` mid-run WITHOUT the loop ever persisting it.
   * The URL is the same runtime-only field documented on CuaObservation.url (never written to the
   * trace); this callback keeps that hygiene — it only hands the value back in memory. Used by the
   * concurrent shared-world barrier to latch a host seat's `/lobby/CODE` URL. Default: no-op.
   */
  onObservedUrl?: (url: string | undefined) => void;
  /**
   * RUNTIME-ONLY per-turn actor-narration callback: invoked with the model's own reasoning+message
   * text each turn. The concurrent shared-world host-first barrier scans it for the lobby code the
   * host states after creating the lobby — a CDP-INDEPENDENT path to the same code, because the
   * E2B-desktop Chrome CDP url-read the onObservedUrl path relies on is unreliable in practice. Like
   * onObservedUrl this is in-memory only; the barrier extracts a code and persists only a digest.
   * Default: no-op.
   */
  onMessage?: (text: string) => void;
  /**
   * RUNTIME-ONLY per-turn raw-frame callback: invoked with the same full-fidelity screenshot Buffer
   * the vision provider already sends to OpenAI that turn (never the redacted/persisted copy). The
   * concurrent shared-world host-first barrier vision-reads the lobby code straight off the host's
   * waiting-room frame — the robust CDP-INDEPENDENT relay, since the code is rendered on screen even
   * when the CDP url-read fails and even when the host never narrates it. The frame Buffer is in-memory
   * only here (this hook never persists it; the loop's own screenshot persistence is separate and
   * governed by redactScreenshots). Fire-and-forget (never awaited by the loop). Default: no-op.
   */
  onScreenshot?: (frame: Buffer) => void;
  /**
   * Per-turn trace snapshot callback (#441): invoked with the redacted trace items recorded so
   * far — once after the initial observation and once at the end of every turn (after that
   * turn's screenshot lands, so a flush never shows an action without the frame that preceded
   * it). The array is a fresh copy each call; items are already redaction-clean (they are the
   * same objects the final trace persists). Fire-and-forget: the loop never awaits the
   * receiver, so a slow disk flush can never stall a turn. Default: no-op.
   */
  /** Per-turn trace snapshot, with the RUNNING usage so a watcher can price a run in flight. */
  onTrace?: (items: readonly ActorTraceItem[], usage: ActorTokenUsage) => void;
}

export interface CuaLoopResult {
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  trace: ActorTrace;
}

/** Runtime validation is also required for third-party provider ports. */
export function validClosingReport(value: unknown): value is ParticipantClosingReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return Object.keys(report).length === 2
    && typeof report.summary === "string" && report.summary.trim().length > 0 && report.summary.length <= 4_000
    && Array.isArray(report.frictionReports) && report.frictionReports.length <= 8
    && report.frictionReports.every((item: unknown) => typeof item === "string" && item.trim().length > 0 && item.length <= 2_000);
}

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function completeTurnUsage(usage: CuaTurn["usage"]): boolean {
  return usage !== undefined && validTokenCount(usage.input) && validTokenCount(usage.output)
    && (usage.cachedInput === undefined || validTokenCount(usage.cachedInput))
    && (usage.cacheWriteInput === undefined || validTokenCount(usage.cacheWriteInput))
    && (usage.cachedInput ?? 0) + (usage.cacheWriteInput ?? 0) <= usage.input;
}

// Waiting is a legitimate strategy, not idleness. A persona told to sign up and verify by email
// polls its inbox — screenshot, wait, screenshot, wait — and at 6 steps that ended the session as
// `gave_up`/`failed` in well under a minute, before the mail could plausibly arrive. The concurrent
// shared-world route already overrode these to 80/40 for exactly this reason; the knowledge existed
// in the codebase and never reached the default every other route uses.
const DEFAULT_IDLE_STEPS = 24;
// The no-progress signal is much stronger since #383 (a stale frame alone no longer counts — the
// actor must also be repeating itself), so this needs less headroom than the raw idle count.
const DEFAULT_NO_PROGRESS_STEPS = 20;
const IDLE_PROGRESS_FORGIVENESS_STEPS = 2;
/** How many recent turns the repetition check looks back over (#383). */
const ACTION_REPEAT_WINDOW = 3;
/** Click/scroll coordinates are bucketed to this many pixels before fingerprinting, so a one-pixel
 *  jitter between two otherwise identical clicks still reads as the same attempt. */
const ACTION_FINGERPRINT_BUCKET = 24;

/**
 * A public-safe fingerprint of ONE turn's actions, used only in memory to tell "trying the same
 * thing again" from "trying something new" (#383).
 *
 * Never includes typed text or key contents — a `type` contributes its LENGTH, exactly as
 * describeCuaAction does, so this can never become a keylogger. Coordinates are bucketed so that
 * re-clicking the same control counts as a repeat while moving to a different control does not.
 */
export function actionFingerprint(actions: readonly CuaAction[]): string {
  const bucket = (value: number): number => Math.round(value / ACTION_FINGERPRINT_BUCKET);
  return actions
    .map((action) => {
      switch (action.kind) {
        case "click":
        case "double_click":
        case "move":
          return `${action.kind}@${bucket(action.x)},${bucket(action.y)}`;
        case "scroll":
          return `scroll@${bucket(action.x)},${bucket(action.y)}:${Math.sign(action.dx)},${Math.sign(action.dy)}`;
        case "type":
          return `type:${action.text.length}`;
        case "keypress":
          return `keypress:${action.keys.join("+")}`;
        case "drag":
          return `drag:${action.path.length}`;
        case "wait":
          return "wait";
        case "screenshot":
          return "screenshot";
      }
    })
    .join("|");
}

function isIdleAction(action: CuaAction): boolean {
  return action.kind === "screenshot" || action.kind === "wait";
}

function isIdleTurn(actions: CuaAction[]): boolean {
  return actions.length === 0 || actions.every(isIdleAction);
}

// Caps for stableProgressKey. The progress key is a coarse turn-over-turn comparison input,
// not a faithful serialization, so it bounds depth, breadth, string length, and total output —
// a huge or deeply nested appState can never blow up the comparison or the trace logging in
// tests. The values are deliberately generous (real route/turn/modal projections are tiny) but
// finite.
const STABLE_KEY_MAX_DEPTH = 6;
const STABLE_KEY_MAX_KEYS = 64;
const STABLE_KEY_MAX_ARRAY = 64;
const STABLE_KEY_MAX_STRING = 256;
const STABLE_KEY_MAX_TOTAL = 8192;

/**
 * A deterministic, bounded, sorted-key projection of an appState object, used as the friction
 * loop's progress key. Two structurally-equal states (regardless of key insertion order) map
 * to the SAME string, so key reordering can never fabricate a progress delta; two different
 * states map to different strings (within the caps).
 *
 * Correctness-load-bearing: it MUST NOT throw on a cyclic or huge input. Cycles are detected
 * with a seen-set (a back-edge degrades to the marker "[Circular]"); depth, key count, array
 * length, string length, and total output length are all capped so an adversarial or merely
 * large appState degrades to a bounded value rather than crashing the loop. Pure: it never
 * mutates the input. (See docs/architecture/state-driven-executor.md.)
 */
export function stableProgressKey(appState: Record<string, unknown>): string {
  const seen = new Set<unknown>();
  let truncated = false;
  const encode = (value: unknown, depth: number): string => {
    if (truncated) return '"…"';
    if (value === null) return "null";
    const type = typeof value;
    if (type === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : `"${String(value)}"`;
    if (type === "boolean") return value ? "true" : "false";
    if (type === "bigint") return `"${(value as bigint).toString()}"`;
    if (type === "string") {
      const s = value as string;
      return JSON.stringify(s.length > STABLE_KEY_MAX_STRING ? `${s.slice(0, STABLE_KEY_MAX_STRING)}…` : s);
    }
    if (type === "function" || type === "symbol" || type === "undefined") return `"[${type}]"`;
    // object or array
    if (depth >= STABLE_KEY_MAX_DEPTH) return '"[MaxDepth]"';
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const cap = Math.min(value.length, STABLE_KEY_MAX_ARRAY);
        const parts: string[] = [];
        for (let i = 0; i < cap; i += 1) {
          parts.push(encode(value[i], depth + 1));
          if (truncated) break;
        }
        if (value.length > STABLE_KEY_MAX_ARRAY) parts.push('"…"');
        return `[${parts.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const cap = Math.min(keys.length, STABLE_KEY_MAX_KEYS);
      const parts: string[] = [];
      for (let i = 0; i < cap; i += 1) {
        const key = keys[i] as string;
        parts.push(`${JSON.stringify(key)}:${encode(record[key], depth + 1)}`);
        if (truncated) break;
      }
      if (keys.length > STABLE_KEY_MAX_KEYS) parts.push('"…":"…"');
      return `{${parts.join(",")}}`;
    } finally {
      // Leave the set so sibling subtrees that legitimately repeat a shared reference still
      // serialize once per occurrence-path without false "Circular" hits across siblings.
      seen.delete(value);
    }
  };
  let out = encode(appState, 0);
  if (out.length > STABLE_KEY_MAX_TOTAL) {
    truncated = true;
    out = `${out.slice(0, STABLE_KEY_MAX_TOTAL)}…`;
  }
  return out;
}

/** The friction progress key: a stable projection of appState when present, else stateSignature. */
/** Pixels of vertical scroll per progress bucket (#393): a real scroll step (typically >=100px)
 *  crosses a bucket and counts as progress; sub-bucket jiggle does not, so an actor nudging the
 *  same dead panel cannot stay "progressing" forever. */
const SCROLL_PROGRESS_BUCKET_PX = 200;

function progressKeyOf(observation: CuaObservation): string {
  const base = observation.appState !== undefined ? stableProgressKey(observation.appState) : observation.stateSignature;
  // Scroll position is state (#393): a scroll-pinned section keeps the frame hash constant while
  // the participant genuinely advances, so the offset rides the key — bucketed, never raw.
  return observation.scrollY === undefined
    ? base
    : `${base}#s${Math.round(observation.scrollY / SCROLL_PROGRESS_BUCKET_PX)}`;
}

/** A public-safe one-line action label. Never includes raw typed text. */
export function describeCuaAction(action: CuaAction): string {
  switch (action.kind) {
    case "click":
      return `click (${action.x}, ${action.y})`;
    case "double_click":
      return `double-click (${action.x}, ${action.y})`;
    case "move":
      return `move (${action.x}, ${action.y})`;
    case "scroll":
      return `scroll (${action.dx}, ${action.dy}) at (${action.x}, ${action.y})`;
    case "type":
      return `type [${action.text.length} chars]`;
    case "keypress":
      return `keypress ${action.keys.join("+")}`;
    case "drag":
      return `drag ${action.path.length} points`;
    case "wait":
      return action.ms === undefined ? "wait" : `wait ${action.ms}ms`;
    case "screenshot":
      return "screenshot";
  }
}

/** Exported so the participant-vs-harness distinction is pinned directly, not inferred from a run. */
export function statusForCompletionReason(reason: ActorCompletionReason): ActorStatus {
  switch (reason) {
    case "goal_satisfied":
    case "turn_completed": // turn_completed is a Codex-lane reason; this loop emits goal_satisfied
      return "passed";
    // A session that ran out of time or budget did not reach its goal, whatever it achieved along
    // the way. Calling that `passed` is how a truncated study came to be reported as a green one —
    // and why "raise the timeout" kept landing on the operator instead of on the tool. This switch
    // is exhaustive with no default, so a new completion reason forces a compile error here.
    case "budget_reached":
      return "incomplete";
    case "timed_out":
      return "timed_out";
    case "blocked_approval":
      return "blocked";
    // A participant who stopped trying is the single most valuable thing a usability study
    // produces. Recording it as `failed` said the instrument broke, which is a different claim and
    // a false one — see docs/principles/three-roles.md.
    case "gave_up":
      return "abandoned";
    // Only the harness failing is a harness failure.
    case "actor_error":
    case "step_failed": // step_failed is the scripted-browser lane's reason; this loop never emits it
    case "harness_error":
      return "failed";
  }
}

// Distinct error classes so the loop can tell a deadline/abort apart from a real
// adapter failure when raceSettle rejects.
/**
 * Read the fixed closing line the prompt asks for (#570): the FIRST non-empty line of the
 * participant's last message, exactly one of three phrases, punctuation and case forgiven. Anything
 * else is absence, never a guess. Exported for tests.
 */
export function declaredOutcomeFromClosingLine(message: string | undefined): ParticipantDeclaredOutcome | undefined {
  if (message === undefined) return undefined;
  const first = message.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (first === undefined) return undefined;
  const normalized = first.replace(/^[*_#>\s-]+|[*_.!\s]+$/g, "").toLowerCase();
  if (normalized === "reached the goal") return "reached";
  if (normalized === "did not reach the goal") return "not_reached";
  if (normalized === "blocked") return "blocked";
  return undefined;
}

class CuaDeadlineError extends Error {}
class CuaAbortError extends Error {}
/** A single call outlived its own bound while the session still had budget: a stall, not a deadline. */
class CuaStallError extends Error {
  constructor(readonly what: string, readonly afterMs: number) {
    super(`${what} produced nothing within ${afterMs}ms`);
  }
}

export const DEFAULT_TURN_TIMEOUT_MS = 180_000;
export const DEFAULT_OBSERVATION_TIMEOUT_MS = 60_000;
// Internal control-flow signal: the per-turn frame guard already set completionReason/reason
// to a structured harness_error; this just unwinds the loop without being misread as an adapter
// failure in the catch block (it carries no message to persist).
class CuaFrameGuardStop extends Error {}
// Internal control-flow signal for deterministic harness stop conditions that match before the
// model is asked for another turn. completionReason/reason are already set by the caller.
class CuaStopWhenStop extends Error {}

const neverAbort: AbortSignal = new AbortController().signal;

/**
 * Wait on a port promise, but stop waiting if the wall-clock budget runs out or
 * the caller aborts. The underlying promise may still settle later (a promise
 * cannot be force-cancelled); we simply stop blocking the loop on it. An
 * already-settled promise always wins, so a fast op is never spuriously failed.
 */
/**
 * raceSettle with a second, tighter clock: the call's own bound. When the tighter clock wins the
 * result is a CuaStallError (the caller decides whether to retry); when the session clock wins it
 * stays a CuaDeadlineError, so the existing budget_reached / timed_out reading is untouched.
 */
async function raceBounded<T>(
  what: string,
  promise: Promise<T>,
  remainingMs: number,
  boundMs: number,
  signal?: AbortSignal
): Promise<T> {
  const cap = Math.min(remainingMs, boundMs);
  const boundWins = boundMs < remainingMs;
  try {
    return await raceSettle(promise, cap, signal);
  } catch (error) {
    if (error instanceof CuaDeadlineError && boundWins) throw new CuaStallError(what, cap);
    throw error;
  }
}

function raceSettle<T>(promise: Promise<T>, remainingMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new CuaAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      apply();
    };
    const onAbort = (): void => finish(() => reject(new CuaAbortError()));
    const timer = setTimeout(() => finish(() => reject(new CuaDeadlineError())), Math.max(0, remainingMs));
    if (typeof timer.unref === "function") timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

/**
 * Drive the computer-use loop to a single explicit completion and return an
 * ActorTrace. Every screenshot is redacted through the injected RedactionHooks
 * before its ref is recorded, so the trace is public-safe by construction.
 */
export async function runComputerUseLoop(options: CuaLoopOptions): Promise<CuaLoopResult> {
  const {
    instructions,
    provider,
    executor,
    persona,
    redaction,
    timeoutMs,
    now,
    signal,
    idleSteps = DEFAULT_IDLE_STEPS,
    noProgressSteps = DEFAULT_NO_PROGRESS_STEPS,
    acknowledgeSafetyChecks = () => null,
    redactScreenshots = false,
    scrubText = (text) => text,
    writeScreenshot = async (name) => `screenshots/${name}`,
    stopWhen,
    dwell,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    tasks,
    maxUsd,
    overRunBudget,
    estimateTurnCostUsd,
    onObservedUrl,
    onMessage,
    onScreenshot,
    onTrace
  } = options;
  const noProgressRecoverySteps = Math.min(Math.max(1, noProgressSteps - 1), 3);
  const idleRecoverySteps = Math.min(Math.max(1, idleSteps - 1), 3);
  // Model-authored narration: literal-scrub known provisioned values, THEN pattern-redact.
  // A value the model transcribes (a DB password it read on screen) has no shape, so redactText
  // alone cannot catch it — the lab's scrubKnownValues, injected as scrubText, closes that.
  const redactNarration = (text: string): string => redaction.redactText(scrubText(text));

  const startedAtMs = now();
  const remaining = (): number => timeoutMs - (now() - startedAtMs);
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const observationTimeoutMs = options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS;
  const items: ActorTraceItem[] = [];
  // The ONE recording choke point (#441): every trace item is stamped `at` from the
  // loop's injected clock as it is recorded, so timed playback reads recorded facts
  // (deterministic in tests via the injected `now`).
  const record = (item: ActorTraceItem): void => {
    items.push({ ...item, at: new Date(now()).toISOString() });
  };
  // Affordance classification (#369): WHICH route the actor took, recorded per dispatched action.
  // Collected here because the typed text exists only at dispatch — describeCuaAction deliberately
  // destroys it before it can reach the trace. Only the CLASS (and a scheme-shaped signal) is kept.
  const affordanceObservations: AffordanceObservation[] = [];
  const counts: Record<string, number> = {
    turns: 0,
    actions: 0,
    materialActions: 0,
    screenshots: 0,
    reasonings: 0,
    messages: 0,
    idleTurns: 0,
    noProgressTurns: 0
  };
  // The last few turns' action fingerprints, in memory only, for the #383 corroboration rule.
  const recentFingerprints: string[] = [];
  // Productivity signal for the wall-clock deadline: a session that took at least one material
  // (non-idle) action before the cap reached its BUDGET rather than stalling. A deadline hit with
  // zero material actions is still an honest failure (timed_out). Kept beside counts.materialActions
  // so the evidence self-describes the distinction.
  let materialActions = 0;
  let seq = 0;
  let usageInput = 0;
  let usageCachedInput = 0;
  let usageCacheWriteInput = 0;
  // Per provider-REQUEST usage, in order (#334): the recorded fact long-context pricing tiers
  // need — totals alone cannot say which requests crossed the provider's threshold.
  const usageTurns: NonNullable<ActorTokenUsage["turns"]> = [];
  // The running usage snapshot both spend guards consume: totals plus the per-request ledger,
  // shaped exactly like the trace's final tokenUsage so one estimator prices both identically.
  // Unlike the persisted trace (where absent means "unreported"), this runtime callback arg
  // ALWAYS carries numeric cache fields: pre-#334 guards received an object whose cachedInput
  // was always a number (0 included), and arithmetic on a suddenly-undefined field yields NaN —
  // which comparison operators swallow silently (red-team finding: a stale study-budget guard
  // would run uncapped without a sound).
  const runningUsage = (): ActorTokenUsage => ({
    input: usageInput,
    output: usageOutput,
    cachedInput: usageCachedInput,
    cacheWriteInput: usageCacheWriteInput,
    ...(usageTurns.length > 0 ? { turns: usageTurns } : {})
  });
  let usageOutput = 0;
  let sawUsage = false;
  let incompleteInteractionUsage = false;
  let lastResponseId: string | undefined;
  let currentPhase = "initializing computer-use loop";
  let lastActionTitle: string | undefined;
  let lastMaterialActionTitle: string | undefined;
  let lastScreenshotRef: ActorTraceItem["screenshotRef"] | undefined;
  const recentActionTitles: string[] = [];

  const nextId = (kind: string): string => `${kind}-${(seq += 1).toString().padStart(3, "0")}`;
  const bump = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  const recordUsage = (turn: CuaTurn, interaction = true): void => {
    if (interaction && !completeTurnUsage(turn.usage)) incompleteInteractionUsage = true;
    const raw = turn.usage;
    if (raw === undefined) return;
    const usage = {
      ...(validTokenCount(raw.input) ? { input: raw.input } : {}),
      ...(validTokenCount(raw.output) ? { output: raw.output } : {}),
      ...(validTokenCount(raw.cachedInput) ? { cachedInput: raw.cachedInput } : {}),
      ...(validTokenCount(raw.cacheWriteInput) ? { cacheWriteInput: raw.cacheWriteInput } : {})
    };
    if (Object.keys(usage).length === 0) return;
    sawUsage = true;
    usageInput += usage.input ?? 0;
    usageCachedInput += usage.cachedInput ?? 0;
    usageCacheWriteInput += usage.cacheWriteInput ?? 0;
    usageOutput += usage.output ?? 0;
    usageTurns.push(usage);
  };

  // Whether any observation this run surfaced structured appState (a non-vision/state executor).
  // RUNTIME-ONLY signal: used solely to self-describe in redaction.notes that app state drove
  // progress detection and was NOT written to the trace — the appState itself never persists.
  let observedAppState = false;

  // Guarded screenshot persistence: a non-vision executor returns an observation with no
  // screenshot, and the loop persists none that turn (counts.screenshots stays 0 → the existing
  // "n/a" branch resolves redaction.screenshots). No Buffer.alloc(0) ever reaches disk.
  const maybeRecordScreenshot = async (observation: CuaObservation, label: string): Promise<void> => {
    const frame = observation.screenshot;
    if (frame === undefined) return;
    currentPhase = `writing screenshot ${label}`;
    // Default: persist the raw frame (full fidelity, local-only). redactScreenshots flips to the
    // publish-safe blurred thumbnail. Either way the bytes the model already saw were raw.
    const { bytes, method } = redactScreenshots
      ? await redaction.redactScreenshot(frame, { label }).then((r) => ({ bytes: r.buffer, method: r.method }))
      : { bytes: frame, method: "none" as const };
    const path = await writeScreenshot(`${label}.png`, bytes);
    const screenshotRef: ActorTraceItem["screenshotRef"] = { path, redaction: method };
    lastScreenshotRef = screenshotRef;
    record({
      id: nextId("screenshot"),
      kind: "screenshot",
      lifecycle: "completed",
      title: label,
      screenshotRef
    });
    bump("screenshots");
  };

  // One projection feeds BOTH the stop guard and the task tracker, so a criterion that would stop
  // the run and a criterion that completes a task can never see different evidence for one turn.
  const stopObservationOf = (observation: CuaObservation): StopConditionObservation => ({
    ...(observation.url === undefined ? {} : { url: observation.url }),
    ...(observation.text === undefined ? {} : { text: observation.text }),
    ...(observation.appState === undefined ? {} : { appState: observation.appState })
  });

  const matchedStopWhen = (observation: CuaObservation): StopConditionMatch | undefined =>
    evaluateStopWhen(stopWhen, stopObservationOf(observation));

  // The funnel is recorded, never consulted: task completion does not steer the loop. Evaluated
  // BEFORE the stopWhen check each turn so a final task whose criterion coincides with the stop
  // condition still lands in the funnel of the very turn that ends the session.
  const taskTracker = tasks !== undefined && tasks.length > 0 ? new TaskTracker(tasks) : undefined;
  const observeTasks = (observation: CuaObservation, turn: number): void => {
    if (taskTracker === undefined) return;
    for (const completion of taskTracker.observe(stopObservationOf(observation), turn)) {
      // The id is researcher-authored config and the kinds are rule-type names; the matched VALUES
      // (a URL, page text) never appear here — the same discipline as stopWhenTraceItem.
      record({
        id: nextId("notice"),
        kind: "notice",
        lifecycle: "completed",
        status: "matched",
        title: `task completed: ${redactNarration(completion.id)}`,
        text: redactNarration(
          `turn ${turn}; matched rule ${completion.matchedRuleIndex} (${completion.matchedKinds.join("+")})`
        )
      });
    }
  };

  let completionReason: ActorCompletionReason = "goal_satisfied";
  let declaredOutcome: ParticipantDeclaredOutcome | undefined;
  let reason = "computer-use loop completed";
  let stopConditionMatch: StopConditionMatch | undefined;

  // A vision provider against a screenshot-less observation is a fail-closed harness error, not
  // a silent crash: record it and break. Returns true when the run must stop. (The provider sets
  // requiresFrame; a state-reasoning provider omits it.)
  const frameGuardTripped = (observation: CuaObservation): boolean => {
    if (provider.requiresFrame === true && observation.screenshot === undefined) {
      completionReason = "harness_error";
      reason = `provider ${provider.id} requires a screenshot frame but the executor returned an observation with no screenshot (vision provider against a state-only executor)`;
      return true;
    }
    return false;
  };

  // Loop-local state. Declared here (before the try) so the initial observe + the per-turn
  // frame guard can fail closed cleanly while these still scope across the loop.
  let previousResponseId: string | undefined;
  let closingObservation: CuaObservation | undefined;
  let closingTrigger: "stop_when" | "dwell" | undefined;
  let debrief: ActorTrace["debrief"];
  let consecutiveIdle = 0;
  // One canonical "no progress" signal: turns that did not change the UI state
  // signature (idle or not). The nudge, the stop threshold, and the reason all
  // key off this counter, and it catches alternating idle/no-progress stalls
  // that two separate counters would let slip past every backstop but the clock.
  let consecutiveNoProgress = 0;
  let lastSignature = "";
  let contextHint: string | undefined;
  let idleProgressForgivenessUsed = 0;
  // Acks granted for the previous turn's safety checks. They must ride the
  // NEXT request (the one carrying that call's computer_call_output), so they
  // are staged here rather than written onto the request already sent.
  let pendingAcks: CuaSafetyCheck[] | undefined;
  try {
    currentPhase = "observing initial UI state";
    // A stalled observe is retried once (#480); a second stall is the substrate telling us it is
    // gone, and that ends the lane with its own name rather than an unexplained deadline.
    const observeBounded = async (label: string): Promise<CuaObservation> => {
      try {
        return await raceBounded(`observe (${label})`, executor.observe(), remaining(), observationTimeoutMs, signal);
      } catch (error) {
        if (!(error instanceof CuaStallError)) throw error;
        record({
          id: nextId("notice"),
          kind: "notice",
          lifecycle: "completed",
          status: "warn",
          title: "observation stalled; retrying once",
          text: `${error.what} produced nothing within ${error.afterMs}ms; asking the desktop again`
        });
        return await raceBounded(`observe (${label}, retry)`, executor.observe(), remaining(), observationTimeoutMs, signal);
      }
    };
    // The declared observation window (#510). The harness holds, looks, and takes nothing back to
    // the model: no action, no turn, no tokens. It runs once, cut to whatever session budget is
    // left, and says in the trace that the time was deliberate.
    let dwellDone = false;
    let dwellHeldMs = 0;
    const dwellIfDue = async (observation: CuaObservation, turnNumber: number): Promise<"continue" | "stop" | undefined> => {
      if (dwell === undefined || dwellDone) return undefined;
      if (dwell.when !== undefined && evaluateStopWhen(dwell.when, stopObservationOf(observation)) === undefined) return undefined;
      dwellDone = true;
      const trigger = dwell.when === undefined ? "at the start" : "its condition matched";
      const budget = Math.min(dwell.ms, Math.max(0, remaining() - dwell.everyMs));
      if (budget < dwell.everyMs) {
        record({
          id: nextId("notice"),
          kind: "notice",
          lifecycle: "completed",
          status: "warn",
          title: "dwell window skipped",
          text: `${trigger} at turn ${turnNumber}, but only ${Math.max(0, remaining())}ms of session budget remained for a ${dwell.ms}ms window`
        });
        return undefined;
      }
      const dwellStartedAtMs = now();
      record({
        id: nextId("notice"),
        kind: "notice",
        lifecycle: "started",
        title: "dwell window started",
        text: `${trigger} at turn ${turnNumber}: holding ${budget}ms, a frame every ${dwell.everyMs}ms, no actions, no model turns`
      });
      let frames = 0;
      while (now() - dwellStartedAtMs < budget) {
        if (signal?.aborted) throw new CuaAbortError();
        await sleep(Math.min(dwell.everyMs, budget - (now() - dwellStartedAtMs)));
        currentPhase = `dwell frame ${frames + 1}`;
        const frameObservation = await observeBounded(`dwell frame ${frames + 1}`);
        frames += 1;
        if (frameObservation.screenshot !== undefined) onScreenshot?.(frameObservation.screenshot);
        await maybeRecordScreenshot(frameObservation, `dwell-${frames.toString().padStart(2, "0")}`);
        onTrace?.(items.slice(), runningUsage());
        observeTasks(frameObservation, turnNumber);
      }
      dwellHeldMs = now() - dwellStartedAtMs;
      record({
        id: nextId("notice"),
        kind: "notice",
        lifecycle: "completed",
        // A window that ENDS the session is structured, harness-owned completion evidence, the
        // same class as a matched stopWhen, and the verdict resolver reads it that way.
        status: dwell.then === "stop" ? "matched" : "ok",
        title: "dwell window complete",
        text: `${frames} frame(s) over ${dwellHeldMs}ms; no model turn was requested during the window`
      });
      if (dwell.then === "stop") return "stop";
      contextHint = `The study held this page under observation for ${Math.round(dwellHeldMs / 1000)} seconds (a declared dwell window; you took no actions in that time). Continue the mission from the current state of the page.`;
      return "continue";
    };
    let observation = await observeBounded("initial");
    // Runtime-only: hand the seat's live location.href back to the orchestrator (never persisted).
    onObservedUrl?.(observation.url);
    if (observation.screenshot !== undefined) onScreenshot?.(observation.screenshot);
    if (observation.appState !== undefined) observedAppState = true;
    // Fail closed BEFORE the first turn if a vision provider got a screenshot-less observation.
    if (frameGuardTripped(observation)) throw new CuaFrameGuardStop();
    await maybeRecordScreenshot(observation, "turn-00-start");
    onTrace?.(items.slice(), runningUsage());
    observeTasks(observation, 0);
    const initialDwell = await dwellIfDue(observation, 0);
    if (initialDwell !== undefined) {
      observation = await observeBounded("after dwell");
      onObservedUrl?.(observation.url);
      if (observation.screenshot !== undefined) onScreenshot?.(observation.screenshot);
      await maybeRecordScreenshot(observation, "turn-00-after-dwell");
      observeTasks(observation, 0);
      if (initialDwell === "stop") {
        completionReason = "goal_satisfied";
        reason = `dwell window complete (${dwellHeldMs}ms held at the start)`;
        closingObservation = observation;
        closingTrigger = "dwell";
        throw new CuaStopWhenStop();
      }
    }
    stopConditionMatch = matchedStopWhen(observation);
    if (stopConditionMatch) {
      completionReason = "goal_satisfied";
      reason = stopWhenReason(stopConditionMatch);
      closingObservation = observation;
      closingTrigger = "stop_when";
      record(stopWhenTraceItem(nextId("notice"), stopConditionMatch, redactNarration));
      throw new CuaStopWhenStop();
    }
    // The progress key prefers a stable appState projection (route/turn/modal deltas drive
    // progress) and falls back to the executor's stateSignature — so a state executor with a
    // constant signature still registers progress, and a vision executor behaves exactly as before.
    lastSignature = progressKeyOf(observation);

    // Bounded by wall-clock and the friction backstops, never a turn count.
    for (;;) {
      if (signal?.aborted) {
        completionReason = "harness_error";
        reason = "run aborted by the harness";
        break;
      }
      if (now() - startedAtMs > timeoutMs) {
        if (materialActions > 0) {
          completionReason = "budget_reached";
          reason = `reached the ${timeoutMs}ms time budget after productive activity (${materialActions} material action(s), ${counts.turns} turn(s))`;
        } else {
          completionReason = "timed_out";
          reason = `wall-clock deadline reached after ${timeoutMs}ms with no material progress`;
        }
        break;
      }

      const turnNumber = (counts.turns ?? 0) + 1;
      const request: CuaTurnRequest = { instructions, observation };
      if (previousResponseId !== undefined) request.previousResponseId = previousResponseId;
      if (contextHint !== undefined) request.contextHint = contextHint;
      if (pendingAcks !== undefined) request.acknowledgedSafetyChecks = pendingAcks;
      contextHint = undefined;
      pendingAcks = undefined;

      currentPhase = `requesting provider turn ${turnNumber}`;
      // Bounded per call (#469): one hung request used to be indistinguishable from thinking
      // and cost the lane its whole remaining budget. One retry with a notice; then the lane ends
      // as harness_error, named, instead of thirty silent minutes.
      let turn: CuaTurn;
      try {
        turn = await raceBounded(`provider turn ${turnNumber}`, provider.nextTurn(request, signal ?? neverAbort), remaining(), turnTimeoutMs, signal);
      } catch (error) {
        if (!(error instanceof CuaStallError)) throw error;
        record({
          id: nextId("notice"),
          kind: "notice",
          lifecycle: "completed",
          status: "warn",
          title: "provider turn stalled; retrying once",
          text: `${error.what} produced nothing within ${error.afterMs}ms; sending the same observation again`
        });
        try {
          turn = await raceBounded(`provider turn ${turnNumber} (retry)`, provider.nextTurn(request, signal ?? neverAbort), remaining(), turnTimeoutMs, signal);
        } catch (retryError) {
          if (!(retryError instanceof CuaStallError)) throw retryError;
          completionReason = "harness_error";
          reason = `provider turn ${turnNumber} stalled twice (${retryError.afterMs}ms each); the model produced no turn and the lane was ended rather than left to run out its budget`;
          record({
            id: nextId("notice"),
            kind: "notice",
            lifecycle: "completed",
            status: "error",
            title: "provider turn stalled twice",
            text: reason
          });
          break;
        }
      }
      bump("turns");
      previousResponseId = turn.responseId ?? previousResponseId;
      lastResponseId = turn.responseId ?? lastResponseId;
      recordUsage(turn);
      if (turn.interruption !== undefined) {
        // A provider can exhaust its response budget before producing visible text, or midway
        // through an action. Preserve usage and partial narration, but never interpret either as
        // participant completion or dispatch actions from an explicitly incomplete response.
        overRunBudget?.(runningUsage());
        if (turn.reasoning) {
          record({ id: nextId("reasoning"), kind: "reasoning", lifecycle: "completed", status: "warn",
            title: `incomplete reasoning turn ${turnNumber}`, text: redactNarration(turn.reasoning) });
          bump("reasonings");
        }
        if (turn.message) {
          record({ id: nextId("message"), kind: "message", lifecycle: "completed", status: "warn",
            title: `incomplete message turn ${turnNumber}`, text: redactNarration(turn.message) });
          bump("messages");
        }
        const tokenLimit = turn.interruption === "token_limit";
        const unexpectedStatus = turn.interruption === "unexpected_status";
        completionReason = tokenLimit ? "budget_reached" : "harness_error";
        reason = tokenLimit
          ? "the provider's output/context token limit interrupted this response; the participant did not report completion. No actions or closing request followed the incomplete response."
          : unexpectedStatus
            ? "the provider returned an unexpected noncompleted response status; the participant did not report completion. No actions or closing request followed this response."
            : "the provider returned an explicitly incomplete response; the participant did not report completion. No actions or closing request followed the incomplete response.";
        record({ id: nextId("notice"), kind: "notice", lifecycle: "completed", status: tokenLimit ? "warn" : "error",
          title: tokenLimit ? "provider token limit reached" : unexpectedStatus ? "unexpected provider response status" : "provider response incomplete", text: reason });
        break;
      }
      // RUNTIME-ONLY: hand the model's narration back so the concurrent host-first barrier can read
      // the lobby code the host states after creating the lobby (CDP url-read is unreliable). Raw
      // text stays in memory; only an extracted code is used (and only as a digest).
      {
        const narration = [turn.reasoning, turn.message]
          .filter((t): t is string => typeof t === "string" && t.length > 0)
          .join("\n");
        if (narration.length > 0) onMessage?.(narration);
      }
      // FAIL-CLOSED spend cap (runaway-retry guard). Placed alongside the wall-clock runaway stop
      // above and BEFORE the next provider.nextTurn request, so a model stuck retrying cannot keep
      // spending: the moment the running estimate crosses maxUsd the loop breaks with a terminal,
      // non-harness-error stop. A null estimate cannot trip it (preflight guaranteed a rate).
      //
      // Classify the outcome HONESTLY, mirroring the wall-clock path above: budget_reached maps to
      // "passed", a verdict only earned AFTER material progress (real work that then hit its cost
      // budget). A zero-action runaway that crosses the cap is NOT a pass — it is the exact runaway
      // the cap exists to catch (maxUsd:0 makes it deterministic: the first turn with any usage
      // trips here before any action executes) — so it surfaces as "gave_up" (→ failed). Either way
      // the running estimate + the cap are cited so the operator sees WHY the loop stopped.
      if (maxUsd !== undefined && estimateTurnCostUsd) {
        const running = estimateTurnCostUsd(runningUsage());
        // Fail CLOSED and LOUD on a non-finite estimate: a stale positional estimator (the
        // pre-#334 (input, output, cachedInput) signature) arithmetics the usage OBJECT into
        // NaN, and NaN > maxUsd is false forever — a spend cap that silently never trips is
        // the one failure mode this guard exists to prevent (red-team finding).
        if (running !== null && !Number.isFinite(running)) {
          completionReason = "harness_error";
          reason = "the injected estimateTurnCostUsd returned a non-finite estimate while execution.caps.maxUsd is set — likely a stale pre-#334 positional (input, output, cachedInput) callback; it now receives one ActorTokenUsage object. Failing closed instead of running uncapped.";
          break;
        }
        if (running !== null && running > maxUsd) {
          if (materialActions > 0) {
            completionReason = "budget_reached";
            reason = `estimated spend $${running} crossed execution.caps.maxUsd=$${maxUsd} after productive activity (${materialActions} material action(s), ${counts.turns} turn(s)); aborted fail-closed before the next model turn`;
          } else {
            completionReason = "gave_up";
            reason = `estimated spend $${running} crossed execution.caps.maxUsd=$${maxUsd} with no material progress; aborted fail-closed before the next model turn`;
          }
          break;
        }
      }
      // The STUDY budget (#299), beside the per-lane cap above and before any further model turn.
      if (overRunBudget) {
        const runStop = overRunBudget(runningUsage());
        if (runStop !== null) {
          completionReason = "budget_reached";
          reason = runStop;
          break;
        }
      }
      if (turn.reasoning) {
        record({
          id: nextId("reasoning"),
          kind: "reasoning",
          lifecycle: "completed",
          title: `reasoning turn ${turnNumber}`,
          text: redactNarration(turn.reasoning)
        });
        bump("reasonings");
      }
      if (turn.message) {
        record({
          id: nextId("message"),
          kind: "message",
          lifecycle: "completed",
          title: `message turn ${turnNumber}`,
          text: redactNarration(turn.message)
        });
        bump("messages");
      }

      if (turn.pendingSafetyChecks.length > 0) {
        const acks = acknowledgeSafetyChecks(turn.pendingSafetyChecks);
        if (acks === null || acks.length === 0) {
          // Safety-check categories are provider-defined enums (e.g.
          // "malicious_instructions"), not free text; record them (redacted for
          // defense-in-depth) so the evidence shows WHY the run paused.
          const checks = redaction.redactText(turn.pendingSafetyChecks.map((check) => check.code).join(", "));
          record({
            id: nextId("approval"),
            kind: "approval",
            lifecycle: "completed",
            status: "blocked",
            title: `safety check: ${checks}`
          });
          completionReason = "blocked_approval";
          reason = `paused on model safety check(s): ${checks}; not acknowledged`;
          break;
        }
        pendingAcks = acks;
      }

      if (turn.done || turn.actions.length === 0) {
        // The participant's own word, when its reply format has one (#570). "not_reached" is a
        // participant who stopped without finishing: gave_up, which tallies as abandoned. "blocked"
        // keeps goal_satisfied here (the actor did stop on purpose) and the lane's credibility read
        // turns it into a blocked participant, the same path a narrated blocker takes.
        // A schema field first; failing that, the fixed first line the prompt asks for (#570).
        const outcome = turn.outcome ?? declaredOutcomeFromClosingLine(turn.message);
        if (outcome !== undefined) declaredOutcome = outcome;
        completionReason = outcome === "not_reached" ? "gave_up" : "goal_satisfied";
        const summary = turn.message?.trim();
        reason = summary
          ? redactNarration(summary)
          : "model reported a natural endpoint with no further action";
        // A done turn takes no actions, so the cadence above never observes the participant's
        // FINAL state — and a task completed by that state read as incomplete. The first live
        // study caught it: both participants reached the dashboard, said so, and the funnel
        // reported 0/2. One guarded closing observation feeds the tracker; a failed observe
        // changes nothing (the funnel stays honest about what it saw), and no screenshot or
        // stop evaluation rides it — the session is already over.
        if (taskTracker !== undefined) {
          try {
            const closing = await observeBounded("closing");
            observeTasks(closing, turnNumber);
          } catch {
            // Best-effort by design.
          }
        }
        break;
      }

      const idleThisTurn = isIdleTurn(turn.actions);
      for (const action of turn.actions) {
        if (signal?.aborted) throw new CuaAbortError();
        const actionTitle = describeCuaAction(action);
        lastActionTitle = actionTitle;
        recentActionTitles.push(actionTitle);
        if (recentActionTitles.length > 8) recentActionTitles.shift();
        // Captured so a recovered (skipped) material action can restore it: a
        // skipped action must not leave its title as the "last material action".
        const priorMaterialActionTitle = lastMaterialActionTitle;
        if (!isIdleAction(action)) {
          lastMaterialActionTitle = actionTitle;
          materialActions += 1;
          counts.materialActions = materialActions;
        }
        bump("actions");
        // Classify BEFORE execute, mirroring counts.actions: the record is of what the actor
        // CHOSE, so an action that then fails to actuate is still an honest record of the route
        // it reached for.
        affordanceObservations.push(classifyCuaAction(action));
        currentPhase = `executing ${actionTitle}`;
        // Record the action as completed only AFTER execute() resolves: a failed
        // action must not appear as a plainly-completed ui_action (#248). On
        // failure the error notice below captures the failing action + phase.
        const executeAction = async (idleBound?: number): Promise<void> => {
          const actionController = new AbortController();
          const onAbort = (): void => actionController.abort();
          if (signal?.aborted) actionController.abort();
          else signal?.addEventListener("abort", onAbort, { once: true });
          try {
            const pending = executor.execute(action, actionController.signal);
            if (idleBound === undefined) await raceSettle(pending, remaining(), signal);
            else await raceBounded(`idle action ${actionTitle}`, pending, remaining(), idleBound, signal);
          } finally {
            signal?.removeEventListener("abort", onAbort);
            // A deadline also closes async executor preparation, so a late pointer read
            // cannot actuate after the loop stopped waiting for this action.
            actionController.abort();
          }
        };
        try {
          if (isIdleAction(action)) {
            // Observation actions only look (#480). A `wait` that hangs inside the SDK has, by
            // definition, waited; skipping it with a notice loses nothing the participant chose.
            const idleBound = observationTimeoutMs + (action.kind === "wait" ? (action.ms ?? 0) : 0);
            try {
              await executeAction(idleBound);
            } catch (error) {
              if (!(error instanceof CuaStallError)) throw error;
              record({
                id: nextId("notice"),
                kind: "notice",
                lifecycle: "completed",
                status: "warn",
                title: "observation action stalled; skipped",
                text: `${error.what} produced nothing within ${error.afterMs}ms; the desktop was not asked again and the next screenshot decides`
              });
            }
          } else {
            await executeAction();
          }
        } catch (error) {
          // RECOVERY at the loop boundary (covers ALL action kinds uniformly):
          // only a genuine substrate-command failure is recoverable. The real
          // @e2b/desktop Sandbox THROWS a CommandExitError on ANY non-zero exit
          // (e.g. a Ctrl+Minus keypress exiting 2), so one flaky desktop command
          // must not end the whole run. Everything else — a raceSettle deadline
          // (CuaDeadlineError) or abort (CuaAbortError), a sandbox-gone failure,
          // any non-CommandExitError — is RE-THROWN so the existing fatal handling
          // (actor_error / timed_out / harness_error) stays byte-identical.
          if (!isCommandExitError(error)) throw error;
          if (!isIdleAction(action)) {
            // The material count was applied above assuming the action would
            // actuate; it did not, so roll it back — a failed action is not
            // progress. The next observe() hands the model a fresh screenshot to
            // adapt, and because a skipped action changes nothing on screen a
            // persistently-failing run makes no progress and still terminates
            // honestly via the idle/no-progress backstop (gave_up), never a
            // silent actor_error and never an infinite loop.
            materialActions -= 1;
            counts.materialActions = materialActions;
            // Roll back the title too, so a later gave_up backstop notice never
            // cites a never-actuated action as the "last material action" while
            // counts.materialActions is 0 (honest-evidence invariant).
            lastMaterialActionTitle = priorMaterialActionTitle;
          }
          const { exitCode, stderrTail } = commandFailureInfo(error);
          record({
            id: nextId("notice"),
            kind: "notice",
            lifecycle: "completed",
            status: "error",
            title: "action skipped: desktop command failed",
            // Public-safe: describeCuaAction never includes raw typed text, the
            // exit code is a number, and the tail is only the substrate's own
            // stderr (tailed+whitespace-collapsed); the whole line is still run
            // through redactNarration (scrubKnownValues + pattern redaction).
            text: redactNarration(
              [
                `action: ${actionTitle}`,
                exitCode === undefined ? undefined : `exit code: ${exitCode}`,
                stderrTail.length > 0 ? `stderr: ${stderrTail}` : undefined
              ].filter(Boolean).join("; ")
            )
          });
          continue;
        }
        record({
          id: nextId("ui_action"),
          kind: "ui_action",
          lifecycle: "completed",
          title: actionTitle,
          // Structured pin coordinates (#441), exactly the click classes the Observer
          // pins render — recorded fact instead of a title re-parse downstream.
          ...(action.kind === "click" || action.kind === "double_click"
            ? { coord: { x: action.x, y: action.y } }
            : {})
        });
      }

      if (signal?.aborted) throw new CuaAbortError();
      currentPhase = `observing UI state after turn ${turnNumber}`;
      observation = await observeBounded(`after turn ${turnNumber}`);
      // Runtime-only: hand the seat's live location.href back to the orchestrator (never persisted).
      onObservedUrl?.(observation.url);
      if (observation.screenshot !== undefined) onScreenshot?.(observation.screenshot);
      if (observation.appState !== undefined) observedAppState = true;
      // Per-turn fail-closed vision guard: a vision provider can never reason over a missing frame.
      if (frameGuardTripped(observation)) break;
      await maybeRecordScreenshot(observation, `turn-${turnNumber.toString().padStart(2, "0")}`);
      onTrace?.(items.slice(), runningUsage());
      observeTasks(observation, turnNumber);
      const dwellOutcome = await dwellIfDue(observation, turnNumber);
      if (dwellOutcome !== undefined) {
        observation = await observeBounded("after dwell");
        onObservedUrl?.(observation.url);
        if (observation.screenshot !== undefined) onScreenshot?.(observation.screenshot);
        await maybeRecordScreenshot(observation, `turn-${turnNumber.toString().padStart(2, "0")}-after-dwell`);
        observeTasks(observation, turnNumber);
        if (dwellOutcome === "stop") {
          completionReason = "goal_satisfied";
          reason = `dwell window complete (${dwellHeldMs}ms held after turn ${turnNumber})`;
          closingObservation = observation;
          closingTrigger = "dwell";
          break;
        }
      }
      stopConditionMatch = matchedStopWhen(observation);
      if (stopConditionMatch) {
        completionReason = "goal_satisfied";
        reason = stopWhenReason(stopConditionMatch);
        closingObservation = observation;
        closingTrigger = "stop_when";
        record(stopWhenTraceItem(nextId("notice"), stopConditionMatch, redactNarration));
        break;
      }

      // Progress prefers the stable appState projection; a state executor with a constant
      // stateSignature still registers progress when its appState changed (and vice versa).
      const progressKey = progressKeyOf(observation);
      const frameChanged = progressKey !== lastSignature;
      lastSignature = progressKey;

      // CORROBORATION (#383). A stale frame alone is NOT evidence of a stuck agent. The frame hash is
      // a coarse whole-screen measure, and on a light-themed web app it can miss a renamed row, a new
      // list item, or an opened panel — a measured run had 9 visibly different consecutive frames hash
      // identically while the agent was a foreign key away from finishing. Ending a lane on that
      // signal alone recorded working sessions as `gave_up`, capping every browser run at roughly
      // noProgressSteps turns and writing harness artifacts into evidence as actor behavior.
      //
      // So a no-progress turn now requires BOTH a stale frame AND the agent repeating something it
      // just tried. An agent doing varied work is never counted stuck, however blind the hash is;
      // an agent re-clicking the same dead control trips it as fast as it did before — arguably
      // faster, since that is the actual signature of being stuck.
      const fingerprint = actionFingerprint(turn.actions);
      const repeatingRecentAction = fingerprint.length > 0 && recentFingerprints.includes(fingerprint);
      recentFingerprints.push(fingerprint);
      if (recentFingerprints.length > ACTION_REPEAT_WINDOW) recentFingerprints.shift();
      // Corroboration governs the FRAME-STALENESS backstop only. The idle backstop below is a direct
      // behavioral signal already (the agent took nothing but screenshots and waits), so it keeps
      // reading the frame on its own — a repeated screenshot is exactly what an idle streak IS, and
      // feeding repetition into it would grant an extra forgiveness step for being idle.
      const progressed = frameChanged || !repeatingRecentAction;

      // A screenshot/wait turn while the UI visibly changes may be patience through loading or a
      // transition, so grant a bounded recovery window. Do not grant infinite immunity: animated
      // pixels or state-executor turn counters can otherwise keep a screenshot/wait loop alive
      // until the wall-clock timeout.
      if (idleThisTurn) {
        if (frameChanged && idleProgressForgivenessUsed < IDLE_PROGRESS_FORGIVENESS_STEPS) {
          idleProgressForgivenessUsed += 1;
          consecutiveIdle = 0;
        } else {
          consecutiveIdle += 1;
        }
      } else {
        idleProgressForgivenessUsed = 0;
        consecutiveIdle = 0;
      }
      if (idleThisTurn) bump("idleTurns");
      consecutiveNoProgress = progressed ? 0 : consecutiveNoProgress + 1;
      if (!progressed) bump("noProgressTurns");

      // An unchanged screen can be legitimate waiting (for example, a shared-world lobby).
      // Recovery may suggest another approach, but must not instruct early abandonment while
      // the task still calls for waiting. The counters, time and spend guards own hard stops.
      const contextHints: string[] = [];
      if (consecutiveNoProgress >= noProgressRecoverySteps && consecutiveNoProgress < noProgressSteps) {
        contextHints.push(
          `No visible progress for ${consecutiveNoProgress} step(s). ` +
          "If your task calls for waiting for another participant or a pending transition, you may continue waiting. " +
          "Otherwise, try a different visible control or scroll within a panel; describe any blocker you actually encounter."
        );
      }
      if (consecutiveIdle >= idleRecoverySteps && consecutiveIdle < idleSteps) {
        contextHints.push(
          `You are only waiting or taking screenshots for ${consecutiveIdle} step(s). ` +
          "If your task calls for waiting, you may continue within the remaining session time. " +
          "When the relevant controls become actionable, continue your task; describe any blocker you actually encounter."
        );
      }
      if (contextHints.length > 0) contextHint = contextHints.join(" ");

      if (consecutiveIdle >= idleSteps) {
        completionReason = "gave_up";
        reason = `gave up: ${consecutiveIdle} consecutive turns with no material UI action (only screenshot/wait)`;
        record(backstopTraceItem({
          id: nextId("notice"),
          reason,
          lastMaterialActionTitle,
          recentActionTitles,
          screenshotRef: lastScreenshotRef,
          redactNarration
        }));
        break;
      }
      if (consecutiveNoProgress >= noProgressSteps) {
        completionReason = "gave_up";
        reason = `gave up: ${consecutiveNoProgress} consecutive turns with no change to the UI state`;
        record(backstopTraceItem({
          id: nextId("notice"),
          reason,
          lastMaterialActionTitle,
          recentActionTitles,
          screenshotRef: lastScreenshotRef,
          redactNarration
        }));
        break;
      }
    }
  } catch (error) {
    if (error instanceof CuaFrameGuardStop || error instanceof CuaStopWhenStop) {
      // completionReason/reason were already set by the frame guard or stopWhen guard.
    } else if (error instanceof CuaDeadlineError) {
      if (materialActions > 0) {
        completionReason = "budget_reached";
        reason = `reached the ${timeoutMs}ms time budget after productive activity (${materialActions} material action(s), ${counts.turns} turn(s))`;
      } else {
        completionReason = "timed_out";
        reason = `wall-clock deadline reached after ${timeoutMs}ms with no material progress`;
      }
    } else if (error instanceof CuaAbortError) {
      completionReason = "harness_error";
      reason = "run aborted by the harness";
    } else {
      completionReason = "actor_error";
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = redactNarration(rawMessage);
      reason = redactNarration(`computer-use loop error: ${rawMessage}`);
      record({
        id: nextId("notice"),
        kind: "notice",
        lifecycle: "completed",
        status: "error",
        title: "computer-use loop error",
        text: [
          `phase: ${redactNarration(currentPhase)}`,
          error instanceof Error && error.name ? `error: ${redactNarration(error.name)}` : undefined,
          `message: ${message}`,
          lastActionTitle === undefined ? undefined : `last action: ${redactNarration(lastActionTitle)}`
        ].filter(Boolean).join("; "),
        ...(lastScreenshotRef === undefined ? {} : { screenshotRef: lastScreenshotRef })
      });
    }
  }

  // Structured completion must stop interaction immediately, but the participant may not yet
  // have spoken. Request one read-only account using the already captured final observation.
  // No callbacks that coordinate live participants and no executor calls occur after this point.
  if (closingTrigger !== undefined && closingObservation !== undefined) {
    const note = (status: "completed" | "skipped" | "failed", detail: string, usageReported?: boolean): void => {
      debrief = { trigger: closingTrigger!, status, reason: redactNarration(detail),
        ...(usageReported === undefined ? {} : { usageReported }) };
      record({ id: nextId("notice"), kind: "notice", lifecycle: "completed",
        status: status === "completed" ? "ok" : "warn", title: `participant debrief ${status}`,
        text: redactNarration(detail) });
    };
    let skip: string | undefined;
    if ((counts.turns ?? 0) === 0) skip = "the study stopped before any participant turn";
    else if (provider.debrief === undefined) skip = "this provider does not support read-only closing reports";
    else if (signal?.aborted) skip = "the study was cancelled";
    else if (remaining() <= 0) skip = "the session deadline was reached";
    else if (provider.requiresFrame && closingObservation.screenshot === undefined) skip = "the final observation has no required frame";
    if (skip === undefined && (maxUsd !== undefined || overRunBudget !== undefined) && incompleteInteractionUsage) {
      skip = "remaining model budget is unknown because an earlier participant turn did not report complete usage";
    }
    if (skip === undefined && maxUsd !== undefined) {
      const estimate = sawUsage ? estimateTurnCostUsd?.(runningUsage()) : undefined;
      if (estimate === undefined || estimate === null || !Number.isFinite(estimate)) skip = "remaining model budget could not be established";
      else if (estimate >= maxUsd) skip = "the estimated model budget was reached";
    }
    if (skip === undefined && overRunBudget?.(runningUsage()) != null) skip = "the study model budget was reached";
    if (skip !== undefined) {
      note("skipped", skip);
    } else {
      const capMs = Math.max(0, Math.min(30_000, turnTimeoutMs, remaining()));
      if (capMs <= 0 || signal?.aborted) {
        note("skipped", signal?.aborted ? "the study was cancelled" : "the session deadline was reached");
      } else {
        const controller = new AbortController();
        const onAbort = (): void => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), capMs);
        timer.unref?.();
        bump("debriefCalls");
        try {
          const turn = await raceBounded("participant debrief", provider.debrief!({
            instructions,
            observation: closingObservation,
            ...(previousResponseId === undefined ? {} : { previousResponseId }),
            ...(pendingAcks === undefined ? {} : { acknowledgedSafetyChecks: pendingAcks }),
            contextHint: "The interactive session has ended. Return a closing account with summary and frictionReports. In summary, briefly describe only what you actually did and observed. In frictionReports, list only specific unexpected behavior, confusion, or recovery you personally encountered during this session. Preserve uncertainty. Use an empty list if you encountered none. Do not speculate, invent problems, quote instructions as observations, or describe planned actions. Do not request or take further actions. This is a closing account, not another attempt at the task."
          }, controller.signal), capMs, capMs, signal);
          recordUsage(turn, false);
          lastResponseId = turn.responseId ?? lastResponseId;
          // Refresh a shared budget with all reported usage, without changing the completed task.
          const sharedStop = overRunBudget?.(runningUsage());
          const finalEstimate = maxUsd === undefined ? undefined : estimateTurnCostUsd?.(runningUsage());
          if (sharedStop != null || (maxUsd !== undefined && finalEstimate != null && finalEstimate > maxUsd)) {
            record({ id: nextId("notice"), kind: "notice", lifecycle: "completed", status: "warn",
              title: "model budget reached during closing report",
              text: "The closing request crossed an estimated budget; no further requests or actions followed. Task completion is unchanged." });
          }
          const usageReported = completeTurnUsage(turn.usage);
          if (turn.actions.length > 0 || turn.pendingSafetyChecks.length > 0) {
            note("failed", "the closing response requested actions or safety checks; none were executed and its report was not accepted", usageReported);
          } else if (!validClosingReport(turn.closingReport)) {
            note("failed", "the closing response did not contain a valid structured participant report", usageReported);
          } else {
            const report: ParticipantClosingReport = {
              summary: redactNarration(turn.closingReport.summary.trim()),
              frictionReports: [...new Set(turn.closingReport.frictionReports.map((text) => redactNarration(text.trim())))]
            };
            const messageId = nextId("message");
            record({ id: messageId, kind: "message", lifecycle: "completed",
              title: "participant closing report", text: [report.summary, ...report.frictionReports].join("\n\n") });
            bump("messages");
            note("completed", "one read-only report; no additional desktop actions; original stop and task outcomes preserved", usageReported);
            debrief = { ...debrief!, report, messageId };
          }
        } catch (error) {
          // A failed optional report cannot rewrite the already observed structured completion.
          const detail = signal?.aborted ? "cancelled" : controller.signal.aborted || error instanceof CuaDeadlineError || error instanceof CuaStallError
            ? "closing report deadline reached" : error instanceof Error ? error.message : String(error);
          note("failed", `${detail}; closing request usage is unreported`, false);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          controller.abort();
        }
      }
    }
    onTrace?.(items.slice(), runningUsage());
  }

  const completedAtMs = now();
  const status = statusForCompletionReason(completionReason);
  const ids: ActorTrace["ids"] = {};
  if (provider.version !== undefined) ids.model = provider.version;
  // responseId is provider-authored and opaque; redact for defense-in-depth.
  if (lastResponseId !== undefined) ids.turnId = redaction.redactText(lastResponseId);

  const screenshotNote = !(counts.screenshots && counts.screenshots > 0)
    ? "no screenshots captured"
    : redactScreenshots
      ? `${counts.screenshots} screenshot(s) redacted to blurred thumbnails via RedactionHooks`
      : `${counts.screenshots} full-fidelity screenshot(s) retained for local use — NOT redacted for publishing; set redactScreenshots to blur a share-as-is bundle`;
  // Self-describing artifact (invariant 6): when a non-vision executor surfaced structured app
  // state, the trace declares HOW it handled that surface — app state drove progress detection
  // each turn and was NOT written to the trace (it is a runtime-only progress input, like
  // stateSignature). The appState itself never appears anywhere in this bundle.
  const notes = observedAppState
    ? `${screenshotNote}. App state was observed each turn to drive progress detection (a state-driven executor) and was NOT written to the trace — it is a runtime-only progress input, never persisted as evidence in this slice.`
    : screenshotNote;

  const trace: ActorTrace = {
    schema: ACTOR_TRACE_SCHEMA,
    provider: provider.id,
    ...(provider.version === undefined ? {} : { providerVersion: provider.version }),
    protocol: "cua-loop",
    lane: "computer-use",
    persona,
    redaction: {
      status: "passed",
      screenshots: !(counts.screenshots && counts.screenshots > 0)
        ? "n/a"
        : redactScreenshots
          ? "blurred"
          : "raw",
      notes
    },
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs - startedAtMs,
    status,
    completionReason,
    reason,
    ids,
    ...(provider.modelSettings === undefined
      ? {}
      : { modelSettings: { reasoningEffort: provider.modelSettings.reasoningEffort,
          ...(provider.modelSettings.maxOutputTokens === undefined ? {} : { maxOutputTokens: provider.modelSettings.maxOutputTokens }) } }),
    counts,
    items,
    ...(affordanceObservations.length > 0 ? { affordanceUse: summarizeAffordanceUse(affordanceObservations) } : {}),
    ...(declaredOutcome === undefined ? {} : { declaredOutcome }),
    ...(debrief === undefined ? {} : { debrief }),
    // The funnel is present exactly when a protocol was declared — including a session that ended
    // on turn 0, whose funnel honestly reads 0/N. No tasks declared means no funnel, not an empty one.
    ...(taskTracker === undefined ? {} : { taskFunnel: taskTracker.funnel() }),
    ...(sawUsage
      ? {
          tokenUsage: {
            input: usageInput,
            output: usageOutput,
            // Recorded only when the provider actually reported it, so a reader can tell "no cache
            // hits" from "this provider does not say" (#391); same for cache writes (#334).
            ...(usageCachedInput > 0 ? { cachedInput: usageCachedInput } : {}),
            ...(usageCacheWriteInput > 0 ? { cacheWriteInput: usageCacheWriteInput } : {}),
            ...(usageTurns.length > 0 ? { turns: usageTurns.map((turn) => ({ ...turn })) } : {}),
            total: usageInput + usageOutput
          }
        }
      : {}),
    capabilities: provider.capabilities
  };

  return { status, completionReason, reason, trace };
}

function stopWhenReason(match: StopConditionMatch): string {
  return `stopWhen matched ${match.id} (${match.kinds.join("+")})`;
}

function stopWhenTraceItem(
  id: string,
  match: StopConditionMatch,
  redactNarration: (text: string) => string
): ActorTraceItem {
  return {
    id,
    kind: "notice",
    lifecycle: "completed",
    status: "matched",
    title: `stopWhen matched: ${match.id}`,
    text: redactNarration(
      `Harness stop condition matched rule ${match.id} using ${match.kinds.join(", ")}. Raw observed URL/text/appState were runtime-only and were not persisted; when a screenshot was available, the immediately preceding screenshot item is the visual evidence for the matched surface.`
    )
  };
}

function backstopTraceItem(args: {
  id: string;
  reason: string;
  lastMaterialActionTitle: string | undefined;
  recentActionTitles: string[];
  screenshotRef: ActorTraceItem["screenshotRef"] | undefined;
  redactNarration: (text: string) => string;
}): ActorTraceItem {
  const details = [
    `reason: ${args.reason}`,
    args.lastMaterialActionTitle === undefined
      ? "last material action: none"
      : `last material action: ${args.lastMaterialActionTitle}`,
    args.recentActionTitles.length === 0
      ? "recent actions: none"
      : `recent actions: ${args.recentActionTitles.join(" -> ")}`
  ];

  return {
    id: args.id,
    kind: "notice",
    lifecycle: "completed",
    status: "blocked",
    title: "computer-use backstop gave up",
    text: args.redactNarration(details.join("; ")),
    ...(args.screenshotRef === undefined ? {} : { screenshotRef: args.screenshotRef })
  };
}
