import { DEVICE_PRESETS } from "../src/device-presets.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { symlinkSync, unlinkSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";

import type { ActorCapabilities, ActorTrace } from "../src/actor-contract.js";
import { ACTOR_TRACE_SCHEMA } from "../src/actor-contract.js";
import { runCuaActorSession, type CuaActorSessionOptions } from "../src/computer-use-actor.js";
import type {
  CuaAction,
  CuaExecutor,
  CuaLoopResult,
  CuaObservation,
  CuaProvider,
  CuaTurn
} from "../src/computer-use.js";
import {
  CUA_ACTOR_LAB_PROVIDER_METADATA,
  buildCuaBundle,
  buildCuaCostSummary,
  makeChromeBrowserStateObserver,
  makeLaneWriteScreenshot,
  resolveSelfReportedBlocker,
  resolveSelfReportedFriction,
  runCuaActorLab,
  type CuaActorLabHooks,
  participantStatusForCredibility,
  CLOSING_LINE_DIRECTIVE,
  composeLaneInstructions
} from "../src/cua-actor-lab.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox
} from "../src/e2b-desktop-launch.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { SANDBOX_CATCH_SCRIPT, externalCatchHealthy } from "../src/comms-sandbox-catch.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import { serveObserver, type ObserverResult, type ObserverServer } from "../src/observer.js";
import type { FetchLike } from "../src/openai-responses-cu.js";
import type {
  BrowserLabScoringContext,
  RunAdapterScore,
  RunBundle,
  RunFeedbackCandidate
} from "../src/index.js";
import { containsSensitive } from "../src/redaction.js";
import { verifyRun } from "../src/run.js";
import { prepareSelectedOutputDirectory } from "../src/selected-output-paths.js";
import type { LocalTreeArchive } from "../src/source-archive.js";
import { freePort } from "./helpers/free-port.js";
import { TERMINAL_NODE_BOOTSTRAP_COMMAND } from "../src/terminal-node-bootstrap.js";

// ---------------------------------------------------------------------------
// Fakes. The desktop module fake serves BOTH faces of the sandbox: the
// E2BDesktopSandbox shape the lab provisions through, and the E2BDesktopLike
// input surface the real executor actuates. Frames are real PNGs (distinct per
// call) so the loop's perceptual progress signature registers movement.
// ---------------------------------------------------------------------------

function makePng(seed: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (seed * 37 + i) % 256;
    png.data[i + 1] = (seed * 89 + i) % 256;
    png.data[i + 2] = (seed * 13 + i) % 256;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function scriptedFetch(responses: unknown[]): FetchLike {
  let i = 0;
  return async (_url, _init) => {
    const value = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
  };
}

interface FakeSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
}

function makeFakeSandbox(options: {
  withOpen?: boolean;
  commandHandler?: (command: string) => { stdout?: string; exitCode?: number } | undefined;
  /**
   * Throws a CommandExitError-shaped error (real-SDK-accurate: the real @e2b/desktop Sandbox
   * throws on any non-zero exit rather than returning one) for commands the predicate matches.
   * Mirrors tests/e2b-desktop-type-fallback.test.ts's makeFakeDesktop convention so both the
   * throwing shape and the structural non-throwing shape (commandHandler) are coverable from
   * the same fake.
   */
  commandThrow?: (command: string) => { exitCode?: number; stderr?: string; stdout?: string; message?: string } | undefined;
} = {}): FakeSandbox {
  let frame = 0;
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => async (...args: unknown[]): Promise<void> => {
    calls.push([name, ...args]);
  };
  const sandbox = {
    calls,
    sandboxId: "fake-sandbox-001",
    // Resource fields captured on stock E2B desktops; see fixtures/e2b-desktop-resources.
    getInfo: async () => ({ cpuCount: 8, memoryMB: 8192 }),
    commands: {
      run: async (command: string) => {
        calls.push(["commands.run", command]);
        const t = options.commandThrow?.(command);
        if (t) {
          throw Object.assign(new Error(t.message ?? `exit status ${t.exitCode ?? 1}`), {
            name: "CommandExitError",
            ...(t.exitCode === undefined ? {} : { exitCode: t.exitCode }),
            ...(t.stderr === undefined ? {} : { stderr: t.stderr }),
            ...(t.stdout === undefined ? {} : { stdout: t.stdout })
          });
        }
        return options.commandHandler?.(command) ?? { exitCode: 0, stdout: "" };
      }
    },
    files: {
      // Raw data (never String()-coerced): existing callers all write string script content
      // (unchanged behavior), and the local-tree upload path writes a real ArrayBuffer that
      // tests need to inspect directly (byteLength, instanceof ArrayBuffer).
      write: async (filePath: string, data: string | ArrayBuffer, writeOpts?: { requestTimeoutMs?: number; useOctetStream?: boolean }) => {
        calls.push(["files.write", filePath, data, writeOpts]);
        return undefined;
      }
    },
    launch: record("launch") as (application: string, uri?: string) => Promise<void>,
    ...(options.withOpen === false ? {} : { open: record("open") as (fileOrUrl: string) => Promise<void> }),
    async screenshot() {
      frame += 1;
      return makePng(frame);
    },
    async wait(ms: number) {
      calls.push(["wait", ms]);
    },
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async () => {
        calls.push(["stream.start"]);
      }
    },
    // E2BDesktopLike actuation surface (driven by the real executor).
    leftClick: record("leftClick"),
    rightClick: record("rightClick"),
    middleClick: record("middleClick"),
    doubleClick: record("doubleClick"),
    moveMouse: record("moveMouse"),
    scroll: record("scroll"),
    write: record("write"),
    press: record("press"),
    drag: record("drag")
  };
  return sandbox as unknown as FakeSandbox;
}

function expectSafeBrowserOpen(calls: Array<[string, ...unknown[]]>, url: string): number {
  const quotedUrl = url.replace(/'/g, "'\\''");
  const index = calls.findIndex(
    (call) =>
      call[0] === "commands.run" &&
      String(call[1]).includes(`target_url='${quotedUrl}'`) &&
      String(call[1]).includes("launch_browser google-chrome google-chrome")
  );
  expect(index).toBeGreaterThan(-1);
  return index;
}

function makeFakeModule(sandbox: FakeSandbox): {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
} {
  const created: E2BDesktopCreateOptions[] = [];
  // Parallel to `created`: the custom desktop template each create() was called with, or undefined
  // when called with NO template arg (the byte-stable default). Mirrors the real @e2b/desktop
  // overload: create(opts) OR create(template, opts).
  const templates: (string | undefined)[] = [];
  const killed: string[] = [];
  const module: E2BDesktopModule = {
    Sandbox: {
      create: async (templateOrOptions: string | E2BDesktopCreateOptions, maybeOptions?: E2BDesktopCreateOptions) => {
        const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
        const createOptions = typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
        templates.push(template);
        created.push(createOptions);
        return sandbox;
      },
      kill: async (sandboxId) => {
        killed.push(sandboxId);
        return true;
      }
    }
  };
  return { module, created, templates, killed };
}

const TWO_TURN_SESSION = [
  { id: "resp_1", output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }] },
  { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }
];
const SUCCESS_WITH_NEGATED_BLOCKER_SESSION = [
  { id: "resp_1", output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }] },
  { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Success: the target state is visible. No blocker encountered." }] }] }
];
// The 2026-08-19 drawDB run (#476): three tables created, then "could not connect the two tables
// because every new table appeared directly on top of the previous one". goal_satisfied, with a
// final message that is a blocker report.
const BLOCKED_AFTER_PARTIAL_SESSION = [
  { id: "resp_1", output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }] },
  { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Blocked after partial completion. Created three tables. Could not connect the two tables because every new table appeared directly on top of the previous one, and repeated attempts to drag them apart did not separate them." }] }] }
];
const BROWSER_ADAPTER_NAMESPACE = "browser-adapter-proof";

function failingBrowserScore(ctx: BrowserLabScoringContext): RunAdapterScore {
  return {
    schema: "humanish.adapter-score.v1",
    namespace: BROWSER_ADAPTER_NAMESPACE,
    status: "fail",
    score: 12,
    summary: `${ctx.backend} actor stopped before product evidence.`,
    data: {
      backend: ctx.backend,
      laneCount: ctx.laneCount,
      productAcceptance: "missing"
    }
  };
}

function browserFeedback(ctx: BrowserLabScoringContext): RunFeedbackCandidate[] {
  return [{
    schema: "humanish.feedback-candidate.v1",
    id: `${BROWSER_ADAPTER_NAMESPACE}-${ctx.runId}`,
    run_id: ctx.runId,
    stream_id: ctx.bundle.streams[0]?.id ?? "stream-001",
    adapter_id: BROWSER_ADAPTER_NAMESPACE,
    scenario_id: ctx.labId,
    persona_id: ctx.bundle.simulations[0]?.personaId ?? "unknown",
    actor: "unknown",
    substrate: "e2b-desktop",
    failure_owner: "actor",
    summary: "Browser actor reached a terminal session but did not provide product-visible completion evidence.",
    expected: "The actor completes the declared browser task and leaves product-visible evidence.",
    actual: "The generic actor session was terminal, but the adapter rubric found no product completion evidence.",
    evidence: [{ path: "review.md", kind: "review", note: "Review summary includes the adapter-owned product acceptance gap." }],
    redaction: { status: "passed", notes: "Synthetic adapter feedback references local public-safe artifacts only." },
    idempotency_key: `${BROWSER_ADAPTER_NAMESPACE}:${ctx.runId}:missing-product-evidence`,
    proposed_next_state: "actor-auth",
    acceptance_proof: [`humanish verify --run ${ctx.runId} --json`],
    adapter: {
      namespace: BROWSER_ADAPTER_NAMESPACE,
      data: {
        productAcceptance: "missing",
        suggestedOwner: "adopter-adapter"
      }
    }
  }];
}

function cuaConfig(appUrl = "http://127.0.0.1:3000/"): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "cua-routing-proof",
    title: "CUA routing proof",
    subject: { source: "app-url", appUrl },
    actors: [{
      type: "openai-computer-use",
      persona: "first-time-visitor",
      mission: "Explore the app and stop.",
      laneFocus: { instruction: "Focus on the landing page." }
    }],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { resolution: [1280, 800] } },
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** Scripted in-sandbox responses for the clone-route provisioning steps. */
function cloneCommandHandler(overrides?: (command: string) => { stdout?: string } | undefined) {
  return (command: string): { stdout?: string } | undefined => {
    const override = overrides?.(command);
    if (override !== undefined) return override;
    if (command.includes("/status")) return { stdout: "0" };
    if (command.includes("rev-parse")) return { stdout: "abc123def4567890abc1\n" };
    if (command.includes("curl")) return { stdout: "READY" };
    if (command.includes("tail -c")) return { stdout: "" };
    return undefined;
  };
}

function cloneCuaConfig(extra?: { env?: string[]; readyTimeoutMs?: number; state?: unknown; keep?: boolean }): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "cua-clone-proof",
    title: "CUA clone proof",
    subject: {
      source: "clone",
      repos: ["example-org/example-app"],
      clone: { depth: 2, ...(extra?.keep === undefined ? {} : { keep: extra.keep }) },
      serve: {
        install: "pnpm install --frozen-lockfile",
        build: "pnpm build",
        start: "pnpm start",
        url: "http://127.0.0.1:3000/",
        ...(extra?.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: extra.readyTimeoutMs })
      },
      ...(extra?.env ? { env: extra.env } : {}),
      ...(extra?.state === undefined ? {} : { state: extra.state })
    },
    actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop." }],
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("lab routing (app-url → cua)", () => {
  it("selectLabBackend routes app-url to the cua backend and leaves the other routes untouched", () => {
    expect(selectLabBackend(cuaConfig())).toBe("cua");
    const synthetic = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "s",
      subject: { source: "this-repo" },
      actors: [{ type: "synthetic-persona" }]
    });
    const clone = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "c",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "humanish-setup" }]
    });
    const meta = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "m",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "codex-app-server" }],
      execution: { target: "e2b-desktop" }
    });
    if (!synthetic.ok || !clone.ok || !meta.ok) throw new Error("fixture configs must parse");
    expect(selectLabBackend(synthetic.config)).toBe("synthetic");
    expect(selectLabBackend(clone.config)).toBe("smoke");
    expect(selectLabBackend(meta.config)).toBe("meta");
  });

  it("routes clone × e2b-desktop to cua when the actor lane is computer-use (meta otherwise)", () => {
    expect(selectLabBackend(cloneCuaConfig())).toBe("cua");
    // Same subject × execution with a non-cua actor stays on the meta route — the lane
    // disambiguates where the two axes collide.
    const meta = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "m2",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "codex-app-server" }],
      execution: { target: "e2b-desktop" }
    });
    if (!meta.ok) throw new Error("fixture must parse");
    expect(selectLabBackend(meta.config)).toBe("meta");
    // A cua-typed actor WITHOUT the desktop target routes to smoke (type is inert there).
    const smoke = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "s2",
      subject: { source: "clone", repos: ["example-org/example-app"] },
      actors: [{ type: "openai-computer-use" }]
    });
    if (!smoke.ok) throw new Error("fixture must parse");
    expect(selectLabBackend(smoke.config)).toBe("smoke");
  });
});

