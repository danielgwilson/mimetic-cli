import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTOR_TRACE_SCHEMA, type ActorCompletionReason, type ActorStatus, type ActorTrace } from "../src/actor-contract.js";
import type { CuaActorSessionOptions } from "../src/computer-use-actor.js";
import type { CuaLoopResult } from "../src/computer-use.js";
import type { E2BDesktopCreateOptions, E2BDesktopModule, E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";
import { concurrentSharedWorldValidationReason, LAB_CONFIG_SCHEMA, parseLabConfig, routesToConcurrentSharedWorld, type LabConfig } from "../src/lab-config.js";
import { runLab, selectLabBackend } from "../src/lab-engine.js";
import {
  runConcurrentSharedWorld,
  extractLobbyCodeFromNarration,
  parseLobbyCodeReply,
  extractResponsesOutputText,
  readLobbyCodeFromFrame
} from "../src/concurrent-shared-world-lab.js";
import type { SharedWorldLabHooks } from "../src/shared-world-lab.js";
import type { BrowserLabScoringContext, RunAdapterScore, RunBundle, SubjectPhaseEvent } from "../src/index.js";
import { verifyRun } from "../src/run.js";
import { serveObserver, type ObserverResult, type ObserverServer } from "../src/observer.js";
import type { LocalTreeArchive } from "../src/source-archive.js";

// ---------------------------------------------------------------------------
// Fakes for the N+1 substrate. The module records create/kill BY id and exposes
// NO `list` (enumerate-and-kill is impossible by construction). Each fake sandbox
// has getHost(port) → a BARE tokenless host keyed on its id (no scheme, exactly as
// the real @e2b SDK returns it — the orchestrator normalizes it to https://). The command handler drives
// the detached primitive (provisioning + checkpoints) and returns STATEFUL
// checkpoint output (a shared worldVersion the fake runSession bumps per turn).
//
// FIX-1: overlap is PRODUCED, not injected. The fake runSession blocks on a
// RENDEZVOUS LATCH until all N actors have entered, so N lane fns are genuinely
// in-flight while the REAL orchestrator clock (Date.now — NOT overridden) measures
// the wrapped [start,end] laneWindows. The windows therefore overlap for real.
// ---------------------------------------------------------------------------

interface FakeSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
}

const FAKE_DESKTOP_SCREEN = { width: 1440, height: 950 } as const;
const FAKE_DESKTOP_VIEWPORT = { width: 1440, height: 817, deviceScaleFactor: 1 } as const;

function browserTargetFromCalls(calls: Array<[string, ...unknown[]]>): string | undefined {
  for (const call of calls) {
    if (call[0] === "open") return String(call[1]);
    if (call[0] !== "commands.run") continue;
    const target = String(call[1]).match(/^target_url='([^']+)'$/m)?.[1];
    if (target) return target;
  }
  return undefined;
}

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
    files: {
      // Raw data (never String()-coerced): existing callers write string script content
      // (String(data) === data for those, unchanged), and the local-tree upload path writes a
      // real ArrayBuffer that tests need to inspect directly (byteLength, reference equality).
      write: async (filePath: string, data: string | ArrayBuffer) => {
        calls.push(["files.write", filePath, data]);
        return undefined;
      }
    },
    launch: async (application: string, uri?: string) => { calls.push(["launch", application, uri]); },
    open: async (fileOrUrl: string) => { calls.push(["open", fileOrUrl]); },
    getHost: (port: number) => `${port}-${id}.e2b.app`, // BARE host (no scheme) — matches the real @e2b SDK
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

function makeFakeModule(commandHandler: (command: string) => { stdout?: string } | undefined, fitToResolution = true): {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
  sandboxes: FakeSandbox[];
} {
  const created: E2BDesktopCreateOptions[] = [];
  // Parallel to `created`: the custom template each create() got — subject AND every actor sandbox.
  // undefined == called with NO template arg (the byte-stable default).
  const templates: (string | undefined)[] = [];
  const killed: string[] = [];
  const sandboxes: FakeSandbox[] = [];
  let n = 0;
  const module: E2BDesktopModule = {
    Sandbox: {
      // Mirror the real @e2b/desktop overload: create(opts) OR create(template, opts).
      create: async (templateOrOptions: string | E2BDesktopCreateOptions, maybeOptions?: E2BDesktopCreateOptions) => {
        const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
        const createOptions = typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
        n += 1;
        const [width, height] = createOptions.resolution ?? [1440, 950];
        const sandbox = makeFakeSandbox(`fake-sandbox-${String(n).padStart(3, "0")}`, (command) => {
          // A phone seat has its own physical display, including in the committed live fixture.
          if (fitToResolution && command.includes("xdpyinfo")) return { stdout: `dimensions: ${width}x${height} pixels\n` };
          if (fitToResolution && command.includes("getwindowgeometry")) return { stdout: `X=0\nY=0\nWIDTH=${width}\nHEIGHT=${height}\n` };
          return commandHandler(command);
        });
        templates.push(template);
        created.push(createOptions);
        sandboxes.push(sandbox);
        return sandbox;
      },
      kill: async (sandboxId) => { killed.push(sandboxId); return true; }
      // NOTE: NO `list` method.
    }
  };
  return { module, created, templates, killed, sandboxes };
}

function makeCommandHandler(state: { worldVersion: number }): (command: string) => { stdout?: string } | undefined {
  return (command: string): { stdout?: string } | undefined => {
    if (command.includes("xdpyinfo")) return { stdout: "dimensions: 1440x950 pixels (381x251 millimeters)\n" };
    if (command.includes("browser_preference='default'")) return { stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n" };
    if (command.includes("/status")) return { stdout: "0" };
    if (command.includes("rev-parse")) return { stdout: "abc123def4567890abc1\n" };
    if (command.includes("curl")) return { stdout: "READY" };
    if (command.includes("checkpoint-") && command.includes("tail -c")) return { stdout: `world=${state.worldVersion}\n` };
    if (command.includes("find_chrome_window")) return { stdout: "WINDOW_ID=424242\n" };
    if (command.includes("getwindowgeometry")) return { stdout: "X=0\nY=0\nWIDTH=1440\nHEIGHT=950\n" };
    if (command.includes("browserWindow: { x: window.screenX")) {
      return { stdout: JSON.stringify({ browserWindow: { x: 0, y: 0, ...FAKE_DESKTOP_SCREEN }, viewport: FAKE_DESKTOP_VIEWPORT }) };
    }
    if (command.includes("tail -c")) return { stdout: "" };
    return undefined;
  };
}

/** A rendezvous latch: the returned fn blocks until `count` callers have entered, then releases
 *  them all — so `count` lane fns are genuinely in-flight at once (real overlap). */
function makeRendezvous(count: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    await gate;
  };
}

async function waitForCondition(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeTrace(args: { persona: { id: string; traitsApplied: string[]; promptDigest: string }; status: ActorStatus; completionReason: ActorCompletionReason; actions: number; messages: number; reason?: string }): ActorTrace {
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
    counts: { actions: args.actions, messages: args.messages, screenshots: 0 },
    items: [
      ...(args.messages > 0 ? [{ id: "i-msg", kind: "message" as const, lifecycle: "completed" as const, title: "message", text: "did my task" }] : []),
      ...(args.actions > 0 ? [{ id: "i-act", kind: "ui_action" as const, lifecycle: "completed" as const, title: "click" }] : [])
    ],
    capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: true, byoModel: false, preGrantableApprovals: false, inProcessTools: false, license: "proprietary" }
  };
}

/** A runSession fake: rendezvous (real overlap) → bump the shared world → engaged passed trace,
 *  unless a per-call override (harness throw / mission failure) applies. */
