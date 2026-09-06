import { validClosingReport } from "./computer-use.js";
import type { ActorCapabilities } from "./actor-contract.js";
import type { CuaAction, CuaProvider, CuaSafetyCheck, CuaTurn, CuaTurnRequest } from "./computer-use.js";
import { redactText } from "./redaction.js";
import type { ReasoningEffort } from "./reasoning-effort.js";
import { isMaxOutputTokens } from "./output-token-limit.js";
import {
  prepareContainedOutputFile,
  prepareSelectedOutputDirectory,
  type PreparedSelectedOutputDirectory,
  writeContainedOutputFile
} from "./selected-output-paths.js";

// A public-safe re-derivation of the OpenAI Responses API computer-use provider,
// behind the CuaProvider port from src/computer-use.ts. It mirrors the
// pure-mapper-plus-injectable-shim pattern proven in src/claude-agent-sdk.ts:
//
//  - PURE mappers (openAiActionToCua, parseOpenAiResponse) and request builders
//    (buildInitialRequest, buildCallOutput, buildContinuationRequest) project the
//    Responses wire shape to/from the provider-neutral CuaAction / CuaTurn types
//    with no network, so they are fully unit-testable in CI (no key, no spend, no
//    SDK); and
//  - the live shim (createOpenAiResponsesProvider) does a RAW POST to the
//    Responses endpoint (no SDK dependency) through an injectable FetchLike seam,
//    so the retry, ZDR fallback, and state threading are testable with a fake.
//
// Public-safety invariants (this is an OSS repo): the apiKey only ever appears in
// the Authorization header, never in a returned object, thrown error, or comment.
// Request bodies (which carry base64 screenshots and the persona instructions)
// and screenshots are never logged or returned; nextTurn returns ONLY a CuaTurn,
// and the engine handles redaction of CuaTurn fields downstream. Error messages
// carry the HTTP status only, never the response body (it can echo the input).
//
// Wire capture (fixture provenance). The 0.6.1 parser incident — the parser read
// `computer_call.action` (singular) while the live API returns `actions` (array),
// and the hand-written fixtures encoded the SAME wrong shape, so tests passed in
// lockstep with the bug while every live action was silently dropped — taught us
// that deterministic fixtures must derive from CAPTURED live wire shapes, never
// from memory. Setting HUMANISH_CUA_WIRE_CAPTURE_DIR makes the live shim persist
// each successful Responses RESPONSE body into that directory as pretty-printed
// JSON, one file per provider call in call order (wire-001.json, wire-002.json,
// ...), for refreshing fixtures. The capture seam is:
//  - OPT-IN: unset (or empty) env means zero behavior change — nothing is written;
//  - RESPONSE-side only: request bodies carry base64 screenshots and the persona
//    instructions and are NEVER captured; non-ok response bodies can echo the
//    request and are never captured either;
//  - REDACTED: every string field (keys and values) passes through the shared
//    redactText (src/redaction.ts) before writing, so a secret-shaped echo in a
//    response cannot persist to disk.
// Point the env var at a gitignored path (e.g. under .humanish/): raw captures must
// never be committed — fixtures derived from them must be minimal, hand-reviewed
// excerpts checked into tests deliberately.

export const OPENAI_RESPONSES_CU_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: false,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "proprietary"
};

// The flagship 5.6-generation tier ("gpt-5.6" is OpenAI's alias for this exact id; the
// computer-use guide's own examples run on it). Explicit tier id so trace provenance and the
// rate-table key stay stable if OpenAI repoints the alias (#334).
export const DEFAULT_OPENAI_CU_MODEL = "gpt-5.6-sol";

/**
 * The effort a request carries when a lab declares none. Exported because a default that only
 * exists as a literal inside the provider is exactly how it stayed invisible: the lab surface has
 * to be able to say what will actually run (#497).
 */
export const DEFAULT_OPENAI_CU_REASONING_EFFORT: ReasoningEffort = "medium";