describe("desktop-cli runtime prerequisites (#515)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-desktop-cli-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  function configFor(install?: string): LabConfig {
    const parsed = parseLabConfig({
      ...cuaConfig(),
      subject: {
        source: "desktop-cli",
        product: { name: "sample-cli", publicSurfaces: ["https://example.com/sample-cli"], ...(install === undefined ? {} : { install }) }
      }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  function scriptIndex(sandbox: FakeSandbox, step: string): number {
    return sandbox.calls.findIndex(([name, file]) => name === "files.write" && String(file).endsWith(`${step}/run.sh`));
  }

  it.each([
    { label: "participant-owned installation", install: undefined, runtime: true },
    { label: "declared npm installation", install: "sudo -n npm install -g sample-cli", runtime: true },
    { label: "declared Python installation", install: "pip install sample-cli", runtime: false }
  ])("prepares $label before the participant and keeps product installation explicit", async ({ install, runtime }) => {
    const config = configFor(install);
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created, killed } = makeFakeModule(sandbox);
    let sessionCallIndex = -1;
    const result = await runCuaActorLab({ cwd, config, dryRun: false, hooks: {
      env: { OPENAI_API_KEY: "synthetic", E2B_API_KEY: "synthetic" },
      loadDesktopModule: async () => module,
      runSession: async (options) => {
        sessionCallIndex = sandbox.calls.length;
        return runCuaActorSession({ ...options, openai: { apiKey: "synthetic", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
      }
    } });
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.envs).toBeUndefined();
    expect(killed).toEqual([sandbox.sandboxId]);
    const terminalIndex = scriptIndex(sandbox, "desktop-cli-terminal");
    expect(terminalIndex).toBeGreaterThan(-1);
    expect(terminalIndex).toBeLessThan(sessionCallIndex);
    const runtimeIndex = scriptIndex(sandbox, "desktop-cli-runtime-node");
    if (runtime) {
      expect(runtimeIndex).toBeGreaterThan(-1);
      expect(runtimeIndex).toBeLessThan(terminalIndex);
      // Use the same checksum-pinned archive and global npm prefix already shell-tested by the
      // terminal route, including its mutation-free fast path for a working custom runtime.
      expect(sandbox.calls[runtimeIndex]?.[2]).toContain(TERMINAL_NODE_BOOTSTRAP_COMMAND);
    } else {
      expect(runtimeIndex).toBe(-1);
    }
    const installIndex = scriptIndex(sandbox, "desktop-cli-install");
    if (install === undefined) {
      expect(installIndex).toBe(-1);
      expect(config.subject.product?.install).toBeUndefined();
    } else {
      expect(installIndex).toBeGreaterThan(runtimeIndex);
      expect(installIndex).toBeLessThan(terminalIndex);
      expect(sandbox.calls[installIndex]?.[2]).toContain(`( ${install} )`);
    }
    expect(sandbox.calls.some(([name]) => name === "open")).toBe(false);
  });

  it("fails before opening a terminal or starting a participant if the no-install runtime fails", async () => {
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler((command) =>
      command.includes("desktop-cli-runtime-node/status") ? { stdout: "1" } : undefined
    ) });
    const { module, killed } = makeFakeModule(sandbox);
    let sessions = 0;
    const result = await runCuaActorLab({ cwd, config: configFor(), dryRun: false, hooks: {
      env: { OPENAI_API_KEY: "synthetic", E2B_API_KEY: "synthetic" },
      loadDesktopModule: async () => module,
      runSession: async (options) => {
        sessions += 1;
        return runCuaActorSession({ ...options, openai: { apiKey: "synthetic", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
      }
    } });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("desktop-cli runtime bootstrap failed");
    expect(sessions).toBe(0);
    expect(scriptIndex(sandbox, "desktop-cli-terminal")).toBe(-1);
    expect(scriptIndex(sandbox, "desktop-cli-install")).toBe(-1);
    expect(killed).toEqual([sandbox.sandboxId]);
  });
});

describe("runCuaActorLab", () => {
  it("forwards the public output limit into the real provider and retained incomplete trace", async () => {
    const config = cuaConfig();
    config.actors[0]!.maxOutputTokens = 16;
    const sandbox = makeFakeSandbox();
    const { module, created, killed } = makeFakeModule(sandbox);
    const wire = JSON.parse(await readFile(new URL("./fixtures/openai-incomplete/reasoning-only.json", import.meta.url), "utf8"));
    let requests = 0;
    vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
      expect(JSON.parse(init.body).max_output_tokens).toBe(16);
      requests += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(wire), json: async () => wire };
    });
    const result = await runCuaActorLab({ cwd, config, dryRun: false, hooks: {
      env: { OPENAI_API_KEY: "synthetic", E2B_API_KEY: "synthetic" }, loadDesktopModule: async () => module
    } }).finally(() => vi.unstubAllGlobals());
    expect(created).toHaveLength(1);
    expect(killed).toHaveLength(1);
    expect(requests).toBe(1);
    expect(result.session?.status).toBe("incomplete");
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.modelSettings.maxOutputTokens).toBe(16);
    expect(sandbox.calls.some(([name]) => name === "leftClick")).toBe(false);
  });

  it("refuses an invalid typed-library output limit before sandbox allocation", async () => {
    const config = cuaConfig();
    config.actors[0]!.maxOutputTokens = 0;
    let allocations = 0;
    const result = await runCuaActorLab({ cwd, config, dryRun: false, hooks: {
      loadDesktopModule: async () => { allocations += 1; throw new Error("must not allocate"); }
    } });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("maxOutputTokens");
    expect(allocations).toBe(0);
  });

  it("rejects custom session hooks that could bypass a declared output limit", async () => {
    const config = cuaConfig();
    config.actors[0]!.maxOutputTokens = 16;
    let called = 0;
    const result = await runCuaActorLab({ cwd, config, dryRun: false, hooks: {
      runSession: async () => { called += 1; throw new Error("must not dispatch"); },
      loadDesktopModule: async () => { called += 1; throw new Error("must not allocate"); }
    } });
    expect(result.error?.message).toContain("custom runSession");
    expect(called).toBe(0);
  });
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-lab-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("dry-run produces a verified contract bundle with no sandbox and no spend", async () => {
    const outcome = await runLab(cuaConfig(), { cwd, dryRun: true });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.actor).toBe("openai-computer-use");
    expect(result.sandbox).toBeUndefined();
    expect(result.session).toBeUndefined();
    expect(result.observer?.ok).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.schema).toBe("humanish.run-bundle.v1");
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.simulations[0].status).toBe("contract_proof_only");
    expect(bundle.review.verdict).toBe("contract_proof_only");
    expect(bundle.cwd).toBe("[target-cwd]");
    expect(bundle.streams[0].desktopGeometry).toEqual({
      screen: { requested: { width: 1280, height: 800 } }
    });
    expect(bundle.streams[0].viewport).toBeUndefined();
  });

  it("pins a symlink cwd before onPreflight can retarget the alias", async () => {
    const physicalA = path.join(cwd, "project-a");
    const physicalB = path.join(cwd, "project-b");
    const cwdAlias = path.join(cwd, "project-alias");
    const runId = "preflight-cwd-retarget";
    const decoyRuns = path.join(physicalB, ".humanish", "runs");
    const decoyLatest = path.join(decoyRuns, "latest.json");
    const sentinel = "outside sentinel must stay unchanged\n";

    await mkdir(physicalA);
    await mkdir(decoyRuns, { recursive: true });
    await writeFile(decoyLatest, sentinel, "utf8");
    symlinkSync(physicalA, cwdAlias, "dir");
    const pinnedA = await realpath(physicalA);

    let preflightCalls = 0;
    const result = await runCuaActorLab({
      cwd: cwdAlias,
      config: cuaConfig(),
      dryRun: true,
      runId,
      hooks: {
        onPreflight: () => {
          preflightCalls += 1;
          unlinkSync(cwdAlias);
          symlinkSync(physicalB, cwdAlias, "dir");
        }
      }
    });

    expect(preflightCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.cwd).toBe(pinnedA);
    await expect(readFile(path.join(physicalA, ".humanish", "runs", runId, "run.json"), "utf8"))
      .resolves.toContain(`"runId": "${runId}"`);
    expect(JSON.parse(await readFile(path.join(physicalA, ".humanish", "runs", "latest.json"), "utf8")).runId)
      .toBe(runId);
    expect(await readFile(decoyLatest, "utf8")).toBe(sentinel);
    expect(await readdir(decoyRuns)).toEqual(["latest.json"]);

    const verified = await verifyRun(physicalA, runId);
    expect(verified.ok).toBe(true);
  });

  it("rejects path-shaped screenshot names and hardlinked leaves", async () => {
    const artifactRoot = path.join(cwd, "screenshot-root");
    await mkdir(artifactRoot);
    const preparedRoot = await prepareSelectedOutputDirectory(cwd, artifactRoot);
    const screenshots: string[] = [];
    const writer = makeLaneWriteScreenshot(preparedRoot, { screenshotDir: "lane-01" }, screenshots);
    await expect(writer("../sentinel.png", makePng(1))).rejects.toThrow(/path segment/i);
    await expect(writer("nested/frame.png", makePng(1))).rejects.toThrow(/path segment/i);
    expect(() => makeLaneWriteScreenshot(preparedRoot, { screenshotDir: "../lane" }, screenshots))
      .toThrow(/path segment/i);

    const outside = path.join(cwd, "outside-frame.png");
    await writeFile(outside, "unchanged\n", "utf8");
    await mkdir(path.join(artifactRoot, "screenshots", "lane-01"), { recursive: true });
    try {
      await link(outside, path.join(artifactRoot, "screenshots", "lane-01", "frame.png"));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) return;
      throw error;
    }
    await expect(writer("frame.png", makePng(2))).rejects.toThrow(/hardlink|single-link/i);
    expect(await readFile(outside, "utf8")).toBe("unchanged\n");
    expect(screenshots).toEqual([]);
  });

  it("live (with fakes): registry actor drives the REAL loop/provider/executor through the lab, fills stream.actor, and tears down", async () => {
    const config = cuaConfig();
    const sandbox = makeFakeSandbox();
    const { module, created, killed } = makeFakeModule(sandbox);
    const sessionOptionsSeen: CuaActorSessionOptions[] = [];
    const prepared: string[] = [];

    const hooks: CuaActorLabHooks = {
      env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      loadDesktopModule: async () => module,
      prepareDesktop: async (desktop) => {
        prepared.push(desktop.sandboxId);
      },
      // Wrap the REAL session: real provider (scripted transport), real executor, the lab's
      // desktop and writeScreenshot — only the network is faked.
      runSession: async (options) => {
        sessionOptionsSeen.push(options);
        return runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
      }
    };

    const outcome = await runLab(config, { cwd, cuaHooks: hooks });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    // Lab verdict: ran to a terminal session and the bundle verified.
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.session?.status).toBe("passed");
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.observer?.ok).toBe(true);

    // Provisioning: metadata convention, config resolution, and NO env forwarding into the
    // sandbox (the model drives from outside; no key may enter the sandbox).
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata?.mode).toBe(CUA_ACTOR_LAB_PROVIDER_METADATA.mode);
    expect(created[0]?.resolution).toEqual([1280, 800]);
    expect(created[0]?.envs).toBeUndefined();
    expect(created[0]?.lifecycle).toEqual({ onTimeout: "kill" });

    // prepareDesktop ran before the browser opened, against the created sandbox.
    expect(prepared).toEqual(["fake-sandbox-001"]);
    const openIndex = expectSafeBrowserOpen(sandbox.calls, "http://127.0.0.1:3000/");

    // The model's click actuated the desktop through the real executor.
    expect(sandbox.calls).toContainEqual(["leftClick", 11, 22]);
    expect(openIndex).toBeLessThan(sandbox.calls.findIndex(([name]) => name === "leftClick"));

    // The prompt was composed from config (persona + mission + lane focus).
    const instructions = sessionOptionsSeen[0]?.instructions ?? "";
    expect(instructions).toContain("first-time-visitor");
    expect(instructions).toContain("Explore the app and stop.");
    expect(instructions).toContain("Focus on the landing page.");

    // Teardown happened even on success.
    expect(killed).toEqual(["fake-sandbox-001"]);
    expect(result.sandbox).toEqual({ sandboxId: "fake-sandbox-001", killed: true, streamUrlPresent: true });

    // The persisted bundle fills the provider-neutral actor seam and keeps evidence local.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.schema).toBe(ACTOR_TRACE_SCHEMA);
    expect(bundle.streams[0].actor.lane).toBe("computer-use");
    expect(bundle.streams[0].actor.provider).toBe("openai-responses-cu");
    expect(bundle.cwd).toBe("[target-cwd]");
    // This fake does not expose runtime geometry. The bundle keeps the request but does not
    // falsify it as a measured CSS viewport.
    expect(bundle.streams[0].desktopGeometry).toMatchObject({
      screen: { requested: { width: 1280, height: 800 } }
    });
    expect(bundle.streams[0].desktopGeometry.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("requested geometry remains unverified"),
      expect.stringContaining("stream.viewport is omitted")
    ]));
    expect(bundle.streams[0].viewport).toBeUndefined();

    // Screenshots were persisted (redacted upstream) and referenced relatively.
    const screenshotArtifacts = bundle.streams[0].artifacts.filter(
      (artifact: { kind: string }) => artifact.kind === "screenshot"
    );
    expect(screenshotArtifacts.length).toBeGreaterThan(0);
    const screenshotFiles = await readdir(path.join(runDir, "screenshots"));
    expect(screenshotFiles.length).toBe(screenshotArtifacts.length);

    // actor.json trace artifact exists and matches the stream seam.
    const traceOnDisk = JSON.parse(await readFile(path.join(runDir, "actor.json"), "utf8"));
    expect(traceOnDisk).toEqual(bundle.streams[0].actor);

    // The runtime-only stream URL (carries an auth key) never lands anywhere: not on the
    // result (the sandbox is dead by then — only presence is reported) nor in any artifact.
    expect("streamUrl" in result).toBe(false);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson", "actor.json"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("stream.invalid");
      expect(text, file).not.toContain("fake-auth-key");
      expect(text, file).not.toContain("test-openai-key");
      expect(text, file).not.toContain("test-e2b-key");
    }
  });

  it("mobile emulation (#221): launches Chrome with the mobile UA and touch flags, holds the CDP session, and records what the page reported", async () => {
    const commands: string[] = [];
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        commands.push(command);
        if (command.includes("xdpyinfo")) {
          return { exitCode: 0, stdout: "dimensions: 500x896 pixels (300x200 millimeters)\n" };
        }
        if (command.includes("find_chrome_window")) {
          return { exitCode: 0, stdout: "WINDOW_ID=7340035\n" };
        }
        if (command.includes("getwindowgeometry")) {
          return { exitCode: 0, stdout: "X=0\nY=0\nWIDTH=500\nHEIGHT=896\n" };
        }
        // Order matters: every probe command embeds the whole script, so match the JSON args first.
        if (command.includes('"mode":"fidelity"')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              fidelity: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1", devicePixelRatio: 3, innerWidth: 414, innerHeight: 896, maxTouchPoints: 5, coarsePointer: true },
              targetId: "T1"
            })
          };
        }
        if (command.includes("mobile-emulation-") && command.includes("tail -c")) {
          return { exitCode: 0, stdout: JSON.stringify({ applied: ["Emulation.setDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled", "Emulation.setEmitTouchEventsForMouse", "Emulation.setUserAgentOverride", "Page.reload"], held: true, targetId: "T1" }) + "\n" };
        }
        // The session's state observations read the emulated target: no drift.
        if (command.includes('"mode":"state"')) {
          return { exitCode: 0, stdout: JSON.stringify({ url: "http://127.0.0.1:3000/", title: "app", text: "hello", scrollY: 0, targetId: "T1" }) };
        }
        if (command.includes("browserWindow: { x: window.screenX")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              browserWindow: { x: 0, y: 0, width: 500, height: 896 },
              viewport: { width: 414, height: 800, deviceScaleFactor: 3 },
              targetId: "T1"
            })
          };
        }
        if (command.includes("browser_preference='chrome'")) {
          return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\nHUMANISH_BROWSER_CDP_PORT=9222\n" };
        }
        return undefined;
      }
    });
    const { module } = makeFakeModule(sandbox);
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-mobile-fidelity",
      title: "Mobile fidelity",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { device: "mobile", browser: "chrome", fidelity: { mobileEmulation: true } } },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    expect(outcome.result.ok).toBe(true);

    // Launch flags: the UA and touch hold browser-wide, beyond the launch tab the holder covers.
    const launch = commands.find((command) => command.includes("browser_preference='chrome'"))!;
    expect(launch).toContain("--user-agent=Mozilla/5.0 (iPhone");
    expect(launch).toContain("--touch-events=enabled");
    // The holder was started detached (its script goes through files.write) with the lane's
    // preset as the emulated device.
    const holderScript = sandbox.calls
      .filter((call) => call[0] === "files.write" && String(call[1]).includes("mobile-emulation-"))
      .map((call) => String(call[2]))
      .find((script) => script.includes('"mode":"hold"'))!;
    expect(holderScript).toContain('"width":414');
    expect(holderScript).toContain('"deviceScaleFactor":3');
    expect(holderScript).toContain('"touch":true');

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.streams[0].desktopGeometry.fidelity).toEqual({
      tier: "mobile-emulated",
      requested: { width: 414, height: 896, deviceScaleFactor: 3, touch: true, userAgent: expect.stringContaining("iPhone") },
      applied: ["Emulation.setDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled", "Emulation.setEmitTouchEventsForMouse", "Emulation.setUserAgentOverride", "Page.reload"],
      resolved: { userAgent: expect.stringContaining("iPhone"), devicePixelRatio: 3, innerWidth: 414, innerHeight: 896, maxTouchPoints: 5, coarsePointer: true, source: "cdp" }
    });
    const geometryWarnings: string[] = bundle.streams[0].desktopGeometry.warnings ?? [];
    expect(geometryWarnings.filter((warning) => warning.includes("Mobile emulation"))).toEqual([]);
    // The advisory must reach the run result consumed by CLI/JSON callers even when every
    // fidelity read-back matches. Correct context flags do not certify repeated-tap behavior.
    expect(outcome.result.warnings.filter((warning) => warning.includes("pointer-to-touch conversion"))).toEqual([
      "Mobile emulation uses desktop pointer-to-touch conversion, which can differ for repeated taps. Confirm gesture failures with direct or native touch input before attributing them to the app."
    ]);
  });

  // A phone lane whose every observation reads a NEW tab (T2) the participant opened; the tab's own
  // fidelity read-back is what the test varies.
  function laterTabSandbox(secondTabInnerWidth: number) {
    return makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("xdpyinfo")) return { exitCode: 0, stdout: "dimensions: 500x896 pixels (300x200 millimeters)\n" };
        if (command.includes("find_chrome_window")) return { exitCode: 0, stdout: "WINDOW_ID=7340035\n" };
        if (command.includes("getwindowgeometry")) return { exitCode: 0, stdout: "X=0\nY=0\nWIDTH=500\nHEIGHT=896\n" };
        if (command.includes('"mode":"fidelity"')) {
          const onSecondTab = command.includes('"targetId":"T2"');
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              fidelity: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1", devicePixelRatio: onSecondTab && secondTabInnerWidth !== 414 ? 1 : 3, innerWidth: onSecondTab ? secondTabInnerWidth : 414, innerHeight: 896, maxTouchPoints: 5, coarsePointer: true },
              targetId: onSecondTab ? "T2" : "T1"
            })
          };
        }
        if (command.includes("mobile-emulation-") && command.includes("tail -c")) {
          // The holder's log grows as tabs appear: the announce first, then one line per attach.
          return {
            exitCode: 0,
            stdout: JSON.stringify({ applied: ["Emulation.setDeviceMetricsOverride", "Page.reload"], held: true, targetId: "T1" }) + "\n"
              + JSON.stringify({ attached: "T2", sent: ["Emulation.setDeviceMetricsOverride", "Page.reload"] }) + "\n"
          };
        }
        if (command.includes('"mode":"state"')) {
          return { exitCode: 0, stdout: JSON.stringify({ url: "http://127.0.0.1:3000/help", title: "help", text: "help", scrollY: 0, targetId: "T2" }) };
        }
        if (command.includes("browserWindow: { x: window.screenX")) {
          return { exitCode: 0, stdout: JSON.stringify({ browserWindow: { x: 0, y: 0, width: 500, height: 896 }, viewport: { width: 414, height: 800, deviceScaleFactor: 3 }, targetId: "T1" }) };
        }
        if (command.includes("browser_preference='chrome'")) {
          return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\nHUMANISH_BROWSER_CDP_PORT=9222\n" };
        }
        return undefined;
      }
    });
  }
  async function runLaterTabLane(sandbox: ReturnType<typeof makeFakeSandbox>) {
    const { module } = makeFakeModule(sandbox);
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-mobile-fidelity-drift",
      title: "Mobile fidelity drift",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { device: "mobile", browser: "chrome", fidelity: { mobileEmulation: true } } },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    return { outcome, bundle };
  }

  it("mobile emulation on a later tab (#623): a tab the page itself reports at the phone width is recorded on the bundle, with no drift warning", async () => {
    const { outcome, bundle } = await runLaterTabLane(laterTabSandbox(414));
    expect((outcome.result.warnings ?? []).filter((warning: string) => warning.includes("Mobile emulation drift"))).toEqual([]);
    expect(bundle.streams[0].desktopGeometry.fidelity.laterTargets).toEqual([{ targetId: "T2", innerWidth: 414, devicePixelRatio: 3, maxTouchPoints: 5 }]);
    // The holder's own account of the later tab travels with the bundle (after its announce line).
    expect(bundle.streams[0].desktopGeometry.fidelity.holderLog).toEqual([JSON.stringify({ attached: "T2", sent: ["Emulation.setDeviceMetricsOverride", "Page.reload"] })]);
  });

  it("mobile emulation drift (#623): a later tab that reports the window width puts one warning on the lane, with the page's number", async () => {
    const { outcome, bundle } = await runLaterTabLane(laterTabSandbox(500));
    const driftWarnings = (outcome.result.warnings ?? []).filter((warning: string) => warning.includes("Mobile emulation drift"));
    expect(driftWarnings).toHaveLength(1);
    expect(driftWarnings[0]).toContain("reports a 500 px viewport where 414 px was requested");
    expect(driftWarnings[0]).toContain("#623");
    expect(bundle.streams[0].desktopGeometry.fidelity.laterTargets).toBeUndefined();
  });

  it("a lab's dwell window reaches the session the lane runs (#510): actor default, lane override", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-dwell-plumbing",
      title: "Dwell plumbing",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{
        type: "openai-computer-use",
        mission: "Watch the room.",
        dwell: { when: { any: [{ id: "in-room", urlIncludes: "/room/" }] }, ms: 30_000 },
        lanes: [
          { id: "watcher", persona: "first-time-visitor", instruction: "Watch." },
          { id: "leaver", persona: "first-time-visitor", instruction: "Watch, then leave.", dwell: { ms: 2_000, everyMs: 1_000, then: "stop" } }
        ]
      }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 1 },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const seen: unknown[] = [];
    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) => {
          seen.push(options.dwell);
          return runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const verified = await verifyRun(cwd, outcome.result.runId);
    expect(outcome.result.ok, JSON.stringify(verified.checks.filter((check) => !check.ok))).toBe(true);
    // The spread that carried it past the type checker is exactly why this test exists: an excess
    // property in a spread is never an error, so a dropped option is silent without it.
    expect(seen).toEqual([
      { when: { any: [{ id: "in-room", urlIncludes: "/room/" }] }, ms: 30_000, everyMs: 10_000, then: "continue" },
      { ms: 2_000, everyMs: 1_000, then: "stop" }
    ]);
  }, 30_000);

  // A lane with a declared synthetic camera (#509): the fake desktop answers the ffmpeg feed
  // generation and the Chrome launch, and the test reads what the browser was launched with.
  function cameraSandbox(ffmpegExit: number) {
    const commands: string[] = [];
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        commands.push(command);
        if (command.includes("ffmpeg -y")) return { exitCode: ffmpegExit, stdout: "", ...(ffmpegExit === 0 ? {} : { stderr: "ffmpeg: command not found" }) };
        if (command.includes("browser_preference='chrome'")) {
          return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\nHUMANISH_BROWSER_CDP_PORT=9222\n" };
        }
        return undefined;
      }
    });
    return { sandbox, commands };
  }
  async function runCameraLane(sandbox: ReturnType<typeof makeFakeSandbox>, policies: Record<string, unknown>) {
    const { module } = makeFakeModule(sandbox);
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-camera",
      title: "Participant camera",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Turn on the camera and stop." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { browser: "chrome", media: { camera: { source: "synthetic" } } } },
      scenario: { mode: "live" },
      policies
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    return outcome;
  }

  it("a synthetic camera (#509): the feed is generated before launch, Chrome gets the fake-device flags, the bundle records it, the permission dialog stays real", async () => {
    const { sandbox, commands } = cameraSandbox(0);
    const outcome = await runCameraLane(sandbox, {});
    expect(outcome.result.ok, JSON.stringify(outcome.result.error)).toBe(true);
    const ffmpeg = commands.findIndex((command) => command.includes("ffmpeg -y"));
    const launch = commands.findIndex((command) => command.includes("browser_preference='chrome'"));
    expect(ffmpeg).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(ffmpeg);
    expect(commands[launch]).toContain("--use-fake-device-for-media-stream");
    expect(commands[launch]).toContain("--use-file-for-fake-video-capture=/dev/shm/humanish-media/camera.y4m");
    expect(commands[launch]).not.toContain("--use-fake-ui-for-media-stream");
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.desktopBrowser.media).toEqual({
      camera: { source: "synthetic", file: "/dev/shm/humanish-media/camera.y4m" },
      permission: "prompt",
      flags: ["--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=/dev/shm/humanish-media/camera.y4m"]
    });
  });

  it("policies.mediaPermission: granted adds the auto-accept flag and the bundle says so", async () => {
    const { sandbox, commands } = cameraSandbox(0);
    const outcome = await runCameraLane(sandbox, { mediaPermission: "granted" });
    expect(outcome.result.ok).toBe(true);
    const launch = commands.find((command) => command.includes("browser_preference='chrome'"))!;
    expect(launch).toContain("--use-fake-ui-for-media-stream");
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.desktopBrowser.media.permission).toBe("granted");
    expect(bundle.desktopBrowser.media.flags).toContain("--use-fake-ui-for-media-stream");
  });

  it("a desktop image without ffmpeg fails the lane closed before the browser launches, named", async () => {
    const { sandbox, commands } = cameraSandbox(127);
    const outcome = await runCameraLane(sandbox, {});
    expect(outcome.result.ok).toBe(false);
    expect(JSON.stringify(outcome.result.error)).toContain("synthetic camera feed could not be generated");
    expect(commands.some((command) => command.includes("browser_preference='chrome'"))).toBe(false);
  });

  it("sandbox create retried once (#630): a first attempt that hit an envd not yet routable is retried, named on the lane and in the phase trail", async () => {
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("browser_preference='chrome'")) {
          return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\nHUMANISH_BROWSER_CDP_PORT=9222\n" };
        }
        return undefined;
      }
    });
    const { module, created } = makeFakeModule(sandbox);
    const realCreate = module.Sandbox.create as unknown as (...args: unknown[]) => Promise<E2BDesktopSandbox>;
    let attempts = 0;
    const failingOnce = async (...args: unknown[]): Promise<E2BDesktopSandbox> => {
      attempts += 1;
      // The measured shape: the API allocated the sandbox, the desktop SDK's first envd request
      // (its Xvfb start) hit the proxy instead, and Sandbox.create threw without an id.
      if (attempts === 1) throw new Error("12: [unimplemented] HTTP 404");
      return realCreate(...args);
    };
    module.Sandbox.create = failingOnce as unknown as typeof module.Sandbox.create;
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-create-retry",
      title: "Sandbox create retry",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { browser: "chrome" } },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const phases: string[] = [];
    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        onPhase: (event) => phases.push(event.type),
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(created).toHaveLength(1);
    const retryWarnings = (outcome.result.warnings ?? []).filter((warning: string) => warning.includes("retried once after a transient provider error"));
    expect(retryWarnings).toHaveLength(1);
    expect(retryWarnings[0]).toContain("[unimplemented] HTTP 404");
    // Cleanup evidence now comes from the guarded SDK error when a handle was acquired.
    expect(retryWarnings[0]).not.toContain("not known to this run");
    expect(phases).toContain("cua-lab.sandbox.create.retry");
  }, 20_000);

  it("sandbox create is NOT retried on an auth failure: the lane fails closed on the first attempt", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    let attempts = 0;
    const alwaysUnauthorized = async (): Promise<E2BDesktopSandbox> => {
      attempts += 1;
      throw new Error("401 Unauthorized: invalid API key");
    };
    module.Sandbox.create = alwaysUnauthorized as unknown as typeof module.Sandbox.create;
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-create-no-retry",
      title: "Sandbox create, no retry",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("mobile emulation leaves a desktop-preset lane alone: no launch flags, no holder, no fidelity block", async () => {
    const commands: string[] = [];
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        commands.push(command);
        if (command.includes("browser_preference='chrome'")) {
          return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\nHUMANISH_BROWSER_CDP_PORT=9222\n" };
        }
        return undefined;
      }
    });
    const { module } = makeFakeModule(sandbox);
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-mobile-fidelity-desktop-lane",
      title: "Mobile fidelity, desktop lane",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { device: "desktop", browser: "chrome", fidelity: { mobileEmulation: true } } },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    const launch = commands.find((command) => command.includes("browser_preference='chrome'"))!;
    expect(launch).not.toContain("--user-agent=");
    expect(sandbox.calls.some((call) => call[0] === "files.write" && String(call[1]).includes("mobile-emulation-"))).toBe(false);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.streams[0].desktopGeometry.fidelity).toBeUndefined();
    expect(outcome.result.warnings.some((warning) => warning.includes("pointer-to-touch conversion"))).toBe(false);
  });

  it("mobile emulation fails the lane closed when the launched browser is not Chromium", async () => {
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("browser_preference='firefox'")) {
          return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=firefox\nHUMANISH_BROWSER_PID=4242\nHUMANISH_BROWSER_PROFILE_DIR=/tmp/p\n" };
        }
        return undefined;
      }
    });
    const { module, killed } = makeFakeModule(sandbox);
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-mobile-fidelity-firefox",
      title: "Mobile fidelity on Firefox",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { device: "mobile", browser: "firefox", fidelity: { mobileEmulation: true } } },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runLab(parsed.config, {
      cwd,
      cuaHooks: { env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" }, loadDesktopModule: async () => module }
    });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.message).toContain("mobileEmulation needs Chrome or Chromium");
    expect(outcome.result.error?.message).toContain("firefox");
    expect(killed).toEqual(["fake-sandbox-001"]);
  });

  it("stops a clipped browser before the participant session and still reclaims the desktop", async () => {
    const sandbox = makeFakeSandbox({ commandHandler: (command) => {
      if (command.includes("xdpyinfo")) return { exitCode: 0, stdout: "dimensions: 1280x800 pixels\n" };
      if (command.includes("find_chrome_window")) return { exitCode: 0, stdout: "WINDOW_ID=7340035\n" };
      if (command.includes("getwindowgeometry")) return { exitCode: 0, stdout: "X=0\nY=32\nWIDTH=1280\nHEIGHT=800\n" };
      if (command.includes("browser_preference='default'")) return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n" };
      return undefined;
    } });
    const { module, killed } = makeFakeModule(sandbox);
    let participantSessions = 0;
    const outcome = await runLab(cuaConfig(), { cwd, cuaHooks: {
      env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      loadDesktopModule: async () => module,
      runSession: async () => { participantSessions++; throw new Error("participant must not start"); }
    } });
    if (outcome.backend !== "cua") throw new Error("wrong route");
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("HUMANISH_CUA_LAB_DEVICE_GEOMETRY");
    expect(outcome.result.error?.message).toContain("Participant actions were not started");
    expect(participantSessions).toBe(0);
    expect(killed).toEqual(["fake-sandbox-001"]);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.streams[0].desktopGeometry.browserWindow).toMatchObject({ y: 32, height: 800, source: "xdotool" });
    expect(bundle.streams[0].desktopGeometry.warnings.join(" ")).toContain("outside the captured");
  });

  it("persists requested/verified screen, browser bounds, and a distinct measured CSS viewport", async () => {
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("xdpyinfo")) {
          return { exitCode: 0, stdout: "dimensions: 1280x800 pixels (300x200 millimeters)\n" };
        }
        if (command.includes("find_chrome_window")) {
          return { exitCode: 0, stdout: "WINDOW_ID=7340035\n" };
        }
        if (command.includes("getwindowgeometry")) {
          return { exitCode: 0, stdout: "X=0\nY=0\nWIDTH=1280\nHEIGHT=800\n" };
        }
        if (command.includes("browserWindow: { x: window.screenX")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              browserWindow: { x: 0, y: 0, width: 1280, height: 800 },
              viewport: { width: 1280, height: 661, deviceScaleFactor: 1 }
            })
          };
        }
        if (command.includes("browser_preference='default'")) {
          return { exitCode: 0, stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n" };
        }
        return undefined;
      }
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) }
          })
      }
    });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;

    const bundle = JSON.parse(await readFile(
      path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"),
      "utf8"
    ));
    expect(bundle.streams[0].desktopGeometry).toEqual({
      screen: {
        requested: { width: 1280, height: 800 },
        verified: { width: 1280, height: 800, source: "xdpyinfo" }
      },
      browserWindow: { x: 0, y: 0, width: 1280, height: 800, source: "xdotool" },
      viewport: { width: 1280, height: 661, deviceScaleFactor: 1, source: "cdp" }
    });
    expect(bundle.streams[0].viewport).toEqual({
      width: 1280,
      height: 661,
      deviceScaleFactor: 1,
      isMobile: false
    });
    expect(bundle.streams[0].viewport.height).not.toBe(bundle.streams[0].desktopGeometry.screen.requested.height);

    // Duplicate measured geometry must remain exact; a forged stream-level mismatch is invalid.
    bundle.streams[0].viewport.height = 660;
    await writeFile(
      path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"),
      `${JSON.stringify(bundle, null, 2)}\n`,
      "utf8"
    );
    const inconsistent = await verifyRun(cwd, outcome.result.runId);
    expect(inconsistent.ok).toBe(false);
    expect(inconsistent.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");

    // Optional geometry is backward-compatible, but a present block is validated fail-closed.
    bundle.streams[0].viewport.height = 661;
    bundle.streams[0].desktopGeometry.viewport.source = "declared";
    await writeFile(
      path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"),
      `${JSON.stringify(bundle, null, 2)}\n`,
      "utf8"
    );
    const malformed = await verifyRun(cwd, outcome.result.runId);
    expect(malformed.ok).toBe(false);
    expect(malformed.error?.code).toBe("HUMANISH_INVALID_RUN_BUNDLE");
  });

  it("does not treat a negated blocker phrase in a success message as a self-reported blocker", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(SUCCESS_WITH_NEGATED_BLOCKER_SESSION) }
          })
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes("NOT counted as a pass"))).toBe(false);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.review.verdict).toBe("pass");
    expect(bundle.review.gaps).toEqual([]);
  });

  const fakeBlockerSession = (
    reason: string,
    opts?: { completionReason?: string; stopWhenMatched?: boolean }
  ): CuaLoopResult =>
    ({
      completionReason: opts?.completionReason ?? "goal_satisfied",
      reason,
      trace: {
        items: opts?.stopWhenMatched
          ? [{ kind: "notice", status: "matched", title: "stopWhen matched: done" }]
          : []
      }
    }) as unknown as CuaLoopResult;

  it("flags a goal_satisfied lane whose OWN narrative reports a real blocker", () => {
    expect(resolveSelfReportedBlocker(fakeBlockerSession("I could not complete the task; the delete button was disabled")))
      .toContain("could not complete");
  });

  it("tallies a refused goal_satisfied under the status the lane judged, one rule for N=1 and fan-out", () => {
    expect(participantStatusForCredibility("passed", { noEngagement: false, selfReportedBlocker: true })).toBe("blocked");
    expect(participantStatusForCredibility("passed", { noEngagement: true, selfReportedBlocker: false })).toBe("incomplete");
    expect(participantStatusForCredibility("passed", { noEngagement: false, selfReportedBlocker: false })).toBe("passed");
    expect(participantStatusForCredibility("passed", undefined)).toBe("passed");
    // A session that did not claim a pass is not re-judged.
    expect(participantStatusForCredibility("abandoned", { noEngagement: false, selfReportedBlocker: true })).toBe("abandoned");
  });

  it("does NOT flag 'can't' + a perception verb: a display defect reported after the goal", () => {
    // Five of five completed live runs on 2026-09-01 were refused on sentences like these. Each
    // participant had reached the goal and was describing what the screen showed.
    for (const message of [
      "Done. I added two tables. It looks like an internal ID leaked into the UI, and the canvas truncates it so you can't even read the whole thing.",
      "Done. I renamed the table. I can't tell from the screen whether that rename is persisted or only in memory.",
      "The long task was cut off at \u201cPrepare notes for Friday proje\u201d rather than wrapping, so I could not read its full description.",
      "Clicking Save twice did not close edit mode or give confirmation, so I could not tell whether the rename had actually been saved.",
      "I was unable to verify from the canvas alone that both tables were still there."
    ]) {
      expect(resolveSelfReportedBlocker(fakeBlockerSession(message)), message).toBeUndefined();
      // They are still friction, and still count as such.
      expect(resolveSelfReportedFriction(fakeBlockerSession(message)), message).toBeDefined();
    }
  });

  it("every computer-use lane is asked for the fixed closing line, after the mission and the lane focus (#570)", () => {
    const composed = composeLaneInstructions({
      mission: "Add two tables.",
      instruction: "keyboard only",
      device: { name: "desktop", preset: DEVICE_PRESETS.desktop }
    });
    expect(composed.instructions).toContain(CLOSING_LINE_DIRECTIVE);
    expect(composed.instructions.indexOf("Lane focus: keyboard only")).toBeLessThan(composed.instructions.indexOf(CLOSING_LINE_DIRECTIVE));
    // A report format, never a behavioural instruction: it does not tell the participant what to do.
    expect(CLOSING_LINE_DIRECTIVE).not.toMatch(/never|always|do not (type|click|use)/i);
  });

  it("the participant's declared outcome wins over the paragraph, both ways (#570)", () => {
    const declared = (reason: string, outcome: "reached" | "blocked" | "not_reached") => {
      const session = fakeBlockerSession(reason);
      session.trace.declaredOutcome = outcome;
      return session;
    };
    // A declared "reached" is not re-read for blocker phrases, however the paragraph is worded.
    expect(resolveSelfReportedBlocker(declared("I could not complete the last step but marked it done anyway.", "reached"))).toBeUndefined();
    // A declared "blocked" is a blocker even when the paragraph is mild.
    expect(resolveSelfReportedBlocker(declared("Stopped at the database dialog.", "blocked"))).toContain("database dialog");
    expect(resolveSelfReportedFriction(declared("Stopped at the database dialog.", "blocked"))).toContain("database dialog");
    // No declaration: the paragraph is read, as before.
    expect(resolveSelfReportedBlocker(fakeBlockerSession("I could not complete the task; the delete button was disabled."))).toBeDefined();
  });

  it("counts a finished participant's report of defects or confusion as friction, so it becomes a candidate", () => {
    // Eleven drawDB reports on 2026-09-01, all "What confused me" / "Accessibility defects:",
    // none a blocker, none a candidate; the draft said "completed without a participant-reported
    // finding" for a run that had just replicated a keyboard-accessibility defect.
    for (const message of [
      "Done. Confused by: \u201cAdd table\u201d immediately created a table with a long random name; the renaming method was not obvious.",
      "Created and saved a PostgreSQL diagram. Accessibility defects: the database chooser and confirmation control were not keyboard-accessible; focus escaped behind the modal, requiring mouse clicks.",
      "Done. The second table was placed exactly on top of the first one, so the two overlapped.",
      "Done. Clicking Save did nothing; pressing Enter saved the name."
    ]) {
      expect(resolveSelfReportedFriction(fakeBlockerSession(message)), message).toBeDefined();
      // Friction, and only friction: none of these refuses the pass.
      expect(resolveSelfReportedBlocker(fakeBlockerSession(message)), message).toBeUndefined();
    }
    // A report with nothing to say stays silent.
    expect(resolveSelfReportedFriction(fakeBlockerSession("Done. I added two tables named customers and orders; both are visible in the sidebar."))).toBeUndefined();
  });

  it("still flags an inability to ACT, which is what a blocker is", () => {
    for (const message of [
      "Blocked after partial completion. Could not connect the two tables because every new table appeared on top of the previous one.",
      "I could not complete the task; the delete button was disabled.",
      "I can tab to the signature box but cannot get focus into the typed-signature entry area.",
      "I was unable to proceed past the login screen."
    ]) {
      expect(resolveSelfReportedBlocker(fakeBlockerSession(message)), message).toBeDefined();
    }
  });

  it("does NOT flag a clean pass that says nothing blocked it", () => {
    // Found on 2026-09-01 by a real benchmark run: a passing lane ended "No functional failures
    // blocked me, and cleanup left the app back at an empty list" and was downgraded from a pass
    // to a lab failure. The negation list only knew real/remaining/actual, so the ordinary
    // qualifier "functional" slipped through and the trailing verb "blocked" tripped the scan.
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession("No functional failures blocked me, and cleanup left the app empty.")
      )
    ).toBeUndefined();
  });

  it("does NOT flag other ordinary ways of saying it went fine", () => {
    for (const message of [
      // A clean benchmark run on 2026-09-01 was refused on this exact sentence.
      "Overall, the main list actions were straightforward and worked on the first try. I encountered no blockers or unclear error output.",
      "I hit no obvious errors during the trial.",
      "There were no significant problems with the main flow.",
      "Nothing really stopped me from finishing the task.",
      "No blocking issues prevented me from completing it."
    ]) {
      expect(resolveSelfReportedBlocker(fakeBlockerSession(message))).toBeUndefined();
    }
  });

  it("still flags a real blocker that happens to sit near the word no", () => {
    // The negation widening must not swallow an actual report. "no" here belongs to a different
    // clause than the blocker.
    expect(
      resolveSelfReportedBlocker(
        fakeBlockerSession("There was no undo button, and I could not complete the checkout at all.")
      )
    ).toContain("could not complete");
  });

  it("does NOT flag a lane that merely QUOTES the subject app's copy containing a blocker word (#329)", () => {
    // The persona faithfully relays the app's banner text; a quoted span is not the actor's own
    // status and must not trip the blocker scan.
    expect(resolveSelfReportedBlocker(fakeBlockerSession(
      'I confirmed the deletion. The banner read "This action cannot be undone." The item is gone.'
    ))).toBeUndefined();
  });

  it("does NOT flag a blocker narrative when the run's own stopWhen predicate matched (#329)", () => {
    // A matched stopWhen is independent, structured completion evidence and overrides the text scan.
    expect(resolveSelfReportedBlocker(fakeBlockerSession(
      "the page shows an error but I reached the target state",
      { stopWhenMatched: true }
    ))).toBeUndefined();
  });

  it("does not flag a clean goal_satisfied success", () => {
    expect(resolveSelfReportedBlocker(fakeBlockerSession("Success: the target state is visible. No blocker encountered.")))
      .toBeUndefined();
  });

  it("only inspects goal_satisfied lanes", () => {
    expect(resolveSelfReportedBlocker(fakeBlockerSession("cannot proceed", { completionReason: "timeout" })))
      .toBeUndefined();
    expect(resolveSelfReportedBlocker(undefined)).toBeUndefined();
  });

  it("a defect report after demonstrated success keeps the pass AND counts as friction (#453)", () => {
    // The live run-1 report shape, verbatim in structure: mission done, then a defect-notes
    // section whose failure narration reports its OWN recovery in the same segment.
    const report = [
      "Done. Created three tables and one relationship. Final state shows Tables (3) and Relationships (1), which matches the requested task.",
      "Notes / defects observed:",
      "- The SQL import editor output was somewhat ambiguous; my first import failed with a parser error that was hard to interpret. A simpler SQL import succeeded.",
      "- Dragging tables around the canvas did not work reliably for me."
    ].join("\n");
    // Strict (verdict): the resolved arc never blocks the pass.
    expect(resolveSelfReportedBlocker(fakeBlockerSession(report))).toBeUndefined();
    // Inclusive (tally/candidates): the friction is still reported evidence.
    expect(resolveSelfReportedFriction(fakeBlockerSession(report))).toContain("parser error");
  });

  it("an UNRESOLVED failure still blocks the verdict — the strip needs the recovery in the segment (#453)", () => {
    expect(resolveSelfReportedBlocker(fakeBlockerSession("The import failed with a parser error, so I gave up on that path and stopped.")))
      .toContain("failed");
    // And a recovery in a DIFFERENT segment does not launder an unresolved failure.
    expect(resolveSelfReportedBlocker(fakeBlockerSession("Login failed and I could not get in. Separately, the search box worked.")))
      .toContain("Login failed");
  });

  it("adapter fail score turns an otherwise goal_satisfied browser run red while keeping the bundle verifiable", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        score: failingBrowserScore,
        deriveFeedback: browserFeedback,
        deriveArtifacts: async (ctx) => {
          await mkdir(path.join(ctx.runDir, "adapter"), { recursive: true });
          await writeFile(
            path.join(ctx.runDir, "adapter", "browser-state-proof.json"),
            `${JSON.stringify({
              schema: "example.adapter-state-proof.v1",
              runId: ctx.runId,
              status: "failed-product-acceptance",
              backend: ctx.backend
            }, null, 2)}\n`,
            "utf8"
          );
          return [{
            schema: "humanish.adapter-artifact.v1",
            namespace: BROWSER_ADAPTER_NAMESPACE,
            label: "Browser adapter state proof",
            path: "adapter/browser-state-proof.json",
            kind: "state",
            note: "Adapter-owned product/state readback proof."
          }];
        }
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Adapter scorer failed the run");

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore?.namespace).toBe(BROWSER_ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("Adapter scorer failed the run");
    expect(bundle.review.gaps.some((gap) => gap.includes("Adapter scorer failed the run"))).toBe(true);
    expect(bundle.feedbackCandidates).toHaveLength(1);
    expect(bundle.feedbackCandidates[0]?.adapter?.namespace).toBe(BROWSER_ADAPTER_NAMESPACE);
    expect(bundle.feedbackCandidates[0]?.substrate).toBe("e2b-desktop");
    expect(bundle.adapterArtifacts).toEqual([{
      schema: "humanish.adapter-artifact.v1",
      namespace: BROWSER_ADAPTER_NAMESPACE,
      label: "Browser adapter state proof",
      path: "adapter/browser-state-proof.json",
      kind: "state",
      note: "Adapter-owned product/state readback proof."
    }]);
    const observerData = JSON.parse(await readFile(path.join(runDir, "observer", "observer-data.json"), "utf8"));
    expect(observerData.artifactLinks).toContainEqual({
      label: "Browser adapter state proof",
      href: "../adapter/browser-state-proof.json",
      kind: "state"
    });

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);

    await rm(path.join(runDir, "adapter", "browser-state-proof.json"), { force: true });
    const missing = await verifyRun(cwd, result.runId);
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toBe("Run bundle failed verification.");
    expect(missing.checks.find((check) => check.name === "local evidence artifacts exist")?.message)
      .toContain("adapter/browser-state-proof.json");
  });

  it("malformed browser adapter outputs are dropped, preserving default green behavior", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        score: () => ({ schema: "humanish.adapter-score.v1", namespace: "", status: "fail", score: 0, summary: "bad" }) as RunAdapterScore,
        deriveArtifacts: () => ([{
          schema: "humanish.adapter-artifact.v1",
          namespace: BROWSER_ADAPTER_NAMESPACE,
          label: "Bad artifact",
          path: "../secret.json",
          kind: "state",
          note: "bad path"
        }]),
        deriveFeedback: () => ([{
          schema: "humanish.feedback-candidate.v1",
          id: "bad",
          summary: "Malformed candidate missing required run fields.",
          evidence: [],
          redaction: { status: "passed", notes: "shape test" }
        }] as unknown as RunFeedbackCandidate[])
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("adapter-score.v1") || warning.includes("feedback-candidate.v1"))).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore).toBeUndefined();
    expect(bundle.adapterArtifacts).toBeUndefined();
    expect(bundle.feedbackCandidates).toHaveLength(0);
    expect(bundle.review.verdict).toBe("pass");

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("DEFAULT persists RAW screenshots (full fidelity, local) and warns the bundle is not publish-safe as-is", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.redaction.screenshots).toBe("raw");
    expect(bundle.streams[0].actor.items.filter((i: { kind: string }) => i.kind === "screenshot")
      .every((i: { screenshotRef?: { redaction: string } }) => i.screenshotRef?.redaction === "none")).toBe(true);
    expect(outcome.result.warnings.some((w) => w.toLowerCase().includes("full-fidelity") || w.toLowerCase().includes("raw"))).toBe(true);

    // Honest labels (invariant 6): a raw run must never be labeled "redacted" anywhere.
    expect(bundle.streams[0].embed.title).toBe("CUA desktop (raw)");
    const screenshotLabels = bundle.streams[0].artifacts
      .filter((a: { kind: string }) => a.kind === "screenshot")
      .map((a: { label: string }) => a.label);
    expect(screenshotLabels.length).toBeGreaterThan(0);
    expect(screenshotLabels.every((label: string) => label.endsWith("(raw)"))).toBe(true);
    expect(bundle.redaction.notes).toContain("FULL-FIDELITY (raw)");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toMatch(/\d+ raw screenshot\(s\)/);
    for (const text of [JSON.stringify(bundle), reviewMd]) {
      expect(text).not.toContain("(redacted)");
      expect(text).not.toContain("redacted screenshot");
    }
    // The raw warning must not promise a commit-blocking scan downstream users do not have
    // (the binary-asset scan is humanish's own CI, not part of the package).
    const rawWarning = outcome.result.warnings.find((w) => w.includes("full-fidelity"));
    expect(rawWarning).toContain(".humanish");
    expect(rawWarning).toContain("review");
    expect(rawWarning).not.toContain("binary-asset scan");
    expect(rawWarning).not.toContain("blocked from commit");
  });

  it("policies.redactScreenshots: true persists blurred screenshots and drops the raw warning", async () => {
    const config = cuaConfig();
    const redactedConfig: LabConfig = { ...config, policies: { ...config.policies, redactScreenshots: true } };
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(redactedConfig, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.redaction.screenshots).toBe("blurred");
    expect(outcome.result.warnings.some((w) => w.toLowerCase().includes("full-fidelity"))).toBe(false);

    // Honest labels (invariant 6): the blurred mode is named as such, not a vague "redacted".
    expect(bundle.streams[0].embed.title).toBe("CUA desktop (blurred)");
    const screenshotLabels = bundle.streams[0].artifacts
      .filter((a: { kind: string }) => a.kind === "screenshot")
      .map((a: { label: string }) => a.label);
    expect(screenshotLabels.length).toBeGreaterThan(0);
    expect(screenshotLabels.every((label: string) => label.endsWith("(blurred)"))).toBe(true);
    expect(bundle.redaction.notes).toContain("blurred at capture");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toMatch(/\d+ blurred screenshot\(s\)/);
    expect(reviewMd).not.toContain("redacted screenshot");
  });

  it("policies.allowPublicTargets lets the engine drive a declared public app-url target", async () => {
    const config = cuaConfig();
    const publicConfig: LabConfig = {
      ...config,
      subject: { source: "app-url", appUrl: "https://preview-xyz.vercel.app/" },
      policies: { allowPublicTargets: true }
    };
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(publicConfig, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.error).toBeUndefined();
    expectSafeBrowserOpen(sandbox.calls, "https://preview-xyz.vercel.app/");

    // Without the policy, the engine fails closed even if a config bypasses the parser.
    const sandbox2 = makeFakeSandbox();
    const { module: module2 } = makeFakeModule(sandbox2);
    const blocked = await runLab({ ...publicConfig, policies: {} }, {
      cwd,
      cuaHooks: { env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" }, loadDesktopModule: async () => module2 }
    });
    if (blocked.backend !== "cua") throw new Error("expected cua backend");
    expect(blocked.result.ok).toBe(false);
    expect(blocked.result.error?.code).toBe("HUMANISH_CUA_LAB_SUBJECT_UNSAFE");
  });

  it("comms:email:fake — injects the catch env, deploys the catch, and drains captured mail into a digest-only evidence artifact", async () => {
    const commsPort = 8025;
    const base = cloneCuaConfig();
    const config: LabConfig = {
      ...base,
      comms: { email: { kind: "fake", injectEnv: "RESEND_API_URL", port: commsPort, recipients: [{ lane: "user", address: "user@example.test" }] } }
    };
    // What the (simulated) subject app POSTed to its Resend-shaped base URL during the run — a
    // verification email to the declared recipient, captured by the in-sandbox catch as NDJSON.
    const verificationHtml = '<p>Confirm.</p><a href="https://app.example.test/verify?token=abc123XYZ-9">Verify</a><p>Code: 481920</p>';
    const capturedNdjson =
      JSON.stringify({ t: 1, path: "/emails", body: JSON.stringify({ from: "no-reply@example.test", to: ["user@example.test"], subject: "Confirm your email", html: verificationHtml }) }) + "\n";
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        // the comms catch readiness probe must see OUR service marker (not the subject's plain READY)
        if (command.includes(`${commsPort}/health`)) return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        // the teardown drain `cat`s the in-sandbox NDJSON of captured sends
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson")) return { stdout: capturedNdjson };
        return undefined;
      })
    });
    const { module, created } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // The adopter-named base-URL env was injected into the subject sandbox at create (the app boots reading it).
    expect(created[0]?.envs?.RESEND_API_URL).toBe(`http://127.0.0.1:${commsPort}`);
    // And the in-sandbox capture script was written into the subject sandbox (the catch was deployed).
    expect(sandbox.calls.some(([name, p]) => name === "files.write" && typeof p === "string" && p.endsWith("catch.py"))).toBe(true);

    // The captured mail was drained + routed + written as a digest-only comms-thread artifact, and
    // REGISTERED in the lane's stream artifacts (so the bundle's existence-verify + scan cover it).
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const commsArtifact = bundle.streams[0].artifacts.find((a: { path: string; kind: string }) => a.path === "comms/thread.json");
    expect(commsArtifact).toMatchObject({ kind: "log", label: "comms thread" });
    const threadRaw = await readFile(path.join(runDir, "comms", "thread.json"), "utf8");
    const thread = JSON.parse(threadRaw) as { schema: string; count: number; thread: Array<{ toDigests: string[]; codeCount: number }> };
    expect(thread.schema).toBe("humanish.comms-thread.v1");
    expect(thread.count).toBe(1);
    expect(thread.thread[0]!.codeCount).toBe(1); // the OTP is a count, never stored
    // Public-safety: NO raw address / link / OTP / subject text in the persisted evidence.
    expect(threadRaw).not.toContain("user@example.test");
    expect(threadRaw).not.toContain("app.example.test/verify");
    expect(threadRaw).not.toContain("481920");
    expect(threadRaw).not.toContain("Confirm your email");
  });

  it("comms:email:fake — TELLS the persona its address and inbox URL, and stays silent for a lane that has neither", async () => {
    // The half no test covered. Capture and drain were proven; whether the ACTOR is ever told an
    // inbox exists was not. That is the gap a live run hit: mail landing in a catch nobody opened,
    // because the persona was never handed the address to sign up with or the URL to read.
    const commsPort = 8025;
    const base = cloneCuaConfig();
    const config: LabConfig = {
      ...base,
      comms: {
        email: {
          kind: "fake",
          injectEnv: "RESEND_BASE_URL",
          port: commsPort,
          recipients: [{ lane: "lane-01", address: "signup-a@example.test" }]
        }
      }
    };
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes(`${commsPort}/health`)) return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson")) return { stdout: "" };
        return undefined;
      })
    });
    const { module } = makeFakeModule(sandbox);
    let t = 0;
    const seenInstructions: string[] = [];
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => {
          seenInstructions.push(options.instructions);
          return runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
        },
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    const prompt = seenInstructions[0] ?? "";
    // The address, because the drain matches captured mail against the DECLARED address — an actor
    // that invents its own at signup gets an inbox that stays empty forever.
    expect(prompt).toContain("signup-a@example.test");
    // The inbox URL, because otherwise there is nowhere to go when the app says "we emailed you".
    expect(prompt).toContain(`http://127.0.0.1:${commsPort}`);
    // And the wait steering, because a mid-flow model reads "we emailed you" as a blocker and ends
    // its session — the exact give-up a live run documented.
    expect(prompt.toLowerCase()).toContain("waiting for an email is normal");
  });

  it("comms:email:fake — does NOT tell a lane about an inbox it could never receive into", async () => {
    // A lane with no addressed recipient must not be sent to an inbox that will stay empty: it
    // would refresh forever and burn the session on a promise the harness cannot keep.
    const commsPort = 8025;
    const base = cloneCuaConfig();
    const config: LabConfig = {
      ...base,
      comms: { email: { kind: "fake", injectEnv: "RESEND_BASE_URL", port: commsPort, recipients: [{ lane: "lane-01" }] } }
    };
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes(`${commsPort}/health`)) return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson")) return { stdout: "" };
        return undefined;
      })
    });
    const { module } = makeFakeModule(sandbox);
    let t = 0;
    const seenInstructions: string[] = [];
    await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => {
          seenInstructions.push(options.instructions);
          return runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
        },
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    expect(seenInstructions[0] ?? "").not.toContain("Email inbox:");
  });

  it("comms:email:fake — warns (never silently loses) when captured mail matches no declared recipient", async () => {
    const commsPort = 8025;
    const base = cloneCuaConfig();
    // comms declared but NO recipients → the app's send is captured but matches no provisioned inbox.
    const config: LabConfig = { ...base, comms: { email: { kind: "fake", injectEnv: "RESEND_API_URL", port: commsPort } } };
    const capturedNdjson =
      JSON.stringify({ t: 1, path: "/emails", body: JSON.stringify({ from: "no-reply@example.test", to: ["user@example.test"], subject: "Confirm", html: "<p>Code: 481920</p>" }) }) + "\n";
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes(`${commsPort}/health`)) return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson")) return { stdout: capturedNdjson };
        return undefined;
      })
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // Captured-but-unevidenced mail surfaces as a warning (not lost silently); no artifact registered.
    expect(outcome.result.warnings.some((w) => w.includes("captured") && w.includes("no comms evidence"))).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].artifacts.find((a: { path: string }) => a.path === "comms/thread.json")).toBeUndefined();
  });

  it("comms:email:fake — tells the persona its inbox URL and renders the LIVE surface mid-run", async () => {
    const commsPort = 8025;
    const base = cloneCuaConfig();
    // Recipient lane must match the N=1 lane id (lane-01) for the inbox instruction to be injected.
    const config: LabConfig = {
      ...base,
      comms: { email: { kind: "fake", injectEnv: "RESEND_API_URL", port: commsPort, recipients: [{ lane: "lane-01", address: "user@example.test" }] } }
    };
    const verificationHtml = '<p>Confirm.</p><a href="http://127.0.0.1:3000/verify?token=abc123XYZ-9">Verify</a><p>Code: 481920</p>';
    const capturedNdjson =
      JSON.stringify({ t: 1, path: "/emails", body: JSON.stringify({ from: "no-reply@example.test", to: ["user@example.test"], subject: "Confirm your email", html: verificationHtml }) }) + "\n";
    let t = 0;
    let seenInstructions = "";
    const streamLifecycle: string[] = [];
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes(`${commsPort}/health`)) return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson")) return { stdout: capturedNdjson };
        return undefined;
      })
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        // #357 lifecycle: ready must fire while the sandbox lives, ended after its teardown —
        // the pair is what lets the watch overlay stop serving a dead stream URL.
        onRuntimeStreamReady: (stream) => { streamLifecycle.push(`ready:${stream.streamId}`); },
        onRuntimeStreamEnded: (stream) => { streamLifecycle.push(`ended:${stream.streamId}`); },
        loadDesktopModule: async () => module,
        runSession: async (options) => {
          seenInstructions = options.instructions;
          return runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
        },
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // The persona actually received the inbox URL in its prompt (loopback, same sandbox as its browser).
    expect(seenInstructions).toContain(`http://127.0.0.1:${commsPort}/inbox`);
    // The full handoff (#351): the persona is told WHICH address to sign up with (the drain matches
    // the declared address, so an invented one would leave the inbox empty forever) and that
    // waiting for an email is a next step, never a give-up state.
    expect(seenInstructions).toContain("Your email address is user@example.test");
    expect(seenInstructions).toContain("do not end your session while waiting");
    // The live inbox surface was rendered into the sandbox DURING the run (the mid-run loop wrote the list).
    expect(sandbox.calls.some(([name, p]) => name === "files.write" && typeof p === "string" && p.endsWith("/surface/inbox/index"))).toBe(true);
    // #357 lifecycle: the lane announced its live stream while the sandbox lived, and announced
    // the END after teardown — ready strictly before ended, one pair, same stream id.
    expect(streamLifecycle).toEqual(["ready:stream-001", "ended:stream-001"]);
  });

  it("comms:email:fake — writes an EMPTY inbox up front so /inbox never 404s before mail arrives", async () => {
    const commsPort = 8025;
    const base = cloneCuaConfig();
    const config: LabConfig = {
      ...base,
      comms: { email: { kind: "fake", injectEnv: "RESEND_API_URL", port: commsPort, recipients: [{ lane: "lane-01", address: "user@example.test" }] } }
    };
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes(`${commsPort}/health`)) return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
        if (command.startsWith("cat ") && command.includes("deliveries.ndjson")) return { stdout: "" }; // NO mail captured
        return undefined;
      })
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // The empty inbox list was written up front, so a persona opening /inbox gets "No messages yet.", not a 404.
    const write = sandbox.calls.find(([name, p]) => name === "files.write" && typeof p === "string" && p.endsWith("/surface/inbox/index"));
    expect(write).toBeDefined();
    expect(String(write![2])).toContain("No messages yet");
  });

  it("honors subject.clone.keep on FAILURE: leaves the sandbox up for debugging instead of killing it", async () => {
    const config = cloneCuaConfig();
    const keepConfig: LabConfig = { ...config, subject: { ...config.subject, clone: { ...config.subject.clone, keep: true } } };
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(keepConfig, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async () => { throw new Error("boom during session"); }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);
    // Failure + keep → NOT killed, with a debug warning naming the sandbox.
    expect(killed).toEqual([]);
    expect(outcome.result.sandbox?.killed).toBe(false);
    expect(outcome.result.warnings.some((w) => w.includes("kept for debugging"))).toBe(true);
  });

  it("does NOT pass a goal_satisfied run with zero actions and zero messages (blank-screen honesty guard)", async () => {
    // Model immediately returns done with no action and no message — i.e. it saw a blank/loading
    // screen and stopped. This must NOT be reported as a pass.
    const noEngagementSession = [
      { id: "r1", output: [{ type: "message", content: [] }] } // no actions, no text
    ];
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(noEngagementSession) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    // The session itself is goal_satisfied, but the LAB refuses to call zero-engagement a pass.
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("no actions");
    expect(result.warnings.some((w) => w.includes("ZERO actions"))).toBe(true);

    // The independent verifier reaches the same judgment from the persisted bundle alone —
    // a hollow bundle must not verify ok even though the producer wrote redaction: passed.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
    expect(verified.checks.find((check) => check.name === "actor engagement")?.ok).toBe(false);
  });

  it("a lane the harness refused as 'not a credible pass' is not written up as a pass (#476)", async () => {
    // Found on a real run: the lane said ok:false / HUMANISH_CUA_LAB_FAILED / "not a credible
    // pass", and the BUNDLE said verdict pass, 1/1 reached the goal. Every projection of the
    // bundle — Observer tally, `humanish runs`, the status index, a share — repeated the pass.
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(BLOCKED_AFTER_PARTIAL_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    // The lane's judgment, unchanged: the actor claimed goal_satisfied, the harness refused it.
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_FAILED");
    expect(result.error?.message).toContain("not a credible pass");

    // The durable evidence now says the same thing the lane said.
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.review.verdict).toBe("blocked");
    expect(bundle.review.summary).toMatch(/^Not counted as a pass: the participant's final message described a blocker\./);
    // 0/1 reached the goal, 1 blocked, 1 reported friction — the honest reading of that run.
    expect(bundle.review.participants).toMatchObject({ total: 1, reachedGoal: 0, blocked: 1, reportedFriction: 1 });
    // The trace keeps the claim: what the actor SAID is evidence, what the harness COUNTED is the review.
    expect(bundle.streams[0].actor.completionReason).toBe("goal_satisfied");

    // The status index copies the review verbatim, so it inherits the fix rather than needing one.
    const status = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "status.json"), "utf8"));
    expect(status.outcome?.verdict).toBe("blocked");
    expect(status.outcome?.participants).toMatchObject({ total: 1, reachedGoal: 0 });

    // The evidence is sound — the harness did what it said — so verify still passes. A blocked
    // participant is a finding, not a broken instrument.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("device preset drives the E2B desktop resolution + tells the model it's mobile (sim-parity)", async () => {
    const config = cuaConfig();
    const mobileConfig: LabConfig = {
      ...config,
      execution: { ...config.execution, target: "e2b-desktop", desktop: { device: "mobile" } }
    };
    const sandbox = makeFakeSandbox();
    const { module, created } = makeFakeModule(sandbox);
    const sessionOptionsSeen: CuaActorSessionOptions[] = [];
    const outcome = await runLab(mobileConfig, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => {
          sessionOptionsSeen.push(options);
          return runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    // The mobile preset (414x896) sizes the E2B desktop — NOT 1280x800 — but its width is FLOORED to
    // Chrome's ~500px window minimum, so the rendered screen the window fits is 500x896 (no clip).
    expect(created[0]?.resolution).toEqual([500, 896]);
    // And the model is TOLD it's a 414 mobile device (the device IDENTITY / sim-parity prompt signal is
    // the unfloored preset, even though the screen renders at the 500px floor).
    expect(sessionOptionsSeen[0]?.instructions).toContain("mobile user");
    expect(sessionOptionsSeen[0]?.instructions).toContain("414x896");
    // The bundle records the requested screen (the floored render target we actually asked E2B for), but
    // this fake exposes no CDP measurement and therefore cannot honestly claim a CSS viewport.
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.streams[0].desktopGeometry.screen.requested).toEqual({ width: 500, height: 896 });
    expect(bundle.streams[0].viewport).toBeUndefined();
  });

  it("device resolution order: raw resolution overrides the preset; default is desktop 1440x950", async () => {
    const def = makeFakeSandbox();
    const defMod = makeFakeModule(def);
    const defConfig: LabConfig = { ...cuaConfig(), execution: { target: "e2b-desktop" } };
    const r1 = await runLab(defConfig, {
      cwd, cuaHooks: { env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" }, loadDesktopModule: async () => defMod.module,
        runSession: async (o) => runCuaActorSession({ ...o, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }) }
    });
    if (r1.backend !== "cua") throw new Error("expected cua");
    expect(defMod.created[0]?.resolution).toEqual([1440, 950]);

    const ov = makeFakeSandbox();
    const ovMod = makeFakeModule(ov);
    const ovConfig: LabConfig = { ...cuaConfig(), execution: { target: "e2b-desktop", desktop: { device: "mobile", resolution: [1024, 768] } } };
    const ovSeen: CuaActorSessionOptions[] = [];
    const r2 = await runLab(ovConfig, {
      cwd, cuaHooks: { env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" }, loadDesktopModule: async () => ovMod.module,
        runSession: async (o) => { ovSeen.push(o); return runCuaActorSession({ ...o, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }); } }
    });
    if (r2.backend !== "cua") throw new Error("expected cua");
    expect(ovMod.created[0]?.resolution).toEqual([1024, 768]);
    // Consistency: a raw resolution override must NOT inherit a named preset's mobile/DSF — the
    // prompt + requested-screen metadata reflect the custom non-mobile geometry, not "mobile".
    expect(ovSeen[0]?.instructions).not.toContain("mobile user");
    const ovBundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", r2.result.runId, "run.json"), "utf8"));
    expect(ovBundle.streams[0].desktopGeometry.screen.requested).toEqual({ width: 1024, height: 768 });
    expect(ovBundle.streams[0].viewport).toBeUndefined();
  });

  it("opens HTTP targets with a shell-quoted browser command so query params survive", async () => {
    const targetUrl = "http://127.0.0.1:3000/api/bootstrap?origin=http%3A%2F%2F127.0.0.1%3A3000&scenario=alpha&redirect=%2Fdashboard";
    const sandbox = makeFakeSandbox({ withOpen: false });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(targetUrl), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    const openIndex = expectSafeBrowserOpen(sandbox.calls, targetUrl);
    const openCommand = String(sandbox.calls[openIndex]?.[1] ?? "");
    expect(openCommand).toContain("&scenario=alpha&redirect=");
    expect(openCommand).toContain("--disable-component-update");
    expect(openCommand).toContain("--disable-extensions");
    expect(openCommand).toContain("--password-store=basic");
    expect(openCommand).toContain("credentials_enable_service");
    expect(openCommand).toContain('"custom_chrome_frame":false');
    expect(openCommand).toContain("\"password_manager_enabled\":false");
    expect(sandbox.calls.some((call) => call[0] === "open")).toBe(false);
    expect(sandbox.calls.some((call) => call[0] === "launch")).toBe(false);
  });

  it("launches the requested desktop browser and records browser provenance", async () => {
    const targetUrl = "http://127.0.0.1:3000/api/bootstrap?scenario=chrome-proof&redirect=%2Fdashboard";
    const config: LabConfig = {
      ...cuaConfig(targetUrl),
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { resolution: [1280, 800], browser: "chrome" } }
    };
    const sandbox = makeFakeSandbox({
      commandHandler: (command) =>
        command.includes("browser_preference='chrome'")
          ? { stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n", exitCode: 0 }
          : undefined
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    const openIndex = expectSafeBrowserOpen(sandbox.calls, targetUrl);
    const openCommand = String(sandbox.calls[openIndex]?.[1] ?? "");
    expect(openCommand).toContain("browser_preference='chrome'");
    expect(openCommand).toContain("launch_browser google-chrome google-chrome");
    expect(sandbox.calls.some((call) => call[0] === "open")).toBe(false);
    expect(sandbox.calls.some((call) => call[0] === "launch")).toBe(false);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.desktopBrowser).toEqual({ requested: "chrome", resolved: "google-chrome" });
  });

  it("attributes explicit Firefox geometry to Firefox even when stale Chrome CDP is present", async () => {
    const config: LabConfig = {
      ...cuaConfig(),
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { resolution: [1280, 800], browser: "firefox" } }
    };
    const firefoxWindowId = "9437185";
    const sandbox = makeFakeSandbox({
      commandHandler: (command) => {
        if (command.includes("browser_preference='firefox'")) {
          return { stdout: "HUMANISH_BROWSER_RESOLVED=firefox\n", exitCode: 0 };
        }
        if (command.includes("xdpyinfo")) {
          return { stdout: "dimensions: 1280x800 pixels (300x200 millimeters)\n", exitCode: 0 };
        }
        if (command.includes("find_firefox_window()")) {
          return { stdout: `WINDOW_ID=${firefoxWindowId}\n`, exitCode: 0 };
        }
        if (command.includes("find_chrome_window()")) {
          return { stdout: "WINDOW_ID=7340035\n", exitCode: 0 };
        }
        if (command.includes("getwindowgeometry")) {
          return { stdout: "X=0\nY=0\nWIDTH=1280\nHEIGHT=800\n", exitCode: 0 };
        }
        if (command.includes("browserWindow: { x: window.screenX")) {
          return {
            stdout: JSON.stringify({
              browserWindow: { x: 0, y: 0, width: 777, height: 555 },
              viewport: { width: 777, height: 444, deviceScaleFactor: 1 }
            }),
            exitCode: 0
          };
        }
        return undefined;
      }
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    const commands = sandbox.calls
      .filter((call) => call[0] === "commands.run")
      .map((call) => String(call[1]));
    expect(commands.some((command) => command.includes("find_firefox_window()"))).toBe(true);
    expect(commands.some((command) => command.includes("find_chrome_window()"))).toBe(false);
    expect(commands.some((command) => command.includes("browserWindow: { x: window.screenX"))).toBe(false);
    expect(commands.some((command) => command.includes(`win='${firefoxWindowId}'`))).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.desktopBrowser).toEqual({ requested: "firefox", resolved: "firefox" });
    expect(bundle.streams[0].desktopGeometry.browserWindow).toEqual({
      x: 0, y: 0, width: 1280, height: 800, source: "xdotool"
    });
    expect(bundle.streams[0].desktopGeometry.viewport).toBeUndefined();
    expect(bundle.streams[0].viewport).toBeUndefined();
    expect(bundle.streams[0].desktopGeometry.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("unavailable for Firefox")
    ]));
  });

  it("live with missing keys fails closed, names the variables, and never creates a sandbox", async () => {
    const sandbox = makeFakeSandbox();
    const { module, created } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: { env: { OPENAI_API_KEY: "present-key" }, loadDesktopModule: async () => module }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_KEYS_MISSING");
    expect(result.error?.message).toContain("E2B_API_KEY");
    expect(result.error?.message).not.toContain("OPENAI_API_KEY and");
    expect(result.error?.message).not.toContain("present-key");
    expect(created).toHaveLength(0);
    expect(result.runId).toBe("not-created");
  });

  it("kills the sandbox and still persists a failed-evidence bundle when the session throws", async () => {
    const sandbox = makeFakeSandbox();
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async () => {
          throw new Error("provider exploded mid-session");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_FAILED");
    expect(result.error?.message).toContain("provider exploded");
    expect(killed).toEqual(["fake-sandbox-001"]);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")
    );
    expect(bundle.simulations[0].status).toBe("failed");
    expect(bundle.review.verdict).toBe("fail");
  });

  it("rejects a non-computer-use actor at the engine even if a config bypasses the parser", async () => {
    const config = cuaConfig();
    const tampered = { ...config, actors: [{ type: "codex-app-server" }] };
    const result = await runCuaActorLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_ACTOR_UNSUPPORTED");
  });

  it("rejects path-shaped runtime lane ids before provider or desktop hooks", async () => {
    const config = cuaConfig();
    const actor = config.actors[0]!;
    const { laneFocus: _laneFocus, ...actorWithoutLaneFocus } = actor;
    const tampered: LabConfig = {
      ...config,
      actors: [{ ...actorWithoutLaneFocus, lanes: [{ id: "../escape" }] }]
    };
    let desktopLoads = 0;
    const result = await runCuaActorLab({
      cwd,
      config: tampered,
      dryRun: false,
      hooks: {
        loadDesktopModule: async () => {
          desktopLoads += 1;
          throw new Error("must not load");
        }
      }
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_FANOUT_INVALID");
    expect(result.runId).toBe("not-created");
    expect(desktopLoads).toBe(0);
  });

  it("re-enforces the loopback entry boundary at the engine even if a config bypasses the parser", async () => {
    const config = cuaConfig();
    const tampered = { ...config, subject: { source: "app-url" as const, appUrl: "https://example.com/" } };
    const result = await runCuaActorLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_SUBJECT_UNSAFE");
    // Nothing was persisted, so no artifact can mislabel the public URL as loopback.
    expect(result.runId).toBe("not-created");
    await expect(readdir(path.join(cwd, ".humanish", "runs"))).rejects.toThrow();
  });

  it("redacts harness-level session errors before they reach ANY persisted artifact", async () => {
    // Built dynamically so no secret-shaped literal ever appears in this source file.
    const secretToken = "Bearer " + "a1b2c3d4e5".repeat(4);
    const hostPath = "/home/" + "someuser/private-checkout/app";
    const sandbox = makeFakeSandbox();
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async () => {
          throw new Error(`request failed with ${secretToken} while reading ${hostPath}`);
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(killed).toEqual(["fake-sandbox-001"]);
    // The error is reported — but scrubbed — and the bundle still VERIFIES (the gate must not
    // trip on the lab's own error report).
    expect(result.error?.message).toContain("[REDACTED_SECRET]");
    expect(result.error?.message).not.toContain(secretToken);
    expect(result.observer?.ok).toBe(true);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(secretToken);
      expect(text, file).not.toContain(hostPath);
    }
  });

  it("turns a missing @e2b/desktop peer into a structured failure with a complete failed bundle (no raw throw, no orphan dir)", async () => {
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => {
          throw new Error("Live E2B desktop launch requires optional peer dependency @e2b/desktop.");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_FAILED");
    expect(result.error?.message).toContain("@e2b/desktop");
    // The run dir is a complete failed-evidence bundle, not an orphan screenshots/ shell.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const files = await readdir(runDir);
    expect(files).toContain("run.json");
    expect(files).toContain("review.md");
    expect(result.observer?.ok).toBe(true);
  });

  it("writes lab identity into the bundle AND a finalized status record on disk (#455)", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      lab: { id: "cua-demo", path: "humanish/labs/cua-demo.yaml", origin: "committed" },
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const runId = outcome.result.runId;

    // Durable identity on the evidence-of-record.
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8")) as {
      lab?: { id: string; path?: string; origin?: string };
      review: { verdict: string };
    };
    expect(bundle.lab).toEqual({ id: "cua-demo", path: "humanish/labs/cua-demo.yaml", origin: "committed" });

    // And the index/liveness record, finalized from that same bundle — never claiming more.
    const status = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", runId, "status.json"), "utf8")
    ) as { schema: string; state: string; lab?: { id: string }; outcome?: { verdict?: string }; completedAt?: string };
    expect(status.schema).toBe("humanish.run-status.v1");
    expect(status.state).toBe("finished");
    expect(status.lab?.id).toBe("cua-demo");
    expect(status.outcome?.verdict).toBe(bundle.review.verdict);
    expect(typeof status.completedAt).toBe("string");
  });

  it("points .humanish/runs/latest.json at the cua run so `verify --run latest` stays honest", async () => {
    const outcome = await runLab(cuaConfig(), { cwd, dryRun: true });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);

    const pointer = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", "latest.json"), "utf8"));
    expect(pointer.schema).toBe("humanish.latest-run.v1");
    expect(pointer.runId).toBe(result.runId);

    const verified = await verifyRun(cwd, "latest");
    expect(verified.ok).toBe(true);
    expect(verified.run).toBe("latest");
    expect(verified.bundlePath).toContain(result.runId);
  });

  it("reports killed=false (with a warning) when the installed SDK lacks Sandbox.kill", async () => {
    const sandbox = makeFakeSandbox();
    const module: E2BDesktopModule = {
      Sandbox: { create: async () => sandbox }
    };
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.sandbox?.killed).toBe(false);
    expect(outcome.result.warnings.some((warning) => warning.includes("Sandbox.kill"))).toBe(true);
  });

  it("clone route: clones, installs, builds, serves, probes, and drives the subject — with provenance and zero value leaks", async () => {
    const config = cloneCuaConfig({ env: ["DATABASE_URL"] });
    const cloneHead = "8758a953415e1f60091d";
    const servedHead = "859043fc8dec448d2ac3";
    let revParseCount = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (!command.includes("rev-parse")) return undefined;
        revParseCount += 1;
        return { stdout: `${revParseCount === 1 ? cloneHead : servedHead}\n` };
      })
    });
    const { module, created, killed } = makeFakeModule(sandbox);

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: {
          OPENAI_API_KEY: "test-openai-key",
          E2B_API_KEY: "test-e2b-key",
          DATABASE_URL: "postgres-secret-value"
        },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.session?.status).toBe("passed");
    expect(result.appUrl).toBe("http://127.0.0.1:3000/");

    // Env placement: EXACTLY the declared subject names — never the actor keys.
    expect(created[0]?.envs).toEqual({ DATABASE_URL: "postgres-secret-value" });

    // Provisioning sequence: the wrapper scripts carry the declared commands.
    const scriptFor = (name: string): string => {
      const entry = sandbox.calls.find(
        (call): call is [string, string, string] => call[0] === "files.write" && String(call[1]).endsWith(`${name}/run.sh`)
      );
      if (!entry) throw new Error(`missing script for ${name}`);
      return entry[2];
    };
    expect(scriptFor("subject-clone")).toContain("git clone --depth 2 https://github.com/example-org/example-app.git");
    expect(scriptFor("subject-install")).toContain("( pnpm install --frozen-lockfile )");
    expect(scriptFor("subject-install")).toContain("cd '/home/user/subject'");
    expect(scriptFor("subject-build")).toContain("( pnpm build )");
    expect(scriptFor("subject-start")).toContain("( pnpm start )");

    // Readiness was probed before the browser opened on the served URL.
    const probeIndex = sandbox.calls.findIndex(
      (call) => call[0] === "commands.run" && String(call[1]).includes("curl")
    );
    const openIndex = expectSafeBrowserOpen(sandbox.calls, "http://127.0.0.1:3000/");
    expect(probeIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeGreaterThan(probeIndex);

    // The model's click actuated the real executor against the served subject.
    expect(sandbox.calls).toContainEqual(["leftClick", 11, 22]);
    expect(killed).toEqual(["fake-sandbox-001"]);

    // Provenance (invariant 5): repo + commit + env NAMES — on the result and in evidence.
    // No subject.state declared → the state story is explicitly "undeclared", never silent.
    expect(result.subject).toEqual({
      source: "clone",
      repo: "example-org/example-app",
      commit: servedHead,
      envNames: ["DATABASE_URL"],
      state: { provenance: "undeclared" }
    });
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(revParseCount).toBeGreaterThan(1);
    expect(bundle.subject.commit).toBe(servedHead);
    expect(JSON.stringify(bundle.subject)).not.toContain(cloneHead);
    const provenance = bundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(provenance?.message).toContain(`example-org/example-app@${servedHead}`);
    expect(provenance?.message).toContain("DATABASE_URL");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toContain(`Subject cloned from example-org/example-app@${servedHead}`);

    // Values never persist: not the subject env value, not the actor keys.
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson", "actor.json"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("postgres-secret-value");
      expect(text, file).not.toContain("test-openai-key");
      expect(text, file).not.toContain("test-e2b-key");
    }
  });

  it("clone route: onPhase (injected capture sink) emits the ordered started/completed sequence for clone/install/build/ready (#263)", async () => {
    const config = cloneCuaConfig();
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);
    const phaseEvents: Array<{ type: string; ok?: boolean; durationMs?: number; message: string }> = [];
    const phaseCtxs: Array<{ laneId: string; laneCount: number }> = [];

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        // The default sink is process.stderr.write; a test-injected sink replaces it entirely
        // (the CuaActorLabHooks seam this closes #263 with) so the ordering below is captured
        // deterministically instead of scraping stderr.
        onPhase: (event, ctx) => {
          phaseEvents.push(event);
          phaseCtxs.push(ctx);
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    // One event PER BOUNDARY, never per poll tick: exactly clone/install/build (started+completed),
    // the lone fire-and-forget serve.started, then ready (started+completed). No subject.state
    // events: cloneCuaConfig() declares no seed steps.
    expect(phaseEvents.map((event) => event.type)).toEqual([
      "cua-lab.subject.clone.started",
      "cua-lab.subject.clone.completed",
      "cua-lab.subject.runtime.started",
      "cua-lab.subject.runtime.completed",
      "cua-lab.subject.install.started",
      "cua-lab.subject.install.completed",
      "cua-lab.subject.build.started",
      "cua-lab.subject.build.completed",
      "cua-lab.subject.serve.started",
      "cua-lab.subject.ready.started",
      "cua-lab.subject.ready.completed"
    ]);

    // Started events (including the lone serve.started) carry neither ok nor durationMs;
    // every completed event on this all-succeeding fake run carries both.
    for (const event of phaseEvents) {
      if (event.type.endsWith(".started")) {
        expect(event.ok).toBeUndefined();
        expect(event.durationMs).toBeUndefined();
      } else {
        expect(event.ok).toBe(true);
        expect(typeof event.durationMs).toBe("number");
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
      }
    }

    // Messages are public-safe by construction: no URLs, no paths, no command text.
    for (const event of phaseEvents) {
      expect(event.message).not.toContain("http://");
      expect(event.message).not.toContain("https://");
      expect(event.message).not.toContain("/home/user");
      expect(event.message).not.toContain("pnpm");
    }

    // Single lane: every sink call names lane-01 with laneCount 1 (no fan-out prefixing).
    for (const ctx of phaseCtxs) {
      expect(ctx).toEqual({ laneId: "lane-01", laneCount: 1 });
    }
  });

  it("clone route: the completed phase trail persists into bundle.events with durationMs folded into each message (#263)", async () => {
    const config = cloneCuaConfig();
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const phaseRunEvents = (bundle.events as Array<{ type: string; level: string; message: string }>).filter(
      (event) => event.type.startsWith("cua-lab.subject.") && event.type.endsWith(".completed")
    );
    // Only COMPLETED phases persist (started events carry no durationMs, so nothing to fold);
    // subject.serve.started never persists here either (no completed pair, no durationMs).
    expect(phaseRunEvents.map((event) => event.type)).toEqual([
      "cua-lab.subject.clone.completed",
      "cua-lab.subject.runtime.completed",
      "cua-lab.subject.install.completed",
      "cua-lab.subject.build.completed",
      "cua-lab.subject.ready.completed"
    ]);
    for (const event of phaseRunEvents) {
      expect(event.level).toBe("info");
      expect(event.message).toMatch(/\(\d+ms\)$/);
    }

    const verified = await verifyRun(cwd, outcome.result.runId);
    expect(verified.ok).toBe(true);
  });

  it("clone route with GITHUB_TOKEN: the clone authenticates via in-sandbox env — the token value never appears in any script or artifact", async () => {
    const config = cloneCuaConfig({ env: ["GITHUB_TOKEN"] });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created } = makeFakeModule(sandbox);

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", GITHUB_TOKEN: "ghp-token-value" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    // The token is provisioned as sandbox env…
    expect(created[0]?.envs).toEqual({ GITHUB_TOKEN: "ghp-token-value" });
    // …and the clone script references the VARIABLE, never the value, never a token-in-URL.
    const cloneScript = sandbox.calls.find(
      (call): call is [string, string, string] => call[0] === "files.write" && String(call[1]).endsWith("subject-clone/run.sh")
    );
    expect(cloneScript?.[2]).toContain("$GITHUB_TOKEN");
    expect(cloneScript?.[2]).toContain("http.extraHeader");
    expect(cloneScript?.[2]).not.toContain("ghp-token-value");
    expect(cloneScript?.[2]).not.toMatch(/https:\/\/[^@\s]+@github\.com/);

    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("ghp-token-value");
    }
  });

  it("fails closed BEFORE any sandbox exists when a declared subject env name is missing", async () => {
    const config = cloneCuaConfig({ env: ["DATABASE_URL"] });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("HUMANISH_CUA_LAB_SUBJECT_ENV_MISSING");
    expect(outcome.result.error?.message).toContain("DATABASE_URL");
    expect(created).toHaveLength(0);
  });

  it("retries a subject install that exits non-zero exactly once, and the phase stream says so (#602)", async () => {
    // A transient registry/TLS error inside the sandbox's npm install cost a cold adopter their
    // whole first live study; the parallel install twenty seconds later passed. First attempt
    // exits 1, the retry (its own step dir, so both logs survive) exits 0.
    const config = cloneCuaConfig();
    const statusReads: string[] = [];
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-install") && command.includes("/status")) {
          statusReads.push(command.includes("subject-install-retry") ? "retry" : "first");
          return { stdout: command.includes("subject-install-retry") ? "0" : "1" };
        }
        if (command.includes("subject-install") && command.includes("tail -c")) {
          return { stdout: "npm error code ERR_SSL_CIPHER_OPERATION_FAILED" };
        }
        return undefined;
      })
    });
    const { module } = makeFakeModule(sandbox);
    const phaseEvents: Array<{ type: string; ok?: boolean; message: string }> = [];
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        onPhase: (event) => {
          phaseEvents.push(event);
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(statusReads).toEqual(["first", "retry"]);
    const installPhases = phaseEvents.filter((event) => event.type.includes(".install"));
    expect(installPhases.map((event) => event.type)).toEqual([
      "cua-lab.subject.install.started",
      "cua-lab.subject.install-retry.started",
      "cua-lab.subject.install-retry.completed",
      "cua-lab.subject.install.completed"
    ]);
    expect(installPhases[1]?.message).toContain("first attempt exited 1; retrying once");
    expect(installPhases[2]?.ok).toBe(true);
    expect(installPhases[3]?.ok).toBe(true);
    expect(installPhases[3]?.message).toBe("subject dependencies installed (on the second attempt)");
  });

  it("a subject install that fails twice reports one actionable line before npm's own output (#602)", async () => {
    const config = cloneCuaConfig();
    let attempts = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-install") && command.includes("/status")) {
          attempts += 1;
          return { stdout: "1" };
        }
        if (command.includes("subject-install") && command.includes("tail -c")) {
          return { stdout: "npm error code ERR_SSL_CIPHER_OPERATION_FAILED\nnpm error ossl_gcm_stream_update" };
        }
        return undefined;
      })
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);
    expect(attempts).toBe(2);
    expect(killed).toEqual(["fake-sandbox-001"]);
    const message = outcome.result.error?.message ?? "";
    expect(message.indexOf("subject install failed twice (exit 1, then exit 1); the sandbox could not complete serve.install"))
      .toBeGreaterThanOrEqual(0);
    expect(message.indexOf("subject install failed twice")).toBeLessThan(message.indexOf("ERR_SSL_CIPHER_OPERATION_FAILED"));
  });

  it("scrubs PROVISIONED VALUES (no secret shape) from every artifact and the result when a serve step echoes them", async () => {
    // The P0 class: an app dumps its config on boot failure. The value is arbitrary — no
    // pattern can catch it; only literal scrubbing of known provisioned values can.
    const plainValue = "plain-text-pw-" + "12345678";
    const config = cloneCuaConfig({ env: ["DATABASE_PASSWORD"] });
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        // Both attempts fail (#602 retries an exit-code failure once under `subject-install-retry`).
        if (command.includes("subject-install") && command.includes("/status")) return { stdout: "1" };
        if (command.includes("subject-install") && command.includes("tail -c")) {
          return { stdout: `boot dump: DATABASE_PASSWORD=${plainValue} (config echo)` };
        }
        return undefined;
      })
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", DATABASE_PASSWORD: plainValue },
        loadDesktopModule: async () => module
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(killed).toEqual(["fake-sandbox-001"]);
    // The error is still diagnosable — the log tail rides along — but the VALUE is gone,
    // replaced by the scrub marker, on the result AND in every persisted artifact.
    expect(result.error?.message).toContain("subject install failed");
    expect(result.error?.message).toContain("[REDACTED_SECRET]");
    expect(result.error?.message).not.toContain(plainValue);
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(plainValue);
    }
    // And the bundle still VERIFIES: the gate must not trip on the scrubbed error report.
    expect(result.observer?.ok).toBe(true);
  });

  it("pattern-redacts a secret-shaped token in a log tail BEFORE truncation can slice through it", async () => {
    // A distinct, properly-bounded token (NOT a known provisioned value — only pattern
    // redaction can catch it). It sits at the FRONT of the log with ~2000 chars after it, so
    // the last-2000 truncation cuts THROUGH the token. Truncate-then-redact would leave a
    // prefix-less fragment that no longer matches `\bghp_…`; redact-then-truncate erases it.
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"; // 44 chars, matches whole
    const midChunk = token.slice(26, 44); // 18 distinct chars, all AFTER the cut at 22 — truncate-first would expose this
    const log = token + " " + "z".repeat(1977); // total 2022; cut lands inside the token
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("curl")) return { stdout: "WAIT" };
        if (command.includes("subject-start") && command.includes("tail -c")) return { stdout: log };
        return undefined;
      })
    });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cloneCuaConfig({ readyTimeoutMs: 5000 }), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, `${file} full token`).not.toContain(token);
      expect(text, `${file} token fragment`).not.toContain(midChunk);
    }
    expect(result.observer?.ok).toBe(true);
  });

  it("provenance wording is honest per phase: dry-run declares, failed provisioning never claims 'served'", async () => {
    // Dry-run: nothing cloned — the event must say so.
    const dry = await runLab(cloneCuaConfig(), { cwd, dryRun: true });
    if (dry.backend !== "cua") throw new Error("expected cua backend");
    const dryBundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", dry.result.runId, "run.json"), "utf8")
    );
    const dryProvenance = dryBundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(dryProvenance?.message).toContain("dry-run contract; nothing cloned");
    expect(dryProvenance?.message).not.toContain("Subject cloned from");

    // Probe failure: cloned at a real commit, but serving never completed — say exactly that.
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) =>
        command.includes("curl") ? { stdout: "WAIT" } : undefined
      )
    });
    const { module } = makeFakeModule(sandbox);
    let t = 0;
    const failed = await runLab(cloneCuaConfig({ readyTimeoutMs: 5000 }), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (failed.backend !== "cua") throw new Error("expected cua backend");
    const failedBundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", failed.result.runId, "run.json"), "utf8")
    );
    const failedProvenance = failedBundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(failedProvenance?.message).toContain("did not complete");
    expect(failedProvenance?.message).not.toContain("and served at");
  });

  it("redacts the repo slug in provenance by default for token-authenticated clones (policies.redactRepos overrides)", async () => {
    // Token present, no explicit policy → redacted by default.
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);
    const tokenHooks = {
      env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", GITHUB_TOKEN: "ghp-token-value" },
      loadDesktopModule: async () => module,
      runSession: async (options: Parameters<NonNullable<CuaActorLabHooks["runSession"]>>[0]) =>
        runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
    };
    const redacted = await runLab(cloneCuaConfig({ env: ["GITHUB_TOKEN"] }), { cwd, cuaHooks: tokenHooks });
    if (redacted.backend !== "cua") throw new Error("expected cua backend");
    expect(redacted.result.subject?.repo).toBe("repo-01");
    const runDir = path.join(cwd, ".humanish", "runs", redacted.result.runId);
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("example-org/example-app");
    }

    // Explicit policies.redactRepos: false wins over the token default.
    const explicit = cloneCuaConfig({ env: ["GITHUB_TOKEN"] });
    const explicitConfig: LabConfig = { ...explicit, policies: { redactRepos: false } };
    const sandbox2 = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module: module2 } = makeFakeModule(sandbox2);
    const unredacted = await runLab(explicitConfig, {
      cwd,
      cuaHooks: { ...tokenHooks, loadDesktopModule: async () => module2 }
    });
    if (unredacted.backend !== "cua") throw new Error("expected cua backend");
    expect(unredacted.result.subject?.repo).toBe("example-org/example-app");
  });

  it("re-enforces the clone-route structure at the engine (tampered config without serve)", async () => {
    const config = cloneCuaConfig();
    const { serve: _serve, ...subjectWithoutServe } = config.subject;
    const tampered: LabConfig = { ...config, subject: subjectWithoutServe };
    const result = await runCuaActorLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_SUBJECT_INVALID");
  });

  it("persists a failed-evidence bundle (with the server log tail) when the subject never answers the probe", async () => {
    const config = cloneCuaConfig({ readyTimeoutMs: 5000 });
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("curl")) return { stdout: "WAIT" };
        if (command.includes("tail -c")) return { stdout: "server crashed at boot" };
        return undefined;
      })
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        detachedTimers: {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          }
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_FAILED");
    expect(result.error?.message).toContain("did not answer");
    expect(result.error?.message).toContain("server crashed at boot");
    expect(killed).toEqual(["fake-sandbox-001"]);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")
    );
    expect(bundle.simulations[0].status).toBe("failed");
  });
});