function makeRunSession(
  state: { worldVersion: number },
  rendezvous: () => Promise<void>,
  override?: (index: number) => { throwMessage?: string; status?: ActorStatus; completionReason?: ActorCompletionReason; reason?: string } | undefined
): (options: CuaActorSessionOptions) => Promise<CuaLoopResult> {
  let calls = -1;
  return async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
    calls += 1;
    // The override targets a LANE (by its persona id), never "the Nth call": concurrent lanes
    // interleave however the scheduler likes, so call order is an accident — asserting on it made
    // these tests flake the moment an unrelated await shifted the schedule (#359 CI).
    const personaMatch = /^persona-(\d+)$/.exec(options.persona.id);
    const myIndex = personaMatch ? Number(personaMatch[1]) - 1 : calls;
    await rendezvous(); // all actors are in-flight here → their windows overlap on the real clock
    // All lanes were released together; hold them concurrently for a measurable interval so the
    // REAL orchestrator clock records overlapping [start,end] windows (Date.now is ms-resolution —
    // without this the instant fake collapses every window to a zero-width point). The overlap is
    // genuinely produced (all lanes are in this delay at once), not injected.
    await new Promise<void>((resolve) => { setTimeout(resolve, 15); });
    state.worldVersion += 1; // each actor's turn mutates the shared world
    const o = override?.(myIndex);
    if (o?.throwMessage) {
      throw new Error(o.throwMessage);
    }
    const status = o?.status ?? "passed";
    const completionReason = o?.completionReason ?? "goal_satisfied";
    const trace = makeTrace({ persona: options.persona, status, completionReason, actions: 1, messages: 1, ...(o?.reason === undefined ? {} : { reason: o.reason }) });
    return { status, completionReason, reason: trace.reason, trace };
  };
}

function concurrentConfig(roleCount = 3, concurrency = 3, template?: string): LabConfig {
  const lanes = Array.from({ length: roleCount }, (_unused, i) => ({
    id: `persona-${String(i + 1).padStart(2, "0")}`,
    actorType: i === 0 ? "initiator" : "collaborator",
    surface: i === 0 ? "intake" : "review",
    caseGroup: "case-001",
    persona: `persona-${i + 1}`,
    entry: `/seat-${i + 1}`
  }));
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "concurrent-shared-world-proof",
    title: "Concurrent shared-world proof",
    subject: {
      source: "clone",
      topology: "shared-world",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: { install: "pnpm install", start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [
          { name: "notes-count", command: "psql query notes" },
          { name: "reviews-count", command: "psql query reviews" }
        ]
      }
    },
    actors: [{ type: "openai-computer-use", mission: "Use the shared app.", lanes }],
    execution: {
      target: "e2b-desktop",
      timeoutMs: 60_000,
      concurrency,
      ...(template === undefined ? {} : { desktop: { template } })
    },
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function baseHooks(state: { worldVersion: number }, rendezvous: () => Promise<void>, override?: Parameters<typeof makeRunSession>[2]): {
  hooks: SharedWorldLabHooks;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
  sandboxes: FakeSandbox[];
  phaseEvents: SubjectPhaseEvent[];
} {
  const { module, created, templates, killed, sandboxes } = makeFakeModule(makeCommandHandler(state));
  const phaseEvents: SubjectPhaseEvent[] = [];
  const hooks: SharedWorldLabHooks = {
    env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key", DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" },
    loadDesktopModule: async () => module,
    runSession: makeRunSession(state, rendezvous, override),
    detachedTimers: { now: () => 0, sleep: async () => {} },
    proberCadenceMs: 100_000, // large: no periodic snapshot fires in the fast test (baseline+final carry the gate)
    // Captures instead of writing to real stderr (the call-site default when this is absent);
    // also lets tests assert the ordered phase-boundary sequence.
    onPhase: (event) => { phaseEvents.push(event); }
  };
  return { hooks, created, templates, killed, sandboxes, phaseEvents };
}

const CONCURRENT_ADAPTER_NAMESPACE = "concurrent-browser-adapter-proof";

