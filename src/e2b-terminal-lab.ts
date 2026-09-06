// The terminal-product lab backend: a real autonomous agent (Codex) studying a CLI/product from
// PUBLIC SURFACES ONLY, running INSIDE an E2B shell with explicit runtime-auth placement, capturing
// its non-interactive exec output (stdin disabled) as a redacted event stream + normalized
// transcript, capped at no-spend, emitting durable terminal/substrate/cost/no-spend/cleanup/
// intervention proof. Mirrors cua-actor-lab.ts / scripted-browser-lab.ts.
//
// BOTH ROUTES ARE IMPLEMENTED.
//   - DRY-RUN: a contract-only `humanish.run-bundle.v1`, honestly labeled.
//   - LIVE: the real create -> inject (command-scoped) -> run `codex exec --json` -> capture
//     (scrub+redact at the source) -> score (verdict-nonce marker) -> teardown (proven cleanup)
//     orchestrator on the @e2b/desktop commands.run surface.
//
// THE SAFETY CONTRACT (docs/goals/terminal-product-lane/goal.md) is enforced BY CONSTRUCTION here
// and CHECKED by the verifier (run.ts validateTerminalProductEvidence):
//   1. EXPLICIT KEY PLACEMENT. openai-env (default) injects the raw runtime key command-scoped,
//      NEVER Sandbox.create({envs}). Opt-in openai-egress sends it only in the host-side E2B
//      header transform and passes an inert command placeholder. The proxy is spendable by every
//      sandbox process from creation; this protects the raw key, not provider spending.
//   2. FAIL-CLOSED CAP. The live key is never exercised without scenario.caps in force: maxUsd
//      (default/require 0 = no-spend) + maxMinutes (wall-clock kill of the codex command).
//   3. PUBLIC SURFACES ONLY. The mission references only subject.product.publicSurfaces + the
//      author mission. No clone, no private-source access — nothing is git-cloned in this lane.
//   4. DENY-BY-DEFAULT CREDENTIALS. The command envs are built from an ALLOWLIST of ONLY the
//      declared runtime key; GITHUB_TOKEN/GH_TOKEN/payment/deploy/db/media keys are excluded by
//      construction (a banned-name guard also fails closed if one is ever requested).
//   5. NO SECRET VALUES IN EVIDENCE. Every captured byte (event stream, transcript, command logs,
//      agent report, metadata) passes scrubKnownValues (literal scrub of the runtime key + any
//      provisioned values, >=4 chars, PRE-truncation) THEN redactText (shape patterns) BEFORE
//      persisting. The transport is labeled HONESTLY (exec-stream/snapshot, NOT an interactive pty).
//   6. METADATA POSITIVE ALLOWLIST. buildSandboxMetadata(allowlist) is the ONLY way metadata is
//      set; it carries solely non-secret labels (mode/tool/labId/simId/provider/runId).
//   7. STDIN DISABLED + INTERVENTIONS LEDGER. stdin is never wired to the codex command; the
//      bundle ALWAYS carries an interventions ledger (empty array is valid + required-present).
//   8. PROVEN CLEANUP, BY ID, NEVER ACCOUNT-WIDE. Sandbox.kill(id) in a finally; the cleanup
//      proof is BY EXACT ID: kill(id)'s own found-and-killed boolean, confirmed further by
//      Sandbox.getInfo(id) when the SDK exposes it (a thrown SandboxNotFoundError means gone).
//      humanish NEVER calls Sandbox.list to prove cleanup, so a shared operator key never reaches a
//      sandbox it did not create. A live run that cannot prove teardown fails closed.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { TERMINAL_NODE_BOOTSTRAP_COMMAND } from "./terminal-node-bootstrap.js";
import { describeTokenUsage, parseTerminalTokenUsage } from "./terminal-token-usage.js";
import type { ActorTokenUsage, ActorRuntimeProvenance } from "./actor-contract.js";
import { buildRuntimeExecPrefix, buildRuntimeVersionCommand, declaredRuntimeProvenance, isExactRuntimeVersion, parseTerminalRuntimeVersion, TERMINAL_RUNTIME_VERSION_TIMEOUT_MS } from "./terminal-runtime.js";
import { isReasoningEffort } from "./reasoning-effort.js";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { ActorCompletionReason, ActorPersonaRef, ActorStatus, ActorTrace, ActorTraceItem } from "./actor-contract.js";
import { beginRunStatus, type RunLabProvenance, type RunStatusHandle , withRunStatusScope} from "./run-status.js";
import { ACTOR_TRACE_SCHEMA, TERMINAL_AGENT_CAPABILITIES } from "./actor-contract.js";
import { actorRegistry, isTerminalActorDescriptor } from "./actor-registry.js";
import { toErrorMessage } from "./command-failure.js";
import { buildOpenAiEgressNetwork, E2B_SYSTEM_CA_BUNDLE, OPENAI_EGRESS_PLACEHOLDER } from "./terminal-runtime-auth.js";
import type { LabConfig, LabScenarioCaps, LabRuntimeAuth } from "./lab-config.js";
import {
  E2BDesktopStartupError,
  isSandboxNotFoundError,
  loadE2BDesktopModule,
  type E2BDesktopModule,
  type E2BDesktopSandbox
} from "./e2b-desktop-launch.js";
import { renderObserver, type ObserverResult } from "./observer.js";
import { parseResolvedPersona, personaToDirectives, renderPersonaPromptSection, type ResolvedPersona } from "./persona.js";
import { digestText, redactedTail, redactText } from "./redaction.js";
import { prepareRunArtifactPaths, validatePreparedRunArtifactPaths } from "./run-paths.js";
import {
  prepareSelectedOutputDirectory,
  readContainedRegularFile,
  writeContainedOutputFile,
  writePreparedRunLatestPointer,
  type PreparedSelectedOutputDirectory
} from "./selected-output-paths.js";
import {
  buildRunSource,
  extractLocalActorVerdict,
  normalizeLocalActorTranscript,
  PUBLIC_TARGET_CWD,
  REVIEW_SCHEMA,
  RUN_BUNDLE_SCHEMA,
  type ReviewSummary,
  type RunAdapterScore,
  type RunBundle,
  type RunEvent,
  type RunFeedbackCandidate,
  type RunScorerProvenance,
  type RunSimulation,
  type RunSimulationStatus,
  type RunStream
} from "./run.js";
import { appendSandboxReceipt } from "./sandbox-receipts.js";
import { applyAdapterScoreFailureToReview, frozenBundleView, recordDeclaredScorerVerdictFailure } from "./adapter-extension.js";
import { TERMINAL_AGENT_NOT_IMPLEMENTED_CODE } from "./terminal-agent-actor.js";

/** Provider-neutral metadata constant: the lane's non-secret tag (mirrors CUA_ACTOR_LAB_PROVIDER_METADATA). */
export const TERMINAL_PRODUCT_LAB_PROVIDER_METADATA = {
  mode: "terminal-product-lab",
  tool: "humanish"
} as const;

// The terminal-product ledger schemas the verifier asserts present on a LIVE bundle. They ride the
// existing terminal stream + events (humanish.run-bundle.v1 is unchanged); these constants name the
// artifact files so the producer and verifier cannot drift on the path.
export const TERMINAL_EVENTS_ARTIFACT = "terminal-events.ndjson";
export const TERMINAL_TRANSCRIPT_ARTIFACT = "terminal-transcript.txt";
export const TERMINAL_LEDGERS_ARTIFACT = "terminal-ledgers.json";

/** The in-sandbox working directory for the agent (a scratch dir; nothing is cloned into it). */
const SANDBOX_WORKDIR = "/home/user/study";
/** A packed npm tarball is a couple of MB; the cap is generous and exists so a mis-set path cannot
 *  stream something enormous into a sandbox. */
const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
// Server-side reclamation buffer past the codex command's own wall-clock (caps.maxMinutes) kill.
const SANDBOX_TIMEOUT_BUFFER_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// Allow the pinned runtime download and install enough time while retaining a finite deadline.
const RUNTIME_BOOTSTRAP_TIMEOUT_MS = 300_000;
// How much of a captured stream / log tail rides a (redacted) message field.
const TAIL_CHARS = 2000;
// Hard cap on the retained event-stream + transcript size, so a runaway agent cannot balloon the
// bundle. Redaction runs PRE-truncation so a cut can never split a secret past the scrubber.
const MAX_TRANSCRIPT_BYTES = 512 * 1024;

export const TERMINAL_PRODUCT_LAB_SCHEMA = "humanish.terminal-lab-result.v1";

/**
 * Library-level hooks: the DI seams that drive the full live path against a fake sandbox + mock
 * CLI at zero spend. The deterministic merge-gate test wires loadModule (a fake @e2b/desktop
 * module) + env (the operator key source) + now (an injected clock); the live rung uses none of
 * them (it loads the real module and reads the real environment).
 */
/**
 * The read-only evidence a thin adapter's scorer/feedback hook sees (the layer-6 extension seam,
 * issue #154 acceptance #8). It is the FULLY-ASSEMBLED, redacted, verifiable evidence — the live run
 * bundle, the provider-neutral actor trace, and the persisted ledgers (substrate/command/
 * interventions/cleanup/cost/no-spend). Every member is an EXPORTED public type, so a thin adapter
 * types against `import("humanish")` alone — never a deep `src/` import. The adapter reads this
 * to score the product attempt and derive feedback; it cannot mutate core's evidence (the lane
 * attaches only the namespaced `RunAdapterScore` it returns + the feedback candidates it derives).
 */
export interface TerminalProductScoringContext {
  /** The assembled live run bundle (already redacted/scrubbed + verifiable). Read-only to the adapter. */
  bundle: RunBundle;
  /** The provider-neutral actor trace for the in-sandbox agent session. */
  trace: ActorTrace;
  /** The persisted terminal-product ledgers (lifecycle/command/interventions/cleanup/cost/no-spend). */
  ledgers: TerminalLedgers;
  /**
   * The FULL normalized transcript of the in-sandbox agent session — scrubbed (literal known
   * values) then redacted (shape patterns) AT THE SOURCE, capped at MAX_TRANSCRIPT_BYTES, and
   * byte-identical to the persisted terminal-transcript.txt artifact. The trace's transcriptTail
   * is a ~2KB projection of this; a scorer needs the whole session so a rubric can find
   * command-tier evidence anywhere in it, not only in the tail window (#341).
   */
  transcript: string;
  /** The studied product name (public-safe). */
  product: string;
  /** The lab id (the run's scenario scope). */
  labId: string;
  /** The run id (for building namespaced idempotency keys + evidence pointers). */
  runId: string;
}

export interface TerminalProductLabHooks {
  /** Lazy-load the E2B module (tests inject a fake; default loadE2BDesktopModule). */
  loadModule?: () => Promise<E2BDesktopModule>;
  /**
   * The operator environment the lane reads the runtime key from (and from which it asserts no
   * banned credential is requested). Defaults to process.env. The runtime key is injected ONLY
   * into command-scoped `codex` env or an external header transform — NEVER Sandbox.create envs (the credential
   * boundary); tests plant a fake key here and assert it never reaches metadata/global env/artifacts.
   */
  env?: Record<string, string | undefined>;
  renderObserverFn?: typeof renderObserver;
  /** Injected clock for deterministic timestamps + wall-clock arithmetic (tests only). */
  now?: () => number;
  /**
   * Optional cost-ledger seam. Core has no product/media/payment spend signal, so it populates only
   * the provider line from trace tokenUsage when present. Tests and adapters can inject KNOWN spend
   * lines; absent signals retain the null-discipline default.
   */
  costProbe?: (context: { tokenCostUsd?: number }) => Partial<Record<"product" | "media" | "payment" | "provider", CostLine>> | undefined;
  /**
   * THE LAYER-6 EXTENSION SEAM (issue #154 acceptance #8: "product-adapter hooks WITHOUT forking
   * core"). A thin in-repo/out-of-tree adapter registers a product scorer here. The lane calls it
   * (when provided) over the fully-assembled evidence and attaches the returned, ADAPTER-NAMESPACED
   * `RunAdapterScore` to `bundle.adapterScore` WITHOUT core knowing any product noun (the score is
   * namespaced + its component breakdown rides in `data`). When NO scorer is given, the default
   * mission-based verdict (`review`) is unchanged. This is the SEAM the adopter's scorecard plugs
   * into — NOT a built-in product scorer (that lives in the adopter's repo).
   */
  score?: (ctx: TerminalProductScoringContext) => RunAdapterScore | Promise<RunAdapterScore>;
  /**
   * Companion seam: derive product-feedback candidates from the same assembled evidence. The lane
   * appends the returned candidates to `bundle.feedbackCandidates`. The adapter records its
   * product-specific concepts (public CLI command observed, hosted success-or-blocker, feedback id,
   * media/job ids, no-spend proof, defection/friction risk) under each candidate's ADAPTER-NAMESPACED
   * `adapter` block — never as core enums (issue #154's "record product-specific concepts as
   * NON-core nouns" list). The candidates must still satisfy core's feedback-candidate shape (which
   * the bundle verifier enforces), so a malformed adapter candidate fails closed.
   */
  deriveFeedback?: (ctx: TerminalProductScoringContext) => RunFeedbackCandidate[] | Promise<RunFeedbackCandidate[]>;
}

export interface RunTerminalProductLabOptions {
  /** Which manifest produced this run (#455); threaded into the status record + bundle. */
  lab?: RunLabProvenance;
  cwd: string;
  config: LabConfig;
  /** Resolved upstream (scenario.mode + CLI override); defaults safe (dry-run). */
  dryRun: boolean;
  open?: boolean;
  runId?: string;
  hooks?: TerminalProductLabHooks;
  /**
   * Present ONLY when the scorer hooks were CONFIG-DECLARED and loaded by the CLI (#316). Its presence
   * is the "declared" marker: a config-declared terminal scorer returning status:"fail" FLIPS
   * bundle.review.verdict (like the browser routes), and one that throws becomes a visible review.gaps
   * entry. A LIBRARY caller passing `hooks` directly leaves this ABSENT and keeps today's purely
   * additive terminal behavior (verdict unchanged). Core-computed, never adopter-supplied.
   */
  scorerProvenance?: RunScorerProvenance;
}

export interface TerminalProductLabResult {
  schema: typeof TERMINAL_PRODUCT_LAB_SCHEMA;
  /** True when the bundle verified AND (dry-run, or the live session reached a terminal verdict
   *  without a harness error + cleanup was proven). The agent's pass/fail is evidence, not the
   *  lab's exit code. */
  ok: boolean;
  cwd: string;
  labId: string;
  /** The registry-resolved actor id that ran (or would run) the session. */
  actor: string;
  /** The studied product name (public-safe). */
  product: string;
  dryRun: boolean;
  runId: string;
  /** Live-only: the in-sandbox agent session verdict (omitted on dry-run / pre-session failure). */
  session?: {
    status: ActorStatus;
    completionReason: ActorCompletionReason;
    reason: string;
  };
  /** Live-only: the sandbox lifecycle proof (the key/auth value is NEVER surfaced here). */
  sandbox?: {
    sandboxId: string;
    killed: boolean;
    /** BY-ID proof (never a re-list): 0 = confirmed reclaimed, 1 = still present (unconfirmed),
     *  -1 = kill(id) itself failed or was unavailable. See TerminalLedgers["cleanup"]. */
    remaining: number;
  };
  /** Live-only: the spend ledger surfaced on the result — unknowns are null, never guessed.
   *  Lets a programmatic caller read spend without parsing the bundle. */
  cost?: {
    knownTotalUsd: number;
    fullyMeasured: boolean;
    /** Per-category USD: a known number, or null = NOT MEASURED (never coerced to 0). */
    lines: Record<"product" | "media" | "payment" | "provider", number | null>;
  };
  /** Live-only: the no-spend proof DERIVED from the ledger. */
  noSpend?: {
    satisfied: boolean;
    maxUsd: number | null;
    knownZeroLines: string[];
    unmeasuredLines: string[];
  };
  observer?: ObserverResult;
  warnings: string[];
  error?: {
    code:
      | "HUMANISH_TERMINAL_LAB_FAILED"
      | "HUMANISH_TERMINAL_LAB_ACTOR_UNSUPPORTED"
      | "HUMANISH_TERMINAL_LAB_SUBJECT_INVALID"
      | "HUMANISH_TERMINAL_LAB_KEYPLACEMENT_INVALID"
      | "HUMANISH_TERMINAL_LAB_RUNTIME_AUTH_MISSING"
      | "HUMANISH_TERMINAL_LAB_CAPS_MISSING"
      | "HUMANISH_TERMINAL_LAB_CAPS_EXCEEDED"
      | "HUMANISH_TERMINAL_LAB_CREDENTIAL_DENIED"
      | "HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN"
      | typeof TERMINAL_AGENT_NOT_IMPLEMENTED_CODE;
    message: string;
  };
}

