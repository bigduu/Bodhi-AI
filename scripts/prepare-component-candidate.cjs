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
const BODHI = "bigduu/Bodhi-AI";
const CATALOG_BRANCH = "components-stable";
const BROWSER_MANIFEST = "bamboo-desktop-browser-runtimes-v1.json";
const VERSION = /^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const digest = (algorithm, bytes, encoding = "hex") => crypto.createHash(algorithm).update(bytes).digest(encoding);
const api = (endpoint) => JSON.parse(execFileSync("gh", ["api", endpoint, "--method", "GET"], {
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
}));

function requireAcceptedSource(repository, sourceRevision) {
  assert.match(sourceRevision, SHA);
  const branch = api(`repos/${repository}/branches/dev`);
  assert.equal(branch.name, "dev");
  assert.equal(branch.protected, true, `Require protected ${repository} Dev`);
  const dev = branch.commit.sha;
  assert.match(dev, SHA);
  const admission = api(`repos/${repository}/compare/${sourceRevision}...${dev}`);
  assert.equal(admission.merge_base_commit.sha, sourceRevision, `${repository} release source is outside protected Dev history`);
  assert.ok(["ahead", "identical"].includes(admission.status) && admission.behind_by === 0);
}

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

function publishedBambooVersion(release) {
  assert.ok(release.draft === false && release.prerelease === false && release.published_at,
    "Expected a published stable Bamboo release");
  const version = typeof release.tag_name === "string" && release.tag_name.startsWith("v")
    ? release.tag_name.slice(1)
    : "";
  assert.match(version, VERSION, "Invalid stable Bamboo release tag");
  return version;
}

async function resolveLatestVersion(component, request = api, read = readBytes) {
  if (component === "bamboo") {
    return publishedBambooVersion(request(`repos/${BAMBOO}/releases/latest`));
  }
  assert.equal(component, "lotus", "Expected Bamboo or Lotus Next");
  const registry = JSON.parse(await read(`${NPM}/${encodeURIComponent(PACKAGE)}/latest`, 1024 * 1024));
  assert.equal(registry.name, PACKAGE, "Unexpected Lotus Next package name");
  assert.match(registry.version, VERSION, "Invalid stable Lotus Next version");
  return registry.version;
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
  assert.equal(publishedBambooVersion(release), version);
  const { sha: sourceRevision } = api(`repos/${BAMBOO}/commits/v${version}`);
  requireAcceptedSource(BAMBOO, sourceRevision);
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
    requireAcceptedSource(LOTUS, manifest.sourceRevision);
    return { version, sourceRevision: manifest.sourceRevision, manifestSha256, resourcesSha256: manifest.resourcesSha256,
      tarball: { sha256: digest("sha256", bytes), sizeBytes: bytes.length } };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function releaseChanges(repo, previous, selected, request = api) {
  if (!previous || previous.sourceRevision === selected.sourceRevision) return { compare: null, commits: [] };
  assert.match(previous.sourceRevision, SHA);
  assert.match(selected.sourceRevision, SHA);
  const range = `${previous.sourceRevision}...${selected.sourceRevision}`;
  const perPage = 64;
  const commits = [];
  const seen = new Set();
  let total;
  for (let page = 1; total === undefined || commits.length < total; page += 1) {
    const compare = request(`repos/${repo}/compare/${range}?per_page=${perPage}&page=${page}`);
    assert.equal(compare.merge_base_commit.sha, previous.sourceRevision, "Component source versions have diverged");
    assert.ok(compare.status === "ahead" && compare.behind_by === 0);
    total ??= compare.total_commits;
    assert.ok(Number.isSafeInteger(total) && total > 0);
    assert.equal(compare.total_commits, total, "The component comparison changed between pages");
    assert.equal(compare.commits.length, Math.min(perPage, total - commits.length), "Incomplete component comparison page");
    for (const item of compare.commits) {
      assert.match(item.sha, SHA);
      assert.ok(!seen.has(item.sha), "Duplicate commit in component comparison");
      seen.add(item.sha);
      commits.push({ sha: item.sha, subject: item.commit.message.split(/\r?\n/, 1)[0].trim() });
    }
  }
  assert.ok(seen.has(selected.sourceRevision), "The component comparison did not reach the selected source");
  return { compare: `https://github.com/${repo}/compare/${range}`, commits };
}

function changeNotes(history) {
  const subjects = history.commits.map(commit => Array.from(commit.subject).slice(0, 300).join("")).filter(Boolean);
  if (subjects.length <= 64) return subjects;
  return [...subjects.slice(-63), `另有 ${subjects.length - 63} 条提交，完整记录 ${history.compare}`];
}

async function prepare(bamboo, lotus, previous) {
  assert.match(bamboo, VERSION);
  assert.match(lotus, VERSION);
  const [engine, frontend] = await Promise.all([bambooRelease(bamboo), lotusRelease(lotus)]);
  const changeHistory = {
    bamboo: releaseChanges(BAMBOO, previous?.bamboo, engine),
    lotus: releaseChanges(LOTUS, previous?.lotus, frontend),
  };
  return {
    kind: "bodhi-component-candidate/v1",
    missingBrowserRuntime: engine.artifacts.filter((item) => !item.browserRuntime).map((item) => item.target),
    changeHistory,
    combination: { bamboo: engine, lotus: frontend, changes: {
      bamboo: changeNotes(changeHistory.bamboo), lotus: changeNotes(changeHistory.lotus),
    } },
  };
}

function parseSingleComponentArgs(args) {
  const [component, ...options] = args;
  assert.ok(component === "bamboo" || component === "lotus",
    "Choose one component: --component bamboo|lotus [VERSION|latest] [--from PREVIOUS_VERSION]");
  const version = options.length > 0 && options[0] !== "--from" ? options.shift() : "latest";
  if (version !== "latest") assert.match(version, VERSION, "Expected a stable component version or latest");
  if (options.length === 0) return { component, version, previousVersion: undefined };
  assert.ok(options.length === 2 && options[0] === "--from",
    "Expected --from PREVIOUS_VERSION after the selected component and version");
  const previousVersion = options[1];
  assert.match(previousVersion, VERSION, "Expected an exact stable previous component version");
  return { component, version, previousVersion };
}

async function prepareSingle({ component, version, previousVersion }) {
  const selected = version === "latest" ? await resolveLatestVersion(component) : version;
  const verify = component === "bamboo" ? bambooRelease : lotusRelease;
  const [release, previous] = await Promise.all([
    verify(selected),
    previousVersion && previousVersion !== selected ? verify(previousVersion) : undefined,
  ]);
  return singleCandidate(component, release, previous);
}

function singleCandidate(component, release, previous, request = api) {
  const changeHistory = releaseChanges(component === "bamboo" ? BAMBOO : LOTUS, previous, release, request);
  const candidate = {
    kind: "bodhi-single-component-candidate/v1",
    component,
    release,
    changes: changeNotes(changeHistory),
    changeHistory,
  };
  if (component === "bamboo") {
    candidate.missingBrowserRuntime = release.artifacts.filter((item) => !item.browserRuntime).map((item) => item.target);
  }
  return candidate;
}

function compareVersions(left, right) {
  assert.match(left, VERSION);
  assert.match(right, VERSION);
  const parts = right.split(".").map(BigInt);
  for (const [index, value] of left.split(".").map(BigInt).entries()) {
    if (value !== parts[index]) return value > parts[index] ? 1 : -1;
  }
  return 0;
}

async function readCatalog() {
  const branch = api(`repos/${BODHI}/branches/${CATALOG_BRANCH}`);
  assert.equal(branch.name, CATALOG_BRANCH);
  assert.equal(branch.protected, true, "Require the protected Bodhi component catalog");
  const revision = branch.commit.sha;
  assert.match(revision, SHA);
  const url = `https://raw.githubusercontent.com/${BODHI}/${revision}/channel-v1.json`;
  const bytes = await readBytes(url, 1024 * 1024);
  const catalog = JSON.parse(bytes);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.shellProtocol, 1);
  assert.ok(Array.isArray(catalog.combinations) && catalog.combinations.length > 0, "Missing stable component combinations");
  return { revision, combinations: catalog.combinations };
}

