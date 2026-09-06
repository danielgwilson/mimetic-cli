import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import type { ActorCapabilities, ActorPersonaRef } from "../src/actor-contract.js";
import {
  describeCuaAction,
  runComputerUseLoop,
  stableProgressKey,
  type CuaAction,
  type CuaExecutor,
  type CuaObservation,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest,
  declaredOutcomeFromClosingLine
} from "../src/computer-use.js";
import { defaultRedactionHooks } from "../src/redaction.js";

const FAKE_CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open"
};

const persona: ActorPersonaRef = {
  id: "dana",
  traitsApplied: ["friction-tolerance:low"],
  promptDigest: "abc123def456"
};

function frame(): Buffer {
  const png = new PNG({ width: 200, height: 150 });
  for (let i = 0; i < 200 * 150; i += 1) {
    const o = i * 4;
    const v = i % 2 === 0 ? 0 : 255;
    png.data[o] = v;
    png.data[o + 1] = v;
    png.data[o + 2] = v;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

class ScriptedProvider implements CuaProvider {
  readonly id = "fake-cua";
  readonly version = "fake-1";
  readonly capabilities = FAKE_CAPS;
  readonly seen: CuaTurnRequest[] = [];
  private i = 0;
  constructor(private readonly turns: CuaTurn[]) {}
  async nextTurn(req: CuaTurnRequest): Promise<CuaTurn> {
    this.seen.push(req);
    const turn = this.turns[this.i];
    this.i += 1;
    return turn ?? { actions: [], pendingSafetyChecks: [], done: true, message: "done (exhausted)" };
  }
}

class RepeatProvider implements CuaProvider {
  readonly id = "fake-cua";
  readonly version = "fake-1";
  readonly capabilities = FAKE_CAPS;
  readonly seen: CuaTurnRequest[] = [];
  constructor(private readonly turn: CuaTurn) {}
  async nextTurn(req: CuaTurnRequest): Promise<CuaTurn> {
    this.seen.push(req);
    return this.turn;
  }
}

class SignatureExecutor implements CuaExecutor {
  private i = 0;
  readonly frame = frame();
  constructor(private readonly signatures: string[]) {}
  async observe(): Promise<{ screenshot: Buffer; stateSignature: string }> {
    const sig = this.signatures[Math.min(this.i, this.signatures.length - 1)] ?? "sig";
    this.i += 1;
    return { screenshot: this.frame, stateSignature: sig };
  }
  async execute(): Promise<void> {}
}

/** Shape matching @e2b/desktop's CommandExitError (name + numeric exitCode + stderr). */
function commandExitError(fields: { exitCode?: number; stderr?: string; message?: string }): Error {
  return Object.assign(new Error(fields.message ?? `exit status ${fields.exitCode ?? 1}`), {
    name: "CommandExitError",
    ...fields
  });
}

// An executor that actuates normally but throws a caller-chosen error on selected actions —
// used to prove a single desktop CommandExitError is a recoverable skipped action while any
// other throw stays fatal. `executed` records only actions that actually actuated.
class FlakyExecutor implements CuaExecutor {
  private i = 0;
  readonly frame = frame();
  readonly executed: CuaAction[] = [];
  constructor(
    private readonly signatures: string[],
    private readonly failOn: (action: CuaAction) => Error | undefined
  ) {}
  async observe(): Promise<CuaObservation> {
    const sig = this.signatures[Math.min(this.i, this.signatures.length - 1)] ?? "sig";
    this.i += 1;
    return { screenshot: this.frame, stateSignature: sig };
  }
  async execute(action: CuaAction): Promise<void> {
    const err = this.failOn(action);
    if (err) throw err;
    this.executed.push(action);
  }
}

class ObservationSequenceExecutor implements CuaExecutor {
  private i = 0;
  readonly frame = frame();
  readonly actions: CuaAction[] = [];
  constructor(private readonly observations: CuaObservation[]) {}
  async observe(): Promise<CuaObservation> {
    const observation = this.observations[Math.min(this.i, this.observations.length - 1)];
    this.i += 1;
    return observation ?? { screenshot: this.frame, stateSignature: "fallback" };
  }
  async execute(action: CuaAction): Promise<void> {
    this.actions.push(action);
  }
}

// A monotonic injected clock so deadlines and timestamps are deterministic.
function monotonicClock(step = 1000): () => number {
  let t = 0;
  return () => (t += step);
}

function recorder() {
  const written: Array<{ name: string; bytes: Buffer }> = [];
  return {
    written,
    writeScreenshot: async (name: string, bytes: Buffer): Promise<string> => {
      written.push({ name, bytes });
      return `screenshots/${name}`;
    }
  };
}

describe("describeCuaAction", () => {
  it("never includes raw typed text", () => {
    expect(describeCuaAction({ kind: "type", text: "secret@example.test" })).toBe("type [19 chars]");
    expect(describeCuaAction({ kind: "click", x: 3, y: 4 })).toBe("click (3, 4)");
    expect(describeCuaAction({ kind: "keypress", keys: ["Control", "a"] })).toBe("keypress Control+a");
  });
});

describe("runComputerUseLoop", () => {
  it("completes when the model reports a natural endpoint", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false, reasoning: "looking", responseId: "r1" },
      { actions: [{ kind: "type", text: "hello@example.test" }], pendingSafetyChecks: [], done: false, responseId: "r2" },
      { actions: [], pendingSafetyChecks: [], done: true, message: "Booked the appointment.", responseId: "r3" }
    ]);
    const executor = new SignatureExecutor(["s0", "s1", "s2", "s3"]);
    const sink = recorder();

    const result = await runComputerUseLoop({
      instructions: "Act as Dana and book a visit.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      writeScreenshot: sink.writeScreenshot
    });

    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("Booked the appointment.");
    expect(result.trace.schema).toBe("humanish.actor-trace.v1");
    expect(result.trace.lane).toBe("computer-use");
    expect(result.trace.protocol).toBe("cua-loop");
    expect(result.trace.provider).toBe("fake-cua");
    expect(result.trace.ids.model).toBe("fake-1");
    expect(result.trace.counts.turns).toBe(3);
    expect(result.trace.counts.actions).toBe(2);
    // initial + 2 executed turns
    expect(result.trace.counts.screenshots).toBe(3);

    // #441: every item is stamped from the injected clock as it is recorded, so
    // stamps are ISO strings and non-decreasing in recording order.
    const stamps = result.trace.items.map((item) => item.at);
    expect(stamps.every((at): at is string => typeof at === "string")).toBe(true);
    const millis = stamps.map((at) => Date.parse(at as string));
    expect(millis.every((ms) => Number.isFinite(ms))).toBe(true);
    expect([...millis].sort((a, b) => a - b)).toEqual(millis);

    // #441: click-like actions carry structured pin coordinates; a type action does not.
    const click = result.trace.items.find((item) => item.kind === "ui_action" && item.title.startsWith("click"));
    expect(click?.coord).toEqual({ x: 10, y: 20 });
    const typed = result.trace.items.find((item) => item.kind === "ui_action" && item.title.startsWith("type"));
    expect(typed?.coord).toBeUndefined();
  });

  it("onTrace (#441) streams growing snapshots: initial observation, then once per turn, frame included", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false, responseId: "r1" },
      { actions: [], pendingSafetyChecks: [], done: true, message: "Done.", responseId: "r2" }
    ]);
    const executor = new SignatureExecutor(["s0", "s1", "s2"]);
    const sink = recorder();
    const snapshots: Array<{ count: number; lastKind: string | undefined }> = [];

    const result = await runComputerUseLoop({
      instructions: "Act.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      writeScreenshot: sink.writeScreenshot,
      onTrace: (items) => snapshots.push({ count: items.length, lastKind: items[items.length - 1]?.kind })
    });

    expect(result.status).toBe("passed");
    // One snapshot after the initial observation, one after the acted turn (the done turn
    // takes no actions and records no frame, so it emits no snapshot).
    expect(snapshots.length).toBe(2);
    // Each snapshot ends on that point's screenshot: a flush never shows an action without
    // the frame that preceded it.
    expect(snapshots.map((snapshot) => snapshot.lastKind)).toEqual(["screenshot", "screenshot"]);
    // Snapshots grow monotonically and the final trace extends the last snapshot.
    expect(snapshots[0]!.count).toBeLessThan(snapshots[1]!.count);
    expect(result.trace.items.length).toBeGreaterThanOrEqual(snapshots[1]!.count);
  });

  it("stops deterministically when post-action browser text matches stopWhen", async () => {
    const provider = new RepeatProvider({
      actions: [{ kind: "click", x: 10, y: 20 }],
      pendingSafetyChecks: [],
      done: false
    });
    const executor = new ObservationSequenceExecutor([
      { screenshot: frame(), stateSignature: "before", url: "http://127.0.0.1:3000/items/123", text: "Edit item" },
      { screenshot: frame(), stateSignature: "after", url: "http://127.0.0.1:3000/items/123", text: "Saved successfully" }
    ]);

    const result = await runComputerUseLoop({
      instructions: "Save the item.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      stopWhen: { any: [{ id: "saved", textIncludes: "Saved successfully" }] }
    });

    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("stopWhen matched saved (textIncludes)");
    expect(provider.seen).toHaveLength(1);
    expect(executor.actions).toHaveLength(1);
    expect(JSON.stringify(result.trace)).not.toContain("Saved successfully");
    const notice = result.trace.items.find((item) => item.kind === "notice" && item.status === "matched");
    expect(notice?.text).toContain("immediately preceding screenshot item");
    expect(notice?.text).not.toContain("Saved successfully");
  });

  it("can stop on an exact URL path plus page text after an action", async () => {
    const provider = new RepeatProvider({
      actions: [{ kind: "click", x: 10, y: 20 }],
      pendingSafetyChecks: [],
      done: false
    });
    const executor = new ObservationSequenceExecutor([
      { screenshot: frame(), stateSignature: "detail", url: "https://example.test/tasks/rfd_123", text: "Confirm deny" },
      { screenshot: frame(), stateSignature: "queue", url: "https://example.test/tasks?tab=open", text: "Tasks\nReview queue" }
    ]);

    const result = await runComputerUseLoop({
      instructions: "Deny the request.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      stopWhen: { any: [{ id: "returned-to-queue", urlPathEquals: "/tasks", textIncludes: "Tasks" }] }
    });

    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("stopWhen matched returned-to-queue (urlPathEquals+textIncludes)");
    expect(provider.seen).toHaveLength(1);
    expect(executor.actions).toHaveLength(1);
    expect(JSON.stringify(result.trace)).not.toContain("Review queue");
  });

  it("can stop before the first model turn when appState already satisfies stopWhen", async () => {
    const provider = new RepeatProvider({
      actions: [{ kind: "click", x: 10, y: 20 }],
      pendingSafetyChecks: [],
      done: false
    });
    const executor = new ObservationSequenceExecutor([
      {
        screenshot: frame(),
        stateSignature: "ready",
        appState: { workflow: { status: "done", count: 3 } }
      }
    ]);

    const result = await runComputerUseLoop({
      instructions: "Finish the workflow.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      stopWhen: { any: [{ id: "already-done", appStatePathEquals: { path: "workflow.status", equals: "done" } }] }
    });

    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("stopWhen matched already-done (appStatePathEquals)");
    expect(provider.seen).toHaveLength(0);
    expect(executor.actions).toHaveLength(0);
    expect(JSON.stringify(result.trace)).not.toContain("workflow");
    const screenshotIndex = result.trace.items.findIndex((item) => item.kind === "screenshot");
    const noticeIndex = result.trace.items.findIndex((item) => item.kind === "notice" && item.status === "matched");
    expect(screenshotIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBe(screenshotIndex + 1);
    expect(result.trace.items[noticeIndex]?.text).toContain("immediately preceding screenshot item");
  });

  it("DEFAULT persists RAW full-fidelity frames (local fidelity) and never logs raw typed text", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "type", text: "hello@example.test" }], pendingSafetyChecks: [], done: false },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
    ]);
    const executor = new SignatureExecutor(["s0", "s1"]);
    const sink = recorder();

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      writeScreenshot: sink.writeScreenshot
      // redactScreenshots omitted → defaults false → raw
    });

    // Typed text (synthetic identity) is STILL never in the trace — that redaction is unconditional.
    expect(JSON.stringify(result.trace)).not.toContain("hello@example.test");
    // Screenshots are recorded raw (redaction: "none"), full fidelity for local use.
    const shots = result.trace.items.filter((i) => i.kind === "screenshot");
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((i) => i.screenshotRef?.redaction === "none")).toBe(true);
    expect(result.trace.redaction.screenshots).toBe("raw");
    // What was persisted IS the raw frame, byte-identical to what the executor produced.
    expect(sink.written.length).toBe(shots.length);
    expect(Buffer.compare(sink.written[0]!.bytes, executor.frame)).toBe(0);
  });

  it("redactScreenshots: true persists blurred thumbnails (publish-safe), not raw frames", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "type", text: "hello@example.test" }], pendingSafetyChecks: [], done: false },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
    ]);
    const executor = new SignatureExecutor(["s0", "s1"]);
    const sink = recorder();

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      redactScreenshots: true,
      writeScreenshot: sink.writeScreenshot
    });

    const shots = result.trace.items.filter((i) => i.kind === "screenshot");
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((i) => i.screenshotRef?.redaction === "blurred")).toBe(true);
    expect(result.trace.redaction.screenshots).toBe("blurred");
    // Persisted bytes are the redacted thumbnail, NOT the raw frame.
    expect(Buffer.compare(sink.written[0]!.bytes, executor.frame)).not.toBe(0);
  });

  it("scrubText scrubs a KNOWN provisioned value the MODEL narrates into reasoning/message (no shape for pattern redaction)", async () => {
    // A DB password has no secret "shape" — redactText alone cannot catch it. The lab injects
    // scrubText so a value the model transcribes into its narration never lands raw in the trace.
    const provisionedValue = "shapeless-db-pw-7Q2x";
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false,
        reasoning: `I see the config shows password ${provisionedValue} on screen`,
        message: `noting ${provisionedValue} before continuing` },
      { actions: [], pendingSafetyChecks: [], done: true, message: `done; the value was ${provisionedValue}` }
    ]);
    const executor = new SignatureExecutor(["s0", "s1"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      scrubText: (text) => text.split(provisionedValue).join("[REDACTED_SECRET]")
    });

    // The shapeless value never appears anywhere in the trace (reasoning, message, summary).
    expect(JSON.stringify(result.trace)).not.toContain(provisionedValue);
    expect(JSON.stringify(result.trace)).toContain("[REDACTED_SECRET]");
  });

  it("records public-safe actor diagnostics when the provider loop crashes", async () => {
    const provisionedValue = "shapeless-runtime-token-9a2b";
    const provider: CuaProvider = {
      id: "crashy-provider",
      version: "c1",
      capabilities: FAKE_CAPS,
      async nextTurn(): Promise<CuaTurn> {
        throw new Error(`provider subprocess exited with ${provisionedValue}`);
      }
    };
    const executor = new SignatureExecutor(["s0"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      scrubText: (text) => text.split(provisionedValue).join("[REDACTED_SECRET]")
    });

    expect(result.completionReason).toBe("actor_error");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("computer-use loop error");
    expect(result.trace.items.at(-1)).toMatchObject({
      kind: "notice",
      status: "error",
      title: "computer-use loop error",
      text: "phase: requesting provider turn 1; error: Error; message: provider subprocess exited with [REDACTED_SECRET]",
      screenshotRef: { path: "screenshots/turn-00-start.png", redaction: "none" }
    });
    expect(JSON.stringify(result.trace)).not.toContain(provisionedValue);
  });

  it("records the last UI action when the executor crashes mid-actuation", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 11, y: 22 }], pendingSafetyChecks: [], done: false }
    ]);
    const executor: CuaExecutor = {
      observe: async () => ({ screenshot: frame(), stateSignature: "s0" }),
      execute: async () => {
        throw new Error("desktop actuator exited 1");
      }
    };

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    expect(result.completionReason).toBe("actor_error");
    expect(result.trace.items.at(-1)).toMatchObject({
      kind: "notice",
      status: "error",
      title: "computer-use loop error",
      text: "phase: executing click (11, 22); error: Error; message: desktop actuator exited 1; last action: click (11, 22)"
    });
  });

  // Issue: a single flaky desktop command must not end the whole run. The real @e2b/desktop
  // Sandbox THROWS a CommandExitError on any non-zero exit (e.g. a Ctrl+Minus keypress exiting
  // 2), so ONE such throw is a recoverable skipped action, not a fatal actor_error.
  it("skips a single desktop CommandExitError action (recoverable) and completes normally, not actor_error", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "keypress", keys: ["Control", "-"] }], pendingSafetyChecks: [], done: false, responseId: "r1" },
      { actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false, responseId: "r2" },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done", responseId: "r3" }
    ]);
    const executor = new FlakyExecutor(["s0", "s1", "s2", "s3"], (action) =>
      action.kind === "keypress" ? commandExitError({ exitCode: 2, stderr: "zoom failed" }) : undefined
    );

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    // NOT fatal: the run reached its natural endpoint despite the failed keypress.
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.status).toBe("passed");
    // The failed keypress did NOT actuate — only the click counts as a material action.
    expect(result.trace.counts.materialActions).toBe(1);
    expect(executor.executed).toEqual([{ kind: "click", x: 10, y: 20 }]);
    // A public-safe skipped-action notice was recorded (action label + exit code + stderr tail).
    const notice = result.trace.items.find((item) => item.title === "action skipped: desktop command failed");
    expect(notice).toMatchObject({ kind: "notice", lifecycle: "completed", status: "error" });
    expect(notice?.text).toBe("action: keypress Control+-; exit code: 2; stderr: zoom failed");
    // The failed action did NOT emit a completed ui_action, and the run did NOT crash.
    expect(result.trace.items.filter((item) => item.kind === "ui_action")).toHaveLength(1);
    expect(result.trace.items.some((item) => item.title === "computer-use loop error")).toBe(false);
  });

  it("a NON-CommandExitError from execute() is still fatal (actor_error path byte-preserved)", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 11, y: 22 }], pendingSafetyChecks: [], done: false }
    ]);
    // A generic Error carries no CommandExitError name and no numeric exitCode → not recoverable.
    const executor = new FlakyExecutor(["s0"], () => new Error("desktop actuator exited 1"));

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    expect(result.completionReason).toBe("actor_error");
    expect(result.status).toBe("failed");
    // It was NOT swallowed by the recovery path — the fatal loop-error notice is present.
    expect(result.trace.items.some((item) => item.title === "action skipped: desktop command failed")).toBe(false);
    expect(result.trace.items.at(-1)).toMatchObject({
      kind: "notice",
      status: "error",
      title: "computer-use loop error",
      text: "phase: executing click (11, 22); error: Error; message: desktop actuator exited 1; last action: click (11, 22)"
    });
  });

  it("reads the fixed closing line the prompt asks for, and nothing looser (#570, second half)", async () => {
    expect(declaredOutcomeFromClosingLine("REACHED THE GOAL.\nAdded two tables.")).toBe("reached");
    expect(declaredOutcomeFromClosingLine("**Did not reach the goal**\n\nI gave up at the modal.")).toBe("not_reached");
    expect(declaredOutcomeFromClosingLine("  blocked\nThe database chooser has no keyboard path.")).toBe("blocked");
    // Anything else is absence, never a guess: the regex fallback reads the paragraph instead.
    expect(declaredOutcomeFromClosingLine("Done. I added two tables.")).toBeUndefined();
    expect(declaredOutcomeFromClosingLine("I reached the goal after some trouble.")).toBeUndefined();
    expect(declaredOutcomeFromClosingLine("")).toBeUndefined();
    expect(declaredOutcomeFromClosingLine(undefined)).toBeUndefined();
  });

  it("a free-text provider's closing line lands on the trace as declaredOutcome", async () => {
    const provider: CuaProvider = {
      id: "free-text",
      version: "f",
      capabilities: FAKE_CAPS,
      nextTurn: async () => ({ actions: [], pendingSafetyChecks: [], done: true, message: "BLOCKED.\nThe database chooser is mouse-only." })
    };
    const executor: CuaExecutor = { observe: async () => ({ screenshot: frame(), stateSignature: "s0" }), execute: async () => {} };
    const result = await runComputerUseLoop({ instructions: "go", provider, executor, persona, redaction: defaultRedactionHooks, timeoutMs: 10_000_000, now: monotonicClock() });
    expect(result.trace.declaredOutcome).toBe("blocked");
    // The schema field, when present, wins over the line.
    const both: CuaProvider = { ...provider, nextTurn: async () => ({ actions: [], pendingSafetyChecks: [], done: true, outcome: "reached", message: "BLOCKED.\nbut the field says reached" }) };
    const resultBoth = await runComputerUseLoop({ instructions: "go", provider: both, executor, persona, redaction: defaultRedactionHooks, timeoutMs: 10_000_000, now: monotonicClock() });
    expect(resultBoth.trace.declaredOutcome).toBe("reached");
  });

  it("records the participant's declared outcome on the trace, and reads not_reached as gave_up (#570)", async () => {
    const run = async (outcome: "reached" | "not_reached" | "blocked" | undefined) => {
      const provider: CuaProvider = {
        id: "declares",
        version: "d",
        capabilities: FAKE_CAPS,
        nextTurn: async () => ({ actions: [], pendingSafetyChecks: [], done: true, message: "I could not read the label, but the task is done.", ...(outcome === undefined ? {} : { outcome }) })
      };
      const executor: CuaExecutor = { observe: async () => ({ screenshot: frame(), stateSignature: "s0" }), execute: async () => {} };
      return runComputerUseLoop({ instructions: "go", provider, executor, persona, redaction: defaultRedactionHooks, timeoutMs: 10_000_000, now: monotonicClock() });
    };
    const reached = await run("reached");
    expect(reached.trace.declaredOutcome).toBe("reached");
    expect(reached.completionReason).toBe("goal_satisfied");
    const notReached = await run("not_reached");
    expect(notReached.trace.declaredOutcome).toBe("not_reached");
    expect(notReached.completionReason).toBe("gave_up");
    expect(notReached.status).toBe("abandoned");
    const blocked = await run("blocked");
    expect(blocked.trace.declaredOutcome).toBe("blocked");
    // The actor stopped on purpose; the LANE turns a declared blocker into a blocked participant.
    expect(blocked.completionReason).toBe("goal_satisfied");
    const silent = await run(undefined);
    expect(silent.trace.declaredOutcome).toBeUndefined();
  });

  it("a provider turn that stalls is retried once with a notice, and the run goes on (#469)", async () => {
    // Three lanes of a real run stopped producing turns within seven seconds of each other and
    // were closed 36 minutes later as budget_reached, nothing in the trace saying why: one hung
    // HTTP request per lane, bounded only by the session budget.
    let calls = 0;
    const provider: CuaProvider = {
      id: "stall-once",
      version: "s",
      capabilities: FAKE_CAPS,
      nextTurn() {
        calls += 1;
        if (calls === 1) return new Promise<CuaTurn>(() => {}); // hangs; only a bound can settle it
        return Promise.resolve({ actions: [], pendingSafetyChecks: [], done: true, message: "done" });
      }
    };
    const executor: CuaExecutor = {
      observe: async () => ({ screenshot: frame(), stateSignature: "s0" }),
      execute: async () => {}
    };
    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      turnTimeoutMs: 30,
      now: monotonicClock()
    });
    expect(calls).toBe(2);
    expect(result.completionReason).toBe("goal_satisfied");
    const notice = result.trace.items.find((item) => item.title === "provider turn stalled; retrying once");
    expect(notice).toMatchObject({ kind: "notice", status: "warn" });
    expect(notice?.text).toContain("provider turn 1 produced nothing within 30ms");
  });

  it("a provider turn that stalls twice ends the lane as harness_error, named, not thirty silent minutes", async () => {
    const provider: CuaProvider = {
      id: "stall-always",
      version: "s",
      capabilities: FAKE_CAPS,
      nextTurn: () => new Promise<CuaTurn>(() => {})
    };
    const executor: CuaExecutor = {
      observe: async () => ({ screenshot: frame(), stateSignature: "s0" }),
      execute: async () => {}
    };
    const startedAt = Date.now();
    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      turnTimeoutMs: 30,
      now: monotonicClock()
    });
    // Ended by the per-turn bound, long before the session budget.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.completionReason).toBe("harness_error");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("provider turn 1 stalled twice (30ms each)");
    expect(result.trace.items.at(-1)).toMatchObject({ kind: "notice", status: "error", title: "provider turn stalled twice" });
  });

  it("a `wait` that hangs inside the desktop SDK is skipped with a notice; the participant is not failed (#480)", async () => {
    // A default wait hung for ~90 s in the SDK after twelve turns of ordinary work and the lane
    // ended actor_error. A wait that has hung has, by definition, waited.
    let turns = 0;
    const provider: CuaProvider = {
      id: "wait-then-done",
      version: "w",
      capabilities: FAKE_CAPS,
      async nextTurn() {
        turns += 1;
        if (turns === 1) return { actions: [{ kind: "wait", ms: 5 }], pendingSafetyChecks: [], done: false };
        return { actions: [], pendingSafetyChecks: [], done: true, message: "done" };
      }
    };
    const executor: CuaExecutor = {
      observe: async () => ({ screenshot: frame(), stateSignature: `s${turns}` }),
      execute: (action) => (action.kind === "wait" ? new Promise<void>(() => {}) : Promise.resolve())
    };
    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      observationTimeoutMs: 30,
      now: monotonicClock()
    });
    expect(result.completionReason).toBe("goal_satisfied");
    expect(turns).toBe(2);
    const notice = result.trace.items.find((item) => item.title === "observation action stalled; skipped");
    expect(notice).toMatchObject({ kind: "notice", status: "warn" });
    expect(notice?.text).toContain("idle action wait 5ms produced nothing within 35ms");
  });

  it("an observe() that stalls is asked again once before the lane gives up on the desktop", async () => {
    let observes = 0;
    const provider: CuaProvider = {
      id: "done-at-once",
      version: "d",
      capabilities: FAKE_CAPS,
      nextTurn: async () => ({ actions: [], pendingSafetyChecks: [], done: true, message: "done" })
    };
    const executor: CuaExecutor = {
      observe: () => {
        observes += 1;
        if (observes === 1) return new Promise<CuaObservation>(() => {});
        return Promise.resolve({ screenshot: frame(), stateSignature: "s0" });
      },
      execute: async () => {}
    };
    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      observationTimeoutMs: 30,
      now: monotonicClock()
    });
    expect(observes).toBe(2);
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.items.some((item) => item.title === "observation stalled; retrying once")).toBe(true);
  });

  it("a raceSettle DEADLINE during execute() propagates (timed_out), never swallowed as a skipped action", async () => {
    let t = 0;
    const now = (): number => t;
    const provider: CuaProvider = {
      id: "hang-exec",
      version: "h",
      capabilities: FAKE_CAPS,
      async nextTurn() {
        t = 1000; // jump past the 100ms deadline before the (idle) action runs
        return { actions: [{ kind: "wait", ms: 5 }], pendingSafetyChecks: [], done: false };
      }
    };
    const executor: CuaExecutor = {
      observe: async () => ({ screenshot: frame(), stateSignature: "s0" }),
      execute: () => new Promise<void>(() => {}) // hangs; only the deadline can settle it
    };

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 100,
      now
    });

    expect(result.completionReason).toBe("timed_out");
    expect(result.status).toBe("timed_out");
    expect(result.trace.items.some((item) => item.title === "action skipped: desktop command failed")).toBe(false);
  });

  it("an ABORT during execute() propagates (harness_error), never swallowed as a skipped action", async () => {
    const controller = new AbortController();
    const provider: CuaProvider = {
      id: "abort-exec",
      version: "a",
      capabilities: FAKE_CAPS,
      // Material action; signal is still un-aborted at the pre-action guard, so the abort
      // is exercised INSIDE the execute await (through the new recovery boundary).
      async nextTurn() {
        return { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false };
      }
    };
    const executor: CuaExecutor = {
      observe: async () => ({ screenshot: frame(), stateSignature: "s0" }),
      execute: () => {
        controller.abort();
        return new Promise<void>(() => {}); // hangs; only the abort can settle it
      }
    };

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      signal: controller.signal
    });

    expect(result.completionReason).toBe("harness_error");
    expect(result.status).toBe("failed");
    expect(result.trace.items.some((item) => item.title === "action skipped: desktop command failed")).toBe(false);
  });

  it("ends as gave_up (friction backstop) — never actor_error and never an infinite loop — when EVERY action fails with CommandExitError", async () => {
    const provider = new RepeatProvider({
      actions: [{ kind: "keypress", keys: ["Control", "-"] }],
      pendingSafetyChecks: [],
      done: false
    });
    // Every keypress throws, and the observation signature never changes, so nothing progresses.
    const executor = new FlakyExecutor(["constant"], () => commandExitError({ exitCode: 2, stderr: "zoom failed" }));

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    // The existing no-progress backstop still terminates the run honestly.
    expect(result.completionReason).toBe("gave_up");
    expect(result.status).toBe("abandoned");
    // Not fatal, and every failed action was skipped (no material progress ever counted).
    expect(result.trace.items.some((item) => item.title === "computer-use loop error")).toBe(false);
    expect(result.trace.counts.materialActions).toBe(0);
    expect(
      result.trace.items.filter((item) => item.title === "action skipped: desktop command failed").length
    ).toBeGreaterThanOrEqual(3);
  });

  // #383: a BLIND frame signature must not be able to end a lane that is working.
  //
  // This is the exact live failure, reduced. A constant stateSignature stands in for the old hash on
  // a light-themed web app, where 9 visibly different consecutive frames produced one identical
  // value. Under the old rule — stale frame alone means no progress — the lane was ended as
  // `gave_up` and the run recorded 0/2 passed, while the agent was a foreign key away from finishing
  // its mission. The backstop now needs the agent to also be repeating itself.
  it("does NOT give up when the frame signature is blind but the agent is doing varied work", async () => {
    // Every turn clicks somewhere new — the shape of an agent working through a form.
    let n = 0;
    const provider: CuaProvider = {
      id: "fake-cua",
      version: "fake-1",
      capabilities: FAKE_CAPS,
      async nextTurn(): Promise<CuaTurn> {
        n += 1;
        return {
          actions: [{ kind: "click", x: 100 + n * 60, y: 200 + n * 40, button: "left" }],
          pendingSafetyChecks: [],
          done: n >= 12
        };
      }
    };
    // A signature that never changes: the blind hash.
    const executor = new SignatureExecutor(["constant"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    expect(result.completionReason).not.toBe("gave_up");
    expect(result.trace.counts.materialActions).toBeGreaterThanOrEqual(10);
  });

  it("still gives up when the agent repeats the same action against a stale frame", async () => {
    // The genuine stuck shape: re-clicking one dead control forever.
    const provider = new RepeatProvider({
      actions: [{ kind: "click", x: 301, y: 486, button: "left" }],
      pendingSafetyChecks: [],
      done: false
    });
    const executor = new SignatureExecutor(["constant"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    expect(result.completionReason).toBe("gave_up");
    expect(result.reason).toContain("no change to the UI state");
  });

  it("gives up on an idle streak, citing the friction (not a turn count)", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "screenshot" }], pendingSafetyChecks: [], done: false });
    const executor = new SignatureExecutor(["same"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      idleSteps: 3
    });

    expect(result.completionReason).toBe("gave_up");
    expect(result.status).toBe("abandoned");
    expect(result.reason).toContain("no material UI action");
    const notice = result.trace.items.find((item) => item.title === "computer-use backstop gave up");
    expect(notice?.text).toContain("recent actions: screenshot -> screenshot -> screenshot");
    expect(notice?.screenshotRef?.path).toBe("screenshots/turn-03.png");
  });

  it("does not carry an idle streak across visible UI progress", async () => {
    const seen: CuaTurnRequest[] = [];
    const provider: CuaProvider = {
      id: "idle-recovery",
      version: "ir",
      capabilities: FAKE_CAPS,
      async nextTurn(req: CuaTurnRequest): Promise<CuaTurn> {
        seen.push(req);
        if (req.contextHint?.includes("only waiting or taking screenshots")) {
          return {
            actions: [{ kind: "click", x: 10, y: 20 }],
            pendingSafetyChecks: [],
            done: false
          };
        }
        if (seen.length >= 6) {
          return {
            actions: [],
            pendingSafetyChecks: [],
            done: true,
            message: "continued after the choice screen became actionable"
          };
        }
        return { actions: [{ kind: "screenshot" }], pendingSafetyChecks: [], done: false };
      }
    };
    const executor = new SignatureExecutor([
      "start",
      "loading",
      "choice-screen",
      "choice-screen",
      "choice-screen",
      "selected"
    ]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      idleSteps: 3,
      noProgressSteps: 6
    });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.status).toBe("passed");
    expect(result.reason).toBe("continued after the choice screen became actionable");
    expect(seen.some((req) => req.contextHint?.includes("only waiting or taking screenshots"))).toBe(true);
    expect(result.trace.counts.idleTurns).toBeGreaterThan(3);
    expect(result.trace.items.some((item) => item.title === "computer-use backstop gave up")).toBe(false);
  });

  it.each([40, 80])("does not instruct a waiting participant to stop before the lobby starts (backstop %i)", async (backstop) => {
    const seen: CuaTurnRequest[] = [];
    let played = false;
    const provider: CuaProvider = {
      id: "waiting-room",
      capabilities: FAKE_CAPS,
      async nextTurn(request) {
        seen.push(request);
        // A participant obeying the old recovery prompt would leave on the fourth turn.
        if (/stop with (?:a final|a blocker) summary/.test(request.contextHint ?? "")) {
          return { actions: [], pendingSafetyChecks: [], done: true, message: "Left the waiting room as instructed." };
        }
        if (request.observation.stateSignature === "game-started") {
          if (played) return { actions: [], pendingSafetyChecks: [], done: true, message: "Joined the started game." };
          played = true;
          return { actions: [{ kind: "click", x: 20, y: 30 }], pendingSafetyChecks: [], done: false };
        }
        return { actions: [{ kind: "screenshot" }], pendingSafetyChecks: [], done: false };
      }
    };
    const result = await runComputerUseLoop({
      instructions: "Join the room and wait for the host to start the game, then play.",
      provider,
      executor: new SignatureExecutor([...Array<string>(9).fill("lobby-waiting"), "game-started"]),
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      idleSteps: backstop,
      noProgressSteps: backstop
    });

    expect(result.reason).toBe("Joined the started game.");
    expect(result.trace.counts.materialActions).toBe(1);
    const hints = seen.flatMap((request) => request.contextHint === undefined ? [] : [request.contextHint]);
    expect(hints.some((hint) => hint.includes("No visible progress"))).toBe(true);
    expect(hints.some((hint) => hint.includes("only waiting or taking screenshots"))).toBe(true);
    expect(hints.every((hint) => !/stop with (?:a final|a blocker) summary/.test(hint))).toBe(true);
  });

  it.each([40, 80])("still ends an unchanged lobby at its declared idle backstop %i", async (backstop) => {
    const provider = new RepeatProvider({ actions: [{ kind: "screenshot" }], pendingSafetyChecks: [], done: false });
    const result = await runComputerUseLoop({
      instructions: "Wait for the host.",
      provider,
      executor: new SignatureExecutor(["lobby-waiting"]),
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      idleSteps: backstop,
      noProgressSteps: backstop
    });
    expect(provider.seen).toHaveLength(backstop);
    expect(result.completionReason).toBe("gave_up");
    expect(result.trace.counts.idleTurns).toBe(backstop);
  });

  it("gives up on a no-progress streak and nudges before stopping", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "click", x: 5, y: 5 }], pendingSafetyChecks: [], done: false });
    const executor = new SignatureExecutor(["same"]); // signature never changes

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    expect(result.completionReason).toBe("gave_up");
    expect(result.reason).toContain("no change to the UI state");
    // A recovery hint was injected before the backstop tripped.
    expect(provider.seen.some((r) => (r.contextHint ?? "").includes("No visible progress"))).toBe(true);
    expect(result.trace.items.find((item) => item.title === "computer-use backstop gave up")?.text).toContain(
      "last material action: click (5, 5)"
    );
  });

  it("reaches the time BUDGET (non-failure) when the wall-clock deadline hits after a material action", async () => {
    let t = 0;
    const now = (): number => t;
    // The first model turn takes a material click, then jumps the clock past the deadline; iteration
    // 2 trips it. Because at least one material action ran, this is a productive budget stop — a
    // non-failure open-ended-watch completion, NOT a stuck timeout.
    const provider: CuaProvider = {
      id: "tick",
      version: "t",
      capabilities: FAKE_CAPS,
      async nextTurn() {
        t = 1000;
        return { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false };
      }
    };
    const executor = new SignatureExecutor(["s0", "s1"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 100,
      now
    });

    expect(result.completionReason).toBe("budget_reached");
    expect(result.status).toBe("incomplete");
    expect(result.trace.counts.materialActions).toBeGreaterThan(0);
    expect(result.reason).toContain("time budget after productive activity");
    expect(result.trace.counts.turns).toBe(1);
  });

  it("stays a FAILURE (timed_out) when the deadline hits after only idle turns (no material progress)", async () => {
    let t = 0;
    const now = (): number => t;
    // The model only waits/screenshots (idle), then the clock jumps past the deadline. Zero material
    // actions → an honest stuck timeout, not a budget stop.
    const provider: CuaProvider = {
      id: "idle-tick",
      version: "t",
      capabilities: FAKE_CAPS,
      async nextTurn() {
        t = 1000;
        return { actions: [{ kind: "wait", ms: 10 }], pendingSafetyChecks: [], done: false };
      }
    };
    const executor = new SignatureExecutor(["s0", "s1"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 100,
      now
    });

    expect(result.completionReason).toBe("timed_out");
    expect(result.status).toBe("timed_out");
    expect(result.trace.counts.materialActions).toBe(0);
    expect(result.reason).toContain("no material progress");
  });

  it("enforces the deadline on a hung provider call (raceSettle) as a zero-progress timed_out failure", async () => {
    const provider: CuaProvider = {
      id: "hang",
      version: "h",
      capabilities: FAKE_CAPS,
      nextTurn: () => new Promise<CuaTurn>(() => {}) // never resolves
    };
    const executor = new SignatureExecutor(["s0"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 30,
      now: () => 0
    });

    expect(result.completionReason).toBe("timed_out");
    expect(result.status).toBe("timed_out");
    expect(result.trace.counts.materialActions).toBe(0);
  });

  it("does not actuate the desktop once aborted mid-turn", async () => {
    const controller = new AbortController();
    let executed = 0;
    const provider: CuaProvider = {
      id: "ab",
      version: "a",
      capabilities: FAKE_CAPS,
      async nextTurn() {
        controller.abort();
        return { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false };
      }
    };
    const executor: CuaExecutor = {
      observe: async () => ({ screenshot: frame(), stateSignature: "s" }),
      execute: async () => {
        executed += 1;
      }
    };

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      signal: controller.signal
    });

    expect(result.completionReason).toBe("harness_error");
    expect(executed).toBe(0); // no action ran after the abort
  });

  it("pauses (blocked) on an unacknowledged safety check", async () => {
    const provider = new RepeatProvider({
      actions: [{ kind: "click", x: 1, y: 1 }],
      pendingSafetyChecks: [{ id: "sc_1", code: "malicious_instructions", message: "be careful" }],
      done: false
    });
    const executor = new SignatureExecutor(["s0", "s1"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    expect(result.completionReason).toBe("blocked_approval");
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("safety check");
    expect(result.trace.items.some((i) => i.kind === "approval")).toBe(true);
  });

  it("carries acknowledged safety checks onto the NEXT turn's request, verbatim and one-shot", async () => {
    const check = { id: "sc_9", code: "malicious_instructions", message: "be careful" };
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [check], done: false, responseId: "r1" },
      { actions: [{ kind: "click", x: 2, y: 2 }], pendingSafetyChecks: [], done: false, responseId: "r2" },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
    ]);
    const executor = new SignatureExecutor(["s0", "s1", "s2"]);

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      acknowledgeSafetyChecks: (checks) => checks
    });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(provider.seen).toHaveLength(3);
    // Turn 1: nothing to acknowledge yet.
    expect(provider.seen[0]?.acknowledgedSafetyChecks).toBeUndefined();
    // Turn 2: the acks granted for turn 1's checks ride the request that carries
    // that call's output — verbatim wire triples, not fabricated from codes.
    expect(provider.seen[1]?.acknowledgedSafetyChecks).toEqual([check]);
    // Turn 3: acks are one-shot; stale acks must not be re-sent.
    expect(provider.seen[2]?.acknowledgedSafetyChecks).toBeUndefined();
  });

  it("stops when the signal is already aborted", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false });
    const executor = new SignatureExecutor(["s0"]);
    const controller = new AbortController();
    controller.abort();

    const result = await runComputerUseLoop({
      instructions: "go",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      signal: controller.signal
    });

    expect(result.completionReason).toBe("harness_error");
    expect(result.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Issue #148: state-driven (non-vision) executors. RUNG 2 (appState-preferred progress,
// no-screenshot persistence, redaction.notes self-describes appState) and RUNG 3 (a
// requiresFrame provider against a screenshot-less observation fails closed).
// ---------------------------------------------------------------------------

// A non-vision executor: returns NO screenshot and a (configurable) appState per turn, with a
// constant stateSignature so progress can ONLY come from the appState delta.
class StateExecutor implements CuaExecutor {
  private i = 0;
  readonly observed: CuaObservation[] = [];
  constructor(
    private readonly appStates: Array<Record<string, unknown>>,
    private readonly stateSignature = "constant-sig"
  ) {}
  async observe(): Promise<CuaObservation> {
    const appState = this.appStates[Math.min(this.i, this.appStates.length - 1)] ?? {};
    this.i += 1;
    const obs: CuaObservation = { stateSignature: this.stateSignature, appState };
    this.observed.push(obs);
    return obs;
  }
  async execute(): Promise<void> {}
}

// A state-reasoning provider: omits requiresFrame (defaults falsey) and reasons over appState.
class StateProvider implements CuaProvider {
  readonly id = "fake-state-brain";
  readonly version = "state-1";
  readonly capabilities = FAKE_CAPS;
  private i = 0;
  constructor(private readonly turns: CuaTurn[]) {}
  async nextTurn(): Promise<CuaTurn> {
    const turn = this.turns[this.i];
    this.i += 1;
    return turn ?? { actions: [], pendingSafetyChecks: [], done: true, message: "done (exhausted)" };
  }
}

describe("stableProgressKey (issue #148)", () => {
  it("is order-independent: shuffled key order maps to the SAME key (no fabricated progress)", () => {
    const a = stableProgressKey({ route: "/home", turn: 3, modal: null, unread: 2 });
    const b = stableProgressKey({ unread: 2, modal: null, turn: 3, route: "/home" });
    expect(a).toBe(b);
  });

  it("distinguishes genuinely different states", () => {
    expect(stableProgressKey({ route: "/home" })).not.toBe(stableProgressKey({ route: "/inbox" }));
  });

  it("does NOT throw on a cyclic appState — it degrades to a bounded value", () => {
    const cyclic: Record<string, unknown> = { route: "/home" };
    cyclic.self = cyclic;
    const key = stableProgressKey(cyclic);
    expect(typeof key).toBe("string");
    expect(key).toContain("[Circular]");
  });

  it("does NOT throw on a huge/deep appState — it caps to a bounded value", () => {
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i += 1) huge[`k${i}`] = "x".repeat(64);
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 200; i += 1) deep = { nested: deep };
    expect(() => stableProgressKey(huge)).not.toThrow();
    expect(() => stableProgressKey(deep)).not.toThrow();
    expect(stableProgressKey(huge).length).toBeLessThanOrEqual(8200);
  });
});

