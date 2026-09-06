import { PNG } from "pngjs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorCompletionReason, type ActorStatus, type ActorTrace } from "../src/actor-contract.js";
import type { CuaActorSessionOptions } from "../src/computer-use-actor.js";
import type { CuaLoopResult } from "../src/computer-use.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox
} from "../src/e2b-desktop-launch.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig, type LabDesktopBrowser } from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import {
  buildSeatBrowserTerminationCommand,
  runSharedWorldLab,
  seatProfilePkillPattern,
  type SharedWorldLabHooks
} from "../src/shared-world-lab.js";
import type { BrowserLabScoringContext, RunAdapterScore, RunBundle, SubjectPhaseEvent } from "../src/index.js";
import { verifyRun } from "../src/run.js";
import { createOpenAiResponsesProvider, DEFAULT_OPENAI_CU_REASONING_EFFORT } from "../src/openai-responses-cu.js";
import type { LocalTreeArchive } from "../src/source-archive.js";

// ---------------------------------------------------------------------------
// Fakes. The desktop module records create/kill BY id and exposes NO `list`
// method — so enumerate-and-kill is impossible by construction (the 2026-06-16
// prod-incident rail). The command handler drives the detached primitive
// (provisioning + checkpoints) and returns STATEFUL checkpoint output: a shared
// `worldVersion` is bumped by each runSession (a turn mutates state), so the
// checkpoint digest changes across snapshots and deltaFromPrev becomes true.
// ---------------------------------------------------------------------------

interface FakeSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
}

const FAKE_SCREEN_GEOMETRY = { width: 1440, height: 950 } as const;
const FAKE_BROWSER_WINDOW = { x: 0, y: 0, width: 1440, height: 950 } as const;
// Browser chrome consumes vertical space: this must stay distinct from the X display and outer
// window so the sequential shared-world contract cannot regress to copying requested resolution.
const FAKE_CSS_VIEWPORT = { width: 1440, height: 817, deviceScaleFactor: 1 } as const;

function makeFakeSandbox(commandHandler: (command: string) => { stdout?: string; exitCode?: number } | undefined): FakeSandbox {
  const calls: Array<[string, ...unknown[]]> = [];
  const sandbox = {
    calls,
    sandboxId: "fake-shared-world-sandbox-001",
    commands: {
      run: async (command: string) => {
        calls.push(["commands.run", command]);
        return commandHandler(command) ?? { exitCode: 0, stdout: "" };
      }
    },
    files: {
      // Raw data (never String()-coerced): existing callers write string script content
      // (String(data) === data for those, unchanged), and the local-tree upload path writes a
      // real ArrayBuffer that tests need to inspect directly (byteLength, reference equality).
      write: async (filePath: string, data: string | ArrayBuffer) => {
        calls.push(["files.write", filePath, data]);
        return undefined;
      }
    },
    launch: async () => undefined,
    open: async () => undefined,
    async screenshot() {
      return new Uint8Array([1, 2, 3, 4]);
    },
    async wait(ms: number) {
      calls.push(["wait", ms]);
    },
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async () => undefined
    }
  };
  return sandbox as unknown as FakeSandbox;
}

function makeFakeModule(sandbox: FakeSandbox): { module: E2BDesktopModule; created: E2BDesktopCreateOptions[]; templates: (string | undefined)[]; killed: string[] } {
  const created: E2BDesktopCreateOptions[] = [];
  // Parallel to `created`: the custom template each create() got (undefined == byte-stable default).
  const templates: (string | undefined)[] = [];
  const killed: string[] = [];
  const module: E2BDesktopModule = {
    Sandbox: {
      // Mirror the real @e2b/desktop overload: create(opts) OR create(template, opts).
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
      // NOTE: NO `list` method — enumerate-and-kill is impossible here by construction.
    }
  };
  return { module, created, templates, killed };
}

/** A scripted command handler whose checkpoint output reflects the shared world version. */
function makeCommandHandler(
  state: { worldVersion: number },
  options: { cdpGeometry?: "measured" | "unavailable" } = {}
): (command: string) => { stdout?: string; exitCode?: number } | undefined {
  return (command: string): { stdout?: string; exitCode?: number } | undefined => {
    if (command.includes("xdpyinfo") && command.includes("dimensions")) {
      return { stdout: `  dimensions:    ${FAKE_SCREEN_GEOMETRY.width}x${FAKE_SCREEN_GEOMETRY.height} pixels (381x251 millimeters)\n`, exitCode: 0 };
    }
    if (command.includes("find_chrome_window()")) return { stdout: "WINDOW_ID=10485761\n", exitCode: 0 };
    if (command.includes("find_firefox_window()")) return { stdout: "WINDOW_ID=20971522\n", exitCode: 0 };
    if (command.includes("xdotool getwindowgeometry --shell")) {
      return {
        stdout: [
          `X=${FAKE_BROWSER_WINDOW.x}`,
          `Y=${FAKE_BROWSER_WINDOW.y}`,
          `WIDTH=${FAKE_BROWSER_WINDOW.width}`,
          `HEIGHT=${FAKE_BROWSER_WINDOW.height}`
        ].join("\n"),
        exitCode: 0
      };
    }
    if (command.includes("browserWindow: { x: window.screenX")) {
      if (options.cdpGeometry === "unavailable") return { stdout: "{}", exitCode: 0 };
      return {
        stdout: JSON.stringify({ browserWindow: FAKE_BROWSER_WINDOW, viewport: FAKE_CSS_VIEWPORT }),
        exitCode: 0
      };
    }
    if (command.includes("browser_preference='firefox'")) return { stdout: "HUMANISH_BROWSER_RESOLVED=firefox\n", exitCode: 0 };
    if (command.includes("browser_preference='chrome'")) return { stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n", exitCode: 0 };
    if (command.includes("browser_preference='chromium'")) return { stdout: "HUMANISH_BROWSER_RESOLVED=chromium\n", exitCode: 0 };
    if (command.includes("browser_preference='default'")) return { stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n", exitCode: 0 };
    if (command.includes("/status")) return { stdout: "0" }; // every detached step exits 0
    if (command.includes("rev-parse")) return { stdout: "abc123def4567890abc1\n" }; // commit SHA
    if (command.includes("curl")) return { stdout: "READY" }; // readiness probe
    if (command.includes("checkpoint-") && command.includes("tail -c")) {
      // The shared-state probe output changes as roles mutate the world → digests diverge.
      return { stdout: `world=${state.worldVersion}\n` };
    }
    if (command.includes("tail -c")) return { stdout: "" }; // other detached logs
    return undefined;
  };
}

function makeTrace(args: {
  persona: { id: string; traitsApplied: string[]; promptDigest: string };
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  actions: number;
  messages: number;
}): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "fake-cua",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: args.persona,
    redaction: { status: "passed", screenshots: "n/a", notes: "fake trace (no frames captured)" },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    status: args.status,
    completionReason: args.completionReason,
    reason: `${args.status} (${args.completionReason})`,
    ids: {},
    counts: { actions: args.actions, messages: args.messages, screenshots: 0 },
    items: [
      ...(args.messages > 0 ? [{ id: "i-msg", kind: "message" as const, lifecycle: "completed" as const, title: "message", text: "did my role's task" }] : []),
      ...(args.actions > 0 ? [{ id: "i-act", kind: "ui_action" as const, lifecycle: "completed" as const, title: "click" }] : [])
    ],
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: false,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "proprietary"
    }
  };
}

