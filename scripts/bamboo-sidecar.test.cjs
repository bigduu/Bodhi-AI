const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { gzipSync } = require("node:zlib");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const sidecar = require("./bamboo-sidecar.cjs");

// Synthetic executable headers exercise the real installer and architecture
// verifier, but are never executed or represented as installable Bamboo builds.
function binary(target) {
  const bytes = Buffer.alloc(65536);
  if (target.includes("darwin")) {
    bytes.writeUInt32LE(0xfeedfacf);
    bytes.writeUInt32LE(target.startsWith("aarch64") ? 0x0100000c : 0x01000007, 4);
  } else if (target.includes("windows")) {
    bytes.write("MZ"); bytes.writeUInt32LE(128, 0x3c);
    bytes.write("PE\0\0", 128); bytes.writeUInt16LE(0x8664, 132);
  } else {
    bytes.write("\x7fELF"); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(0x3e, 18);
  }
  return bytes;
}

function tar(entries, trailing = Buffer.alloc(1024)) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || "fixture");
    const header = Buffer.alloc(512);
    header.write(entry.name);
    const octal = (offset, length, value) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
    octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, data.length); octal(136, 12, 0);
    header.fill(32, 148, 156); header[156] = (entry.type || "0").charCodeAt(0);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write("ustar\0", 257); header.write("00", 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, trailing]));
}

const v2Targets = ["aarch64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"];

function fixture(t, { manifestVersion = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-sidecar-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  const entries = sidecar.HOST_FILES.map((name) => ({ name, data: name.endsWith(".cjs") ? "// synthetic browser host\n" : "{}\n" }));
  const files = new Map();
  const targets = manifestVersion === 2 ? v2Targets : sidecar.TARGETS;
  const manifestName = manifestVersion === 2 ? "bamboo-sidecars-v2.json" : sidecar.MANIFEST;
  const artifacts = targets.map((target) => {
    const data = binary(target), name = sidecar.binaryName(target);
    files.set(name, data);
    return { target, buildMode: "embedded", embeddedFrontend: true, format: "raw", assetName: name,
      sha256: sidecar.sha256(data), sizeBytes: data.length };
  });
  const host = tar(entries);
  files.set("bamboo-browser-host-v1.tar.gz", host);
  const manifest = { schemaVersion: manifestVersion, version: "2026.10.18", sourceRevision: "a".repeat(40), artifacts,
    browserHost: { assetName: "bamboo-browser-host-v1.tar.gz", sha256: sidecar.sha256(host), sizeBytes: host.length,
      files: entries.map(({ name, data }) => ({ path: name, sha256: sidecar.sha256(data), sizeBytes: Buffer.byteLength(data) })) } };
  const lock = { schemaVersion: 1, repository: sidecar.REPOSITORY, version: manifest.version,
    sourceRevision: manifest.sourceRevision, buildMode: "embedded", embeddedFrontend: true,
    manifestAssetName: manifestName, manifestSha256: "", targets: [...targets] };
  const refresh = () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    lock.manifestSha256 = sidecar.sha256(bytes);
    files.set(manifestName, bytes);
    fs.writeFileSync(path.join(root, "scripts/bamboo-sidecar-lock.json"), JSON.stringify(lock));
  };
  refresh();
  const requests = [];
  const download = (url, file) => {
    const name = url.split("/").pop(); requests.push(url);
    assert.equal(url, sidecar.releaseUrl(lock, name));
    assert.ok(files.has(name), "Fixture asset must exist");
    fs.writeFileSync(file, files.get(name));
  };
  const target = targets[0];
  const install = (options = {}) => sidecar.installRelease(root, target, { env: {}, download, ...options });
  const cache = (name) => path.join(root, "src-tauri/.bamboo-sidecar-cache", lock.manifestSha256, name);
  return { root, entries, manifest, lock, refresh, files, requests, download, target, install, cache, manifestName, targets };
}