describe("runComputerUseLoop with a state-driven (non-vision) executor (issue #148)", () => {
  it("persists ZERO frames, resolves redaction.screenshots to n/a, and self-describes appState in redaction.notes", async () => {
    const provider = new StateProvider([
      { actions: [{ kind: "type", text: "hi" }], pendingSafetyChecks: [], done: false },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
    ]);
    // Distinct appState per turn → progress; constant stateSignature throughout. The route
    // values are deliberately distinctive so the runtime-only assertion below cannot false-match.
    const executor = new StateExecutor([
      { route: "/appstate-marker-one", turn: 1 },
      { route: "/appstate-marker-two", turn: 2 }
    ]);
    const sink = recorder();

    const result = await runComputerUseLoop({
      instructions: "drive via state",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      writeScreenshot: sink.writeScreenshot
    });

    expect(result.completionReason).toBe("goal_satisfied");
    // (a) zero frames written, zero screenshot trace items, no Buffer.alloc(0) on disk.
    expect(sink.written.length).toBe(0);
    expect(result.trace.items.filter((i) => i.kind === "screenshot").length).toBe(0);
    expect(result.trace.counts.screenshots).toBe(0);
    // (b) redaction resolves to n/a.
    expect(result.trace.redaction.screenshots).toBe("n/a");
    // (c) redaction.notes self-describes the appState stance (doctrine fix 1, invariant 6).
    expect(result.trace.redaction.notes).toContain("App state was observed");
    expect(result.trace.redaction.notes).toContain("NOT written to the trace");
    // appState is runtime-only: it must NEVER appear in the serialized trace.
    expect(JSON.stringify(result.trace)).not.toContain('"route"');
    expect(JSON.stringify(result.trace)).not.toContain("appstate-marker");
  });

  it("an appState delta drives progress even when the stateSignature is CONSTANT", async () => {
    // 8 actuating turns then stop; appState changes every turn → never trips no-progress.
    const turns: CuaTurn[] = [];
    for (let i = 0; i < 8; i += 1) turns.push({ actions: [{ kind: "click", x: i, y: i }], pendingSafetyChecks: [], done: false });
    turns.push({ actions: [], pendingSafetyChecks: [], done: true, message: "done" });
    const provider = new StateProvider(turns);
    const appStates = Array.from({ length: 9 }, (_, i) => ({ turn: i }));
    const executor = new StateExecutor(appStates, "frozen-sig");

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    // A constant stateSignature would have tripped gave_up at step 3; the appState delta saved it.
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.counts.noProgressTurns ?? 0).toBe(0);
  });

  it("the inverse trips the backstop: a CONSTANT appState (and constant signature) gives up on no progress", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false });
    // Same appState object every turn → progressKey never changes.
    const executor = new StateExecutor([{ turn: "frozen" }], "frozen-sig");

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    expect(result.completionReason).toBe("gave_up");
    expect(result.reason).toContain("no change");
  });

  it("shuffled-key-order appState across turns is NOT progress (gives up)", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false });
    // Same content, different key insertion order each turn — must NOT register as progress.
    const executor = new StateExecutor(
      [
        { route: "/x", turn: 1, modal: null },
        { modal: null, turn: 1, route: "/x" },
        { turn: 1, route: "/x", modal: null },
        { route: "/x", modal: null, turn: 1 }
      ],
      "frozen-sig"
    );

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      noProgressSteps: 3
    });

    expect(result.completionReason).toBe("gave_up");
  });

  it("an oversized/cyclic appState does NOT crash the loop (bounded progress key)", async () => {
    const provider = new StateProvider([
      { actions: [{ kind: "type", text: "x" }], pendingSafetyChecks: [], done: false },
      { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
    ]);
    const cyclic: Record<string, unknown> = { route: "/home" };
    cyclic.self = cyclic;
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i += 1) huge[`k${i}`] = i;
    const executor = new StateExecutor([cyclic, huge], "frozen-sig");

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    // No throw → the loop produced a terminal verdict.
    expect(["goal_satisfied", "gave_up"]).toContain(result.completionReason);
  });
});

