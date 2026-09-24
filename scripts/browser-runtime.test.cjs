const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { signingIdentity, targetDetails, treeHash, verifyArchitecture, verifyRuntime } = require("./browser-runtime.cjs");

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

test("macOS browser archives are pinned for both published CPU targets", () => {
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const details = targetDetails(target);
    assert.match(details.nodeSha256, /^[a-f0-9]{64}$/);
    assert.match(details.browserSha256, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => targetDetails("x86_64-unknown-linux-gnu"), /Unsupported/);
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

test("runtime inventory changes on tampering and rejects symlink escapes", () => {
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
