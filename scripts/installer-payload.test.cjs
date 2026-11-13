"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { treeHash } = require("./browser-runtime.cjs");
const { inventory, contentHash, NEXT_PACKAGE } = require("./lotus-dist.cjs");

const LINUX = "aarch64-unknown-linux-gnu";
const WINDOWS = "aarch64-pc-windows-msvc";

function elf(machine = 0xb7, size = 64) {
  const header = Buffer.alloc(size);
  Buffer.from("7f454c46020101", "hex").copy(header);
  header.writeUInt16LE(machine, 18);
  return header;
}

function pe(machine = 0xaa64) {
  const header = Buffer.alloc(70);
  header.write("MZ");
  header.writeUInt32LE(64, 0x3c);
  header.write("PE\0\0", 64);
  header.writeUInt16LE(machine, 68);
  return header;
}

function save(root, name, content, mode = 0o644) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  return file;
}

function fixture(t, format) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bodhi-payload-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = format === "nsis" ? WINDOWS : LINUX;
  const extension = format === "nsis" ? ".exe" : "";
  const appDir = path.join(root, "Bodhi AI.AppDir");
  const fixtureTree = format === "appimage" ? appDir : path.join(root, "installer-layout");
  const bin = format === "nsis" ? "" : "usr/bin";
  const resources = path.join(fixtureTree, format === "nsis" ? "" : "usr/lib/Bodhi AI");
  const executable = format === "nsis" ? pe() : elf();
  const shell = save(root, "original-bodhi", Buffer.concat([executable, Buffer.from("shell")]), 0o755);
  const sidecar = save(root, "original-bamboo", Buffer.concat([executable, Buffer.from("sidecar")]), 0o755);
  const shellPayload = save(fixtureTree, path.join(bin, "bodhi" + extension), fs.readFileSync(shell), 0o755);
  const sidecarPayload = save(fixtureTree, path.join(bin, "bamboo" + extension), fs.readFileSync(sidecar), 0o755);
  const runtime = path.join(resources, "browser-runtime");
  const platform = format === "nsis" ? "win-arm64" : "linux-arm64";
  const lock = { schemaVersion: 1, nodeVersion: "24.0.0", playwrightCoreVersion: "1.0.0", chromiumVersion: "140.0.0.1",
    chromiumRevision: "1", targets: { [target]: { platform, nodeSha256: "a".repeat(64), browserSha256: "b".repeat(64) } } };
  save(runtime, "node/node" + extension, executable, 0o755);
  save(runtime, "node/LICENSE", "license");
  save(runtime, "host.cjs", "host");
  save(runtime, path.join("chromium", "chrome-headless-shell-" + platform, "chrome-headless-shell" + extension), executable, 0o755);
  save(runtime, "node_modules/playwright-core/package.json", JSON.stringify({ version: lock.playwrightCoreVersion }));
  save(runtime, "node_modules/playwright-core/browsers.json", JSON.stringify({ browsers: [
    { name: "chromium-headless-shell", revision: lock.chromiumRevision, browserVersion: lock.chromiumVersion },
  ] }));
  const { nodeVersion, playwrightCoreVersion, chromiumVersion, chromiumRevision } = lock;
  save(runtime, "receipt.json", JSON.stringify({ schemaVersion: 1, target, nodeVersion, playwrightCoreVersion, chromiumVersion,
    chromiumRevision, filesSha256: treeHash(runtime) }));
  const browserRoot = path.join(root, "staged-runtime");
  fs.cpSync(runtime, browserRoot, { recursive: true });
  const frontend = path.join(resources, "frontend");
  save(frontend, "dist/index.html", "frontend");
  const files = inventory(path.join(frontend, "dist"));
  const frontendReceipt = { packageName: NEXT_PACKAGE, files, contentHash: contentHash(files) };
  save(frontend, "receipt.json", JSON.stringify(frontendReceipt));
  const launcher = elf(0xb7, 164);
  launcher.write("AI\x02", 8, "ascii");
  launcher.writeBigUInt64LE(64n, 40);
  launcher.writeUInt16LE(64, 58);
  launcher.writeUInt16LE(1, 60);
  launcher.writeBigUInt64LE(152n, 88);
  launcher.writeBigUInt64LE(8n, 96);
  launcher.write("hsqs", 160);
  const file = save(root, "candidate", format === "appimage" ? launcher : "opaque package fixture");
  return { fixtureTree, runtime, frontend, shellPayload, sidecarPayload,
    input: { format, file, target, shell, sidecar, browserRoot, browserLock: lock, frontendReceipt, appDir } };
}