describe("execution.desktop.template (custom E2B desktop image, single-lane cua route)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-template-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function templatedConfig(template?: string): LabConfig {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-template-proof",
      title: "CUA template proof",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop." }],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        desktop: { resolution: [1280, 800], ...(template === undefined ? {} : { template }) }
      },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  async function runWith(config: LabConfig) {
    const sandbox = makeFakeSandbox();
    const { module, created, templates } = makeFakeModule(sandbox);
    const hooks: CuaActorLabHooks = {
      env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      loadDesktopModule: async () => module,
      runSession: async (options) =>
        runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
    };
    const outcome = await runLab(config, { cwd, cuaHooks: hooks });
    if (outcome.backend !== "cua") throw new Error("expected the cua backend");
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    return { created, templates, bundle };
  }

  it("threads the template into Sandbox.create(template, opts) and records it in the bundle (provenance)", async () => {
    const { created, templates, bundle } = await runWith(templatedConfig("acme-desktop-with-runtimes"));
    expect(created).toHaveLength(1);
    // The desktop create received the configured template as its first (template) argument.
    expect(templates).toEqual(["acme-desktop-with-runtimes"]);
    // The options object is otherwise unchanged — the template is an ADDED selector, not a rewrite.
    expect(created[0]?.resolution).toEqual([1280, 800]);
    expect(created[0]?.lifecycle).toEqual({ onTimeout: "kill" });
    // Evidence shows WHICH image ran (public-safe: a template name is not a secret).
    expect(bundle.desktopTemplate).toBe("acme-desktop-with-runtimes");
  });

  it("byte-stable default: NO template → Sandbox.create called with NO template arg, bundle omits desktopTemplate", async () => {
    const { created, templates, bundle } = await runWith(templatedConfig());
    expect(created).toHaveLength(1);
    // undefined == create(opts): the historical single-argument call shape, unchanged.
    expect(templates).toEqual([undefined]);
    expect(bundle.desktopTemplate).toBeUndefined();
    expect("desktopTemplate" in bundle).toBe(false);
  });
});