describe("runComputerUseLoop vision-provider frame guard (issue #148, RUNG 3)", () => {
  it("a requiresFrame provider against a screenshot-less observation fails closed with the named reason (not a crash)", async () => {
    // A vision provider (requiresFrame: true) paired with a state-only executor (no screenshot).
    class VisionProvider implements CuaProvider {
      readonly id = "vision-needs-frame";
      readonly version = "v1";
      readonly capabilities = FAKE_CAPS;
      readonly requiresFrame = true;
      async nextTurn(): Promise<CuaTurn> {
        return { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false };
      }
    }
    const provider = new VisionProvider();
    const executor = new StateExecutor([{ turn: 1 }]);
    const sink = recorder();

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      writeScreenshot: sink.writeScreenshot
    });

    expect(result.completionReason).toBe("harness_error");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("vision-needs-frame");
    expect(result.reason).toContain("requires a screenshot frame");
    // Failed before any frame was persisted.
    expect(sink.written.length).toBe(0);
  });

  it("a requiresFrame provider WITH a screenshot behaves normally (no false trip)", async () => {
    class VisionProvider implements CuaProvider {
      readonly id = "vision-with-frame";
      readonly version = "v1";
      readonly capabilities = FAKE_CAPS;
      readonly requiresFrame = true;
      private i = 0;
      async nextTurn(): Promise<CuaTurn> {
        this.i += 1;
        return this.i >= 2
          ? { actions: [], pendingSafetyChecks: [], done: true, message: "done" }
          : { actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false };
      }
    }
    const provider = new VisionProvider();
    const executor = new SignatureExecutor(["s0", "s1"]);

    const result = await runComputerUseLoop({
      instructions: "drive",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    expect(result.completionReason).toBe("goal_satisfied");
  });
});

