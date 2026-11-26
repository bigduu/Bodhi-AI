const assert = require("node:assert/strict");
const { V3_TARGETS } = require("./bamboo-sidecar.cjs");

const VERSION = /^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_CATALOG_BYTES = 1024 * 1024;

function compareVersions(left, right) {
  assert.match(left, VERSION);
  assert.match(right, VERSION);
  const parts = right.split(".").map(BigInt);
  for (const [index, value] of left.split(".").map(BigInt).entries()) {
    if (value !== parts[index]) return value > parts[index] ? 1 : -1;
  }
  return 0;
}

function catalogFilename(component) {
  assert.ok(component === "bamboo" || component === "lotus", "Choose Bamboo or Lotus Next");
  return `${component}-v1.json`;
}

function objectKeys(value, required) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected a catalog object");
  assert.deepEqual(Object.keys(value).sort(), [...required].sort());
}

function assetIdentity(asset, min, max) {
  objectKeys(asset, ["sha256", "sizeBytes"]);
  assert.match(asset.sha256, SHA256);
  assert.ok(Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes >= min && asset.sizeBytes <= max, "Invalid asset size");
}

function releaseIdentity(component, release) {
  if (component === "bamboo") {
    objectKeys(release, ["version", "sourceRevision", "manifest", "browserHost", "artifacts"]);
    assetIdentity(release.manifest, 1, 1024 ** 2);
    assetIdentity(release.browserHost, 1, 8 * 1024 ** 2);
    assert.ok(Array.isArray(release.artifacts), "Expected Bamboo native artifacts");
    assert.deepEqual(release.artifacts.map(({ target }) => target), V3_TARGETS);
    for (const artifact of release.artifacts) {
      objectKeys(artifact, ["target", "assetName", "executable", "browserRuntime"]);
      const { target, browserRuntime } = artifact;
      const suffix = target.endsWith("-windows-msvc") ? ".exe" : "";
      assert.equal(artifact.assetName, `bamboo-${target}${suffix}`);
      assetIdentity(artifact.executable, 65_536, 1024 ** 3);
      objectKeys(browserRuntime, ["assetName", "archive", "receiptSha256"]);
      assert.equal(browserRuntime.assetName, `bamboo-browser-runtime-v1-${target}.tar.gz`);
      assetIdentity(browserRuntime.archive, 1, 768 * 1024 ** 2);
      assert.match(browserRuntime.receiptSha256, SHA256);
    }
  } else {
    objectKeys(release, ["version", "sourceRevision", "manifestSha256", "resourcesSha256", "tarball"]);
    assert.match(release.manifestSha256, SHA256);
    assert.match(release.resourcesSha256, SHA256);
    assetIdentity(release.tarball, 1, 32 * 1024 ** 2);
  }
  assert.match(release.version, VERSION);
  const maxPart = component === "bamboo" ? 0xffff_ffffn : 0xffff_ffff_ffff_ffffn;
  assert.ok(release.version.split(".").every((part) => BigInt(part) <= maxPart), "Invalid stable version");
  assert.match(release.sourceRevision, SHA);
}

function validateCatalog(component, catalog) {
  catalogFilename(component);
  objectKeys(catalog, ["schemaVersion", "revision", "recommendedVersion", "releases"]);
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(Number.isSafeInteger(catalog.revision) && catalog.revision > 0, "Invalid catalog revision");
  assert.ok(Array.isArray(catalog.releases) && catalog.releases.length <= 64, "Invalid admitted release inventory");
  let previous;
  for (const entry of catalog.releases) {
    objectKeys(entry, ["release", "changes"]);
    releaseIdentity(component, entry.release);
    const version = entry.release.version;
    assert.ok(!previous || compareVersions(previous, version) < 0, "Catalog releases must be unique and ascending");
    assert.ok(Array.isArray(entry.changes) && entry.changes.length <= 64 && entry.changes.every((line) =>
      typeof line === "string" && line.trim().length > 0 && Buffer.byteLength(line) <= 2048), "Invalid catalog change notes");
    previous = version;
  }
  assert.ok(catalog.recommendedVersion === null || catalog.releases.some(({ release }) =>
    release.version === catalog.recommendedVersion), "The recommendation must refer to an admitted release");
  return catalog;
}

function seedCatalog(component, legacy, sequence) {
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.shellProtocol, 1);
  const reviewed = legacy.combinations.find((pair) => pair.sequence === sequence && pair.bootstrap);
  assert.ok(reviewed, "Expected a reviewed bootstrap sequence");
  const release = reviewed[component];
  return validateCatalog(component, {
    schemaVersion: 1,
    revision: 1,
    recommendedVersion: release.version,
    releases: [{ release, changes: reviewed.changes[component] }],
  });
}

function recommendCandidate(component, current, baseline, candidate) {
  assert.equal(candidate.kind, "bodhi-single-component-candidate/v1");
  assert.equal(candidate.component, component);
  const { branchRevision, ...checked } = candidate.catalog;
  const { branchRevision: currentBranch, ...expected } = baseline;
  assert.match(branchRevision, SHA);
  assert.match(currentBranch, SHA);
  assert.deepEqual(checked, expected, "The catalog changed after candidate preflight");
  const { release, changes } = candidate;
  const retained = current.releases.find((entry) => entry.release.version === release.version);
  if (retained) assert.deepEqual(retained.release, release, "Cannot replace an admitted release identity");
  const releases = retained
    ? current.releases
    : [...current.releases, { release, changes }].sort((a, b) => compareVersions(a.release.version, b.release.version));
  return validateCatalog(component, {
    ...current, revision: current.revision + 1, recommendedVersion: release.version, releases,
  });
}

function withdrawRelease(component, current, version, recommendation) {
  const releases = current.releases.filter((entry) => entry.release.version !== version);
  assert.ok(releases.length < current.releases.length, "The version to withdraw must already be admitted");
  assert.ok(recommendation !== undefined || current.recommendedVersion !== version,
    "Withdrawing the recommendation requires a replacement version or none");
  const recommendedVersion = recommendation === "none" ? null : recommendation ?? current.recommendedVersion;
  return validateCatalog(component, {
    ...current, revision: current.revision + 1, recommendedVersion, releases,
  });
}

module.exports = {
  catalogFilename, compareVersions, MAX_CATALOG_BYTES, recommendCandidate, seedCatalog, validateCatalog, withdrawRelease,
};