function concurrentFailScore(ctx: BrowserLabScoringContext): RunAdapterScore {
  return {
    schema: "humanish.adapter-score.v1",
    namespace: CONCURRENT_ADAPTER_NAMESPACE,
    status: "fail",
    score: 20,
    summary: `${ctx.backend} adapter found no product-level concurrent success evidence.`,
    data: {
      backend: ctx.backend,
      laneCount: ctx.laneCount
    }
  };
}

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-concurrent-sw-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("runConcurrentSharedWorld (the heart: real orchestration + rendezvous latch, $0)", () => {
  it("dry-run produces a verified contract bundle (concurrent shape + attributionClass + limits), no sandboxes", async () => {
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(), dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.subjectSandbox).toBeUndefined();
    expect(result.topologyMode).toBe("concurrent");
    expect(result.roleCount).toBe(3);
    expect(result.concurrency).toBe(3);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.attributionClass).toBe("shared-world");
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.timeline).toBeUndefined();
    expect(bundle.sharedWorld.attributionLimits).toEqual(
      expect.arrayContaining(["concurrent", "best-effort-causal-attribution", "non-deterministic-shared-state", "window-and-snapshot-granularity", "contention-observed-not-proven-safe", "state-change-not-isolated-to-actors"])
    );
    expect(bundle.sharedWorld.attributionLimits).not.toContain("sequential-only");
    const publicTruth = JSON.stringify({ events: bundle.events, review: bundle.review }).toLowerCase();
    expect(publicTruth).toContain("this contract-only run proves no live concurrency, scale, or adoption");
    expect(publicTruth).toContain("proves contract shape only, not live behavior, scale, or adopter-harness replacement");
    expect(publicTruth).not.toContain("receipt");
    expect(publicTruth).not.toContain("deferred live receipt");
    expect(publicTruth).not.toContain("capability at scale");
    expect(bundle.streams.every((stream: { viewport?: unknown }) => stream.viewport === undefined)).toBe(true);
    expect(bundle.streams.map((stream: { desktopGeometry: { screen: { requested: unknown } } }) => stream.desktopGeometry.screen.requested)).toEqual([
      FAKE_DESKTOP_SCREEN, FAKE_DESKTOP_SCREEN, FAKE_DESKTOP_SCREEN
    ]);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("execution.desktop.template: BOTH the subject AND every actor sandbox launch on the template; bundle records it; absent stays byte-stable", async () => {
    // With a custom template: all N+1 creates (subject + N actors) get it.
    const withState = { worldVersion: 0 };
    const withTemplate = baseHooks(withState, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3, "acme-desktop-with-runtimes"), dryRun: false, hooks: withTemplate.hooks });
    expect(result.ok).toBe(true);
    expect(withTemplate.created).toHaveLength(4); // 1 subject + 3 actors
    expect(withTemplate.templates).toHaveLength(4);
    expect(withTemplate.templates.every((t) => t === "acme-desktop-with-runtimes")).toBe(true);
    const withBundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(withBundle.desktopTemplate).toBe("acme-desktop-with-runtimes");

    // Byte-stable default: NO template → every create called with NO template arg, bundle omits it.
    const noState = { worldVersion: 0 };
    const noTemplate = baseHooks(noState, makeRendezvous(3));
    const result2 = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks: noTemplate.hooks });
    expect(result2.ok).toBe(true);
    expect(noTemplate.templates).toHaveLength(4);
    expect(noTemplate.templates.every((t) => t === undefined)).toBe(true);
    const noBundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result2.runId, "run.json"), "utf8"));
    expect(noBundle.desktopTemplate).toBeUndefined();
  });

  it("GOOD run: ONE subject + N actors all torn down BY id (killed==created, N+1), same getHost URL, REAL overlap, state delta, verify ok", async () => {
    const state = { worldVersion: 0 };
    const { hooks, created, killed, sandboxes } = baseHooks(state, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // ONE subject sandbox + 3 actor sandboxes = 4 created; ALL torn down BY exact id (no list).
    expect(created).toHaveLength(4);
    expect(sandboxes).toHaveLength(4);
    expect(created[0]?.metadata?.role).toBe("subject");
    expect(created[0]?.metadata?.topologyMode).toBe("concurrent");
    const createdIds = sandboxes.map((s) => s.sandboxId).sort();
    expect([...killed].sort()).toEqual(createdIds); // killed-set == created-set (N+1)
    expect(result.subjectSandbox).toEqual({ sandboxId: "fake-sandbox-001", killed: true });

    // Subject creds entered ONLY the subject sandbox (FIX-10): actor creates carry no envs.
    expect(created[0]?.envs).toEqual({ DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" });
    for (const createOpts of created.slice(1)) {
      expect(createOpts.envs).toBeUndefined();
    }

    // provisionCloneSubject ran EXACTLY once, on the SUBJECT sandbox only (one git clone written).
    const cloneWrites = sandboxes.flatMap((s) => s.calls).filter(([name, , data]) => name === "files.write" && String(data).includes("git clone"));
    expect(cloneWrites).toHaveLength(1);

    // Every actor ACTUALLY opened the SAME harness-minted getHost URL (FIX-2): one shared plane.
    // (The raw URL appears only in the in-memory fake's recorded calls — never in the bundle.)
    const getHostUrl = `https://3000-fake-sandbox-001.e2b.app`;
    const actorSandboxes = sandboxes.slice(1);
    expect(actorSandboxes).toHaveLength(3);
    for (const actor of actorSandboxes) {
      const opened = browserTargetFromCalls(actor.calls);
      expect(opened, "each actor opens a seat URL").toBeTruthy();
      expect(new URL(opened!).origin).toBe(new URL(getHostUrl).origin);
    }
    // The published bundle records the host as a DIGEST (public-safe), never the raw e2b URL; the
    // raw tokenless URL is surfaced only on the ephemeral result.
    expect(result.host).toBe(getHostUrl);
    const runText = await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8");
    expect(runText).not.toContain("e2b.app");

    const bundle = JSON.parse(runText);
    const livePublicTruth = JSON.stringify({ events: bundle.events, review: bundle.review }).toLowerCase();
    expect(livePublicTruth).toContain("this run reports only its own observed overlap and state changes");
    expect(livePublicTruth).toContain("does not prove scale, repeatability, or adopter-harness replacement");
    expect(livePublicTruth).not.toContain("receipt");
    expect(bundle.simulations.map((sim: { progress: number }) => sim.progress)).toEqual([100, 100, 100]);
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.plane.hostDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.sharedWorld.plane.exposure).toBe("synthetic");
    for (const stream of bundle.streams) {
      expect(stream.desktopGeometry).toEqual({
        screen: {
          requested: FAKE_DESKTOP_SCREEN,
          verified: { ...FAKE_DESKTOP_SCREEN, source: "xdpyinfo" }
        },
        browserWindow: { x: 0, y: 0, ...FAKE_DESKTOP_SCREEN, source: "xdotool" },
        viewport: { ...FAKE_DESKTOP_VIEWPORT, source: "cdp" }
      });
      expect(stream.viewport).toEqual({ ...FAKE_DESKTOP_VIEWPORT, isMobile: false });
    }

    // PROVEN CONCURRENCY (FIX-1): the laneWindows the REAL clock measured overlap (≥2 in flight).
    const windows = bundle.sharedWorld.laneWindows as Array<{ startedAt: number; endedAt: number; routeHostDigest: string; actorType?: string; surface?: string; caseGroup?: string }>;
    expect(windows).toHaveLength(3);
    expect(windows.map((w) => [w.actorType, w.surface, w.caseGroup])).toEqual([
      ["initiator", "intake", "case-001"],
      ["collaborator", "review", "case-001"],
      ["collaborator", "review", "case-001"]
    ]);
    const overlapping = windows.some((a, i) => windows.some((b, j) => i !== j && a.startedAt < b.endedAt && b.startedAt < a.endedAt));
    expect(overlapping).toBe(true);
    expect(result.overlapProven).toBe(true);
    // Every actor drove EXACTLY the harness-minted host (FIX-2): routeHostDigest == plane.hostDigest.
    for (const w of windows) {
      expect(w.routeHostDigest).toBe(bundle.sharedWorld.plane.hostDigest);
    }

    // A stateSeries delta occurred under load (the world changed; FIX-6).
    const series = bundle.sharedWorld.stateSeries as Array<{ timestamp: number; digest: string }>;
    expect(series.length).toBeGreaterThanOrEqual(2);
    expect(series.some((s, i) => i > 0 && s.digest !== series[i - 1]!.digest)).toBe(true);

    // Per-persona outcomes recorded (the "M of N" headline).
    expect(bundle.sharedWorld.outcomes).toHaveLength(3);
    expect((bundle.sharedWorld.outcomes as Array<{ actorType?: string; surface?: string; caseGroup?: string }>).map((o) => [o.actorType, o.surface, o.caseGroup])).toEqual([
      ["initiator", "intake", "case-001"],
      ["collaborator", "review", "case-001"],
      ["collaborator", "review", "case-001"]
    ]);
    expect((bundle.sharedWorld.outcomes as Array<{ ok: boolean }>).every((o) => o.ok)).toBe(true);

    // verifyRun ok on the GOOD concurrent bundle (incl. the concurrency-on-pass gate).
    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);

    const observerData = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "observer", "observer-data.json"), "utf8"));
    expect(observerData.laneGroups).toEqual([
      expect.objectContaining({ roleId: "persona-01", actorType: "initiator", surface: "intake", caseGroup: "case-001", status: "passed" }),
      expect.objectContaining({ roleId: "persona-02", actorType: "collaborator", surface: "review", caseGroup: "case-001", status: "passed" }),
      expect.objectContaining({ roleId: "persona-03", actorType: "collaborator", surface: "review", caseGroup: "case-001", status: "passed" })
    ]);
    expect(observerData.streams.map((stream: { label: string }) => stream.label).join("\n")).toContain("type:initiator / surface:intake / case:case-001");

    // Per-actor traces written.
    const actorsDir = await readdir(path.join(cwd, ".humanish", "runs", result.runId, "actors"));
    expect(actorsDir.sort()).toEqual(["stream-001.json", "stream-002.json", "stream-003.json"]);
  });

  it("comms:email:fake — deploys the catch on the SUBJECT sandbox, injects env there ONLY, drains to run-level evidence", async () => {
    const state = { worldVersion: 0 };
    const commsPort = 8025;
    const verificationHtml = '<p>Confirm.</p><a href="https://app.example.test/verify?token=abc123XYZ-9">Verify</a><p>Code: 481920</p>';
    const capturedNdjson =
      JSON.stringify({ t: 1, path: "/emails", body: JSON.stringify({ from: "no-reply@example.test", to: ["user@example.test"], subject: "Confirm your email", html: verificationHtml }) }) + "\n";
    // The base subject handler + comms overrides (health service-marker + the teardown drain `cat`).
    const baseHandler = makeCommandHandler(state);
    const commandHandler = (command: string): { stdout?: string } | undefined => {
      // Both the loopback capture (commsPort) and the 0.0.0.0 inbox (commsPort+1) listeners are probed on
      // /health; the serve readiness probe hits `/` (no /health), so this only marks the comms listeners.
      if (command.includes("/health")) return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
      if (command.startsWith("cat ") && command.includes("deliveries.ndjson")) return { stdout: capturedNdjson };
      return baseHandler(command);
    };
    const { module, created } = makeFakeModule(commandHandler);
    const hooks: SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key", DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" },
      loadDesktopModule: async () => module,
      runSession: makeRunSession(state, makeRendezvous(3)),
      detachedTimers: { now: () => 0, sleep: async () => {} },
      proberCadenceMs: 100_000
    };
    const config: LabConfig = {
      ...concurrentConfig(3, 3),
      comms: { email: { kind: "fake", injectEnv: "RESEND_API_URL", port: commsPort, recipients: [{ lane: "user", address: "user@example.test" }] } }
    };
    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, hooks });
    expect(result.ok).toBe(true);

    // The catch base-URL env is injected into the SUBJECT sandbox (created[0]) alongside DATABASE_URL —
    // and NOWHERE else: the actor sandboxes still carry no envs (FIX-10 preserved).
    expect(created[0]?.envs?.RESEND_API_URL).toBe(`http://127.0.0.1:${commsPort}`);
    expect(created[0]?.envs?.DATABASE_URL).toBe("opaque-pw-7f3a9c2e-do-not-leak");
    for (let i = 1; i < created.length; i += 1) expect((created[i]?.envs as Record<string, string> | undefined)?.RESEND_API_URL).toBeUndefined();

    // The captured mail was drained at subject teardown + written as a run-level digest-only artifact,
    // registered ONCE on the first stream (a property of the shared app, not any single persona).
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const onStream0 = bundle.streams[0].artifacts.find((a: { path: string; kind: string; label: string }) => a.path === "comms/thread.json");
    expect(onStream0).toMatchObject({ kind: "log", label: "comms thread" });
    expect(bundle.streams[1]?.artifacts.find((a: { path: string }) => a.path === "comms/thread.json")).toBeUndefined();
    const threadRaw = await readFile(path.join(runDir, "comms", "thread.json"), "utf8");
    const thread = JSON.parse(threadRaw) as { schema: string; count: number };
    expect(thread.schema).toBe("humanish.comms-thread.v1");
    expect(thread.count).toBe(1);
    // Public-safety: no raw address / link / OTP / subject text in the persisted evidence.
    expect(threadRaw).not.toContain("user@example.test");
    expect(threadRaw).not.toContain("app.example.test/verify");
    expect(threadRaw).not.toContain("481920");
    expect(threadRaw).not.toContain("Confirm your email");

    // The evidence artifact does not break bundle verification.
    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });

  it("comms:email:fake — getHost-exposes the inbox, renders the live surface on the SUBJECT, and tells the matching persona its inbox URL", async () => {
    const state = { worldVersion: 0 };
    const commsPort = 8025;
    const verificationHtml = '<p>Confirm.</p><a href="http://127.0.0.1:3000/verify?token=abc123XYZ-9">Verify</a><p>Code: 481920</p>';
    const capturedNdjson =
      JSON.stringify({ t: 1, path: "/emails", body: JSON.stringify({ from: "no-reply@example.test", to: ["user@example.test"], subject: "Confirm your email", html: verificationHtml }) }) + "\n";
    const baseHandler = makeCommandHandler(state);
    const commandHandler = (command: string): { stdout?: string } | undefined => {
      if (command.includes("/health")) return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
      if (command.startsWith("cat ") && command.includes("deliveries.ndjson")) return { stdout: capturedNdjson };
      return baseHandler(command);
    };
    const { module, sandboxes } = makeFakeModule(commandHandler);
    // Capture the instructions each persona actually received.
    const seenInstructions: string[] = [];
    const baseRun = makeRunSession(state, makeRendezvous(3));
    const hooks: SharedWorldLabHooks = {
      env: { OPENAI_API_KEY: "k", E2B_API_KEY: "k", DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" },
      loadDesktopModule: async () => module,
      runSession: async (options) => { seenInstructions.push(options.instructions); return baseRun(options); },
      detachedTimers: { now: () => 0, sleep: async () => {} },
      proberCadenceMs: 100_000
    };
    const config: LabConfig = {
      ...concurrentConfig(3, 3),
      // Recipient lane matches the FIRST persona's lane id, so only it is told to check the inbox.
      comms: { email: { kind: "fake", injectEnv: "RESEND_API_URL", port: commsPort, recipients: [{ lane: "persona-01", address: "user@example.test" }] } }
    };
    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, hooks });
    expect(result.ok).toBe(true);

    // The read-only inbox listener was getHost-exposed on commsPort+1; the matching persona was told THAT
    // URL (a getHost host, reachable from its own — different — sandbox), not the loopback capture URL.
    const inboxHost = `https://${commsPort + 1}-${sandboxes[0]!.sandboxId}.e2b.app/inbox`;
    expect(seenInstructions.some((text) => text.includes(inboxHost))).toBe(true);
    // The full handoff (#351) rides the same injection on this route too: address + wait steering.
    expect(seenInstructions.some((text) => text.includes("Your email address is user@example.test"))).toBe(true);
    expect(seenInstructions.some((text) => text.includes("do not end your session while waiting"))).toBe(true);
    expect(seenInstructions.some((text) => text.includes(`127.0.0.1:${commsPort}`))).toBe(false); // never the capture URL

    // The live inbox surface was rendered into the SUBJECT sandbox (created first) during the run.
    expect(sandboxes[0]!.calls.some(([name, p]) => name === "files.write" && typeof p === "string" && p.endsWith("/surface/inbox/index"))).toBe(true);
  });

  it("onPhase (injected DI seam, #263): the ONE shared-plane provision reports clone started/completed, then ready completed ok true, in order, off real stderr", async () => {
    const state = { worldVersion: 0 };
    const { hooks, phaseEvents } = baseHooks(state, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

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

  it("publishes an attached live Observer while concurrent actors are still running", async () => {
    const state = { worldVersion: 0 };
    const { hooks, sandboxes } = baseHooks(state, async () => {});
    const runId = "concurrent-shared-world-live-observer";
    const runRoot = path.join(cwd, ".humanish", "runs", runId);
    let actorSessionsStarted = 0;
    let resolveActorsStarted: () => void = () => {};
    const actorsStarted = new Promise<void>((resolve) => { resolveActorsStarted = resolve; });
    let releaseActors: () => void = () => {};
    const actorsReleased = new Promise<void>((resolve) => { releaseActors = resolve; });
    let readyObserver: (ObserverResult & { ok: true }) | undefined;
    let observerServer: ObserverServer | undefined;

    hooks.runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      actorSessionsStarted += 1;
      if (actorSessionsStarted >= 3) {
        resolveActorsStarted();
      }
      await actorsReleased;
      state.worldVersion += 1;
      const trace = makeTrace({ persona: options.persona, status: "passed", completionReason: "goal_satisfied", actions: 1, messages: 1 });
      return { status: "passed", completionReason: "goal_satisfied", reason: trace.reason, trace };
    };

    const runPromise = runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      hooks,
      onObserverReady: async (observer) => {
        readyObserver = observer;
        observerServer = await serveObserver(observer, { port: 0 });
      },
      runId
    });

    try {
      await waitForCondition("observer server", () => observerServer !== undefined);
      await actorsStarted;
      await waitForCondition("all actor sessions started", () => actorSessionsStarted === 3);
      const streamStarts = sandboxes.flatMap((sandbox) =>
        sandbox.calls.filter(([name]) => name === "stream.start")
      );
      expect(streamStarts).toHaveLength(3);
      expect(streamStarts.every(([, options]) => (options as { windowId?: string }).windowId === "424242")).toBe(true);

      const persistedRunText = await readFile(path.join(runRoot, "run.json"), "utf8");
      expect(persistedRunText).not.toContain("fake-auth-key");
      expect(persistedRunText).not.toContain("stream.invalid");

      const persistedObserverDataText = await readFile(path.join(runRoot, "observer", "observer-data.json"), "utf8");
      expect(persistedObserverDataText).not.toContain("fake-auth-key");
      expect(persistedObserverDataText).not.toContain("stream.invalid");
      const persistedObserverData = JSON.parse(persistedObserverDataText) as {
        events: Array<{ type: string }>;
        streams: Array<{ status: string }>;
        summary: { active: number };
      };
      expect(persistedObserverData.summary.active).toBe(3);
      expect(persistedObserverData.streams.map((stream) => stream.status)).toEqual(["running", "running", "running"]);
      expect(persistedObserverData.events.filter((event) => event.type === "actor.running")).toHaveLength(3);

      expect(readyObserver).toBeTruthy();
      expect(observerServer).toBeTruthy();
      const served = await fetch(new URL("observer-data.json", observerServer!.url));
      const servedObserverData = await served.json() as {
        streams: Array<{ embed?: { kind: string; url?: string }; transport: string; url?: string }>;
      };
      expect(servedObserverData.streams).toHaveLength(3);
      expect(servedObserverData.streams.every((stream) => stream.transport === "sse")).toBe(true);
      expect(servedObserverData.streams.every((stream) => stream.embed?.kind === "iframe")).toBe(true);
      expect(servedObserverData.streams.every((stream) => stream.url === "https://stream.invalid/fake-auth-key")).toBe(true);

      releaseActors();
      const result = await runPromise;
      expect(result.ok).toBe(true);

      const finalObserverData = JSON.parse(await readFile(path.join(runRoot, "observer", "observer-data.json"), "utf8")) as {
        summary: { active: number };
        streams: Array<{ status: string }>;
      };
      expect(finalObserverData.summary.active).toBe(0);
      expect(finalObserverData.streams.map((stream) => stream.status)).toEqual(["passed", "passed", "passed"]);
      const finalRunText = await readFile(path.join(runRoot, "run.json"), "utf8");
      expect(finalRunText).not.toContain("fake-auth-key");
      expect(finalRunText).not.toContain("stream.invalid");
    } finally {
      releaseActors();
      await observerServer?.close();
      await runPromise.catch(() => undefined);
    }
  });

  it("threads actor-default and lane-level stopWhen guards into concurrent shared-world actors", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3));
    const config = concurrentConfig(3, 3);
    const actorDefault = { any: [{ id: "actor-done", textIncludes: "Saved" }] };
    const laneOverride = { any: [{ id: "second-done", urlIncludes: "/done" }] };
    config.actors[0]!.stopWhen = actorDefault;
    config.actors[0]!.lanes![1]!.stopWhen = laneOverride;

    // Keyed by lane persona, not call order — concurrent completion order is not a contract.
    const seen = new Map<string, CuaActorSessionOptions["stopWhen"]>();
    const runSession = hooks.runSession!;
    hooks.runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      seen.set(options.persona.id, options.stopWhen);
      return runSession(options);
    };

    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(seen.size).toBe(3);
    expect(seen.get("persona-1")).toEqual(actorDefault);
    expect(seen.get("persona-2")).toEqual(laneOverride);
    expect(seen.get("persona-3")).toEqual(actorDefault);
  });

  it("threads actor-default and lane-level dwell windows into concurrent shared-world actors (#510)", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3));
    const config = concurrentConfig(3, 3);
    const actorDefault = { when: { any: [{ id: "in-room", urlIncludes: "/room/" }] }, ms: 30_000, everyMs: 10_000, then: "continue" as const };
    const laneOverride = { ms: 5_000, everyMs: 1_000, then: "stop" as const };
    config.actors[0]!.dwell = actorDefault;
    config.actors[0]!.lanes![1]!.dwell = laneOverride;

    const seen = new Map<string, CuaActorSessionOptions["dwell"]>();
    const runSession = hooks.runSession!;
    hooks.runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      seen.set(options.persona.id, options.dwell);
      return runSession(options);
    };

    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(seen.size).toBe(3);
    expect(seen.get("persona-1")).toEqual(actorDefault);
    expect(seen.get("persona-2")).toEqual(laneOverride);
    expect(seen.get("persona-3")).toEqual(actorDefault);
  });

  it("adapter fail score turns a coherent concurrent shared-world run red while keeping evidence verifiable", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3));
    hooks.score = concurrentFailScore;
    hooks.deriveArtifacts = async (ctx) => {
      await mkdir(path.join(ctx.runDir, "adapter"), { recursive: true });
      await writeFile(
        path.join(ctx.runDir, "adapter", "concurrent-readback.json"),
        `${JSON.stringify({
          schema: "example.concurrent-readback.v1",
          status: "review-required",
          backend: ctx.backend,
          laneCount: ctx.laneCount
        }, null, 2)}\n`,
        "utf8"
      );
      return [{
        schema: "humanish.adapter-artifact.v1",
        namespace: CONCURRENT_ADAPTER_NAMESPACE,
        label: "Concurrent adapter readback",
        path: "adapter/concurrent-readback.json",
        kind: "state",
        note: "Adapter-owned concurrent shared-world readback."
      }];
    };
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Adapter scorer failed the run");
    expect(result.overlapProven).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore?.namespace).toBe(CONCURRENT_ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.adapterScore?.data?.backend).toBe("concurrent-shared-world");
    expect(bundle.adapterArtifacts?.[0]?.path).toBe("adapter/concurrent-readback.json");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("Adapter scorer failed the run"))).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("fails review when a lane returns a terminal failed actor trace", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3), (index) => (
      index === 1 ? { status: "failed", completionReason: "actor_error" } : undefined
    ));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("2/3 actor(s) reached a terminal, engaged passed session");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("2/3 actor session(s) passed credibility checks");
    expect(bundle.review.summary).toContain("mission endpoint: 2/3 ended goal_satisfied");
    expect(bundle.review.summary).toContain("completion reasons: actor_error 1/3, goal_satisfied 2/3");
    expect(bundle.review.summary).not.toContain("reached their goal");
    expect(bundle.review.gaps.some((gap) => gap.includes("persona-02"))).toBe(true);
    expect(bundle.sharedWorld?.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roleId: "persona-02", status: "failed", completionReason: "actor_error", ok: false })
      ])
    );
  });

  it("fails review when a lane self-reports a blocker while claiming goal_satisfied", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3), (index) => (
      index === 0
        ? {
            status: "passed",
            completionReason: "goal_satisfied",
            reason: "I cannot complete the approval because the app shows an error: APP_USER_ID is not set."
          }
        : undefined
    ));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.roles[0]?.ok).toBe(false);
    expect(result.roles[0]?.error?.message).toContain("not a credible pass");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("APP_USER_ID is not set"))).toBe(true);
    expect(bundle.events.some((event) =>
      event.level === "warn" && event.message.includes("NOT counted as a pass")
    )).toBe(true);
  });

  it("routes through runLab(sharedWorldHooks) to the concurrent backend", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3));
    const config = concurrentConfig(3, 3);
    expect(selectLabBackend(config)).toBe("concurrent-shared-world");
    const outcome = await runLab(config, { cwd, dryRun: false, sharedWorldHooks: hooks });
    expect(outcome.backend).toBe("concurrent-shared-world");
    if (outcome.backend !== "concurrent-shared-world") return;
    expect(outcome.result.ok).toBe(true);
  });

  it("INDEPENDENT actors (FIX-11): one actor's harness error does NOT block the swarm or suppress overlap", async () => {
    const state = { worldVersion: 0 };
    // Actor index 1 throws AFTER entering the rendezvous (so all 3 windows still overlap).
    const { hooks } = baseHooks(state, makeRendezvous(3), (index) => (index === 1 ? { throwMessage: "boom in actor 1" } : undefined));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });

    // The swarm did not run fully coherently → ok false, but the other actors STILL ran (no gate).
    expect(result.ok).toBe(false);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    // All 3 windows + outcomes intact (no pipeline-gate / fail-fast corrupting the "M of N").
    expect(bundle.sharedWorld.laneWindows).toHaveLength(3);
    expect(bundle.sharedWorld.outcomes).toHaveLength(3);
    const windows = bundle.sharedWorld.laneWindows as Array<{ startedAt: number; endedAt: number }>;
    expect(windows.some((a, i) => windows.some((b, j) => i !== j && a.startedAt < b.endedAt && b.startedAt < a.endedAt))).toBe(true);
    // 2 of 3 sessions passed the credibility checks; the failed one is recorded as data, not a
    // swarm-blocker. Mission and convergence claims remain separate in the review summary (#364).
    const okCount = (bundle.sharedWorld.outcomes as Array<{ ok: boolean }>).filter((o) => o.ok).length;
    expect(okCount).toBe(2);
  });

  it("literal-scrubs a provisioned value injected into a forced error before persist", async () => {
    const state = { worldVersion: 0 };
    const secret = "opaque-pw-7f3a9c2e-do-not-leak";
    const { hooks } = baseHooks(state, makeRendezvous(3), (index) => (index === 0 ? { throwMessage: `connection failed using ${secret}` } : undefined));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });
    expect(result.ok).toBe(false);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(cwd, ".humanish", "runs", result.runId, file), "utf8");
      expect(text, file).not.toContain(secret);
    }
  });
});