describe("subject.state (seed/migrate/fixtures on the clone route)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-state-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const sha16 = (command: string): string => createHash("sha256").update(command).digest("hex").slice(0, 16);

  const THREE_PHASE_STATE = {
    seed: [
      { name: "prebuild", command: "node scripts/prebuild-fixtures.js", when: "before-build", timeoutMs: 300_000 },
      { name: "db-up", command: "sudo service postgresql start && pg_isready -t 30", timeoutMs: 120_000 },
      { name: "admin-user", command: "curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin", when: "after-ready", timeoutMs: 60_000 }
    ]
  };

  it("runs seed steps in their declared phases with exact commands, records seeded provenance with digests, and grows the sandbox deadline", async () => {
    const config = cloneCuaConfig({ state: THREE_PHASE_STATE });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        // Fixed clock so per-step durationMs is deterministic (0) in the record assertions.
        detachedTimers: { now: () => 0, sleep: async () => {} },
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);
    expect(killed).toEqual(["fake-sandbox-001"]);

    // Each step runs through the detached primitive under the reserved prefix, with the
    // EXACT declared command and cwd inside the subject checkout.
    const writeIndexFor = (name: string): number =>
      sandbox.calls.findIndex((call) => call[0] === "files.write" && String(call[1]).endsWith(`${name}/run.sh`));
    const scriptFor = (name: string): string => {
      const entry = sandbox.calls.find(
        (call): call is [string, string, string] => call[0] === "files.write" && String(call[1]).endsWith(`${name}/run.sh`)
      );
      if (!entry) throw new Error(`missing script for ${name}`);
      return entry[2];
    };
    expect(scriptFor("subject-state-db-up")).toContain("( sudo service postgresql start && pg_isready -t 30 )");
    expect(scriptFor("subject-state-db-up")).toContain("cd '/home/user/subject'");
    expect(scriptFor("subject-state-admin-user")).toContain("bootstrap-admin");

    // Phase ordering from the recorded call sequence: install → before-build → build →
    // before-start → start → readiness probe → after-ready → browser open.
    const probeIndex = sandbox.calls.findIndex(
      (call) => call[0] === "commands.run" && String(call[1]).includes("curl -sf -o /dev/null")
    );
    const openIndex = expectSafeBrowserOpen(sandbox.calls, "http://127.0.0.1:3000/");
    expect(writeIndexFor("subject-install")).toBeLessThan(writeIndexFor("subject-state-prebuild"));
    expect(writeIndexFor("subject-state-prebuild")).toBeLessThan(writeIndexFor("subject-build"));
    expect(writeIndexFor("subject-build")).toBeLessThan(writeIndexFor("subject-state-db-up"));
    expect(writeIndexFor("subject-state-db-up")).toBeLessThan(writeIndexFor("subject-start"));
    expect(writeIndexFor("subject-start")).toBeLessThan(probeIndex);
    expect(probeIndex).toBeLessThan(writeIndexFor("subject-state-admin-user"));
    expect(writeIndexFor("subject-state-admin-user")).toBeLessThan(openIndex);

    // The default sandbox deadline grows by the declared state budget.
    expect(created[0]?.timeoutMs).toBe(
      60_000 // execution.timeoutMs
      + 30 * 60_000 // SUBJECT_PROVISION_BUDGET_MS
      + (300_000 + 120_000 + 60_000) // Σ step.timeoutMs
      + 10 * 60_000 // SANDBOX_TIMEOUT_BUFFER_MS
    );

    // Provenance: marker seeded, per-step records with sha256-16 digests of the EXACT
    // commands — and never the command text itself.
    const expectedSeed = [
      { name: "prebuild", when: "before-build", commandDigest: sha16("node scripts/prebuild-fixtures.js"), ok: true, exitCode: 0, durationMs: 0 },
      { name: "db-up", when: "before-start", commandDigest: sha16("sudo service postgresql start && pg_isready -t 30"), ok: true, exitCode: 0, durationMs: 0 },
      { name: "admin-user", when: "after-ready", commandDigest: sha16("curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin"), ok: true, exitCode: 0, durationMs: 0 }
    ];
    expect(result.subject?.state).toEqual({ provenance: "seeded", seed: expectedSeed });

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.subject).toEqual({
      source: "clone",
      repo: "example-org/example-app",
      commit: "abc123def4567890abc1",
      envNames: [],
      state: { provenance: "seeded", seed: expectedSeed }
    });
    const provenance = bundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(provenance?.message).toContain("state: seeded (3 step(s): prebuild, db-up, admin-user)");
    const reviewMd = await readFile(path.join(runDir, "review.md"), "utf8");
    expect(reviewMd).toContain("state: seeded");
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("pg_isready"); // digests only — never command text
      expect(text, file).not.toContain("prebuild-fixtures.js");
    }

    // The independent verifier accepts the seeded claim against its evidence.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(true);
    // No undeclared-state nudge: the state story IS declared.
    expect(verified.warnings.some((w) => w.includes("no state story"))).toBe(false);
  });

  it("fails closed on a mid-sequence step failure: partial provenance, no actor session, scrubbed tail, failed bundle that still verifies", async () => {
    const plainValue = "plain-state-pw-" + "87654321";
    const config = cloneCuaConfig({
      env: ["DATABASE_PASSWORD"],
      state: {
        seed: [
          { name: "db-up", command: "start the db" },
          { name: "db-migrate", command: "run migrations" },
          { name: "fixtures", command: "load fixtures" }
        ]
      }
    });
    let sessionStarted = false;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-state-db-migrate/status")) return { stdout: "1" };
        if (command.includes("subject-state-db-migrate") && command.includes("tail -c")) {
          return { stdout: `migration blew up: DATABASE_PASSWORD=${plainValue}` };
        }
        return undefined;
      })
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", DATABASE_PASSWORD: plainValue },
        loadDesktopModule: async () => module,
        detachedTimers: { now: () => 0, sleep: async () => {} },
        runSession: async () => {
          sessionStarted = true;
          throw new Error("session must never start after a failed state step");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(sessionStarted).toBe(false);
    expect(killed).toEqual(["fake-sandbox-001"]);
    expect(result.error?.message).toContain('subject state step "db-migrate" failed (exit 1)');
    expect(result.error?.message).toContain("[REDACTED_SECRET]");
    expect(result.error?.message).not.toContain(plainValue);

    // Partial state provenance: the succeeded step ok:true, the failing step ok:false with
    // its exit code, the unreached step ABSENT — and the marker stays honest.
    expect(result.subject?.state.provenance).toBe("declared-not-run");
    expect(result.subject?.state.seed).toEqual([
      { name: "db-up", when: "before-start", commandDigest: sha16("start the db"), ok: true, exitCode: 0, durationMs: 0 },
      { name: "db-migrate", when: "before-start", commandDigest: sha16("run migrations"), ok: false, exitCode: 1, durationMs: 0 }
    ]);

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.simulations[0].status).toBe("failed");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.subject.state.provenance).toBe("declared-not-run");
    expect(bundle.subject.state.seed).toHaveLength(2);

    // The provisioned value never reaches any artifact (literal scrub pre-truncation).
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(plainValue);
    }

    // A FAILED bundle with honest partial provenance still verifies its state claim
    // (verdict is fail, so the passed-live-with-failed-step rule does not trip).
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(true);
  });

  it("times out a hung state step (kill + timedOut record) and honors clone.keep on that failure", async () => {
    const config = cloneCuaConfig({
      keep: true,
      state: { seed: [{ name: "slow", command: "sleep forever", timeoutMs: 5_000 }] }
    });
    let t = 0;
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-state-slow/status")) return { stdout: "" };
        if (command.includes("subject-state-slow") && command.includes("tail -c")) return { stdout: "still sleeping" };
        return undefined;
      })
    });
    const { module, killed } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        detachedTimers: { now: () => t, sleep: async (ms: number) => { t += ms; } }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('subject state step "slow" timed out after 5000ms');
    expect(result.subject?.state.seed?.[0]).toMatchObject({ name: "slow", ok: false, timedOut: true });
    // keep-on-failure applies to state failures exactly as to serve failures.
    expect(killed).toEqual([]);
    expect(result.warnings.some((w) => w.includes("kept for debugging"))).toBe(true);
  });

  it("dry-run records the DECLARED recipe as declared-not-run: digests and phases only, no execution fields, honest event wording", async () => {
    const outcome = await runLab(cloneCuaConfig({ state: THREE_PHASE_STATE }), { cwd, dryRun: true });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);

    expect(result.subject?.state).toEqual({
      provenance: "declared-not-run",
      seed: [
        { name: "prebuild", when: "before-build", commandDigest: sha16("node scripts/prebuild-fixtures.js") },
        { name: "db-up", when: "before-start", commandDigest: sha16("sudo service postgresql start && pg_isready -t 30") },
        { name: "admin-user", when: "after-ready", commandDigest: sha16("curl -sf -X POST http://127.0.0.1:3000/api/test/bootstrap-admin") }
      ]
    });

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.subject.state.provenance).toBe("declared-not-run");
    expect(bundle.subject.state.seed.every((record: Record<string, unknown>) => !("ok" in record))).toBe(true);
    const provenance = bundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(provenance?.message).toContain("state: declared, not run (dry-run contract)");

    // The contract bundle verifies — declared-not-run is the honest dry-run marker.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(true);
  });

  it("declared external state records UNPINNED provenance (seed digests still attached when both are declared)", async () => {
    const config = cloneCuaConfig({
      env: ["DATABASE_URL"],
      state: { seed: [{ name: "db-migrate", command: "run migrations" }], external: ["DATABASE_URL"] }
    });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", DATABASE_URL: "postgres-external-value" },
        loadDesktopModule: async () => module,
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);

    // Migrating an external DB is still unpinned overall: marker unpinned, digests attached.
    expect(result.subject?.state.provenance).toBe("unpinned");
    expect(result.subject?.state.externalEnvNames).toEqual(["DATABASE_URL"]);
    expect(result.subject?.state.seed?.[0]).toMatchObject({ name: "db-migrate", ok: true });

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const provenance = bundle.events.find((event: { type: string }) => event.type === "cua-lab.subject.provenance");
    expect(provenance?.message).toContain("state: UNPINNED (external: DATABASE_URL)");
    for (const file of ["run.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain("postgres-external-value");
    }
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "subject state provenance")?.ok).toBe(true);
  });

  it("app-url bundles carry the uniform subject block: source app-url, state undeclared", async () => {
    const outcome = await runLab(cuaConfig(), { cwd, dryRun: true });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.subject).toEqual({ source: "app-url", state: { provenance: "undeclared" } });
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")
    );
    expect(bundle.subject).toEqual({ source: "app-url", state: { provenance: "undeclared" } });
  });

  it("re-enforces the state declaration at the engine for configs that bypass the parser", async () => {
    const base = cloneCuaConfig();
    const tamper = (state: unknown): LabConfig =>
      ({ ...base, subject: { ...base.subject, state } }) as LabConfig;

    // Bad step name (interpolates into in-sandbox paths — must fail closed).
    const badName = await runCuaActorLab({ cwd, config: tamper({ seed: [{ name: "Bad Name!", command: "true" }] }), dryRun: true });
    expect(badName.ok).toBe(false);
    expect(badName.error?.code).toBe("HUMANISH_CUA_LAB_SUBJECT_INVALID");
    expect(badName.runId).toBe("not-created");

    // Duplicate step names.
    const dupe = await runCuaActorLab({
      cwd,
      config: tamper({ seed: [{ name: "a", command: "true" }, { name: "a", command: "false" }] }),
      dryRun: true
    });
    expect(dupe.error?.code).toBe("HUMANISH_CUA_LAB_SUBJECT_INVALID");

    // external must name a provisioned channel (subset of subject.env).
    const unbacked = await runCuaActorLab({ cwd, config: tamper({ external: ["REDIS_URL"] }), dryRun: true });
    expect(unbacked.error?.code).toBe("HUMANISH_CUA_LAB_SUBJECT_INVALID");

    // state on an app-url subject is rejected, never silently inert (invariant 6).
    const appUrlBase = cuaConfig();
    const appUrlTampered = {
      ...appUrlBase,
      subject: { ...appUrlBase.subject, state: { seed: [{ name: "a", command: "true" }] } }
    } as LabConfig;
    const onAppUrl = await runCuaActorLab({ cwd, config: appUrlTampered, dryRun: true });
    expect(onAppUrl.ok).toBe(false);
    expect(onAppUrl.error?.code).toBe("HUMANISH_CUA_LAB_SUBJECT_INVALID");
    expect(onAppUrl.error?.message).toContain("clone subjects");
  });
});