describe("runComputerUseLoop fail-closed maxUsd cap", () => {
  // A non-idle turn that also reports fixed per-turn usage; a RepeatProvider emits it forever so
  // only the cap (or a backstop) can stop the loop.
  const usageTurn: CuaTurn = {
    actions: [{ kind: "click", x: 10, y: 20 }],
    pendingSafetyChecks: [],
    done: false,
    usage: { input: 100, output: 50 }
  };
  // An injected PURE estimator with a fake rate (no live pricing table): $0.001 per token.
  const estimateTurnCostUsd = (usage: { input?: number; output?: number }): number => ((usage.input ?? 0) + (usage.output ?? 0)) * 0.001;

  it("fails CLOSED and LOUD when a stale positional estimator NaNs the running estimate (red-team)", async () => {
    const provider = new RepeatProvider(usageTurn);
    const executor = new SignatureExecutor(["a", "b", "c", "d"]);
    // The pre-#334 positional shape: arithmetic on the usage OBJECT yields NaN.
    const staleEstimator = ((input: number, output: number): number =>
      (input + output) * 0.001) as unknown as (usage: { input?: number }) => number;
    const result = await runComputerUseLoop({
      instructions: "Act.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      maxUsd: 0.35,
      estimateTurnCostUsd: staleEstimator
    });
    expect(result.status).toBe("failed");
    expect(result.completionReason).toBe("harness_error");
    expect(result.reason).toContain("non-finite estimate");
  });

  it("aborts fail-closed the moment the running estimate crosses maxUsd, BEFORE the next model turn", async () => {
    const provider = new RepeatProvider(usageTurn);
    const executor = new SignatureExecutor(["s0", "s1", "s2", "s3", "s4", "s5"]);

    const result = await runComputerUseLoop({
      instructions: "Drive until the budget cap fires.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      maxUsd: 0.35,
      estimateTurnCostUsd
    });

    // Cumulative estimate: turn1 $0.15, turn2 $0.30, turn3 $0.45 > $0.35 → break at turn 3.
    // Two material clicks executed BEFORE the cap tripped → a productive lane that hit its cost
    // budget → budget_reached (passed), with the estimate + cap cited in the detail.
    expect(result.completionReason).toBe("budget_reached");
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("crossed execution.caps.maxUsd=$0.35");
    expect(result.reason).toContain("after productive activity");
    expect(result.trace.counts.materialActions).toBeGreaterThan(0);
    // The cap fires BEFORE the next provider.nextTurn: exactly 3 turns were requested, no 4th.
    expect(provider.seen).toHaveLength(3);
    expect(result.trace.tokenUsage).toMatchObject({ input: 300, output: 150, total: 450 });
    // The per-request usage ledger (#334): one record per provider turn, in order.
    expect(result.trace.tokenUsage?.turns).toEqual([
      { input: 100, output: 50 },
      { input: 100, output: 50 },
      { input: 100, output: 50 }
    ]);
  });

  it("classifies a ZERO-action runaway that crosses the cap as FAILED (gave_up), not a passed budget stop", async () => {
    // maxUsd:0 is deterministic: the first turn's usage accrues, then the cap check at the TOP of
    // the loop trips BEFORE the turn's click is ever executed → materialActions is still 0. This is
    // the exact runaway the cap exists to catch; it must surface as FAILED, never a passed lane.
    const provider = new RepeatProvider(usageTurn);
    const executor = new SignatureExecutor(["s0", "s1"]);

    const result = await runComputerUseLoop({
      instructions: "Any token usage on the first turn must trip the $0 cap before any material action.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      maxUsd: 0,
      estimateTurnCostUsd
    });

    expect(result.completionReason).toBe("gave_up");
    expect(result.status).toBe("abandoned");
    expect(result.trace.counts.materialActions).toBe(0);
    expect(result.reason).toContain("crossed execution.caps.maxUsd=$0");
    expect(result.reason).toContain("no material progress");
    // Tripped on turn 1, before a second provider turn was ever requested.
    expect(provider.seen).toHaveLength(1);
  });

  it("is a no-op when maxUsd is unset — the loop runs to its natural completion unchanged", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false, usage: { input: 100, output: 50 } },
      { actions: [], pendingSafetyChecks: [], done: true, message: "Done.", usage: { input: 100, output: 50 } }
    ]);
    const executor = new SignatureExecutor(["s0", "s1", "s2"]);

    const result = await runComputerUseLoop({
      instructions: "Finish naturally.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      // estimator present but no cap → the cap branch is never consulted.
      estimateTurnCostUsd
    });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("Done.");
    expect(result.trace.tokenUsage).toMatchObject({ input: 200, output: 100, total: 300 });
  });

  it("cannot trip on a null (unpriceable) estimate mid-run — it runs to natural completion", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false, usage: { input: 100, output: 50 } },
      { actions: [], pendingSafetyChecks: [], done: true, message: "Done.", usage: { input: 100, output: 50 } }
    ]);
    const executor = new SignatureExecutor(["s0", "s1", "s2"]);

    const result = await runComputerUseLoop({
      instructions: "Finish naturally.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      maxUsd: 0,
      // A vanished rate returns null; the cap must NOT abort on it (never a silent-zero abort).
      estimateTurnCostUsd: () => null
    });

    expect(result.completionReason).toBe("goal_satisfied");
  });
});

