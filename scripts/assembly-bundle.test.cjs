const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { NEXT_PACKAGE, LEGACY_PACKAGE, contentHash, inventory } = require("./lotus-dist.cjs");
const { LOCK, browserPaths, sha256File, treeHash, verifyRuntime } = require("./browser-runtime.cjs");
const { verifyBundledFrontend, verifyBundledRuntime, verifyDebugAssembly } = require("./verify-assembly.cjs");

function write(file, value, executable = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  if (executable) fs.chmodSync(file, 0o755);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-bundle-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Bodhi AI.app");
  const frontend = path.join(app, "Contents", "Resources", "frontend");
  const dist = path.join(frontend, "dist");
  write(path.join(dist, "index.html"), '<script src="assets/app.js"></script>');
  write(path.join(dist, "assets/app.js"), 'import("./lazy.js");');
  write(path.join(dist, "assets/lazy.js"), "export const value = 'accepted';");
  const files = inventory(dist);
  const receipt = { schemaVersion: 2, mode: "package", packageName: NEXT_PACKAGE, version: "2026.10.12", sourceRevision: "a".repeat(40), sourceDirty: false, contentHash: contentHash(files), files };
  write(path.join(frontend, "receipt.json"), receipt);
  return { root, app, frontend, dist, receipt };
}

test("final app checks lazy frontend resources even when its receipt is unchanged", (t) => {
  const { app, dist, receipt } = fixture(t);
  assert.doesNotThrow(() => verifyBundledFrontend(app, receipt));
  write(path.join(dist, "assets/lazy.js"), "export const value = 'stale';");
  assert.throws(() => verifyBundledFrontend(app, receipt), /different Lotus frontend assets/);
});

test("a coherent older frontend cannot replace the selected app input", (t) => {
  const { app, frontend, dist, receipt } = fixture(t);
  write(path.join(dist, "assets/lazy.js"), "export const value = 'old';");
  const files = inventory(dist);
  write(path.join(frontend, "receipt.json"), { ...receipt, contentHash: contentHash(files), files });
  assert.throws(() => verifyBundledFrontend(app, receipt), /different Lotus frontend receipt/);
});

test("an undeclared app resource fails the final frontend inventory", (t) => {
  const { app, dist, receipt } = fixture(t);
  write(path.join(dist, "assets/unaccepted.js"), "extra");
  assert.throws(() => verifyBundledFrontend(app, receipt), /different Lotus frontend assets/);
});

test("final frontend rejects linked receipts and resource directories", { skip: process.platform === "win32" }, (t) => {
  const { root, app, frontend, receipt } = fixture(t);
  const receiptPath = path.join(frontend, "receipt.json");
  const movedReceipt = path.join(root, "receipt.json");
  fs.renameSync(receiptPath, movedReceipt);
  fs.symlinkSync(movedReceipt, receiptPath);
  assert.throws(() => verifyBundledFrontend(app, receipt), /regular receipt/);
  fs.unlinkSync(receiptPath);
  fs.renameSync(movedReceipt, receiptPath);
  const movedFrontend = path.join(root, "frontend");
  fs.renameSync(frontend, movedFrontend);
  fs.symlinkSync(movedFrontend, frontend, "dir");
  assert.throws(() => verifyBundledFrontend(app, receipt), /owned directory/);
});

test("legacy rollback accepts its receipt without adding a second frontend", (t) => {
  const { app, frontend, dist, receipt } = fixture(t);
  const legacy = { ...receipt, packageName: LEGACY_PACKAGE };
  write(path.join(frontend, "receipt.json"), legacy);
  fs.rmSync(dist, { recursive: true });
  assert.doesNotThrow(() => verifyBundledFrontend(app, legacy));
  write(path.join(dist, "index.html"), "unexpected second UI");
  assert.throws(() => verifyBundledFrontend(app, legacy), /must not carry a second Tauri frontend/);
});

function runtimeFixture(directory) {
  const target = "x86_64-unknown-linux-gnu";
  const { node, host, browser } = browserPaths(directory, target);
  // The real inventory/architecture verifier checks these inert ELF fixtures;
  // no fake Node or browser is ever executed and no signing command is needed.
  const header = Buffer.alloc(20);
  header.write("\x7fELF");
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(0x3e, 18);
  write(node, header, true);
  write(browser, header, true);
  write(host, "accepted browser host");
  write(path.join(directory, "node/LICENSE"), "fixture license");
  write(path.join(directory, "package-lock.json"), {});
  write(path.join(directory, "node_modules/playwright-core/package.json"), { version: LOCK.playwrightCoreVersion });
  write(path.join(directory, "node_modules/playwright-core/browsers.json"), { browsers: [{ name: "chromium-headless-shell", revision: LOCK.chromiumRevision, browserVersion: LOCK.chromiumVersion }] });
  const receipt = { schemaVersion: 1, target, nodeVersion: LOCK.nodeVersion, playwrightCoreVersion: LOCK.playwrightCoreVersion, chromiumVersion: LOCK.chromiumVersion, chromiumRevision: LOCK.chromiumRevision, signingIdentity: null, hostSha256: sha256File(host), packageLockSha256: sha256File(path.join(directory, "package-lock.json")), filesSha256: treeHash(directory) };
  write(path.join(directory, "receipt.json"), receipt);
  return { target, receipt, host };
}

