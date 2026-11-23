// Read original producer artifacts and write the unsigned input for admission.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MANIFEST_V3, REPOSITORY: BAMBOO, validateManifest } = require("./bamboo-sidecar.cjs");
const { LOTUS_NEXT_PACKAGE_NAME: PACKAGE, verifyLotusNextArtifact } = require("./lotus-next-artifact.cjs");

const LOTUS = "bigduu/lotus-next";
const NPM = "https://registry.npmjs.org";
const BROWSER_MANIFEST = "bamboo-desktop-browser-runtimes-v1.json";
const VERSION = /^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const digest = (algorithm, bytes, encoding = "hex") => crypto.createHash(algorithm).update(bytes).digest(encoding);
const api = (endpoint) => JSON.parse(execFileSync("gh", ["api", endpoint, "--method", "GET"], {
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
}));

async function readBytes(url, limit, allowGithubRedirects = false) {
  const signal = AbortSignal.timeout(90_000);
  let current = new URL(url);
  let response;
  for (let hops = 0; hops <= 4; hops += 1) {
    response = await fetch(current, { redirect: "manual", signal });
    if (!allowGithubRedirects || ![301, 302, 303, 307, 308].includes(response.status)) break;
    assert.ok(hops < 4 && response.headers.has("location"), "Invalid GitHub release redirect");
    current = new URL(response.headers.get("location"), current);
    assert.ok(current.protocol === "https:" && !current.username && !current.password && !current.port &&
      ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(current.hostname),
    "Unexpected GitHub release redirect host");
    await response.body?.cancel();
  }
  assert.equal(response.status, 200, `Cannot read ${url}`);
  assert.equal(new URL(response.url).protocol, "https:");
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert.ok(length <= limit, "Published asset exceeds its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function asset(assets, name) {
  const rows = assets.filter((row) => row.name === name && row.state === "uploaded");
  assert.equal(rows.length, 1, `Expected one published Bamboo asset ${name}`);
  const row = rows[0];
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(row.digest)?.[1];
  assert.ok(sha256 && Number.isSafeInteger(row.size) && row.size > 0, `Missing published digest or size for ${name}`);
  return { sha256, sizeBytes: row.size };
}

async function releaseManifest(release, name) {
  const identity = asset(release.assets, name);
  assert.ok(identity.sizeBytes <= 1024 * 1024);
  const url = `https://github.com/${BAMBOO}/releases/download/${release.tag_name}/${name}`;
  const bytes = await readBytes(url, identity.sizeBytes, true);
  assert.equal(bytes.length, identity.sizeBytes);
  assert.equal(digest("sha256", bytes), identity.sha256);
  return { bytes, identity };
}

function browserArtifacts(companion, expected, release) {
  assert.deepEqual(Object.keys(companion).sort(), ["artifacts", "bambooManifestSha256", "kind", "sourceRevision", "version"]);
  assert.equal(companion.kind, "bamboo-desktop-browser-runtimes/v1");
  assert.equal(companion.version, expected.version);
  assert.equal(companion.sourceRevision, expected.sourceRevision);
  assert.equal(companion.bambooManifestSha256, expected.manifestSha256);
  assert.deepEqual(companion.artifacts.map(item => item.target), expected.targets);
  return new Map(companion.artifacts.map(({ target, ...runtime }) => {
    assert.deepEqual(Object.keys(runtime).sort(), ["archive", "assetName", "receiptSha256"]);
    assert.equal(runtime.assetName, `bamboo-browser-runtime-v1-${target}.tar.gz`);
    assert.match(runtime.receiptSha256, SHA256);
    assert.deepEqual(asset(release.assets, runtime.assetName), runtime.archive);
    assert.ok(runtime.archive.sizeBytes <= 768 * 1024 ** 2);
    return [target, runtime];
  }));
}

async function bambooRelease(version) {
  const release = api(`repos/${BAMBOO}/releases/tags/v${version}`);
  assert.equal(release.tag_name, `v${version}`);
  assert.ok(!release.draft && !release.prerelease && release.published_at);
  const { sha: sourceRevision } = api(`repos/${BAMBOO}/commits/v${version}`);
  assert.match(sourceRevision, SHA);
  const { bytes, identity: manifestAsset } = await releaseManifest(release, MANIFEST_V3);
  const targets = JSON.parse(bytes).artifacts.map((item) => item.target);
  const lock = { schemaVersion: 1, repository: BAMBOO, version, sourceRevision,
    buildMode: "embedded", embeddedFrontend: true, manifestAssetName: MANIFEST_V3,
    manifestSha256: manifestAsset.sha256, targets };
  const { manifest } = validateManifest(bytes, lock, targets[0]);
  const browserHost = asset(release.assets, manifest.browserHost.assetName);
  assert.deepEqual(browserHost, { sha256: manifest.browserHost.sha256, sizeBytes: manifest.browserHost.sizeBytes });
  const runtime = release.assets.some(item => item.name === BROWSER_MANIFEST)
    ? browserArtifacts(JSON.parse((await releaseManifest(release, BROWSER_MANIFEST)).bytes),
      { version, sourceRevision, manifestSha256: manifestAsset.sha256, targets }, release)
    : new Map();
  const artifacts = manifest.artifacts.map((item) => {
    const executable = asset(release.assets, item.assetName);
    assert.deepEqual(executable, { sha256: item.sha256, sizeBytes: item.sizeBytes });
    const native = { target: item.target, assetName: item.assetName, executable };
    if (runtime.has(item.target)) native.browserRuntime = runtime.get(item.target);
    return native;
  });
  return { version, sourceRevision, manifest: manifestAsset, browserHost, artifacts };
}

async function lotusRelease(version) {
  const metadataUrl = `${NPM}/${encodeURIComponent(PACKAGE)}/${version}`;
  const registry = JSON.parse(await readBytes(metadataUrl, 1024 * 1024));
  assert.equal(registry.name, PACKAGE);
  assert.equal(registry.version, version);
  const archiveUrl = `${NPM}/${PACKAGE}/-/lotus-next-${version}.tgz`;
  assert.equal(registry.dist.tarball, archiveUrl);
  const bytes = await readBytes(archiveUrl, 32 * 1024 * 1024);
  assert.equal(`sha512-${digest("sha512", bytes, "base64")}`, registry.dist.integrity);
  assert.equal(digest("sha1", bytes), registry.dist.shasum);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-component-candidate-"));
  try {
    fs.mkdirSync(path.join(scratch, "scripts"));
    fs.writeFileSync(path.join(scratch, "scripts/frontend-package-lock.json"), JSON.stringify({
      packageName: PACKAGE, packageVersion: version,
    }));
    const filename = "lotus-next.tgz";
    const report = path.join(scratch, "pack.json");
    fs.writeFileSync(path.join(scratch, filename), bytes);
    fs.writeFileSync(report, JSON.stringify([{ name: PACKAGE, version, filename, size: bytes.length,
      integrity: registry.dist.integrity, shasum: registry.dist.shasum }]));
    execFileSync("python3", ["-I", path.join(__dirname, "stage-release-frontend.py"), report], {
      env: { ...process.env, SOURCE_ROOT: scratch, LOTUS_PACKAGE_NAME: PACKAGE, LOTUS_VERSION: version },
      encoding: "utf8", maxBuffer: 32 * 1024,
    });
    const dist = path.join(scratch, "node_modules", PACKAGE, "dist");
    const { manifest, manifestSha256 } = verifyLotusNextArtifact({
      distDirectory: dist,
      expectedIdentity: { packageName: PACKAGE, packageVersion: version, sourceDirty: false, entrypoint: "index.html" },
    });
    assert.match(manifest.sourceRevision, SHA);
    const admission = api(`repos/${LOTUS}/compare/${manifest.sourceRevision}...dev`);
    assert.equal(admission.merge_base_commit.sha, manifest.sourceRevision, "Lotus source is outside accepted Dev history");
    assert.ok(["ahead", "identical"].includes(admission.status) && admission.behind_by === 0);
    return { version, sourceRevision: manifest.sourceRevision, manifestSha256, resourcesSha256: manifest.resourcesSha256,
      tarball: { sha256: digest("sha256", bytes), sizeBytes: bytes.length } };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function releaseChanges(repo, previous, selected) {
  if (!previous || previous.sourceRevision === selected.sourceRevision) return [];
  assert.match(previous.sourceRevision, SHA);
  const compare = api(`repos/${repo}/compare/${previous.sourceRevision}...${selected.sourceRevision}?per_page=64`);
  assert.equal(compare.merge_base_commit.sha, previous.sourceRevision, "Component source versions have diverged");
  assert.ok(compare.status === "ahead" && compare.behind_by === 0);
  return compare.commits.map((item) => item.commit.message.split(/\r?\n/, 1)[0].trim().slice(0, 300)).filter(Boolean);
}

async function prepare(bamboo, lotus, previous) {
  assert.match(bamboo, VERSION);
  assert.match(lotus, VERSION);
  const [engine, frontend] = await Promise.all([bambooRelease(bamboo), lotusRelease(lotus)]);
  return {
    kind: "bodhi-component-candidate/v1",
    missingBrowserRuntime: engine.artifacts.filter((item) => !item.browserRuntime).map((item) => item.target),
    combination: { bamboo: engine, lotus: frontend, changes: {
      bamboo: releaseChanges(BAMBOO, previous?.bamboo, engine), lotus: releaseChanges(LOTUS, previous?.lotus, frontend),
    } },
  };
}

if (require.main === module) {
  const [bamboo, lotus, previous, oldBamboo, oldLotus] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    if (previous === "--from") {
      assert.match(oldBamboo, VERSION);
      assert.match(oldLotus, VERSION);
      const [engine, frontend] = await Promise.all([bambooRelease(oldBamboo), lotusRelease(oldLotus)]);
      return prepare(bamboo, lotus, { bamboo: engine, lotus: frontend });
    }
    return prepare(bamboo, lotus, previous && JSON.parse(fs.readFileSync(previous)).combination);
  })
    .then((candidate) => console.log(JSON.stringify(candidate, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { browserArtifacts, prepare };
