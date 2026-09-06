import type { AffordanceUse } from "./affordance.js";
import type { CodexAppServerRunResult, CodexAppServerStatus, CodexAppServerTrace } from "./codex-app-server.js";
import type { ActorEstimatedCost } from "./pricing.js";
import type { TaskFunnel } from "./tasks.js";
import { redactText } from "./redaction.js";

// The provider-neutral evidence schema. Codex item/* events, Claude
// ToolUse/ToolResult blocks, pi tool_execution_* events, and computer-use
// cycles all map onto this one ActorTrace. See docs/architecture/actor-contract.md.
//
// The schema maps the providers and routes implemented by the closed first-party
// registry. The broader Actor.run(input), RedactionHooks, ApprovalPolicy, and
// ResolvedPersona contract remains design-only and is intentionally absent from
// these runtime types.

export const ACTOR_TRACE_SCHEMA = "humanish.actor-trace.v1";

/**
 * How a session ended, from the point of view of the STUDY rather than the harness.
 *
 * The distinction matters because two of these are participant outcomes and the rest are not. A
 * participant who abandons a task is the single most valuable thing a usability study produces, and
 * recording that as `failed` — as this type used to force — reads as the instrument breaking. See
 * docs/principles/three-roles.md.
 *
 * - `passed`      the participant reached the goal
 * - `abandoned`   the participant stopped trying. A FINDING, not a malfunction
 * - `incomplete`  the session ended (time or budget) before the goal was reached
 * - `blocked`     the participant could not proceed: an approval the run could not give, or a
 *                 blocker they described in their own final words (#476)
 * - `timed_out`   the session hit its deadline with no productive activity at all
 * - `failed`      the HARNESS failed: a dead sandbox, a provider error, a broken artifact
 */
export type ActorStatus = "passed" | "abandoned" | "incomplete" | "blocked" | "timed_out" | "failed";

/**
 * What the PARTICIPANT said happened, in a field rather than a paragraph (#570). Providers whose
 * reply is schema-constrained (the local-agent routes) fill it on their final turn; a free-text
 * provider leaves it absent and the lane falls back to reading the closing message. `reached`:
 * the task is finished. `blocked`: something in the app stopped the participant. `not_reached`:
 * the participant stopped for another reason (gave up, ran out of ideas).
 */
export type ParticipantDeclaredOutcome = "reached" | "not_reached" | "blocked";

/** Statuses that describe what happened to a PARTICIPANT rather than a harness malfunction. Verify
 *  treats these as study results, so a run whose evidence is sound is not called untrustworthy just
 *  because a persona gave up. */
export const PARTICIPANT_OUTCOME_STATUSES: readonly ActorStatus[] = ["abandoned", "incomplete"];

export type ActorCompletionReason =
  | "goal_satisfied"
  | "turn_completed"
  | "gave_up"
  | "blocked_approval"
  | "timed_out"
  // A study or provider limit ended the session before a natural endpoint. The computer-use
  // loop maps this to "incomplete", even after productive activity. trace.reason distinguishes
  // wall-clock, estimated-spend, and provider output/context token limits.
  | "budget_reached"
  | "actor_error"
  // A deterministic scripted step or expectation evaluated false: the scenario predicate
  // failed. Distinct from actor_error/harness_error — the harness executed faithfully; the
  // SUBJECT did not satisfy the script.
  | "step_failed"
  | "harness_error";

// "scripted-browser" is the deterministic, model-free browser-actuation lane — distinct from
// "computer-use" (raw pixels + a model) and "app". "terminal" is the autonomous-agent lane: a
// real coding agent (Codex) driving a CLI/product from inside an E2B shell — distinct from
// "code" (the local/app-server Codex lanes that run on the operator's machine).
export type ActorLane = "code" | "app" | "computer-use" | "scripted-browser" | "terminal";

// "terminal-exec" is the captured non-interactive exec stream of an in-sandbox agent (stdin
// disabled): `codex exec --json` launched via `commands.run`, output captured. It is NOT an
// interactive duplex PTY — labeling captured exec output as an interactive transport would be a
// claim/mechanism mismatch (invariant 6 + the goal packet's PTY ruling), so it gets its own
// honest protocol label distinct from "cua-loop"/"scripted-steps".
export type ActorProtocol = "json-rpc" | "json-stream" | "in-process-sdk" | "cua-loop" | "scripted-steps" | "terminal-exec";