describe("buildCuaBundle", () => {
describe("local-tree route (subject.source: local-tree, computer-use)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-local-tree-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function localTreeCuaConfig(extra?: {
    env?: string[];
    state?: unknown;
    count?: number;
    caps?: { maxUsd?: number };
    localTree?: { keep?: boolean; exclude?: string[]; maxArchiveBytes?: number };
  }): LabConfig {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-local-tree-proof",
      title: "CUA local-tree proof",
      subject: {
        source: "local-tree",
        serve: {
          install: "pnpm install --frozen-lockfile",
          build: "pnpm build",
          start: "pnpm start",
          url: "http://127.0.0.1:3000/"
        },
        ...(extra?.env ? { env: extra.env } : {}),
        ...(extra?.state === undefined ? {} : { state: extra.state }),
        ...(extra?.localTree === undefined ? {} : { localTree: extra.localTree })
      },
      actors: [{
        type: "openai-computer-use",
        persona: "first-time-visitor",
        mission: "Explore the app and stop.",
        ...(extra?.count === undefined ? {} : { count: extra.count })
      }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, ...(extra?.caps ? { caps: extra.caps } : {}) },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  // 64-hex archiveSha256 and a 40-hex commit: shape-valid fixtures, not real digests.
  const FIXED_ARCHIVE: LocalTreeArchive = {
    archivePath: "/unused-in-fake/source.tar.gz",
    archiveSha256: "ab".repeat(32),
    fileCount: 3,
    totalBytes: 42,
    git: { commit: "cd".repeat(20), dirty: true }
  };
  const FAKE_ARCHIVE_BYTES = new TextEncoder().encode("fake-packed-archive-bytes").buffer;

  it("dry-run yields the contract bundle with subject.source local-tree and NO archiveSha256", async () => {
    const config = localTreeCuaConfig();
    const outcome = await runLab(config, { cwd, dryRun: true });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.sandbox).toBeUndefined();
    expect(result.subject).toEqual({ source: "local-tree", envNames: [], state: { provenance: "undeclared" } });

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.subject).toEqual({ source: "local-tree", envNames: [], state: { provenance: "undeclared" } });
    expect("archiveSha256" in bundle.subject).toBe(false);

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("live (single lane): onPhase (injected capture sink) emits the upload/extract phase boundaries, then install/build/ready (#263)", async () => {
    const config = localTreeCuaConfig();
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);
    const phaseEvents: Array<{ type: string; ok?: boolean; durationMs?: number }> = [];

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        onPhase: (event) => {
          phaseEvents.push(event);
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    const types = phaseEvents.map((event) => event.type);
    expect(types).toEqual([
      "cua-lab.subject.upload.started",
      "cua-lab.subject.upload.completed",
      "cua-lab.subject.extract.started",
      "cua-lab.subject.extract.completed",
      "cua-lab.subject.runtime.started",
      "cua-lab.subject.runtime.completed",
      "cua-lab.subject.install.started",
      "cua-lab.subject.install.completed",
      "cua-lab.subject.build.started",
      "cua-lab.subject.build.completed",
      "cua-lab.subject.serve.started",
      "cua-lab.subject.ready.started",
      "cua-lab.subject.ready.completed"
    ]);
    // The local-tree route never runs git: no clone phase on this route, ever.
    expect(types.some((type) => type.includes(".clone."))).toBe(false);
  });

  it("live fan-out (2 lanes): packs the working tree ONCE, uploads it per lane, extracts via tar, and carries archive provenance on every lane + the aggregate", async () => {
    const config = localTreeCuaConfig({ count: 2 });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created, killed } = makeFakeModule(sandbox);
    const packCalls: Array<{ root: string; extraExclude?: string[]; maxArchiveBytes?: number }> = [];

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        packLocalTree: async (args) => {
          packCalls.push(args);
          return { archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES };
        },
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.ok).toBe(true);
    expect(created.length).toBe(2);

    // Packed exactly ONCE for the whole 2-lane fan-out, rooted at the lab resolution cwd.
    expect(packCalls).toHaveLength(1);
    expect(packCalls[0]?.root).toBe(await realpath(cwd));

    // Every lane uploaded the SAME archive bytes to the SAME remote path, octet-stream.
    const uploads = sandbox.calls.filter(
      (call): call is [string, string, ArrayBuffer, { useOctetStream?: boolean } | undefined] =>
        call[0] === "files.write" && call[1] === "/home/user/.humanish-source.tar.gz"
    );
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload[2]).toBeInstanceOf(ArrayBuffer);
      expect(upload[2]).toBe(FAKE_ARCHIVE_BYTES);
      expect(upload[3]?.useOctetStream).toBe(true);
    }

    // The extract step ran one command: rm -rf/mkdir -p SUBJECT_DIR, tar -xzf, then rm -f the
    // uploaded archive.
    const extractScript = sandbox.calls.find(
      (call): call is [string, string, string] => call[0] === "files.write" && String(call[1]).endsWith("subject-extract/run.sh")
    );
    expect(extractScript?.[2]).toContain("rm -rf /home/user/subject");
    expect(extractScript?.[2]).toContain("mkdir -p /home/user/subject");
    expect(extractScript?.[2]).toContain("tar -xzf /home/user/.humanish-source.tar.gz -C /home/user/subject");
    expect(extractScript?.[2]).toContain("rm -f /home/user/.humanish-source.tar.gz");

    // Provenance: aggregate + every lane carry archiveSha256/commit/dirty from the hook result.
    const expectedSubject = {
      source: "local-tree",
      archiveSha256: FIXED_ARCHIVE.archiveSha256,
      commit: FIXED_ARCHIVE.git!.commit,
      dirty: true,
      envNames: [],
      state: { provenance: "undeclared" }
    };
    expect(result.subject).toEqual(expectedSubject);
    expect(result.lanes).toHaveLength(2);
    for (const lane of result.lanes ?? []) {
      expect(lane.subject).toEqual(expectedSubject);
    }

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.subject).toEqual(expectedSubject);

    expect(killed.length).toBeGreaterThan(0);
  });

  it("live fan-out (2 lanes) with maxUsd: warns that maxUsd is a PER-LANE cap and cites the ~N × cap ceiling", async () => {
    const config = localTreeCuaConfig({ count: 2, caps: { maxUsd: 3 } });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } })
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    const capWarning = result.warnings.find((w) => w.includes("PER-LANE cap"));
    expect(capWarning).toBeDefined();
    // 2 lanes × $3 → the true ~$6 ceiling is surfaced, not the per-lane $3 — and the warning
    // points at the shared study budget (#299) as the fix, since it exists now.
    expect(capWarning).toContain("2 × $3");
    expect(capWarning).toContain("~$6");
    expect(capWarning).toContain("maxTotalUsd");
  });

  it("live fan-out (2 lanes): onPhase captures BOTH lanes under their OWN lane id with the TOTAL laneCount, and the persisted bundle attributes each lane's phase events to that lane's OWN simId/streamId (#263)", async () => {
    const config = localTreeCuaConfig({ count: 2 });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module } = makeFakeModule(sandbox);
    const phaseCalls: Array<{ event: { type: string; ok?: boolean }; ctx: { laneId: string; laneCount: number } }> = [];

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
        runSession: async (options) =>
          runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } }),
        onPhase: (event, ctx) => {
          phaseCalls.push({ event, ctx });
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);

    // (c) laneCount > 1: the default-sink prefix logic (defaultSubjectPhaseSink) reads
    // ctx.laneCount to decide whether to prefix lines with the lane id. Every captured ctx here
    // carries the TOTAL fan-out width (2), never a per-lane count.
    expect(phaseCalls.length).toBeGreaterThan(0);
    expect(phaseCalls.every(({ ctx }) => ctx.laneCount === 2)).toBe(true);

    // (a) BOTH lanes reported phase events under their OWN distinct lane id, and each lane's own
    // boundary sequence is the full upload/extract/install/build/ready chain (no lane silently
    // skipped, no cross-lane mixing within a single lane's sequence).
    const laneIds = [...new Set(phaseCalls.map(({ ctx }) => ctx.laneId))].sort();
    expect(laneIds).toEqual(["lane-01", "lane-02"]);
    const expectedTypes = [
      "cua-lab.subject.upload.started",
      "cua-lab.subject.upload.completed",
      "cua-lab.subject.extract.started",
      "cua-lab.subject.extract.completed",
      "cua-lab.subject.runtime.started",
      "cua-lab.subject.runtime.completed",
      "cua-lab.subject.install.started",
      "cua-lab.subject.install.completed",
      "cua-lab.subject.build.started",
      "cua-lab.subject.build.completed",
      "cua-lab.subject.serve.started",
      "cua-lab.subject.ready.started",
      "cua-lab.subject.ready.completed"
    ];
    for (const laneId of laneIds) {
      const types = phaseCalls.filter(({ ctx }) => ctx.laneId === laneId).map(({ event }) => event.type);
      expect(types).toEqual(expectedTypes);
    }

    // (b) the persisted fan-out bundle attributes each lane's COMPLETED phase events to that
    // lane's OWN simId/streamId (lane-01 -> sim-001/stream-001, lane-02 -> sim-002/stream-002):
    // no cross-lane leakage into the wrong lane's stream.
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const persistedPhaseEvents = (bundle.events as Array<{ id: string; type: string; simId?: string; streamId?: string }>).filter(
      (event) => event.type.startsWith("cua-lab.subject.") && event.type.endsWith(".completed")
    );
    expect(persistedPhaseEvents.length).toBeGreaterThan(0);
    for (const event of persistedPhaseEvents) {
      if (event.id.includes("lane-01")) {
        expect(event.simId).toBe("sim-001");
        expect(event.streamId).toBe("stream-001");
      } else if (event.id.includes("lane-02")) {
        expect(event.simId).toBe("sim-002");
        expect(event.streamId).toBe("stream-002");
      } else {
        throw new Error(`unexpected phase event id shape: ${event.id}`);
      }
    }
    // Both lanes actually persisted (neither lane's phase trail silently swallowed).
    expect(persistedPhaseEvents.some((event) => event.simId === "sim-001")).toBe(true);
    expect(persistedPhaseEvents.some((event) => event.simId === "sim-002")).toBe(true);

    const verified = await verifyRun(cwd, outcome.result.runId);
    expect(verified.ok).toBe(true);
  });

  it("extract failure, throwing CommandExitError shape: fails the lane with a scrubbed tail", async () => {
    const config = localTreeCuaConfig();
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler(),
      commandThrow: (command) =>
        command.includes("setsid -f") && command.includes("subject-extract/run.sh")
          ? { exitCode: 2, message: "tar: unexpected end of archive (extract failed)" }
          : undefined
    });
    const { module, created } = makeFakeModule(sandbox);

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
        runSession: async () => {
          throw new Error("runSession must not be reached: extract should fail first");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");

    expect(outcome.result.ok).toBe(false);
    // The sandbox WAS created (provisioning is in-sandbox); only packing skips sandbox creation.
    expect(created.length).toBe(1);
    const message = outcome.result.lanes?.[0]?.error?.message ?? outcome.result.error?.message ?? "";
    expect(message).toContain("tar: unexpected end of archive");
  });

  it("extract failure, structural fake returning a nonzero exitCode (not throwing): fails the lane with a scrubbed tail", async () => {
    const config = localTreeCuaConfig();
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-extract/status")) return { stdout: "2" };
        if (command.includes("subject-extract/log.txt")) return { stdout: "tar: unexpected end of archive (exit 2)" };
        return undefined;
      })
    });
    const { module } = makeFakeModule(sandbox);

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
        runSession: async () => {
          throw new Error("runSession must not be reached: extract should fail first");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");

    expect(outcome.result.ok).toBe(false);
    const message = outcome.result.lanes?.[0]?.error?.message ?? outcome.result.error?.message ?? "";
    expect(message).toContain("subject extract");
    expect(message).toContain("tar: unexpected end of archive");
  });

  it("failing extract: onPhase emits a completed event with ok false before the lane fails (#263)", async () => {
    const config = localTreeCuaConfig();
    const sandbox = makeFakeSandbox({
      commandHandler: cloneCommandHandler((command) => {
        if (command.includes("subject-extract/status")) return { stdout: "2" };
        if (command.includes("subject-extract/log.txt")) return { stdout: "tar: unexpected end of archive (exit 2)" };
        return undefined;
      })
    });
    const { module } = makeFakeModule(sandbox);
    const phaseEvents: Array<{ type: string; ok?: boolean; durationMs?: number }> = [];

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
        onPhase: (event) => {
          phaseEvents.push(event);
        },
        runSession: async () => {
          throw new Error("runSession must not be reached: extract should fail first");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(false);

    // Upload succeeded (started+completed ok:true); the failing extract still gets its
    // completed event, with ok false and a real durationMs, BEFORE the thrown error unwinds.
    // install/build/ready never ran.
    expect(phaseEvents.map((event) => event.type)).toEqual([
      "cua-lab.subject.upload.started",
      "cua-lab.subject.upload.completed",
      "cua-lab.subject.extract.started",
      "cua-lab.subject.extract.completed"
    ]);
    const extractCompleted = phaseEvents[3];
    expect(extractCompleted?.ok).toBe(false);
    expect(typeof extractCompleted?.durationMs).toBe("number");
    expect(extractCompleted?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("packing failure (hook throws) fails the run closed BEFORE any sandbox is created", async () => {
    const config = localTreeCuaConfig();
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, created } = makeFakeModule(sandbox);

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        packLocalTree: async () => {
          // A realistic createLocalTreeArchive-shaped failure: names counts, includes an
          // absolute path the redaction pipeline must scrub before it reaches the result.
          // Built from joined fragments (never a literal /Users/... path in source) so this
          // fixture itself never trips the repo's own public-surface path scan.
          const fakeAbsoluteRoot = ["", "Users", "fake-operator", "project"].join("/");
          throw new Error(
            `Local tree root "${fakeAbsoluteRoot}" produced zero packable entries after the always-on denylist; local-tree packing requires at least one non-denylisted file or symlink.`
          );
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("HUMANISH_CUA_LAB_SUBJECT_INVALID");
    expect(outcome.result.error?.message).toContain("zero packable entries");
    expect(outcome.result.error?.message).not.toContain(["", "Users", "fake-operator"].join("/"));
    expect(created).toHaveLength(0);
  });

  it("subject.localTree.keep: true preserves the sandbox on a failed lane (mirrors subject.clone.keep)", async () => {
    const config = localTreeCuaConfig({ localTree: { keep: true } });
    const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
    const { module, killed } = makeFakeModule(sandbox);

    const outcome = await runLab(config, {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        packLocalTree: async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES }),
        runSession: async () => {
          throw new Error("boom during session");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");

    expect(outcome.result.ok).toBe(false);
    // Failure + keep -> NOT killed, with a debug warning naming the flag that caused it.
    expect(killed).toEqual([]);
    expect(outcome.result.sandbox?.killed).toBe(false);
    expect(outcome.result.warnings.some((w) => w.includes("kept for debugging"))).toBe(true);
    expect(outcome.result.warnings.some((w) => w.includes("subject.localTree.keep"))).toBe(true);
  });
});

  it("dry-run bundle shape: contract verdict, no actor seam, public cwd", () => {
    const bundle = buildCuaBundle({
      actorId: "openai-computer-use",
      appUrl: "http://127.0.0.1:3000/",
      createdAt: "2026-01-01T00:00:00.000Z",
      dryRun: true,
      labId: "shape-proof",
      mission: "Explore.",
      persona: { id: "p1", traitsApplied: [], promptDigest: "digest" },
      resolution: [1440, 960],
      runId: "cua-test-run",
      screenshots: [],
      source: {
        packageName: "humanish",
        humanishSource: "present",
        git: { schema: "humanish.git-state.v1", capturedAt: "2026-01-01T00:00:00.000Z", present: false, refState: "unknown", note: "test" } as never
      }
    });
    expect(bundle.streams[0]?.actor).toBeUndefined();
    expect(bundle.streams[0]?.embed?.kind).toBe("placeholder");
    expect(bundle.review.verdict).toBe("contract_proof_only");
    expect(bundle.review.gaps.length).toBeGreaterThan(0);
    expect(bundle.cwd).toBe("[target-cwd]");
    expect(bundle.simCount).toBe(1);
    expect(bundle.simulations[0]?.progress).toBe(100);
    // Honest no-session notes: zero frames exist, so no redaction (blur OR raw) is claimed.
    expect(bundle.redaction.notes).toContain("No screenshots captured");
    expect(bundle.redaction.notes).not.toContain("blurred fail-closed");
    // Stream artifact references are unique and relative (verifyRun's evidence rules).
    const keys = bundle.streams[0]?.artifacts.map((artifact) => `${artifact.kind}:${artifact.path}`) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
    for (const artifact of bundle.streams[0]?.artifacts ?? []) {
      expect(path.isAbsolute(artifact.path)).toBe(false);
    }
  });

  it("keeps sensitive public target URLs out of persisted bundle text while preserving lane metadata", () => {
    const rawUrl = "https://3000-example-sandbox.e2b.app/bootstrap/session";
    const bundle = buildCuaBundle({
      actorId: "openai-computer-use",
      actorType: "reviewer",
      surface: "inbox",
      caseGroup: "message-flow",
      appUrl: rawUrl,
      createdAt: "2026-01-01T00:00:00.000Z",
      dryRun: true,
      labId: "shape-proof",
      mission: "Explore.",
      persona: { id: "p1", traitsApplied: [], promptDigest: "digest" },
      resolution: [414, 896],
      runId: "cua-test-run",
      screenshots: [],
      source: {
        packageName: "humanish",
        humanishSource: "present",
        git: { schema: "humanish.git-state.v1", capturedAt: "2026-01-01T00:00:00.000Z", present: false, refState: "unknown", note: "test" } as never
      }
    });

    const text = JSON.stringify(bundle);
    expect(text).not.toContain(rawUrl);
    expect(text).not.toContain("e2b.app");
    expect(containsSensitive(text)).toBe(false);
    expect(bundle.streams[0]?.ui?.route).toMatch(/^\[target-url:[a-f0-9]{16}\]$/);
    expect(bundle.streams[0]).toMatchObject({
      actorType: "reviewer",
      surface: "inbox",
      caseGroup: "message-flow"
    });
  });

  it("labels mid-failure frames by capture policy when the session died before a trace existed", () => {
    // A session can throw after frames were already written: no trace exists to testify, so
    // the labels fall back to the capture-time policy the lab actually ran with.
    const base = {
      actorId: "openai-computer-use",
      appUrl: "http://127.0.0.1:3000/",
      createdAt: "2026-01-01T00:00:00.000Z",
      dryRun: false,
      labId: "shape-proof",
      mission: "Explore.",
      persona: { id: "p1", traitsApplied: [], promptDigest: "digest" },
      resolution: [1440, 960] as [number, number],
      runId: "cua-test-run",
      screenshots: ["screenshots/turn-001.png"],
      sessionError: "provider exploded mid-loop",
      source: {
        packageName: "humanish",
        humanishSource: "present" as const,
        git: { schema: "humanish.git-state.v1", capturedAt: "2026-01-01T00:00:00.000Z", present: false, refState: "unknown", note: "test" } as never
      }
    };

    const blurred = buildCuaBundle({ ...base, captureRedaction: "blurred" });
    expect(blurred.simulations[0]?.progress).toBe(100);
    expect(blurred.streams[0]?.embed?.title).toBe("CUA desktop (blurred)");
    expect(blurred.streams[0]?.artifacts.some((a) => a.label === "screenshot 01 (blurred)")).toBe(true);
    expect(blurred.redaction.notes).toContain("capture policy (blurred)");

    const raw = buildCuaBundle({ ...base, captureRedaction: "raw" });
    expect(raw.streams[0]?.embed?.title).toBe("CUA desktop (raw)");
    expect(raw.streams[0]?.artifacts.some((a) => a.label === "screenshot 01 (raw)")).toBe(true);
    expect(raw.redaction.notes).toContain("capture policy (raw)");
    expect(JSON.stringify(raw)).not.toContain("(redacted)");
  });
});

// ---------------------------------------------------------------------------
// Issue #148: the in-process (state-driven, no-E2B) lab route. RUNG 4 (load-bearing) and RUNG 5.
// ---------------------------------------------------------------------------

const STATE_CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: false,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open"
};

