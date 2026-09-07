import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "yaml";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorCompletionReason, type ActorStatus, type ActorTrace } from "../src/actor-contract.js";
import type { CuaActorSessionOptions } from "../src/computer-use-actor.js";
import {
  runComputerUseLoop,
  type CuaExecutor,
  type CuaLoopResult,
  type CuaObservation,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest
} from "../src/computer-use.js";
import { createE2BDesktopExecutor, type E2BDesktopLike } from "../src/e2b-desktop-executor.js";
import { extractLobbyCode, runConcurrentSharedWorld } from "../src/index.js";
import { makeChromeBrowserStateObserver } from "../src/cua-actor-lab.js";
import {
  LAB_CONFIG_SCHEMA,
  externalPublicSharedWorldValidationReason,
  parseLabConfig,
  routesToConcurrentSharedWorld,
  concurrentSharedWorldValidationReason,
  type LabConfig
} from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import type { SharedWorldLabHooks } from "../src/shared-world-lab.js";
import type { E2BDesktopCreateOptions, E2BDesktopModule, E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";
import { defaultRedactionHooks } from "../src/redaction.js";
import type { RunBundle } from "../src/index.js";
import { verifyRun } from "../src/run.js";

// ---------------------------------------------------------------------------
// Fakes. Same N-substrate shape as the concurrent-shared-world harness, but the
// external-public route creates NO subject sandbox — only actor sandboxes via
// runCuaLane. The fake runSession simulates the CUA loop's onObservedUrl calls
// (which resolve the host-first handoff latch) and returns an engaged trace.
// ---------------------------------------------------------------------------

interface FakeSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
}

const FAKE_DESKTOP_SCREEN = { width: 1440, height: 950 } as const;
const FAKE_DESKTOP_VIEWPORT = { width: 1440, height: 817, deviceScaleFactor: 1 } as const;
const LOBBY_URL = "https://lobby-trivia.example.test/en/lobby/AB2CD9"; // locale-prefixed + a valid 6-char code
const HOME_URL = "https://lobby-trivia.example.test/"; // a follower stuck here never converges

function makeFakeSandbox(id: string, commandHandler: (command: string) => { stdout?: string } | undefined): FakeSandbox {
  const calls: Array<[string, ...unknown[]]> = [];
  const sandbox = {
    calls,
    sandboxId: id,
    commands: {
      run: async (command: string) => {
        calls.push(["commands.run", command]);
        return commandHandler(command) ?? { exitCode: 0, stdout: "" };
      }
    },
    files: { write: async (filePath: string, data: string | ArrayBuffer) => { calls.push(["files.write", filePath, data]); return undefined; } },
    launch: async (application: string, uri?: string) => { calls.push(["launch", application, uri]); },
    open: async (fileOrUrl: string) => { calls.push(["open", fileOrUrl]); },
    getHost: (port: number) => `${port}-${id}.e2b.app`,
    async screenshot() { return new Uint8Array([1, 2, 3, 4]); },
    async wait(ms: number) { calls.push(["wait", ms]); },
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async (options?: unknown) => { calls.push(["stream.start", options]); }
    }
  };
  return sandbox as unknown as FakeSandbox;
}

function makeFakeModule(commandHandler: (command: string) => { stdout?: string } | undefined): {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  killed: string[];
  sandboxes: FakeSandbox[];
} {
  const created: E2BDesktopCreateOptions[] = [];
  const killed: string[] = [];
  const sandboxes: FakeSandbox[] = [];
  let n = 0;
  const module: E2BDesktopModule = {
    Sandbox: {
      create: async (templateOrOptions: string | E2BDesktopCreateOptions, maybeOptions?: E2BDesktopCreateOptions) => {
        const createOptions = typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
        n += 1;
        const [width, height] = createOptions.resolution ?? [1440, 950];
        // Each seat's physical desktop follows its device; the former fixed desktop-size fake
        // accidentally put the browser outside every phone screen (#702).
        const sandbox = makeFakeSandbox(`fake-sandbox-${String(n).padStart(3, "0")}`, (command) => {
          if (command.includes("xdpyinfo")) return { stdout: `dimensions: ${width}x${height} pixels\n` };
          if (command.includes("getwindowgeometry")) return { stdout: `X=0\nY=0\nWIDTH=${width}\nHEIGHT=${height}\n` };
          return commandHandler(command);
        });
        created.push(createOptions);
        sandboxes.push(sandbox);
        return sandbox;
      },
      kill: async (sandboxId) => { killed.push(sandboxId); return true; }
    }
  };
  return { module, created, killed, sandboxes };
}