export type ActorTraceItemKind =
  | "message"
  | "reasoning"
  | "tool_call"
  | "command"
  | "file_change"
  | "approval"
  | "screenshot"
  | "ui_action"
  | "plan"
  | "notice";

export interface ActorTraceItem {
  id: string;
  kind: ActorTraceItemKind;
  lifecycle: "started" | "completed";
  status?: string;
  title: string;
  tool?: { server?: string; name?: string };
  command?: { text?: string; cwd?: string; exitCode?: number; outputTail?: string };
  screenshotRef?: { path: string; redaction: "blurred" | "ocr_scrubbed" | "none" };
  text?: string;
  /** When the item was recorded (ISO-8601), from the loop's injected clock. Additive
   *  (#441): items from older bundles and non-stamping producers lack it, so every
   *  consumer must treat absence as "timing unknown", never as t=0. */
  at?: string;
  /** Structured pointer coordinates for click-like `ui_action` items (#441) — the
   *  recorded fact the Observer's pins previously re-parsed out of the title text. */
  coord?: { x: number; y: number };
}

export interface ActorCapabilities {
  headless: boolean;
  structuredTrace: boolean;
  lanes: ActorLane[];
  producesScreenshots: boolean;
  byoModel: boolean;
  preGrantableApprovals: boolean;
  inProcessTools: boolean;
  license: "open" | "source-available" | "proprietary";
  /**
   * WHERE this actor's runtime key lives, per the placement rule (invariants-and-defaults.md):
   * "keys live where the keyed process runs — and nowhere else." Registry metadata the engine
   * enforces, NOT a code convention.
   *   - "external" (the implicit default for every existing actor): the keyed process (e.g. a
   *     computer-use provider loop) runs OUTSIDE any sandbox, so its key never enters one.
   *   - "in-sandbox-command-scoped": the keyed process is an agent-harness-under-test that runs
   *     INSIDE the sandbox; its runtime key is injected ONLY into the per-command `envs` of that
   *     invocation (never `Sandbox.create({envs})`, which is sandbox-global), the key is presumed
   *     exfiltratable, and the blast radius is bounded by key scoping + a spend budget.
   * Absent === "external". On the shipped terminal-product live route, the engine enforces this
   * declaration before sandbox creation and passes the key only to the agent command.
   */
  keyPlacement?: "external" | "in-sandbox-command-scoped";
}

export interface ActorPersonaRef {
  id: string;
  traitsApplied: string[];
  promptDigest: string;
}

export interface ActorTokenUsage {
  input?: number;
  output?: number;
  /** Of `input`, how many tokens were served from the provider's prompt cache. Optional and
   *  HONESTLY ABSENT: a provider that does not report it leaves this undefined rather than
   *  reporting 0, because 0 and "unknown" price very differently (#391). */
  cachedInput?: number;
  /** Of `input`, how many tokens were newly WRITTEN to the provider's prompt cache
   *  (OpenAI 5.6+ bills these at a surcharge and reports `cache_write_tokens`). Same
   *  honestly-absent discipline as `cachedInput` (#334). */
  cacheWriteInput?: number;
  /** Per provider-REQUEST usage, in request order. Recorded fact, not pricing: a provider
   *  that re-prices whole requests past an input-size threshold (long-context tiers) can
   *  only be priced exactly from per-request sizes; totals cannot say which requests
   *  crossed. Additive and honestly absent on producers that do not record it (#334). */
  turns?: Array<{
    input?: number;
    cachedInput?: number;
    cacheWriteInput?: number;
    output?: number;
  }>;
  total?: number;
  costUsd?: number;
}

/** The participant's account, not an independently confirmed product diagnosis. */
export interface ParticipantClosingReport {
  summary: string;
  frictionReports: string[];
}

/** Runtime declarations and executable-version observations; not provider request attestation. */
export interface ActorRuntimeProvenance {
  schema: "humanish.actor-runtime.v1";
  package: string;
  requestedVersion: string;
  observedVersion?: string;
  versionStatus: "unobserved" | "verified" | "failed";
  requestedModel?: string;
  modelStatus: "declared" | "runtime_default_unobserved";
  requestedReasoningEffort?: string;
  /** Codex turn.completed aggregates requests; it cannot establish per-request pricing tiers. */
  usageGranularity: "runtime_turn";
}