// ---------------------------------------------------------------------------
// Defensive readers. The Responses wire shape is loosely typed (unknown), so we
// read every field defensively: a non-object is treated as empty, a non-number
// coordinate becomes 0, and a non-string text becomes "".
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPoint(value: unknown): { x: number; y: number } {
  const point = asRecord(value);
  return { x: asNumber(point.x), y: asNumber(point.y) };
}

/**
 * Map an OpenAI computer action object to a provider-neutral CuaAction, or null
 * for an unknown type. Every coordinate and field is read defensively so a
 * malformed action never throws and a non-number coordinate becomes 0.
 */
export function openAiActionToCua(action: unknown): CuaAction | null {
  const record = asRecord(action);
  const type = asString(record.type);
  switch (type) {
    case "click": {
      const button = record.button;
      return {
        kind: "click",
        x: asNumber(record.x),
        y: asNumber(record.y),
        button: button === "right" || button === "middle" ? button : "left"
      };
    }
    case "double_click":
      return { kind: "double_click", x: asNumber(record.x), y: asNumber(record.y) };
    case "move":
      return { kind: "move", x: asNumber(record.x), y: asNumber(record.y) };
    case "scroll":
      return {
        kind: "scroll",
        x: asNumber(record.x),
        y: asNumber(record.y),
        dx: asNumber(record.scroll_x),
        dy: asNumber(record.scroll_y)
      };
    case "type":
      return { kind: "type", text: asString(record.text) };
    case "keypress":
      return { kind: "keypress", keys: asArray(record.keys).filter((key): key is string => typeof key === "string") };
    case "drag":
      return { kind: "drag", path: asArray(record.path).map(asPoint) };
    case "wait":
      return { kind: "wait" };
    case "screenshot":
      return { kind: "screenshot" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Response parsing.
// ---------------------------------------------------------------------------

export interface ParsedOpenAiResponse {
  turn: CuaTurn;
  callIds: string[];
  outputItems: unknown[];
}

// Collect plain strings or { text } entries from a reasoning summary/content array.
function collectTextEntries(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry === "string") {
      if (entry.length > 0) out.push(entry);
      continue;
    }
    const text = asString(asRecord(entry).text);
    if (text.length > 0) out.push(text);
  }
  return out;
}

// Collect output_text strings from a message content array.
function collectMessageText(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (asString(record.type) === "output_text") {
      const text = asString(record.text);
      if (text.length > 0) out.push(text);
    }
  }
  return out;
}

/**
 * Parse a Responses API response into a provider-neutral CuaTurn plus the
 * computer_call ids (needed to build the next turn's call outputs) and the raw
 * output items (needed for ZDR explicit-context continuation). Pure: no network,
 * no mutation of the input. Optional CuaTurn fields are only set when present so
 * the result satisfies exactOptionalPropertyTypes.
 */