/**
 * Wrapped so a DIRECT library caller gets the same status-record lifetime the CLI does: returning
 * from this function finalizes any record the run opened, whichever of its fail-closed exits it
 * took. `runLab` establishes a scope too and nesting is harmless — the inner scope owns what it
 * opened. Without this a test or an adopter calling the backend directly leaves the 5s cadence
 * ticking into a directory something else is deleting, which surfaces as an unrelated ENOTEMPTY.
 */
export async function runTerminalProductLab(options: RunTerminalProductLabOptions): Promise<TerminalProductLabResult> {
  return withRunStatusScope(() => runTerminalProductLabInScope(options));
}

async function runTerminalProductLabInScope(options: RunTerminalProductLabOptions): Promise<TerminalProductLabResult> {
  const { config, dryRun } = options;
  const cwd = path.resolve(options.cwd);
  const hooks = options.hooks ?? {};
  const render = hooks.renderObserverFn ?? renderObserver;
  const warnings: string[] = [];
  const actorType = config.actors[0]?.type ?? "";
  const product = config.subject.product;

  const failed = (
    code: NonNullable<TerminalProductLabResult["error"]>["code"],
    message: string,
    extras?: { actor?: string; product?: string }
  ): TerminalProductLabResult => ({
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok: false,
    cwd,
    labId: config.id,
    actor: extras?.actor ?? actorType,
    product: extras?.product ?? product?.name ?? "",
    dryRun,
    runId: options.runId ?? "not-created",
    warnings,
    error: { code, message }
  });

  // Resolve the actor through the registry — the parse layer already validated this, but the
  // engine fails closed rather than trusting a config that arrived through another door
  // (runTerminalProductLab is itself exported npm surface).
  const descriptor = actorRegistry[actorType as keyof typeof actorRegistry];
  if (!descriptor || !isTerminalActorDescriptor(descriptor)) {
    return failed(
      "HUMANISH_TERMINAL_LAB_ACTOR_UNSUPPORTED",
      `actors[0].type "${actorType}" is not a registered terminal actor.`
    );
  }

  const runtimeVersion = config.execution?.runtime?.version;
  const actor = config.actors[0];
  if ((config.execution?.runtime !== undefined && !isExactRuntimeVersion(runtimeVersion))
    || (actor?.model !== undefined && (typeof actor.model !== "string" || actor.model.trim().length === 0))
    || (actor?.reasoningEffort !== undefined && !isReasoningEffort(actor.reasoningEffort))) {
    return failed("HUMANISH_TERMINAL_LAB_FAILED", "Terminal runtime settings require an exact Codex version, a nonempty model when declared, and a supported reasoning-effort value.");
  }

  // Re-enforce the subject shape at the engine (the parser rejects these too, but this is exported
  // npm surface). A terminal-product subject MUST declare product.name + public surfaces.
  if (!product || !product.name || product.publicSurfaces.length === 0) {
    return failed(
      "HUMANISH_TERMINAL_LAB_SUBJECT_INVALID",
      "terminal-product subjects require `subject.product` with a name and at least one public surface URL.",
      { actor: descriptor.id }
    );
  }

  // LIVE path: the real in-sandbox agent session. A separate orchestrator owns the
  // create -> inject (command-scoped) -> run -> capture -> teardown lifecycle so the dry-run path
  // below stays a pure contract builder. It enforces the safety contract by construction (the
  // keyPlacement-routed command-scoped key, the deny-by-default allowlist, the fail-closed cap,
  // the proven cleanup) and fails closed before any sandbox/key/spend on any precondition miss.
  if (!dryRun) {
    return runLiveTerminalSession({ options, cwd, config, descriptorId: descriptor.id, product, warnings, render, failed });
  }

  const mission = config.actors[0]?.mission ?? defaultMission(product.name);
  const personaId = config.actors[0]?.persona ?? "autonomous-terminal-agent";
  const physicalCwd = await realpath(cwd);
  // Resolve the committed persona so its traits actually shape the agent prompt (#308); fail-safe to
  // the bare persona id (no traits applied) when no persona file is committed.
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const resolvedPersona = await resolveTerminalPersona(projectRoot, personaId);
  warnings.push(...resolvedPersona.warnings);
  const personaLine = resolvedPersona.persona
    ? renderPersonaPromptSection(resolvedPersona.persona)
    : `persona: ${personaId}`;
  const traitsApplied = resolvedPersona.persona
    ? personaToDirectives(resolvedPersona.persona).traitsApplied
    : [];
  // The composed prompt = mission + persona + public-surface manifest. Only the AUTHOR mission
  // goes plaintext into evidence (it is public-safe committed lab text); the full composed prompt
  // is recorded as a DIGEST (the safety contract's mission ruling).
  const composedPrompt = composePrompt({ mission, personaLine, productName: product.name, publicSurfaces: product.publicSurfaces });
  const promptDigest = digestText(composedPrompt);
  const persona: ActorPersonaRef = { id: personaId, traitsApplied, promptDigest };

  const runId = options.runId ?? makeTerminalRunId();
  const runPaths = await prepareRunArtifactPaths(physicalCwd, runId);
  // Identity + liveness on disk (#455): every backend writes this, so a watcher can classify any
  // run without parsing bundles and without depending on the interactive-observer path.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    mode: dryRun ? "dry-run" : "live",
    ...(options.lab === undefined ? {} : { lab: options.lab })
  });
  const createdAt = new Date().toISOString();
  const source = await buildRunSource({
    capturedAt: createdAt,
    cwd: physicalCwd,
    humanishSource: "present",
    packageName: "humanish"
  });

  const bundle = buildTerminalProductBundle({
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    actorId: descriptor.id,
    createdAt,
    dryRun,
    labId: config.id,
    ...(config.title ? { labTitle: config.title } : {}),
    mission,
    persona,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    ...(config.scenario?.caps ? { caps: config.scenario.caps } : {}),
    ...(config.execution?.runtimeAuth ? { runtimeAuth: config.execution.runtimeAuth } : {}),
    stdin: config.execution?.terminal?.stdin ?? "disabled",
    policies: {
      allowPrivateRepoAccess: config.policies?.allowPrivateRepoAccess ?? false,
      allowProviderCredentials: config.policies?.allowProviderCredentials ?? false,
      allowPaymentCredentials: config.policies?.allowPaymentCredentials ?? false,
      allowGitHubMutation: config.policies?.allowGitHubMutation ?? false
    },
    runId,
    source
  });
  bundle.events.push({
    id: "event-terminal-runtime-declared",
    at: createdAt,
    level: "info",
    type: "terminal-lab.runtime.declared",
    message: redactText(JSON.stringify(declaredRuntimeProvenance({
      ...(config.execution?.runtime?.version === undefined ? {} : { version: config.execution.runtime.version }),
      ...(config.actors[0]?.model === undefined ? {} : { model: config.actors[0].model }),
      ...(config.actors[0]?.reasoningEffort === undefined ? {} : { reasoningEffort: config.actors[0].reasoningEffort })
    })))
  });

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
  await writeContainedOutputFile(runPaths, "review.md", renderTerminalReviewMarkdown(bundle), "utf8");
  await writeContainedOutputFile(runPaths, "events.ndjson", `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  // Keep `verify --run latest` honest: point it at THIS run (mirrors run.ts's RunPointer).
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({
      schema: "humanish.latest-run.v1",
      runId,
      path: runPaths.relativeRunRoot,
      updatedAt: createdAt
    }, null, 2)}\n`,
    "utf8"
  );

  const observer = await render(physicalCwd, runId, { open: options.open === true });
  await validatePreparedRunArtifactPaths(runPaths);
  const ok = observer.ok;

  return {
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptor.id,
    product: product.name,
    dryRun,
    runId,
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: "HUMANISH_TERMINAL_LAB_FAILED" as const,
            message: observer.error?.message ?? "Observer failed for the terminal-product lab run."
          }
        })
  };
}

// ===========================================================================
// LIVE PATH
// ===========================================================================

/** Substrate lifecycle ledger entry (create/readiness/exec/cleanup events with timestamps). */
export interface LifecycleRecord {
  at: string;
  event: string;
  /** Redacted+scrubbed before persisting (it never carries a secret, but the harness never trusts that). */
  message: string;
}

/** Command-log ledger entry: which command ran, with what exit/duration (NEVER its env values). */
export interface CommandLogRecord {
  at: string;
  /** A public-safe label for the command (e.g. "codex-exec"); the full argv is bound by digest only. */
  label: string;
  /** sha256-12 of the exact command string — pins "same recipe" without persisting it. */
  commandDigest: string;
  /** The env var NAMES injected command-scoped (values NEVER persisted) — the credential evidence. */
  envNames: string[];
  exitCode?: number;
  timedOut?: boolean;
  durationMs: number;
}

/** One redacted terminal output event (the append-only NDJSON stream). */
interface TerminalEventRecord {
  at: string;
  stream: "stdout" | "stderr";
  /** ALREADY scrubbed (literal known values) THEN redacted (shape patterns) at the source. */
  chunk: string;
}

/**
 * One operator intervention (assisted-input event). The current route ships NO assisted-input
 * path, so this ledger is ALWAYS empty — but always PRESENT (the safety contract: empty-present is
 * the contract, an absent ledger fails verify). A future assisted path can fill this shape.
 */
export interface InterventionRecord {
  at: string;
  kind: "stdin";
  /** Redacted+scrubbed digest of the injected input (never the raw bytes). */
  inputDigest: string;
}

/**
 * One cost line of the spend ledger. THE NULL DISCIPLINE (issue #154, the cost/no-spend asks):
 * three distinct states are crisply modeled and NEVER conflated —
 *   - `usd: 0`     => KNOWN to be zero. A measured-and-zero spend (we metered this category and it
 *                     billed nothing). The no-spend proof may legitimately assert this is zero.
 *   - `usd: null`  => NOT MEASURED. This run carries no spend signal for the category. `null` is
 *                     written explicitly (never undefined-omitted, never guessed to 0). The no-spend
 *                     proof must list this line as UNMEASURED and must NOT claim it is zero.
 *   - line ABSENT  => NOT APPLICABLE to this lane/run (n/a). The line simply does not appear in
 *                     `lines`. (The current route emits all four lines, so absence is reserved for
 *                     future lanes that genuinely have no such category.)
 * `null` vs missing-key is the load-bearing distinction: a missing key means "this category does not
 * exist for this run"; a present key with `null` means "this category exists but we did not measure
 * it". A no-spend proof that claimed zero on a `null` line would claim more than it measured.
 */
export interface CostLine {
  /** known zero (0) | not measured (null). The key is ALWAYS present when the line is applicable. */
  usd: number | null;
  /** Optional billable-unit count, same discipline: a known count, or null = not measured. */
  count?: number | null;
  /** How this line's value was established (provenance for the verifier + the human reviewer). */
  source:
    | "provider-token-usage"
    | "no-spend-signal"
    | "operator-cap"
    | "unmeasured"
    /** Tokens were COUNTED but no rate could price them, so `usd` stays null while the note
     *  carries the measured token totals (#531). Distinct from "unmeasured", which means no
     *  signal at all. */
    | "unpriced-token-usage";
  /** A short, public-safe note (never a secret value). */
  note: string;
}

/** The cost categories the lane meters. product/media/payment are adapter signals; core can
 *  populate the provider line from the actor trace's tokenUsage.costUsd when present. */
export type CostCategory = "product" | "media" | "payment" | "provider";

/**
 * The spend ledger (a block of `TerminalLedgers`). The no-spend PROOF is DERIVED from this — never
 * asserted independently. Every applicable category appears as a line; unknowns are `null`.
 */
export interface TerminalCostLedger {
  schema: "humanish.terminal-cost-ledger.v1";
  /** USD currency unit (recorded explicitly so a future multi-currency lane is unambiguous). */
  currency: "usd";
  lines: Record<CostCategory, CostLine>;
  /** Sum of the KNOWN (non-null) lines. null lines contribute NOTHING and are NOT guessed as 0. */
  knownTotalUsd: number;
  /** True when every applicable line is measured (no null). When false, knownTotalUsd is a LOWER
   *  bound, not the full spend — the no-spend proof says so honestly. */
  fullyMeasured: boolean;
}

/**
 * The no-spend proof, DERIVED from the cost ledger (issue #154: "derived from a ledger, not
 * asserted"). It is honest about what it knows: it lists the KNOWN-zero lines it can vouch for and,
 * separately, the UNMEASURED (null) lines it CANNOT vouch for. `satisfied` is true only when every
 * KNOWN line is zero (a known non-zero line fails it); but a proof with unmeasured lines explicitly
 * says it could not measure them — it never claims zero on a line the ledger marks null.
 */
export interface NoSpendProof {
  schema: "humanish.terminal-no-spend-proof.v1";
  /** The maxUsd cap this proof was evaluated against (the no-spend scenario declares maxUsd: 0). */
  maxUsd: number | null;
  /** True iff every KNOWN (measured) line is <= maxUsd (for a no-spend run, == 0). */
  satisfied: boolean;
  /** Categories the ledger MEASURED and found at (known) zero — the proof CAN vouch for these. */
  knownZeroLines: CostCategory[];
  /** Categories the ledger measured with a known NON-zero spend (these break `satisfied`). */
  knownNonZeroLines: CostCategory[];
  /** Categories the ledger marks `null` (NOT MEASURED). The proof explicitly lists these and does
   *  NOT claim they are zero — it claims only that this run could not measure them. */
  unmeasuredLines: CostCategory[];
  /** Sum of the known lines (== 0 for a satisfied no-spend run). */
  knownTotalUsd: number;
  /** Human-readable honesty statement covering both what is proven and what is unmeasured. */
  statement: string;
}

/** The persisted terminal-product ledgers artifact (substrate lifecycle + command log + interventions + cleanup + cost). */
export interface TerminalLedgers {
  schema: "humanish.terminal-ledgers.v1";
  runtime?: ActorRuntimeProvenance;
  lifecycle: LifecycleRecord[];
  commandLog: CommandLogRecord[];
  /** ALWAYS present; ALWAYS empty while no assisted-input path ships — the safety contract. */
  interventions: InterventionRecord[];
  cleanup: {
    /** True when exact-id kill resolved, including the startup guard's acquired-instance kill
     *  (found-and-killed or already gone both prove absence; see `remaining`/`reason`). */
    killed: boolean;
    /** BY-ID proof, NEVER derived from Sandbox.list: 0 = confirmed reclaimed (kill(id) RESOLVED
     *  -- returned true "found and killed" OR false "404, exact id already gone" -- and, when the
     *  SDK exposes it, getInfo(id) did not report a live sandbox); 1 = getInfo(id) still reports
     *  this exact sandbox running/paused (NOT reclaimed); -1 = kill(id) itself failed, threw, or
     *  was unavailable (the server-side kill-on-timeout is the backstop). */
    remaining: number;
    /** Honest, human-readable statement of which by-id signal produced `remaining`. */
    reason: string;
  };
  /** The spend ledger. Unknowns are `null`, never guessed; the no-spend proof
   *  below is DERIVED from it. */
  cost: TerminalCostLedger;
  /** The no-spend proof DERIVED from `cost`. Never an independent assertion. */
  noSpendProof: NoSpendProof;
}

/** The four cost categories, in a fixed order so the ledger shape is stable across runs. */
const COST_CATEGORIES: readonly CostCategory[] = ["product", "media", "payment", "provider"] as const;