// A fake state executor: drives an in-memory app (route advances each action), returns NO
// screenshot and a distinct appState per turn so the REAL loop's friction keys off app state.
function makeStateExecutor(): CuaExecutor & { actuated: CuaAction[] } {
  const actuated: CuaAction[] = [];
  let turn = 0;
  return {
    actuated,
    async observe(): Promise<CuaObservation> {
      turn += 1;
      return { stateSignature: "frozen-sig", appState: { route: `/step-${turn}`, turn } };
    },
    async execute(action: CuaAction): Promise<void> {
      actuated.push(action);
    }
  };
}

// A fake state "brain": reasons over appState, takes one real action, then stops (so the run
// bumps counts.actions and passes the noEngagement honesty guard), with NO requiresFrame.
function makeStateProvider(): CuaProvider {
  let i = 0;
  return {
    id: "fake-state-brain",
    version: "0.1.0",
    requiresFrame: false,
    capabilities: STATE_CAPS,
    async nextTurn(): Promise<CuaTurn> {
      i += 1;
      return i >= 2
        ? { actions: [], pendingSafetyChecks: [], done: true, message: "Reached the goal via getState()." }
        : { actions: [{ kind: "type", text: "hello" }], pendingSafetyChecks: [], done: false, reasoning: "state looks right" };
    }
  };
}

