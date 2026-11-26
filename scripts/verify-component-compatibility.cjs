const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { createServer } = require("node:net");
const { once } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { downloadAsset, installRelease, MANIFEST_V3, REPOSITORY, sha256, V3_TARGETS } = require("./bamboo-sidecar.cjs");
const { LOTUS_NEXT_PACKAGE_NAME: PACKAGE, verifyLotusNextArtifact } = require("./lotus-next-artifact.cjs");
const { readCatalog } = require("./prepare-component-candidate.cjs");

const LOOPBACK = "127.0.0.1";
const MAX_PROBE_JSON = 64 * 1024;

async function selectPair(candidate, read = readCatalog) {
  assert.equal(candidate.kind, "bodhi-single-component-candidate/v1");
  assert.ok(candidate.component === "bamboo" || candidate.component === "lotus", "Expected one component candidate");
  const peer = candidate.component === "bamboo" ? "lotus" : "bamboo";
  const [current, other] = await Promise.all([read(candidate.component), read(peer)]);
  assert.deepEqual(current.baseline, candidate.catalog, "Candidate catalog changed before compatibility verification");
  assert.equal(other.baseline.branchRevision, candidate.catalog.branchRevision, "Stable catalog snapshot changed during selection");
  const retained = other.catalog.releases.find((entry) => entry.release.version === other.catalog.recommendedVersion);
  assert.ok(retained, "The peer catalog has no recommended release to test");
  return {
    [candidate.component]: candidate.release, [peer]: retained.release,
    catalogs: { [candidate.component]: current.baseline, [peer]: other.baseline },
  };
}

function stageBamboo(scratch, release, target, download) {
  const { version, sourceRevision } = release;
  const lock = { schemaVersion: 1, repository: REPOSITORY, version, sourceRevision, buildMode: "embedded",
    embeddedFrontend: true, manifestAssetName: MANIFEST_V3, manifestSha256: release.manifest.sha256, targets: V3_TARGETS };
  fs.writeFileSync(path.join(scratch, "scripts", "bamboo-sidecar-lock.json"), JSON.stringify(lock));
  const staged = installRelease(scratch, target, { env: {}, download });
  const native = release.artifacts.find((artifact) => artifact.target === target);
  assert.ok(native, "Bamboo release does not support the probe target");
  assert.equal(staged.assetName, native.assetName);
  assert.deepEqual({ sha256: staged.sha256, sizeBytes: staged.sizeBytes }, native.executable);
  assert.equal(staged.browserHostSha256, release.browserHost.sha256);
  return staged;
}