/**
 * Build the spend ledger from the captured session. THE NULL DISCIPLINE (issue #154):
 *   - The `provider` line is populated from the actor trace's tokenUsage.costUsd when the trace
 *     CARRIES it (a measured value, incl. a measured 0). When the trace carries NO costUsd, the
 *     provider line is `null` = NOT MEASURED (never guessed to 0 just because no-spend was intended).
 *   - product/media/payment are `null` by default: core has no signal for those categories; an
 *     adapter may provide one through the shipped costProbe seam.
 * `injectedLines` lets a test or adapter supply known spend for a category,
 * exercising the fail-closed cap enforcement deterministically without a real billable run.
 */
function buildCostLedger(args: {
  tokenCostUsd?: number;
  /** Measured token counts, when the run produced them but no rate could price them (#531). */
  tokenUsage?: ActorTokenUsage;
  injectedLines?: Partial<Record<CostCategory, CostLine>>;
}): TerminalCostLedger {
  const providerLine: CostLine =
    typeof args.tokenCostUsd === "number"
      ? {
          usd: args.tokenCostUsd,
          source: "provider-token-usage",
          note: `Provider spend metered from the actor trace tokenUsage.costUsd (${args.tokenCostUsd} USD).`
        }
      : args.tokenUsage
      ? {
          // Tokens counted, no rate to price them. This stays `usd: null` because a guessed
          // dollar figure would be worse than none, but the note carries the measured fact so a
          // reader never mistakes "no charge recorded" for "nothing was consumed" (#531).
          usd: null,
          source: "unpriced-token-usage",
          note:
            `Provider spend UNPRICED: the run consumed ${describeTokenUsage(args.tokenUsage)}, `
            + "but the terminal lane records the model as `codex` and src/pricing.ts carries no "
            + "rate for it, so no dollar figure is claimed. Tokens are a MEASURED fact here; the "
            + "price is the unknown. Recorded null (never guessed to 0)."
        }
      : {
          usd: null,
          source: "unmeasured",
          note: "Provider spend NOT MEASURED: the actor trace carried no tokenUsage.costUsd this run. Recorded null (not guessed to 0)."
        };

  const unmeasured = (category: CostCategory): CostLine => ({
    usd: null,
    count: null,
    source: "unmeasured",
    note: `${category} spend NOT MEASURED: core has no ${category}-spend signal for this run; an adapter may supply one through costProbe. Recorded null (never guessed to 0).`
  });

  const lines: Record<CostCategory, CostLine> = {
    product: args.injectedLines?.product ?? unmeasured("product"),
    media: args.injectedLines?.media ?? unmeasured("media"),
    payment: args.injectedLines?.payment ?? unmeasured("payment"),
    provider: args.injectedLines?.provider ?? providerLine
  };

  // knownTotalUsd sums ONLY the non-null lines. A null line contributes NOTHING — it is never
  // coerced to 0 (that would let an unmeasured category masquerade as a measured zero).
  let knownTotalUsd = 0;
  let fullyMeasured = true;
  for (const category of COST_CATEGORIES) {
    const usd = lines[category].usd;
    if (usd === null) {
      fullyMeasured = false;
    } else {
      knownTotalUsd += usd;
    }
  }
  return {
    schema: "humanish.terminal-cost-ledger.v1",
    currency: "usd",
    lines,
    knownTotalUsd: roundUsd(knownTotalUsd),
    fullyMeasured
  };
}

/** Derive the no-spend proof from the ledger. It is HONEST: it vouches for known-zero lines and
 *  explicitly lists the unmeasured (null) lines it cannot vouch for — never claiming zero on null. */