function verifier(t, fixture, transform = () => {}) {
  const calls = [];
  const sandbox = { Buffer, process, module: { exports: {} }, require: name => name === "node:child_process"
    ? { execFileSync(program, args, options) {
      calls.push({ program, args, options });
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.PATH, "tool-path");
      if (program === "objcopy") {
        const input = fs.readFileSync(args[2]);
        fs.writeFileSync(args[1].slice(".text=".length), input.subarray(64, 69));
        return;
      }
      const root = fixture.input.format === "appimage" ? path.join(options.cwd, "squashfs-root") : options.cwd;
      fs.cpSync(fixture.fixtureTree, root, { recursive: true });
      transform(root);
    } } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "installer-payload.cjs"), "utf8"), sandbox);
  t.after(() => {
    for (const { options } of calls) assert.equal(fs.existsSync(options.cwd), false, "extraction directory was retained");
  });
  return { calls, verify: () => sandbox.module.exports.verifyInstallerPayload(fixture.input, { PATH: "tool-path", GH_TOKEN: "unused" }) };
}

for (const [format, program] of [["deb", "dpkg-deb"], ["rpm", "bash"], ["nsis", "7z"]]) {
  test(format + " verifies both native executables and exact browser and frontend payloads", t => {
    const { calls, verify } = verifier(t, fixture(t, format));
    verify();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].program, program);
  });
}

test("NSIS rejects a foreign machine and a same-machine sidecar with different bytes", t => {
  const installer = fixture(t, "nsis");
  const { verify } = verifier(t, installer);
  fs.writeFileSync(installer.sidecarPayload, pe(0x8664));
  assert.throws(verify, /does not contain the aarch64-pc-windows-msvc CPU architecture/);
  fs.writeFileSync(installer.sidecarPayload, pe());
  assert.throws(verify, /Installed bamboo differs from the verified input/);
});

test("the package browser tree must match the original receipt even if the new receipt validates", t => {
  const installer = fixture(t, "deb");
  const { verify } = verifier(t, installer);
  fs.appendFileSync(path.join(installer.runtime, "host.cjs"), "modified");
  assert.throws(verify, /Browser runtime receipt or file inventory/);
  const receipt = path.join(installer.runtime, "receipt.json");
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), filesSha256: treeHash(installer.runtime) }));
  assert.throws(verify, /does not contain the exact staged browser runtime/);
});

test("the package frontend must carry the files from its verified staged receipt", t => {
  const installer = fixture(t, "rpm");
  fs.appendFileSync(path.join(installer.frontend, "dist/index.html"), "modified");
  assert.throws(verifier(t, installer).verify, /different Lotus frontend assets/);
});

test("AppImage checks its Type 2 payload offset, built AppDir and original executable code", t => {
  const installer = fixture(t, "appimage");
  fs.appendFileSync(installer.shellPayload, "RPATH fixture");
  const { calls, verify } = verifier(t, installer);
  verify();
  assert.equal(calls[0].program, "unsquashfs");
  assert.equal(calls[0].args[calls[0].args.indexOf("-offset") + 1], "160");
  const wrongAppDir = verifier(t, installer, root => fs.appendFileSync(path.join(root, "usr/bin/bodhi"), "other bytes"));
  assert.throws(wrongAppDir.verify, /AppImage bodhi differs from its built AppDir/);
  const alteredCode = fs.readFileSync(installer.shellPayload);
  alteredCode[64] ^= 1;
  fs.writeFileSync(installer.shellPayload, alteredCode);
  assert.throws(verify, /AppImage bodhi code differs from the verified input/);
  const brokenLauncher = fs.readFileSync(installer.input.file);
  brokenLauncher.writeBigUInt64LE(2n ** 60n, 40);
  fs.writeFileSync(installer.input.file, brokenLauncher);
  const previousCalls = calls.length;
  assert.throws(verify, /Invalid AppImage ELF section table/);
  assert.equal(calls.length, previousCalls);
});

test("package extraction refuses linked resource directories", { skip: process.platform === "win32" }, t => {
  const installer = fixture(t, "deb");
  const { verify } = verifier(t, installer, root => {
    const runtime = path.join(root, "usr/lib/Bodhi AI/browser-runtime");
    fs.rmSync(runtime, { recursive: true });
    fs.symlinkSync(installer.input.browserRoot, runtime);
  });
  assert.throws(verify, /Unexpected installer payload entry/);
});
