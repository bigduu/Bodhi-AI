const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-tauri-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(__dirname, "../package.json"), path.join(root, "package.json"));
  fs.copyFileSync(path.join(__dirname, "tauri.cjs"), path.join(root, "scripts/tauri.cjs"));
  const observed = path.join(root, "observed.json");
  const record = (entry, args) => `require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({entry:${JSON.stringify(entry)},args:${args}})); process.exitCode=Number(process.env.BODHI_TEST_EXIT_CODE || 0);`;
  fs.writeFileSync(path.join(root, "scripts/tauri-dev.cjs"), `exports.runDevCommand=(args)=>{${record("owned-development", "args")}};`);
  const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, record("official-cli", "process.argv.slice(2)"));
  return { root, observed };
}

function invoke(f, args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: f.root, env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  return { result, observed: JSON.parse(fs.readFileSync(f.observed, "utf8")) };
}

test("development dispatch retains native options and literal cargo/application arguments", (t) => {
  const f = fixture(t);
  const args = ["--release", "--", "--", "a path with spaces", "$(literal)"];
  for (const global of [[], ["--verbose"], ["-vv"]]) {
    const { result, observed } = invoke(f, ["scripts/tauri.cjs", ...global, "dev", ...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(observed, { entry: "owned-development", args: [...global, ...args] });
  }
});

test("non-development commands retain official CLI arguments and failure status", (t) => {
  const f = fixture(t);
  for (const args of [["build", "--debug"], ["info"], ["--help"], ["--version"], ["plugin", "add", "dev"]]) {
    const { result, observed } = invoke(f, ["scripts/tauri.cjs", ...args], { BODHI_TEST_EXIT_CODE: "7" });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(observed, { entry: "official-cli", args });
  }
});

test("both npm spellings reach owned development with the same native arguments", {
  skip: !process.env.npm_execpath && "Run npm run test:build to exercise npm argument forwarding.",
}, (t) => {
  const f = fixture(t);
  const args = ["--release", "--", "--", "a path with spaces"];
  for (const command of [["tauri", "dev", "--", ...args], ["tauri:dev", "--", ...args]]) {
    const { result, observed } = invoke(f, [process.env.npm_execpath, "run", "--silent", ...command]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(observed, { entry: "owned-development", args });
  }
});

test("npm tauri build keeps the official CLI and development failures remain failures", {
  skip: !process.env.npm_execpath && "Run npm run test:build to exercise npm exit status forwarding.",
}, (t) => {
  const f = fixture(t);
  const { result, observed } = invoke(f, [process.env.npm_execpath, "run", "--silent", "tauri", "--", "build", "--debug"], { BODHI_TEST_EXIT_CODE: "9" });
  assert.equal(result.status, 9, result.stderr);
  assert.deepEqual(observed, { entry: "official-cli", args: ["build", "--debug"] });
  for (const command of [["tauri", "dev"], ["tauri:dev"]]) {
    const failure = invoke(f, [process.env.npm_execpath, "run", "--silent", ...command], { BODHI_TEST_EXIT_CODE: "8" });
    assert.equal(failure.result.status, 8, failure.result.stderr);
    assert.equal(failure.observed.entry, "owned-development");
  }
});