function localAppConfig(appUrl = "http://localhost:5173/"): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "downstream-local-app-state",
    title: "State-driven local app",
    subject: { source: "local-app", appUrl },
    actors: [{ type: "openai-computer-use", persona: "pixel-pat", mission: "Drive the app via its state contract." }],
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("runCuaActorLab in-process (state-driven, no E2B) — issue #148", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-inproc-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // RUNG 4 (load-bearing): live mode, custom executor + provider drive the REAL loop, a
  // loadDesktopModule whose Sandbox.create pushes to created[]. Assert created.length === 0,
  // result.sandbox === undefined, AND the produced bundle PASSES verifyRun (the hollow-pass net).
  it("drives the REAL loop with NO E2B sandbox created, omits result.sandbox, and the bundle passes verifyRun", async () => {
    const sandbox = makeFakeSandbox();
    const { module, created, killed } = makeFakeModule(sandbox);
    const stateExecutor = makeStateExecutor();

    const outcome = await runLab(localAppConfig(), {
      cwd,
      cuaHooks: {
        // If anything on this route touched E2B, created[] would grow — this is the proof probe.
        loadDesktopModule: async () => module,
        buildExecutor: async () => stateExecutor,
        buildProvider: async () => makeStateProvider()
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    // The verifiable "no E2B SDK call" proof: no sandbox was ever created or killed.
    expect(created).toHaveLength(0);
    expect(killed).toHaveLength(0);
    expect(result.sandbox).toBeUndefined();
    expect("streamUrl" in result).toBe(false);

    // The REAL loop ran: the state executor was actuated by the brain's action.
    expect(stateExecutor.actuated).toContainEqual({ kind: "type", text: "hello" });

    // The lab reached a terminal verdict and the bundle verified.
    expect(result.dryRun).toBe(false);
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(true);
    expect(result.observer?.ok).toBe(true);

    // The trace's provider id is the INJECTED brain's id (no new lane needed); zero screenshots.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams[0].actor.provider).toBe("fake-state-brain");
    expect(bundle.streams[0].actor.lane).toBe("computer-use");
    expect(bundle.streams[0].actor.redaction.screenshots).toBe("n/a");
    expect(bundle.streams[0].actor.counts.screenshots).toBe(0);
    expect(bundle.streams[0].actor.redaction.notes).toContain("App state was observed");
    // No screenshots dir contents on disk.
    const shotFiles = await readdir(path.join(runDir, "screenshots")).catch(() => [] as string[]);
    expect(shotFiles).toHaveLength(0);

    // Honest UNPINNED provenance (invariant 5): the bundle DECLARES the un-pinnable local app.
    const subjectEvent = bundle.events.find((e: { type: string }) => e.type === "cua-lab.subject.declared");
    expect(subjectEvent.message).toContain("UNPINNED");
    expect(subjectEvent.message).toContain("NO E2B");
    expect(bundle.subject).toEqual({ source: "app-url", state: { provenance: "undeclared" } });

    // appState never persists anywhere in the bundle (runtime-only).
    const bundleText = await readFile(path.join(runDir, "run.json"), "utf8");
    expect(bundleText).not.toContain("/step-1");
    expect(bundleText).not.toContain('"appState"');

    // The hollow-pass net: the independent verifier passes the REAL (action-bearing) bundle.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
    expect(verified.checks.find((check) => check.name === "actor engagement")?.ok).toBe(true);
  });

  it("a hollow in-process run (zero actions/messages) still FAILS the honesty guard + verifyRun", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runLab(localAppConfig(), {
      cwd,
      cuaHooks: {
        loadDesktopModule: async () => module,
        buildExecutor: async () => makeStateExecutor(),
        // A brain that immediately reports done with no action and no message → hollow.
        buildProvider: async (): Promise<CuaProvider> => ({
          id: "hollow-brain",
          capabilities: STATE_CAPS,
          async nextTurn(): Promise<CuaTurn> {
            return { actions: [], pendingSafetyChecks: [], done: true };
          }
        })
      }
    });
    expect(created).toHaveLength(0);
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    expect(result.session?.completionReason).toBe("goal_satisfied");
    expect(result.ok).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("no actions");
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
  });

  it("a gave_up in-process run is an ABANDONED lane — a participant outcome, still not an engaged pass", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runLab(localAppConfig(), {
      cwd,
      cuaHooks: {
        loadDesktopModule: async () => module,
        buildExecutor: async () => makeStateExecutor(),
        buildProvider: async (): Promise<CuaProvider> => ({
          id: "idle-brain",
          capabilities: STATE_CAPS,
          async nextTurn(): Promise<CuaTurn> {
            return { actions: [{ kind: "wait", ms: 1 }], pendingSafetyChecks: [], done: false, message: "Still waiting." };
          }
        })
      }
    });
    expect(created).toHaveLength(0);
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;
    // The participant stopped trying. That is a finding about the product, not the harness
    // malfunctioning — but it is still not a pass, and the lane must not be counted as one.
    expect(result.session?.status).toBe("abandoned");
    expect(result.session?.completionReason).toBe("gave_up");
    expect(result.ok).toBe(false);
    const lanes = result.lanes ?? [];
    const laneSummary = result.laneSummary;
    if (!laneSummary) throw new Error("expected lane summary");
    expect(lanes[0]?.status).toBe("abandoned");
    expect(lanes[0]?.ok).toBe(false);
    expect(laneSummary.passed).toBe(0);
    // The error names what actually happened to the participant, not a generic failure.
    expect(result.error?.message).toContain("abandoned");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("gave up");
  });

  // RUNG 5: the two boot-time fail-closed guards, both BEFORE any key check / any E2B touch.
  it("buildExecutor WITHOUT buildProvider → EXECUTOR_NO_PROVIDER (before any key check)", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runCuaActorLab({
      cwd,
      config: localAppConfig(),
      dryRun: false,
      hooks: {
        env: {}, // NO keys — proves the guard precedes key-gating
        loadDesktopModule: async () => module,
        buildExecutor: async () => makeStateExecutor()
        // buildProvider deliberately omitted
      }
    });
    expect(created).toHaveLength(0);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER");
    expect(outcome.sandbox).toBeUndefined();
  });

  it("local-app subject with NO hooks → LOCAL_APP_NO_EXECUTOR (a structured error, never a desktop attempt, before key-gating)", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const outcome = await runCuaActorLab({
      cwd,
      config: localAppConfig(),
      dryRun: false,
      hooks: {
        env: {}, // NO keys — the local-app guard must win over KEYS_MISSING
        loadDesktopModule: async () => module
        // no buildExecutor / buildProvider
      }
    });
    expect(created).toHaveLength(0);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("HUMANISH_CUA_LAB_LOCAL_APP_NO_EXECUTOR");
    expect(outcome.error?.message).toContain("buildExecutor");
    expect(outcome.sandbox).toBeUndefined();
  });

  it("buildProvider ALONE (a model swap) does NOT take the in-process route — it still provisions E2B", async () => {
    // buildProvider without buildExecutor is allowed and stays on the normal E2B route; with no
    // keys/dry-run we just confirm it does NOT trip EXECUTOR_NO_PROVIDER and is NOT treated as
    // in-process (a dry-run produces a contract bundle with no sandbox, the normal route).
    const outcome = await runLab(cuaConfig(), {
      cwd,
      dryRun: true,
      cuaHooks: { buildProvider: async () => makeStateProvider() }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.error?.code).not.toBe("HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER");
  });
});

// Observe-time CDP port re-resolution: the probe re-reads DevToolsActivePort at observe time (the
// resolution itself is contract-tested under the real python3 in tests/chrome-cdp-probe.test.ts);
// this pins that the shipped in-sandbox command carries the seam.
describe("chromium browser-state observer command (observe-time CDP port re-resolution)", () => {
  it("the chromium browser-state observer embeds the re-read seam (profile dir + marker path) in its in-sandbox script", async () => {
    const commands: string[] = [];
    const desktop = {
      commands: {
        run: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, stdout: "{}" };
        }
      }
    } as unknown as E2BDesktopSandbox;
    const observe = makeChromeBrowserStateObserver(desktop, 5_000, { profileDir: "/tmp/humanish-profile-x", targetUrl: "http://127.0.0.1:3000/" });
    // The fake endpoint answers with an empty page set, so the observer degrades to {}.
    expect(await observe()).toEqual({});
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("DevToolsActivePort");
    expect(commands[0]).toContain("/tmp/humanish-profile-x");
  });
});