async function prepareSinceCatalog(component, {
  catalog = readCatalog,
  latest = resolveLatestVersion,
  verify = component === "bamboo" ? bambooRelease : lotusRelease,
  request = api,
} = {}) {
  assert.ok(component === "bamboo" || component === "lotus", "Choose Bamboo or Lotus Next");
  const [{ revision, combinations }, version] = await Promise.all([catalog(), latest(component)]);
  const previous = combinations.reduce((newest, entry) => {
    const order = compareVersions(entry[component].version, newest[component].version);
    if (order === 0) {
      assert.deepEqual(entry[component], newest[component], "Matching catalog versions must have the same release identity");
    }
    return order >= 0 ? entry : newest;
  });
  const recorded = previous[component];
  const order = compareVersions(version, recorded.version);
  assert.ok(order >= 0, `${component} latest ${version} is older than the catalog version ${recorded.version}`);
  const release = await verify(version);
  if (order === 0) {
    assert.deepEqual(release, recorded, `${component} ${version} differs from the accepted catalog identity`);
    return null;
  }
  const candidate = singleCandidate(component, release, recorded, request);
  if (component === "bamboo") {
    assert.deepEqual(candidate.missingBrowserRuntime, [], "New Bamboo candidate is missing a desktop browser runtime");
  }
  return { ...candidate, catalog: { revision, sequence: previous.sequence, version: recorded.version } };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  Promise.resolve().then(async () => {
    if (args[0] === "--component") return prepareSingle(parseSingleComponentArgs(args.slice(1)));
    if (args[0] === "--since-catalog") {
      assert.equal(args.length, 2, "Expected --since-catalog bamboo|lotus");
      return prepareSinceCatalog(args[1]);
    }
    const [bamboo, lotus, previous, oldBamboo, oldLotus] = args;
    if (previous === "--from") {
      assert.match(oldBamboo, VERSION);
      assert.match(oldLotus, VERSION);
      const [engine, frontend] = await Promise.all([bambooRelease(oldBamboo), lotusRelease(oldLotus)]);
      return prepare(bamboo, lotus, { bamboo: engine, lotus: frontend });
    }
    return prepare(bamboo, lotus, previous && JSON.parse(fs.readFileSync(previous)).combination);
  })
    .then((candidate) => {
      if (candidate) console.log(JSON.stringify(candidate, null, 2));
    })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { browserArtifacts, changeNotes, parseSingleComponentArgs, prepare, prepareSinceCatalog, releaseChanges, resolveLatestVersion };