function browserGeometryHandler(command: string): { stdout?: string } | undefined {
  if (command.includes("xdpyinfo")) return { stdout: "dimensions: 1440x950 pixels (381x251 millimeters)\n" };
  if (command.includes("browser_preference='default'")) return { stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n" };
  if (command.includes("find_chrome_window")) return { stdout: "WINDOW_ID=424242\n" };
  if (command.includes("getwindowgeometry")) return { stdout: "X=0\nY=0\nWIDTH=1440\nHEIGHT=950\n" };
  if (command.includes("browserWindow: { x: window.screenX")) {
    return { stdout: JSON.stringify({ browserWindow: { x: 0, y: 0, ...FAKE_DESKTOP_SCREEN }, viewport: FAKE_DESKTOP_VIEWPORT }) };
  }
  return undefined;
}

function makeTrace(args: { persona: CuaActorSessionOptions["persona"]; status: ActorStatus; completionReason: ActorCompletionReason; reason?: string }): ActorTrace {
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
    reason: args.reason ?? `${args.status} (${args.completionReason})`,
    ids: {},
    counts: { actions: 1, messages: 1, screenshots: 0 },
    items: [
      { id: "i-msg", kind: "message", lifecycle: "completed", title: "message", text: "did my task" },
      { id: "i-act", kind: "ui_action", lifecycle: "completed", title: "click" }
    ],
    capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: true, byoModel: false, preGrantableApprovals: false, inProcessTools: false, license: "proprietary" }
  };
}

const HOST_HOLD_MS = 60; // host keeps its window open past the followers' (overlap)
const FOLLOWER_HOLD_MS = 10;
const DEFAULT_OBSERVED_ORIGIN = "https://lobby-trivia.example.test"; // matches the declared apex appUrl (no redirect)
const lobbyUrlFor = (origin: string): string => `${origin}/en/lobby/AB2CD9`; // locale-prefixed + valid code
const homeUrlFor = (origin: string): string => `${origin}/`; // a seat stuck here observes no lobby code

/** A runSession fake for the external-public route. It detects the host by its unique mission text,
 *  fires the loop's onObservedUrl to drive the handoff latch + convergence, and returns an engaged
 *  trace. `stuckPersonaId` steers one follower (by persona id) onto the home page (no lobby code) and
 *  makes it fail — a deterministic non-converging seat. `observedOrigin` steers ALL seats onto a
 *  DIFFERENT observed origin than the declared appUrl (simulates a cross-origin redirect, e.g.
 *  apex->www); `divergentPersonaId`+`divergentOrigin` steer ONE follower onto a different observed
 *  origin than the others (a genuine non-convergence on observed origins). */
function makeExternalRunSession(args: {
  seen: CuaActorSessionOptions[];
  stuckPersonaId?: string;
  hostFiresLobby?: boolean;
  observedOrigin?: string;
  divergentPersonaId?: string;
  divergentOrigin?: string;
  sessionOutcome?: { status: ActorStatus; completionReason: ActorCompletionReason };
}): (options: CuaActorSessionOptions) => Promise<CuaLoopResult> {
  const baseOrigin = args.observedOrigin ?? DEFAULT_OBSERVED_ORIGIN;
  return async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
    args.seen.push(options);
    const isHost = options.instructions.toLowerCase().includes("create a");
    if (isHost) {
      if (args.hostFiresLobby !== false) {
        options.onObservedUrl?.(homeUrlFor(baseOrigin)); // first observe: still on the home page
        options.onObservedUrl?.(lobbyUrlFor(baseOrigin)); // then the host lands on /lobby/CODE -> resolves the latch
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, HOST_HOLD_MS); });
      const status = args.sessionOutcome?.status ?? "passed";
      const completionReason = args.sessionOutcome?.completionReason ?? "goal_satisfied";
      const trace = makeTrace({ persona: options.persona, status, completionReason });
      return { status, completionReason, reason: trace.reason, trace };
    }
    const stuck = args.stuckPersonaId !== undefined && options.persona.id === args.stuckPersonaId;
    const divergent = args.divergentPersonaId !== undefined && options.persona.id === args.divergentPersonaId;
    const followerOrigin = divergent ? (args.divergentOrigin ?? baseOrigin) : baseOrigin;
    options.onObservedUrl?.(stuck ? homeUrlFor(followerOrigin) : lobbyUrlFor(followerOrigin));
    await new Promise<void>((resolve) => { setTimeout(resolve, FOLLOWER_HOLD_MS); });
    const status: ActorStatus = stuck ? "failed" : args.sessionOutcome?.status ?? "passed";
    const completionReason: ActorCompletionReason = stuck ? "gave_up" : args.sessionOutcome?.completionReason ?? "goal_satisfied";
    const trace = makeTrace({ persona: options.persona, status, completionReason, ...(stuck ? { reason: "could not find the lobby" } : {}) });
    return { status, completionReason, reason: trace.reason, trace };
  };
}

function externalPublicConfig(overrides?: {
  appUrl?: string;
  hostCount?: number;
  concurrency?: number;
  omitPublicTarget?: boolean;
  hostLast?: boolean;
}): unknown {
  const lanes: Array<Record<string, unknown>> = overrides?.hostLast
    ? [
        // Host is the LAST roster lane (blockers 1 & 4): with concurrency < laneCount it must still be
        // schedulable on its dedicated slot rather than starved behind the follower pool.
        { id: "player-2", device: "mobile", persona: "competitive-friend", instruction: "Join the lobby you're told the code for, then play." },
        { id: "player-3", device: "small-mobile", persona: "casual-friend", instruction: "Join the lobby you're told the code for, then play." },
        { id: "host", host: true, device: "mobile", persona: "party-host", instruction: "Create a lobby, then wait; once 3 players are in, start and play." }
      ]
    : [
        { id: "host", host: true, device: "mobile", persona: "party-host", instruction: "Create a lobby, then wait; once 3 players are in, start and play." },
        { id: "player-2", device: "mobile", persona: "competitive-friend", instruction: "Join the lobby you're told the code for, then play." },
        { id: "player-3", device: "small-mobile", persona: "casual-friend", instruction: "Join the lobby you're told the code for, then play." }
      ];
  if (overrides?.hostCount === 0) delete lanes[0]!.host;
  if (overrides?.hostCount === 2) lanes[1]!.host = true;
  return {
    schema: LAB_CONFIG_SCHEMA,
    id: "lobby-trivia-3player-test",
    title: "the example multiplayer app 3-player external-public",
    subject: {
      source: "app-url",
      topology: "shared-world",
      appUrl: overrides?.appUrl ?? "https://lobby-trivia.example.test/",
      ...(overrides?.omitPublicTarget ? {} : { publicTarget: { owner: "example-operator/lobby-trivia", authorized: true } })
    },
    policies: { allowPublicTargets: true },
    actors: [{ type: "openai-computer-use", mission: "Play the example multiplayer app with your friends.", lanes }],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: overrides?.concurrency ?? 3 },
    scenario: { mode: "live" }
  };
}