function stageLotus(scratch, release, download) {
  const { version, sourceRevision } = release;
  assert.match(version, /^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const filename = `lotus-next-${version}.tgz`;
  const archive = path.join(scratch, filename);
  download(`https://registry.npmjs.org/${PACKAGE}/-/${filename}`, archive, release.tarball.sizeBytes);
  assert.equal(fs.statSync(archive).size, release.tarball.sizeBytes, "Lotus archive length changed");
  const bytes = fs.readFileSync(archive);
  assert.equal(sha256(bytes), release.tarball.sha256, "Lotus archive identity changed");
  // The stable identity pins the archive bytes. Supply the staging tool's
  // pack report from those bytes after checking the pinned size and digest.
  fs.writeFileSync(path.join(scratch, "scripts", "frontend-package-lock.json"),
    JSON.stringify({ packageName: PACKAGE, packageVersion: version }));
  const report = path.join(scratch, "pack.json");
  fs.writeFileSync(report, JSON.stringify([{
    name: PACKAGE, version, filename, size: bytes.length,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  }]));
  execFileSync("python3", ["-I", path.join(__dirname, "stage-release-frontend.py"), report], {
    env: { PATH: process.env.PATH, SOURCE_ROOT: scratch, LOTUS_PACKAGE_NAME: PACKAGE, LOTUS_VERSION: version },
    timeout: 30_000,
  });
  const dist = path.join(scratch, "node_modules", PACKAGE, "dist");
  const { manifest, manifestSha256 } = verifyLotusNextArtifact({ distDirectory: dist, expectedIdentity: {
    packageName: PACKAGE, packageVersion: version, sourceRevision, sourceDirty: false, entrypoint: "index.html",
  } });
  assert.equal(manifestSha256, release.manifestSha256, "Lotus manifest identity changed");
  assert.equal(manifest.resourcesSha256, release.resourcesSha256, "Lotus resource identity changed");
  const declaration = JSON.parse(fs.readFileSync(path.join(dist, "lotus-next-bootstrap-requirements.json")));
  assert.deepEqual({
    schemaVersion: declaration.schemaVersion, packageName: declaration.packageName,
    packageVersion: declaration.packageVersion, sourceRevision: declaration.sourceRevision, sourceDirty: declaration.sourceDirty,
  }, { schemaVersion: 1, packageName: PACKAGE, packageVersion: version, sourceRevision, sourceDirty: false });
  return { dist, index: manifest.resources.find((entry) => entry.path === "index.html"), required: declaration.bootstrap };
}

function verifyBootstrap(required, actual, version) {
  assert.deepEqual([required.schema_version, required.server.product, required.api.name,
    required.api.canonical_base_path, required.api.version], [1, "bamboo", "bamboo.agent", "/api/v1", 1],
  "Lotus declares a Bootstrap schema this Bodhi source does not support");
  assert.equal(actual.schema_version, required.schema_version, "Bamboo Bootstrap schema differs from Lotus requirements");
  assert.deepEqual([actual.server.product, actual.server.version], [required.server.product, version]);
  for (const [key, field] of [["api", "canonical_base_path"], ["realtime", "path"]]) {
    const expected = required[key], observed = actual[key];
    assert.deepEqual([observed.name, observed[field]], [expected.name, expected[field]], `Bamboo ${key} contract differs`);
    assert.ok(Number.isSafeInteger(observed.min_version) && Number.isSafeInteger(observed.max_version)
      && observed.min_version <= expected.version && expected.version <= observed.max_version, `Bamboo ${key} version is incompatible`);
  }
  assert.ok(new Set(actual.realtime.subprotocols.map((entry) => entry.name)).size === actual.realtime.subprotocols.length &&
    actual.realtime.subprotocols.some((entry) => entry.name === required.realtime.subprotocol.name &&
    entry.encoding === required.realtime.subprotocol.encoding), "Bamboo lacks the required realtime subprotocol");
  for (const capabilities of [required.capabilities, actual.capabilities]) {
    assert.ok(capabilities.every((entry) => typeof entry === "string" && entry !== "") &&
      new Set(capabilities).size === capabilities.length, "Bootstrap capabilities must have unique names");
  }
  assert.ok(required.capabilities.every((value) => actual.capabilities.includes(value)), "Bamboo lacks a required capability");
  assert.deepEqual([actual.auth.policy, actual.auth.request_state, actual.auth.password_enabled, actual.auth.device_auth_enabled],
    ["open", "local_bypass", false, false], "An isolated profile must report open, local Bamboo access");
  for (const [key, field] of [["password_enabled", "verify_path"], ["device_auth_enabled", "pair_path"]]) {
    assert.equal(actual.auth[field], required.auth[key][field], `Bamboo auth route ${field} differs`);
    assert.ok(actual.capabilities.includes(required.auth[key].capability), `Bamboo lacks the required auth capability ${key}`);
  }
}

async function loopbackPort(requestedPort = 0) {
  const server = createServer();
  server.listen({ host: LOOPBACK, port: requestedPort });
  await once(server, "listening");
  const { port } = server.address();
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
}

async function readProbe(origin, route, maxBytes) {
  const response = await fetch(origin + route, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  try {
    assert.equal(response.status, 200, `Bamboo probe ${route} returned HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= maxBytes, `Bamboo probe ${route} exceeded its size limit`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

async function runPair(scratch, bamboo, lotus) {
  const profile = path.join(scratch, "profile");
  fs.mkdirSync(profile);
  const port = await loopbackPort();
  const origin = `http://${LOOPBACK}:${port}`;
  const child = spawn(bamboo.binary, [
    "serve", "--parent-pid", String(process.pid), "--port", String(port), "--bind", LOOPBACK,
    "--workers", "1", "--data-dir", profile, "--static-dir", lotus.dist,
  ], { cwd: profile, stdio: ["ignore", "pipe", "pipe"], env: {
    BAMBOO_DATA_DIR: profile, BAMBOO_WORKSPACE_ROOT: path.join(profile, "workspace"),
    BAMBOO_JIANDU_DATA_DIR: path.join(profile, "jiandu"), CFFIXED_USER_HOME: profile,
    RUST_LOG: "bamboo_server::server::entrypoints=info",
  } });
  let ready = false, spawnError, stopped;
  child.once("error", (error) => { spawnError = error; });
  const finished = new Promise((resolve) => child.once("close", (code, signal) => {
    stopped = { code, signal };
    resolve(stopped);
  }));
  for (const output of [child.stdout, child.stderr]) {
    let line = "";
    output.setEncoding("utf8").on("data", (text) => {
      const rows = (line + text).split("\n");
      line = rows.pop().slice(-16_384);
      const bound = `Unified server running on ${origin}`;
      ready ||= rows.some((row) => row.replaceAll("\x1b[0m", "").trimEnd().endsWith(bound));
    });
  }
  let actual;
  try {
    const deadline = Date.now() + 30_000;
    while (!ready && !spawnError && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(75);
    if (spawnError) throw spawnError;
    assert.ok(ready && child.exitCode === null && child.signalCode === null, "The owned Bamboo process did not become ready");
    await readProbe(origin, "/api/v1/health", MAX_PROBE_JSON);
    const status = JSON.parse(await readProbe(origin, "/readyz", MAX_PROBE_JSON));
    assert.deepEqual([status.status, status.version], ["ok", bamboo.version]);
    const index = await readProbe(origin, "/index.html", lotus.index.size);
    assert.equal(sha256(index), lotus.index.sha256, "Bamboo did not serve the verified Lotus entry");
    actual = JSON.parse(await readProbe(origin, "/api/v1/bootstrap", MAX_PROBE_JSON));
    verifyBootstrap(lotus.required, actual, bamboo.version);
    assert.ok(child.exitCode === null && child.signalCode === null, "The owned Bamboo process exited during compatibility verification");
  } finally {
    if (!stopped && !spawnError) child.kill("SIGTERM");
    stopped = await Promise.race([finished, delay(10_000, null, { ref: false })]);
    if (!stopped) {
      child.kill("SIGKILL");
      await Promise.race([finished, delay(2_000, null, { ref: false })]);
    }
  }
  assert.deepEqual(stopped, { code: 0, signal: null }, "The owned Bamboo process did not stop cleanly");
  await loopbackPort(port);
  return { indexSha256: lotus.index.sha256, bootstrap: actual, normalShutdown: true, portReleased: true };
}

async function provePair({ bamboo, lotus }, { download = downloadAsset } = {}) {
  const target = { "linux-x64": "x86_64-unknown-linux-gnu", "darwin-arm64": "aarch64-apple-darwin" }[`${process.platform}-${process.arch}`];
  assert.ok(target, "The published component probe supports Linux x64 and macOS ARM64");
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-component-proof-")));
  try {
    fs.mkdirSync(path.join(scratch, "scripts"));
    const kernel = stageBamboo(scratch, bamboo, target, download);
    const frontend = stageLotus(scratch, lotus, download);
    const proof = await runPair(scratch, kernel, frontend);
    const { binary, hostDirectory, ...native } = kernel;
    return { target, bamboo: native, lotus, ...proof };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(candidateFile) {
  const bytes = fs.readFileSync(candidateFile);
  const candidate = JSON.parse(bytes);
  const pair = await selectPair(candidate);
  const proof = await provePair(pair);
  return {
    schemaVersion: 1, kind: "bodhi-component-compatibility/v1",
    component: candidate.component, candidateSha256: sha256(bytes), catalogs: pair.catalogs,
    controller: { repository: process.env.GITHUB_REPOSITORY, workflowRevision: process.env.GITHUB_WORKFLOW_SHA,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT },
    ...proof,
  };
}

if (require.main === module) {
  main(process.argv[2]).then((proof) => console.log(JSON.stringify(proof, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { provePair, selectPair, verifyBootstrap };
