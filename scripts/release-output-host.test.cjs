"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("static output verification reads the browser host from its verified subdirectory", () => {
  const root = "/product", source = "a".repeat(40), lock = { schemaVersion: 1 }, calls = [];
  const sandbox = { module: { exports: {} }, __dirname, process, console, Buffer, require(name) {
    if (name === "node:child_process") return { execFileSync(program, args, options) {
      assert.equal(program, "git"); assert.deepEqual(Array.from(args), ["show", `${source}:scripts/browser-runtime.lock.json`]);
      assert.equal(options.cwd, root); return JSON.stringify(lock);
    } };
    if (name === "./lotus-dist.cjs") return { resolveSource() { return {}; }, verifyStaged() { return {}; } };
    if (name === "./bamboo-sidecar.cjs") return { installedRelease() { return { hostDirectory: path.join(root, "cache", "browser-host") }; } };
    if (name === "./browser-runtime.cjs") return { verifyRuntime(runtime, target, host, selected) {
      calls.push({ runtime, target, host, selected }); throw Error("stop after runtime inputs");
    } };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "release-output.cjs"), "utf8"), sandbox);
  assert.throws(() => sandbox.module.exports.staticOutputs(root, { source }, "aarch64-apple-darwin", root), /stop after runtime inputs/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, path.join(root, "cache", "browser-host", "browser-runtime"));
  assert.equal(JSON.stringify(calls[0].selected), JSON.stringify(lock));
});
