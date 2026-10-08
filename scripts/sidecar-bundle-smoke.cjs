// Exercise the native sidecar's real entry point and owned actor transport.
// Echo uses no model/provider credential; every data path belongs to this smoke.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ROOT } = require("./lotus-dist.cjs");
const { verifySidecar } = require("./verify-assembly.cjs");
const { verifyArchitecture } = require("./browser-runtime.cjs");

const target = process.argv[2];
const nativeArch = target?.startsWith("aarch64-") ? "arm64" : target?.startsWith("x86_64-") ? "x64" : null;
assert.equal(process.arch, nativeArch, "Sidecar smoke must run on its native architecture");
const staged = verifySidecar(ROOT, target);
const binary = target.includes("apple-darwin")
  ? path.join(ROOT, "target", target, "release/bundle/macos/Bodhi AI.app/Contents/MacOS/bamboo")
  : staged.binary;
const metadata = fs.lstatSync(binary);
assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size >= 65536);
verifyArchitecture(binary, target);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-sidecar-smoke-"));
const data = path.join(directory, "bamboo");
const workspace = path.join(directory, "workspace");
fs.mkdirSync(data);
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(data, "config.json"), "{}\n");
const marker = "bodhi-bundled-actor-transport-ok";
const environment = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LANG"]
  .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
environment.BAMBOO_DATA_DIR = data;
environment.BAMBOO_JIANDU_DATA_DIR = path.join(directory, "jiandu");
let childPid;
let parentFailed = false;
try {
  const result = spawnSync(binary, ["-p", marker, "--echo", "--stream-json", "--data-dir", data, "--workspace", workspace], {
    cwd: workspace, env: environment, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024,
  });
  parentFailed = Boolean(result.error || result.status !== 0);
  childPid = Number((result.stderr || "").match(/actor registered \(pid (\d+),/)?.[1]);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(childPid > 0, "The packaged sidecar did not register a real owned worker");
  assert.match(result.stderr, /completed/);
  assert.ok(result.stdout.includes(marker), "The owned actor did not echo its assignment");
  const receipt = { target, binary, bytes: metadata.size, transport: "owned-actor-echo", processExit: result.status, externalStackOverride: false, providerCredentials: false };
  if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  // A failed parent timeout must not leave the worker it registered behind.
  if (parentFailed && childPid > 0) {
    try { process.kill(childPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
