// Compiled CLI/default-loader regression for #708 and the deterministic part of #581.
// Run after build. No keys, provider allocation, model calls, or forced product exit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist/cli.js");
const preload = join(root, "tests/fixtures/e2b-desktop-startup/fault-preload.mjs");
const lab = (await readFile(join(root, "humanish/labs/terminal-product-demo.yaml"), "utf8"))
  .replace("mode: dry-run", "mode: live");

for (const phase of ["Xvfb", "startxfce4"]) {
  const cwd = await mkdtemp(join(tmpdir(), "humanish-startup-exit-"));
  try {
    await writeFile(join(cwd, "lab.yaml"), lab);
    const proofPath = join(cwd, "proof.json");
    const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--import", preload,
      cli, "lab", "run", "lab.yaml", "--cwd", cwd, "--json", "--no-open"], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
      // No inherited credentials, key discovery, adoption telemetry, or local-agent invocation.
      env: { PATH: process.env.PATH, DO_NOT_TRACK: "1", HUMANISH_STRICT_KEYS: "1",
        OPENAI_API_KEY: "synthetic-no-provider-key", E2B_API_KEY: "synthetic-no-sandbox-key",
        HUMANISH_PROOF_CLI: cli, HUMANISH_PROOF_RESULT: proofPath, HUMANISH_PROOF_PHASE: phase }
    });
    let stdout = "", stderr = "", jsonAt, timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      try { JSON.parse(stdout); jsonAt ??= performance.now(); } catch { /* Incomplete JSON. */ }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    // Parent-only safety bound. A fired watchdog fails the proof; the CLI must exit naturally.
    const watchdog = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20000);
    let closed;
    try {
      closed = await new Promise((done, fail) => {
        child.on("error", fail);
        child.on("close", (code, signal) => done({ code, signal, at: performance.now() }));
      });
    } finally { clearTimeout(watchdog); }
    assert.equal(timedOut, false, `CLI did not exit naturally (${phase}): ${stderr}`);
    assert.equal(closed.code, 2, stderr);
    assert.equal(closed.signal, null);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "HUMANISH_TERMINAL_LAB_FAILED");
    assert.match(result.error.message, /synthetic desktop startup failure/);
    assert.equal(result.observer.ok, true, "failed-session evidence must verify and render");
    const proof = JSON.parse(await readFile(proofPath, "utf8"));
    assert.deepEqual(proof.networkAttempts, []);
    assert.equal(proof.instances, 1);
    assert.deepEqual(proof.killed, [1]);
    assert.equal(proof.disconnected, phase === "Xvfb" ? 0 : 1);
    assert.equal(proof.code, 2);
    assert.ok(proof.jsonAtNs !== null, "CLI final JSON write was observed");
    const jsonToExitMs = Number(BigInt(proof.exitAtNs) - BigInt(proof.jsonAtNs)) / 1e6;
    assert.ok(jsonToExitMs < 2000, `JSON write to natural exit took ${jsonToExitMs}ms`);
    assert.ok(jsonAt !== undefined && closed.at - jsonAt < 2000, "CLI remained alive after final JSON arrived");
    assert.deepEqual(proof.resources.filter((resource) => resource !== "PipeWrap"), []);
    console.log(`terminal startup ${phase}: failure evidence verified; natural exit ${jsonToExitMs.toFixed(1)}ms after JSON; no network`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