function buildNoSpendProof(ledger: TerminalCostLedger, maxUsd: number | null): NoSpendProof {
  const knownZeroLines: CostCategory[] = [];
  const knownNonZeroLines: CostCategory[] = [];
  const unmeasuredLines: CostCategory[] = [];
  for (const category of COST_CATEGORIES) {
    const usd = ledger.lines[category].usd;
    if (usd === null) unmeasuredLines.push(category);
    else if (usd === 0) knownZeroLines.push(category);
    else knownNonZeroLines.push(category);
  }
  // satisfied only when every KNOWN line is within the cap (for a no-spend run, maxUsd 0 => every
  // known line must be exactly 0). Unmeasured lines do NOT make it satisfied — they are reported
  // separately as the proof's honest blind spot.
  const cap = maxUsd ?? 0;
  const satisfied = knownNonZeroLines.length === 0 && ledger.knownTotalUsd <= cap;
  const statement = [
    satisfied
      ? `No-spend proof SATISFIED for maxUsd=${cap}: every MEASURED spend line is zero (known total ${ledger.knownTotalUsd} USD).`
      : `No-spend proof NOT satisfied for maxUsd=${cap}: known spend total ${ledger.knownTotalUsd} USD${knownNonZeroLines.length > 0 ? ` (non-zero: ${knownNonZeroLines.join(", ")})` : ""}.`,
    // When tokens were counted but not priced, say so IN THE STATEMENT. A reader who sees
    // "SATISFIED for maxUsd=0" must not walk away thinking nothing was consumed (#531).
    ledger.lines.provider.source === "unpriced-token-usage"
      ? `Provider tokens WERE consumed on this run and are counted in the ledger; they are unpriced, not zero.`
      : "",
    unmeasuredLines.length > 0
      ? `UNPRICED (null, NOT claimed zero): ${unmeasuredLines.join(", ")}. The proof does not vouch for these. `
        + (ledger.lines.provider.source === "unpriced-token-usage"
            // provider has a signal here (a token count), it just has no rate. Saying it "carries
            // no spend signal" one sentence after reporting its token total would contradict the
            // line above it.
            ? "Of these, provider has a measured token count but no rate; the rest carry no spend signal for this run."
            : "They carry no spend signal for this run.")
      : "All applicable spend lines were measured."
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return {
    schema: "humanish.terminal-no-spend-proof.v1",
    maxUsd,
    satisfied,
    knownZeroLines,
    knownNonZeroLines,
    unmeasuredLines,
    knownTotalUsd: ledger.knownTotalUsd,
    statement
  };
}

/**
 * Full caps enforcement (fail-closed, not advisory). Returns a structured violation when a KNOWN
 * (measured) spend line exceeds maxUsd, or a known billable-job count exceeds maxJobs. Unknowns
 * (`null`) NEVER trip the cap (we cannot claim a violation we did not measure) — but they also never
 * grant a green pass: the no-spend proof reports them as unmeasured. maxMinutes is wall-clock and is
 * enforced separately (runWithWallClock); it is not a ledger-derived cap.
 */
function evaluateCapsAgainstLedger(
  ledger: TerminalCostLedger,
  caps: LabScenarioCaps
): { ok: true } | { ok: false; message: string } {
  if (caps.maxUsd !== undefined && ledger.knownTotalUsd > caps.maxUsd) {
    const overLines = COST_CATEGORIES.filter((c) => ledger.lines[c].usd !== null && (ledger.lines[c].usd as number) > 0);
    return {
      ok: false,
      message: `Observed KNOWN spend ${ledger.knownTotalUsd} USD exceeds scenario.caps.maxUsd=${caps.maxUsd}${overLines.length > 0 ? ` (non-zero lines: ${overLines.join(", ")})` : ""}. The run fails closed: the cap is a fail-closed mechanism, not an advisory.`
    };
  }
  if (caps.maxJobs !== undefined) {
    let knownJobs = 0;
    for (const category of COST_CATEGORIES) {
      const count = ledger.lines[category].count;
      if (typeof count === "number") knownJobs += count;
    }
    if (knownJobs > caps.maxJobs) {
      return {
        ok: false,
        message: `Observed KNOWN billable-job count ${knownJobs} exceeds scenario.caps.maxJobs=${caps.maxJobs}. The run fails closed.`
      };
    }
  }
  return { ok: true };
}

/** Round a USD sum to 6 decimals so a float-accumulated total never carries spurious precision. */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Resolve the runtime key on the host. Legacy openai-env passes it command-scoped; openai-egress
 * returns an inert command env while retaining the actual value for the external transform and
 * literal redaction. Only CODEX_API_KEY/OPENAI_API_KEY are accepted as sources. No other operator
 * credential is forwarded. The real value must never be logged or persisted in either mode.
 */
function buildRuntimeAuth(args: {
  /** Undefined retains the historical openai-env default. */
  runtimeAuth: LabRuntimeAuth | undefined;
  /** The operator environment the key value is read from (process.env or a test fake). */
  env: Record<string, string | undefined>;
}):
  | { ok: true; mode: LabRuntimeAuth; envs: Record<string, string>; keyName: string; keyValue: string }
  | { ok: false; code: "HUMANISH_TERMINAL_LAB_RUNTIME_AUTH_MISSING" | "HUMANISH_TERMINAL_LAB_CREDENTIAL_DENIED"; message: string } {
  // The "openai-env" channel accepts CODEX_API_KEY or OPENAI_API_KEY as the runtime key SOURCE
  // name, read in this preference order. CODEX_API_KEY is preferred: the official Codex docs
  // (developers.openai.com/codex/noninteractive) document it as the channel for a SINGLE codex exec
  // invocation, which is exactly this lane's shape (no persisted auth.json/CODEX_HOME, per-command
  // envs only). A dated in-repo receipt
  // (docs/goals/humanish-recursive-proof-critical-point/receipts/actor-required-attempt.md) shows a
  // job-wide OPENAI_API_KEY alone failing bearer auth for this same pinned-exec pattern. When the
  // operator only exported OPENAI_API_KEY, its value is ALSO injected under CODEX_API_KEY below, so
  // the documented exec auth channel is always populated regardless of which name the operator
  // used. The ALLOWLIST is exactly these two names; everything else is denied by construction.
  const ALLOWED_RUNTIME_KEY_NAMES = ["CODEX_API_KEY", "OPENAI_API_KEY"] as const;
  // Tripwire (safety contract item 4): if a FUTURE widening of ALLOWED_RUNTIME_KEY_NAMES ever
  // added a clearly-non-runtime credential (a GitHub/payment/deploy/db secret), fail closed. The
  // generic `*_KEY` shape is deliberately NOT a tripwire here, since a runtime key legitimately
  // ends in _KEY (CODEX_API_KEY/OPENAI_API_KEY), so testing it against the generic shape would
  // false-positive on the very key this lane exists to inject. The positive allowlist itself is
  // the real boundary: the command env is built from exactly these names and nothing else (so
  // GITHUB_TOKEN/payment/db keys present in the operator env are never forwarded, proven by the
  // deterministic test).
  if (ALLOWED_RUNTIME_KEY_NAMES.some((name) => isNonRuntimeCredentialName(name))) {
    return {
      ok: false,
      code: "HUMANISH_TERMINAL_LAB_CREDENTIAL_DENIED",
      message: "Internal invariant violated: a runtime-key allowlist entry is a non-runtime credential (GitHub/payment/deploy/db)."
    };
  }
  const keyName = ALLOWED_RUNTIME_KEY_NAMES.find((name) => (args.env[name]?.trim() ?? "").length > 0);
  if (!keyName) {
    return {
      ok: false,
      code: "HUMANISH_TERMINAL_LAB_RUNTIME_AUTH_MISSING",
      message: `Live terminal-product labs declare runtimeAuth "${String(args.runtimeAuth)}" and need ${ALLOWED_RUNTIME_KEY_NAMES.join(" or ")} in the environment (pass via --env-file; the selected auth mode places the value in command-scoped env or an external E2B header transform; the value is never persisted).`
    };
  }
  const keyValue = args.env[keyName] as string;
  // The command-scoped env is the ALLOWLIST: exactly the runtime key name(s), nothing else. No
  // GITHUB_TOKEN/GH_TOKEN, no payment/deploy/db/media key, excluded by construction. When the
  // SOURCE was OPENAI_API_KEY, the SAME value is also injected as CODEX_API_KEY so codex exec's
  // documented single-invocation auth channel is populated either way (see the comment above).
  const mode = args.runtimeAuth ?? "openai-env";
  const envs: Record<string, string> = mode === "openai-egress"
    // Codex documents this verified-TLS trust channel. The stock image's default OpenSSL CA
    // file can be absent even though E2B has installed its proxy CA in the system bundle.
    ? { CODEX_API_KEY: OPENAI_EGRESS_PLACEHOLDER, CODEX_CA_CERTIFICATE: E2B_SYSTEM_CA_BUNDLE }
    : keyName === "OPENAI_API_KEY" ? { CODEX_API_KEY: keyValue, OPENAI_API_KEY: keyValue } : { [keyName]: keyValue };
  return {
    ok: true,
    mode,
    envs,
    keyName,
    keyValue
  };
}

// Clearly-non-runtime credential NAME shapes. Used as the runtime-key allowlist tripwire (a
// runtime key must never be one of these). Deliberately EXCLUDES the generic `*_KEY` shape: the
// runtime key this lane injects (CODEX_API_KEY/OPENAI_API_KEY) legitimately ends in _KEY, so the
// generic shape would false-positive on it. The positive allowlist, not a denylist, is what
// keeps every OTHER operator-env credential (GitHub/payment/deploy/db/media keys) out of the
// sandbox: the command env is built from exactly the allowlisted runtime key and nothing else.
const NON_RUNTIME_CREDENTIAL_NAME_PATTERNS: RegExp[] = [
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /TOKEN$/i,        // deploy tokens, write tokens
  /SECRET/i,        // *_SECRET, payment secrets
  /PASSWORD/i,
  /DATABASE_URL/i,
  /(^|_)DSN$/i,
  /STRIPE/i,
  /AWS_/i
];

/** True when `name` is a clearly-non-runtime credential (cannot be a runtime-key allowlist entry). */
function isNonRuntimeCredentialName(name: string): boolean {
  return NON_RUNTIME_CREDENTIAL_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Build the sandbox metadata from a POSITIVE ALLOWLIST (safety contract item 6). This is the ONLY
 * way metadata is set on the terminal lane — it carries solely non-secret labels and rejects any
 * value that is not a plain short label. A verifier check asserts the persisted metadata has no
 * prompt/token/secret shapes; this builder makes that true by construction.
 */
export function buildSandboxMetadata(allowlist: {
  labId: string;
  simId: string;
  runId: string;
}): Record<string, string> {
  return {
    mode: TERMINAL_PRODUCT_LAB_PROVIDER_METADATA.mode,
    tool: TERMINAL_PRODUCT_LAB_PROVIDER_METADATA.tool,
    provider: "codex",
    labId: allowlist.labId,
    simId: allowlist.simId,
    // The run id is a harness-minted token (terminal-<ts>-<hex>), not user data.
    runId: allowlist.runId
  };
}

interface RunLiveTerminalSessionArgs {
  options: RunTerminalProductLabOptions;
  cwd: string;
  config: LabConfig;
  descriptorId: string;
  product: NonNullable<LabConfig["subject"]["product"]>;
  warnings: string[];
  render: typeof renderObserver;
  failed: (
    code: NonNullable<TerminalProductLabResult["error"]>["code"],
    message: string,
    extras?: { actor?: string; product?: string }
  ) => TerminalProductLabResult;
}

/**
 * The live in-sandbox agent session orchestrator (mirror of runCuaActorLab's E2B branch). Enforces
 * the 8-point safety contract by construction; fails closed before any sandbox/key/spend on any
 * precondition miss. Persists the substrate-lifecycle/command-log/interventions/cleanup ledgers,
 * the redacted terminal event stream + normalized transcript, the agent report, and the
 * provider-neutral actor trace; tears the sandbox down in a finally and proves the teardown.
 */
async function runLiveTerminalSession(args: RunLiveTerminalSessionArgs): Promise<TerminalProductLabResult> {
  const { options, cwd, config, descriptorId, product, warnings, render, failed } = args;
  const hooks = options.hooks ?? {};
  const env = hooks.env ?? process.env;
  const now = hooks.now ?? (() => Date.now());
  const nowIso = (): string => new Date(now()).toISOString();

  // Check the registered terminal actor's default placement contract before launching. The
  // explicit openai-egress mode overrides the resolved trace's placement to external; registry
  // metadata continues to describe the compatible openai-env default.
  const descriptor = actorRegistry[descriptorId as keyof typeof actorRegistry];
  const keyPlacement = descriptor?.capabilities.keyPlacement;
  if (keyPlacement !== "in-sandbox-command-scoped") {
    return failed(
      "HUMANISH_TERMINAL_LAB_KEYPLACEMENT_INVALID",
      `Terminal actor "${descriptorId}" must declare keyPlacement "in-sandbox-command-scoped" for the live lane (got "${String(keyPlacement)}"). The engine requires this registered default before applying the declared runtime-auth mode.`,
      { actor: descriptorId }
    );
  }

  // --- Safety contract item 2: a fail-closed cap MUST be in force before the live key runs. ---
  const caps = config.scenario?.caps;
  const maxUsd = caps?.maxUsd;
  const maxMinutes = caps?.maxMinutes;
  if (caps === undefined || maxUsd === undefined || maxMinutes === undefined || maxMinutes <= 0) {
    return failed(
      "HUMANISH_TERMINAL_LAB_CAPS_MISSING",
      "A live terminal-product run grants provider access to the in-sandbox agent and so REQUIRES a fail-closed cap: scenario.caps with maxUsd (0 = no-spend) and a positive maxMinutes (the codex command's wall-clock kill). The live key is never exercised without a cap in force.",
      { actor: descriptorId }
    );
  }
  // maxUsd is ENFORCED fail-closed against the cost ledger (evaluateCapsAgainstLedger after the
  // session), not advisory. A positive maxUsd is permitted, but core still has no
  // PRODUCT-spend signal (product/media/payment lines are null = unmeasured; only the provider line
  // is measurable, from tokenUsage). So a positive budget is honestly bounded by what is MEASURED:
  // the known total (provider, when present) must stay <= maxUsd, and the no-spend proof reports the
  // unmeasured lines rather than guessing them zero. Warn so the operator knows a positive budget is
  // only as strong as the (currently provider-only) spend signal.
  if (maxUsd > 0) {
    warnings.push(`scenario.caps.maxUsd=${maxUsd} declares a non-zero spend budget. maxUsd is enforced fail-closed against the cost ledger, but core meters only the provider line from tokenUsage; product/media/payment stay null (UNMEASURED, never guessed zero) unless an adapter supplies those signals through costProbe. The no-spend proof reports unmeasured lines honestly.`);
  }

  // --- Safety contract item 4: deny-by-default credentials; build the command-scoped allowlist. ---
  const runtimeEnv = buildRuntimeAuth({ runtimeAuth: config.execution?.runtimeAuth, env });
  if (!runtimeEnv.ok) {
    return failed(runtimeEnv.code, runtimeEnv.message, { actor: descriptorId });
  }

  // Compose the prompt from PUBLIC surfaces + the author mission ONLY (safety contract item 3).
  // Inject a per-run verdict nonce: the agent echoes HUMANISH_ACTOR_VERDICT=<status>
  // HUMANISH_ACTOR_NONCE=<nonce>; the scorer verifies the nonce so replayed text cannot forge it.
  const mission = config.actors[0]?.mission ?? defaultMission(product.name);
  const personaId = config.actors[0]?.persona ?? "autonomous-terminal-agent";
  const physicalCwd = await realpath(cwd);
  // Resolve the committed persona so its traits actually shape the agent prompt (#308); fail-safe to
  // the bare persona id (no traits applied) when no persona file is committed.
  const projectRoot = await prepareSelectedOutputDirectory(path.dirname(physicalCwd), physicalCwd);
  const resolvedPersona = await resolveTerminalPersona(projectRoot, personaId);
  warnings.push(...resolvedPersona.warnings);
  const personaLine = resolvedPersona.persona
    ? renderPersonaPromptSection(resolvedPersona.persona)
    : `persona: ${personaId}`;
  const traitsApplied = resolvedPersona.persona
    ? personaToDirectives(resolvedPersona.persona).traitsApplied
    : [];
  const verdictNonce = randomUUID().slice(0, 12);
  const composedPrompt = composeLivePrompt({
    mission,
    personaLine,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    verdictNonce
  });
  const promptDigest = digestText(composedPrompt);
  const persona: ActorPersonaRef = { id: personaId, traitsApplied, promptDigest };

  // --- Safety contract item 5: literal-scrub EVERY known value, then pattern-redact, at the source. ---
  // The runtime key value (+ any other provisioned value) is scrubbed by LITERAL match before
  // anything persists (a key has no detectable "shape" if it is an arbitrary token); redactText is
  // the second pass for secret-SHAPED content. Applied PRE-truncation so a cut can never split a
  // value past the scrubber.
  const knownSecretValues = [runtimeEnv.keyValue, env.E2B_API_KEY?.trim() ?? ""].filter((v) => v.length >= 4);
  const scrubKnownValues = (text: string): string =>
    knownSecretValues.reduce((current, value) => current.split(value).join("[REDACTED_SECRET]"), text);
  const sanitize = (text: string): string => redactText(scrubKnownValues(text));

  const runId = options.runId ?? makeTerminalRunId();
  const runPaths = await prepareRunArtifactPaths(physicalCwd, runId);
  // Identity + liveness on disk (#455): every backend writes this, so a watcher can classify any
  // run without parsing bundles and without depending on the interactive-observer path.
  const runStatus: RunStatusHandle = beginRunStatus(runPaths, {
    runId,
    // This entry point IS the live terminal route; its dry-run sibling is a separate function.
    mode: "live",
    ...(options.lab === undefined ? {} : { lab: options.lab })
  });
  const createdAt = nowIso();
  const source = await buildRunSource({ capturedAt: createdAt, cwd: physicalCwd, humanishSource: "present", packageName: "humanish" });

  const e2bApiKey = env.E2B_API_KEY?.trim() ?? "";
  // Declared egress allowlist, or undefined for the historical unrestricted default (#538).
  const egressAllow = config.execution?.egressAllow;

  // The ledgers + capture buffers, mutated through the live lifecycle.
  const lifecycle: LifecycleRecord[] = [];
  const commandLog: CommandLogRecord[] = [];
  const terminalEvents: TerminalEventRecord[] = [];
  // Capture may stop inside a known key. Keep only enough following characters to finish the
  // cross-chunk redaction below; this overlap is never added to terminal events/artifacts.
  const discardedPrefixes = { stdout: "", stderr: "", combined: "" };
  const maxDiscardedPrefixChars = Math.max(0, ...knownSecretValues.map((value) => value.length - 1));
  const interventions: InterventionRecord[] = []; // ALWAYS empty while no assisted-input path ships.
  let transcriptBytes = 0;
  let cleanup: TerminalLedgers["cleanup"] = { killed: false, remaining: -1, reason: "teardown not reached" };

  const recordLifecycle = (event: string, message: string): void => {
    lifecycle.push({ at: nowIso(), event, message: sanitize(message) });
  };
  const appendTerminalChunk = (stream: "stdout" | "stderr", raw: string): void => {
    if (transcriptBytes >= MAX_TRANSCRIPT_BYTES) {
      for (const order of [stream, "combined"] as const) {
        const remaining = maxDiscardedPrefixChars - discardedPrefixes[order].length;
        if (remaining > 0) discardedPrefixes[order] += raw.slice(0, remaining);
      }
      return;
    }
    transcriptBytes += Buffer.byteLength(raw, "utf8");
    // Scrub THEN redact at the SOURCE — raw bytes never leave this function (safety contract item 5).
    terminalEvents.push({ at: nowIso(), stream, chunk: sanitize(raw) });
  };

  // E2B can stream every byte through callbacks AND return the same complete output (#667).
  // Track transport delivery, independently per stream, rather than deduplicating participant
  // lines or equal usage records. Hash raw callback bytes before redaction/truncation so the
  // comparison cannot confuse two values that redact identically or lose capped-away delivery.
  // Delivery tracking retains only counts and hashes; payloads still pass the artifact sanitizer.
  const streamedOutput = {
    stdout: { bytes: 0, hash: createHash("sha256") },
    stderr: { bytes: 0, hash: createHash("sha256") }
  };
  const recordStreamedTerminalChunk = (stream: "stdout" | "stderr", raw: string): void => {
    streamedOutput[stream].bytes += Buffer.byteLength(raw, "utf8");
    streamedOutput[stream].hash.update(raw, "utf8");
    appendTerminalChunk(stream, raw);
  };
  const appendReturnedTerminalOutput = (stream: "stdout" | "stderr", raw: string): void => {
    const delivered = streamedOutput[stream];
    const returned = Buffer.from(raw, "utf8");
    if (delivered.bytes > 0 && returned.length >= delivered.bytes) {
      const returnedPrefixHash = createHash("sha256").update(returned.subarray(0, delivered.bytes)).digest("hex");
      if (returnedPrefixHash === delivered.hash.copy().digest("hex")) {
        // A complete replay adds nothing; a partly streamed prefix keeps only the unseen tail.
        const suffix = returned.subarray(delivered.bytes).toString("utf8");
        if (suffix) appendTerminalChunk(stream, suffix);
        return;
      }
    }
    // Older/final-only SDK delivery, or output that does not match the streamed prefix: keep it.
    // Guessing at overlap here could erase legitimate repeated participant text.
    appendTerminalChunk(stream, raw);
  };

  let sandbox: E2BDesktopSandbox | undefined;
  let sandboxModule: E2BDesktopModule | undefined;
  let sandboxId: string | undefined;
  let sessionStatus: ActorStatus = "failed";
  let completionReason: ActorCompletionReason = "harness_error";
  let sessionReason = "live terminal-product session did not start";
  let sessionError: string | undefined;
  let startupCleanup: E2BDesktopStartupError["cleanup"] | undefined;
  let timedOut = false;
  const runtime = declaredRuntimeProvenance({
    ...(config.execution?.runtime?.version === undefined ? {} : { version: config.execution.runtime.version }),
    ...(config.actors[0]?.model === undefined ? {} : { model: sanitize(config.actors[0].model) }),
    ...(config.actors[0]?.reasoningEffort === undefined ? {} : { reasoningEffort: config.actors[0].reasoningEffort })
  });

  recordLifecycle("terminal-lab.run.created", `Created live terminal-product run ${runId} (actor ${descriptorId}, product ${product.name}). Caps: maxUsd=${maxUsd}, maxMinutes=${maxMinutes}. Subject provenance UNPINNED (public surfaces only).`);

  const requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const wallClockMs = maxMinutes * 60_000;
  const sandboxTimeoutMs = wallClockMs + SANDBOX_TIMEOUT_BUFFER_MS;
  const metadata = buildSandboxMetadata({ labId: config.id, simId: "sim-001", runId });

  try {
    sandboxModule = await (hooks.loadModule ?? loadE2BDesktopModule)();
    await validatePreparedRunArtifactPaths(runPaths);
    // No sandbox-global env in either mode. In openai-egress, only this host-side SDK request
    // carries the real runtime key; participant commands receive an inert placeholder. The proxy
    // capability is available from sandbox creation, including during bootstrap/product setup.
    const routing = egressAllow === undefined ? undefined : { allowOut: egressAllow, denyOut: ["0.0.0.0/0"] };
    const network = runtimeEnv.mode === "openai-egress"
      ? buildOpenAiEgressNetwork(runtimeEnv.keyValue, routing)
      : routing;
    sandbox = await sandboxModule.Sandbox.create({
      apiKey: e2bApiKey,
      requestTimeoutMs,
      timeoutMs: sandboxTimeoutMs,
      metadata,
      ...(network === undefined ? {} : { network }),
      lifecycle: { onTimeout: "kill" }
    });
    await validatePreparedRunArtifactPaths(runPaths);
    sandboxId = sandbox.sandboxId;
    // #358 salvage: durable id receipt the moment the sandbox exists (reclaim by exact id).
    await appendSandboxReceipt(runPaths, { at: nowIso(), laneId: "terminal", sandboxId, timeoutMs: sandboxTimeoutMs });
    recordLifecycle("terminal-lab.sandbox.created", `E2B shell sandbox ${sandboxId} created with positive-allowlist metadata and kill-on-timeout; NO sandbox-global env.`);
    // The allowlist is evidence: a reader of the ledger can see exactly what the participant was
    // able to reach, without the ledger carrying any secret.
    recordLifecycle(
      "terminal-lab.egress.policy",
      egressAllow === undefined
        ? "Egress UNRESTRICTED (no execution.egressAllow declared)."
        : `Egress routing allowlist: ${egressAllow.length} declared host(s): ${egressAllow.join(", ")}; deny-all fallback. Domain routing is not strict destination isolation on shared infrastructure.`
    );

    recordLifecycle("terminal-lab.runtime-auth", runtimeEnv.mode === "openai-egress"
      ? "Runtime auth openai-egress: raw key remains outside the sandbox in the api.openai.com HTTPS Authorization transform; Codex receives an inert CODEX_API_KEY placeholder and the default OpenAI endpoint. Every sandbox process, including bootstrap/setup, can spend via this proxy; no added routing restriction or provider spending limit."
      : `Runtime auth openai-env: raw key from ${runtimeEnv.keyName} is passed command-scoped to Codex and inherited by its child processes.`);
    if (runtimeEnv.mode === "openai-egress") {
      warnings.push("openai-egress keeps the raw runtime key outside the sandbox, but every sandbox process can spend through the api.openai.com proxy from creation until teardown. It adds no egress restriction or provider-enforced budget; extra provider calls may be absent from the Codex usage ledger.");
    }

    // Readiness: a tiny probe receives no runtime env; openai-egress's proxy is already available.
    const ready = await sandbox.commands.run(`mkdir -p ${SANDBOX_WORKDIR} && echo HUMANISH_SHELL_READY`, { requestTimeoutMs });
    recordLifecycle("terminal-lab.sandbox.ready", `Shell readiness probe exit=${ready.exitCode ?? "null"}; workdir ${SANDBOX_WORKDIR} prepared.`);

    // --- Runtime bootstrap: no runtime env; openai-egress proxy capability is already available. ---
    // The stock desktop needs Node/npm on PATH before npx can run Codex. Reuse a working
    // installation or install the pinned official binary after checksum verification (#674).
    // No raw runtime key touches this step; the egress proxy, when selected, is already available.
    const bootstrapStartedAt = now();
    let bootstrapError: string | undefined;
    try {
      const bootstrap = await sandbox.commands.run(TERMINAL_NODE_BOOTSTRAP_COMMAND, {
        requestTimeoutMs,
        timeoutMs: RUNTIME_BOOTSTRAP_TIMEOUT_MS
      });
      if ((bootstrap.exitCode ?? 1) !== 0) {
        bootstrapError = `runtime bootstrap exited ${bootstrap.exitCode ?? "null"}`;
      }
    } catch (error) {
      bootstrapError = toErrorMessage(error);
    }
    const bootstrapDurationMs = Math.max(0, now() - bootstrapStartedAt);
    recordLifecycle(
      "terminal-lab.runtime.bootstrapped",
      bootstrapError
        ? `Runtime bootstrap FAILED after ${bootstrapDurationMs}ms: ${bootstrapError}. codex exec runs via npx and needs Node/npm present; the lane fails closed rather than attempting an exec with no runtime.`
        : `Runtime bootstrap ensured Node/npm present in ${bootstrapDurationMs}ms (codex exec runs via npx).`
    );

    if (bootstrapError) {
      // Fail closed as a structured lane status (never a raw throw): no codex exec is attempted
      // without a proven runtime; this mirrors the exec-error status assignment below so the
      // bundle and verify surface the failure the same way.
      sessionStatus = "failed";
      completionReason = "harness_error";
      sessionError = sanitize(bootstrapError);
      sessionReason = `runtime bootstrap could not ensure Node/npm before codex exec: ${sessionError}`;
    } else if (await (async (): Promise<boolean> => {
      // Observe the executable without command-scoped auth, then use only that exact version.
      // The SDK bounds the request and command; version failures reach the owned cleanup path.
      try {
        const versionProbe = await sandbox.commands.run(buildRuntimeVersionCommand(config.execution?.runtime?.version), {
          requestTimeoutMs,
          timeoutMs: TERMINAL_RUNTIME_VERSION_TIMEOUT_MS
        });
        const observed = parseTerminalRuntimeVersion(versionProbe.stdout ?? "");
        if (observed !== undefined) runtime.observedVersion = observed;
        if (versionProbe.exitCode !== 0 || observed === undefined) throw new Error("Codex version probe did not return a successful `codex-cli <exact-version>` result.");
        if (config.execution?.runtime?.version !== undefined && observed !== config.execution.runtime.version) {
          throw new Error(`Codex version mismatch: requested ${config.execution.runtime.version}, observed ${observed}.`);
        }
        runtime.versionStatus = "verified";
        recordLifecycle("terminal-lab.runtime.version", `Codex requested ${runtime.requestedVersion}, observed ${observed}; exact version selected for execution. Model ${runtime.requestedModel ?? "runtime default (unobserved)"}; reasoning effort ${runtime.requestedReasoningEffort ?? "runtime default (unobserved)"}.`);
      } catch (error) {
        runtime.versionStatus = "failed";
        sessionStatus = "failed";
        completionReason = "harness_error";
        sessionError = sanitize(toErrorMessage(error));
        sessionReason = `Codex runtime version could not be verified before execution: ${sessionError}`;
        recordLifecycle("terminal-lab.runtime.version.error", sessionReason);
        return false;
      }
      // --- Optional product setup (no runtime env), before the Codex exec. ---
      // Same channel and same guarantees as the runtime bootstrap above: no runtime key touches it,
      // and a failure fails the lane closed rather than handing the agent a half-built world. It
      // exists so a study can put the participant IN a prepared project — asking an agent what
      // studies a project contains, in an empty directory, measures the lab and not the product
      // (learned the hard way on the desktop lane, labs/tui-self-study.yaml).
      const install = config.subject.product?.install;
      if (install === undefined) return true;

      // An optional local file, put on the machine before the install runs, so a study can meet a
      // build that is not published yet. Read and checked HERE rather than trusted from the
      // manifest: this puts a file from the operator's disk onto a machine an autonomous agent is
      // about to drive, so it stays inside the project, must be a regular file, and is size-capped.
      let uploadAssignment = "";
      const uploadRel = config.subject.product?.upload;
      if (uploadRel !== undefined) {
        const uploadStartedAt = now();
        try {
          const resolved = path.resolve(cwd, uploadRel);
          const projectRoot = await realpath(cwd);
          const real = await realpath(resolved);
          if (real !== projectRoot && !real.startsWith(`${projectRoot}${path.sep}`)) {
            throw new Error("subject.product.upload resolved outside the project");
          }
          const info = await stat(real);
          if (!info.isFile()) throw new Error("subject.product.upload is not a regular file");
          if (info.size > UPLOAD_MAX_BYTES) {
            throw new Error(`subject.product.upload is ${info.size} bytes; the cap is ${UPLOAD_MAX_BYTES}`);
          }
          const destination = `${SANDBOX_WORKDIR}/.humanish-upload/${path.basename(real)}`;
          await sandbox.commands.run(`mkdir -p ${SANDBOX_WORKDIR}/.humanish-upload`, { requestTimeoutMs });
          const bytes = await readFile(real);
          await sandbox.files.write(destination, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          // Inlined into the command string rather than passed as `envs`: the ONLY call in this
          // lane that carries envs is the keyed codex exec, and that invariant is worth more than
          // the convenience of a second envs channel.
          uploadAssignment = `export HUMANISH_PRODUCT_UPLOAD='${destination.replace(/'/g, "'\\''")}'; `;
          recordLifecycle(
            "terminal-lab.product.uploaded",
            `Uploaded ${info.size} bytes to the sandbox in ${Math.max(0, now() - uploadStartedAt)}ms (no runtime env; declared egress auth may already be available).`
          );
        } catch (error) {
          sessionStatus = "failed";
          completionReason = "harness_error";
          sessionError = sanitize(toErrorMessage(error));
          sessionReason = `subject.product.upload could not be placed in the sandbox: ${sessionError}`;
          return false;
        }
      }
      const setupStartedAt = now();
      let setupError: string | undefined;
      try {
        const setup = await sandbox.commands.run(`${uploadAssignment}cd ${SANDBOX_WORKDIR} && ${install}`, {
          // The install step may run the product itself (release:dogfood's does: `humanish init
          // --yes`); on the 0.67.0 dogfood that one command arrived unmarked while the participant's
          // nine others carried the marker (#546).
          envs: { HUMANISH_STUDY_PARTICIPANT: "1" },
          requestTimeoutMs,
          timeoutMs: RUNTIME_BOOTSTRAP_TIMEOUT_MS
        });
        if ((setup.exitCode ?? 1) !== 0) {
          setupError = `product setup exited ${setup.exitCode ?? "null"}`;
        }
      } catch (error) {
        setupError = toErrorMessage(error);
      }
      recordLifecycle(
        "terminal-lab.product.prepared",
        setupError
          ? `Product setup FAILED after ${Math.max(0, now() - setupStartedAt)}ms: ${sanitize(setupError)}`
          : `Product setup completed in ${Math.max(0, now() - setupStartedAt)}ms (no runtime env; declared egress auth may already be available).`
      );
      if (setupError) {
        sessionStatus = "failed";
        completionReason = "harness_error";
        sessionError = sanitize(setupError);
        sessionReason = `subject.product.install could not prepare the world before codex exec: ${sessionError}`;
        return false;
      }
      return true;
    })()) {
      // --- The keyed run: `codex exec --json` non-interactively (stdin disabled). ---
      // openai-env passes the real key here; openai-egress passes an inert placeholder. stdin is
      // never wired (safety contract item 7) — commands.run takes no stdin channel. The command's
      // wall-clock is bounded by maxMinutes (safety contract item 2): commands.run timeoutMs +
      // an injected-clock guard so a mock/real run that exceeds it is killed and fails closed.
      const codexCommand = buildCodexExecCommand({
        workdir: SANDBOX_WORKDIR, prompt: composedPrompt, runtimeAuth: runtimeEnv.mode,
        version: runtime.observedVersion!,
        ...(config.actors[0]?.model === undefined ? {} : { model: config.actors[0].model }),
        ...(config.actors[0]?.reasoningEffort === undefined ? {} : { reasoningEffort: config.actors[0].reasoningEffort })
      });
      const commandDigest = digestText(codexCommand);
      const startedAt = now();
      recordLifecycle("terminal-lab.exec.started", `Launching codex exec (runtime auth ${runtimeEnv.mode}; command env names: ${Object.keys(runtimeEnv.envs).join(", ")}); wall-clock bound ${wallClockMs}ms.`);

      let exitCode: number | undefined;
      let runError: string | undefined;
      try {
        const result = await runWithWallClock(
          sandbox.commands.run(codexCommand, {
            // The selected command env (raw key or inert placeholder). The participant
            // marker rides the same command: humanish telemetry from inside a study reads as a new
            // adopter otherwise. #546 added the flag and nothing set it; the 0.66.0 dogfood
            // participant's twelve commands arrived unmarked.
            envs: { ...runtimeEnv.envs, HUMANISH_STUDY_PARTICIPANT: "1" },
            requestTimeoutMs,
            timeoutMs: wallClockMs,
            onStdout: (data: string) => recordStreamedTerminalChunk("stdout", data),
            onStderr: (data: string) => recordStreamedTerminalChunk("stderr", data)
          }),
          wallClockMs,
          now
        );
        if (result.timedOut) {
          timedOut = true;
        } else {
          exitCode = result.value.exitCode;
          // Reconcile the SDK's returned aggregate against bytes already delivered by callbacks.
          if (result.value.stdout) appendReturnedTerminalOutput("stdout", result.value.stdout);
          if (result.value.stderr) appendReturnedTerminalOutput("stderr", result.value.stderr);
          if (result.value.error) runError = result.value.error;
        }
      } catch (error) {
        runError = toErrorMessage(error);
      }
      const durationMs = Math.max(0, now() - startedAt);

      commandLog.push({
        at: nowIso(),
        label: "codex-exec",
        commandDigest,
        envNames: Object.keys(runtimeEnv.envs), // NAMES only — the credential evidence (item 4).
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(timedOut ? { timedOut: true } : {}),
        durationMs
      });

      // Score by the verdict-nonce marker over the SCRUBBED+REDACTED, NORMALIZED transcript — the
      // exact same logic the local-actor lanes use (extractLocalActorVerdict/normalizeLocalActorTranscript).
      const rawTranscript = terminalEvents.map((e) => e.chunk).join("");
      const normalizedTranscript = normalizeLocalActorTranscript(rawTranscript);
      const markerStatus = extractLocalActorVerdict(normalizedTranscript, verdictNonce);

      if (timedOut) {
        sessionStatus = "timed_out";
        completionReason = "timed_out";
        sessionReason = `codex exec exceeded the maxMinutes wall-clock (${maxMinutes}m); killed and failed closed.`;
        recordLifecycle("terminal-lab.exec.timed_out", sessionReason);
      } else if (runError) {
        sessionStatus = "failed";
        completionReason = "harness_error";
        sessionError = sanitize(runError);
        sessionReason = `codex exec could not run: ${sessionError}`;
        recordLifecycle("terminal-lab.exec.error", sessionReason);
      } else if (markerStatus) {
        sessionStatus = markerStatus;
        completionReason = markerStatus === "passed" ? "goal_satisfied" : markerStatus === "blocked" ? "blocked_approval" : "gave_up";
        sessionReason = `agent reported ${markerStatus} verdict marker (nonce-verified)`;
        recordLifecycle("terminal-lab.exec.completed", `codex exec exit=${exitCode ?? "null"}; ${sessionReason}.`);
      } else {
        // No nonce-verified verdict: the agent did not (credibly) report a terminal status. A run
        // that exited 0 but printed no verified marker is BLOCKED evidence (the failure IS the
        // evidence — still structurally verifiable), not a silent pass.
        sessionStatus = "blocked";
        completionReason = "gave_up";
        sessionReason = `codex exec exit=${exitCode ?? "null"} but no nonce-verified HUMANISH_ACTOR_VERDICT marker was emitted; recorded as blocked (the missing verdict is the evidence).`;
        recordLifecycle("terminal-lab.exec.blocked", sessionReason);
      }
    }
  } catch (error) {
    if (error instanceof E2BDesktopStartupError) startupCleanup = error.cleanup;
    sessionError = sanitize(toErrorMessage(error));
    sessionStatus = "failed";
    completionReason = "harness_error";
    sessionReason = `live terminal-product session failed: ${sessionError}`;
    recordLifecycle("terminal-lab.session.error", sessionReason);
  } finally {
    // --- Safety contract item 8: PROVEN cleanup, BY EXACT ID, never Sandbox.list. ---
    cleanup = await teardownSandbox({
      sandboxModule,
      sandbox,
      ...(startupCleanup === undefined ? {} : { startupCleanup }),
      requestTimeoutMs,
      sanitize,
      recordLifecycle,
      warnings
    });
  }

  // Prefix reconciliation may cut through a known key. Scrub literal values across the retained
  // chunks before any transcript/trace/event artifact is persisted. Check both each stream and
  // the combined event order that the transcript uses; either view can assemble a split value.
  scrubSplitKnownValues(terminalEvents, knownSecretValues, discardedPrefixes);

  // Build the actor trace FIRST (the cost ledger reads its tokenUsage).
  const normalizedTranscript = normalizeLocalActorTranscript(terminalEvents.map((e) => e.chunk).join(""));
  // Parsed from the FULL stream, not the tail: usage records arrive once per turn and the tail
  // would drop all but the last (#531).
  const terminalTokenUsage = parseTerminalTokenUsage(normalizedTranscript);
  const trace = buildTerminalActorTrace({
    persona,
    productName: product.name,
    status: sessionStatus,
    completionReason,
    reason: sanitize(sessionReason),
    createdAt,
    completedAt: nowIso(),
    durationMs: commandLog[0]?.durationMs ?? 0,
    terminalEvents,
    commandLog,
    transcriptTail: tailOf(normalizedTranscript),
    runtimeAuth: runtimeEnv.mode,
    runtime,
    ...(terminalTokenUsage === undefined ? {} : { tokenUsage: terminalTokenUsage })
  });

  // --- Spend ledger + no-spend proof + full caps enforcement (fail-closed). ---
  // The cost ledger is DERIVED, with the null discipline: provider spend from the trace's
  // tokenUsage.costUsd when present (else null = NOT MEASURED), product/media/payment null by
  // default (core has no signal). The costProbe hook lets tests or adapters inject KNOWN
  // spend to exercise the fail-closed cap without a real billable run.
  const injectedLines = hooks.costProbe?.({ ...(trace.tokenUsage?.costUsd === undefined ? {} : { tokenCostUsd: trace.tokenUsage.costUsd }) });
  if (hooks.costProbe) await validatePreparedRunArtifactPaths(runPaths);
  const cost = buildCostLedger({
    ...(trace.tokenUsage?.costUsd === undefined ? {} : { tokenCostUsd: trace.tokenUsage.costUsd }),
    ...(trace.tokenUsage === undefined ? {} : { tokenUsage: trace.tokenUsage }),
    ...(injectedLines ? { injectedLines } : {})
  });
  const noSpendProof = buildNoSpendProof(cost, maxUsd ?? null);
  recordLifecycle(
    "terminal-lab.cost.measured",
    `Cost ledger: known total ${cost.knownTotalUsd} USD${cost.fullyMeasured ? " (fully measured)" : ` (lower bound; unmeasured: ${noSpendProof.unmeasuredLines.join(", ") || "none"})`}. No-spend proof ${noSpendProof.satisfied ? "satisfied" : "NOT satisfied"} for maxUsd=${maxUsd ?? "null"}.`
  );

  // FULL caps enforcement (fail-closed, NOT advisory): if a KNOWN spend line exceeds maxUsd (or a
  // known job count exceeds maxJobs), the run fails closed — never a green pass. Unknowns (null) do
  // NOT trip the cap (we cannot claim a violation we did not measure) but never grant a pass either
  // (the no-spend proof reports them as unmeasured). maxMinutes is already wall-clock-enforced above.
  const capCheck = evaluateCapsAgainstLedger(cost, caps);
  let capsExceeded = false;
  if (!capCheck.ok) {
    capsExceeded = true;
    sessionStatus = "failed";
    completionReason = "harness_error";
    sessionError = capCheck.message;
    sessionReason = capCheck.message;
    recordLifecycle("terminal-lab.caps.exceeded", capCheck.message);
    // Reflect the fail-closed verdict in the trace the bundle/observer reads (so the run cannot show
    // a passing agent verdict while the cap was blown).
    trace.status = "failed";
    trace.completionReason = "harness_error";
    trace.reason = capCheck.message;
  }

  // Assemble + persist the ledgers (now carrying the cost block + no-spend proof), the redacted
  // event stream, the normalized transcript, the actor trace, and the run bundle.
  const ledgers: TerminalLedgers = {
    schema: "humanish.terminal-ledgers.v1",
    runtime,
    lifecycle,
    commandLog,
    interventions, // ALWAYS present, ALWAYS empty while no assisted-input path ships.
    cleanup,
    cost,
    noSpendProof
  };

  await writeContainedOutputFile(
    runPaths,
    TERMINAL_EVENTS_ARTIFACT,
    `${terminalEvents.map((e) => JSON.stringify(e)).join("\n")}${terminalEvents.length > 0 ? "\n" : ""}`,
    "utf8"
  );
  await writeContainedOutputFile(runPaths, TERMINAL_TRANSCRIPT_ARTIFACT, `${normalizedTranscript}\n`, "utf8");
  await writeContainedOutputFile(runPaths, TERMINAL_LEDGERS_ARTIFACT, `${JSON.stringify(ledgers, null, 2)}\n`, "utf8");
  await writeContainedOutputFile(runPaths, "actor.json", `${JSON.stringify(trace, null, 2)}\n`, "utf8");

  const bundle = buildLiveTerminalProductBundle({
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    actorId: descriptorId,
    createdAt,
    labId: config.id,
    ...(config.title ? { labTitle: config.title } : {}),
    mission,
    persona,
    productName: product.name,
    publicSurfaces: product.publicSurfaces,
    caps,
    runtimeAuthKeyName: runtimeEnv.keyName,
    runtimeAuth: runtimeEnv.mode,
    policies: {
      allowPrivateRepoAccess: config.policies?.allowPrivateRepoAccess ?? false,
      allowProviderCredentials: config.policies?.allowProviderCredentials ?? false,
      allowPaymentCredentials: config.policies?.allowPaymentCredentials ?? false,
      allowGitHubMutation: config.policies?.allowGitHubMutation ?? false
    },
    runId,
    source,
    trace,
    ledgers,
    ...(sandboxId ? { sandboxId } : {}),
    ...(sessionError ? { sessionError } : {}),
    sessionReason: sanitize(sessionReason)
  });

  // --- THE LAYER-6 EXTENSION SEAM (issue #154 acceptance #8). ---
  // When a thin adapter registered a scorer / feedback strategy, the lane calls it over the
  // FULLY-ASSEMBLED, redacted evidence and attaches the results to the bundle WITHOUT knowing any
  // product noun: the namespaced RunAdapterScore lands on bundle.adapterScore, and the derived
  // feedback candidates (each carrying its own namespaced product-noun block) are appended to
  // bundle.feedbackCandidates. Core's mission-based verdict (bundle.review) is left UNCHANGED — the
  // adapter score is additive, not a replacement. The adapter payloads pass the same scrub+redact
  // the rest of the bundle does (the adapter is trusted in-repo code, but the harness never relies
  // on that for secret values) and are validated fail-closed by the bundle verifier downstream.
  const declaredScorerFailure = await applyAdapterExtensionSeam({ hooks, bundle, trace, ledgers, transcript: normalizedTranscript, product: product.name, labId: config.id, runId, sanitize, warnings, ...(options.scorerProvenance === undefined ? {} : { scorerProvenance: options.scorerProvenance }) });
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
  await writeContainedOutputFile(runPaths, "review.md", renderTerminalReviewMarkdown(bundle), "utf8");
  await writeContainedOutputFile(runPaths, "events.ndjson", `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writePreparedRunLatestPointer(
    runPaths,
    `${JSON.stringify({ schema: "humanish.latest-run.v1", runId, path: runPaths.relativeRunRoot, updatedAt: createdAt }, null, 2)}\n`,
    "utf8"
  );

  const observer = await render(physicalCwd, runId, { open: options.open === true });
  await validatePreparedRunArtifactPaths(runPaths);

  // The lab's exit code: verified evidence AND no harness error AND proven cleanup. A blocked/
  // timed-out agent run is STILL ok-as-evidence at the bundle level (the failure is the evidence),
  // but the LAB result surfaces ok:false on a harness error or unproven teardown (fail-closed).
  // remaining===0 is the by-id-confirmed-reclaimed state; remaining===1 (still present) and
  // remaining===-1 (kill(id) itself failed) are both unproven by design.
  const cleanupProven = cleanup.killed && cleanup.remaining === 0;
  // A CONFIG-DECLARED scorer that failed to render a pass (status:"fail" / malformed / throw) fails the
  // run RESULT too, not just the persisted verdict — the keystone lane's declared rubric is a gate, so
  // its fail must drive exit code. Library callers never set this (additive, back-compat).
  const ok = observer.ok && completionReason !== "harness_error" && cleanupProven && declaredScorerFailure === undefined;

  return {
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok,
    cwd,
    labId: config.id,
    actor: descriptorId,
    product: product.name,
    dryRun: false,
    runId,
    session: { status: sessionStatus, completionReason, reason: sanitize(sessionReason) },
    ...(sandboxId
      ? { sandbox: { sandboxId, killed: cleanup.killed, remaining: cleanup.remaining } }
      : {}),
    cost: {
      knownTotalUsd: cost.knownTotalUsd,
      fullyMeasured: cost.fullyMeasured,
      lines: {
        product: cost.lines.product.usd,
        media: cost.lines.media.usd,
        payment: cost.lines.payment.usd,
        provider: cost.lines.provider.usd
      }
    },
    noSpend: {
      satisfied: noSpendProof.satisfied,
      maxUsd: noSpendProof.maxUsd,
      knownZeroLines: noSpendProof.knownZeroLines,
      unmeasuredLines: noSpendProof.unmeasuredLines
    },
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: (!cleanupProven
              ? "HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN"
              : capsExceeded
                ? "HUMANISH_TERMINAL_LAB_CAPS_EXCEEDED"
                : "HUMANISH_TERMINAL_LAB_FAILED") as NonNullable<TerminalProductLabResult["error"]>["code"],
            message: !cleanupProven
              ? `Live terminal-product run could not prove sandbox teardown (killed=${cleanup.killed}, remaining=${cleanup.remaining}): ${cleanup.reason}. A run that cannot prove teardown fails closed.${sessionError ? ` Session failure: ${sessionError}` : ""}`
              : declaredScorerFailure ?? sessionError ?? observer.error?.message ?? sessionReason
          }
        })
  };
}

/**
 * Run the layer-6 product-adapter extension seam (issue #154 acceptance #8) over the assembled
 * evidence and attach its results to the bundle IN PLACE — without core knowing any product noun.
 *
 *  - `score`: when present, the returned namespaced `RunAdapterScore` lands on `bundle.adapterScore`.
 *    For a LIBRARY caller (no `scorerProvenance`), core's mission-based verdict (`bundle.review`) is
 *    UNCHANGED — the adapter score is additive. For a CONFIG-DECLARED scorer (#316; `scorerProvenance`
 *    present), a status:"fail" FLIPS the verdict via `applyAdapterScoreFailureToReview` (the keystone
 *    lane is the product's own definition of pass/fail), and a scorer that THROWS becomes a visible
 *    `review.gaps` entry so a crashed declared gate is never a silent green.
 *  - `deriveFeedback`: when present, the returned candidates are appended to
 *    `bundle.feedbackCandidates`; each carries its own namespaced `adapter` product-noun block.
 *
 * Defense in depth: the adapter's namespaced payloads are re-serialized through the run's scrub +
 * redact, and any candidate / score that does not satisfy core's exported shape is DROPPED with a
 * warning (a malformed adapter output never poisons a verifiable bundle). The bundle verifier
 * re-checks the surviving shapes downstream, so the seam stays fail-closed end to end.
 */
async function applyAdapterExtensionSeam(args: {
  hooks: TerminalProductLabHooks;
  bundle: RunBundle;
  trace: ActorTrace;
  ledgers: TerminalLedgers;
  transcript: string;
  product: string;
  labId: string;
  runId: string;
  sanitize: (text: string) => string;
  warnings: string[];
  /** Present only when the scorer was CONFIG-DECLARED (#316) — the "declared" marker that opts the
   *  terminal route into flip-on-fail. Absent for library callers (additive, back-compat). */
  scorerProvenance?: RunScorerProvenance;
}): Promise<string | undefined> {
  const { hooks, bundle, trace, ledgers, transcript, product, labId, runId, sanitize, warnings, scorerProvenance } = args;
  if (!hooks.score && !hooks.deriveFeedback) return undefined;
  const declared = scorerProvenance !== undefined;
  // Record the loaded scorer's identity regardless of hook outcome (a throwing/invalid scorer was
  // still loaded and attempted).
  if (scorerProvenance) bundle.scorerProvenance = scorerProvenance;

  // The scorer sees a READ-ONLY view of the bundle so it cannot mutate noSpend/cost/review in place to
  // launder a verdict (a tamper attempt throws and is caught as a hook failure below). The seam stamps
  // the REAL bundle. The transcript is the SAME normalized, source-scrubbed text the run persists as
  // terminal-transcript.txt — no new exposure beyond what disk already holds (#341).
  const ctx: TerminalProductScoringContext = { bundle: frozenBundleView(bundle), trace, ledgers, transcript, product, labId, runId };
  // Best-effort re-scrub of the adapter payload: round-trip the whole JSON through the run's denylist
  // sanitizer. This is NOT containment — it catches recognizable secret shapes and known local paths,
  // but not encoded/split/custom secrets, DB passwords, PII, or abs paths outside the denylist. A
  // payload from config-declared code is acceptable only because the trust boundary (the party who
  // declares the scorer runs the lab) already permits direct exfiltration; the re-scrub is
  // defense-in-depth, not a wall.
  const scrubValue = <T>(value: T): T => JSON.parse(sanitize(JSON.stringify(value))) as T;

  // Set for a DECLARED scorer that fails to render a PASS verdict (status:"fail", malformed, or throw).
  // The caller fails the run RESULT on it — a declared gate that cannot pass is a fail, never a silent
  // green. Left undefined for a library caller (additive, back-compat) and for a passing scorer.
  let declaredVerdictFailure: string | undefined;

  if (hooks.score) {
    try {
      const score = await hooks.score(ctx);
      const cleaned = scrubValue(score);
      if (isAdapterScoreShape(cleaned)) {
        bundle.adapterScore = cleaned;
        // A CONFIG-DECLARED terminal scorer owns the product verdict: a status:"fail" flips
        // review.verdict (this only ever makes the verdict STRICTER) AND fails the run result. A
        // library caller keeps the additive no-flip behavior.
        if (declared) {
          const message = applyAdapterScoreFailureToReview(bundle);
          if (message !== undefined) declaredVerdictFailure = message;
        }
      } else {
        warnings.push("terminalHooks.score returned a value that is not a well-formed humanish.adapter-score.v1 (non-empty namespace + status + numeric score + summary); dropped so the bundle stays verifiable.");
        // A declared gate that returned a MALFORMED value never rendered a verdict — fail closed.
        if (declared) {
          declaredVerdictFailure = "Declared product scorer returned a malformed value instead of a verdict; a declared gate that cannot render a pass is recorded as a fail, never a silent pass.";
          recordDeclaredScorerVerdictFailure(bundle, declaredVerdictFailure);
        }
      }
    } catch (error) {
      const detail = sanitize(error instanceof Error ? error.message : String(error));
      warnings.push(`terminalHooks.score threw (${detail}); dropped so the bundle stays verifiable.`);
      // A crashed DECLARED gate must be visible, never a silent pass: surface it as a review gap +
      // verdict downgrade AND fail the run result.
      if (declared) {
        declaredVerdictFailure = `Declared product scorer threw before returning a verdict (${detail}); a crashed declared gate is recorded as a fail, never a silent pass.`;
        recordDeclaredScorerVerdictFailure(bundle, declaredVerdictFailure);
      }
    }
  }

  if (hooks.deriveFeedback) {
    try {
      const candidates = await hooks.deriveFeedback(ctx);
      const accepted: RunFeedbackCandidate[] = [];
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const cleaned = scrubValue(candidate);
        if (isAdapterFeedbackCandidateShape(cleaned)) accepted.push(cleaned);
        else warnings.push("terminalHooks.deriveFeedback returned a candidate that is not a well-formed humanish.feedback-candidate.v1 (or its adapter block lacked a non-empty namespace + data record); dropped so the bundle stays verifiable.");
      }
      if (accepted.length > 0) {
        bundle.feedbackCandidates = [...bundle.feedbackCandidates, ...accepted];
      }
    } catch (error) {
      warnings.push(`terminalHooks.deriveFeedback threw (${sanitize(error instanceof Error ? error.message : String(error))}); dropped so the bundle stays verifiable.`);
    }
  }

  return declaredVerdictFailure;
}

/** Structural guard for an adapter-returned RunAdapterScore (mirrors run.ts isRunAdapterScore, kept
 *  local so the lane fails closed at the seam BEFORE the bundle verifier re-checks it). */
function isAdapterScoreShape(value: unknown): value is RunAdapterScore {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as RunAdapterScore).schema === "humanish.adapter-score.v1"
    && typeof (value as RunAdapterScore).namespace === "string"
    && (value as RunAdapterScore).namespace.trim().length > 0
    && ["pass", "partial", "fail"].includes((value as RunAdapterScore).status)
    && typeof (value as RunAdapterScore).score === "number"
    && Number.isFinite((value as RunAdapterScore).score)
    && typeof (value as RunAdapterScore).summary === "string";
}

/** Structural guard for an adapter-returned feedback candidate. This mirrors run.ts's full
 * isRunFeedbackCandidate predicate, including its local evidence-path contract, so a malformed
 * candidate is dropped at the extension seam instead of poisoning the persisted bundle. */
function isAdapterFeedbackCandidateShape(value: unknown): value is RunFeedbackCandidate {
  return isAdapterRecord(value)
    && value.schema === "humanish.feedback-candidate.v1"
    && typeof value.id === "string"
    && typeof value.run_id === "string"
    && (typeof value.stream_id === "string" || value.stream_id === undefined)
    && typeof value.adapter_id === "string"
    && typeof value.scenario_id === "string"
    && typeof value.persona_id === "string"
    && isAdapterFeedbackActor(value.actor)
    && isAdapterFeedbackSubstrate(value.substrate)
    && isAdapterFeedbackFailureOwner(value.failure_owner)
    && typeof value.summary === "string"
    && value.summary.trim().length > 0
    && typeof value.expected === "string"
    && typeof value.actual === "string"
    && Array.isArray(value.evidence)
    && value.evidence.every(isAdapterFeedbackEvidence)
    && isAdapterRecord(value.redaction)
    && value.redaction.status === "passed"
    && typeof value.redaction.notes === "string"
    && typeof value.idempotency_key === "string"
    && isAdapterFeedbackNextState(value.proposed_next_state)
    && Array.isArray(value.acceptance_proof)
    && value.acceptance_proof.every((item) => typeof item === "string")
    && (value.adapter === undefined || (
      isAdapterRecord(value.adapter)
      && typeof value.adapter.namespace === "string"
      && value.adapter.namespace.trim().length > 0
      && isAdapterRecord(value.adapter.data)
    ));
}

function isAdapterFeedbackEvidence(value: unknown): value is RunFeedbackCandidate["evidence"][number] {
  return isAdapterRecord(value)
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

function isAdapterFeedbackActor(value: unknown): value is RunFeedbackCandidate["actor"] {
  return value === "codex-tui"
    || value === "codex-exec"
    || value === "codex-app-server"
    || value === "computer-use"
    || value === "synthetic-dry-run"
    || value === "unknown";
}

function isAdapterFeedbackSubstrate(value: unknown): value is RunFeedbackCandidate["substrate"] {
  return value === "e2b-desktop"
    || value === "e2b-terminal"
    || value === "local-filesystem"
    || value === "codex-app-server"
    || value === "unknown";
}

function isAdapterFeedbackFailureOwner(value: unknown): value is RunFeedbackCandidate["failure_owner"] {
  return value === "harness"
    || value === "target-app"
    || value === "actor"
    || value === "environment"
    || value === "unknown";
}

function isAdapterFeedbackNextState(value: unknown): value is RunFeedbackCandidate["proposed_next_state"] {
  return value === "watch"
    || value === "adapter-hardening"
    || value === "target-app-setup"
    || value === "actor-auth"
    || value === "setup-quality-review"
    || value === "study-quality-review";
}

function isAdapterRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tear the sandbox down and PROVE it BY EXACT ID -- NEVER Sandbox.list (humanish must never
 * enumerate the operator's E2B account; see docs/principles/invariants-and-defaults.md). After
 * Sandbox.kill(id) resolves, its own boolean return ("found and killed", per the SDK) is the
 * PRIMARY proof. Where the SDK exposes Sandbox.getInfo(id), a thrown SandboxNotFoundError is a
 * second by-id confirmation that the exact sandbox is gone; a returned SandboxInfo with a live
 * state means teardown is NOT confirmed. Never throws -- teardown failure is recorded, the
 * caller fails closed on an unproven teardown.
 */
async function teardownSandbox(args: {
  sandboxModule: E2BDesktopModule | undefined;
  sandbox: E2BDesktopSandbox | undefined;
  startupCleanup?: E2BDesktopStartupError["cleanup"];
  requestTimeoutMs: number;
  sanitize: (text: string) => string;
  recordLifecycle: (event: string, message: string) => void;
  warnings: string[];
}): Promise<TerminalLedgers["cleanup"]> {
  const { sandboxModule, sandbox, startupCleanup, requestTimeoutMs, sanitize, recordLifecycle, warnings } = args;
  if (!sandbox || !sandboxModule) {
    // create() can reject AFTER its constructor acquired a handle. The default loader retains
    // that authority and reclaims it before rejecting; the lane itself never receives its ID.
    if (startupCleanup === "killed" || startupCleanup === "already_gone") {
      const reason = `desktop startup guard confirmed its acquired sandbox ${startupCleanup === "killed" ? "was killed" : "was already gone"}`;
      recordLifecycle("terminal-lab.cleanup.killed", reason);
      return { killed: true, remaining: 0, reason };
    }
    const reason = startupCleanup === "unconfirmed"
      ? "desktop startup guard could not confirm cleanup of its acquired sandbox; provider timeout remains the backstop"
      : "create did not return a sandbox; the lane has no acquired handle and cannot establish allocation or cleanup";
    recordLifecycle("terminal-lab.cleanup.unconfirmed", reason);
    return { killed: false, remaining: -1, reason };
  }
  if (typeof sandboxModule.Sandbox.kill !== "function") {
    return { killed: false, remaining: -1, reason: "installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox" };
  }

  let killResult = false;
  try {
    killResult = (await sandboxModule.Sandbox.kill(sandbox.sandboxId, { requestTimeoutMs })) === true;
  } catch (error) {
    const sanitizedError = sanitize(toErrorMessage(error));
    warnings.push(`Sandbox teardown failed (server-side kill-on-timeout will reclaim it): ${sanitizedError}`);
    recordLifecycle("terminal-lab.cleanup.kill_error", `Sandbox ${sandbox.sandboxId} kill(id) failed: ${sanitizedError}`);
    return { killed: false, remaining: -1, reason: `kill(id) failed: ${sanitizedError} (server-side kill-on-timeout will reclaim it)` };
  }

  // BY-ID verification only, from here down: NEVER Sandbox.list. A kill(id) call that RESOLVES is
  // itself proof the exact sandbox is gone: kill(id) returns true when it found and killed the
  // sandbox, and false ONLY on a 404 (the exact id was already gone, e.g. the server-side
  // kill-on-timeout raced ahead). Both mean "this id is no longer running." Sandbox.getInfo(id),
  // when the SDK exposes it, adds a second by-id confirmation; the only thing that overturns the
  // kill proof is getInfo returning a LIVE sandbox for this exact id.
  const killNote = killResult
    ? "kill(id) returned true (found and killed)"
    : "kill(id) returned false (404: the exact sandbox was already gone)";

  if (typeof sandboxModule.Sandbox.getInfo !== "function") {
    recordLifecycle("terminal-lab.cleanup.killed", `Sandbox ${sandbox.sandboxId} reclaimed: ${killNote}; the installed SDK has no getInfo(id) to re-verify, so kill(id)'s own result is the proof.`);
    return { killed: true, remaining: 0, reason: `reclaimed by id; ${killNote} and the installed SDK does not expose Sandbox.getInfo to re-verify` };
  }

  try {
    const info = await sandboxModule.Sandbox.getInfo(sandbox.sandboxId, { requestTimeoutMs });
    const state = info.state ?? "unknown";
    recordLifecycle("terminal-lab.cleanup.unconfirmed", `Sandbox ${sandbox.sandboxId} ${killNote}, but getInfo(id) still reports state=${state} (not confirmed reclaimed by id).`);
    return { killed: true, remaining: 1, reason: `${killNote} but getInfo(id) still reports state=${state}; this sandbox's teardown is not confirmed by id` };
  } catch (error) {
    if (isSandboxNotFoundError(error)) {
      recordLifecycle("terminal-lab.cleanup.verified", `Sandbox ${sandbox.sandboxId} reclaimed; getInfo(id) confirms it no longer exists (SandboxNotFoundError) -- by exact id, never re-listed.`);
      return { killed: true, remaining: 0, reason: `reclaimed by id; getInfo(id) confirms the exact sandbox no longer exists (SandboxNotFoundError)` };
    }
    // getInfo(id) failed for a reason OTHER than "not found" (e.g. a transient network error):
    // no second by-id confirmation is available, so the RESOLVED kill(id) call stands as the proof
    // of absence. Never fall back to Sandbox.list.
    const sanitizedError = sanitize(toErrorMessage(error));
    recordLifecycle("terminal-lab.cleanup.killed", `Sandbox ${sandbox.sandboxId} reclaimed: ${killNote}; getInfo(id) re-verification errored (${sanitizedError}), so kill(id)'s resolved result is the proof.`);
    return { killed: true, remaining: 0, reason: `reclaimed by id; ${killNote} and getInfo(id) re-verification errored (${sanitizedError}), so kill(id)'s resolved result is the proof` };
  }
}

/**
 * Race a commands.run promise against the maxMinutes wall-clock (safety contract item 2). The E2B
 * commands.run timeoutMs is the primary kill; this injected-clock guard is the belt-and-suspenders
 * backstop so a mock CLI (which ignores timeoutMs) is still bounded and fails closed in CI.
 */
async function runWithWallClock<T>(
  promise: Promise<T>,
  wallClockMs: number,
  now: () => number
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const start = now();
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), wallClockMs);
    timer.unref?.();
  });
  const value = await Promise.race([
    promise.then((v) => ({ timedOut: false as const, value: v })),
    timeout
  ]);
  if (timer) clearTimeout(timer);
  // Guard against a clock that advanced past the budget even if the race resolved on the promise.
  if (!value.timedOut && now() - start >= wallClockMs) {
    return { timedOut: true };
  }
  return value;
}