// The same concurrent shared-world composition, but driven from the operator's own packed working
// tree (subject.source: local-tree) instead of a clone - the follow-up to the local-tree keystone
// that wires provisionLocalTreeSubject into the ONE subject sandbox (issue #261 follow-up). The N
// actor desktops still drive the getHost URL exactly as today - only the subject's provisioning +
// provenance source changes.
describe("runConcurrentSharedWorld (local-tree route: subject.source: local-tree)", () => {
  // 64-hex archiveSha256 and a 40-hex commit: shape-valid fixtures, not real digests.
  const FIXED_ARCHIVE: LocalTreeArchive = {
    archivePath: "/unused-in-fake/source.tar.gz",
    archiveSha256: "ef".repeat(32),
    fileCount: 5,
    totalBytes: 99,
    git: { commit: "12".repeat(20), dirty: false }
  };
  const FAKE_ARCHIVE_BYTES = new TextEncoder().encode("fake-packed-archive-bytes").buffer;

  function localTreeConcurrentConfig(roleCount = 3, concurrency = 3): LabConfig {
    const lanes = Array.from({ length: roleCount }, (_unused, i) => ({
      id: `persona-${String(i + 1).padStart(2, "0")}`,
      persona: `persona-${i + 1}`,
      entry: `/seat-${i + 1}`
    }));
    const parsed = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "concurrent-shared-world-local-tree-proof",
      title: "Concurrent shared-world local-tree proof",
      subject: {
        source: "local-tree",
        topology: "shared-world",
        exposure: "synthetic",
        env: ["DATABASE_URL"],
        serve: { install: "pnpm install", start: "pnpm start -H 0.0.0.0", url: "http://127.0.0.1:3000/" },
        state: {
          seed: [{ name: "migrate", command: "pnpm db:migrate" }],
          checkpoint: [
            { name: "notes-count", command: "psql query notes" },
            { name: "reviews-count", command: "psql query reviews" }
          ]
        }
      },
      actors: [{ type: "openai-computer-use", mission: "Use the shared app.", lanes }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency },
      scenario: { mode: "live" }
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  it("dry-run: subject.source local-tree, no archiveSha256, verified concurrent contract bundle", async () => {
    const result = await runConcurrentSharedWorld({ cwd, config: localTreeConcurrentConfig(), dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.subjectSandbox).toBeUndefined();
    expect(result.subject?.source).toBe("local-tree");
    expect(result.subject && "archiveSha256" in result.subject).toBe(false);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });

  it("GOOD run: packs ONCE, uploads to the SUBJECT sandbox only, extracts, provisions via provisionLocalTreeSubject; provenance carries archiveSha256 + commit + dirty; N actors unaffected; verify ok", async () => {
    const state = { worldVersion: 0 };
    const { hooks, created, killed, sandboxes } = baseHooks(state, makeRendezvous(3));
    const packCalls: Array<{ root: string }> = [];
    hooks.packLocalTree = async (args) => {
      packCalls.push(args);
      return { archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES };
    };
    const result = await runConcurrentSharedWorld({ cwd, config: localTreeConcurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // Packed exactly ONCE, before ANY (subject or actor) sandbox is created.
    expect(packCalls).toHaveLength(1);
    expect(packCalls[0]?.root).toBe(cwd);

    // ONE subject sandbox + 3 actor sandboxes = 4 created; ALL torn down BY exact id.
    expect(created).toHaveLength(4);
    const createdIds = sandboxes.map((s) => s.sandboxId).sort();
    expect([...killed].sort()).toEqual(createdIds);

    // The archive uploaded ONLY to the subject sandbox (sandboxes[0]), never any actor sandbox.
    const subjectUploads = sandboxes[0]!.calls.filter(
      (call): call is [string, string, ArrayBuffer] => call[0] === "files.write" && call[1] === "/home/user/.humanish-source.tar.gz"
    );
    expect(subjectUploads).toHaveLength(1);
    expect(subjectUploads[0]?.[2]).toBe(FAKE_ARCHIVE_BYTES);
    for (const actorSandbox of sandboxes.slice(1)) {
      const actorUploads = actorSandbox.calls.filter((call) => call[0] === "files.write" && call[1] === "/home/user/.humanish-source.tar.gz");
      expect(actorUploads).toHaveLength(0);
    }

    // The local-tree route never runs git: no clone script written on any sandbox.
    const cloneWrites = sandboxes.flatMap((s) => s.calls).filter(([name, , data]) => name === "files.write" && String(data).includes("git clone"));
    expect(cloneWrites).toHaveLength(0);

    // Provenance: source local-tree + archiveSha256 (the pin - ONE archive, no per-lane unanimity
    // math needed) + commit/dirty from the host-packed archive; no repo/publicRepo for local-tree.
    const expectedSubject = {
      source: "local-tree",
      archiveSha256: FIXED_ARCHIVE.archiveSha256,
      commit: FIXED_ARCHIVE.git!.commit,
      dirty: false,
      envNames: ["DATABASE_URL"],
      state: { provenance: "seeded", seed: [{ name: "migrate", when: "before-start", commandDigest: expect.any(String), ok: true, exitCode: 0, durationMs: expect.any(Number) }] }
    };
    expect(result.subject).toEqual(expectedSubject);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.subject).toEqual(expectedSubject);
    expect(bundle.sharedWorld.plane.commit).toBe(FIXED_ARCHIVE.git!.commit);
    // The concurrency-on-pass gate still holds on the local-tree route (real overlap + a state delta).
    expect(result.overlapProven).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("onPhase: the ONE subject sandbox's provision reports upload/extract (never clone), then install/ready, in order", async () => {
    const state = { worldVersion: 0 };
    const { hooks, phaseEvents } = baseHooks(state, makeRendezvous(3));
    hooks.packLocalTree = async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES });
    const result = await runConcurrentSharedWorld({ cwd, config: localTreeConcurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    const uploadStarted = phaseEvents.findIndex((e) => e.type === "cua-lab.subject.upload.started");
    const extractCompleted = phaseEvents.findIndex((e) => e.type === "cua-lab.subject.extract.completed");
    const readyCompleted = phaseEvents.findIndex((e) => e.type === "cua-lab.subject.ready.completed");
    expect(uploadStarted).toBeGreaterThanOrEqual(0);
    expect(extractCompleted).toBeGreaterThan(uploadStarted);
    expect(readyCompleted).toBeGreaterThan(extractCompleted);
    expect(phaseEvents.some((e) => e.type.includes(".clone."))).toBe(false);
  });

  it("packing failure (hook throws) fails the run closed BEFORE any sandbox (subject or actor) is created", async () => {
    const state = { worldVersion: 0 };
    const { hooks, created } = baseHooks(state, makeRendezvous(3));
    hooks.packLocalTree = async () => {
      throw new Error("Local tree root produced zero packable entries after the always-on denylist.");
    };
    const result = await runConcurrentSharedWorld({ cwd, config: localTreeConcurrentConfig(3, 3), dryRun: false, hooks });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_FAILED");
    expect(result.error?.message).toContain("zero packable entries");
    expect(created).toHaveLength(0);
  });

  it("engine re-enforcement (library API surface, bypassing the parser): a local-tree config missing subject.serve fails closed", async () => {
    const valid = localTreeConcurrentConfig();
    const subjectWithoutServe: Record<string, unknown> = { ...valid.subject };
    delete subjectWithoutServe.serve;
    const broken = { ...valid, subject: subjectWithoutServe } as unknown as LabConfig;
    const result = await runConcurrentSharedWorld({ cwd, config: broken, dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID");
    expect(result.error?.message).toContain("subject.serve");
  });

  it("engine re-enforcement rejects path-shaped role ids before loading a desktop", async () => {
    const valid = concurrentConfig(3, 3);
    const actor = valid.actors[0]!;
    const lanes = actor.lanes!.map((lane, index) => index === 0 ? { ...lane, id: "..\\escape" } : lane);
    const broken: LabConfig = { ...valid, actors: [{ ...actor, lanes }] };
    let desktopLoads = 0;
    const result = await runConcurrentSharedWorld({
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
    expect(result.error?.code).toBe("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID");
    expect(result.runId).toBe("not-created");
    expect(desktopLoads).toBe(0);
  });

  it("engine re-enforcement: a local-tree config declaring subject.localTree.keep on the concurrent route fails closed (would orphan the N actor sandboxes)", async () => {
    const valid = localTreeConcurrentConfig();
    const broken: LabConfig = { ...valid, subject: { ...valid.subject, localTree: { keep: true } } };
    const result = await runConcurrentSharedWorld({ cwd, config: broken, dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID");
    expect(result.error?.message).toContain("subject.localTree.keep");
  });

  it("engine re-enforcement: a local-tree config with a non-e2b-desktop execution.target fails closed", async () => {
    const valid = localTreeConcurrentConfig();
    const broken = { ...valid, execution: { ...valid.execution, target: "local" } } as unknown as LabConfig;
    const result = await runConcurrentSharedWorld({ cwd, config: broken, dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_CONCURRENT_SHARED_WORLD_LAB_INVALID");
  });

  it("routes through runLab(sharedWorldHooks) to the concurrent-shared-world backend", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3));
    hooks.packLocalTree = async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES });
    const config = localTreeConcurrentConfig(3, 3);
    expect(selectLabBackend(config)).toBe("concurrent-shared-world");
    const outcome = await runLab(config, { cwd, dryRun: false, sharedWorldHooks: hooks });
    expect(outcome.backend).toBe("concurrent-shared-world");
    if (outcome.backend !== "concurrent-shared-world") return;
    expect(outcome.result.ok).toBe(true);
  });
});

describe("verifyRun fails closed on each injected concurrent overclaim", () => {
  async function goodBundlePath(): Promise<{ runId: string; bundlePath: string }> {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(3, 3), dryRun: false, hooks });
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
    return (await verifyRun(cwd, runId)).ok;
  }

  it("(a) a 'concurrent' bundle whose laneWindows do NOT overlap", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { laneWindows: Array<{ startedAt: number; endedAt: number }> };
      sw.laneWindows.forEach((w, i) => { w.startedAt = i * 1000; w.endedAt = i * 1000 + 10; }); // sequential, no overlap
    });
    expect(ok).toBe(false);
  });

  it("(b) missing best-effort-causal-attribution", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { attributionLimits: string[] };
      sw.attributionLimits = sw.attributionLimits.filter((l) => l !== "best-effort-causal-attribution");
    });
    expect(ok).toBe(false);
  });

  it("(b2) a FORBIDDEN limit present (sequential-only)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { attributionLimits: string[] };
      sw.attributionLimits = [...sw.attributionLimits, "sequential-only"];
    });
    expect(ok).toBe(false);
  });

  it("(c) a value-shaped stateSeries field (allowed-keys tripwire)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { stateSeries: Array<Record<string, unknown>> };
      sw.stateSeries[0]!.rawCount = "42"; // a non-allowed field; the series is digest-only
    });
    expect(ok).toBe(false);
  });

  it("(d) divergent plane provenance across laneWindows", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { laneWindows: Array<Record<string, unknown>> };
      sw.laneWindows[0]!.commit = "deadbeefdeadbeef0000";
    });
    expect(ok).toBe(false);
  });

  it("(e) a PASSED run with no stateSeries delta", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { stateSeries: Array<{ digest: string }> };
      const d = sw.stateSeries[0]!.digest;
      for (const s of sw.stateSeries) s.digest = d; // flatten → no delta
    });
    expect(ok).toBe(false);
  });

  it("(f) a persona with goal_satisfied + zero engagement", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const streams = bundle.streams as Array<{ actor?: { completionReason?: string; counts?: Record<string, number>; items?: unknown[] } }>;
      const stream = streams.find((s) => s.actor)!;
      stream.actor!.completionReason = "goal_satisfied";
      stream.actor!.counts = { actions: 0, messages: 0, screenshots: 0 };
      stream.actor!.items = [];
    });
    expect(ok).toBe(false);
  });

  it("(g) the topologyMode discriminator is enforced (sequential timeline smuggled onto a concurrent bundle)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as Record<string, unknown>;
      sw.timeline = [{ kind: "checkpoint", name: "cp-baseline", digest: "abc123def4567890", deltaFromPrev: false }];
    });
    expect(ok).toBe(false);
  });

  it("(h) an actor that drove a host OTHER than the harness-minted plane (FIX-2 / invariant 2)", async () => {
    const ok = await mutateAndVerify((bundle) => {
      const sw = bundle.sharedWorld as { laneWindows: Array<{ routeHostDigest: string }> };
      sw.laneWindows[0]!.routeHostDigest = "ffffffffffffffff"; // a different host than plane.hostDigest
    });
    expect(ok).toBe(false);
  });
});