function parseExternal(overrides?: Parameters<typeof externalPublicConfig>[0]): LabConfig {
  const parsed = parseLabConfig(externalPublicConfig(overrides));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function makeExternalHooks(runSession: (options: CuaActorSessionOptions) => Promise<CuaLoopResult>, extra?: Partial<SharedWorldLabHooks>): {
  hooks: SharedWorldLabHooks;
  created: E2BDesktopCreateOptions[];
  killed: string[];
  sandboxes: FakeSandbox[];
} {
  const { module, created, killed, sandboxes } = makeFakeModule(browserGeometryHandler);
  const hooks: SharedWorldLabHooks = {
    env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
    loadDesktopModule: async () => module,
    runSession,
    detachedTimers: { now: () => 0, sleep: async () => {} },
    ...extra
  };
  return { hooks, created, killed, sandboxes };
}

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-external-public-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// 1 + the crux: the mid-run current-URL read + onObservedUrl plumbing.
// ---------------------------------------------------------------------------
describe("the handoff crux: CDP current-URL read + onObservedUrl", () => {
  it("makeChromeBrowserStateObserver returns the CDP url; createE2BDesktopExecutor stamps observation.url", async () => {
    const pngFrame = PNG.sync.write(new PNG({ width: 4, height: 4 }));
    const desktop = {
      commands: {
        run: async () => ({ exitCode: 0, stdout: JSON.stringify({ url: LOBBY_URL, title: "the example multiplayer app", text: "waiting room" }) })
      },
      screenshot: async () => new Uint8Array(pngFrame)
    } as unknown as E2BDesktopSandbox;
    const observe = makeChromeBrowserStateObserver(desktop, 1000, { targetUrl: "https://lobby-trivia.example.test/" });
    const state = await observe();
    expect(state.url).toBe(LOBBY_URL);
    expect(state.title).toBe("the example multiplayer app");

    const executor = createE2BDesktopExecutor(desktop as unknown as E2BDesktopLike, { observeBrowserState: observe });
    const observation = await executor.observe();
    expect(observation.url).toBe(LOBBY_URL);
    // A non-matching home url yields no lobby code.
    expect(extractLobbyCode(observation.url)).toBe("AB2CD9");
    const homeState = { url: HOME_URL } as Pick<CuaObservation, "url">;
    expect(extractLobbyCode(homeState.url)).toBeUndefined();
  });

  it("onObservedUrl fires on the initial AND loop observe, and the url is NEVER written to the trace", async () => {
    const observedUrls: (string | undefined)[] = [];
    let observeCount = 0;
    const executor: CuaExecutor = {
      async observe(): Promise<CuaObservation> {
        observeCount += 1;
        return { stateSignature: `sig-${observeCount}`, url: `${LOBBY_URL}?turn=${observeCount}` };
      },
      async execute() {}
    };
    const provider: CuaProvider = {
      id: "fake-cua",
      capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: false, byoModel: true, preGrantableApprovals: false, inProcessTools: false, license: "open" },
      async nextTurn(_req: CuaTurnRequest): Promise<CuaTurn> {
        // One action turn, then a natural endpoint (forces exactly one loop observe).
        return observeCount <= 1
          ? { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false }
          : { actions: [], pendingSafetyChecks: [], done: true, message: "done" };
      }
    };
    let now = 0;
    const result = await runComputerUseLoop({
      instructions: "do it",
      provider,
      executor,
      persona: { id: "dana", traitsApplied: [], promptDigest: "abc123def4560000" },
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000,
      now: () => (now += 1),
      onObservedUrl: (url) => observedUrls.push(url)
    });
    // Fired on the initial observe AND at least one post-action observe.
    expect(observedUrls.length).toBeGreaterThanOrEqual(2);
    expect(observedUrls[0]).toBe(`${LOBBY_URL}?turn=1`);
    // Hygiene: the raw url never lands in the persisted trace.
    const traceText = JSON.stringify(result.trace);
    expect(traceText).not.toContain("lobby-trivia.example.test");
    expect(traceText).not.toContain("AB2CD9");
  });
});