export interface ActorTrace {
  schema: typeof ACTOR_TRACE_SCHEMA;
  provider: string;
  providerVersion?: string;
  runtime?: ActorRuntimeProvenance;
  protocol: ActorProtocol;
  lane: ActorLane;
  persona: ActorPersonaRef;
  // status: "passed" means the trace conforms to its declared redaction policy and carries no
  // secret VALUES in text. screenshots: "raw" = full-fidelity frames retained (valid for LOCAL
  // use; redact before publishing); "blurred"/"ocr_scrubbed" = publish-safe; "n/a" = none captured.
  redaction: { status: "passed"; screenshots: "n/a" | "raw" | "blurred" | "ocr_scrubbed"; notes: string };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  ids: { sessionId?: string; threadId?: string; turnId?: string; model?: string };
  /**
   * ADDITIVE + OPTIONAL record of HOW the model was asked to run (humanish.model-settings.v1,
   * #497). `ids.model` says which model; this says the reasoning effort the request actually
   * carried. Present on lanes whose provider declares settings; absent everywhere else and on
   * every pre-existing bundle, and its absence is tolerated by verify.
   *
   * It exists because effort was a silent constant: unreachable from a lab, so every run took the
   * provider default. Effort is part of WHO the participant was, not of how the instrument was
   * tuned (docs/principles/actor-fidelity.md), so a trace that does not carry it is a result with
   * half its sample description missing — and two such traces cannot honestly be compared.
   */
  modelSettings?: { reasoningEffort: string; maxOutputTokens?: number };
  counts: Record<string, number>;
  /**
   * ADDITIVE + OPTIONAL affordance record (humanish.affordance-use.v1, #369): which KIND of route
   * this actor took — pointer, keyboard, url-navigation, script-execution, devtools,
   * browser-internal, observation — as per-class counts over the run's dispatched actions.
   * Present on computer-use lanes that dispatched at least one action; absent elsewhere and on
   * every pre-existing bundle (its absence is tolerated by verify). The harness records the class
   * and states NO verdict: whether a class is faithful depends on the population the study
   * declares, which is product semantics and belongs to the adopter's scorer. See
   * docs/principles/actor-fidelity.md.
   */
  affordanceUse?: AffordanceUse;
  /**
   * ADDITIVE + OPTIONAL task funnel (humanish.task-funnel.v1, #414): how far this participant got
   * through the lab's declared protocol, corroborated per task by observations rather than by the
   * actor's own narration. Present only when the lab declared `tasks` and the session ran; absent
   * on every pre-existing bundle and on dry-run contract bundles (honest absence — a funnel that
   * was never measured is not an empty funnel). Its absence is tolerated by verify.
   */
  taskFunnel?: TaskFunnel;
  /**
   * ADDITIVE + OPTIONAL (#570): the outcome the participant declared on its final turn, when its
   * provider's reply carries the field. Absent on free-text providers and on every older bundle.
   * The lane reads this before it reads the closing paragraph; three regex patches in one month
   * (#453, #549, #565) each fixed a false refusal and each left the next shape unhandled.
   */
  declaredOutcome?: ParticipantDeclaredOutcome;
  /** Closing report after a harness-owned stop. Does not change task outcomes or permit actions. */
  debrief?: {
    trigger: "stop_when" | "dwell";
    status: "completed" | "skipped" | "failed";
    reason: string;
    /** Absent if no request was made; false means that request's cost is unreported. */
    usageReported?: boolean;
    report?: ParticipantClosingReport;
    /** Links the readable projection so it is not heuristically classified a second time. */
    messageId?: string;
  };
  items: ActorTraceItem[];
  tokenUsage?: ActorTokenUsage;
  /**
   * ADDITIVE + OPTIONAL token-derived cost ESTIMATE for this lane (humanish.actor-estimated-cost.v1).
   * Distinct from `tokenUsage.costUsd`, which is RESERVED for a real provider-returned charge: a
   * bare `costUsd` always means "the provider billed this", while `estimatedCost.estimatedCostUsd`
   * is a rate-table multiply named honestly as an estimate (invariant 6). Absent on codex/scripted
   * lanes and on every pre-existing bundle — its absence is tolerated by verify (fail-open on
   * display). A `null` estimatedCostUsd is DECLARED ABSENT (unknown rate / no usage), never 0.
   */
  estimatedCost?: ActorEstimatedCost;
  capabilities: ActorCapabilities;
}