for (const target of v2Targets) test(`installs the locked v2 ${target} without changing the legacy four-target contract`, (t) => {
  const f = fixture(t, { manifestVersion: 2 });
  const result = sidecar.installRelease(f.root, target, { env: {}, download: f.download });
  assert.equal(result.manifestSha256, f.lock.manifestSha256);
  assert.deepEqual(fs.readFileSync(result.binary), binary(target));
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests[0].endsWith("/bamboo-sidecars-v2.json"));
  assert.ok(fs.existsSync(f.cache("bamboo-sidecars-v2.json")));
  assert.equal(fs.existsSync(f.cache("bamboo-sidecars-v1.json")), false);
  assert.equal(sidecar.installedRelease(f.root, target, {}).sha256, result.sha256);
  assert.equal(sidecar.installRelease(f.root, target, { env: {}, offline: true,
    download() { assert.fail("offline v2 must not download"); } }).sha256, result.sha256);
});

test("locked manifest name, schema and complete target set cannot be mixed between v1 and v2", (t) => {
  for (const manifestVersion of [1, 2]) {
    const f = fixture(t, { manifestVersion });
    assert.equal(sidecar.validateLock(f.lock), f.lock);
    const otherName = manifestVersion === 1 ? "bamboo-sidecars-v2.json" : "bamboo-sidecars-v1.json";
    assert.throws(() => sidecar.validateLock({ ...f.lock, manifestAssetName: otherName }), /targets/);
    for (const name of ["bamboo-sidecars-v3.json", "bamboo-sidecars-v02.json", "../bamboo-sidecars-v2.json"]) {
      assert.throws(() => sidecar.validateLock({ ...f.lock, manifestAssetName: name }), /Invalid/);
    }
    assert.throws(() => sidecar.validateLock({ ...f.lock, schemaVersion: 2 }), /Invalid/);
    assert.throws(() => sidecar.releaseUrl(f.lock, otherName), /Unexpected/);
    f.manifest.schemaVersion = manifestVersion === 1 ? 2 : 1; f.refresh();
    assert.throws(() => f.install(), /manifest schema/);
    assert.equal(f.requests.length, 1);
    assert.equal(fs.existsSync(path.join(f.root, "src-tauri/binaries")), false);
  }
});

test("v2 rejects Intel before cache creation or requests, and rejects missing, duplicate and unsorted manifest targets", (t) => {
  const f = fixture(t, { manifestVersion: 2 });
  assert.throws(() => sidecar.installRelease(f.root, "x86_64-apple-darwin", { env: {}, download: f.download }), /Unsupported/);
  assert.throws(() => sidecar.releaseUrl(f.lock, sidecar.binaryName("x86_64-apple-darwin")), /Unexpected/);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, "src-tauri")), false);
  const changes = [
    ...v2Targets.map(target => manifest => { manifest.artifacts = manifest.artifacts.filter(item => item.target !== target); }),
    manifest => { manifest.artifacts.push({ ...manifest.artifacts[0], target: "x86_64-apple-darwin" }); },
    manifest => { manifest.artifacts[1] = manifest.artifacts[0]; },
    manifest => { manifest.artifacts.reverse(); },
  ];
  for (const change of changes) {
    const candidate = fixture(t, { manifestVersion: 2 }); change(candidate.manifest); candidate.refresh();
    assert.throws(() => candidate.install(), /targets/);
    assert.equal(candidate.requests.length, 1);
    assert.equal(fs.existsSync(path.join(candidate.root, "src-tauri/binaries")), false);
  }
});

test("v2 offline verification cannot substitute the legacy cache filename", (t) => {
  const f = fixture(t, { manifestVersion: 2 }), accepted = f.install();
  fs.renameSync(f.cache("bamboo-sidecars-v2.json"), f.cache("bamboo-sidecars-v1.json"));
  assert.throws(() => f.install({ offline: true, download() { assert.fail("offline download"); } }), /Offline Bamboo cache is missing/);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(fs.readFileSync(accepted.binary), binary(f.target));
});