// ---------------------------------------------------------------------------
// 3. CODE extraction regex table.
// ---------------------------------------------------------------------------
describe("extractLobbyCode regex", () => {
  const cases: Array<[string, string | undefined]> = [
    ["https://lobby-trivia.example.test/lobby/AB2CD9", "AB2CD9"],
    ["https://lobby-trivia.example.test/en/lobby/AB2CD9", "AB2CD9"],
    ["https://lobby-trivia.example.test/lobby/AB2CD9?x=1", "AB2CD9"],
    ["https://lobby-trivia.example.test/lobby/AB2CD9/", "AB2CD9"],
    ["https://lobby-trivia.example.test/lobby/AB2CD9#frag", "AB2CD9"],
    ["https://lobby-trivia.example.test/", undefined],
    ["https://lobby-trivia.example.test/game/AB2CD9", undefined],
    ["https://lobby-trivia.example.test/lobby/toolongcode", undefined],
    ["https://lobby-trivia.example.test/lobby/AB2CD", undefined] // 5 chars, too short
  ];
  it.each(cases)("%s -> %s", (url, expected) => {
    expect(extractLobbyCode(url)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 6. Public-app-plane config validation.
// ---------------------------------------------------------------------------
describe("external-public config validation + routing", () => {
  it("app-url + topology shared-world + concurrency 3 + allowPublicTargets + publicTarget.authorized ROUTES to concurrent-shared-world", () => {
    const config = parseExternal();
    expect(routesToConcurrentSharedWorld(config)).toBe(true);
    expect(selectLabBackend(config)).toBe("concurrent-shared-world");
    expect(externalPublicSharedWorldValidationReason(config)).toBeNull();
  });

  it("rejects a missing publicTarget.authorized", () => {
    const parsed = parseLabConfig(externalPublicConfig({ omitPublicTarget: true }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("subject.publicTarget");
  });

  it("rejects a loopback appUrl (not a public plane)", () => {
    const parsed = parseLabConfig(externalPublicConfig({ appUrl: "http://127.0.0.1:3000/" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("non-loopback");
  });

  it("rejects declaring subject.serve / state / exposure / clone / repos on the external-public branch", () => {
    for (const [field, subjectPatch, needle] of [
      ["serve", { serve: { start: "x", url: "http://127.0.0.1:3000/" } }, "subject.serve"],
      ["state", { state: { seed: [{ name: "s", command: "c" }] } }, "subject.state"], // parse rejects state on app-url
      ["exposure", { exposure: "synthetic" }, "subject.exposure"],
      ["clone", { clone: { depth: 1 } }, "subject.clone"],
      ["repos", { repos: ["x/y"] }, "subject.repos"]
    ] as const) {
      const base = externalPublicConfig() as Record<string, unknown>;
      const subject = { ...(base.subject as Record<string, unknown>), ...subjectPatch };
      const parsed = parseLabConfig({ ...base, subject });
      expect(parsed.ok, `${field} must be rejected`).toBe(false);
      if (!parsed.ok) expect(parsed.error.message).toContain(needle);
    }
  });

  it("rejects zero or >1 host lanes", () => {
    const zero = parseLabConfig(externalPublicConfig({ hostCount: 0 }));
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error.message).toContain("EXACTLY ONE");
    const two = parseLabConfig(externalPublicConfig({ hostCount: 2 }));
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.error.message).toContain("EXACTLY ONE");
  });

  it("rejects N=1 (a single-seat shared world proves nothing)", () => {
    // One host lane, concurrency 1 -> a shared world needs >=2 seats AND concurrency > 1.
    const base = externalPublicConfig({ concurrency: 1 }) as Record<string, unknown>;
    const actor = (base.actors as Array<Record<string, unknown>>)[0]!;
    actor.lanes = [(actor.lanes as unknown[])[0]];
    const parsed = parseLabConfig(base);
    expect(parsed.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. GATE-INTACT regression: the provisioned-getHost path is unchanged.
// ---------------------------------------------------------------------------
describe("getHost synthetic gate stays intact (regression)", () => {
  function provisionedConfig(): LabConfig {
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "provisioned-gethost",
      subject: {
        source: "clone",
        topology: "shared-world",
        exposure: "synthetic",
        repos: ["example-org/collab-app"],
        env: ["DATABASE_URL"],
        serve: { install: "pnpm install", start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
        state: { seed: [{ name: "migrate", command: "pnpm db:migrate" }], checkpoint: [{ name: "n", command: "psql n" }] }
      },
      actors: [{ type: "openai-computer-use", mission: "use", lanes: [{ id: "a", persona: "p1", entry: "/a" }, { id: "b", persona: "p2", entry: "/b" }] }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  it("a valid provisioned-getHost config still validates and still REQUIRES exposure:synthetic + seeded", () => {
    const config = provisionedConfig();
    expect(concurrentSharedWorldValidationReason(config)).toBeNull();
    // Drop exposure:synthetic -> the getHost gate still fails closed.
    const { exposure: _dropped, ...subjectWithoutExposure } = config.subject;
    const withoutExposure = { ...config, subject: subjectWithoutExposure } as LabConfig;
    expect(concurrentSharedWorldValidationReason(withoutExposure)).toContain("exposure: synthetic");
  });
});

// ---------------------------------------------------------------------------
// 4 + 9. Handoff barrier + lobby convergence (deterministic, $0).
// ---------------------------------------------------------------------------
describe("host-first handoff barrier + convergence", () => {
  it("host resolves the latch; followers open only AFTER, receive the CODE, and windows overlap", async () => {
    const seen: CuaActorSessionOptions[] = [];
    const { hooks, created } = makeExternalHooks(makeExternalRunSession({ seen }));
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(result.host).toBeUndefined(); // NO harness-minted host on the external-public plane
    expect(result.subjectSandbox).toBeUndefined(); // NO subject sandbox
    expect(created).toHaveLength(3); // exactly 3 ACTOR sandboxes (no subject sandbox)
    expect(result.overlapProven).toBe(true);

    // Followers received the CODE threaded into their mission (runtime-only prompt, not persisted).
    const followerInstructions = seen.filter((o) => !o.instructions.toLowerCase().includes("create a")).map((o) => o.instructions);
    expect(followerInstructions).toHaveLength(2);
    expect(followerInstructions.every((text) => text.includes("AB2CD9"))).toBe(true);
    expect(followerInstructions.every((text) => text.toLowerCase().includes("join"))).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.sharedWorld?.planeClass).toBe("external-public");
    expect(bundle.sharedWorld?.plane.publicOriginDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.sharedWorld?.plane.exposure).toBeUndefined(); // no synthetic claim on a real site
    expect(bundle.sharedWorld?.plane.hostDigest).toBeUndefined();
    expect(bundle.sharedWorld?.stateSeries).toBeUndefined(); // option A: no authoritative state proof
    expect(bundle.subject?.state.provenance).toBe("external-public");

    // Every seat's CDP-observed origin equals the operator-declared origin (convergence on one origin).
    const windows = bundle.sharedWorld?.laneWindows ?? [];
    expect(windows).toHaveLength(3);
    for (const w of windows) expect(w.routeHostDigest).toBe(bundle.sharedWorld?.plane.publicOriginDigest);
    const overlapping = windows.some((a, i) => windows.some((b, j) => i !== j && a.startedAt < b.endedAt && b.startedAt < a.endedAt));
    expect(overlapping).toBe(true);

    // lobbyConvergenceDigest: all 3 seats converged on the SAME /lobby/CODE.
    expect(bundle.sharedWorld?.lobbyConvergenceDigest).toMatch(/^[0-9a-f]{16}$/);

    // HYGIENE: the raw code + the raw origin never land in the bundle.
    const runText = await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8");
    expect(runText).not.toContain("AB2CD9");
    expect(runText).not.toContain("lobby-trivia.example.test");

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("a follower stuck on / does not converge (digest absent) and is a non-passed outcome", async () => {
    const seen: CuaActorSessionOptions[] = [];
    const { hooks } = makeExternalHooks(makeExternalRunSession({ seen, stuckPersonaId: "casual-friend" }));
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: false, hooks });

    expect(result.ok).toBe(false); // not every seat passed
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    // No false convergence: one seat never reached a /lobby/CODE.
    expect(bundle.sharedWorld?.lobbyConvergenceDigest).toBeUndefined();
    const stuck = bundle.sharedWorld?.outcomes?.find((o) => o.roleId === "player-3");
    expect(stuck?.ok).toBe(false);
  });

  it("proves convergence from the VISION read when CDP never surfaces a /lobby/CODE (the real E2B case)", async () => {
    // The unreliable-E2B reality: the CDP url-read yields only the ORIGIN (home), never a /lobby/CODE. The
    // lobby code reaches the harness ONLY through the vision-off-frame read — the host latches the handoff
    // with it, and every follower INDEPENDENTLY observes its own code with it. Convergence must still be
    // PROVEN (previously it read "not observed" because followers' codes came solely from the flaky CDP).
    const seen: CuaActorSessionOptions[] = [];
    const frame = Buffer.from("waiting-room-frame-bytes");
    let visionReads = 0;
    const runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      seen.push(options);
      const isHost = options.instructions.toLowerCase().includes("create a");
      options.onObservedUrl?.(homeUrlFor(DEFAULT_OBSERVED_ORIGIN)); // origin only — CDP never sees the code
      options.onScreenshot?.(frame); // this seat's waiting-room frame -> the vision reader extracts the code
      await new Promise<void>((resolve) => { setTimeout(resolve, isHost ? HOST_HOLD_MS : FOLLOWER_HOLD_MS); });
      const trace = makeTrace({ persona: options.persona, status: "passed", completionReason: "goal_satisfied" });
      return { status: "passed", completionReason: "goal_satisfied", reason: trace.reason, trace };
    };
    const { hooks } = makeExternalHooks(runSession, {
      readLobbyCodeFromFrame: async () => { visionReads += 1; return "AB2CD9"; },
      handoffDeadlineMs: 5_000
    });
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    // Convergence PROVEN purely from the vision reads (CDP surfaced no /lobby/CODE for any seat).
    expect(bundle.sharedWorld?.lobbyConvergenceDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(visionReads).toBeGreaterThanOrEqual(3); // host latch + each follower observing its own code
    // Hygiene preserved: the raw code never lands in the bundle.
    expect(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")).not.toContain("AB2CD9");
    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4b. Host-first scheduling: the host lane is NEVER starved (blockers 1 & 4).
// ---------------------------------------------------------------------------
describe("host-first scheduling: host runs on a dedicated slot, never starved", () => {
  it("lanes [follower, follower, host] with concurrency 2 does NOT deadlock; followers receive the code", async () => {
    // The host is the LAST roster lane and concurrency (2) < laneCount (3): if the host were scheduled
    // inside the same bounded pool as the followers, the two follower workers would block on the latch
    // holding both slots and the host would never be scheduled -> a spurious HANDOFF_TIMEOUT. On its
    // dedicated slot the host runs immediately, resolves the latch, and the followers proceed.
    const seen: CuaActorSessionOptions[] = [];
    const { hooks, created } = makeExternalHooks(
      makeExternalRunSession({ seen }),
      { handoffDeadlineMs: 5_000 } // a real deadline; a deadlock would blow past it and fail the test
    );
    const result = await runConcurrentSharedWorld({
      cwd,
      config: parseExternal({ hostLast: true, concurrency: 2 }),
      dryRun: false,
      hooks
    });

    expect(result.ok).toBe(true); // no deadlock, no HANDOFF_TIMEOUT
    expect(result.error).toBeUndefined();
    expect(created).toHaveLength(3); // all three seats opened (host + 2 followers)

    // Both followers received the host's CODE threaded into their mission.
    const followerInstructions = seen.filter((o) => !o.instructions.toLowerCase().includes("create a")).map((o) => o.instructions);
    expect(followerInstructions).toHaveLength(2);
    expect(followerInstructions.every((text) => text.includes("AB2CD9"))).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.sharedWorld?.lobbyConvergenceDigest).toMatch(/^[0-9a-f]{16}$/); // all seats on one lobby
    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4c. Observed-origin convergence: redirect tolerated, divergence fails closed (blocker 2).
// ---------------------------------------------------------------------------
describe("observed-origin convergence (redirect tolerated)", () => {
  it("seats observed on www while declared apex PASSES; publicOriginDigest = the OBSERVED origin", async () => {
    // Declared appUrl is the apex https://lobby-trivia.example.test/, but every seat's CDP-observed final URL is
    // on https://www.lobby-trivia.example.test (a normal apex->www 307 redirect). This must PASS: the convergence
    // proof is about the OBSERVED origin, and publicOriginDigest is derived from it (not the declared).
    const seen: CuaActorSessionOptions[] = [];
    const { hooks } = makeExternalHooks(makeExternalRunSession({ seen, observedOrigin: "https://www.lobby-trivia.example.test" }));
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: false, hooks });
    expect(result.ok).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    const plane = bundle.sharedWorld?.plane as { publicOriginDigest?: string; declaredOriginDigest?: string };
    expect(plane.publicOriginDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(plane.declaredOriginDigest).toMatch(/^[0-9a-f]{16}$/);
    // publicOriginDigest is the OBSERVED (www) origin; declaredOriginDigest is the DECLARED (apex) origin.
    // A redirect makes them DIFFER — and that difference must not fail verify.
    expect(plane.publicOriginDigest).not.toBe(plane.declaredOriginDigest);
    // Every seat's observed routeHostDigest equals the observed publicOriginDigest (they converged).
    for (const w of bundle.sharedWorld?.laneWindows ?? []) expect(w.routeHostDigest).toBe(plane.publicOriginDigest);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("seats on TWO different observed origins FAIL closed (did not converge on ONE observed origin)", async () => {
    // The host + player-2 observe www; player-3 observes the apex origin. The seats genuinely diverge
    // on their OBSERVED origins, so publicOriginDigest cannot be set and verify fails closed.
    const seen: CuaActorSessionOptions[] = [];
    const { hooks } = makeExternalHooks(makeExternalRunSession({
      seen,
      observedOrigin: "https://www.lobby-trivia.example.test",
      divergentPersonaId: "casual-friend", // player-3 lands on the apex origin instead
      divergentOrigin: "https://lobby-trivia.example.test"
    }));
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: false, hooks });

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    // Divergent observed origins -> no single observed origin -> publicOriginDigest absent.
    expect((bundle.sharedWorld?.plane as { publicOriginDigest?: string }).publicOriginDigest).toBeUndefined();
    const distinct = new Set((bundle.sharedWorld?.laneWindows ?? []).map((w) => w.routeHostDigest));
    expect(distinct.size).toBe(2);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(false);
    const check = verify.checks.find((c) => c.name === "shared-world evidence");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("did not converge on ONE OBSERVED origin");
  });
});

// ---------------------------------------------------------------------------
// 4d. review.summary is plane-class-aware (external-public, not getHost).
// ---------------------------------------------------------------------------
describe("review.summary is external-public plane-aware", () => {
  it("dry-run summary names the external-public plane (no getHost/clone/seed), not a getHost-exposed plane", async () => {
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: true });
    expect(result.ok).toBe(true);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    const summary = bundle.review.summary;
    expect(summary).toContain("external-public");
    expect(summary).toContain("no getHost");
    expect(summary).not.toContain("getHost-exposed");
  });

  it("live summary reports lobby convergence and drops the 'state delta(s) under load' clause", async () => {
    const seen: CuaActorSessionOptions[] = [];
    const { hooks } = makeExternalHooks(makeExternalRunSession({ seen }));
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: false, hooks });
    expect(result.ok).toBe(true);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    const summary = bundle.review.summary;
    expect(summary).not.toContain("state delta(s) under load");
    expect(summary).toContain("seats converged on one lobby");
  });

  it("separates lobby convergence from unfinished participant sessions (#364)", async () => {
    const seen: CuaActorSessionOptions[] = [];
    const { hooks } = makeExternalHooks(makeExternalRunSession({
      seen,
      // Exact captured live shape from #364 (humanish 0.36.0): all three traces were `passed`
      // even though every completionReason was `budget_reached`. Current actors normalize that
      // pairing to `incomplete`, but the durable summary must remain honest for either producer.
      sessionOutcome: { status: "passed", completionReason: "budget_reached" }
    }));
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: false, hooks });
    expect(result.ok).toBe(true);

    const runRoot = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
    const reviewMarkdown = await readFile(path.join(runRoot, "review.md"), "utf8");

    expect(bundle.review.verdict).toBe("pass");
    const expectedSummary = "Concurrent shared-world (ONE external-public plane, 3 simultaneous personas): swarm ran coherently; 3/3 actor session(s) passed credibility checks; mission endpoint: 0/3 ended goal_satisfied; completion reasons: budget_reached 3/3; overlap proven; 3 seats converged on one lobby.";
    expect(bundle.review.summary).toBe(expectedSummary);
    expect(bundle.review.summary).not.toContain("reached their goal");
    expect(reviewMarkdown).toContain("- verdict: pass");
    expect(reviewMarkdown).toContain(`- summary: ${expectedSummary}`);
  });
});

// ---------------------------------------------------------------------------
// 5. Handoff timeout fail-closed.
// ---------------------------------------------------------------------------
describe("handoff timeout fail-closed", () => {
  it("shares the actor study budget across host and follower sessions", async () => {
    const seen: CuaActorSessionOptions[] = [];
    const config = parseExternal();
    config.actors[0]!.model = "gpt-5.5";
    config.execution!.caps = { maxUsd: 1, maxTotalUsd: 0.04 };
    const { hooks } = makeExternalHooks(makeExternalRunSession({ seen }));
    await runConcurrentSharedWorld({ cwd, config, dryRun: false, hooks });
    expect(seen).toHaveLength(3);
    const usage = { input: 5000, output: 0 };
    expect(seen[0]!.overRunBudget?.(usage)).toBeNull();
    expect(seen[1]!.overRunBudget?.(usage)).toContain("study budget reached");
    // The host sees the sibling's spend without its own usage growing.
    expect(seen[0]!.overRunBudget?.(usage)).toContain("study budget reached");
  });

  it("refuses an unpriceable spend cap before opening the host", async () => {
    const config = parseExternal();
    config.actors[0]!.model = "unknown-priced-model";
    config.execution!.caps = { maxTotalUsd: 1 };
    const { hooks, created } = makeExternalHooks(makeExternalRunSession({ seen: [] }));
    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, hooks });
    expect(result.error?.message).toContain("unpriced model");
    expect(created).toHaveLength(0);
  });

  it("preserves a host startup failure instead of claiming the handoff deadline expired", async () => {
    const { hooks, created, killed } = makeExternalHooks(async () => { throw new Error("physical browser containment failed"); }, { handoffDeadlineMs: 5000 });
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: false, hooks });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED");
    expect(result.error?.message).toContain("physical browser containment failed");
    expect(result.error?.message).not.toContain("deadline");
    expect(created).toHaveLength(1);
    expect(killed).toHaveLength(1);
    expect(result.roles.filter((role) => role.id !== "host").every((role) => role.error?.message.includes("physical browser containment failed"))).toBe(true);
  });

  it("host never yields a /lobby/CODE -> followers do NOT open, run returns HANDOFF_TIMEOUT, host window recorded", async () => {
    const seen: CuaActorSessionOptions[] = [];
    const { hooks, created } = makeExternalHooks(
      makeExternalRunSession({ seen, hostFiresLobby: false }),
      { handoffDeadlineMs: 30 }
    );
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_HANDOFF_TIMEOUT");
    // Only the host opened a browser (one actor sandbox); the followers failed closed WITHOUT opening.
    expect(created).toHaveLength(1);
    expect(seen).toHaveLength(1); // only the host session ran

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    const windows = bundle.sharedWorld?.laneWindows ?? [];
    // The host window is still recorded (a real [start,end]); the followers are contract windows.
    const hostWindow = windows.find((w) => w.roleId === "host");
    expect(hostWindow).toBeTruthy();
    expect((hostWindow!.endedAt) - (hostWindow!.startedAt)).toBeGreaterThanOrEqual(0);
    // The follower outcomes are non-pass (they never opened).
    const followerOutcomes = bundle.sharedWorld?.outcomes?.filter((o) => o.roleId !== "host") ?? [];
    expect(followerOutcomes.every((o) => o.ok === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Verify evidence class (external-public) fail-closed inversions.
// ---------------------------------------------------------------------------
describe("verify evidence class: external-public fail-closed inversions", () => {
  async function goodRun(): Promise<string> {
    const seen: CuaActorSessionOptions[] = [];
    const { hooks } = makeExternalHooks(makeExternalRunSession({ seen }));
    const result = await runConcurrentSharedWorld({ cwd, config: parseExternal(), dryRun: false, hooks });
    expect(result.ok).toBe(true);
    return result.runId;
  }

  async function mutateAndVerify(runId: string, mutate: (bundle: RunBundle) => void): Promise<{ ok: boolean; message: string }> {
    const runPath = path.join(cwd, ".humanish", "runs", runId, "run.json");
    const bundle = JSON.parse(await readFile(runPath, "utf8")) as RunBundle;
    mutate(bundle);
    await writeFile(runPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    const verify = await verifyRun(cwd, runId);
    const check = verify.checks.find((c) => c.name === "shared-world evidence");
    return { ok: check?.ok ?? true, message: check?.message ?? "" };
  }

  it("fails closed when provenance is 'seeded'", async () => {
    const { ok, message } = await mutateAndVerify(await goodRun(), (b) => { b.subject!.state.provenance = "seeded" as never; });
    expect(ok).toBe(false);
    expect(message).toContain('provenance == "external-public"');
  });

  it("fails closed when exposure is 'synthetic' (a lie on a real site)", async () => {
    const { ok, message } = await mutateAndVerify(await goodRun(), (b) => { (b.sharedWorld!.plane as { exposure?: string }).exposure = "synthetic"; });
    expect(ok).toBe(false);
    expect(message).toContain("exposure must be ABSENT");
  });

  it("fails closed when a routeHostDigest diverges (seats did not converge on ONE observed origin)", async () => {
    const { ok, message } = await mutateAndVerify(await goodRun(), (b) => { b.sharedWorld!.laneWindows![1]!.routeHostDigest = "0000000000000000"; });
    expect(ok).toBe(false);
    expect(message).toContain("did not converge on ONE OBSERVED origin");
  });

  it("fails closed when a required external-public attributionLimit is missing", async () => {
    const { ok, message } = await mutateAndVerify(await goodRun(), (b) => {
      b.sharedWorld!.attributionLimits = b.sharedWorld!.attributionLimits.filter((l) => l !== "no-synthetic-attestation");
    });
    expect(ok).toBe(false);
    expect(message).toContain("no-synthetic-attestation");
  });

  it("fails closed on a passed run with no overlapping windows (relaxed concurrency-on-pass)", async () => {
    const { ok, message } = await mutateAndVerify(await goodRun(), (b) => {
      // Force strictly non-overlapping windows.
      b.sharedWorld!.laneWindows!.forEach((w, i) => { w.startedAt = i * 1000; w.endedAt = i * 1000 + 100; });
    });
    expect(ok).toBe(false);
    expect(message).toContain("no two laneWindows overlap");
  });

  it("does NOT require a stateSeries and does NOT apply the getHost hostDigest assertion", async () => {
    const runId = await goodRun();
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.sharedWorld?.stateSeries).toBeUndefined();
    expect(bundle.sharedWorld?.plane.hostDigest).toBeUndefined();
    const verify = await verifyRun(cwd, runId);
    expect(verify.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. init template smoke: the committed lobby-trivia-3player lab.
// ---------------------------------------------------------------------------
describe("lobby-trivia-3player committed lab", () => {
  it("parses, routes to concurrent-shared-world, and dry-runs $0 with a verified bundle", async () => {
    const raw = parse(readFileSync(path.join(process.cwd(), "humanish", "labs", "lobby-trivia-3player.yaml"), "utf8")) as Record<string, unknown>;
    raw.schema = LAB_CONFIG_SCHEMA;
    const parsed = parseLabConfig(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings ?? []).toEqual([]);
    expect(selectLabBackend(parsed.config)).toBe("concurrent-shared-world");

    const outcome = await runLab(parsed.config, { cwd, dryRun: true });
    expect(outcome.backend).toBe("concurrent-shared-world");
    if (outcome.backend !== "concurrent-shared-world") return;
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.host).toBeUndefined();
    expect(outcome.result.subjectSandbox).toBeUndefined();

    const verify = await verifyRun(cwd, outcome.result.runId);
    expect(verify.ok).toBe(true);
  });
});

// Exercise the actual first-party provider route: a custom runSession would bypass the
// output-limit contract. The response is a retained wire fixture; no network or paid compute.
it("routes actor output limits and per-lane reasoning to concurrent provider requests", async () => {
  const config = parseExternal();
  config.actors[0]!.maxOutputTokens = 8192;
  config.actors[0]!.reasoningEffort = "low";
  config.actors[0]!.lanes![1]!.reasoningEffort = "high";
  const { hooks } = makeExternalHooks(makeExternalRunSession({ seen: [] }));
  delete hooks.runSession;
  hooks.prepareDesktop = async desktop => {
    desktop.screenshot = async () => new Uint8Array(PNG.sync.write(new PNG({ width: 4, height: 4 })));
  };
  hooks.readLobbyCodeFromFrame = async () => "AB2CD9";
  const captured = JSON.parse(readFileSync(new URL("./fixtures/openai-closing-report/typed-closing-report.json", import.meta.url), "utf8"));
  const bodies: Array<{ max_output_tokens?: number; reasoning?: { effort?: string } }> = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => captured, text: async () => JSON.stringify(captured) };
  });
  try {
    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, hooks });
    expect(bodies).toHaveLength(3);
    expect(bodies.map(body => body.max_output_tokens)).toEqual([8192, 8192, 8192]);
    expect(bodies.map(body => body.reasoning?.effort).sort()).toEqual(["high", "low", "low"]);
    expect(result.roles).toHaveLength(3);
  } finally { vi.unstubAllGlobals(); }
});