export const CODEX_APP_SERVER_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["code"],
  producesScreenshots: false,
  byoModel: false,
  preGrantableApprovals: true,
  inProcessTools: false,
  license: "open"
};

// pi-agent-core (@earendil-works/pi-agent-core): an embeddable, provider-agnostic
// agent loop (MIT). byoModel: 15+ providers incl. local. No confirmed pre-grant
// approval hook today, so preGrantableApprovals is false until verified.
export const PI_AGENT_CORE_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["code", "app"],
  producesScreenshots: false,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: true,
  license: "open"
};

// Claude Agent SDK (@anthropic-ai/claude-agent-sdk): in-process query() stream
// with typed SDK messages. Pre-grant approvals via permissionMode/allowedTools.
// Anthropic-centric models (others via a proxy), so byoModel is false.
export const CLAUDE_AGENT_SDK_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["code", "app"],
  producesScreenshots: false,
  byoModel: false,
  preGrantableApprovals: true,
  inProcessTools: true,
  license: "open"
};

// Scripted browser driver (src/scripted-browser-actor.ts): deterministic Playwright step
// replay against a loopback app. byoModel is false because there is NO model — the committed
// scenario steps are the whole behavior; tokenUsage on its traces records zeros by mechanism.
export const SCRIPTED_BROWSER_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["scripted-browser"],
  producesScreenshots: true,
  byoModel: false,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open" // playwright-core (Apache-2.0), already a lazy-imported production dependency
};

// Terminal agent (src/e2b-terminal-lab.ts): a real autonomous coding agent (Codex) discovering
// and using a CLI/product from inside an E2B shell, capturing its non-interactive exec output as
// a redacted event stream + normalized transcript. The "terminal" lane is the autonomous-agent
// study lane (distinct from "code", the operator-machine Codex lanes). byoModel is false: the
// agent runs its own model via the command-scoped runtime auth, not a humanish-supplied provider.
// keyPlacement is "in-sandbox-command-scoped" — the load-bearing inversion of every existing
// E2B route's external-key default (the agent is the keyed process and it runs INSIDE). The
// terminal-product live route enforces the boundary before sandbox creation.
export const TERMINAL_AGENT_CAPABILITIES: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["terminal"],
  producesScreenshots: false,
  byoModel: false,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open", // the Codex CLI is invoked as a subprocess inside the sandbox; no peer dep here
  keyPlacement: "in-sandbox-command-scoped"
};

// Codex app-server reports four terminal statuses but no explicit completion
// reason enum, so map status -> reason. App-server "blocked" is approval-driven
// (an action was declined and the turn could not proceed). "goal_satisfied" and
// "gave_up" are not reachable from Codex today; they arrive with persona-driven
// scenario predicates and harness-enforced turn budgets in a later PR.
export function codexStatusToCompletionReason(status: CodexAppServerStatus): ActorCompletionReason {
  switch (status) {
    case "passed":
      return "turn_completed";
    case "timed_out":
      return "timed_out";
    case "blocked":
      return "blocked_approval";
    case "failed":
      return "actor_error";
  }
}

function codexItemKind(type: string): ActorTraceItemKind {
  switch (type) {
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file_change";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "tool_call";
    case "agentMessage":
      return "message";
    case "reasoning":
      return "reasoning";
    default: {
      const lowered = type.toLowerCase();
      if (lowered.includes("message")) return "message";
      if (lowered.includes("reason")) return "reasoning";
      if (lowered.includes("command")) return "command";
      if (lowered.includes("file")) return "file_change";
      if (lowered.includes("tool")) return "tool_call";
      if (lowered.includes("plan")) return "plan";
      return "notice";
    }
  }
}

function pickTokenUsage(raw: CodexAppServerTrace["tokenUsage"]): ActorTokenUsage | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const numberFrom = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  };
  const input = numberFrom(["input", "input_tokens", "inputTokens", "prompt_tokens"]);
  const output = numberFrom(["output", "output_tokens", "outputTokens", "completion_tokens"]);
  const total = numberFrom(["total", "total_tokens", "totalTokens"]);
  const costUsd = numberFrom(["costUsd", "cost_usd", "cost"]);
  const usage: ActorTokenUsage = {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === undefined ? {} : { total }),
    ...(costUsd === undefined ? {} : { costUsd })
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