/**
 * Per-chunk sanitization cannot recognize a value split across deliveries. Redact those complete
 * known values before persistence without collapsing events or changing stdout/stderr ordering.
 * Work backwards through matches so edits to later text leave earlier offsets valid.
 */
function scrubSplitKnownValues(
  events: TerminalEventRecord[],
  knownValues: string[],
  discardedPrefixes: Record<"stdout" | "stderr" | "combined", string>
): void {
  for (const order of ["stdout", "stderr", "combined"] as const) {
    const chunks: Array<{ chunk: string }> = order === "combined"
      ? [...events]
      : events.filter((event) => event.stream === order);
    // A virtual final chunk makes a key crossing the capture cap recognizable. Edits to retained
    // events redact evidence; the raw overlap and this virtual chunk are never persisted.
    if (discardedPrefixes[order]) chunks.push({ chunk: discardedPrefixes[order] });
    for (const value of knownValues) {
      if (!value) continue;
      let offset = 0;
      const starts = chunks.map((event) => {
        const start = offset;
        offset += event.chunk.length;
        return start;
      });
      const text = chunks.map((event) => event.chunk).join("");
      const matches: number[] = [];
      for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length)) matches.push(at);
      for (const at of matches.reverse()) {
        let first = 0;
        while (first + 1 < starts.length && (starts[first + 1] ?? Infinity) <= at) first += 1;
        let last = first;
        while (last + 1 < starts.length && (starts[last + 1] ?? Infinity) < at + value.length) last += 1;
        const firstChunk = chunks[first];
        const lastChunk = chunks[last];
        if (!firstChunk || !lastChunk) continue;
        const before = firstChunk.chunk.slice(0, at - (starts[first] ?? 0));
        const after = lastChunk.chunk.slice(at + value.length - (starts[last] ?? 0));
        firstChunk.chunk = `${before}[REDACTED_SECRET]${first === last ? after : ""}`;
        for (let index = first + 1; index < last; index += 1) {
          const middle = chunks[index];
          if (middle) middle.chunk = "";
        }
        if (first !== last) lastChunk.chunk = after;
      }
    }
  }
}

