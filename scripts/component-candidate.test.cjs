const assert = require("node:assert/strict");
const { test } = require("node:test");
const { browserArtifacts, changeNotes, releaseChanges } = require("./prepare-component-candidate.cjs");

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

test("change history reads all comparison pages and gives bounded notes a full-history link", () => {
  const previous = { sourceRevision: "a".repeat(40) };
  const items = Array.from({ length: 70 }, (_, index) => ({ sha: index.toString(16).padStart(40, "0"),
    commit: { message: `Change ${index}\nCommit body` } }));
  const selected = { sourceRevision: items.at(-1).sha };
  const requested = [];
  function request(endpoint) {
    const page = Number(new URL(`https://api.github.com/${endpoint}`).searchParams.get("page"));
    requested.push(page);
    return { merge_base_commit: { sha: previous.sourceRevision }, status: "ahead", behind_by: 0, total_commits: items.length,
      commits: items.slice((page - 1) * 64, page * 64) };
  }
  const history = releaseChanges("bigduu/Bamboo-agent", previous, selected, request);
  assert.deepEqual(requested, [1, 2]);
  assert.equal(history.commits.length, 70);
  assert.deepEqual(history.commits.at(-1), { sha: selected.sourceRevision, subject: "Change 69" });
  const notes = changeNotes(history);
  assert.equal(notes.length, 64);
  assert.equal(notes.at(-2), "Change 69");
  assert.ok(notes.at(-1).endsWith(history.compare));

  assert.throws(() => releaseChanges("bigduu/Bamboo-agent", previous, selected, (endpoint) => {
    const result = request(endpoint);
    if (requested.at(-1) === 2) result.commits.pop();
    return result;
  }), /Incomplete component comparison page/);
});
