const assert = require("node:assert/strict");
const { test } = require("node:test");
const { browserArtifacts } = require("./prepare-component-candidate.cjs");

function fixture() {
  const version = "2026.11.39", sourceRevision = "a".repeat(40), manifestSha256 = "b".repeat(64);
  const targets = ["aarch64-apple-darwin", "aarch64-pc-windows-msvc", "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"];
  const artifacts = targets.map((target, index) => ({
    target, assetName: `bamboo-browser-runtime-v1-${target}.tar.gz`,
    archive: { sha256: index.toString().repeat(64), sizeBytes: index + 50 }, receiptSha256: "c".repeat(64),
  }));
  return {
    expected: { version, sourceRevision, manifestSha256, targets },
    manifest: { kind: "bamboo-desktop-browser-runtimes/v1", version, sourceRevision, bambooManifestSha256: manifestSha256, artifacts },
    release: { assets: artifacts.map(item => ({ name: item.assetName, state: "uploaded", size: item.archive.sizeBytes,
      digest: `sha256:${item.archive.sha256}` })) },
  };
}

test("desktop browser inputs belong to the exact Bamboo release and all five targets", () => {
  const { expected, manifest, release } = fixture();
  const selected = browserArtifacts(manifest, expected, release);
  assert.deepEqual([...selected.keys()], expected.targets);
  assert.deepEqual(selected.get("aarch64-pc-windows-msvc").archive, manifest.artifacts[1].archive);

  for (const field of ["version", "sourceRevision", "bambooManifestSha256"]) {
    assert.throws(() => browserArtifacts({ ...manifest, [field]: "wrong" }, expected, release));
  }
  assert.throws(() => browserArtifacts({ ...manifest, artifacts: manifest.artifacts.slice(1) }, expected, release));
  const changed = structuredClone(release);
  changed.assets[1].digest = changed.assets[0].digest;
  assert.throws(() => browserArtifacts(manifest, expected, changed));
});