// --- The committed live-fixture lab: deterministic $0 wiring proof (#164) ----------------------
// Proves the live rung's lab + synthetic fixture are wired correctly BEFORE any spend: the
// committed humanish/labs/shared-world-concurrent-live.yaml parses, routes to the concurrent
// backend, passes the synthetic/seeded/0.0.0.0 validations, dry-runs to a verified bundle, AND
// drives the REAL orchestrator on the fake N+1 substrate at $0.
describe("concurrent physical geometry guard", () => {
  it("starts no participant on clipped seats and reclaims the host plus every actor desktop", async () => {
    const state = { worldVersion: 0 };
    const { hooks } = baseHooks(state, async () => undefined);
    const handler = makeCommandHandler(state);
    const { module, sandboxes, killed } = makeFakeModule((command) => command.includes("getwindowgeometry")
      ? { stdout: "X=0\nY=32\nWIDTH=1440\nHEIGHT=950\n" }
      : handler(command), false);
    let participantSessions = 0;
    hooks.loadDesktopModule = async () => module;
    hooks.runSession = async () => { participantSessions++; throw new Error("participant must not start"); };
    const result = await runConcurrentSharedWorld({ cwd, config: concurrentConfig(2, 2), dryRun: false, hooks });
    expect(result.ok).toBe(false);
    expect(participantSessions).toBe(0);
    expect(sandboxes).toHaveLength(3);
    expect(killed.sort()).toEqual(sandboxes.map((sandbox) => sandbox.sandboxId).sort());
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    for (const stream of bundle.streams) {
      expect(stream.desktopGeometry.warnings.join(" ")).toContain("outside the captured");
    }
  });
});