// Flatten the Codex trace into provider-neutral items. The lifecycle rows in
// trace.items only cover message/reasoning/command/file/tool; approvals, plans,
// warnings, and errors live only in sibling arrays and are synthesized here so
// no evidence is silently dropped.
function codexTraceToActorItems(trace: CodexAppServerTrace): ActorTraceItem[] {
  const commandByItem = new Map(trace.commands.map((command) => [command.itemId, command]));
  const toolByItem = new Map(trace.tools.map((tool) => [tool.itemId, tool]));
  const messageByItem = new Map(trace.messages.map((message) => [message.itemId, message]));
  const reasoningByItem = new Map(trace.reasoning.map((entry) => [entry.itemId, entry]));
  const fileChangeByItem = new Map(trace.fileChanges.map((change) => [change.itemId, change]));

  const items: ActorTraceItem[] = trace.items.map((item) => {
    const kind = codexItemKind(item.type);
    const base: ActorTraceItem = {
      id: item.id,
      kind,
      lifecycle: item.lifecycle,
      title: item.title,
      ...(item.status === undefined ? {} : { status: item.status })
    };
    if (kind === "command") {
      const command = commandByItem.get(item.id);
      if (command) {
        return {
          ...base,
          command: {
            ...(command.command === undefined ? {} : { text: command.command }),
            ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
            ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
            ...(command.outputTail === undefined ? {} : { outputTail: command.outputTail })
          }
        };
      }
    }
    if (kind === "tool_call") {
      const tool = toolByItem.get(item.id);
      if (tool) {
        return {
          ...base,
          tool: {
            ...(tool.server === undefined ? {} : { server: tool.server }),
            ...(tool.tool === undefined ? {} : { name: tool.tool })
          }
        };
      }
    }
    if (kind === "message") {
      const message = messageByItem.get(item.id);
      if (message) {
        return { ...base, text: message.text };
      }
    }
    if (kind === "reasoning") {
      const reasoning = reasoningByItem.get(item.id);
      if (reasoning) {
        return { ...base, text: reasoning.text };
      }
    }
    if (kind === "file_change") {
      const change = fileChangeByItem.get(item.id);
      if (change?.outputTail !== undefined) {
        return { ...base, text: change.outputTail };
      }
    }
    return base;
  });

  for (const approval of trace.approvals) {
    items.push({
      id: `approval-${String(approval.id)}`,
      kind: "approval",
      lifecycle: "completed",
      status: approval.decision,
      title: `${approval.method} (${approval.decision})`,
      ...(approval.reason ? { text: approval.reason } : {})
    });
  }
  trace.plans.forEach((plan, index) => {
    items.push({
      id: `plan-${index + 1}`,
      kind: "plan",
      lifecycle: "completed",
      title: plan.explanation ?? "Plan update",
      ...(plan.steps.length > 0 ? { text: plan.steps.join("\n") } : {})
    });
  });
  [...trace.warnings, ...trace.errors].forEach((notice, index) => {
    items.push({
      id: `notice-${index + 1}`,
      kind: "notice",
      lifecycle: "completed",
      title: notice.method,
      ...(notice.message ? { text: notice.message } : {})
    });
  });

  return items;
}

/**
 * Map a Codex app-server run result into the provider-neutral ActorTrace. Pure
 * and side-effect-free. The persona reference is supplied by the harness; until
 * personas are load-bearing it is a minimal stub ({ id, traitsApplied: [],
 * promptDigest }).
 */
export function codexResultToActorTrace(result: CodexAppServerRunResult, persona: ActorPersonaRef): ActorTrace {
  const trace = result.trace;
  const tokenUsage = pickTokenUsage(trace.tokenUsage);
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "codex-app-server",
    ...(trace.server.codexCliVersion === undefined ? {} : { providerVersion: trace.server.codexCliVersion }),
    protocol: "json-rpc",
    lane: "code",
    persona,
    redaction: { status: "passed", screenshots: "n/a", notes: trace.redaction.notes },
    startedAt: trace.startedAt,
    completedAt: trace.completedAt,
    durationMs: trace.durationMs,
    status: trace.status,
    completionReason: codexStatusToCompletionReason(trace.status),
    // result.reason is the raw reason; the codex trace redacts its own reason, so
    // redact here too to keep the actor projection consistent (defense in depth).
    reason: redactText(result.reason),
    ids: {
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
      ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
      ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
      ...(result.model === undefined ? {} : { model: result.model })
    },
    counts: { ...trace.counts },
    items: codexTraceToActorItems(trace),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    capabilities: CODEX_APP_SERVER_CAPABILITIES
  };
}