test("v2 pinned manifest cannot mask the wrong native architecture", (t) => {
  const f = fixture(t, { manifestVersion: 2 }), accepted = f.install();
  const wrong = binary("x86_64-apple-darwin");
  f.files.set(sidecar.binaryName(f.target), wrong);
  f.manifest.artifacts[0].sha256 = sidecar.sha256(wrong); f.refresh();
  assert.throws(() => f.install(), /CPU architecture/);
  assert.deepEqual(fs.readFileSync(accepted.binary), binary(f.target));
});

for (const target of sidecar.TARGETS) test(`installs verified raw ${target} and exact browser host without a source checkout`, (t) => {
  const f = fixture(t);
  const result = sidecar.installRelease(f.root, target, { env: {}, download: f.download });
  assert.equal(path.basename(result.binary), sidecar.binaryName(target));
  assert.equal(result.buildMode, "embedded");
  assert.equal(result.embeddedFrontend, true);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(fs.readFileSync(result.binary), binary(target));
  assert.equal(fs.existsSync(path.join(f.root, "bamboo-src")), false);
  assert.equal(sidecar.installedRelease(f.root, target, {}).manifestSha256, f.lock.manifestSha256);
});

test("repeat installation is offline, rehashes exact bytes and preserves the binary inode", (t) => {
  const f = fixture(t), first = f.install();
  const inode = fs.statSync(first.binary).ino;
  const second = f.install({ offline: true, download() { assert.fail("offline download"); } });
  assert.equal(second.sha256, first.sha256);
  assert.equal(fs.statSync(second.binary).ino, inode);
  assert.equal(f.requests.length, 3);
  fs.unlinkSync(second.binary);
  assert.equal(f.install({ env: { BAMBOO_SIDECAR_OFFLINE: "1" } }).sha256, first.sha256);
  assert.equal(f.requests.length, 3);
});

test("unaccepted production lock fails before downloads or output creation", (t) => {
  const f = fixture(t); f.lock.manifestSha256 = null;
  fs.writeFileSync(path.join(f.root, "scripts/bamboo-sidecar-lock.json"), JSON.stringify(f.lock));
  assert.throws(() => f.install(), /not accepted/);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, "src-tauri")), false);
});

test("the actual preflight CLI accepts exact dispatch identity and rejects mismatches", (t) => {
  const f = fixture(t);
  const script = path.join(f.root, "scripts/bamboo-sidecar.cjs");
  fs.copyFileSync(path.join(__dirname, "bamboo-sidecar.cjs"), script);
  const run = (overrides) => spawnSync(process.execPath, [script, "check-lock"], { encoding: "utf8", env: {
    ...process.env, BAMBOO_RELEASE_VERSION: f.lock.version, BAMBOO_RELEASE_SOURCE_REVISION: f.lock.sourceRevision, ...overrides,
  } });
  assert.equal(run({}).status, 0);
  const wrong = run({ BAMBOO_RELEASE_VERSION: "latest" });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /differs from the accepted/);
  assert.equal(fs.existsSync(path.join(f.root, "src-tauri")), false);
});