/** Build the in-sandbox `codex exec` command (non-interactive, JSON, stdin disabled by mechanism). */
function buildCodexExecCommand(args: { workdir: string; prompt: string; runtimeAuth: LabRuntimeAuth; version: string; model?: string; reasoningEffort?: import("./reasoning-effort.js").ReasoningEffort }): string {
  // The prompt is passed via a heredoc on stdin of a wrapper? NO, stdin is DISABLED (item 7), so
  // the prompt rides as the final positional arg, shell-quoted. codex exec --json runs once and
  // exits (no interactive loop). --skip-git-repo-check: the workdir is a fresh scratch dir.
  // Pinned via npx (never an ambient/preinstalled `codex` binary, which the stock @e2b/desktop
  // image does not ship, per issue #159); npm_config_update_notifier=false silences npx's own
  // update check so it cannot leak into the captured stdout the scorer/redactor parse.
  const quotedPrompt = `'${args.prompt.replace(/'/g, "'\\''")}'`;
  // --dangerously-bypass-approvals-and-sandbox: codex's OWN inner sandbox is
  // redundant here and blocks the network/file access the study mission needs.
  // The E2B sandbox is the trust boundary (the disposable machine); the sibling
  // oss-meta-lab lane carries the same flag at both live call sites for the
  // same reason, and exec mode has no interactive approval channel at all.
  // The egress transform protects only the default OpenAI host. Pin the effective built-in
  // provider/base URL above config-file settings so setup-written custom endpoints cannot make
  // this invocation silently claim protection for another provider. openai-env is unchanged.
  const providerConfig = args.runtimeAuth === "openai-egress"
    ? ` -c 'model_provider="openai"' -c 'openai_base_url="https://api.openai.com/v1"'`
    : "";
  return `cd ${args.workdir} && ${buildRuntimeExecPrefix(args.version, args.model, args.reasoningEffort)} --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check${providerConfig} --json ${quotedPrompt}`;
}

