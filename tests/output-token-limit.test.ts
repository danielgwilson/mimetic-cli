import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { parseLabConfig } from "../src/lab-config.js";
import { createOpenAiResponsesProvider, type FetchLike } from "../src/openai-responses-cu.js";
import { runCuaActorSession } from "../src/computer-use-actor.js";

const captured = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const pending = captured("openai-closing-report/pending-computer-call");
const incomplete = captured("openai-incomplete/reasoning-only");
const report = captured("openai-closing-report/typed-closing-report");
const screenshot = PNG.sync.write(new PNG({ width: 2, height: 2 }));
const request = { instructions: "Synthetic output-limit check.", observation: { screenshot, stateSignature: "fixture" } };
const signal = new AbortController().signal;
const lab = (actor: Record<string, unknown> = {}) => ({
  schema: "humanish.lab.v2", id: "output-limit", subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actors: [{ type: "openai-computer-use", maxOutputTokens: 16, ...actor }], execution: { target: "e2b-desktop" }
});
const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value });

describe("declared per-response output limit", () => {
  it.each([16, 1024, 128000])("parses positive integer %s", maxOutputTokens => {
    const parsed = parseLabConfig(lab({ maxOutputTokens }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.actors[0]?.maxOutputTokens).toBe(maxOutputTokens);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "16"])("rejects invalid value %s before a provider can be built", maxOutputTokens => {
    const parsed = parseLabConfig(lab({ maxOutputTokens }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("maxOutputTokens");
    expect(() => createOpenAiResponsesProvider({ apiKey: "synthetic", maxOutputTokens: maxOutputTokens as number })).toThrow("positive safe integer");
  });
  it.each(["local-agent", "scripted-browser", "codex-exec", "synthetic-persona"])("refuses unsupported actor %s", type => {
    const result = parseLabConfig(lab({ type }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("maxOutputTokens");
  });
  it("rejects custom in-process and lane/roster declarations instead of ignoring them", () => {
    for (const raw of [
      { ...lab(), subject: { source: "local-app" } },
      lab({ lanes: [{ id: "one", maxOutputTokens: 32 }] }),
      lab({ roster: [{ id: "one", count: 2, maxOutputTokens: 32 }] })
    ]) expect(parseLabConfig(raw).ok).toBe(false);
  });
  it("keeps the field on initial, continuation, policy fallback and HTTP retry requests", async () => {
    const bodies: Record<string, unknown>[] = [];
    // Deliberate transport-error controls use the already-tested provider policy messages;
    // successful response fixtures come from captured wire, not invented API responses.
    const errors: Record<number, [number, string]> = {
      2: [400, "Zero Data Retention is enabled for this org."],
      3: [400, "Your organization must be verified to generate reasoning summaries."],
      4: [429, "rate limited"]
    };
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const error = errors[bodies.length];
      return error ? { ok: false, status: error[0], text: async () => error[1], json: async () => ({}) } : ok(pending);
    };
    const provider = createOpenAiResponsesProvider({ apiKey: "synthetic", maxOutputTokens: 64, fetchFn, delayFn: async () => {} });
    await provider.nextTurn(request, signal);
    await provider.nextTurn(request, signal);
    expect(bodies).toHaveLength(5);
    expect(bodies.every(body => body.max_output_tokens === 64)).toBe(true);
    expect(bodies[1]?.previous_response_id).toBeDefined();
    expect(bodies[2]?.previous_response_id).toBeUndefined();
    expect(bodies[4]?.reasoning).not.toHaveProperty("summary");
    expect(provider.modelSettings?.maxOutputTokens).toBe(64);
  });
  it.each([16, 4096, undefined])("closing request respects the smaller bound; declared=%s", async maxOutputTokens => {
    const bodies: Record<string, unknown>[] = [];
    const provider = createOpenAiResponsesProvider({ apiKey: "synthetic", ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), fetchFn: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return ok(bodies.length === 1 ? pending : maxOutputTokens === 16 ? incomplete : report);
    } });
    await provider.nextTurn(request, signal);
    await provider.debrief!(request, signal);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.max_output_tokens).toBe(maxOutputTokens);
    expect(bodies[1]?.max_output_tokens).toBe(Math.min(maxOutputTokens ?? 1024, 1024));
    expect(bodies[1]?.tool_choice).toBe("none");
    if (maxOutputTokens === undefined) {
      expect(bodies[0]).not.toHaveProperty("max_output_tokens");
      expect(provider.modelSettings).not.toHaveProperty("maxOutputTokens");
    }
  });
  it("records the effective setting and stops captured token exhaustion before actions or debrief", async () => {
    let calls = 0;
    let actions = 0;
    const result = await runCuaActorSession({
      instructions: request.instructions, persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" }, timeoutMs: 1000,
      executor: { observe: async () => request.observation, execute: async () => { actions += 1; } },
      openai: { apiKey: "synthetic", maxOutputTokens: 16, fetchFn: async (_url, init) => {
        expect(JSON.parse(init.body).max_output_tokens).toBe(16); calls += 1; return ok(incomplete);
      } }
    });
    expect(result.trace.modelSettings).toEqual({ reasoningEffort: "medium", maxOutputTokens: 16 });
    expect(result.status).toBe("incomplete");
    expect(result.completionReason).toBe("budget_reached");
    expect(result.trace.tokenUsage?.output).toBe(16);
    expect(calls).toBe(1);
    expect(actions).toBe(0);
  });
});