describe("committed live-fixture lab (deterministic $0 wiring proof)", () => {
  function loadLiveLab(): LabConfig {
    const raw = parse(readFileSync(path.join(process.cwd(), "humanish/labs/shared-world-concurrent-live.yaml"), "utf8"));
    const parsed = parseLabConfig(raw);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  it("is well-formed: parses, routes to concurrent, and passes the synthetic/seeded/0.0.0.0 validations", () => {
    const config = loadLiveLab();
    expect(routesToConcurrentSharedWorld(config)).toBe(true);
    expect(selectLabBackend(config)).toBe("concurrent-shared-world");
    expect(concurrentSharedWorldValidationReason(config)).toBeNull();
    expect(config.subject.exposure).toBe("synthetic");
    expect(config.subject.serve?.start).toContain("0.0.0.0");
    expect(config.subject.serve?.start).toContain("humanish/fixtures/shared-world-app/server.py");
    expect(config.subject.repos).toEqual(["danielgwilson/humanish"]);
    expect((config.subject.state?.seed ?? []).length).toBeGreaterThan(0);
    expect((config.subject.state?.checkpoint ?? []).length).toBeGreaterThan(0);
    expect(config.actors[0]?.lanes).toHaveLength(3);
    expect(config.actors[0]?.lanes?.map((lane) => [lane.actorType, lane.surface, lane.caseGroup])).toEqual([
      ["planner", "task-board", "board-001"],
      ["coordinator", "task-board", "board-001"],
      ["contributor", "task-board", "board-001"]
    ]);
    expect(config.execution?.concurrency).toBe(3);
  });

  it("dry-runs this exact committed config to a verified concurrent shared-world bundle at $0", async () => {
    const outcome = await runLab(loadLiveLab(), { cwd, dryRun: true });
    expect(outcome.backend).toBe("concurrent-shared-world");
    if (outcome.backend !== "concurrent-shared-world") return;
    expect(outcome.result.ok).toBe(true);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.attributionClass).toBe("shared-world");
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.laneWindows.map((lane: { actorType?: string; surface?: string; caseGroup?: string }) => [lane.actorType, lane.surface, lane.caseGroup])).toEqual([
      ["planner", "task-board", "board-001"],
      ["coordinator", "task-board", "board-001"],
      ["contributor", "task-board", "board-001"]
    ]);
    const observerData = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "observer", "observer-data.json"), "utf8"));
    expect(observerData.laneGroups.map((lane: { actorType?: string; surface?: string; caseGroup?: string }) => [lane.actorType, lane.surface, lane.caseGroup])).toEqual([
      ["planner", "task-board", "board-001"],
      ["coordinator", "task-board", "board-001"],
      ["contributor", "task-board", "board-001"]
    ]);
    const verify = await verifyRun(cwd, outcome.result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("drives this exact committed config through the REAL orchestrator on a fake N+1 substrate ($0): one plane, real overlap, a state delta, verify ok", async () => {
    const state = { worldVersion: 0 };
    const { hooks, created, killed, sandboxes } = baseHooks(state, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config: loadLiveLab(), dryRun: false, hooks });

    expect(result.ok).toBe(true);
    // ONE subject sandbox + 3 actor sandboxes, ALL torn down BY id (N+1).
    expect(created).toHaveLength(4);
    expect([...killed].sort()).toEqual(sandboxes.map((s) => s.sandboxId).sort());
    expect(result.subjectSandbox?.killed).toBe(true);
    expect(result.overlapProven).toBe(true);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.outcomes).toHaveLength(3);
    const series = bundle.sharedWorld.stateSeries as Array<{ digest: string }>;
    expect(series.some((s, i) => i > 0 && s.digest !== series[i - 1]!.digest)).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });
});