for (const [name, mutate, pattern] of [
  ["wrong version", (f) => { f.manifest.version = "2026.10.17"; }, /version or sourceRevision/],
  ["wrong source", (f) => { f.manifest.sourceRevision = "b".repeat(40); }, /version or sourceRevision/],
  ["api-only variant", (f) => { f.manifest.artifacts[0].buildMode = "api-only"; }, /raw full/],
  ["missing embedded frontend", (f) => { f.manifest.artifacts[0].embeddedFrontend = false; }, /raw full/],
  ["archive in place of raw", (f) => { f.manifest.artifacts[0].format = "tar.gz"; }, /raw full/],
  ["unsafe asset name", (f) => { f.manifest.artifacts[0].assetName = "../../bamboo"; }, /exact raw/],
  ["missing target", (f) => { f.manifest.artifacts.pop(); }, /targets/],
  ["duplicate target", (f) => { f.manifest.artifacts[1] = f.manifest.artifacts[0]; }, /targets/],
  ["wrong target", (f) => { f.manifest.artifacts[0].target = "aarch64-unknown-linux-gnu"; }, /targets/],
  ["invalid digest", (f) => { f.manifest.artifacts[0].sha256 = "0"; }, /SHA-256/],
  ["invalid size", (f) => { f.manifest.artifacts[0].sizeBytes = 4; }, /sizeBytes/],
  ["different raw binary hash", (f) => { f.manifest.artifacts[0].binarySha256 = "c".repeat(64); }, /binarySha256/],
  ["different raw binary size", (f) => { f.manifest.artifacts[0].binarySizeBytes = 999999; }, /binarySizeBytes/],
  ["extra host path", (f) => { f.manifest.browserHost.files.push({ ...f.manifest.browserHost.files[0], path: "extra" }); }, /three declared/],
]) test(`rejects ${name} before accepting an executable`, (t) => {
  const f = fixture(t); mutate(f); f.refresh();
  assert.throws(() => f.install(), pattern);
  assert.equal(f.requests.length, 1);
  assert.equal(fs.existsSync(path.join(f.root, "src-tauri/binaries", sidecar.binaryName(f.target))), false);
});