/** Compose the live prompt: PUBLIC surfaces + author mission + the verdict-nonce marker contract. */
function composeLivePrompt(args: {
  mission: string;
  personaLine: string;
  productName: string;
  publicSurfaces: string[];
  verdictNonce: string;
}): string {
  return [
    args.personaLine,
    `product: ${args.productName}`,
    `public-surfaces: ${args.publicSurfaces.join(" ")}`,
    `mission: ${args.mission}`,
    "",
    "Work ONLY from the public surfaces above. Do NOT clone or inspect any private repository.",
    `When finished, print exactly one final machine-readable line in this format: HUMANISH_ACTOR_VERDICT=<status> HUMANISH_ACTOR_NONCE=${args.verdictNonce} where <status> is passed, blocked, or failed.`
  ].join("\n");
}

/** Redacted, ellipsis-prefixed tail of a captured stream/log for a message field. */
function tailOf(text: string): string {
  return redactedTail(text, TAIL_CHARS);
}

/**
 * Project the live terminal session into the provider-neutral humanish.actor-trace.v1 (lane
 * "terminal", protocol "terminal-exec"). counts.actions/messages drive the no-engagement honesty
 * guard (a real run bumps them; a no-op is caught). No screenshots on this lane.
 */
function buildTerminalActorTrace(args: {
  persona: ActorPersonaRef;
  productName: string;
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  reason: string;
  createdAt: string;
  completedAt: string;
  durationMs: number;
  terminalEvents: TerminalEventRecord[];
  commandLog: CommandLogRecord[];
  transcriptTail: string;
  runtimeAuth: LabRuntimeAuth;
  runtime: ActorRuntimeProvenance;
  /** Runtime-turn aggregate usage parsed from the exec stream (#531). Absent when the stream
   *  carried no usage record, which stays distinct from a measured zero. */
  tokenUsage?: ActorTokenUsage;
}): ActorTrace {
  const items: ActorTraceItem[] = [
    ...args.commandLog.map((entry, index): ActorTraceItem => ({
      id: `command-${String(index + 1).padStart(3, "0")}`,
      kind: "command",
      lifecycle: "completed",
      ...(entry.exitCode === undefined ? {} : { status: String(entry.exitCode) }),
      title: `${entry.label} (${entry.envNames.join(",") || "no command-scoped env"})`,
      command: {
        ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
        outputTail: args.transcriptTail
      }
    })),
    // One message item carrying the (already-redacted) transcript tail so the trace shows the agent
    // narrated SOMETHING — the engagement signal the no-engagement guard reads.
    ...(args.terminalEvents.length > 0
      ? [{ id: "message-001", kind: "message", lifecycle: "completed", title: "agent terminal output", text: args.transcriptTail } as ActorTraceItem]
      : [])
  ];
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "codex",
    ...(args.runtime.versionStatus === "verified" ? { providerVersion: args.runtime.observedVersion } : {}),
    runtime: args.runtime,
    protocol: "terminal-exec",
    lane: "terminal",
    persona: args.persona,
    redaction: {
      status: "passed",
      screenshots: "n/a",
      notes: "Terminal exec output captured via commands.run onStdout/onStderr, scrubbed (literal known values) then redacted (shape patterns) AT THE SOURCE before persisting; no screenshots on this lane."
    },
    startedAt: args.createdAt,
    completedAt: args.completedAt,
    durationMs: args.durationMs,
    status: args.status,
    completionReason: args.completionReason,
    reason: args.reason,
    ids: {}, // Runtime model requests are not observed; declarations live in runtime provenance.
    ...(args.tokenUsage ? { tokenUsage: args.tokenUsage } : {}),
    counts: {
      commands: args.commandLog.length,
      // actions == executed commands; messages == 1 when the agent produced any output. The
      // no-engagement guard (run.ts) reads these: a real run bumps them, a no-op is caught.
      actions: args.commandLog.length,
      messages: args.terminalEvents.length > 0 ? 1 : 0,
      terminalEvents: args.terminalEvents.length
    },
    items,
    capabilities: args.runtimeAuth === "openai-egress"
      ? { ...TERMINAL_AGENT_CAPABILITIES, keyPlacement: "external" }
      : TERMINAL_AGENT_CAPABILITIES
  };
}

/**
 * Project the terminal-product lab run into a humanish.run-bundle.v1 (no schema change — a new
 * producer only). DRY-RUN: a contract bundle. The terminal stream is a contract placeholder
 * (stdin disabled, no captured tail — honest: nothing ran), the subject is declared UNPINNED, and
 * the caps/policies/runtime-auth declarations are recorded without pretending that live ledgers
 * exist. The shipped live builder fills the same evidence contract. Exported for tests.
 */
