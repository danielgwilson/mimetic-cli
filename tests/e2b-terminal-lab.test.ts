import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Sandbox as SdkDesktop } from "@e2b/desktop";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LAB_CONFIG_SCHEMA,
  parseLabConfig,
  type LabConfig,
  type LabRuntimeAuth
} from "../src/lab-config.js";
import { resolveTerminalPersona, runTerminalProductLab, type TerminalProductLabHooks } from "../src/e2b-terminal-lab.js";
import { guardDesktopSandboxCreate, type E2BDesktopCreateOptions, type E2BDesktopModule, type E2BNetworkOptions } from "../src/e2b-desktop-launch.js";
import { E2B_SYSTEM_CA_BUNDLE, OPENAI_EGRESS_PLACEHOLDER } from "../src/terminal-runtime-auth.js";
import { prepareSelectedOutputDirectory } from "../src/selected-output-paths.js";
import { verifyRun } from "../src/run.js";

// SLICE 2 deterministic safety net: drive the REAL live orchestration (dryRun:false) against a
// FAKE E2B module + a MOCK codex CLI at zero spend. The load-bearing assertions are the
// credential-boundary ones — the runtime key reaches ONLY the per-command envs, never
// Sandbox.create envs / metadata / the persisted bundle — because that is the inversion this
// lane introduces and the single most dangerous surface in the project.

// A fake key VALUE the test controls. Deliberately NOT secret-SHAPED (no sk-/ghp_ prefix) so it
// would NOT be caught by pattern redaction alone — only the literal scrub of known provisioned
// values catches it. If it survives into the bundle, the scrub failed.
const FAKE_RUNTIME_KEY = "FAKEKEY-terminal-slice2-do-not-leak-1234567890";

interface RecordedCreate {
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
  network?: E2BNetworkOptions;
}
interface RecordedRun {
  command: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
}

function makeFakeModule(opts: {
  codexBehavior: (cmd: string, run: RecordedRun) => {
    exitCode: number;
    stdout?: string;
    emit?: (onStdout: (d: string) => void, onStderr: (d: string) => void) => void;
    returnedStdout?: string;
    returnedStderr?: string;
  };
  creates: RecordedCreate[];
  createError?: Error;
  runs: RecordedRun[];
  killed: string[];
  /** Records every Sandbox.list(id) call. Teardown must NEVER call it (by-id proof only, never
   *  a re-list); tests assert this array stays empty after a run. */
  listCalls?: string[];
  /** When set, Sandbox.kill(id) THROWS instead of resolving (the "kill itself failed" case ->
   *  fail-closed remaining=-1). */
  killThrows?: (sandboxId: string) => { message?: string } | undefined;
  /** Sandbox.kill(id)'s own resolved boolean ("found and killed", per the real SDK) when it does
   *  not throw. Defaults to true. */
  killResult?: boolean;
  /**
   * Controls Sandbox.getInfo(id): "not-found" throws a SandboxNotFoundError-shaped error (the
   * by-id CONFIRMED-reclaimed case, remaining=0 -- this is the default, matching a genuinely
   * reclaimed sandbox); "running"/"paused" returns a live SandboxInfo (NOT confirmed reclaimed,
   * remaining=1).
   */
  getInfoState?: "not-found" | "running" | "paused";
  /** Omit Sandbox.getInfo entirely, simulating an older SDK (kill(id)'s own boolean becomes the
   *  sole by-id proof). */
  noGetInfo?: boolean;
  /**
   * Throws a CommandExitError-shaped error (real-SDK-accurate: the real @e2b/desktop Sandbox
   * throws on any non-zero exit rather than returning one) for the runtime-bootstrap command.
   * Mirrors tests/cua-actor-lab.test.ts's makeFakeSandbox convention, so the bootstrap-failure
   * path is covered by the THROWING shape, not just a structural non-zero return.
   */
  bootstrapThrow?: (command: string) => { exitCode?: number; stderr?: string; message?: string } | undefined;
  versionProbe?: { exitCode: number; stdout: string } | Error;
}) {
  let counter = 0;
  return {
    Sandbox: {
      // Mirror the real @e2b/desktop overload: create(opts) OR create(template, opts). The terminal
      // route never passes a template, but the fake must accept the overload to type-check.
      async create(
        templateOrOptions: string | RecordedCreate,
        maybeOptions?: RecordedCreate
      ) {
        const options = typeof templateOrOptions === "string" ? (maybeOptions ?? {}) : templateOrOptions;
        counter += 1;
        opts.creates.push({ ...(options.envs ? { envs: options.envs } : {}), ...(options.metadata ? { metadata: options.metadata } : {}), ...(options.network ? { network: options.network } : {}) });
        if (opts.createError) throw opts.createError;
        const sandboxId = `fake-sandbox-${counter}`;
        return {
          sandboxId,
          commands: {
            async run(
              command: string,
              runOptions?: { envs?: Record<string, string>; timeoutMs?: number; onStdout?: (d: string) => void; onStderr?: (d: string) => void }
            ) {
              const rec: RecordedRun = {
                command,
                ...(runOptions?.envs ? { envs: runOptions.envs } : {}),
                ...(runOptions?.timeoutMs === undefined ? {} : { timeoutMs: runOptions.timeoutMs })
              };
              opts.runs.push(rec);
              if (command.endsWith(" --version")) {
                if (opts.versionProbe instanceof Error) throw opts.versionProbe;
                return opts.versionProbe ?? { exitCode: 0, stdout: "codex-cli 0.153.3\n" };
              }
              if (command.includes("codex")) {
                const behavior = opts.codexBehavior(command, rec);
                if (behavior.emit && runOptions?.onStdout) behavior.emit(runOptions.onStdout, runOptions.onStderr ?? (() => {}));
                else if (behavior.stdout && runOptions?.onStdout) runOptions.onStdout(behavior.stdout);
                return {
                  exitCode: behavior.exitCode,
                  ...(behavior.returnedStdout === undefined ? {} : { stdout: behavior.returnedStdout }),
                  ...(behavior.returnedStderr === undefined ? {} : { stderr: behavior.returnedStderr })
                };
              }
              if (command.includes("# humanish terminal-node-bootstrap")) {
                // The UNKEYED runtime-bootstrap command (ensure Node/npm before the keyed exec).
                const thrown = opts.bootstrapThrow?.(command);
                if (thrown) {
                  throw Object.assign(new Error(thrown.message ?? `exit status ${thrown.exitCode ?? 1}`), {
                    name: "CommandExitError",
                    ...(thrown.exitCode === undefined ? {} : { exitCode: thrown.exitCode }),
                    ...(thrown.stderr === undefined ? {} : { stderr: thrown.stderr })
                  });
                }
                return { exitCode: 0, stdout: "" };
              }
              // readiness probe
              if (runOptions?.onStdout) runOptions.onStdout("HUMANISH_SHELL_READY\n");
              return { exitCode: 0, stdout: "HUMANISH_SHELL_READY\n" };
            }
          },
          files: { async write() { return undefined; } },
          async launch() { return undefined; },
          async wait() { return undefined; },
          async screenshot() { return new Uint8Array(); },
          stream: {
            getAuthKey: () => "fake-auth",
            getUrl: () => "https://fake-stream",
            async start() { return undefined; }
          }
        };
      },
      async kill(sandboxId: string) {
        opts.killed.push(sandboxId);
        const thrown = opts.killThrows?.(sandboxId);
        if (thrown) {
          throw Object.assign(new Error(thrown.message ?? "kill failed"), { name: "Error" });
        }
        return opts.killResult ?? true;
      },
      ...(opts.noGetInfo
        ? {}
        : {
            async getInfo(sandboxId: string) {
              const state = opts.getInfoState ?? "not-found";
              if (state === "not-found") {
                // A real reclaimed sandbox: the SDK throws SandboxNotFoundError, detected by
                // `.name` (see isSandboxNotFoundError in src/e2b-desktop-launch.ts).
                throw Object.assign(new Error(`Sandbox ${sandboxId} not found`), { name: "SandboxNotFoundError" });
              }
              return { sandboxId, state };
            }
          }),
      // Kept only for structural parity with the real SDK (older callers, e.g. lab-preflight.ts,
      // still use it for their own purposes). Teardown must NEVER call this -- see listCalls.
      list(_options: unknown) {
        opts.listCalls?.push("called");
        const paginator = {
          hasNext: false,
          async nextItems() { return []; }
        };
        return paginator;
      }
    }
  };
}

