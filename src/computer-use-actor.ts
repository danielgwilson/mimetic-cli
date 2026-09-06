// The registry-facing wrapper for the OpenAI Computer Use (CUA) actor. runComputerUseLoop needs
// fully-constructed provider/executor instances; exposing that raw through the actor registry
// would leak adapter construction to every call site. So runCuaActorSession takes intent-level
// fields and constructs the provider/executor internally — with DI seams (provider/executor/now)
// so CI can drive the real loop with fakes and zero network/zero spend (mirrors how the Claude
// adapter injects its queryFn).
//
// The loop already returns a fully-formed ActorTrace at result.trace, so there is no separate
// toActorTrace mapper — runCuaActorSession returns the CuaLoopResult unchanged.

import type { ActorPersonaRef, ActorTokenUsage, ActorTraceItem } from "./actor-contract.js";
import {
  runComputerUseLoop,
  type CuaExecutor,
  type CuaLoopOptions,
  type CuaLoopResult,
  type CuaProvider,
  type CuaSafetyCheck
} from "./computer-use.js";
import {
  createE2BDesktopExecutor,
  type E2BDesktopExecutorOptions,
  type E2BDesktopLike
} from "./e2b-desktop-executor.js";
import {
  createOpenAiResponsesProvider,
  type OpenAiResponsesProviderOptions
} from "./openai-responses-cu.js";
import { defaultRedactionHooks, type RedactionHooks } from "./redaction.js";
import type { DwellWindow, StopWhen } from "./stop-conditions.js";
import type { LabTask } from "./tasks.js";

export interface CuaActorSessionOptions {
  /** The composed mission (persona + scenario/lane instruction) handed to the model. */
  instructions: string;
  /** Provenance of the persona this actor embodies (id + applied traits + prompt digest). */
  persona: ActorPersonaRef;
  /** Hard wall-clock runaway guard — the only count-free hard stop the loop honors. */
  timeoutMs: number;
  signal?: AbortSignal;

  /** Live provider construction (used when `provider` is not injected). */
  openai?: OpenAiResponsesProviderOptions;
  /** Live executor construction (used when `executor` is not injected). */
  desktop?: E2BDesktopLike;
  executorOptions?: E2BDesktopExecutorOptions;

  /**
   * DI seams — inject to bypass live construction (CI uses these for zero-spend tests; library
   * callers use them to drive a state-driven, non-vision flow). NOTE: a STATE executor (one
   * whose observe() returns no screenshot — see CuaObservation.screenshot optional) MUST be
   * paired with a NON-vision provider (requiresFrame falsey). The default OpenAI provider is
   * vision-based and would fail closed against a screenshot-less observation. See
   * docs/architecture/state-driven-executor.md.
   */
  provider?: CuaProvider;
  executor?: CuaExecutor;
  redaction?: RedactionHooks;
  now?: () => number;
  /**
   * Decide which model-flagged safety checks to acknowledge; returned checks are echoed back
   * (verbatim wire triples) on the next turn's request so the model proceeds. Omitted here means
   * the loop's own fail-closed default applies (pause on any check). No auto-ack policy ships yet.
   */
  acknowledgeSafetyChecks?: (checks: CuaSafetyCheck[]) => CuaSafetyCheck[] | null;
  idleSteps?: number;
  noProgressSteps?: number;
  /**
   * Redact persisted screenshots (blur+downscale). Default FALSE — full fidelity for local use.
   * Set true for unowned subjects or share-as-is bundles. The provider always sees raw frames.
   */
  redactScreenshots?: boolean;
  /** Literal scrub for known provisioned values, composed before redactText on model narration. */
  scrubText?: (text: string) => string;
  /** Persist a screenshot (raw or redacted per redactScreenshots), returning the trace ref path. */
  writeScreenshot?: (name: string, bytes: Buffer) => Promise<string>;
  /** Deterministic harness-owned stop guards evaluated between model turns. */
  stopWhen?: StopWhen;
  /** A declared observation window (#510), forwarded to the loop. */
  dwell?: DwellWindow;
  /** The lab's declared protocol; the loop records a corroborated task funnel on the trace (#414).
   *  Only the `success` criteria are read here — the participant-facing goals are already composed
   *  into `instructions` upstream, and the criteria never reach the prompt. */
  tasks?: readonly LabTask[];
  /** FAIL-CLOSED spend cap (USD) threaded to the loop; absent = uncapped. See CuaLoopOptions.maxUsd. */
  maxUsd?: number;
  /** Injected pure per-turn cost estimator paired with `maxUsd`. See CuaLoopOptions.estimateTurnCostUsd. */
  estimateTurnCostUsd?: (usage: ActorTokenUsage) => number | null;
  /** RUN-LEVEL spend guard threaded to the loop (#299). See CuaLoopOptions.overRunBudget. */
  overRunBudget?: (usage: ActorTokenUsage) => string | null;
  /** RUNTIME-ONLY observed-URL callback threaded to the loop; see CuaLoopOptions.onObservedUrl. Used by
   *  the concurrent shared-world handoff barrier to latch a host seat's live /lobby/CODE URL. */
  onObservedUrl?: (url: string | undefined) => void;
  /** RUNTIME-ONLY per-turn narration callback threaded to the loop; see CuaLoopOptions.onMessage. */
  onMessage?: (text: string) => void;
  /** RUNTIME-ONLY per-turn raw-frame callback threaded to the loop; see CuaLoopOptions.onScreenshot. */
  onScreenshot?: (frame: Buffer) => void;
  /** Per-turn trace snapshot callback threaded to the loop (#441); see CuaLoopOptions.onTrace. */
  onTrace?: (items: readonly ActorTraceItem[], usage: ActorTokenUsage) => void;
}