test("dispatch version, source, target and invalid lock identities fail closed", (t) => {
  const f = fixture(t);
  for (const env of [{ BAMBOO_RELEASE_VERSION: "latest" }, { BAMBOO_RELEASE_SOURCE_REVISION: "b".repeat(40) }, { TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" }]) {
    assert.throws(() => f.install({ env }), /differs|match the Tauri/);
  }
  for (const change of [{ repository: "other/repo" }, { version: "latest" }, { buildMode: "api-only", embeddedFrontend: false }, { manifestAssetName: "../manifest.json" }, { targets: [f.target] }]) {
    assert.throws(() => sidecar.validateLock({ ...f.lock, ...change }, {}), /Invalid|not accepted|four desktop/);
  }
  assert.throws(() => sidecar.installRelease(f.root, "../escape", { env: {} }), /Unsupported/);
  assert.equal(f.requests.length, 0);
});

for (const name of [sidecar.MANIFEST, sidecar.binaryName(sidecar.TARGETS[0]), "bamboo-browser-host-v1.tar.gz"]) {
  test(`offline cache refuses changed ${name} rather than redownloading or building`, (t) => {
    const f = fixture(t), accepted = f.install();
    fs.appendFileSync(f.cache(name), "tampered");
    assert.throws(() => f.install({ offline: true, download() { assert.fail("must not redownload"); } }), /bounded regular|mismatch/);
    assert.deepEqual(fs.readFileSync(accepted.binary), binary(f.target));
    assert.equal(f.requests.length, 3);
  });
}

test("offline cache missing an exact asset fails without network", (t) => {
  const f = fixture(t);
  assert.throws(() => f.install({ offline: true }), /Offline Bamboo cache is missing/);
  assert.equal(f.requests.length, 0);
  f.install(); fs.unlinkSync(f.cache(sidecar.binaryName(f.target)));
  assert.throws(() => f.install({ offline: true }), /Offline Bamboo cache is missing/);
  assert.equal(f.requests.length, 3);
});

test("missing published asset and truncated or corrupt downloads leave no installed binary or partial cache", (t) => {
  for (const mode of ["missing", "truncated", "bad-hash"]) {
    const f = fixture(t);
    assert.throws(() => f.install({ download(url, file) {
      if (url.endsWith(sidecar.MANIFEST)) return f.download(url, file);
      if (mode === "missing") throw new Error("fixture HTTP 404");
      const bytes = Buffer.from(f.files.get(url.split("/").pop()));
      if (mode === "bad-hash") bytes[64] ^= 1;
      fs.writeFileSync(file, mode === "truncated" ? bytes.subarray(0, 10) : bytes);
    } }), /HTTP 404|mismatch/);
    assert.deepEqual(fs.readdirSync(f.cache("")), [sidecar.MANIFEST]);
    assert.equal(fs.existsSync(path.join(f.root, "src-tauri/binaries")), false);
  }
});

test("correct manifest identity cannot mask a binary for the wrong CPU", (t) => {
  const f = fixture(t), accepted = f.install();
  const wrong = binary("x86_64-apple-darwin");
  f.files.set(sidecar.binaryName(f.target), wrong);
  f.manifest.artifacts[0].sha256 = sidecar.sha256(wrong); f.refresh();
  assert.throws(() => f.install(), /CPU architecture/);
  assert.deepEqual(fs.readFileSync(accepted.binary), binary(f.target));
});

test("installed receipt, executable and cached host are rechecked before assembly", (t) => {
  const f = fixture(t), result = f.install();
  fs.writeFileSync(`${result.binary}.json`, "{}");
  assert.throws(() => sidecar.installedRelease(f.root, f.target, {}), /receipt differs/);
  f.install(); fs.writeFileSync(result.binary, "tampered");
  assert.throws(() => sidecar.installedRelease(f.root, f.target, {}), /SHA-256 or size/);
  f.install(); fs.writeFileSync(path.join(result.hostDirectory, "browser-runtime/host.cjs"), "changed");
  assert.throws(() => f.install(), /Cached browser host/);
});

for (const [name, change] of [
  ["path traversal", (entries) => [{ ...entries[0], name: "../../escaped" }, ...entries.slice(1)]],
  ["absolute path", (entries) => [{ ...entries[0], name: "/tmp/escaped" }, ...entries.slice(1)]],
  ["duplicate member", (entries) => [...entries, entries[0]]],
  ["extra member", (entries) => [...entries, { name: "browser-runtime/extra", data: "extra" }]],
  ["symlink", (entries) => [{ ...entries[0], type: "2", link: "../../escaped" }, ...entries.slice(1)]],
  ["hardlink", (entries) => [{ ...entries[0], type: "1", link: "../../escaped" }, ...entries.slice(1)]],
  ["PAX metadata", (entries) => [{ ...entries[0], type: "x" }, ...entries.slice(1)]],
  ["directory entry", (entries) => [{ ...entries[0], type: "5" }, ...entries.slice(1)]],
  ["missing member", (entries) => entries.slice(1)],
  ["changed member bytes", (entries) => [{ ...entries[0], data: "changed" }, ...entries.slice(1)]],
]) test(`host archive rejects ${name} before staging files`, (t) => {
  const f = fixture(t);
  assert.throws(() => sidecar.unpackHost(tar(change(f.entries)), f.manifest.browserHost), /archive|USTAR/);
});

test("host archive rejects truncation, nonzero trailing data and decompression overflow", (t) => {
  const f = fixture(t);
  for (const archive of [tar(f.entries, Buffer.alloc(0)), tar(f.entries, Buffer.from("unsafe")),
    gzipSync(Buffer.alloc(1024 * 1024)), f.files.get("bamboo-browser-host-v1.tar.gz").subarray(0, 15)]) {
    assert.throws(() => sidecar.unpackHost(archive, f.manifest.browserHost));
  }
});

test("linked output and cache paths cannot redirect writes", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t), accepted = f.install();
  const outside = path.join(f.root, "outside"); fs.writeFileSync(outside, "preserve");
  fs.unlinkSync(accepted.binary); fs.symlinkSync(outside, accepted.binary);
  assert.throws(() => f.install(), /linked or non-file/);
  assert.equal(fs.readFileSync(outside, "utf8"), "preserve");
  fs.unlinkSync(accepted.binary);
  const asset = f.cache(sidecar.binaryName(f.target));
  fs.unlinkSync(asset); fs.symlinkSync(path.join(f.root, "absent"), asset);
  assert.throws(() => f.install(), /ENOENT|bounded regular/);
  assert.equal(fs.lstatSync(asset).isSymbolicLink(), true);
  const g = fixture(t); fs.mkdirSync(path.join(g.root, "src-tauri"));
  fs.symlinkSync(f.root, path.join(g.root, "src-tauri/.bamboo-sidecar-cache"), "dir");
  assert.throws(() => g.install(), /owned directory/);
  assert.equal(g.requests.length, 0);
});

