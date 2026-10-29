const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { signingIdentity, targetDetails, treeHash, verifyArchitecture, verifyRuntime } = require("./browser-runtime.cjs");
const { LOCK, sha256File } = require("./browser-runtime.cjs");

test("nested browser code uses the outer release signing identity", () => {
  const previousApple = process.env.APPLE_SIGNING_IDENTITY;
  const previousRelease = process.env.BODHI_BROWSER_RUNTIME_RELEASE_BUILD;
  try {
    delete process.env.APPLE_SIGNING_IDENTITY;
    process.env.BODHI_BROWSER_RUNTIME_RELEASE_BUILD = "0";
    assert.equal(signingIdentity(), null);
    process.env.BODHI_BROWSER_RUNTIME_RELEASE_BUILD = "1";
    const configured = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src-tauri", "tauri.conf.json"), "utf8")).bundle.macOS.signingIdentity;
    assert.equal(signingIdentity(), configured);
    process.env.APPLE_SIGNING_IDENTITY = "-";
    assert.equal(signingIdentity(), "-");
  } finally {
    if (previousApple === undefined) delete process.env.APPLE_SIGNING_IDENTITY;
    else process.env.APPLE_SIGNING_IDENTITY = previousApple;
    if (previousRelease === undefined) delete process.env.BODHI_BROWSER_RUNTIME_RELEASE_BUILD;
    else process.env.BODHI_BROWSER_RUNTIME_RELEASE_BUILD = previousRelease;
  }
});

test("browser archives are pinned for every desktop release target", () => {
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc"]) {
    const details = targetDetails(target);
    assert.match(details.nodeSha256, /^[a-f0-9]{64}$/);
    assert.match(details.browserSha256, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => targetDetails("../unknown"), /Unsupported/);
});

test("browser executable architecture must match the bundle target", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-browser-mach-test-"));
  try {
    const binary = path.join(directory, "browser");
    const header = Buffer.alloc(8);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(0x0100000c, 4);
    fs.writeFileSync(binary, header);
    assert.doesNotThrow(() => verifyArchitecture(binary, "aarch64-apple-darwin"));
    assert.throws(() => verifyArchitecture(binary, "x86_64-apple-darwin"), /does not contain/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("runtime inventory changes on tampering and rejects symlink escapes", { skip: process.platform === "win32" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-browser-tree-test-"));
  const linkedRoot = `${directory}-link`;
  try {
    fs.writeFileSync(path.join(directory, "host.cjs"), "one");
    const first = treeHash(directory);
    fs.writeFileSync(path.join(directory, "host.cjs"), "two");
    assert.notEqual(treeHash(directory), first);
    fs.symlinkSync(path.join(directory, "host.cjs"), path.join(directory, "alias.cjs"));
    assert.throws(() => treeHash(directory), /symlink/);
    fs.symlinkSync(directory, linkedRoot, "dir");
    assert.throws(() => verifyRuntime(linkedRoot, "aarch64-apple-darwin"), /owned directory/);
  } finally {
    fs.rmSync(linkedRoot, { force: true });
    fs.rmSync(directory, { recursive: true });
  }
});

function runtimeFixture(t, lock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-browser-selected-lock-")), target = "x86_64-unknown-linux-gnu";
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const save = (name, data, mode = 0o644) => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { mode }); return file;
  };
  const elf = Buffer.alloc(20); elf.write("\x7fELF"); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(0x3e, 18);
  save("node/node", elf, 0o755); save("node/LICENSE", "fixture license"); save("host.cjs", "fixture host");
  save(`chromium/chrome-headless-shell-${lock.targets[target].platform}/chrome-headless-shell`, elf, 0o755);
  save("node_modules/playwright-core/package.json", JSON.stringify({ version: lock.playwrightCoreVersion }));
  save("node_modules/playwright-core/browsers.json", JSON.stringify({ browsers: [{ name: "chromium-headless-shell", revision: lock.chromiumRevision, browserVersion: lock.chromiumVersion }] }));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-browser-selected-host-")); t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, "host.cjs"), "fixture host"); fs.writeFileSync(path.join(source, "package-lock.json"), "fixture lock");
  save("receipt.json", JSON.stringify({ schemaVersion: 1, target, nodeVersion: lock.nodeVersion, playwrightCoreVersion: lock.playwrightCoreVersion,
    chromiumVersion: lock.chromiumVersion, chromiumRevision: lock.chromiumRevision, hostSha256: sha256File(path.join(source, "host.cjs")),
    packageLockSha256: sha256File(path.join(source, "package-lock.json")), filesSha256: treeHash(root) }));
  return { root, source, target };
}
test("C static verifier accepts selected S lock data without mutating C defaults or another S context", t => {
  const unchanged = JSON.stringify(LOCK), a = structuredClone(LOCK), b = structuredClone(LOCK);
  Object.assign(a, { nodeVersion: "99.0.1", playwrightCoreVersion: "99.1.1", chromiumVersion: "199.0.1", chromiumRevision: "9991" });
  Object.assign(b, { nodeVersion: "99.0.2", playwrightCoreVersion: "99.1.2", chromiumVersion: "199.0.2", chromiumRevision: "9992" });
  a.targets["x86_64-unknown-linux-gnu"].platform = "selected-a"; b.targets["x86_64-unknown-linux-gnu"].platform = "selected-b";
  const first = runtimeFixture(t, a), second = runtimeFixture(t, b), legacy = runtimeFixture(t, LOCK);
  for (const [fixture, selected] of [[first, a], [second, b], [first, a]]) assert.equal(verifyRuntime(fixture.root, fixture.target, fixture.source, selected).nodeVersion, selected.nodeVersion);
  assert.throws(() => verifyRuntime(first.root, first.target, first.source));
  assert.throws(() => verifyRuntime(first.root, first.target, first.source, b));
  assert.equal(verifyRuntime(legacy.root, legacy.target, legacy.source).nodeVersion, LOCK.nodeVersion);
  assert.equal(JSON.stringify(LOCK), unchanged);
});
test("selected browser lock refuses wrong version, unknown schema and escaping platform data", t => {
  const selected = structuredClone(LOCK), fixture = runtimeFixture(t, selected);
  const wrong = structuredClone(selected); wrong.nodeVersion = "0.0.0";
  assert.throws(() => verifyRuntime(fixture.root, fixture.target, fixture.source, wrong), /receipt/);
  wrong.schemaVersion = 2; assert.throws(() => verifyRuntime(fixture.root, fixture.target, fixture.source, wrong), /Unsupported/);
  wrong.schemaVersion = 1; wrong.targets[fixture.target].platform = "../outside";
  assert.throws(() => verifyRuntime(fixture.root, fixture.target, fixture.source, wrong), /platform directory/);
});