describe("dwell window (#510): the harness holds, looks, and requests no model turn", () => {
  const item = (text: string, signature: string) => ({
    screenshot: frame(),
    stateSignature: signature,
    url: "http://127.0.0.1:3000/",
    text
  });
  // A clock that only moves when the loop sleeps, so the window's frame count is exact.
  function heldClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }

  it("once its condition matches, holds for the window on the cadence, then hands control back with a hint", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false });
    const executor = new ObservationSequenceExecutor([
      item("Add a task", "s0"),
      item("1 item left", "s1"), // after turn 1: the dwell condition matches
      item("1 item left", "dwell-1"),
      item("1 item left", "dwell-2"),
      item("1 item left", "dwell-3"),
      item("1 item left", "after-dwell"),
      item("2 items left", "s2") // after turn 2: stopWhen
    ]);
    const clock = heldClock();
    const rec = recorder();
    const result = await runComputerUseLoop({
      instructions: "Add one task, then add another.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: clock.now,
      sleep: clock.sleep,
      writeScreenshot: rec.writeScreenshot,
      dwell: { when: { any: [{ id: "one-left", textIncludes: "1 item left" }] }, ms: 3_000, everyMs: 1_000, then: "continue" },
      stopWhen: { any: [{ id: "two-left", textIncludes: "2 items left" }] }
    });
    expect(result.status).toBe("passed");
    expect(result.reason).toBe("stopWhen matched two-left (textIncludes)");
    // Two model turns in all: one before the window, one after. None during it.
    expect(provider.seen).toHaveLength(2);
    const titles = result.trace.items.map((entry) => entry.title);
    const started = titles.indexOf("dwell window started");
    const completed = titles.indexOf("dwell window complete");
    expect(started).toBeGreaterThan(-1);
    expect(completed).toBeGreaterThan(started);
    const complete = result.trace.items[completed];
    expect(complete?.text).toContain("3 frame(s) over 3000ms");
    expect(complete?.text).toContain("no model turn was requested");
    // The frames were persisted on the cadence, named as dwell frames.
    expect(rec.written.map((entry) => entry.name).filter((name) => name.startsWith("dwell-"))).toEqual(["dwell-01.png", "dwell-02.png", "dwell-03.png"]);
    // The turn after the window carries the hint that time passed deliberately.
    expect(provider.seen[1]?.contextHint).toContain("held this page under observation for 3 seconds");
    // Nothing the page said leaks through the window's notices.
    expect(JSON.stringify(result.trace.items.filter((entry) => entry.kind === "notice"))).not.toContain("1 item left");
  });

  it("then: stop ends the session after the window with a reason that names the hold", async () => {
    const provider = new RepeatProvider({ actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false });
    const executor = new ObservationSequenceExecutor([
      item("Add a task", "s0"),
      item("1 item left", "s1"),
      item("1 item left", "dwell-1"),
      item("1 item left", "dwell-2"),
      item("1 item left", "after-dwell")
    ]);
    const clock = heldClock();
    const result = await runComputerUseLoop({
      instructions: "Add one task.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: clock.now,
      sleep: clock.sleep,
      dwell: { when: { any: [{ id: "one-left", textIncludes: "1 item left" }] }, ms: 2_000, everyMs: 1_000, then: "stop" }
    });
    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.reason).toBe("dwell window complete (2000ms held after turn 1)");
    expect(provider.seen).toHaveLength(1);
  });

  it("with no condition the window opens at the start, before the first model turn", async () => {
    const provider = new RepeatProvider({ actions: [], pendingSafetyChecks: [], done: true, message: "Nothing to do." });
    const executor = new ObservationSequenceExecutor([item("Dashboard", "s0"), item("Dashboard", "d1"), item("Dashboard", "d2"), item("Dashboard", "after")]);
    const clock = heldClock();
    const result = await runComputerUseLoop({
      instructions: "Watch the dashboard.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: clock.now,
      sleep: clock.sleep,
      dwell: { ms: 2_000, everyMs: 1_000, then: "continue" }
    });
    const titles = result.trace.items.map((entry) => entry.title);
    expect(titles.indexOf("dwell window complete")).toBeGreaterThan(-1);
    expect(result.trace.items[titles.indexOf("dwell window started")]?.text).toContain("at the start at turn 0");
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]?.contextHint).toContain("held this page under observation");
  });

  it("a window the session budget cannot hold is skipped and says so", async () => {
    const provider = new RepeatProvider({ actions: [], pendingSafetyChecks: [], done: true, message: "Done." });
    const executor = new ObservationSequenceExecutor([item("Dashboard", "s0")]);
    const clock = heldClock();
    const result = await runComputerUseLoop({
      instructions: "Watch the dashboard.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
      dwell: { ms: 60_000, everyMs: 10_000, then: "continue" }
    });
    const skipped = result.trace.items.find((entry) => entry.title === "dwell window skipped");
    expect(skipped?.text).toContain("session budget remained for a 60000ms window");
    expect(result.trace.items.some((entry) => entry.title === "dwell window started")).toBe(false);
  });
});