test("downloader enforces HTTPS redirects, bounded downloads and no ambient curl credentials", () => {
  let args;
  const context = { module: { exports: {} }, __dirname, process, Buffer, console, require(name) {
    if (name === "node:child_process") return { execFileSync(command, given) { assert.equal(command, "curl"); args = given; } };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "bamboo-sidecar.cjs"), "utf8"), context);
  context.module.exports.downloadAsset("https://github.com/bigduu/Bamboo-agent/releases/download/v2026.10.18/bamboo-test", "/tmp/bamboo-test.part-1", 65536);
  assert.equal(args[0], "-q");
  assert.equal(args[args.indexOf("--proto") + 1], "=https");
  assert.equal(args[args.indexOf("--proto-redir") + 1], "=https");
  assert.equal(args[args.indexOf("--max-filesize") + 1], "65536");
  assert.ok(!args.some((arg) => /netrc|header|token|user|insecure/.test(arg)));
});

for (const name of ["ci.yml", "release.yml"]) test(`${name} consumes assets before shell compilation and retains native gates`, () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows", name), "utf8");
  const body = name === "ci.yml" ? workflow.slice(workflow.indexOf("  native-tests:")) : workflow;
  assert.doesNotMatch(body, /bamboo-src|repository:\s*bigduu\/Bamboo-agent|BAMBOO_SIDECAR_SOURCE:\s*local|sidecar_cache/);
  assert.doesNotMatch(body, /cargo update/);
  const targets = [...body.matchAll(/^\s+target:\s*["']?([a-z0-9_-]+)["']?\s*$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(targets, [...require("./release-finalizer.cjs").NATIVE_TARGETS].sort());
  if (name === "ci.yml") {
    const stage = body.indexOf("run: npm run build:sidecar:dev");
    const tests = body.indexOf("run: cargo test --locked");
    assert.ok(stage > 0 && tests > stage);
    assert.match(body, /--assembly=debug/);
    assert.doesNotMatch(body, /cargo build|tauri-action|release\/bundle/);
  } else {
    const preflight = body.indexOf("scripts/release-finalizer-v2.cjs reserve");
    const build = body.indexOf("npm run tauri:build");
    const verify = body.indexOf("scripts/release-output.cjs capture");
    assert.ok(preflight > 0 && build > preflight && verify > build);
    assert.match(body, /hashFiles\('product\/scripts\/bamboo-sidecar-lock.json'\)/);
    assert.doesNotMatch(body, /scripts\/bamboo-sidecar\.cjs install|npm run web:build|sidecar-bundle-smoke|browser-bundle-smoke/);
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../src-tauri/tauri.conf.json")));
    assert.equal(config.build.beforeBuildCommand, "node scripts/build-sidecar.cjs");
    const verifier = fs.readFileSync(path.join(__dirname, "release-output.cjs"), "utf8");
    for (const check of ["installedRelease(root, target", "lotus.verifyStaged(source, root)", "verifyArchitecture", "verifyMacosBundle", "verifyRuntime"])
      assert.ok(verifier.includes(check), `Missing static release check: ${check}`);
  }
  assert.match(workflow, /BAMBOO_SIDECAR_SOURCE: release/);
  if (name === "ci.yml") {
    assert.match(body, /hashFiles\('scripts\/bamboo-sidecar-lock.json'\)/);
    assert.match(body, /npm run verify:assembly/);
    assert.match(body, /node scripts\/sidecar-bundle-smoke.cjs/);
    assert.match(body, /node scripts\/browser-bundle-smoke.cjs/);
  }
});