// Extract the per-run verdict nonce the lab embedded in the codex command, so the mock can echo
// a NONCE-VERIFIED marker exactly as a real agent would (the scorer rejects a bare marker).
function nonceFrom(command: string): string {
  const m = /HUMANISH_ACTOR_NONCE=([A-Za-z0-9-]+)/.exec(command);
  return m?.[1] ?? "unknown-nonce";
}

function liveConfig(overrides?: { caps?: Record<string, number> | null; runtimeAuth?: LabRuntimeAuth; egressAllow?: string[] }): LabConfig {
  const raw: Record<string, unknown> = {
    schema: LAB_CONFIG_SCHEMA,
    id: "terminal-live-proof",
    title: "Terminal live proof",
    subject: {
      source: "terminal-product",
      product: { name: "widgetsmith-cli", publicSurfaces: ["https://example.com/widgetsmith"] }
    },
    actors: [{ type: "codex-exec", persona: "autonomous-creative-agent", mission: "Discover widgetsmith-cli from public surfaces." }],
    execution: { target: "e2b-terminal", runtimeAuth: overrides?.runtimeAuth ?? "openai-env", ...(overrides?.egressAllow ? { egressAllow: overrides.egressAllow } : {}), timeoutMs: 600_000, terminal: { transport: "exec-stream", stdin: "disabled" } },
    scenario: { mode: "live", ...(overrides && "caps" in overrides ? (overrides.caps ? { caps: overrides.caps } : {}) : { caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } }) },
    policies: { allowPrivateRepoAccess: false, allowProviderCredentials: false, allowPaymentCredentials: false, allowGitHubMutation: false }
  };
  const parsed = parseLabConfig(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function baseEnv(): Record<string, string | undefined> {
  return {
    OPENAI_API_KEY: FAKE_RUNTIME_KEY,
    E2B_API_KEY: "FAKE-E2B-KEY-also-do-not-leak-0987654321",
    // Banned credentials present in the operator env — must NOT be forwarded into the sandbox.
    GITHUB_TOKEN: "FAKE-github-token-name-present-not-forwarded",
    DATABASE_URL: "FAKE-database-url-name-present-not-forwarded",
    STRIPE_SECRET_KEY: "FAKE-stripe-key"
  };
}

// Same real-SDK debug constructor seam as e2b-desktop-create-lease.test.ts. Command/kill
// method ports are local; no provider HTTP responses or hosted allocations are fabricated.
function guardedStartupFailure(phase: "Xvfb" | "startxfce4", killResult: boolean | Error) {
  const killed: number[] = [];
  let constructed = 0;
  class ProbeSandbox extends SdkDesktop {
    constructor(...args: ConstructorParameters<typeof SdkDesktop>) {
      super(...args);
      const instance = ++constructed;
      this.commands.run = (async (command: string) => {
        if (command.includes(phase)) throw new Error(`synthetic ${phase} startup failure`);
        return { exitCode: 0, stdout: "", stderr: "", pid: instance, disconnect: async () => undefined };
      }) as typeof this.commands.run;
      this.kill = async () => {
        killed.push(instance);
        if (killResult instanceof Error) throw killResult;
        return killResult;
      };
    }
  }
  const allocation = vi.spyOn(ProbeSandbox as unknown as {
    createSandbox(...args: unknown[]): Promise<unknown>;
  }, "createSandbox").mockRejectedValue(new Error("provider allocation forbidden"));
  const list = vi.spyOn(ProbeSandbox, "list").mockImplementation(() => { throw new Error("account enumeration forbidden"); });
  const guarded = guardDesktopSandboxCreate({ Sandbox: ProbeSandbox } as unknown as E2BDesktopModule);
  const module: E2BDesktopModule = { Sandbox: {
    create(templateOrOptions: string | E2BDesktopCreateOptions, options?: E2BDesktopCreateOptions) {
      const debugOptions = { ...(typeof templateOrOptions === "string" ? options : templateOrOptions), debug: true } as E2BDesktopCreateOptions;
      return typeof templateOrOptions === "string"
        ? guarded.Sandbox.create(templateOrOptions, debugOptions)
        : guarded.Sandbox.create(debugOptions);
    }
  } };
  return { module, killed, allocation, list, constructed: () => constructed };
}

describe("runTerminalProductLab (live path, deterministic, no spend)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-live-")); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(cwd, { recursive: true, force: true }); });

  it.each([
    ["Xvfb", true], ["startxfce4", true], ["Xvfb", false]
  ] as const)("keeps guarded %s startup failure verifiable after cleanup resolves %s", async (phase, killResult) => {
    const probe = guardedStartupFailure(phase, killResult);
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), loadModule: async () => probe.module
    } });
    expect(result.ok).toBe(false);
    expect(result.session?.completionReason).toBe("harness_error");
    expect(result.error).toMatchObject({ code: "HUMANISH_TERMINAL_LAB_FAILED" });
    expect(result.error?.message).toContain(`synthetic ${phase} startup failure`);
    expect(result.sandbox).toBeUndefined(); // The lane never received a handle or ID.
    expect(probe.constructed()).toBe(1);
    expect(probe.killed).toEqual([1]);
    expect(probe.allocation).not.toHaveBeenCalled();
    expect(probe.list).not.toHaveBeenCalled();
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.cleanup).toMatchObject({ killed: true, remaining: 0 });
    expect(ledgers.cleanup.reason).toContain("startup guard");
    expect(ledgers.cleanup.reason).toContain(killResult ? "killed" : "already gone");
    expect(JSON.stringify(ledgers.lifecycle)).not.toContain("No sandbox was created");
    expect(await readFile(path.join(runDir, "terminal-events.ndjson"), "utf8")).toBe("");
    expect(result.observer?.ok).toBe(true);
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });

  it("keeps unconfirmed guarded cleanup failed closed with the startup cause visible", async () => {
    const probe = guardedStartupFailure("Xvfb", new Error("synthetic-cleanup-secret"));
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), loadModule: async () => probe.module
    } });
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN");
    expect(result.error?.message).toContain("synthetic Xvfb startup failure");
    expect(JSON.stringify(result)).not.toContain("synthetic-cleanup-secret");
    expect(probe.killed).toEqual([1]);
    expect(probe.allocation).not.toHaveBeenCalled();
    expect(probe.list).not.toHaveBeenCalled();
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.cleanup).toMatchObject({ killed: false, remaining: -1 });
    expect((await verifyRun(cwd, result.runId)).ok).toBe(false);
  });

  it("does not infer allocation absence when create rejects before returning a handle", async () => {
    const killed: string[] = [];
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), loadModule: async () => makeFakeModule({ creates: [], runs: [], killed,
        createError: new Error("synthetic create response lost"), codexBehavior: () => { throw new Error("must not execute"); } })
    } });
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN");
    expect(result.error?.message).toContain("synthetic create response lost");
    expect(killed).toEqual([]);
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.cleanup).toMatchObject({ killed: false, remaining: -1 });
    expect(ledgers.cleanup.reason).toContain("no acquired handle");
    expect(JSON.stringify(ledgers.lifecycle)).not.toContain("No sandbox was created");
  });

  it("verifies a zero-output terminal session but rejects missing, contradicted, or unrelated empty evidence", async () => {
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), loadModule: async () => makeFakeModule({ creates: [], runs: [], killed: [], codexBehavior: () => ({ exitCode: 0 }) })
    } });
    expect(result.session?.status).toBe("blocked");
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundlePath = path.join(runDir, "run.json");
    const originalBundle = await readFile(bundlePath, "utf8");
    const tracePath = path.join(runDir, "actor.json");
    const originalTrace = await readFile(tracePath, "utf8");
    const eventsPath = path.join(runDir, "terminal-events.ndjson");
    const missing = async (artifact = "terminal-events.ndjson") => {
      const verified = await verifyRun(cwd, result.runId);
      expect(verified.ok).toBe(false);
      expect(verified.checks.find((check) => check.name === "local evidence artifacts exist")?.message).toContain(artifact);
    };
    await rm(eventsPath);
    await missing();
    await writeFile(eventsPath, "");

    const positiveTrace = JSON.parse(originalTrace);
    positiveTrace.counts.terminalEvents = 1;
    await writeFile(tracePath, JSON.stringify(positiveTrace));
    await missing();
    await writeFile(tracePath, originalTrace);

    for (const mutation of ["positive-count", "missing-count", "nonterminal", "screenshot", "other-log", "shared-reference"]) {
      const bundle = JSON.parse(originalBundle);
      const stream = bundle.streams[0];
      const artifact = stream.artifacts.find((entry: { path: string }) => entry.path === "terminal-events.ndjson");
      if (mutation === "positive-count") stream.actor.counts.terminalEvents = 1;
      if (mutation === "missing-count") delete stream.actor.counts.terminalEvents;
      if (mutation === "nonterminal") stream.actor.protocol = "json-stream";
      if (mutation === "screenshot") artifact.kind = "screenshot";
      if (mutation === "other-log") { artifact.path = "other-empty.log"; await writeFile(path.join(runDir, artifact.path), ""); }
      if (mutation === "shared-reference") bundle.adapterArtifacts = [{ schema: "humanish.adapter-artifact.v1", namespace: "synthetic", label: "other consumer", path: "terminal-events.ndjson", kind: "log", note: "Requires nonempty evidence." }];
      await writeFile(bundlePath, JSON.stringify(bundle));
      await missing(mutation === "other-log" ? "other-empty.log" : undefined);
    }
    await writeFile(bundlePath, originalBundle);
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });

  it("records dry-run runtime declarations without resolving or allocating", async () => {
    const config = liveConfig();
    config.execution!.runtime = { version: "0.153.3" };
    config.actors[0]!.model = "gpt-5.6-sol";
    const result = await runTerminalProductLab({ cwd, config, dryRun: true, open: false, hooks: {
      loadModule: async () => { throw new Error("must not resolve or allocate"); }
    } });
    expect(result.ok).toBe(true);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    const event = bundle.events.find((entry: { type: string }) => entry.type === "terminal-lab.runtime.declared");
    expect(JSON.parse(event.message)).toMatchObject({ requestedVersion: "0.153.3", versionStatus: "unobserved", requestedModel: "gpt-5.6-sol", modelStatus: "declared" });
    expect(JSON.parse(event.message).observedVersion).toBeUndefined();
  });

  it("pins the observed executable, forwards declared model/effort, and preserves additive provenance", async () => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const config = liveConfig();
    config.execution!.runtime = { version: "0.153.3" };
    config.actors[0]!.model = "gpt-5.6-sol";
    config.actors[0]!.reasoningEffort = "low";
    const result = await runTerminalProductLab({ cwd, config, dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => ({
        exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`
      }) })
    } });
    expect(result.ok).toBe(true);
    const probeIndex = runs.findIndex((r) => r.command.endsWith(" --version"));
    const execIndex = runs.findIndex((r) => r.command.includes(" exec "));
    expect(probeIndex).toBeLessThan(execIndex);
    expect(runs[probeIndex]).toMatchObject({ timeoutMs: 60_000 });
    expect(runs[probeIndex]?.envs).toBeUndefined();
    expect(runs[probeIndex]?.command).toContain("@openai/codex@0.153.3 --version");
    expect(runs[execIndex]?.command).toContain("@openai/codex@0.153.3 exec --model 'gpt-5.6-sol' -c 'model_reasoning_effort=\"low\"'");
    const dir = path.join(cwd, ".humanish", "runs", result.runId);
    const actor = JSON.parse(await readFile(path.join(dir, "actor.json"), "utf8"));
    const ledgers = JSON.parse(await readFile(path.join(dir, "terminal-ledgers.json"), "utf8"));
    const bundle = JSON.parse(await readFile(path.join(dir, "run.json"), "utf8"));
    expect(actor.providerVersion).toBe("0.153.3");
    expect(actor.runtime).toEqual({
      schema: "humanish.actor-runtime.v1", package: "@openai/codex", requestedVersion: "0.153.3", observedVersion: "0.153.3",
      versionStatus: "verified", requestedModel: "gpt-5.6-sol", modelStatus: "declared", requestedReasoningEffort: "low", usageGranularity: "runtime_turn"
    });
    expect(ledgers.runtime).toEqual(actor.runtime);
    expect(bundle.streams[0].actor.runtime).toEqual(actor.runtime);
    expect(actor.ids.model).toBeUndefined(); // No provider model response was inspected.
    expect(ledgers.cost.lines.provider.usd).toBeNull(); // Declaration is not an observed charge.
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });

  it.each([
    { exitCode: 0, stdout: "codex-cli 0.153.2\n" },
    { exitCode: 0, stdout: "unrecognized output\n" },
    { exitCode: 1, stdout: "codex-cli 0.153.3\n" },
    new Error("Synthetic version probe timeout")
  ])("cleans the owned sandbox without a keyed exec after version failure %j", async (versionProbe) => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const config = liveConfig();
    config.execution!.runtime = { version: "0.153.3" };
    const result = await runTerminalProductLab({ cwd, config, dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, versionProbe, codexBehavior: () => { throw new Error("must not execute"); } })
    } });
    expect(result.ok).toBe(false);
    expect(killed).toEqual(["fake-sandbox-1"]);
    expect(runs.some((r) => r.envs?.CODEX_API_KEY)).toBe(false);
    const actor = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "actor.json"), "utf8"));
    expect(actor.runtime.versionStatus).toBe("failed");
    expect(actor.runtime.modelStatus).toBe("runtime_default_unobserved");
    expect(actor.ids.model).toBeUndefined();
    expect(actor.providerVersion).toBeUndefined();
  });

  it("rejects a bad pin at the exported engine before loading or allocating", async () => {
    const config = liveConfig();
    config.execution!.runtime = { version: "latest; unexpected-command" };
    const result = await runTerminalProductLab({ cwd, config, dryRun: false, open: false, hooks: {
      env: baseEnv(), loadModule: async () => { throw new Error("must not load or allocate"); }
    } });
    expect(result.runId).toBe("not-created");
    expect(result.error?.message).toContain("exact Codex version");
  });

  // Captured verbatim from the real Codex event shape on 2026-09-05. This record has no
  // identifiers or participant prose. The E2B callback/returned-stdout duplication is proven
  // byte-for-byte in docs/goals/terminal-product-lane/receipts/2026-09-05-runtime-egress-auth.md.
  const capturedUsage = '{"type":"turn.completed","usage":{"input_tokens":94325,"cached_input_tokens":55936,"cache_write_input_tokens":0,"output_tokens":1407,"reasoning_output_tokens":864}}\n';

  it.each(["returned-only", "callbacks-only", "split-before-quote"] as const)("preserves nested JSON and report extraction through %s delivery", async (delivery) => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const localPath = ["", "tmp", "synthetic-workspace"].join("/");
    // Live message envelope captured on 2026-09-05; all variable content is synthetic.
    const report = { type: "item.completed", item: {
      id: "synthetic-message", type: "agent_message", text: `I opened "${localPath}".`
    } };
    const nested = JSON.stringify({ payload: JSON.stringify({ cwd: localPath, ok: true }) });
    const records = `${JSON.stringify(report)}\n${nested}\n`;
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => {
        const output = `${records}HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`;
        return { exitCode: 0, emit: (stdout) => {
          if (delivery === "returned-only") return;
          if (delivery === "split-before-quote") {
            const at = output.indexOf(localPath) + localPath.length + 1;
            stdout(output.slice(0, at));
            stdout(output.slice(at));
          } else stdout(output);
        }, ...(delivery === "callbacks-only" ? {} : { returnedStdout: output }) };
      } })
    } });
    const transcript = await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-transcript.txt"), "utf8");
    const events = transcript.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0].item.text).toBe('I opened "[REDACTED_LOCAL_PATH]".');
    expect(JSON.parse(events[1].payload)).toEqual({ cwd: "[REDACTED_LOCAL_PATH]", ok: true });
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });

  it.each(["streamed-and-returned", "returned-only", "partial-prefix", "callbacks-only"] as const)("counts captured usage once for %s delivery and preserves actual repeated lines", async (delivery) => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const repeated = "I checked the same control again.\n";
    const prefix = `Visible unicode: café 🧭\n${repeated}${repeated}known value ${FAKE_RUNTIME_KEY}\n`;
    const result = await runTerminalProductLab({ cwd, config: liveConfig({ caps: { maxUsd: 1, maxMinutes: 1 } }), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => {
        const output = `${prefix}${capturedUsage}HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`;
        return {
          exitCode: 0,
          emit: (stdout) => {
            if (delivery === "returned-only") return;
            stdout(prefix);
            if (delivery !== "partial-prefix") stdout(output.slice(prefix.length));
          },
          ...(delivery === "callbacks-only" ? {} : { returnedStdout: output })
        };
      } })
    } });
    expect(result.ok).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const transcript = await readFile(path.join(runDir, "terminal-transcript.txt"), "utf8");
    expect(transcript.split(repeated).length - 1).toBe(2);
    expect(transcript).toContain("Visible unicode: café 🧭");
    expect(transcript).not.toContain(FAKE_RUNTIME_KEY);
    expect(transcript).toContain("[REDACTED_SECRET]");
    const actor = JSON.parse(await readFile(path.join(runDir, "actor.json"), "utf8"));
    expect(actor.tokenUsage.turns).toHaveLength(1);
    expect(actor.tokenUsage.input).toBe(94325);
    expect(actor.tokenUsage.cachedInput).toBe(55936);
    expect(actor.tokenUsage.output).toBe(1407);
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });

  it.each(["partial-prefix", "complete-replay", "callbacks-only"] as const)("redacts a known key split across delivery chunks (%s)", async (delivery) => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => ({
        exitCode: 0,
        emit: (stdout, stderr) => {
          stdout(`key was ${FAKE_RUNTIME_KEY.slice(0, 10)}`);
          stderr("an interleaved diagnostic\n");
          stdout(FAKE_RUNTIME_KEY.slice(10, -1));
          if (delivery !== "partial-prefix") stdout(`${FAKE_RUNTIME_KEY.slice(-1)}\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`);
        },
        ...(delivery === "callbacks-only" ? {} : { returnedStdout: `key was ${FAKE_RUNTIME_KEY}\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      }) })
    } });
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const events = (await readFile(path.join(runDir, "terminal-events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const stdout = events.filter((event) => event.stream === "stdout").map((event) => event.chunk).join("");
    expect(stdout).not.toContain(FAKE_RUNTIME_KEY);
    expect(stdout).not.toContain(FAKE_RUNTIME_KEY.slice(0, -1));
    expect(stdout).toContain("[REDACTED_SECRET]");
    expect(events.some((event) => event.chunk.includes("an interleaved diagnostic"))).toBe(true);
    for (const file of ["run.json", "actor.json", "terminal-transcript.txt", "terminal-events.ndjson"]) {
      expect(await readFile(path.join(runDir, file), "utf8")).not.toContain(FAKE_RUNTIME_KEY);
    }
  });

  it("scrubs multiple split known values without losing surrounding repeated text", async () => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const e2bKey = baseEnv().E2B_API_KEY as string;
    let expected = "";
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => {
        const output = `repeat\n${FAKE_RUNTIME_KEY} between ${e2bKey} after ${FAKE_RUNTIME_KEY}\nrepeat\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`;
        expected = output.split(FAKE_RUNTIME_KEY).join("[REDACTED_SECRET]").split(e2bKey).join("[REDACTED_SECRET]");
        return { exitCode: 0, emit: (stdout) => {
          for (let at = 0; at < output.length; at += 7) stdout(output.slice(at, at + 7));
        }, returnedStdout: output };
      } })
    } });
    const events = (await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.chunk).join("")).toBe(expected);
  });

  it.each(["partial-prefix", "complete-replay", "callbacks-only"] as const)("redacts the retained key prefix when its completion is beyond the capture cap (%s)", async (delivery) => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => {
        const prefix = `${"x".repeat(512 * 1024 - 20)}${FAKE_RUNTIME_KEY.slice(0, -1)}`;
        const suffix = `${FAKE_RUNTIME_KEY.slice(-1)}\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`;
        return {
          exitCode: 0,
          emit: (stdout, stderr) => {
            stdout(prefix);
            if (delivery !== "partial-prefix") {
              stderr("discarded interleaved diagnostic\n");
              stdout(suffix.slice(0, 1));
              stdout(suffix.slice(1));
            }
          },
          ...(delivery === "callbacks-only" ? {} : { returnedStdout: `${prefix}${suffix}` })
        };
      } })
    } });
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["terminal-transcript.txt", "terminal-events.ndjson", "actor.json"]) {
      expect(await readFile(path.join(runDir, file), "utf8")).not.toContain(FAKE_RUNTIME_KEY.slice(0, -1));
    }
    const transcript = await readFile(path.join(runDir, "terminal-transcript.txt"), "utf8");
    expect(transcript).toContain("[REDACTED_SECRET]");
    expect(transcript).not.toContain("HUMANISH_ACTOR_NONCE=");
    expect(transcript).not.toContain("discarded interleaved diagnostic");
  });

  it.each([false, true])("scrubs a known key assembled across stdout and stderr in transcript order (capped=%s)", async (capped) => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const padding = capped ? "x".repeat(512 * 1024) : "";
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => ({
        exitCode: 0,
        emit: (stdout, stderr) => {
          stdout(`${padding}${FAKE_RUNTIME_KEY.slice(0, 10)}`);
          stderr(FAKE_RUNTIME_KEY.slice(10, 20));
          stdout(FAKE_RUNTIME_KEY.slice(20));
          stdout(`\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`);
        }
      }) })
    } });
    const events = (await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const transcriptOrder = events.map((event) => event.chunk).join("");
    expect(transcriptOrder).not.toContain(FAKE_RUNTIME_KEY.slice(0, 10));
    expect(transcriptOrder).toContain("[REDACTED_SECRET]");
    if (!capped) expect(events.map((event) => event.stream)).toEqual(["stdout", "stderr", "stdout", "stdout"]);
  });

  it("retains legitimate equal-valued usage turns inside one complete delivery", async () => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => {
        const output = `${capturedUsage}${capturedUsage}HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`;
        return { exitCode: 0, stdout: output, returnedStdout: output };
      } })
    } });
    const actor = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "actor.json"), "utf8"));
    expect(actor.tokenUsage.turns).toHaveLength(2);
    expect(actor.tokenUsage.input).toBe(188650);
  });

  it("reconciles stderr independently and preserves a returned-only stdout with the same text", async () => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const shared = `Same visible line on both streams: ${FAKE_RUNTIME_KEY}\n`;
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => ({
        exitCode: 0,
        emit: (_stdout, stderr) => { stderr(shared); },
        returnedStderr: `${shared}stderr final tail\n`,
        returnedStdout: `${shared}HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`
      }) })
    } });
    const events = (await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const output = (stream: string): string => events.filter((event) => event.stream === stream).map((event) => event.chunk).join("");
    expect(output("stdout").split("Same visible line").length - 1).toBe(1);
    expect(output("stderr").split("Same visible line").length - 1).toBe(1);
    expect(output("stderr")).toContain("stderr final tail");
    expect(JSON.stringify(events)).not.toContain(FAKE_RUNTIME_KEY);
  });

  it("keeps nonmatching returned output instead of guessing away repeated participant text", async () => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => ({
        exitCode: 0,
        stdout: "first callback\nrepeat this line\n",
        returnedStdout: `repeat this line\nfinal output\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`
      }) })
    } });
    const transcript = await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-transcript.txt"), "utf8");
    expect(transcript.split("repeat this line").length - 1).toBe(2);
    expect(transcript).toContain("first callback");
    expect(transcript).toContain("final output");
  });

  it("does not spend the transcript cap twice on replayed stdout and drop returned-only stderr", async () => {
    const creates: RecordedCreate[] = [], runs: RecordedRun[] = [], killed: string[] = [];
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => {
        const output = `${"x".repeat(500 * 1024)}\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`;
        return { exitCode: 0, stdout: output, returnedStdout: output, returnedStderr: "important final diagnostic\n" };
      } })
    } });
    const transcript = await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-transcript.txt"), "utf8");
    expect(transcript).toContain("important final diagnostic");
    expect(Buffer.byteLength(transcript)).toBeLessThan(512 * 1024);
  });

  it.each([undefined, ["api.openai.com", "example.com"]])("openai-egress keeps the raw key outside sandbox commands and preserves routing %j", async (egressAllow) => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const config = liveConfig({ runtimeAuth: "openai-egress", ...(egressAllow ? { egressAllow } : {}) });
    const result = await runTerminalProductLab({ cwd, config, dryRun: false, open: false, hooks: {
      env: { ...baseEnv(), OPENAI_BASE_URL: "https://example.com/custom-provider" },
      now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: (cmd) => ({
        exitCode: 0,
        // Output echoes a known value to exercise literal scrubbing even with external placement.
        stdout: `I used the public docs. echoed value: ${FAKE_RUNTIME_KEY}\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`
      }) })
    } });
    expect(result.ok).toBe(true);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.envs).toBeUndefined();
    expect(creates[0]?.network).toEqual({
      ...(egressAllow ? { allowOut: egressAllow, denyOut: ["0.0.0.0/0"] } : {}),
      rules: { "api.openai.com": [{ transform: { headers: { Authorization: `Bearer ${FAKE_RUNTIME_KEY}` } } }] }
    });
    expect(JSON.stringify(creates[0]?.metadata)).not.toContain(FAKE_RUNTIME_KEY);
    const codexRun = runs.find((r) => r.command.includes(" exec "));
    expect(codexRun?.envs).toEqual({ CODEX_API_KEY: OPENAI_EGRESS_PLACEHOLDER, CODEX_CA_CERTIFICATE: E2B_SYSTEM_CA_BUNDLE, HUMANISH_STUDY_PARTICIPANT: "1" });
    expect(codexRun?.command).toContain(`-c 'model_provider="openai"' -c 'openai_base_url="https://api.openai.com/v1"'`);
    expect(JSON.stringify(runs)).not.toContain(FAKE_RUNTIME_KEY);
    expect(JSON.stringify(runs)).not.toContain("https://example.com/custom-provider");
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["run.json", "terminal-events.ndjson", "terminal-transcript.txt", "terminal-ledgers.json", "actor.json", "events.ndjson", "review.json", "review.md"]) {
      expect(await readFile(path.join(runDir, file), "utf8")).not.toContain(FAKE_RUNTIME_KEY);
    }
    const trace = JSON.parse(await readFile(path.join(runDir, "actor.json"), "utf8"));
    expect(trace.capabilities.keyPlacement).toBe("external");
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.redaction.notes).toContain("Runtime auth openai-egress");
    expect(bundle.redaction.notes).toContain("spendable OpenAI proxy capability");
    expect(result.warnings.join("\n")).toContain("extra provider calls may be absent");
    expect(killed).toHaveLength(1);
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });

  it("scrubs the external runtime key from a sandbox-creation failure", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const result = await runTerminalProductLab({ cwd, config: liveConfig({ runtimeAuth: "openai-egress" }), dryRun: false, open: false, hooks: {
      env: baseEnv(), now: () => 1_000,
      loadModule: async () => makeFakeModule({ creates, runs, killed,
        createError: new Error(`request rejected: Authorization: Bearer ${FAKE_RUNTIME_KEY}`),
        codexBehavior: () => { throw new Error("must not execute"); }
      })
    } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(FAKE_RUNTIME_KEY);
    expect(runs).toHaveLength(0);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["run.json", "terminal-events.ndjson", "terminal-transcript.txt", "terminal-ledgers.json", "actor.json", "events.ndjson", "review.json", "review.md"]) {
      expect(await readFile(path.join(runDir, file), "utf8")).not.toContain(FAKE_RUNTIME_KEY);
    }
    expect(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8")).toContain("[REDACTED_SECRET]");
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.redaction.notes).toContain("Codex was not launched.");
    expect(bundle.redaction.notes).not.toContain("Codex received");
  });

  it("injects the runtime key ONLY command-scoped, never into Sandbox.create or metadata or the bundle", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 1_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        codexBehavior: (cmd) => ({
          exitCode: 0,
          // A real agent echoes the nonce-verified verdict AND some output — INCLUDING the key value
          // (simulating an agent that transcribed its key into output). The scrub must catch it.
          stdout: `working on it... key seen: ${FAKE_RUNTIME_KEY}\nHUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n`
        })
      })
    };

    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });

    // Sandbox created + killed; cleanup proven BY EXACT ID (getInfo(id) confirms
    // SandboxNotFoundError). Sandbox.list is NEVER called on the teardown path.
    expect(creates.length).toBe(1);
    expect(killed.length).toBe(1);
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(listCalls.length).toBe(0);

    // CREDENTIAL BOUNDARY: Sandbox.create carried NO envs (key never sandbox-global) and no key in metadata.
    expect(creates[0]?.envs).toBeUndefined();
    expect(JSON.stringify(creates[0]?.metadata ?? {})).not.toContain(FAKE_RUNTIME_KEY);

    // The codex command run carried the key in its OWN envs (command-scoped) — and ONLY the runtime key.
    const codexRun = runs.find((r) => r.command.includes(" exec "));
    // Pinned via npx, never an ambient/preinstalled `codex` binary (issue #159).
    expect(codexRun?.command).toContain("npx -y @openai/codex@0.153.3 exec");
    expect(codexRun?.command).not.toContain("codex exec"); // never the bare ambient-binary form
    // codex's inner sandbox is bypassed: the E2B sandbox is the trust boundary.
    expect(codexRun?.command).toContain("--dangerously-bypass-approvals-and-sandbox");
    // Preference order: only OPENAI_API_KEY was set, so its value is injected under BOTH names,
    // so codex exec's documented single-invocation auth channel (CODEX_API_KEY) is populated too.
    expect(codexRun?.envs?.OPENAI_API_KEY).toBe(FAKE_RUNTIME_KEY);
    expect(codexRun?.envs?.CODEX_API_KEY).toBe(FAKE_RUNTIME_KEY);
    // The key names, plus the study-participant marker that rides the same command (#546): a
    // participant's own humanish telemetry must not read as a new adopter.
    expect(Object.keys(codexRun?.envs ?? {}).slice().sort()).toEqual(["CODEX_API_KEY", "HUMANISH_STUDY_PARTICIPANT", "OPENAI_API_KEY"]);
    // Deny-by-default: no banned credential reached the command envs.
    expect(codexRun?.envs).not.toHaveProperty("GITHUB_TOKEN");
    expect(codexRun?.envs).not.toHaveProperty("DATABASE_URL");
    expect(codexRun?.envs).not.toHaveProperty("STRIPE_SECRET_KEY");

    // The planted key value must be SCRUBBED out of every persisted artifact.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.simulations[0]?.progress).toBe(100);
    expect(bundle.streams[0].actor.runtime).toMatchObject({ requestedVersion: "latest", observedVersion: "0.153.3", versionStatus: "verified", modelStatus: "runtime_default_unobserved" });
    expect(bundle.streams[0].actor.ids.model).toBeUndefined();
    for (const file of ["run.json", "terminal-events.ndjson", "terminal-transcript.txt", "terminal-ledgers.json", "actor.json", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text).not.toContain(FAKE_RUNTIME_KEY);
      expect(text).not.toContain("FAKE-github-token-name-present-not-forwarded");
    }
    // The event stream actually captured output (scrubbed): the sentinel marker is gone, the
    // redaction placeholder is present.
    const events = await readFile(path.join(runDir, "terminal-events.ndjson"), "utf8");
    expect(events).toContain("[REDACTED_SECRET]");

    // The bundle verifies independently, including the new terminal-product evidence check.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(true);

    // Agent verdict surfaced as evidence; interventions ledger present + empty.
    expect(result.session?.status).toBe("passed");
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    expect(Array.isArray(ledgers.interventions)).toBe(true);
    expect(ledgers.interventions.length).toBe(0);
    expect(ledgers.cleanup.killed).toBe(true);
    // The recorded env-name metadata lists exactly the names actually injected.
    const codexEntry = ledgers.commandLog.find((entry: { label: string }) => entry.label === "codex-exec");
    expect(codexEntry?.envNames.slice().sort()).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
  });

  it("runs the runtime bootstrap UNKEYED, before the keyed codex exec, with an explicit generous timeout", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 4_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });

    const readinessIndex = runs.findIndex((r) => r.command.includes("HUMANISH_SHELL_READY"));
    const bootstrapIndex = runs.findIndex((r) => r.command.includes("# humanish terminal-node-bootstrap"));
    const codexIndex = runs.findIndex((r) => r.command.includes(" exec "));
    expect(readinessIndex).toBeGreaterThanOrEqual(0);
    expect(bootstrapIndex).toBeGreaterThan(readinessIndex);
    expect(codexIndex).toBeGreaterThan(bootstrapIndex);

    // UNKEYED: the runtime-bootstrap command carries no envs at all (no runtime key touches it).
    expect(runs[bootstrapIndex]?.envs).toBeUndefined();
    // Explicit generous timeout: the SDK's commands.run default (60s) can be too short for a verified runtime download.
    expect(runs[bootstrapIndex]?.timeoutMs).toBe(300_000);

    expect(result.session?.status).toBe("passed");
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    const bootstrapEvent = ledgers.lifecycle.find((entry: { event: string }) => entry.event === "terminal-lab.runtime.bootstrapped");
    expect(bootstrapEvent).toBeDefined();
    expect(String(bootstrapEvent?.message)).not.toMatch(/FAILED/);
  });

  it("fails the lane closed via a structured error (not a raw throw) when the runtime bootstrap command throws a CommandExitError", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 5_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        // If this ever runs, the lane failed to fail closed on the bootstrap error first.
        codexBehavior: () => ({ exitCode: 0, stdout: "HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=should-not-run\n" }),
        // Real-SDK-accurate: the real @e2b/desktop Sandbox THROWS a CommandExitError on a
        // non-zero exit rather than returning one; cover the THROWING shape, not just a
        // structural non-zero return.
        bootstrapThrow: () => ({ exitCode: 1, stderr: "sudo: a password is required" })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });

    // The keyed exec is NEVER attempted once the runtime bootstrap has failed.
    expect(runs.some((r) => r.command.includes(" exec "))).toBe(false);

    // Fails closed as a structured lane result: the run completes (no unhandled throw escapes
    // the lane), is recorded as a harness error, and cleanup still runs.
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_LAB_FAILED");
    expect(result.session?.status).toBe("failed");
    expect(result.session?.completionReason).toBe("harness_error");
    expect(killed.length).toBe(1);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const ledgers = JSON.parse(await readFile(path.join(runDir, "terminal-ledgers.json"), "utf8"));
    const bootstrapEvent = ledgers.lifecycle.find((entry: { event: string }) => entry.event === "terminal-lab.runtime.bootstrapped");
    expect(bootstrapEvent).toBeDefined();
    expect(String(bootstrapEvent?.message)).toMatch(/FAILED/);
    expect(ledgers.cleanup.killed).toBe(true);
  });

  it("fails closed BEFORE creating a sandbox when no fail-closed cap is in force", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      loadModule: async () => makeFakeModule({ creates, runs, killed, codexBehavior: () => ({ exitCode: 0 }) })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig({ caps: null }), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_LAB_CAPS_MISSING");
    expect(creates.length).toBe(0); // the live key is never exercised without a cap
  });

  it("keeps a BLOCKED agent run (no verified verdict) structurally verifiable", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 2_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        // Exits 0 but emits NO nonce-verified verdict marker -> blocked evidence, not a hollow pass.
        codexBehavior: () => ({ exitCode: 0, stdout: "I could not find the product docs.\n" })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.session?.status).toBe("blocked");
    expect(killed.length).toBe(1);
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true); // the failure is the evidence; ledgers + cleanup present
    expect(verified.checks.find((c) => c.name === "terminal-product evidence")?.ok).toBe(true);
  });

  it("fails closed when teardown cannot be proven by id (Sandbox.getInfo(id) still reports the sandbox running)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        // kill(id) resolves, but getInfo(id) STILL reports the sandbox running -> not confirmed
        // reclaimed by id. Never a re-list.
        getInfoState: "running",
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN");
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining).toBe(1);
    expect(killed.length).toBe(1);
    expect(listCalls.length).toBe(0);
  });

  it("fails closed when Sandbox.kill(id) itself throws (remaining=-1, never a re-list)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_500,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        killThrows: () => ({ message: "provider timeout killing sandbox" }),
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN");
    expect(result.sandbox?.killed).toBe(false);
    expect(result.sandbox?.remaining).toBe(-1);
    expect(listCalls.length).toBe(0);
  });

  it("confirms reclamation by id when Sandbox.getInfo(id) throws SandboxNotFoundError (remaining=0, never a re-list)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_700,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        getInfoState: "not-found", // the exact sandbox no longer exists -> confirmed reclaimed
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(listCalls.length).toBe(0);
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.cleanup.reason).toMatch(/SandboxNotFoundError/);
  });

  it("falls back to kill(id)'s own boolean as proof when the installed SDK has no Sandbox.getInfo (never a re-list)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_900,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        noGetInfo: true, // an older SDK: kill(id) returning true is the sole by-id proof
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);
    expect(result.sandbox?.killed).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(listCalls.length).toBe(0);
  });

  it("treats kill(id) returning false (404: exact id already gone) as confirmed reclaimed, no getInfo (never a re-list)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_950,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        noGetInfo: true,
        // The server-side kill-on-timeout raced ahead: the exact sandbox is already gone, so
        // kill(id) returns false (404). That is proof of absence, not an unproven teardown.
        killResult: false,
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(listCalls.length).toBe(0);
  });

  it("treats kill(id)=false confirmed by getInfo SandboxNotFoundError as reclaimed (remaining=0)", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const listCalls: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 3_960,
      loadModule: async () => makeFakeModule({
        creates, runs, killed, listCalls,
        killResult: false,
        getInfoState: "not-found",
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);
    expect(result.sandbox?.remaining).toBe(0);
    expect(listCalls.length).toBe(0);
  });
});

