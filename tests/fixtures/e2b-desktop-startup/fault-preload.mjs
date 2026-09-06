// Real installed SDK, debug constructor, and local method faults; no provider wire fixtures.
// Used only by scripts/terminal-startup-exit-proof.mjs against the freshly compiled CLI.
import { writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const proof = { networkAttempts: [], instances: 0, killed: [], disconnected: 0, jsonAtNs: null };
const forbidden = (name) => function () {
  proof.networkAttempts.push(name);
  throw new Error(`Network forbidden in startup proof: ${name}`);
};
globalThis.fetch = forbidden("fetch");
http.request = forbidden("http.request");
http.get = forbidden("http.get");
https.request = forbidden("https.request");
https.get = forbidden("https.get");
net.Socket.prototype.connect = forbidden("net.Socket.connect");
tls.connect = forbidden("tls.connect");
syncBuiltinESMExports();

const requireFromCli = createRequire(process.env.HUMANISH_PROOF_CLI);
const { Sandbox } = await import(pathToFileURL(requireFromCli.resolve("@e2b/desktop")).href);
const create = Sandbox.create;
const start = Sandbox.prototype._start;
const kill = Sandbox.prototype.kill;
const instances = new WeakMap();
Sandbox.createSandbox = forbidden("SDK.createSandbox");
Sandbox.list = forbidden("SDK.list");
Sandbox.create = function (templateOrOptions, options) {
  return typeof templateOrOptions === "string"
    ? Reflect.apply(create, this, [templateOrOptions, { ...options, debug: true }])
    : Reflect.apply(create, this, [{ ...templateOrOptions, debug: true }]);
};
Sandbox.prototype._start = function (...args) {
  // Base SDK has constructed the instance, and Humanish has captured its kill authority.
  const instance = ++proof.instances;
  instances.set(this, instance);
  this.commands.run = async (command) => {
    if (command.includes(process.env.HUMANISH_PROOF_PHASE)) throw new Error("synthetic desktop startup failure");
    return { exitCode: 0, stdout: "", stderr: "", pid: instance,
      disconnect: async () => { proof.disconnected++; } };
  };
  return Reflect.apply(start, this, args);
};
Sandbox.prototype.kill = async function (...args) {
  proof.killed.push(instances.get(this));
  return Reflect.apply(kill, this, args); // Real SDK debug kill; never a provider request.
};
const write = process.stdout.write;
process.stdout.write = function (chunk, ...args) {
  try {
    if (JSON.parse(String(chunk)).schema === "humanish.terminal-lab-result.v1") {
      proof.jsonAtNs = String(process.hrtime.bigint());
    }
  } catch { /* Preserve unrelated stdout writes. */ }
  return Reflect.apply(write, this, [chunk, ...args]);
};
process.on("exit", (code) => {
  writeFileSync(process.env.HUMANISH_PROOF_RESULT, JSON.stringify({ ...proof, code,
    exitAtNs: String(process.hrtime.bigint()), resources: process.getActiveResourcesInfo() }));
});