/** A runSession fake that bumps the world version (a turn mutates state) and returns a passed,
 *  engaged trace — unless a per-call override (harness error / mission failure / throw) applies. */
function makeRunSession(
  state: { worldVersion: number },
  override?: (index: number, options: CuaActorSessionOptions) => { throwMessage?: string; status?: ActorStatus; completionReason?: ActorCompletionReason; actions?: number; messages?: number } | undefined
): (options: CuaActorSessionOptions) => Promise<CuaLoopResult> {
  let index = -1;
  return async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
    index += 1;
    state.worldVersion += 1; // each role's turn mutates the shared world
    const o = override?.(index, options);
    if (o?.throwMessage) {
      throw new Error(o.throwMessage);
    }
    const status = o?.status ?? "passed";
    const completionReason = o?.completionReason ?? "goal_satisfied";
    const trace = makeTrace({
      persona: options.persona,
      status,
      completionReason,
      actions: o?.actions ?? 1,
      messages: o?.messages ?? 1
    });
    return { status, completionReason, reason: trace.reason, trace };
  };
}

function sharedWorldConfig(overrides?: { browser?: LabDesktopBrowser; env?: string[]; template?: string }): LabConfig {
  const desktop = {
    ...(overrides?.browser === undefined ? {} : { browser: overrides.browser }),
    ...(overrides?.template === undefined ? {} : { template: overrides.template })
  };
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "shared-world-proof",
    title: "Shared-world proof",
    subject: {
      source: "clone",
      topology: "shared-world",
      repos: ["example-org/collab-app"],
      env: overrides?.env ?? ["DATABASE_URL"],
      serve: { install: "pnpm install", start: "pnpm start", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [
          { name: "notes-count", command: "psql query notes" },
          { name: "reviews-count", command: "psql query reviews" }
        ]
      }
    },
    actors: [
      {
        type: "openai-computer-use",
        mission: "Use the shared app.",
        lanes: [
          { id: "role-author", persona: "author", entry: "/compose", instruction: "Create a note." },
          { id: "role-reviewer", persona: "reviewer", entry: "/inbox", instruction: "Review the note." }
        ]
      }
    ],
    execution: {
      target: "e2b-desktop",
      timeoutMs: 60_000,
      // Sequential PoC by explicit choice: since #350 an omitted concurrency runs all seats at
      // once (routing to the CONCURRENT substrate); this suite proves the turn-taking route.
      concurrency: 1,
      ...(Object.keys(desktop).length === 0 ? {} : { desktop })
    },
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function baseHooks(state: { worldVersion: number }, options: { cdpGeometry?: "measured" | "unavailable" } = {}): {
  hooks: SharedWorldLabHooks;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
  sandbox: FakeSandbox;
  phaseEvents: SubjectPhaseEvent[];
} {
  const sandbox = makeFakeSandbox(makeCommandHandler(state, options));
  const { module, created, templates, killed } = makeFakeModule(sandbox);
  const phaseEvents: SubjectPhaseEvent[] = [];
  const hooks: SharedWorldLabHooks = {
    env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key", DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" },
    loadDesktopModule: async () => module,
    runSession: makeRunSession(state),
    detachedTimers: { now: () => 0, sleep: async () => {} },
    // Captures instead of writing to real stderr (the call-site default when this is absent);
    // also lets tests assert the ordered phase-boundary sequence.
    onPhase: (event) => { phaseEvents.push(event); }
  };
  return { hooks, created, templates, killed, sandbox, phaseEvents };
}

const SHARED_WORLD_ADAPTER_NAMESPACE = "shared-world-adapter-proof";