describe("runtime-auth key allowlist preference (CODEX_API_KEY over OPENAI_API_KEY)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-live-authorder-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("injects CODEX_API_KEY alone when only CODEX_API_KEY is set", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const env = baseEnv();
    delete env.OPENAI_API_KEY;
    env.CODEX_API_KEY = FAKE_RUNTIME_KEY;
    const hooks: TerminalProductLabHooks = {
      env,
      now: () => 6_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    const codexRun = runs.find((r) => r.command.includes(" exec "));
    expect(codexRun?.envs).toEqual({ CODEX_API_KEY: FAKE_RUNTIME_KEY, HUMANISH_STUDY_PARTICIPANT: "1" });
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.commandLog[0]?.envNames).toEqual(["CODEX_API_KEY"]);
  });

  it("injects the value under BOTH CODEX_API_KEY and OPENAI_API_KEY when only OPENAI_API_KEY is set", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(), // OPENAI_API_KEY only, no CODEX_API_KEY
      now: () => 7_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    const codexRun = runs.find((r) => r.command.includes(" exec "));
    expect(codexRun?.envs).toEqual({ CODEX_API_KEY: FAKE_RUNTIME_KEY, OPENAI_API_KEY: FAKE_RUNTIME_KEY, HUMANISH_STUDY_PARTICIPANT: "1" });
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.commandLog[0]?.envNames.slice().sort()).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
  });

  it("prefers CODEX_API_KEY's value when both CODEX_API_KEY and OPENAI_API_KEY are set", async () => {
    const creates: RecordedCreate[] = [];
    const runs: RecordedRun[] = [];
    const killed: string[] = [];
    const env = baseEnv();
    env.CODEX_API_KEY = "FAKEKEY-codex-wins-0000000000000000";
    const hooks: TerminalProductLabHooks = {
      env,
      now: () => 8_000,
      loadModule: async () => makeFakeModule({
        creates, runs, killed,
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };
    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    const codexRun = runs.find((r) => r.command.includes(" exec "));
    expect(codexRun?.envs).toEqual({ CODEX_API_KEY: "FAKEKEY-codex-wins-0000000000000000", HUMANISH_STUDY_PARTICIPANT: "1" });
    const ledgers = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "terminal-ledgers.json"), "utf8"));
    expect(ledgers.commandLog[0]?.envNames).toEqual(["CODEX_API_KEY"]);
  });
});