// Budget vs. timed_out semantics through the lab, and live-serve-during-run wiring. Every session
// is driven by the REAL loop against an injected clock + state executor/provider (no vision, no
// screenshots, $0). The fake sandbox provisions a stream URL before the session runs, so the live
// Observer picks it up even when the session ends timed_out/failed.
describe("runCuaActorLab budget/timeout semantics + live serve", () => {
  let cwd: string;
  const openServers: ObserverServer[] = [];

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-budget-"));
  });
  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((server) => server.close()));
    await rm(cwd, { recursive: true, force: true });
  });

  // A state executor (no screenshot) reading a shared clock so the loop's deadline is deterministic.
  function clockExecutor(clock: { t: number }): CuaExecutor {
    let turn = 0;
    return {
      async observe(): Promise<CuaObservation> {
        turn += 1;
        return { stateSignature: `sig-${turn}`, appState: { turn, t: clock.t } };
      },
      async execute(): Promise<void> {}
    };
  }

  // Reaches budget: takes one MATERIAL action, then the clock jumps past the deadline.
  function budgetProvider(clock: { t: number }): CuaProvider {
    return {
      id: "budget-brain",
      version: "0.1.0",
      requiresFrame: false,
      capabilities: STATE_CAPS,
      async nextTurn(): Promise<CuaTurn> {
        clock.t = 1000;
        return { actions: [{ kind: "type", text: "hello" }], pendingSafetyChecks: [], done: false };
      }
    };
  }

  // Zero material progress: only an idle wait, then the clock jumps past the deadline → timed_out.
  function idleTimeoutProvider(clock: { t: number }): CuaProvider {
    return {
      id: "idle-brain",
      version: "0.1.0",
      requiresFrame: false,
      capabilities: STATE_CAPS,
      async nextTurn(): Promise<CuaTurn> {
        clock.t = 1000;
        return { actions: [{ kind: "wait", ms: 1 }], pendingSafetyChecks: [], done: false };
      }
    };
  }

  it("classifies a productive budget stop as INCOMPLETE — no pass claimed, and the evidence still verifies", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => {
          const clock = { t: 0 };
          return runCuaActorSession({
            ...options,
            provider: budgetProvider(clock),
            executor: clockExecutor(clock),
            now: () => clock.t,
            timeoutMs: 100
          });
        }
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;
    // The session ran out before reaching its goal. It did real work on the way — that is what
    // separates it from a zero-progress timeout — but "productive" is not "finished", and calling it
    // a pass is how a truncated study came to be reported green.
    expect(result.session?.completionReason).toBe("budget_reached");
    expect(result.session?.status).toBe("incomplete");
    expect(result.ok).toBe(false);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.review.verdict).not.toBe("pass");
    expect(bundle.streams[0].actor.completionReason).toBe("budget_reached");
    // The verdict collapses the run to one word; the participant tally does not. A reader can see
    // that nobody reached the goal AND that the denominator was one (three-roles.md).
    expect(bundle.review.participants).toMatchObject({ total: 1, reachedGoal: 0, ranOut: 1, harnessFailed: 0 });

    // The distinction that matters: the STUDY is incomplete, but the EVIDENCE is sound. The harness
    // did exactly what it said it did, so verify still passes — an unfinished study is a finding
    // about the session, not a reason to distrust the bundle.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("keeps a zero-progress timeout an honest FAILURE (timed_out → result.ok false)", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    const outcome = await runLab(cuaConfig(), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => {
          const clock = { t: 0 };
          return runCuaActorSession({
            ...options,
            provider: idleTimeoutProvider(clock),
            executor: clockExecutor(clock),
            now: () => clock.t,
            timeoutMs: 100
          });
        }
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;
    expect(result.session?.completionReason).toBe("timed_out");
    expect(result.session?.status).toBe("timed_out");
    expect(result.ok).toBe(false);
  });

  it("flushes liveActor items into the in-progress bundle mid-run, and the final write replaces them (#441)", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    type MidRunBundle = { streams: Array<{ status: string; liveActor?: { schema: string; items: Array<{ kind: string; at?: string }> } }> };
    let midRunBundle: MidRunBundle | undefined;

    // Two material turns then done. Turn 2's nextTurn polls the persisted run.json for the
    // flush of turn 1's items — the flush is fire-and-forget, so a bounded poll (real fs,
    // fake substrate, $0) is the honest way to observe it without a test-only seam.
    const runJsonPath = (): string => path.join(cwd, ".humanish", "runs", "run-flush", "run.json");
    function flushProvider(clock: { t: number }): CuaProvider {
      let turn = 0;
      return {
        id: "flush-brain",
        version: "0.1.0",
        requiresFrame: false,
        capabilities: STATE_CAPS,
        async nextTurn(): Promise<CuaTurn> {
          clock.t += 10;
          turn += 1;
          if (turn === 2) {
            for (let attempt = 0; attempt < 100 && midRunBundle === undefined; attempt += 1) {
              try {
                const parsed = JSON.parse(await readFile(runJsonPath(), "utf8")) as MidRunBundle;
                const flushed = parsed.streams.some((stream) =>
                  stream.liveActor?.items.some((item) => item.kind === "ui_action") === true
                );
                if (flushed) midRunBundle = parsed;
              } catch {
                // Bundle mid-write or not yet flushed; keep polling.
              }
              if (midRunBundle === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          if (turn >= 3) return { actions: [], pendingSafetyChecks: [], done: true, message: "Done." };
          return { actions: [{ kind: "type", text: `t${turn}` }], pendingSafetyChecks: [], done: false };
        }
      };
    }

    const outcome = await runLab(cuaConfig(), {
      cwd,
      runId: "run-flush",
      onObserverReady: async () => {},
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => {
          const clock = { t: 0 };
          return runCuaActorSession({
            ...options,
            provider: flushProvider(clock),
            executor: clockExecutor(clock),
            now: () => clock.t,
            timeoutMs: 10_000
          });
        }
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;

    // Mid-run: the persisted in-progress bundle carried the partial — schema'd, stamped items,
    // on a stream still honestly marked running (no completion claims anywhere).
    expect(midRunBundle).toBeTruthy();
    const liveStream = midRunBundle?.streams.find((stream) => stream.liveActor !== undefined);
    expect(liveStream?.status).toBe("running");
    const live = liveStream?.liveActor;
    expect(live?.schema).toBe("humanish.live-actor.v1");
    expect(live?.items.some((item) => item.kind === "ui_action")).toBe(true);
    expect(live?.items.every((item) => typeof item.at === "string")).toBe(true);

    // Final: the real actor replaces the partial; liveActor never survives completion.
    const finalBundle = JSON.parse(await readFile(runJsonPath(), "utf8")) as {
      streams: Array<{ status: string; actor?: { items: unknown[] }; liveActor?: unknown }>;
    };
    expect(finalBundle.streams.every((stream) => stream.status !== "running")).toBe(true);
    expect(finalBundle.streams.every((stream) => stream.liveActor === undefined)).toBe(true);
    expect(finalBundle.streams.some((stream) => (stream.actor?.items.length ?? 0) > 0)).toBe(true);
  });

  it("fires onObserverReady for a single lane and serves the LIVE in-progress bundle (incl. the stream URL) even after a timed_out run", async () => {
    const sandbox = makeFakeSandbox();
    const { module } = makeFakeModule(sandbox);
    let readyObserver: (ObserverResult & { ok: true }) | undefined;
    let server: ObserverServer | undefined;

    const outcome = await runLab(cuaConfig(), {
      cwd,
      onObserverReady: async (observer) => {
        // Invoked BEFORE the actor loop, for laneCount === 1, with an ok in-progress bundle.
        readyObserver = observer;
        expect(observer.ok).toBe(true);
        server = await serveObserver(observer, { port: 0 });
        openServers.push(server);
      },
      cuaHooks: {
        env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2" },
        loadDesktopModule: async () => module,
        runSession: async (options) => {
          const clock = { t: 0 };
          return runCuaActorSession({
            ...options,
            provider: idleTimeoutProvider(clock),
            executor: clockExecutor(clock),
            now: () => clock.t,
            timeoutMs: 100
          });
        }
      }
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    // Serve-on-failure: the run ended timed_out (not ok) but the attached server still came up.
    expect(result.ok).toBe(false);
    expect(readyObserver).toBeTruthy();
    expect(server).toBeTruthy();

    const served = await fetch(new URL("observer-data.json", server!.url));
    expect(served.status).toBe(200);
    const observerData = await served.json() as {
      streams: Array<{ transport?: string; url?: string; embed?: { kind: string } }>;
    };
    // #357: the run is OVER (the lane tore down and fired onRuntimeStreamEnded), so the server no
    // longer injects the now-dead stream URL — the tile falls back to recorded evidence and the
    // stream says why (liveEnded). Serving the URL here was exactly the "board full of 'sandbox
    // not found'" failure the field run hit.
    expect(observerData.streams[0]?.transport).not.toBe("sse");
    expect(observerData.streams[0]?.url).toBeUndefined();
    expect((observerData.streams[0] as { liveEnded?: boolean } | undefined)?.liveEnded).toBe(true);
    // The runtime URL is NEVER persisted to disk in any state.
    const persisted = await readFile(path.join(cwd, ".humanish", "runs", result.runId, "observer", "observer-data.json"), "utf8");
    expect(persisted).not.toContain("fake-auth-key");
    expect(persisted).not.toContain("stream.invalid");
  });
});

describe("runCuaActorLab cost estimates", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-cost-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  // A stepped clock: runCuaLane reads it exactly twice — right after create() and right after
  // teardown — so delta == one step == the deterministic billed span.
  function steppedClock(stepMs: number): () => number {
    let t = 0;
    return () => (t += stepMs);
  }
  // A scripted OpenAI Responses session that reports token usage, so a real estimate is produced.
  const usageSession = (input: number, output: number): unknown[] => [
    { id: "resp_1", output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }], usage: { input_tokens: input, output_tokens: output } },
    { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }], usage: { input_tokens: 0, output_tokens: 0 } }
  ];
  function configWithModel(model?: string, caps?: { maxUsd?: number }): LabConfig {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "cua-cost-proof",
      title: "CUA cost proof",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", persona: "first-time-visitor", mission: "Explore the app and stop.", ...(model ? { model } : {}) }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { resolution: [1280, 800] }, ...(caps ? { caps } : {}) },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }
  const readBundle = async (runId: string): Promise<any> =>
    JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8"));

  it("attaches a labeled per-lane + run-level estimated cost with provenance and deterministic desktop-minutes; verify passes", async () => {
    const { module, killed } = makeFakeModule(makeFakeSandbox());
    const result = await runCuaActorLab({
      cwd,
      config: configWithModel(), // default resolves to gpt-5.6-sol (#334: the 5.6-generation flagship)
      dryRun: false,
      hooks: {
        env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k" },
        loadDesktopModule: async () => module,
        now: steppedClock(60_000), // create → 60000ms, teardown → 120000ms → 1 billed minute
        runSession: async (o) => runCuaActorSession({ ...o, openai: { ...o.openai, apiKey: "k", fetchFn: scriptedFetch(usageSession(2_000_000, 4_000)) } })
      }
    });
    expect(result.ok).toBe(true);
    expect(killed).toEqual(["fake-sandbox-001"]);

    const bundle = await readBundle(result.runId);
    // Per-actor estimate on the persisted trace: labeled with provenance; gpt-5.6-sol is a
    // confirmed (non-placeholder) rate. The single 2M-input request crosses the 272K
    // long-context threshold, so the WHOLE request re-tiers (2x input-side, 1.5x output) —
    // exact because the trace now records per-request turns (#334).
    const est = bundle.streams[0].actor.estimatedCost;
    expect(est.schema).toBe("humanish.actor-estimated-cost.v1");
    // gpt-5.6-sol long tier (promo sheet 2026-09-03): 2_000_000*4e-6*2 + 4_000*20e-6*1.5
    // = 16 + 0.12 = 16.12.
    expect(est.estimatedCostUsd).toBeCloseTo(16.12, 6);
    expect(est.ratesAsOf).toBe("2026-09-03");
    expect(est.source).toContain("developers.openai.com/api/docs/pricing");
    expect(est.placeholder).toBeUndefined();
    expect(est.modelId).toBe("gpt-5.6-sol");
    expect(est.breakdown.longContextTurns).toBe(1);
    // The trace records the per-request usage ledger the tiering priced from.
    expect(bundle.streams[0].actor.tokenUsage.turns).toHaveLength(2);

    const cost = bundle.cost;
    expect(cost.schema).toBe("humanish.run-cost-summary.v1");
    expect(cost.currency).toBe("usd");
    expect(cost.desktopMinutes).toBe(1);
    expect(cost.tokenUsage).toEqual({ input: 2_000_000, output: 4_000, total: 2_004_000 });
    const modelLine = cost.breakdown.find((l: any) => l.kind === "model-tokens");
    const desktopLine = cost.breakdown.find((l: any) => l.kind === "desktop-minutes");
    expect(modelLine.estimatedCostUsd).toBeCloseTo(16.12, 6);
    expect(modelLine.ratesAsOf).toBe("2026-09-03");
    expect(modelLine.source).toContain("developers.openai.com/api/docs/pricing");
    expect(desktopLine.estimatedCostUsd).toBeCloseTo(0.00888, 6);
    expect(desktopLine.desktop).toMatchObject({ resources: { cpuCount: 8, memoryMiB: 8192 }, resourceSource: "e2b.getInfo" });
    expect(cost.estimatedTotalUsd).toBeCloseTo(16.12888, 6);
    expect(cost.placeholder).toBe(false);
    expect(cost.fullyEstimated).toBe(true);
    expect(cost.ratesAsOf).toBe("2026-09-03");

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.checks.find((c) => c.name === "cost estimate labeling")?.ok).toBe(true);
    expect(verify.ok).toBe(true);
  });

  it.each(["absent", "rejected"] as const)("keeps metadata %s unpriced while the actual lane still reclaims its handle", async mode => {
    const sandbox = makeFakeSandbox();
    if (mode === "absent") delete sandbox.getInfo;
    else sandbox.getInfo = async () => { throw new Error("synthetic metadata failure"); };
    const { module, killed } = makeFakeModule(sandbox);
    const result = await runCuaActorLab({ cwd, config: configWithModel(), dryRun: false, hooks: {
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k" }, loadDesktopModule: async () => module,
      now: steppedClock(60_000),
      runSession: async o => runCuaActorSession({ ...o, openai: { ...o.openai, apiKey: "k", fetchFn: scriptedFetch(usageSession(1000, 200)) } })
    } });
    expect(result.ok).toBe(true);
    expect(killed).toEqual(["fake-sandbox-001"]);
    const bundle = await readBundle(result.runId);
    expect(bundle.cost.fullyEstimated).toBe(false);
    expect(bundle.cost.breakdown.find((line: any) => line.kind === "desktop-minutes")).toMatchObject({ estimatedCostUsd: null, reason: "no_desktop_resources" });
  });

  it("aggregate ratesAsOf is the OLDEST contributing asOf, never the newest — an aggregate is only as fresh as its stalest input", () => {
    const costTrace = (estimatedCostUsd: number, ratesAsOf: string, input: number, output: number): ActorTrace => ({
      schema: ACTOR_TRACE_SCHEMA,
      provider: "openai-responses-cu",
      protocol: "cua-loop",
      lane: "computer-use",
      persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "d" },
      redaction: { status: "passed", screenshots: "n/a", notes: "" },
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
      durationMs: 1000,
      status: "passed",
      completionReason: "goal_satisfied",
      reason: "done",
      ids: {},
      counts: {},
      items: [],
      tokenUsage: { input, output, total: input + output },
      estimatedCost: {
        schema: "humanish.actor-estimated-cost.v1",
        estimatedCostUsd,
        ratesAsOf,
        source: "openai.com/api/pricing",
        modelId: "computer-use-preview"
      },
      capabilities: STATE_CAPS
    });

    // Two priced model-token lines with DIVERGENT asOf dates (an operator edited one rate later).
    const cost = buildCuaCostSummary({
      lanes: [
        { laneId: "lane-01", trace: costTrace(1, "2026-08-01", 1000, 100) },
        { laneId: "lane-02", trace: costTrace(2, "2026-01-15", 2000, 200) }
      ],
      desktopMinutes: undefined
    });

    expect(cost).toBeDefined();
    // The aggregate reports the OLDER date (MIN), never the newer one (MAX would overclaim freshness).
    expect(cost!.ratesAsOf).toBe("2026-01-15");
    expect(cost!.note).toContain("2026-01-15");
    expect(cost!.note).toContain("OLDEST");
    // Per-line breakdown keeps each line's OWN true asOf — only the aggregate is conservative.
    const asOfById = new Map(cost!.breakdown.map((l) => [l.laneId, l.ratesAsOf]));
    expect(asOfById.get("lane-01")).toBe("2026-08-01");
    expect(asOfById.get("lane-02")).toBe("2026-01-15");
    expect(cost!.estimatedTotalUsd).toBeCloseTo(3, 6);
  });

  it("DECLARES ABSENT (null + reason) for an unpriced model and sums ONLY the known lines into the total", async () => {
    const { module } = makeFakeModule(makeFakeSandbox());
    const result = await runCuaActorLab({
      cwd,
      config: configWithModel("gpt-4o-unpriced-xyz"),
      dryRun: false,
      hooks: {
        env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k" },
        loadDesktopModule: async () => module,
        now: steppedClock(60_000),
        runSession: async (o) => runCuaActorSession({ ...o, openai: { ...o.openai, apiKey: "k", fetchFn: scriptedFetch(usageSession(1000, 200)) } })
      }
    });

    const bundle = await readBundle(result.runId);
    const est = bundle.streams[0].actor.estimatedCost;
    expect(est.estimatedCostUsd).toBeNull();
    expect(est.reason).toBe("no_rate_for_model");
    expect(est.ratesAsOf).toBeNull();

    const cost = bundle.cost;
    const modelLine = cost.breakdown.find((l: any) => l.kind === "model-tokens");
    const desktopLine = cost.breakdown.find((l: any) => l.kind === "desktop-minutes");
    expect(modelLine.estimatedCostUsd).toBeNull();
    expect(modelLine.reason).toBe("no_rate_for_model");
    // The total is the desktop line ALONE — the null model line is never coerced to 0.
    expect(cost.estimatedTotalUsd).toBeCloseTo(desktopLine.estimatedCostUsd, 6);
    expect(cost.fullyEstimated).toBe(false);
    // token usage is still summed even though the model could not be priced.
    expect(cost.tokenUsage).toEqual({ input: 1000, output: 200, total: 1200 });

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.checks.find((c) => c.name === "cost estimate labeling")?.ok).toBe(true);
  });

  it("DRY-RUN invents no spend: the bundle carries no cost block", async () => {
    const result = await runCuaActorLab({ cwd, config: configWithModel(), dryRun: true, runId: "cost-dry-run" });
    expect(result.ok).toBe(true);
    const bundle = await readBundle("cost-dry-run");
    expect(bundle.cost).toBeUndefined();
  });

  it("refuses a maxUsd cap on a model src/pricing.ts cannot price, BEFORE creating any sandbox", async () => {
    const { module, created } = makeFakeModule(makeFakeSandbox());
    const result = await runCuaActorLab({
      cwd,
      config: configWithModel("gpt-4o-unpriced-xyz", { maxUsd: 5 }),
      dryRun: false,
      hooks: {
        env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k" },
        loadDesktopModule: async () => module,
        runSession: async () => { throw new Error("a session must never run under an unenforceable cap"); }
      }
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CUA_LAB_UNPRICED_CAP");
    expect(created).toHaveLength(0);
  });

  it("accepts a maxUsd cap on a PRICED model and runs — a priced cap is wired, never a refusal", async () => {
    const { module } = makeFakeModule(makeFakeSandbox());
    const result = await runCuaActorLab({
      cwd,
      config: configWithModel("computer-use-preview", { maxUsd: 50 }),
      dryRun: false,
      hooks: {
        env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k" },
        loadDesktopModule: async () => module,
        now: steppedClock(60_000),
        runSession: async (o) => runCuaActorSession({ ...o, openai: { ...o.openai, apiKey: "k", fetchFn: scriptedFetch(usageSession(1000, 200)) } })
      }
    });
    expect(result.error?.code).not.toBe("HUMANISH_CUA_LAB_UNPRICED_CAP");
    expect(result.ok).toBe(true);
    const bundle = await readBundle(result.runId);
    // computer-use-preview is a CONFIRMED (non-placeholder) MODEL rate — the per-actor estimate
    // and its model-tokens line carry no placeholder flag.
    expect(bundle.streams[0].actor.estimatedCost.placeholder).toBeUndefined();
    const modelLine = bundle.cost.breakdown.find((l: any) => l.kind === "model-tokens");
    expect(modelLine.placeholder).toBeUndefined();
    // Both the model rate and this allocation's observed resource rate are confirmed.
    expect(bundle.cost.placeholder).toBe(false);
  });
});

describe("adopter-hosted comms on the app-url route (#380)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-cua-external-cwd-"));
  });
  afterEach(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  it("tells each persona its inbox, drains the adopter catch once, and writes digest-only evidence", async () => {
    // The REAL python catch as a subprocess — the same bytes an adopter runs via `humanish comms
    // catch` — so the health probe, the token guard, and the drain contract are proven against the
    // actual implementation.
    const TOKEN = "test-token-not-a-secret";
    const dir = await mkdtemp(path.join(tmpdir(), "humanish-cua-external-"));
    const scriptPath = path.join(dir, "catch.py");
    const surface = path.join(dir, "surface");
    await mkdir(surface, { recursive: true });
    await writeFile(scriptPath, SANDBOX_CATCH_SCRIPT, "utf8");
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn("python3", [scriptPath, String(port), path.join(dir, "deliveries.ndjson"), surface, "0", TOKEN], { stdio: "ignore" });
    try {
      let healthy = false;
      for (let i = 0; i < 100 && !healthy; i += 1) {
        healthy = await externalCatchHealthy({ catchBaseUrl: baseUrl }, { timeoutMs: 1000 });
        if (!healthy) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(healthy).toBe(true);

      // The app's send, captured by the adopter's catch, addressed to lane-01's FILLED
      // deterministic address (recipients omitted in the lab on purpose — the parser fills one
      // per lane, and this proves the filled address is what the funnel matches).
      const posted = await fetch(`${baseUrl}/emails`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: "no-reply@example.test",
          to: ["lane-01@example.test"],
          subject: "Confirm your email",
          html: "<a href=\"https://app.example.test/verify?token=xyz789\">Verify</a>"
        })
      });
      expect(posted.ok).toBe(true);

      const parsed = parseLabConfig({
        schema: LAB_CONFIG_SCHEMA,
        id: "cua-external-comms",
        title: "CUA adopter-hosted comms",
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
        comms: { email: { external: { catchBaseUrl: baseUrl, authTokenEnv: "CATCH_TOKEN" } } },
        actors: [{ type: "openai-computer-use", mission: "Sign up using the email address in your instructions.", count: 2 }],
        execution: { target: "e2b-desktop", desktop: { resolution: [1280, 800] } },
        scenario: { mode: "live" }
      });
      if (!parsed.ok) throw new Error(parsed.error.message);

      const sandbox = makeFakeSandbox({ commandHandler: cloneCommandHandler() });
      const { module } = makeFakeModule(sandbox);
      const seenInstructions: string[] = [];
      const outcome = await runLab(parsed.config, {
        cwd,
        cuaHooks: {
          env: { OPENAI_API_KEY: "k1", E2B_API_KEY: "k2", CATCH_TOKEN: TOKEN },
          loadDesktopModule: async () => module,
          runSession: async (options) => {
            seenInstructions.push(options.instructions);
            return runCuaActorSession({ ...options, openai: { apiKey: "k1", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
          }
        }
      });
      if (outcome.backend !== "cua") throw new Error("expected cua backend");
      const result = outcome.result;

      // Every persona was told ITS OWN filled address and the adopter's inbox URL (#380: this
      // route previously ignored the whole block).
      expect(seenInstructions).toHaveLength(2);
      expect(seenInstructions.some((text) => text.includes(`${baseUrl}/inbox`) && text.includes("lane-01@example.test"))).toBe(true);
      expect(seenInstructions.some((text) => text.includes(`${baseUrl}/inbox`) && text.includes("lane-02@example.test"))).toBe(true);

      // The drain ran once at run level, matched the captured send, and wrote the digest-only
      // artifact — no raw address, subject, or link may appear in it.
      const threadPath = path.join(cwd, ".humanish", "runs", result.runId, "comms", "thread.json");
      const thread = await readFile(threadPath, "utf8");
      expect(thread).toContain("humanish.comms-thread.v1");
      expect(thread).not.toContain("lane-01@example.test");
      expect(thread).not.toContain("Confirm your email");
      expect(thread).not.toContain("xyz789");
      expect(result.warnings.some((w) => w.includes("captured ZERO email sends"))).toBe(false);
    } finally {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