function sharedWorldFailScore(ctx: BrowserLabScoringContext): RunAdapterScore {
  return {
    schema: "humanish.adapter-score.v1",
    namespace: SHARED_WORLD_ADAPTER_NAMESPACE,
    status: "fail",
    score: 18,
    summary: `${ctx.backend} adapter found no product-level shared-world success evidence.`,
    data: {
      backend: ctx.backend,
      laneCount: ctx.laneCount
    }
  };
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-shared-world-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("runSharedWorldLab (the heart: real orchestration vs fakes, $0)", () => {
  it("forwards the actor output limit to both sequential role constructors", async () => {
    const config = sharedWorldConfig();
    config.actors[0]!.maxOutputTokens = 16;
    const { hooks, killed, sandbox } = baseHooks({ worldVersion: 0 });
    delete hooks.runSession;
    sandbox.screenshot = async () => PNG.sync.write(new PNG({ ...FAKE_SCREEN_GEOMETRY }));
    const wire = JSON.parse(await readFile(new URL("./fixtures/openai-incomplete/reasoning-only.json", import.meta.url), "utf8"));
    const seen: Array<number | undefined> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
      seen.push(JSON.parse(init.body).max_output_tokens);
      return { ok: true, status: 200, text: async () => JSON.stringify(wire), json: async () => wire };
    });
    await runSharedWorldLab({ cwd, config, dryRun: false, hooks }).finally(() => vi.unstubAllGlobals());
    expect(seen).toEqual([16, 16]);
    expect(killed).toHaveLength(1);
  });

  it("refuses an invalid typed-library limit before the shared desktop is allocated", async () => {
    const config = sharedWorldConfig();
    config.actors[0]!.maxOutputTokens = 0;
    const { hooks, created } = baseHooks({ worldVersion: 0 });
    const result = await runSharedWorldLab({ cwd, config, dryRun: false, hooks });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("maxOutputTokens");
    expect(created).toHaveLength(0);
  });

  it("refuses a custom session before allocating a desktop when an output limit is declared", async () => {
    const config = sharedWorldConfig();
    config.actors[0]!.maxOutputTokens = 16;
    const { hooks, created } = baseHooks({ worldVersion: 0 });
    const result = await runSharedWorldLab({ cwd, config, dryRun: false, hooks });
    expect(result.error?.message).toContain("custom runSession");
    expect(created).toHaveLength(0);
  });
  it("dry-run produces a verified contract bundle with the sharedWorld block + attributionClass + limits, no sandbox", async () => {
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.sandbox).toBeUndefined();
    expect(result.topology).toBe("shared-world");
    expect(result.roleCount).toBe(2);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.attributionClass).toBe("shared-world");
    expect(bundle.sharedWorld.schema).toBe("humanish.shared-world.v1");
    expect(bundle.sharedWorld.attributionLimits).toEqual(
      expect.arrayContaining(["sequential-only", "no-concurrent-races", "delta-attributed-to-turn-not-action"])
    );
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.simulations.map((sim: { progress: number }) => sim.progress)).toEqual([100, 100]);
    for (const stream of bundle.streams) {
      expect(stream.viewport).toBeUndefined();
      expect(stream.desktopGeometry).toEqual({
        screen: { requested: FAKE_SCREEN_GEOMETRY }
      });
    }

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("execution.desktop.template: the ONE shared-plane Sandbox.create gets the template; bundle records it; absent stays byte-stable", async () => {
    // With a custom template configured.
    const withState = { worldVersion: 0 };
    const withTemplate = baseHooks(withState);
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig({ template: "acme-desktop-with-runtimes" }), dryRun: false, hooks: withTemplate.hooks });
    expect(result.ok).toBe(true);
    expect(withTemplate.created).toHaveLength(1);
    expect(withTemplate.templates).toEqual(["acme-desktop-with-runtimes"]);
    const withBundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(withBundle.desktopTemplate).toBe("acme-desktop-with-runtimes");

    // Byte-stable default: NO template → create called with NO template arg, bundle omits the field.
    const noState = { worldVersion: 0 };
    const noTemplate = baseHooks(noState);
    const result2 = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks: noTemplate.hooks });
    expect(result2.ok).toBe(true);
    expect(noTemplate.templates).toEqual([undefined]);
    const noBundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result2.runId, "run.json"), "utf8"));
    expect(noBundle.desktopTemplate).toBeUndefined();
  });

  it("execution.desktop.browser: sequential shared-world seats honor explicit browser preference and record provenance", async () => {
    const state = { worldVersion: 0 };
    const { hooks, sandbox } = baseHooks(state);
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig({ browser: "firefox" }), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    const seatLaunches = sandbox.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call[0] === "commands.run" && String(call[1]).includes("browser_preference="));
    expect(seatLaunches).toHaveLength(2);
    expect(String(seatLaunches[0]!.call[1])).toContain("browser_preference='firefox'");
    expect(String(seatLaunches[0]!.call[1])).toContain("launch_firefox");
    expect(String(seatLaunches[0]!.call[1])).not.toContain("setsid -f google-chrome");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.desktopBrowser).toEqual({ requested: "firefox", resolved: "firefox" });
    expect(sandbox.calls.some((call) => call[0] === "commands.run" && String(call[1]).includes("find_firefox_window()"))).toBe(true);
    expect(sandbox.calls.some((call) => call[0] === "commands.run" && String(call[1]).includes("find_chrome_window()"))).toBe(false);
    expect(sandbox.calls.some((call) => call[0] === "commands.run" && String(call[1]).includes("browserWindow: { x: window.screenX"))).toBe(false);
    for (const stream of bundle.streams) {
      expect(stream.desktopGeometry.browserWindow).toEqual({ ...FAKE_BROWSER_WINDOW, source: "xdotool" });
      expect(stream.desktopGeometry.viewport).toBeUndefined();
      expect(stream.viewport).toBeUndefined();
      expect(stream.desktopGeometry.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("unavailable for Firefox")
      ]));
    }

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });

  it("records requested + verified screen, browser outer bounds, and the measured CSS viewport as distinct geometry", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    for (const stream of bundle.streams) {
      expect(stream.desktopGeometry).toEqual({
        screen: {
          requested: FAKE_SCREEN_GEOMETRY,
          verified: { ...FAKE_SCREEN_GEOMETRY, source: "xdpyinfo" }
        },
        browserWindow: { ...FAKE_BROWSER_WINDOW, source: "cdp" },
        viewport: { ...FAKE_CSS_VIEWPORT, source: "cdp" }
      });
      expect(stream.viewport).toEqual({
        ...FAKE_CSS_VIEWPORT,
        isMobile: false
      });
      expect(stream.viewport).not.toEqual(expect.objectContaining(FAKE_SCREEN_GEOMETRY));
    }

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });

  it("omits stream.viewport when live CSS viewport measurement is unavailable instead of copying the requested screen", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, { cdpGeometry: "unavailable" });
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("stream.viewport is omitted instead of copying the requested screen resolution")
    ]));
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    for (const stream of bundle.streams) {
      expect(stream.viewport).toBeUndefined();
      expect(stream.desktopGeometry).toEqual({
        screen: {
          requested: FAKE_SCREEN_GEOMETRY,
          verified: { ...FAKE_SCREEN_GEOMETRY, source: "xdpyinfo" }
        },
        browserWindow: { ...FAKE_BROWSER_WINDOW, source: "xdotool" },
        warnings: [expect.stringContaining("stream.viewport is omitted")]
      });
    }

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });

  it("GOOD run: ONE sandbox by-id, plane provisioned ONCE, sequential distinct profiles, interaction proof, verify ok", async () => {
    const state = { worldVersion: 0 };
    const { hooks, created, killed, sandbox } = baseHooks(state);
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // ONE sandbox created + torn down BY its exact id (killed-set == {createdId}).
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata?.topology).toBe("shared-world");
    expect(created[0]?.metadata?.roleCount).toBe("2");
    expect(killed).toEqual([sandbox.sandboxId]);
    expect(result.sandbox).toEqual({ sandboxId: sandbox.sandboxId, killed: true });

    // The ACTOR key never entered the sandbox; the SUBJECT env was provisioned by name.
    expect(created[0]?.envs).toEqual({ DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" });

    // provisionCloneSubject ran EXACTLY once (one plane, not N): one `git clone` script written.
    const cloneWrites = sandbox.calls.filter(([name, , data]) => name === "files.write" && String(data).includes("git clone"));
    expect(cloneWrites).toHaveLength(1);

    // Seats are sequential with DISTINCT --user-data-dir per role, in declared order.
    const seatLaunches = sandbox.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call[0] === "commands.run" && String(call[1]).includes("--user-data-dir="));
    expect(seatLaunches).toHaveLength(2);
    expect(String(seatLaunches[0]!.call[1])).toContain("profile_dir='/tmp/seat-role-author'");
    expect(String(seatLaunches[1]!.call[1])).toContain("profile_dir='/tmp/seat-role-reviewer'");
    expect(seatLaunches[0]!.index).toBeLessThan(seatLaunches[1]!.index); // author's seat before reviewer's
    const firstSeatCommand = String(seatLaunches[0]!.call[1]);
    expect(firstSeatCommand).toContain("--disable-component-update");
    expect(firstSeatCommand).toContain("--disable-extensions");
    expect(firstSeatCommand).toContain("--password-store=basic");
    expect(firstSeatCommand).toContain("credentials_enable_service");
    expect(firstSeatCommand).toContain("\"password_manager_enabled\":false");

    // A checkpoint at baseline + after each turn → timeline = cp, turn, cp, turn, cp.
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.simulations.map((sim: { progress: number }) => sim.progress)).toEqual([100, 100]);
    const timeline = bundle.sharedWorld.timeline as Array<{ kind: string; name?: string; deltaFromPrev?: boolean; roleId?: string }>;
    expect(timeline.map((e) => e.kind)).toEqual(["checkpoint", "turn", "checkpoint", "turn", "checkpoint"]);
    expect(timeline[0]!.name).toBe("cp-baseline");
    expect(bundle.sharedWorld.sequence).toEqual(["role-author", "role-reviewer"]);
    expect(bundle.sharedWorld.roleCount).toBe(2);
    expect(bundle.desktopBrowser).toBeUndefined();

    // THE INTERACTION PROOF: the checkpoint after role-author carries deltaFromPrev == true AND
    // appears strictly BEFORE role-reviewer's turn in the one harness clock.
    const cpAfterAuthorIndex = timeline.findIndex((e) => e.kind === "checkpoint" && e.name === "cp-after-role-author");
    const reviewerTurnIndex = timeline.findIndex((e) => e.kind === "turn" && e.roleId === "role-reviewer");
    expect(cpAfterAuthorIndex).toBeGreaterThanOrEqual(0);
    expect(timeline[cpAfterAuthorIndex]!.deltaFromPrev).toBe(true);
    expect(cpAfterAuthorIndex).toBeLessThan(reviewerTurnIndex);

    // Single-plane provenance: every turn shares the one commit + seedDigest.
    const turns = timeline.filter((e) => e.kind === "turn") as Array<{ commit?: string; seedDigest?: string }>;
    expect(new Set(turns.map((t) => `${t.commit}:${t.seedDigest}`)).size).toBe(1);
    expect(bundle.sharedWorld.plane.commit).toBe("abc123def4567890abc1");

    // verifyRun ok on the GOOD bundle.
    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);

    // Per-role actor traces written.
    const actorsDir = await readdir(path.join(cwd, ".humanish", "runs", result.runId, "actors"));
    expect(actorsDir.sort()).toEqual(["stream-001.json", "stream-002.json"]);
  });

  it("ends each seat's browser at turn end: kill by recorded PID + pkill on the seat profile; prior seat gone before the next launch, final seat too", async () => {
    const state = { worldVersion: 0 };
    const base = makeCommandHandler(state);
    // The default chrome seat launch also reports its PID (the real launch script records it).
    const sandbox = makeFakeSandbox((command) => {
      if (command.includes("browser_preference='default'")) {
        return { stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\nHUMANISH_BROWSER_PID=4242\n", exitCode: 0 };
      }
      return base(command);
    });
    const { module, killed } = makeFakeModule(sandbox);
    const hooks: SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k2", DATABASE_URL: "v" },
      loadDesktopModule: async () => module,
      runSession: makeRunSession(state),
      detachedTimers: { now: () => 0, sleep: async () => {} },
      // No-op: keeps this live-path test off real stderr (baseHooks captures elsewhere).
      onPhase: () => {}
    };
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });
    expect(result.ok).toBe(true);

    const runs = sandbox.calls
      .map((call, index) => ({ name: call[0], command: String(call[1]), index }))
      .filter((entry) => entry.name === "commands.run");
    const launches = runs.filter((entry) => entry.command.includes("--user-data-dir="));
    const terminations = runs.filter((entry) => entry.command.includes("profile_pattern="));
    expect(launches).toHaveLength(2);
    expect(terminations).toHaveLength(2);

    // Each seat's termination kills the RECORDED launch PID first and falls back to pkill on
    // the seat's own unique profile dir (self-match-proof bracketed pattern).
    expect(terminations[0]!.command).toContain("launch_pid='4242'");
    expect(terminations[0]!.command).toContain("profile_pattern='[/]tmp/seat-role-author'");
    expect(terminations[0]!.command).toContain("pkill");
    expect(terminations[1]!.command).toContain("launch_pid='4242'");
    expect(terminations[1]!.command).toContain("profile_pattern='[/]tmp/seat-role-reviewer'");

    // Role-author's browser ends BEFORE role-reviewer's seat launches (ONE shared desktop: no
    // idle prior-seat browser mutating the plane during a later role's turn, no authenticated
    // window one Alt-Tab away), and the FINAL seat's browser is ended too.
    expect(terminations[0]!.index).toBeGreaterThan(launches[0]!.index);
    expect(terminations[0]!.index).toBeLessThan(launches[1]!.index);
    expect(terminations[1]!.index).toBeGreaterThan(launches[1]!.index);

    expect(killed).toEqual([sandbox.sandboxId]);
  });

  it("seatProfilePkillPattern matches the seat browser's cmdline but never the termination command's own text", () => {
    const pattern = seatProfilePkillPattern("/tmp/seat-role-author");
    const regex = new RegExp(pattern);
    // Matches the launched browser's real cmdline (the expanded --user-data-dir path)...
    expect(regex.test("chromium --new-window --user-data-dir=/tmp/seat-role-author http://127.0.0.1:3000/")).toBe(true);
    // ...but never the termination command itself (its text carries only the bracketed
    // pattern), so pkill/pgrep -f can never match the shell running the termination.
    expect(regex.test(buildSeatBrowserTerminationCommand("4242", "/tmp/seat-role-author"))).toBe(false);
  });

  it("onPhase (injected DI seam, #263): the ONE shared-plane provision reports clone started/completed, then ready completed ok true, in order, off real stderr", async () => {
    const state = { worldVersion: 0 };
    const { hooks, phaseEvents } = baseHooks(state);
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(phaseEvents.length).toBeGreaterThan(0);

    const cloneStartedIndex = phaseEvents.findIndex((e) => e.type === "cua-lab.subject.clone.started");
    const cloneCompletedIndex = phaseEvents.findIndex((e) => e.type === "cua-lab.subject.clone.completed");
    const readyCompletedIndex = phaseEvents.findIndex((e) => e.type === "cua-lab.subject.ready.completed");
    expect(cloneStartedIndex).toBeGreaterThanOrEqual(0);
    expect(cloneCompletedIndex).toBeGreaterThan(cloneStartedIndex);
    expect(readyCompletedIndex).toBeGreaterThan(cloneCompletedIndex);

    expect(phaseEvents[cloneCompletedIndex]!.ok).toBe(true);
    expect(phaseEvents[readyCompletedIndex]!.ok).toBe(true);
  });

  it("adapter fail score turns a coherent shared-world run red while keeping shared-world evidence verifiable", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    hooks.score = sharedWorldFailScore;
    hooks.deriveArtifacts = async (ctx) => {
      await mkdir(path.join(ctx.runDir, "adapter"), { recursive: true });
      await writeFile(
        path.join(ctx.runDir, "adapter", "shared-world-readback.json"),
        `${JSON.stringify({
          schema: "example.shared-world-readback.v1",
          status: "review-required",
          backend: ctx.backend,
          laneCount: ctx.laneCount
        }, null, 2)}\n`,
        "utf8"
      );
      return [{
        schema: "humanish.adapter-artifact.v1",
        namespace: SHARED_WORLD_ADAPTER_NAMESPACE,
        label: "Shared-world adapter readback",
        path: "adapter/shared-world-readback.json",
        kind: "state",
        note: "Adapter-owned shared-world state readback."
      }];
    };
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Adapter scorer failed the run");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore?.namespace).toBe(SHARED_WORLD_ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.adapterScore?.data?.backend).toBe("shared-world");
    expect(bundle.adapterArtifacts?.[0]?.path).toBe("adapter/shared-world-readback.json");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("Adapter scorer failed the run"))).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("routes through runLab(sharedWorldHooks) to the shared-world backend", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    const config = sharedWorldConfig();
    expect(selectLabBackend(config)).toBe("shared-world");
    const outcome = await runLab(config, { cwd, dryRun: false, sharedWorldHooks: hooks });
    expect(outcome.backend).toBe("shared-world");
    if (outcome.backend !== "shared-world") return;
    expect(outcome.result.ok).toBe(true);
  });

  it("threads actor-default and lane-level stopWhen guards into sequential shared-world sessions", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    const config = sharedWorldConfig();
    const actorDefault = { any: [{ id: "actor-done", textIncludes: "Saved" }] };
    const laneOverride = { any: [{ id: "reviewer-done", urlIncludes: "/reviewed" }] };
    config.actors[0]!.stopWhen = actorDefault;
    config.actors[0]!.lanes![1]!.stopWhen = laneOverride;

    const seen: Array<CuaActorSessionOptions["stopWhen"]> = [];
    hooks.runSession = makeRunSession(state, (_index, options) => {
      seen.push(options.stopWhen);
      return undefined;
    });

    const result = await runSharedWorldLab({ cwd, config, dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([actorDefault, laneOverride]);
  });

  it.each([
    { actor: "low" as const, lane: "high" as const, declared: ["low", "high"], effective: ["low", "high"] },
    { actor: undefined, lane: "high" as const, declared: [undefined, "high"], effective: [DEFAULT_OPENAI_CU_REASONING_EFFORT, "high"] },
    { actor: undefined, lane: undefined, declared: [undefined, undefined], effective: [DEFAULT_OPENAI_CU_REASONING_EFFORT, DEFAULT_OPENAI_CU_REASONING_EFFORT] }
  ])("forwards sequential role reasoning effort with lane precedence and omission preserved: $declared", async ({ actor, lane, declared, effective }) => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    const config = sharedWorldConfig();
    if (actor !== undefined) config.actors[0]!.reasoningEffort = actor;
    if (lane !== undefined) config.actors[0]!.lanes![1]!.reasoningEffort = lane;
    const seen: Array<string | undefined> = [];
    const settings: Array<string | undefined> = [];
    hooks.runSession = makeRunSession(state, (_index, options) => {
      seen.push(options.openai?.reasoningEffort);
      settings.push(createOpenAiResponsesProvider(options.openai!).modelSettings?.reasoningEffort);
      if (options.openai?.reasoningEffort === undefined) expect(options.openai).not.toHaveProperty("reasoningEffort");
      return undefined;
    });

    const outcome = await runLab(config, { cwd, dryRun: false, sharedWorldHooks: hooks });

    expect(outcome.result.ok).toBe(true);
    expect(seen).toEqual(declared);
    expect(settings).toEqual(effective);
  });

  it("an explicit per-role budget that would push the ONE sandbox past the provider's 60-minute cap fails closed before any create, with the arithmetic", async () => {
    const state = { worldVersion: 0 };
    const sandbox = makeFakeSandbox(makeCommandHandler(state));
    const { module, created } = makeFakeModule(sandbox);
    const config = sharedWorldConfig();
    config.execution = { ...(config.execution ?? {}), timeoutMs: 900_000 }; // 15 min x 2 roles + 30 + 10 = 70 min
    const hooks: SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k2", DATABASE_URL: "v" },
      loadDesktopModule: async () => module,
      runSession: makeRunSession(state, () => undefined),
      detachedTimers: { now: () => 0, sleep: async () => {} },
      onPhase: () => {}
    };
    await expect(runSharedWorldLab({ cwd, config, dryRun: false, hooks })).rejects.toThrow(/over the provider's 60-minute sandbox cap; set execution\.timeoutMs to at most \d+ ms per role/);
    expect(created).toHaveLength(0);
  });

  it("threads actor-default and lane-level dwell windows into sequential shared-world sessions (#510)", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    const config = sharedWorldConfig();
    const actorDefault = { when: { any: [{ id: "in-room", urlIncludes: "/room/" }] }, ms: 30_000, everyMs: 10_000, then: "continue" as const };
    const laneOverride = { ms: 5_000, everyMs: 1_000, then: "stop" as const };
    config.actors[0]!.dwell = actorDefault;
    config.actors[0]!.lanes![1]!.dwell = laneOverride;

    const seen: Array<CuaActorSessionOptions["dwell"]> = [];
    hooks.runSession = makeRunSession(state, (_index, options) => {
      seen.push(options.dwell);
      return undefined;
    });

    const result = await runSharedWorldLab({ cwd, config, dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([actorDefault, laneOverride]);
  });

  it("HARNESS error on role 1 ⇒ remaining roles blocked + pinned reason (fail-fast); fail-fast event recorded", async () => {
    const state = { worldVersion: 0 };
    const sandbox = makeFakeSandbox(makeCommandHandler(state));
    const { module, killed } = makeFakeModule(sandbox);
    const hooks: SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k2", DATABASE_URL: "v" },
      loadDesktopModule: async () => module,
      runSession: makeRunSession(state, (index) => (index === 0 ? { status: "failed", completionReason: "harness_error" } : undefined)),
      detachedTimers: { now: () => 0, sleep: async () => {} },
      // No-op: keeps this live-path test off real stderr (baseHooks captures elsewhere).
      onPhase: () => {}
    };
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.roles[0]?.id).toBe("role-author");
    expect(result.roles[1]?.status).toBe("blocked");
    expect(result.roles[1]?.skippedReason).toContain("fail-fast");
    // Only role-author took a turn (the premise broke); reviewer never ran a session.
    expect(result.sequence).toEqual(["role-author"]);
    // Still ONE sandbox, still killed by id.
    expect(killed).toEqual([sandbox.sandboxId]);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.events.some((e: { type: string }) => e.type === "shared-world.fail-fast")).toBe(true);
  });

  it("MISSION failure (non-harness) is DATA, never trips fail-fast: every role still runs", async () => {
    const state = { worldVersion: 0 };
    const sandbox = makeFakeSandbox(makeCommandHandler(state));
    const { module } = makeFakeModule(sandbox);
    const hooks: SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k2", DATABASE_URL: "v" },
      loadDesktopModule: async () => module,
      runSession: makeRunSession(state, (index) => (index === 0 ? { status: "failed", completionReason: "gave_up" } : undefined)),
      detachedTimers: { now: () => 0, sleep: async () => {} },
      // No-op: keeps this live-path test off real stderr (baseHooks captures elsewhere).
      onPhase: () => {}
    };
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });

    // role-author failed its MISSION but did NOT trip fail-fast: role-reviewer still took its turn.
    expect(result.ok).toBe(false);
    expect(result.roles[0]?.status).toBe("failed");
    expect(result.roles[0]?.ok).toBe(false);
    expect(result.roles[1]?.status).not.toBe("blocked");
    expect(result.sequence).toEqual(["role-author", "role-reviewer"]);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("1/2 role(s)");
    expect(bundle.review.gaps[0]).toContain("failed (gave_up)");
  });

  it("literal-scrubs a provisioned value injected into a forced error before persist", async () => {
    const state = { worldVersion: 0 };
    const sandbox = makeFakeSandbox(makeCommandHandler(state));
    const { module } = makeFakeModule(sandbox);
    const secret = "opaque-pw-7f3a9c2e-do-not-leak"; // an opaque value pattern-redaction would MISS
    const hooks: SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k2", DATABASE_URL: secret },
      loadDesktopModule: async () => module,
      runSession: makeRunSession(state, (index) => (index === 0 ? { throwMessage: `connection failed using ${secret}` } : undefined)),
      detachedTimers: { now: () => 0, sleep: async () => {} },
      // No-op: keeps this live-path test off real stderr (baseHooks captures elsewhere).
      onPhase: () => {}
    };
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });
    expect(result.ok).toBe(false);

    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(cwd, ".humanish", "runs", result.runId, file), "utf8");
      expect(text, file).not.toContain(secret);
    }
  });
});