describe("terminal persona traits (#308)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-tp-persona-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  const projectRootFor = (dir: string) => prepareSelectedOutputDirectory(path.dirname(dir), dir);

  it("applies committed persona traits to the agent prompt AND records them in the actor trace", async () => {
    await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "personas", "autonomous-creative-agent.yaml"),
      [
        "id: autonomous-creative-agent",
        "name: Autonomous Creative Agent",
        "traits:",
        "  patience: low",
        "  technical_confidence: high",
        "  accessibility_needs: keyboard-only",
        "constraints:",
        "  - Only use public surfaces",
        ""
      ].join("\n"),
      "utf8"
    );

    const runs: RecordedRun[] = [];
    const hooks: TerminalProductLabHooks = {
      env: baseEnv(),
      now: () => 1_000,
      loadModule: async () => makeFakeModule({
        creates: [], runs, killed: [], listCalls: [],
        codexBehavior: (cmd) => ({ exitCode: 0, stdout: `HUMANISH_ACTOR_VERDICT=passed HUMANISH_ACTOR_NONCE=${nonceFrom(cmd)}\n` })
      })
    };

    const result = await runTerminalProductLab({ cwd, config: liveConfig(), dryRun: false, open: false, hooks });
    expect(result.ok).toBe(true);

    // The persona's low-patience directive reached the agent's ACTUAL composed prompt.
    const codexRun = runs.find((r) => r.command.includes(" exec "));
    expect(codexRun?.command).toContain("impatient");
    expect(codexRun?.command).not.toContain("persona: autonomous-creative-agent");

    // The actor trace records WHICH traits took effect — no longer the hardcoded [].
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    const traitsApplied = bundle.streams[0]?.actor?.persona?.traitsApplied ?? [];
    expect(traitsApplied).toContain("patience:low");
    expect(traitsApplied).toContain("skill:high");
    expect(traitsApplied).toContain("accessibility:keyboard-only");
  });

  it("resolveTerminalPersona resolves a committed persona file into traits", async () => {
    await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "personas", "careful-reviewer.yaml"),
      "id: careful-reviewer\nname: Careful Reviewer\ntraits:\n  patience: high\n  technical_confidence: low\n",
      "utf8"
    );
    const { persona, warnings } = await resolveTerminalPersona(await projectRootFor(cwd), "careful-reviewer");
    expect(warnings).toEqual([]);
    expect(persona?.traits.patience).toBe("high");
    expect(persona?.traits.skill).toBe("low");
  });

  it("resolveTerminalPersona returns null (truthful empty traits) when no persona file is committed", async () => {
    const { persona, warnings } = await resolveTerminalPersona(await projectRootFor(cwd), "autonomous-terminal-agent");
    expect(persona).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("resolveTerminalPersona never builds a path from an unsafe persona id", async () => {
    const { persona } = await resolveTerminalPersona(await projectRootFor(cwd), "../../etc/passwd");
    expect(persona).toBeNull();
  });

  it("resolveTerminalPersona warns and falls back on unparseable persona YAML", async () => {
    await mkdir(path.join(cwd, "humanish", "personas"), { recursive: true });
    await writeFile(path.join(cwd, "humanish", "personas", "broken.yaml"), "traits: {patience: low", "utf8");
    const { persona, warnings } = await resolveTerminalPersona(await projectRootFor(cwd), "broken");
    expect(persona).toBeNull();
    expect(warnings.join(" ")).toContain("could not be parsed as YAML");
  });
});