export async function runCuaActorSession(options: CuaActorSessionOptions): Promise<CuaLoopResult> {
  if (options.provider && options.openai?.maxOutputTokens !== undefined) {
    throw new Error("openai.maxOutputTokens cannot be enforced by an injected provider.");
  }
  const provider = options.provider ?? buildProvider(options.openai);
  const executor = options.executor ?? buildExecutor(options.desktop, options.executorOptions);

  const loopOptions: CuaLoopOptions = {
    instructions: options.instructions,
    provider,
    executor,
    persona: options.persona,
    redaction: options.redaction ?? defaultRedactionHooks,
    timeoutMs: options.timeoutMs,
    now: options.now ?? (() => Date.now()),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.idleSteps === undefined ? {} : { idleSteps: options.idleSteps }),
    ...(options.noProgressSteps === undefined ? {} : { noProgressSteps: options.noProgressSteps }),
    ...(options.acknowledgeSafetyChecks === undefined ? {} : { acknowledgeSafetyChecks: options.acknowledgeSafetyChecks }),
    ...(options.redactScreenshots === undefined ? {} : { redactScreenshots: options.redactScreenshots }),
    ...(options.scrubText === undefined ? {} : { scrubText: options.scrubText }),
    ...(options.writeScreenshot === undefined ? {} : { writeScreenshot: options.writeScreenshot }),
    ...(options.stopWhen === undefined ? {} : { stopWhen: options.stopWhen }),
    ...(options.dwell === undefined ? {} : { dwell: options.dwell }),
    ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
    ...(options.maxUsd === undefined ? {} : { maxUsd: options.maxUsd }),
    ...(options.estimateTurnCostUsd === undefined ? {} : { estimateTurnCostUsd: options.estimateTurnCostUsd }),
    ...(options.overRunBudget === undefined ? {} : { overRunBudget: options.overRunBudget }),
    ...(options.onObservedUrl === undefined ? {} : { onObservedUrl: options.onObservedUrl }),
    ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
    ...(options.onScreenshot === undefined ? {} : { onScreenshot: options.onScreenshot }),
    ...(options.onTrace === undefined ? {} : { onTrace: options.onTrace })
  };

  return runComputerUseLoop(loopOptions);
}

function buildProvider(openai: OpenAiResponsesProviderOptions | undefined): CuaProvider {
  if (!openai) {
    throw new Error("runCuaActorSession requires either `provider` (injected) or `openai` provider options.");
  }
  return createOpenAiResponsesProvider(openai);
}

function buildExecutor(desktop: E2BDesktopLike | undefined, executorOptions: E2BDesktopExecutorOptions | undefined): CuaExecutor {
  if (!desktop) {
    throw new Error("runCuaActorSession requires either `executor` (injected) or `desktop` to build one.");
  }
  return createE2BDesktopExecutor(desktop, executorOptions ?? {});
}