export function buildTerminalProductBundle(args: {
  /** Lab provenance for the bundle\'s own `lab` field (#455). */
  lab?: RunLabProvenance;
  actorId: string;
  createdAt: string;
  dryRun: boolean;
  labId: string;
  labTitle?: string;
  mission: string;
  persona: ActorPersonaRef;
  productName: string;
  publicSurfaces: string[];
  caps?: LabScenarioCaps;
  runtimeAuth?: string;
  stdin: "disabled" | "planned" | "sent";
  policies: {
    allowPrivateRepoAccess: boolean;
    allowProviderCredentials: boolean;
    allowPaymentCredentials: boolean;
    allowGitHubMutation: boolean;
  };
  runId: string;
  source: RunBundle["source"];
}): RunBundle {
  const reason = "Contract bundle only: dry-run declared the terminal-product study contract without creating an E2B sandbox, injecting any key, or spending. This run did not execute an agent or prove live behavior.";

  const simulation: RunSimulation = {
    id: "sim-001",
    index: 1,
    personaId: args.persona.id,
    scenarioId: `terminal-${args.labId}`,
    status: "contract_proof_only",
    streamKind: "terminal",
    mode: "cli-sim",
    progress: 100,
    currentStep: reason,
    summary: `Contract lane for the terminal agent (${args.actorId}) studying ${args.productName} from public surfaces.`,
    streamIds: ["stream-001"],
    startedAt: args.createdAt,
    updatedAt: args.createdAt
  };

  // The terminal stream is a CONTRACT PLACEHOLDER on the dry-run path: stdin is disabled and no
  // exec output was captured, so the tail is empty and transport stays "snapshot" — NOT "pty"
  // (captured non-interactive exec output is never an interactive PTY; invariant 6 + the PTY
  // ruling). The shipped live builder fills terminal.tail from redacted exec-stream capture.
  const stream: RunStream = {
    id: "stream-001",
    simId: "sim-001",
    kind: "terminal",
    label: `Terminal agent — ${args.labId}`,
    status: "contract_proof_only",
    transport: "snapshot",
    updatedAt: args.createdAt,
    embed: { kind: "placeholder", title: `Terminal agent (${args.productName})` },
    terminal: {
      title: `${args.actorId} exec (stdin ${args.stdin})`,
      format: "plain",
      stdin: args.stdin,
      tail: ""
    },
    ui: {
      intent: `Watch the terminal agent discover and use ${args.productName} from its public surfaces.`,
      state: reason
    },
    artifacts: [
      { label: "run bundle", path: "run.json", kind: "bundle" as const },
      { label: "review", path: "review.md", kind: "review" as const },
      { label: "events", path: "events.ndjson", kind: "events" as const }
    ]
  };

  const capsText = describeCaps(args.caps);
  const events: RunEvent[] = [
    {
      id: "event-000-created",
      at: args.createdAt,
      level: "info",
      type: "terminal-lab.run.created",
      message: `Created terminal-product lab run for ${args.labId} (actor ${args.actorId}, product ${args.productName}).`
    },
    {
      id: "event-001-subject",
      at: args.createdAt,
      level: "info",
      type: "terminal-lab.subject.declared",
      // Invariant 5: provenance recorded or its absence DECLARED. The agent drives PUBLIC surfaces,
      // not a clone, so the subject provenance is explicitly UNPINNED; evidence binds to the
      // composed-prompt digest. Public surfaces are recorded (they are public by declaration).
      message: `Subject product declared: ${args.productName}; public surfaces: ${args.publicSurfaces.join(", ")}. The lab did not provision/clone the product — subject provenance is UNPINNED (a public-surface study cannot be commit-pinned); evidence binds to the composed-prompt digest ${args.persona.promptDigest}.`,
      simId: "sim-001",
      streamId: "stream-001"
    },
    {
      id: "event-002-credentials",
      at: args.createdAt,
      level: "info",
      type: "terminal-lab.credentials.declared",
      // Names-only evidence (invariant 1): the runtime-auth CHANNEL is declared; no value is ever
      // recorded. The deny-by-default policies are recorded so the credential posture is auditable.
      message: `Runtime auth channel: ${args.runtimeAuth ?? "none declared"} (names only; values never persist; the live engine applies the selected key placement, while this dry-run performs no injection). Credential policies (deny-by-default): allowPrivateRepoAccess=${args.policies.allowPrivateRepoAccess}, allowProviderCredentials=${args.policies.allowProviderCredentials}, allowPaymentCredentials=${args.policies.allowPaymentCredentials}, allowGitHubMutation=${args.policies.allowGitHubMutation}.`,
      simId: "sim-001",
      streamId: "stream-001"
    },
    {
      id: "event-003-caps",
      at: args.createdAt,
      level: "info",
      type: "terminal-lab.caps.declared",
      message: `Spend/job/time caps: ${capsText}. A live run never exercises the runtime key without a fail-closed cap; its no-spend proof is derived from the persisted cost ledger. This dry-run spends $0 by mechanism.`,
      simId: "sim-001",
      streamId: "stream-001"
    },
    {
      id: "event-004-contract",
      at: args.createdAt,
      level: "info",
      type: "terminal-lab.contract.ready",
      message: "Dry-run contract bundle ready. Switch scenario.mode to live with the required runtime auth and caps to exercise the in-sandbox agent route, captured exec stream, and declared runtime-auth placement.",
      simId: "sim-001",
      streamId: "stream-001"
    }
  ];

  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict: "contract_proof_only",
    summary: reason,
    gaps: [
      "This dry-run did not execute the live in-sandbox agent route; it proves contract shape only, not live behavior, scale, or adoption.",
      "No exec-stream, transcript, substrate, cost, or cleanup artifacts were produced because no live session ran; live verification requires those artifacts."
    ]
  };

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: args.dryRun ? "dry-run" : "live",
    simCount: 1,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    ...(args.lab === undefined ? {} : { lab: args.lab }),
    artifactRoot: path.join(".humanish", "runs", args.runId),
    source: args.source,
    persona: {
      id: args.persona.id,
      name: `Autonomous terminal agent (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    scenario: {
      id: `terminal-${args.labId}`,
      title: args.labTitle ?? `Terminal-product lab: ${args.labId}`,
      // The author mission is public-safe committed lab text — recorded plaintext as the goal,
      // redacted defensively before persisting (it never carries a secret, but the harness never
      // trusts that). The full composed prompt is bound by digest, not text.
      goal: redactText(args.mission),
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    lifecycle: [
      {
        at: args.createdAt,
        event: "terminal-lab.run.created",
        message: `Created terminal-product lab run with one in-sandbox agent lane (actor ${args.actorId}, product ${args.productName}).`
      }
    ],
    simulations: [simulation],
    streams: [stream],
    events,
    redaction: {
      status: "passed",
      notes: "Dry-run contract bundle: no sandbox ran, no key was injected, no exec output was captured. The author mission is public-safe committed lab text (redacted defensively); the composed prompt is bound by digest. The shipped live path applies scrubKnownValues then redactText at the capture source before persistence."
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
}

/**
 * Build the LIVE terminal-product run bundle (mode "live") from the captured session: the actor
 * trace seam (stream.actor = trace), the substrate-lifecycle events, the terminal stream with the
 * redacted transcript tail, and references to the written evidence artifacts (terminal event
 * stream, transcript, ledgers, actor trace). verifyRun's terminal-product check (gated on
 * mode==="live") enforces the ledgers + proven cleanup + interventions-present over this bundle.
 */
export function buildLiveTerminalProductBundle(args: {
  /** Lab provenance for the bundle\'s own `lab` field (#455). */
  lab?: RunLabProvenance;
  actorId: string;
  createdAt: string;
  labId: string;
  labTitle?: string;
  mission: string;
  persona: ActorPersonaRef;
  productName: string;
  publicSurfaces: string[];
  caps?: LabScenarioCaps;
  runtimeAuthKeyName: string;
  runtimeAuth?: LabRuntimeAuth;
  policies: {
    allowPrivateRepoAccess: boolean;
    allowProviderCredentials: boolean;
    allowPaymentCredentials: boolean;
    allowGitHubMutation: boolean;
  };
  runId: string;
  source: RunBundle["source"];
  trace: ActorTrace;
  ledgers: TerminalLedgers;
  sandboxId?: string;
  sessionError?: string;
  sessionReason: string;
}): RunBundle {
  const simStatus: RunSimulationStatus = args.trace.status === "passed"
    ? "passed"
    : args.trace.status === "blocked"
      ? "blocked"
      : args.trace.status === "timed_out"
        ? "timed_out"
        : "failed";
  const messageItem = args.trace.items.find((item) => item.kind === "message");
  const tail = (messageItem?.text ?? args.trace.reason).slice(0, 2000);

  const simulation: RunSimulation = {
    id: "sim-001",
    index: 1,
    personaId: args.persona.id,
    scenarioId: `terminal-${args.labId}`,
    status: simStatus,
    streamKind: "terminal",
    mode: "cli-sim",
    progress: 100,
    currentStep: args.sessionReason,
    summary: `Terminal agent (${args.actorId}) studied ${args.productName} from public surfaces (${args.trace.status}).`,
    streamIds: ["stream-001"],
    startedAt: args.createdAt,
    updatedAt: args.trace.completedAt
  };

  // transport "snapshot": the persisted tail is a redacted snapshot of the captured exec output,
  // NOT an interactive PTY (stdin disabled). The actor trace seam carries the structured evidence.
  const stream: RunStream = {
    id: "stream-001",
    simId: "sim-001",
    kind: "terminal",
    label: `Terminal agent — ${args.labId}`,
    status: simStatus,
    transport: "snapshot",
    updatedAt: args.trace.completedAt,
    embed: { kind: "placeholder", title: `Terminal agent (${args.productName})` },
    terminal: {
      title: `${args.actorId} exec (stdin disabled)`,
      format: "plain",
      stdin: "disabled",
      tail
    },
    ui: {
      intent: `Watch the terminal agent discover and use ${args.productName} from its public surfaces.`,
      state: args.sessionReason
    },
    actor: args.trace,
    artifacts: [
      { label: "run bundle", path: "run.json", kind: "bundle" as const },
      { label: "review", path: "review.md", kind: "review" as const },
      { label: "event log", path: "events.ndjson", kind: "events" as const },
      { label: "actor trace", path: "actor.json", kind: "trace" as const },
      { label: "terminal event stream", path: TERMINAL_EVENTS_ARTIFACT, kind: "log" as const },
      { label: "terminal transcript", path: TERMINAL_TRANSCRIPT_ARTIFACT, kind: "log" as const },
      { label: "terminal ledgers", path: TERMINAL_LEDGERS_ARTIFACT, kind: "log" as const }
    ]
  };

  // Substrate-lifecycle ledger -> bundle events (each already sanitized when recorded).
  const lifecycleEvents: RunEvent[] = args.ledgers.lifecycle.map((record, index) => ({
    id: `event-${String(index).padStart(3, "0")}-${record.event}`,
    at: record.at,
    level: record.event.includes("error") || record.event.includes("timed_out") || record.event.includes("exceeded") ? "warn" : "info",
    type: record.event,
    message: record.message,
    simId: "sim-001",
    streamId: "stream-001"
  }));

  // Surface the no-spend proof as a first-class bundle event so the Observer/review can SHOW it.
  // It is DERIVED from the cost ledger (never asserted): it lists the known-zero lines it vouches
  // for AND the unmeasured (null) lines it explicitly cannot vouch for.
  const noSpend = args.ledgers.noSpendProof;
  lifecycleEvents.push({
    id: "event-cost-no-spend-proof",
    at: args.trace.completedAt,
    level: noSpend.satisfied ? "info" : "warn",
    type: "terminal-lab.no-spend.proof",
    message: noSpend.statement,
    simId: "sim-001",
    streamId: "stream-001"
  });

  const verdict: ReviewSummary["verdict"] = args.trace.status === "passed"
    ? "pass"
    : args.trace.status === "blocked"
      ? "blocked"
      : args.trace.status === "timed_out"
        ? "timed_out"
        : "fail";
  const review: ReviewSummary = {
    schema: REVIEW_SCHEMA,
    verdict,
    summary: args.sessionReason,
    gaps: [
      ...(args.trace.status === "passed" ? [] : [`Agent session ended ${args.trace.status}: ${args.sessionReason}`]),
      // Honesty gap: the no-spend proof always declares which spend lines it could NOT measure, so a
      // green run never silently over-claims a fully-proven $0.
      ...(noSpend.unmeasuredLines.length > 0
        ? [`No-spend proof is partial: ${noSpend.unmeasuredLines.join(", ")} spend was UNMEASURED for this run (recorded null, not claimed zero; an adapter may supply these signals through costProbe).`]
        : [])
    ]
  };

  return {
    schema: RUN_BUNDLE_SCHEMA,
    runId: args.runId,
    mode: "live",
    simCount: 1,
    createdAt: args.createdAt,
    cwd: PUBLIC_TARGET_CWD,
    ...(args.lab === undefined ? {} : { lab: args.lab }),
    artifactRoot: path.join(".humanish", "runs", args.runId),
    source: args.source,
    persona: {
      id: args.persona.id,
      name: `Autonomous terminal agent (${args.persona.id})`,
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    scenario: {
      id: `terminal-${args.labId}`,
      title: args.labTitle ?? `Terminal-product lab: ${args.labId}`,
      goal: redactText(args.mission),
      source: `lab:${args.labId}`,
      sourceDigest: args.persona.promptDigest
    },
    lifecycle: args.ledgers.lifecycle.map((record) => ({ at: record.at, event: record.event, message: record.message })),
    simulations: [simulation],
    streams: [stream],
    events: lifecycleEvents,
    redaction: {
      status: "passed",
      notes: `Live terminal-product run: the in-sandbox agent's output was captured via commands.run onStdout/onStderr and scrubbed (literal known values incl. the runtime key) THEN redacted (shape patterns) AT THE SOURCE before persisting. ${args.runtimeAuth === "openai-egress" ? `Runtime auth openai-egress: the raw key from ${args.runtimeAuthKeyName} is reserved for E2B's external api.openai.com HTTPS header transform. ${args.ledgers.commandLog.some((command) => command.label === "codex-exec") ? "Codex received an inert CODEX_API_KEY placeholder." : "Codex was not launched."} Any created sandbox retains a spendable OpenAI proxy capability until teardown; additional provider calls may not appear in the Codex usage ledger.` : `Runtime auth openai-env: the runtime key (${args.runtimeAuthKeyName}) was injected ONLY into the command-scoped codex invocation, never sandbox-global env or metadata; only its NAME appears in evidence.`} Subject provenance is UNPINNED (public-surface study).`
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
}

function describeCaps(caps: LabScenarioCaps | undefined): string {
  if (!caps) return "none declared (a live run requires caps)";
  const parts: string[] = [];
  if (caps.maxUsd !== undefined) parts.push(`maxUsd=${caps.maxUsd}`);
  if (caps.maxJobs !== undefined) parts.push(`maxJobs=${caps.maxJobs}`);
  if (caps.maxMinutes !== undefined) parts.push(`maxMinutes=${caps.maxMinutes}`);
  return parts.length > 0 ? parts.join(", ") : "empty";
}

/** The default mission when the lab omits one. Public-safe, product-neutral author text. */
function defaultMission(productName: string): string {
  return `You are an autonomous agent. Discover ${productName} from its public surfaces and determine whether it can help with a durable real task. Stay within the declared no-spend caps. Leave feedback if the workflow is confusing.`;
}

const TERMINAL_PERSONA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Title-case a persona id for a fallback display name, e.g. "first-time-visitor" -> "First Time Visitor". */
function personaTitleFromId(personaId: string): string {
  const title = personaId
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return title.length > 0 ? title : personaId;
}

/**
 * Resolve a committed persona (humanish/personas/<id>.yaml) into behavioral directives so the
 * terminal agent runs IN CHARACTER (#308). Fail-SAFE, never fail-closed: an unsafe id, a missing
 * file, or unparseable YAML returns `persona: null`, and the caller keeps the legacy bare-id prompt
 * with a truthful empty traitsApplied — a persona that DECLARED nothing must not receive fabricated
 * traits. Reads are containment-guarded exactly like scenario.ref (readContainedRegularFile).
 */
export async function resolveTerminalPersona(
  projectRoot: PreparedSelectedOutputDirectory,
  personaId: string
): Promise<{ persona: ResolvedPersona | null; warnings: string[] }> {
  if (!TERMINAL_PERSONA_ID_PATTERN.test(personaId)) {
    return { persona: null, warnings: [] };
  }
  const candidates = [
    path.posix.join("humanish", "personas", `${personaId}.yaml`),
    path.posix.join("humanish", "personas", `${personaId}.yml`)
  ];
  for (const candidate of candidates) {
    const bytes = await readContainedRegularFile(projectRoot, candidate);
    if (!bytes) {
      continue;
    }
    let raw: unknown;
    try {
      raw = parseYaml(bytes.toString("utf8"));
    } catch {
      return {
        persona: null,
        warnings: [`${candidate} could not be parsed as YAML; the terminal agent ran with the persona id only (no traits applied).`]
      };
    }
    return { persona: parseResolvedPersona(raw, { id: personaId, name: personaTitleFromId(personaId) }), warnings: [] };
  }
  return { persona: null, warnings: [] };
}

/** Compose the full prompt the agent would run. Bound to evidence by DIGEST only. */
function composePrompt(args: { mission: string; personaLine: string; productName: string; publicSurfaces: string[] }): string {
  return [
    args.personaLine,
    `product: ${args.productName}`,
    `public-surfaces: ${args.publicSurfaces.join(" ")}`,
    `mission: ${args.mission}`
  ].join("\n");
}

function renderTerminalReviewMarkdown(bundle: RunBundle): string {
  const subject = bundle.events.find((event) => event.type === "terminal-lab.subject.declared");
  const credentials = bundle.events.find((event) => event.type === "terminal-lab.credentials.declared");
  const caps = bundle.events.find((event) => event.type === "terminal-lab.caps.declared");
  return [
    `# ${bundle.scenario.title}`,
    "",
    `- run: ${bundle.runId}`,
    `- mode: ${bundle.mode}`,
    `- verdict: ${bundle.review.verdict}`,
    `- summary: ${bundle.review.summary}`,
    `- mission: ${bundle.scenario.goal}`,
    ...(subject ? [`- subject: ${subject.message}`] : []),
    ...(credentials ? [`- credentials: ${credentials.message}`] : []),
    ...(caps ? [`- caps: ${caps.message}`] : []),
    ...(bundle.review.gaps.length > 0 ? ["", "## Gaps", ...bundle.review.gaps.map((gap) => `- ${gap}`)] : []),
    ""
  ].join("\n");
}

function makeTerminalRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `terminal-${stamp}-${randomBytes(4).toString("hex")}`;
}