// The same shared-world composition, but driven from the operator's own packed working tree
// (subject.source: local-tree) instead of a clone - the follow-up to the local-tree keystone that
// wires provisionLocalTreeSubject into the sequential shared-world engine (issue #261 follow-up).
describe("runSharedWorldLab (local-tree route: subject.source: local-tree)", () => {
  // 64-hex archiveSha256 and a 40-hex commit: shape-valid fixtures, not real digests.
  const FIXED_ARCHIVE: LocalTreeArchive = {
    archivePath: "/unused-in-fake/source.tar.gz",
    archiveSha256: "ab".repeat(32),
    fileCount: 3,
    totalBytes: 42,
    git: { commit: "cd".repeat(20), dirty: true }
  };
  const FAKE_ARCHIVE_BYTES = new TextEncoder().encode("fake-packed-archive-bytes").buffer;

  function localTreeSharedWorldConfig(overrides?: { subject?: Record<string, unknown>; execution?: Record<string, unknown> }): LabConfig {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "shared-world-local-tree-proof",
      title: "Shared-world local-tree proof",
      subject: {
        source: "local-tree",
        topology: "shared-world",
        env: ["DATABASE_URL"],
        serve: { install: "pnpm install", start: "pnpm start", url: "http://127.0.0.1:3000/" },
        state: {
          seed: [{ name: "migrate", command: "pnpm db:migrate" }],
          checkpoint: [
            { name: "notes-count", command: "psql query notes" },
            { name: "reviews-count", command: "psql query reviews" }
          ]
        },
        ...(overrides?.subject ?? {})
      },
      actors: [
        {
          type: "openai-computer-use",
          mission: "Use the shared app.",
          lanes: [
            { id: "role-author", persona: "author", entry: "/compose", instruction: "Create a note." },
            { id: "role-reviewer", persona: "reviewer", entry: "/inbox", instruction: "Review the note." }
          ]
        }
      ],
      execution: overrides?.execution ?? { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 1 },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  it("dry-run: subject.source local-tree, no archiveSha256 (nothing packed), verified contract bundle", async () => {
    const result = await runSharedWorldLab({ cwd, config: localTreeSharedWorldConfig(), dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.sandbox).toBeUndefined();
    expect(result.subject).toEqual({ source: "local-tree", envNames: ["DATABASE_URL"], state: { provenance: "declared-not-run", seed: [{ name: "migrate", when: "before-start", commandDigest: expect.any(String) }] } });

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.subject.source).toBe("local-tree");
    expect("archiveSha256" in bundle.subject).toBe(false);
    expect(bundle.attributionClass).toBe("shared-world");

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });

  it("GOOD live run: packs ONCE, uploads to the ONE subject sandbox, extracts, provisions via provisionLocalTreeSubject; bundle provenance carries archiveSha256 + commit + dirty; verify ok", async () => {
    const state = { worldVersion: 0 };
    const { hooks, created, killed, sandbox } = baseHooks(state);
    const packCalls: Array<{ root: string; extraExclude?: string[]; maxArchiveBytes?: number }> = [];
    hooks.packLocalTree = async (args) => {
      packCalls.push(args);
      return { archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES };
    };
    const result = await runSharedWorldLab({ cwd, config: localTreeSharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // Packed exactly ONCE, rooted at the lab resolution cwd - before the ONE sandbox is created.
    expect(packCalls).toHaveLength(1);
    expect(packCalls[0]?.root).toBe(cwd);
    expect(created).toHaveLength(1);
    expect(killed).toEqual([sandbox.sandboxId]);

    // The archive uploaded to the ONE subject sandbox at the known remote path, octet-stream.
    const uploads = sandbox.calls.filter(
      (call): call is [string, string, ArrayBuffer] => call[0] === "files.write" && call[1] === "/home/user/.humanish-source.tar.gz"
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.[2]).toBe(FAKE_ARCHIVE_BYTES);

    // The local-tree route never runs git: no clone script written, ever.
    const cloneWrites = sandbox.calls.filter(([name, , data]) => name === "files.write" && String(data).includes("git clone"));
    expect(cloneWrites).toHaveLength(0);

    // The extract step ran: rm -rf/mkdir -p SUBJECT_DIR, tar -xzf, then rm -f the uploaded archive.
    const extractScript = sandbox.calls.find(
      (call): call is [string, string, string] => call[0] === "files.write" && String(call[1]).endsWith("subject-extract/run.sh")
    );
    expect(extractScript?.[2]).toContain("rm -rf /home/user/subject");
    expect(extractScript?.[2]).toContain("tar -xzf /home/user/.humanish-source.tar.gz -C /home/user/subject");

    // Provenance: source local-tree + archiveSha256 (the pin) + commit/dirty from the host-packed
    // archive (never resolved in-sandbox: no repo/publicRepo for local-tree).
    const expectedSubject = {
      source: "local-tree",
      archiveSha256: FIXED_ARCHIVE.archiveSha256,
      commit: FIXED_ARCHIVE.git!.commit,
      dirty: true,
      envNames: ["DATABASE_URL"],
      state: { provenance: "seeded", seed: [{ name: "migrate", when: "before-start", commandDigest: expect.any(String), ok: true, exitCode: 0, durationMs: expect.any(Number) }] }
    };
    expect(result.subject).toEqual(expectedSubject);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.subject).toEqual(expectedSubject);
    expect(bundle.sharedWorld.plane.commit).toBe(FIXED_ARCHIVE.git!.commit);

    // The interaction proof still holds (single-plane checkpoint delta) on the local-tree route.
    const timeline = bundle.sharedWorld.timeline as Array<{ kind: string; deltaFromPrev?: boolean }>;
    expect(timeline.some((entry) => entry.kind === "checkpoint" && entry.deltaFromPrev === true)).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("fails closed: a live local-tree bundle with archiveSha256 stripped no longer verifies (the pin is load-bearing)", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    hooks.packLocalTree = async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES });
    const result = await runSharedWorldLab({ cwd, config: localTreeSharedWorldConfig(), dryRun: false, hooks });
    expect(result.ok).toBe(true);
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);

    // Strip the content pin from the persisted bundle: a live local-tree subject has no other
    // provenance anchor (a dirty tree cannot be commit-pinned), so verify must fail closed.
    const runPath = path.join(cwd, ".humanish", "runs", result.runId, "run.json");
    const bundle = JSON.parse(await readFile(runPath, "utf8"));
    delete bundle.subject.archiveSha256;
    await writeFile(runPath, JSON.stringify(bundle));
    expect((await verifyRun(cwd, result.runId)).ok).toBe(false);
  });

  it("onPhase: the ONE shared-plane provision reports upload/extract (never clone), then install/build/ready, in order", async () => {
    const state = { worldVersion: 0 };
    const { hooks, phaseEvents } = baseHooks(state);
    hooks.packLocalTree = async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES });
    const result = await runSharedWorldLab({ cwd, config: localTreeSharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
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
      "cua-lab.subject.state.before-start.started",
      "cua-lab.subject.state.before-start.completed",
      "cua-lab.subject.serve.started",
      "cua-lab.subject.ready.started",
      "cua-lab.subject.ready.completed"
    ]);
    expect(types.some((type) => type.includes(".clone."))).toBe(false);
  });

  it("packing failure (hook throws) fails the run closed BEFORE any sandbox is created", async () => {
    const state = { worldVersion: 0 };
    const { hooks, created } = baseHooks(state);
    hooks.packLocalTree = async () => {
      throw new Error("Local tree root produced zero packable entries after the always-on denylist.");
    };
    const result = await runSharedWorldLab({ cwd, config: localTreeSharedWorldConfig(), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SHARED_WORLD_LAB_FAILED");
    expect(result.error?.message).toContain("zero packable entries");
    expect(created).toHaveLength(0);
  });

  it("subject.localTree.keep: true preserves the sandbox on a failed role (mirrors subject.clone.keep)", async () => {
    const state = { worldVersion: 0 };
    const { hooks, killed, sandbox } = baseHooks(state);
    hooks.packLocalTree = async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES });
    hooks.runSession = async () => {
      throw new Error("boom during session");
    };
    const result = await runSharedWorldLab({
      cwd,
      config: localTreeSharedWorldConfig({ subject: { localTree: { keep: true } } }),
      dryRun: false,
      hooks
    });

    expect(result.ok).toBe(false);
    expect(killed).toEqual([]);
    expect(result.warnings.some((w) => w.includes("subject.localTree.keep"))).toBe(true);
    expect(result.sandbox).toEqual({ sandboxId: sandbox.sandboxId, killed: false });
  });

  it("engine re-enforcement (library API surface, bypassing the parser): a local-tree config missing subject.serve fails closed", async () => {
    const valid = localTreeSharedWorldConfig();
    const subjectWithoutServe: Record<string, unknown> = { ...valid.subject };
    delete subjectWithoutServe.serve;
    const broken = { ...valid, subject: subjectWithoutServe } as unknown as LabConfig;
    const result = await runSharedWorldLab({ cwd, config: broken, dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SHARED_WORLD_LAB_INVALID");
    expect(result.error?.message).toContain("subject.serve");
  });

  it("engine re-enforcement rejects path-shaped role ids before loading a desktop", async () => {
    const valid = sharedWorldConfig();
    const actor = valid.actors[0]!;
    const lanes = actor.lanes!.map((lane, index) => index === 0 ? { ...lane, id: "../escape" } : lane);
    const broken: LabConfig = { ...valid, actors: [{ ...actor, lanes }] };
    let desktopLoads = 0;
    const result = await runSharedWorldLab({
      cwd,
      config: broken,
      dryRun: false,
      hooks: {
        loadDesktopModule: async () => {
          desktopLoads += 1;
          throw new Error("must not load");
        }
      }
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SHARED_WORLD_LAB_INVALID");
    expect(result.runId).toBe("not-created");
    expect(desktopLoads).toBe(0);
  });

  it("engine re-enforcement: a local-tree config with the wrong execution.target fails closed", async () => {
    const valid = localTreeSharedWorldConfig();
    const executionWithoutTarget: Record<string, unknown> = { ...valid.execution };
    delete executionWithoutTarget.target;
    const broken = { ...valid, execution: executionWithoutTarget } as LabConfig;
    const result = await runSharedWorldLab({ cwd, config: broken, dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SHARED_WORLD_LAB_INVALID");
    expect(result.error?.message).toContain("execution.target: e2b-desktop");
  });

  it("routes through runLab(sharedWorldHooks) to the shared-world backend", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    hooks.packLocalTree = async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES });
    const config = localTreeSharedWorldConfig();
    expect(selectLabBackend(config)).toBe("shared-world");
    const outcome = await runLab(config, { cwd, dryRun: false, sharedWorldHooks: hooks });
    expect(outcome.backend).toBe("shared-world");
    if (outcome.backend !== "shared-world") return;
    expect(outcome.result.ok).toBe(true);
  });
});

describe("verifyRun fails closed on each injected shared-world overclaim", () => {
  async function goodBundlePath(): Promise<{ runId: string; bundlePath: string }> {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state);
    const result = await runSharedWorldLab({ cwd, config: sharedWorldConfig(), dryRun: false, hooks });
    expect(result.ok).toBe(true);
    const baseline = await verifyRun(cwd, result.runId);
    expect(baseline.ok).toBe(true); // the un-mutated bundle MUST verify (so a failure is attributable)
    return { runId: result.runId, bundlePath: path.join(cwd, ".humanish", "runs", result.runId, "run.json") };
  }

  async function mutateAndVerify(mutate: (bundle: Record<string, unknown>) => void): Promise<boolean> {
    const { runId, bundlePath } = await goodBundlePath();
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    mutate(bundle);
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    const verify = await verifyRun(cwd, runId);
    return verify.ok;
  }

  it("(a) attributionLimits missing no-concurrent-races", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { attributionLimits: string[] };
      sw.attributionLimits = sw.attributionLimits.filter((limit) => limit !== "no-concurrent-races");
    });
    expect(ok).toBe(false);
  });

  it("(b) a value-shaped (non-digest) checkpoint field", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { timeline: Array<Record<string, unknown>> };
      const checkpoint = sw.timeline.find((entry) => entry.kind === "checkpoint")!;
      checkpoint.rawValue = "notes=42"; // a value-shaped field; checkpoints persist digest-only
    });
    expect(ok).toBe(false);
  });

  it("(c) divergent plane provenance across turns", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { timeline: Array<Record<string, unknown>> };
      const turn = sw.timeline.find((entry) => entry.kind === "turn")!;
      turn.commit = "deadbeefdeadbeef0000"; // diverges from the single plane
    });
    expect(ok).toBe(false);
  });

  it("(d) a phantom/dropped role (sequence length != roleCount)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { sequence: string[] };
      sw.sequence = sw.sequence.slice(0, 1); // drop a role
    });
    expect(ok).toBe(false);
  });

  it("(e) a PASSED run with no checkpoint delta (hollow interaction)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { timeline: Array<Record<string, unknown>> };
      for (const entry of sw.timeline) {
        if (entry.kind === "checkpoint") entry.deltaFromPrev = false;
      }
    });
    expect(ok).toBe(false);
  });

  it("(f) a role with goal_satisfied + zero engagement", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const streams = bundle.streams as Array<{ actor?: { completionReason?: string; counts?: Record<string, number>; items?: unknown[] } }>;
      const stream = streams.find((s) => s.actor)!;
      stream.actor!.completionReason = "goal_satisfied";
      stream.actor!.counts = { actions: 0, messages: 0, screenshots: 0 };
      stream.actor!.items = [];
    });
    expect(ok).toBe(false);
  });
});