test("a self-consistent old browser host still fails the selected bundle input", (t) => {
  const { root } = fixture(t);
  const staged = path.join(root, "staged-runtime");
  const bundled = path.join(root, "bundled-runtime");
  const { target, receipt } = runtimeFixture(staged);
  fs.cpSync(staged, bundled, { recursive: true });
  assert.doesNotThrow(() => verifyBundledRuntime(bundled, staged, target));
  const host = browserPaths(bundled, target).host;
  write(host, "older but internally consistent host");
  write(path.join(bundled, "receipt.json"), { ...receipt, hostSha256: sha256File(host), filesSha256: treeHash(bundled) });
  assert.doesNotThrow(() => verifyRuntime(bundled, target));
  assert.throws(() => verifyBundledRuntime(bundled, staged, target), /exact staged browser runtime/);
});

test("bundle verification also binds the recorded signing identity", (t) => {
  const { root } = fixture(t);
  const staged = path.join(root, "staged-runtime");
  const bundled = path.join(root, "bundled-runtime");
  const { target, receipt } = runtimeFixture(staged);
  fs.cpSync(staged, bundled, { recursive: true });
  write(path.join(bundled, "receipt.json"), { ...receipt, signingIdentity: "different-build-identity" });
  assert.doesNotThrow(() => verifyRuntime(bundled, target));
  assert.throws(() => verifyBundledRuntime(bundled, staged, target), /exact staged browser runtime/);
});

function debugFixture(t) {
  const { root, app, receipt } = fixture(t);
  const target = "x86_64-unknown-linux-gnu";
  const directory = path.join(root, "target", target, "debug");
  fs.mkdirSync(directory, { recursive: true });
  fs.cpSync(path.join(app, "Contents", "Resources", "frontend"), path.join(directory, "frontend"), { recursive: true });
  const binary = Buffer.alloc(65536);
  binary.write("\x7fELF");
  binary[4] = 2;
  binary[5] = 1;
  binary.writeUInt16LE(0x3e, 18);
  write(path.join(root, "src-tauri", "binaries", `bamboo-${target}`), binary, true);
  write(path.join(directory, "bamboo"), binary, true);
  const stagedRuntime = path.join(root, "src-tauri", "browser-runtime");
  runtimeFixture(stagedRuntime);
  fs.cpSync(stagedRuntime, path.join(directory, "browser-runtime"), { recursive: true });
  return { root, target, directory, receipt };
}

test("feature E2E verifies Cargo's debug resources without an installer or release bundle", (t) => {
  const { root, target, directory, receipt } = debugFixture(t);
  assert.deepEqual(verifyDebugAssembly(root, target, receipt), {
    binary: path.join(directory, "bamboo"),
    staticDirectory: path.join(directory, "frontend", "dist"),
    runtime: path.join(directory, "browser-runtime"),
  });
  assert.equal(fs.existsSync(path.join(root, "target", target, "release")), false);
});

for (const [name, mutate, error] of [
  ["a changed copied sidecar", (f) => {
    const binary = path.join(f.directory, "bamboo");
    const bytes = fs.readFileSync(binary); bytes[100] = 1; fs.writeFileSync(binary, bytes);
  }, /sidecar differs/],
  ["an unchanged receipt with changed frontend bytes", (f) => write(path.join(f.directory, "frontend", "dist", "assets", "lazy.js"), "changed"), /different Lotus frontend assets/],
  ["a coherent old frontend", (f) => {
    const directory = path.join(f.directory, "frontend");
    write(path.join(directory, "receipt.json"), { ...f.receipt, sourceRevision: "b".repeat(40) });
  }, /different Lotus frontend receipt/],
  ["an old browser receipt", (f) => {
    const file = path.join(f.directory, "browser-runtime", "receipt.json");
    const receipt = JSON.parse(fs.readFileSync(file));
    write(file, { ...receipt, signingIdentity: "different" });
  }, /exact staged browser runtime/],
  ["missing Cargo output", (f) => fs.rmSync(f.directory, { recursive: true }), /ENOENT/],
]) test(`feature E2E rejects ${name} instead of using staged or release fallbacks`, (t) => {
  const f = debugFixture(t);
  mutate(f);
  assert.throws(() => verifyDebugAssembly(f.root, f.target, f.receipt), error);
});

test("feature E2E rejects a linked debug output", { skip: process.platform === "win32" }, (t) => {
  const f = debugFixture(t);
  const moved = path.join(f.root, "other-debug");
  fs.renameSync(f.directory, moved);
  fs.symlinkSync(moved, f.directory, "dir");
  assert.throws(() => verifyDebugAssembly(f.root, f.target, f.receipt), /real Cargo output/);
});