describe("lobby-code handoff relays (CDP-independent: narration + vision-off-frame)", () => {
  it("extractLobbyCodeFromNarration reads a /lobby/CODE or a labeled UPPERCASE code, never lowercase prose", () => {
    expect(extractLobbyCodeFromNarration("I'm in! The link is https://lobby-trivia.example.test/en/lobby/UDYCPH now.")).toBe("UDYCPH");
    expect(extractLobbyCodeFromNarration("lobby code: MHDTP2")).toBe("MHDTP2");
    expect(extractLobbyCodeFromNarration("LOBBY_CODE=AB8K9Q done")).toBe("AB8K9Q");
    // A wrong latch fails the whole run: ordinary lowercase words after "lobby code" must NOT latch,
    // even though the label match is case-insensitive (regression: the /i flag used to grab them).
    expect(extractLobbyCodeFromNarration("I clicked the lobby code screen to check")).toBeUndefined();
    expect(extractLobbyCodeFromNarration("the lobby code button was there")).toBeUndefined();
    expect(extractLobbyCodeFromNarration("no code here")).toBeUndefined();
    expect(extractLobbyCodeFromNarration(undefined)).toBeUndefined();
  });

  it("parseLobbyCodeReply is PRECISION-FIRST: only a bare code or an echoed /lobby/CODE, never prose", () => {
    expect(parseLobbyCodeReply("UDYCPH")).toBe("UDYCPH");
    expect(parseLobbyCodeReply("  mhdtp2 ")).toBe("MHDTP2");
    expect(parseLobbyCodeReply("/lobby/QW3RTY")).toBe("QW3RTY");
    expect(parseLobbyCodeReply("https://lobby-trivia.example.test/en/lobby/QW3RTY?x=1")).toBe("QW3RTY");
    // A wrong latch fails the whole run, so these must NOT match — a miss just retries next frame.
    expect(parseLobbyCodeReply("The code is ABC234")).toBeUndefined();
    expect(parseLobbyCodeReply("I see a home SCREEN")).toBeUndefined();
    expect(parseLobbyCodeReply("NONE")).toBeUndefined();
    expect(parseLobbyCodeReply("No lobby code visible: NONE")).toBeUndefined();
    expect(parseLobbyCodeReply("")).toBeUndefined();
    expect(parseLobbyCodeReply(undefined)).toBeUndefined();
  });

  it("extractResponsesOutputText handles the output_text convenience field and the output[] array", () => {
    expect(extractResponsesOutputText({ output_text: "AB8K9Q" })).toBe("AB8K9Q");
    expect(
      extractResponsesOutputText({ output: [{ type: "message", content: [{ type: "output_text", text: "ZZ4T5U" }] }] })
    ).toBe("ZZ4T5U");
    expect(extractResponsesOutputText({})).toBeUndefined();
    expect(extractResponsesOutputText(null)).toBeUndefined();
  });

  it("readLobbyCodeFromFrame POSTs the frame and returns the parsed code; fail-soft on non-ok / bad key", async () => {
    const frame = Buffer.from("fake-png-bytes");
    const calls: Array<{ url: string; body: string; signal: unknown }> = [];
    const okFetch = (async (url: string, init: { body: string; signal: unknown }) => {
      calls.push({ url, body: init.body, signal: init.signal });
      return { ok: true, status: 200, json: async () => ({ output_text: "QW3RTY" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const code = await readLobbyCodeFromFrame(frame, "sk-test", { fetchFn: okFetch });
    expect(code).toBe("QW3RTY");
    expect(calls).toHaveLength(1);
    // The frame is sent as a base64 data URL (same shape the CU provider already uses); key never in body.
    expect(calls[0]!.body).toContain("data:image/png;base64,");
    expect(calls[0]!.body).not.toContain("sk-test");
    // A timeout signal is always attached even when the caller passes none, so a stalled request cannot
    // wedge the caller's in-flight guard.
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);

    const notOk = (async () => ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;
    expect(await readLobbyCodeFromFrame(frame, "sk-test", { fetchFn: notOk })).toBeUndefined();

    const threw = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await readLobbyCodeFromFrame(frame, "sk-test", { fetchFn: threw })).toBeUndefined();

    // No key / empty frame => no network call at all.
    let called = false;
    const spy = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await readLobbyCodeFromFrame(frame, "", { fetchFn: spy })).toBeUndefined();
    expect(await readLobbyCodeFromFrame(Buffer.alloc(0), "sk-test", { fetchFn: spy })).toBeUndefined();
    expect(called).toBe(false);
  });
});