export function parseOpenAiResponse(raw: unknown): ParsedOpenAiResponse {
  const root = asRecord(raw);
  const responseId = optionalString(root.id);
  const output = asArray(root.output);

  const actions: CuaAction[] = [];
  const callIds: string[] = [];
  const reasoningParts: string[] = [];
  const messageParts: string[] = [];
  const safetyChecks: CuaSafetyCheck[] = [];

  for (const rawItem of output) {
    const item = asRecord(rawItem);
    switch (asString(item.type)) {
      case "reasoning":
        reasoningParts.push(...collectTextEntries(item.summary), ...collectTextEntries(item.content));
        break;
      case "message":
        messageParts.push(...collectMessageText(item.content));
        break;
      case "output_text": {
        const text = asString(item.text);
        if (text.length > 0) messageParts.push(text);
        break;
      }
      case "computer_call": {
        const callId = optionalString(item.call_id);
        if (callId !== undefined) callIds.push(callId);
        // The live Responses API returns the actions as an ARRAY (`item.actions`); a single
        // computer_call can carry several. (An older/alt shape used a singular `item.action` —
        // supported as a fallback.) Reading only `item.action` silently dropped EVERY action,
        // which made the loop see zero actions and stop on a false `goal_satisfied`.
        const rawActions = Array.isArray(item.actions)
          ? item.actions
          : item.action !== undefined
            ? [item.action]
            : [];
        for (const rawAction of rawActions) {
          const mapped = openAiActionToCua(rawAction);
          if (mapped !== null) actions.push(mapped);
        }
        // Preserve the wire triple verbatim: the API matches acknowledgements on
        // `id`, so collapsing to a code string (and fabricating ids on echo)
        // would silently break the proceed path.
        for (const rawCheck of asArray(item.pending_safety_checks)) {
          const check = asRecord(rawCheck);
          const id = asString(check.id);
          const code = asString(check.code);
          safetyChecks.push({
            id: id || code || "safety_check",
            code: code || id || "safety_check",
            message: asString(check.message) || code || id || "safety_check"
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const topText = asString(root.output_text);
  if (topText.length > 0) messageParts.push(topText);

  const reasoning = reasoningParts.filter((part) => part.length > 0).join("\n");
  const message = messageParts.filter((part) => part.length > 0).join("\n");

  const usageRecord = asRecord(root.usage);
  const usageInput = optionalNumber(usageRecord.input_tokens);
  const usageOutput = optionalNumber(usageRecord.output_tokens);
  // Of the input tokens, how many the provider served from its prompt cache. This loop threads
  // state with previous_response_id and re-sends a growing warm prefix every turn, so most input on
  // a long session is a cache hit billed at a fraction of the full rate. Not reading it made every
  // cost line materially overstate the bill (#391).
  const usageCachedInput = optionalNumber(asRecord(usageRecord.input_tokens_details).cached_tokens);
  // GPT-5.6+ bills cache WRITES (1.25x input) and reports them here; older models omit the field.
  const usageCacheWriteInput = optionalNumber(asRecord(usageRecord.input_tokens_details).cache_write_tokens);
  const usage =
    usageInput === undefined && usageOutput === undefined
      ? undefined
      : {
          ...(usageInput === undefined ? {} : { input: usageInput }),
          ...(usageOutput === undefined ? {} : { output: usageOutput }),
          ...(usageCachedInput === undefined ? {} : { cachedInput: usageCachedInput }),
          ...(usageCacheWriteInput === undefined ? {} : { cacheWriteInput: usageCacheWriteInput })
        };

  // Responses can exhaust output/context tokens before producing any visible answer. Empty
  // actions on that wire status are an interrupted generation, never a natural endpoint.
  const interruption = root.status === "incomplete"
    ? (asRecord(root.incomplete_details).reason === "max_output_tokens" ? "token_limit" : "incomplete")
    : root.status !== undefined && root.status !== "completed" ? "unexpected_status" : undefined;

  const turn: CuaTurn = {
    actions,
    pendingSafetyChecks: safetyChecks,
    done: interruption === undefined && actions.length === 0,
    ...(interruption === undefined ? {} : { interruption }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(message.length > 0 ? { message } : {}),
    ...(usage === undefined ? {} : { usage })
  };

  return { turn, callIds, outputItems: output };
}

// ---------------------------------------------------------------------------
// Request builders. Each returns a plain object that is JSON-serialized as the
// POST body. They never carry the apiKey (that lives only in the header).
// ---------------------------------------------------------------------------

export type OpenAiReasoningSummary = "auto" | "concise" | "detailed";

export interface OpenAiCuContext {
  model: string;
  instructions: string;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
  /** When set, request provider-sanctioned reasoning summaries (#427). Absent = do not ask. */
  reasoningSummary?: OpenAiReasoningSummary;
  safetyIdentifier?: string;
}

// The fields shared by the initial and continuation requests: the tool spec,
// truncation policy, reasoning effort, and (when configured) the safety id.
function sharedRequestFields(ctx: OpenAiCuContext): Record<string, unknown> {
  return {
    model: ctx.model,
    ...(ctx.maxOutputTokens === undefined ? {} : { max_output_tokens: ctx.maxOutputTokens }),
    // Keep the task/persona contract present on every turn. Some computer-use
    // continuations carry only screenshot call outputs; without repeating the
    // instructions, a provider that does not fully retain prior state can drift
    // into asking the operator what to do.
    instructions: ctx.instructions,
    // The Responses API `computer` tool takes no display/environment fields — the model infers
    // resolution from the screenshots it is sent. (Sending display_* returns a 400
    // "Unknown parameter tools[0].display_width", confirmed against the live API 2026-06.)
    tools: [{ type: "computer" }],
    truncation: "auto",
    // `summary` asks for the provider-SANCTIONED reasoning summary items (#427) — the
    // capture side never scrapes or reconstructs raw chain-of-thought. Parsed by
    // parseOpenAiResponse into turn.reasoning; the loop records them as redacted
    // `kind: "reasoning"` trace items.
    reasoning: {
      effort: ctx.reasoningEffort,
      ...(ctx.reasoningSummary === undefined ? {} : { summary: ctx.reasoningSummary })
    },
    ...(ctx.safetyIdentifier === undefined ? {} : { safety_identifier: ctx.safetyIdentifier })
  };
}

/** Build the first-turn request body: instructions + an initial user text input. */
export function buildInitialRequest(ctx: OpenAiCuContext): Record<string, unknown> {
  return {
    ...sharedRequestFields(ctx),
    input: [{ role: "user", content: [{ type: "input_text", text: ctx.instructions }] }]
  };
}

/**
 * Build one computer_call_output for a pending call id, carrying the latest
 * screenshot as an inline data URL. Acknowledged safety checks (if any) are
 * echoed back so the model can proceed past a check the harness approved.
 *
 * The screenshot param is `Buffer | undefined` because CuaObservation.screenshot is now
 * optional (a non-vision executor omits it). This provider is a VISION model (it sets
 * requiresFrame), so a missing frame is a hard error here — defense-in-depth: the loop's
 * per-turn requiresFrame guard already fails closed before this is reached, but throwing keeps
 * the mapper self-validating and isolable.
 */
export function buildCallOutput(callId: string, screenshot: Buffer | undefined, acknowledged?: CuaSafetyCheck[]): Record<string, unknown> {
  if (screenshot === undefined) {
    throw new Error("openai-responses-cu requires observation.screenshot (it is a vision provider; pair a state-only executor with a non-vision provider)");
  }
  return {
    type: "computer_call_output",
    call_id: callId,
    output: {
      type: "computer_screenshot",
      image_url: `data:image/png;base64,${screenshot.toString("base64")}`
    },
    ...(acknowledged && acknowledged.length > 0
      ? { acknowledged_safety_checks: acknowledged.map(({ id, code, message }) => ({ id, code, message })) }
      : {})
  };
}

export interface ContinuationRequestArgs {
  ctx: OpenAiCuContext;
  previousResponseId: string | undefined;
  callOutputs: object[];
  contextHint?: string;
  explicitContextItems?: unknown[];
}

// Turn an optional context-hint string into an input item array (or empty).
function hintItems(contextHint: string | undefined): unknown[] {
  return contextHint ? [{ role: "user", content: [{ type: "input_text", text: contextHint }] }] : [];
}

/**
 * Build a continuation request body. Two modes:
 *  - default: thread server-side state via previous_response_id and send only the
 *    new call outputs (plus an optional hint).
 *  - explicit-context (ZDR): no previous_response_id; the prior output items are
 *    re-sent inline ahead of the new call outputs so the model has full context
 *    without the server retaining any.
 */
export function buildContinuationRequest(args: ContinuationRequestArgs): Record<string, unknown> {
  const { ctx, previousResponseId, callOutputs, contextHint, explicitContextItems } = args;
  if (explicitContextItems === undefined) {
    return {
      ...sharedRequestFields(ctx),
      previous_response_id: previousResponseId,
      input: [...callOutputs, ...hintItems(contextHint)]
    };
  }
  return {
    ...sharedRequestFields(ctx),
    input: [...explicitContextItems, ...callOutputs, ...hintItems(contextHint)]
  };
}

// ---------------------------------------------------------------------------
// Wire capture (see the module header). Pure helpers, exported for unit tests.
// ---------------------------------------------------------------------------

/** The opt-in gate for response wire capture: a directory path, or unset for off. */
export const WIRE_CAPTURE_ENV = "HUMANISH_CUA_WIRE_CAPTURE_DIR";

/**
 * Deep-copy a captured wire value with every string — object keys included —
 * passed through the shared redactText, so a secret-shaped echo in a response
 * can never persist to disk. Pure; non-string primitives pass through unchanged.
 */
export function redactWireJson(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactWireJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [redactText(key), redactWireJson(entry)])
    );
  }
  return value;
}

/** Deterministic ordered capture file name for the 1-based nth provider call. */
export function wireCaptureFileName(callNumber: number): string {
  return `wire-${String(callNumber).padStart(3, "0")}.json`;
}

// ---------------------------------------------------------------------------
// Live shim: a stateful CuaProvider over a raw POST to the Responses endpoint.
// ---------------------------------------------------------------------------

/**
 * The minimal slice of the fetch contract the shim depends on. Injecting this
 * (rather than importing a fetch type) keeps the module dependency-free and lets
 * CI tests run with a fake that never touches the network.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Optional so a scripted fake need not carry headers; the real fetch Response does. */
  headers?: { get(name: string): string | null };
}>;

/** The longest wait a provider's Retry-After hint can impose on one retry. */
export const RETRY_AFTER_CAP_MS = 60_000;

/**
 * Parse a Retry-After header (delay-seconds or an HTTP-date) into milliseconds from `now`;
 * undefined when absent or unreadable. OpenAI's 2026-09-02 change added `429 slow_down` and
 * `503 server_is_overloaded`, both of which may carry it; a fixed 200/400/800 ms backoff against
 * a 20 s hint burns every retry inside the hint and ends the lane for nothing.
 */
export function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * The provider error codes a lane's reason may name. Read from a non-ok body, which is never
 * kept or logged (it can echo the input); only a code on this list crosses over.
 */
const NAMED_PROVIDER_ERROR_CODES = [
  "misalignment_policy_violation",
  "slow_down",
  "server_is_overloaded",
  "rate_limit_exceeded",
  "insufficient_quota",
  "model_not_found",
  "context_length_exceeded"
] as const;

export function namedProviderErrorCode(bodyText: string): string | undefined {
  const match = /"code"\s*:\s*"([a-z_]+)"/.exec(bodyText);
  const code = match?.[1];
  return code !== undefined && (NAMED_PROVIDER_ERROR_CODES as readonly string[]).includes(code) ? code : undefined;
}

export interface OpenAiResponsesProviderOptions {
  apiKey: string;
  model?: string;
  /**
   * How hard the model is asked to think per turn. Absent = the provider default below.
   * The vocabulary is the documented union across models; SUPPORT IS MODEL-DEPENDENT, so an
   * unsupported level surfaces as the provider's own first-turn error rather than a silent
   * downgrade to something the trace would then misreport. See src/reasoning-effort.ts.
   */
  reasoningEffort?: ReasoningEffort;
  /** Optional positive integer output limit per response, including reasoning. Not a spend cap. */
  maxOutputTokens?: number;
  /**
   * Reasoning-summary capture (#427). Defaults to "auto" (the provider picks the best
   * summarizer the model supports); "off" never asks. If the account/model rejects the
   * request (e.g. an org not verified for reasoning summaries), the provider latches
   * summaries off for the session and retries the same turn — the run degrades to
   * exactly the pre-#427 behavior instead of failing after spend. Absence stays honest:
   * no summary means no `reasoning` trace items and `counts.reasonings` stays 0.
   */
  reasoningSummary?: OpenAiReasoningSummary | "off";
  safetyIdentifier?: string;
  endpoint?: string;
  fetchFn?: FetchLike;
  maxRetries?: number;
  delayFn?: (ms: number) => Promise<void>;
  zeroDataRetention?: boolean;
  /**
   * Environment for the wire-capture gate (HUMANISH_CUA_WIRE_CAPTURE_DIR — see the
   * module header). Injectable so deterministic tests control the gate without
   * mutating process.env. Defaults to process.env.
   */
  env?: Record<string, string | undefined>;
}

// A typed error so nextTurn can distinguish a ZDR-policy rejection (recoverable
// by switching to explicit-context mode) from any other non-ok status. It never
// carries the apiKey or the response body.
class ZdrError extends Error {
  constructor() {
    super("OpenAI Responses rejected server-side state (zero data retention)");
    this.name = "ZdrError";
  }
}

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/responses";

// A 400 whose body mentions any of these means the account/org cannot use
// server-side response state, so we must fall back to explicit-context mode.
function isZdrRejection(bodyText: string): boolean {
  return (
    bodyText.includes("Zero Data Retention") ||
    bodyText.includes("zero data retention") ||
    bodyText.includes("previous_response_id")
  );
}

// A typed error so nextTurn can latch reasoning summaries off and retry the turn
// (an org not verified for summaries, or a model without a summarizer, 400s the
// whole request). Like ZdrError it never carries the response body.
class SummaryRejectionError extends Error {
  constructor() {
    super("OpenAI Responses rejected the reasoning.summary request");
    this.name = "SummaryRejectionError";
  }
}

// A 400 whose body names the reasoning-summary feature. Observed live shapes:
// "Unsupported parameter: 'reasoning.summary' ..." and "Your organization must
// be verified to generate reasoning summaries."
function isSummaryRejection(bodyText: string): boolean {
  return bodyText.includes("reasoning.summary") || bodyText.includes("reasoning summaries");
}

function defaultFetch(): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    return {
      ok: res.ok,
      status: res.status,
      text: () => res.text(),
      json: () => res.json() as Promise<unknown>
    };
  };
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Create a stateful CuaProvider backed by the OpenAI Responses API. The first
 * turn opens a session (buildInitialRequest); subsequent turns send the prior
 * call outputs (with the latest screenshot) and thread state via
 * previous_response_id, transparently falling back to explicit-context mode if
 * the account rejects server-side retention. Transient HTTP failures are retried
 * with exponential backoff. Returns ONLY a CuaTurn from nextTurn; nothing
 * sensitive (the key, the request body, the screenshot, the raw response body)
 * is ever returned or logged.
 */
export function createOpenAiResponsesProvider(options: OpenAiResponsesProviderOptions): CuaProvider {
  if (options.maxOutputTokens !== undefined && !isMaxOutputTokens(options.maxOutputTokens)) {
    throw new Error("maxOutputTokens must be a positive safe integer.");
  }
  const maxOutputTokens = options.maxOutputTokens;
  const model = options.model ?? DEFAULT_OPENAI_CU_MODEL;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_OPENAI_CU_REASONING_EFFORT;
  const maxRetries = options.maxRetries ?? 3;
  const fetchFn = options.fetchFn ?? defaultFetch();
  const delayFn = options.delayFn ?? defaultDelay;
  // Opt-in response wire capture (see module header): unset/empty means OFF and
  // zero behavior change. The counter is per-provider, so file order is call order.
  const captureDir = optionalString((options.env ?? process.env)[WIRE_CAPTURE_ENV]?.trim());
  let captureCount = 0;
  let preparedCaptureRoot: Promise<PreparedSelectedOutputDirectory> | undefined;

  const prepareNextCapture = async (): Promise<PreparedSelectedOutputDirectory | undefined> => {
    if (captureDir === undefined) return undefined;
    preparedCaptureRoot ??= prepareSelectedOutputDirectory(process.cwd(), captureDir);
    const captureRoot = await preparedCaptureRoot;
    await prepareContainedOutputFile(captureRoot, wireCaptureFileName(captureCount + 1));
    return captureRoot;
  };

  // Persist one successful RESPONSE body, redacted and pretty-printed. Fails loud:
  // a silent capture failure would mean missing turns in a fixture refresh — the
  // exact "fixtures drift from the wire" pathology capture exists to prevent.
  const captureResponse = async (raw: unknown): Promise<void> => {
    if (captureDir === undefined) return;
    const captureRoot = await prepareNextCapture();
    if (!captureRoot) return;
    captureCount += 1;
    await writeContainedOutputFile(
      captureRoot,
      wireCaptureFileName(captureCount),
      `${JSON.stringify(redactWireJson(raw), null, 2)}\n`,
      "utf8"
    );
  };

  let lastResponseId: string | undefined;
  let pendingCallIds: string[] = [];
  let lastOutputItems: unknown[] = [];
  let mode: "previous_response_id" | "explicit_context" = options.zeroDataRetention ? "explicit_context" : "previous_response_id";
  // Latches to undefined (stop asking) for the rest of the session when the
  // account/model rejects the summary request — see OpenAiResponsesProviderOptions.
  let reasoningSummary: OpenAiReasoningSummary | undefined =
    options.reasoningSummary === "off" ? undefined : (options.reasoningSummary ?? "auto");

  const buildContext = (instructions: string): OpenAiCuContext => ({
    model,
    instructions,
    reasoningEffort,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningSummary === undefined ? {} : { reasoningSummary }),
    ...(options.safetyIdentifier === undefined ? {} : { safetyIdentifier: options.safetyIdentifier })
  });

  // POST the JSON body and return the parsed JSON on success. Retries on
  // transient statuses (408/409/429/>=500). Maps a ZDR-policy 400 to a typed
  // ZdrError; any other non-ok status throws with the STATUS ONLY (never the
  // body, which can echo the input/screenshot).
  const post = async (body: Record<string, unknown>, signal: AbortSignal | undefined, retries = maxRetries): Promise<unknown> => {
    // Preflight the deterministic next capture leaf before any network side
    // effect. A hostile generated path must fail with zero provider calls.
    await prepareNextCapture();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json"
    };
    const payload = JSON.stringify(body);
    let lastStatus = 0;
    let sawNetworkError = false;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await fetchFn(endpoint, {
          method: "POST",
          headers,
          body: payload,
          ...(signal === undefined ? {} : { signal })
        });
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) {
          throw error;
        }
        sawNetworkError = true;
        if (attempt < retries) {
          await delayFn(2 ** attempt * 200);
          continue;
        }
        throw new Error("OpenAI Responses network error");
      }
      if (res.ok) {
        const parsed: unknown = await res.json();
        // Capture AFTER ok and BEFORE parse-to-CuaTurn: responses only, never the
        // request (screenshots/instructions) and never a non-ok body (input echo).
        await captureResponse(parsed);
        return parsed;
      }
      lastStatus = res.status;
      if (res.status === 400) {
        const bodyText = await res.text();
        if (isZdrRejection(bodyText)) {
          throw new ZdrError();
        }
        if (isSummaryRejection(bodyText)) {
          throw new SummaryRejectionError();
        }
        throw new Error("OpenAI Responses 400");
      }
      if (res.status === 403) {
        // Misalignment monitoring (2026-09-03): the provider can stop a threaded conversation
        // mid-run with 403 misalignment_policy_violation; there is no resume path, and earlier
        // actions may already have executed. Named, terminal, never retried.
        const bodyText = await res.text().catch(() => "");
        if (namedProviderErrorCode(bodyText) === "misalignment_policy_violation") {
          throw new Error("OpenAI Responses 403 misalignment_policy_violation: the provider stopped this conversation and it cannot be resumed");
        }
        throw new Error("OpenAI Responses 403");
      }
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        // The provider's own hint wins over the fixed backoff, up to the cap.
        const backoff = 2 ** attempt * 200;
        const hinted = retryAfterMs(res.headers?.get("retry-after"), Date.now());
        await delayFn(hinted === undefined ? backoff : Math.min(Math.max(backoff, hinted), RETRY_AFTER_CAP_MS));
        continue;
      }
      const code = namedProviderErrorCode(await res.text().catch(() => ""));
      throw new Error(`OpenAI Responses ${res.status}${code === undefined ? "" : ` ${code}`}`);
    }
    if (sawNetworkError) {
      throw new Error("OpenAI Responses network error");
    }
    throw new Error(`OpenAI Responses ${lastStatus}`);
  };

  const requestTurn = async (req: CuaTurnRequest, signal: AbortSignal, closing = false): Promise<CuaTurn> => {
    await prepareNextCapture();
    const isFirstTurn = lastResponseId === undefined && pendingCallIds.length === 0;

    // POST with the recoverable-policy latches: a ZDR rejection switches to
    // explicit-context mode; a reasoning-summary rejection latches summaries off.
    // Each latch can flip only once, so the loop is bounded; anything else
    // rethrows. The body is rebuilt per attempt so a flipped latch is reflected.
    const attempt = async (build: (ctx: OpenAiCuContext) => Record<string, unknown>): Promise<unknown> => {
      // A closing report makes exactly one request: no HTTP or policy-latch retries.
      if (closing) {
        return post({ ...build(buildContext(req.instructions)), tool_choice: "none", max_output_tokens: Math.min(maxOutputTokens ?? 1024, 1024),
          text: { format: { type: "json_schema", name: "participant_closing_report", strict: true,
            schema: { type: "object", additionalProperties: false, required: ["summary", "frictionReports"],
              properties: { summary: { type: "string" }, frictionReports: { type: "array", items: { type: "string" } } } }
          } }
        }, signal, 0);
      }
      for (;;) {
        try {
          return await post(build(buildContext(req.instructions)), signal);
        } catch (error) {
          if (error instanceof SummaryRejectionError && reasoningSummary !== undefined) {
            reasoningSummary = undefined;
            continue;
          }
          if (error instanceof ZdrError && mode !== "explicit_context") {
            mode = "explicit_context";
            continue;
          }
          throw error;
        }
      }
    };

    let raw: unknown;
    if (isFirstTurn) {
      raw = await attempt((ctx) => buildInitialRequest(ctx));
    } else {
      const callOutputs = pendingCallIds.map((id) =>
        buildCallOutput(id, req.observation.screenshot, req.acknowledgedSafetyChecks)
      );
      raw = await attempt((ctx) =>
        buildContinuationRequest({
          ctx,
          previousResponseId: lastResponseId,
          callOutputs,
          ...(req.contextHint === undefined ? {} : { contextHint: req.contextHint }),
          ...(mode === "explicit_context" ? { explicitContextItems: lastOutputItems } : {})
        })
      );
    }

    const parsed = parseOpenAiResponse(raw);
    if (parsed.turn.responseId !== undefined) lastResponseId = parsed.turn.responseId;
    pendingCallIds = parsed.callIds;
    lastOutputItems = parsed.outputItems;
    if (closing) {
      // Refusals, incomplete output, malformed JSON, and invalid shapes remain no-report results.
      // Never promote raw JSON or a fallback paragraph into a structured finding.
      try {
        const report: unknown = JSON.parse(parsed.turn.message ?? "");
        if (asRecord(raw).status === "completed" && validClosingReport(report)) {
          return { ...parsed.turn, closingReport: report };
        }
      } catch { /* A failed optional closing account keeps its usage and no report. */ }
    }
    return parsed.turn;
  };

  return {
    id: "openai-responses-cu",
    version: model,
    // The effort the wire actually carries, not the one the lab asked for — the provider defaults
    // an absent request to "medium", and the trace has to say what produced it (#497).
    modelSettings: { reasoningEffort, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) },
    capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
    // This is a VISION provider: nextTurn sends the screenshot as the computer_call_output, so
    // it cannot reason over a screenshot-less observation. The loop reads this to fail closed
    // (harness_error) when a state-only executor is paired with it (provider-authoring contract).
    requiresFrame: true,
    nextTurn: (req, signal) => requestTurn(req, signal),
    // Stateless mode retains only the latest output packet, not the whole session needed for
    // retrospective claims. This getter follows both configured ZDR and a runtime policy latch.
    get debrief() {
      return mode === "explicit_context" || lastResponseId === undefined ? undefined : (req: CuaTurnRequest, signal: AbortSignal) => requestTurn(req, signal, true);
    }
  };
}
