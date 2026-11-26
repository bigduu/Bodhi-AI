const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  browserArtifacts, changeNotes, parseSingleComponentArgs, prepareSinceCatalog, readCatalog, releaseChanges, resolveLatestVersion,
} = require("./prepare-component-candidate.cjs");
const { recommendCandidate, seedCatalog, validateCatalog, withdrawRelease } = require("./component-catalog.cjs");

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

test("single-component arguments allow independent latest and exact release selection", () => {
  assert.deepEqual(parseSingleComponentArgs(["bamboo"]), {
    component: "bamboo", version: "latest", previousVersion: undefined,
  });
  assert.deepEqual(parseSingleComponentArgs(["bamboo", "--from", "2026.11.39"]), {
    component: "bamboo", version: "latest", previousVersion: "2026.11.39",
  });
  assert.deepEqual(parseSingleComponentArgs(["lotus", "latest", "--from", "2026.11.27"]), {
    component: "lotus", version: "latest", previousVersion: "2026.11.27",
  });
  assert.deepEqual(parseSingleComponentArgs(["lotus", "2026.11.30"]), {
    component: "lotus", version: "2026.11.30", previousVersion: undefined,
  });
});

test("single-component arguments reject unstable or ambiguous release selections", () => {
  for (const args of [
    [], ["bamboo", "--from"], ["bamboo", "--from", "latest"], ["bamboo", "--from", "2026.11.38-rc.1"],
    ["lotus", "v2026.11.30"], ["lotus", "2026.11.30-rc.1"], ["lotus", "2026.11.30+build"],
    ["lotus", "2026.11.30", "2026.11.29"], ["lotus", "latest", "--unknown", "2026.11.29"],
    ["lotus", "latest", "--from", "2026.11.29", "2026.11.28"], ["nova", "latest"],
  ]) {
    assert.throws(() => parseSingleComponentArgs(args), `Invalid arguments ${JSON.stringify(args)}`);
  }
});

test("Bamboo latest reads only the official published GitHub release", async () => {
  const release = {
    tag_name: "v2026.11.44", draft: false, prerelease: false, published_at: "2026-11-25T02:48:22Z",
  };
  const npmRead = () => assert.fail("Bamboo must not read the Lotus npm registry");
  const bambooRequest = (value) => (endpoint) => {
    assert.equal(endpoint, "repos/bigduu/Bamboo-agent/releases/latest");
    return value;
  };

  assert.equal(await resolveLatestVersion("bamboo", bambooRequest(release), npmRead), "2026.11.44");
  for (const invalid of [
    { draft: true }, { prerelease: true }, { published_at: null },
    { tag_name: "2026.11.44" }, { tag_name: "v2026.11.44-rc.1" },
  ]) {
    await assert.rejects(() => resolveLatestVersion("bamboo", bambooRequest({ ...release, ...invalid }), npmRead));
  }
});

test("Lotus latest reads only the official package dist-tag", async () => {
  const metadata = { name: "@bigduu/lotus-next", version: "2026.11.30" };
  const githubRequest = () => assert.fail("Lotus must not read the Bamboo GitHub release");
  const lotusRead = (value) => async (url) => {
    assert.equal(url, "https://registry.npmjs.org/%40bigduu%2Flotus-next/latest");
    return Buffer.from(JSON.stringify(value));
  };

  assert.equal(await resolveLatestVersion("lotus", githubRequest, lotusRead(metadata)), "2026.11.30");
  for (const invalid of [{ name: "lotus-next" }, { version: "2026.11.30-rc.1" }, { version: null }]) {
    await assert.rejects(() => resolveLatestVersion("lotus", githubRequest, lotusRead({ ...metadata, ...invalid })));
  }
});

test("catalog discovery uses the explicit recommendation, even when a newer release is retained", async () => {
  const lotus = { version: "2026.11.9", sourceRevision: "b".repeat(40) };
  const published = { version: "2026.11.10", sourceRevision: "c".repeat(40) };
  const baseline = { branchRevision: "a".repeat(40), revision: 3, version: lotus.version, sha256: "f".repeat(64) };
  const catalog = { recommendedVersion: lotus.version, releases: [{ release: lotus }, { release: published }] };
  const candidate = await prepareSinceCatalog("lotus", {
    read: async (component) => {
      assert.equal(component, "lotus");
      return { catalog, baseline };
    },
    latest: async (component) => {
      assert.equal(component, "lotus");
      return published.version;
    },
    verify: async (version) => {
      assert.equal(version, published.version);
      return published;
    },
    request: (endpoint) => {
      assert.equal(endpoint, `repos/bigduu/lotus-next/compare/${lotus.sourceRevision}...${published.sourceRevision}?per_page=64&page=1`);
      return { merge_base_commit: { sha: lotus.sourceRevision }, status: "ahead", behind_by: 0, total_commits: 1,
        commits: [{ sha: published.sourceRevision, commit: { message: "Fix message selection" } }] };
    },
  });
  assert.deepEqual(candidate.catalog, baseline);
  assert.deepEqual(candidate.release, published);
  assert.deepEqual(candidate.changes, ["Fix message selection"]);
});

test("catalog discovery suppresses only an unchanged release and rejects a rewritten or older official version", async () => {
  const bamboo = { version: "2026.11.9", manifest: { sha256: "a".repeat(64) }, artifacts: [] };
  const retained = { ...bamboo, version: "2026.11.10" };
  const deps = {
    read: async () => ({ catalog: { recommendedVersion: bamboo.version, releases: [{ release: bamboo }, { release: retained }] } }),
    latest: async () => bamboo.version,
    verify: async () => structuredClone(bamboo),
  };
  assert.equal(await prepareSinceCatalog("bamboo", deps), null);
  await assert.rejects(prepareSinceCatalog("bamboo", {
    ...deps, verify: async () => ({ ...bamboo, manifest: { sha256: "c".repeat(64) } }),
  }), /differs from the accepted catalog identity/);
  await assert.rejects(prepareSinceCatalog("bamboo", {
    ...deps, latest: async () => "2026.11.8", verify: () => assert.fail("Older release must be rejected"),
  }), /older than the recommended catalog version/);
  await assert.rejects(prepareSinceCatalog("bamboo", {
    ...deps,
    exactVersion: retained.version,
    latest: () => assert.fail("Explicit version must not read upstream latest"),
    verify: async () => ({ ...retained, manifest: { sha256: "c".repeat(64) } }),
  }), /differs from the accepted catalog identity/);
});

test("catalog discovery rejects a newer Bamboo missing a desktop browser runtime", async () => {
  const bamboo = { version: "2026.11.9", sourceRevision: "a".repeat(40) };
  const published = { ...bamboo, version: "2026.11.10", artifacts: [{ target: "aarch64-apple-darwin" }] };
  await assert.rejects(prepareSinceCatalog("bamboo", {
    read: async () => ({ catalog: { recommendedVersion: bamboo.version, releases: [{ release: bamboo }] } }),
    latest: async () => published.version,
    verify: async () => published,
  }), /missing a desktop browser runtime/);
});

function lotusEntry(version) {
  return { release: {
    version, sourceRevision: "a".repeat(40), manifestSha256: "b".repeat(64),
    resourcesSha256: "c".repeat(64), tarball: { sha256: "d".repeat(64), sizeBytes: 354 },
  }, changes: ["Repair startup"] };
}

test("catalog schema admits exact numeric versions, a held recommendation and an empty recommendation", () => {
  const older = lotusEntry("2026.11.9");
  const newer = lotusEntry("2026.11.10");
  const catalog = { schemaVersion: 1, revision: 1, recommendedVersion: older.release.version, releases: [older, newer] };
  assert.deepEqual(validateCatalog("lotus", catalog), catalog);
  validateCatalog("lotus", { ...catalog, recommendedVersion: null, releases: [] });
  for (const invalid of [
    { recommendedVersion: "2026.11.11" }, { releases: [newer, older] }, { releases: [older, older] }, { revision: 0 },
    { releases: [{ ...older, changes: [" "] }] }, { releases: [{ ...older, release: { ...older.release, sourceRevision: "wrong" } }] },
  ]) {
    assert.throws(() => validateCatalog("lotus", { ...catalog, ...invalid }));
  }
});

test("seeding selects only the specified reviewed bootstrap release", () => {
  const reviewed = lotusEntry("2026.11.35");
  const legacy = { schemaVersion: 1, shellProtocol: 1, combinations: [
    { sequence: 9, bootstrap: true, lotus: reviewed.release, changes: { lotus: reviewed.changes } },
    { sequence: 10, bootstrap: false, lotus: lotusEntry("2026.11.36").release, changes: { lotus: [] } },
  ] };
  assert.deepEqual(seedCatalog("lotus", legacy, 9), {
    schemaVersion: 1, revision: 1, recommendedVersion: "2026.11.35", releases: [reviewed],
  });
  assert.throws(() => seedCatalog("lotus", legacy, 10), /reviewed bootstrap sequence/);
});

test("a recommendation retains prior exact identities and rejects a stale per-component baseline", () => {
  const entry = lotusEntry("2026.11.35");
  const next = lotusEntry("2026.11.36");
  const catalog = { schemaVersion: 1, revision: 1, recommendedVersion: entry.release.version, releases: [entry] };
  const baseline = { branchRevision: "a".repeat(40), revision: 1, version: entry.release.version, sha256: "c".repeat(64) };
  const candidate = { kind: "bodhi-single-component-candidate/v1", component: "lotus", catalog: baseline, ...next };
  assert.deepEqual(recommendCandidate("lotus", catalog, { ...baseline, branchRevision: "b".repeat(40) }, candidate), {
    schemaVersion: 1, revision: 2, recommendedVersion: next.release.version, releases: [entry, next],
  });
  assert.throws(() => recommendCandidate("lotus", catalog, { ...baseline, sha256: "d".repeat(64) }, candidate),
    /catalog changed after candidate preflight/);
  assert.throws(() => recommendCandidate("lotus", catalog, baseline, {
    ...candidate, release: { ...entry.release, sourceRevision: "e".repeat(40) },
  }), /replace an admitted release identity/);
});

test("a withdrawal preserves other releases and requires an explicit decision for the recommendation", () => {
  const prior = lotusEntry("2026.11.35");
  const current = lotusEntry("2026.11.36");
  const catalog = { schemaVersion: 1, revision: 2, recommendedVersion: current.release.version, releases: [prior, current] };
  assert.throws(() => withdrawRelease("lotus", catalog, current.release.version), /requires a replacement version or none/);
  assert.deepEqual(withdrawRelease("lotus", catalog, current.release.version, prior.release.version), {
    schemaVersion: 1, revision: 3, recommendedVersion: prior.release.version, releases: [prior],
  });
  assert.equal(withdrawRelease("lotus", catalog, current.release.version, "none").recommendedVersion, null);
  assert.deepEqual(withdrawRelease("lotus", catalog, prior.release.version).releases, [current]);
});

test("catalog baseline requires identical pinned and fixed consumer URL bytes", async () => {
  const entry = lotusEntry("2026.11.35");
  const catalog = { schemaVersion: 1, revision: 1, recommendedVersion: entry.release.version, releases: [entry] };
  const branchRevision = "a".repeat(40);
  const request = (url) => {
    assert.equal(url, "repos/bigduu/Bodhi-AI/branches/components-stable");
    return { name: "components-stable", protected: true, commit: { sha: branchRevision } };
  };
  const expected = Buffer.from(JSON.stringify(catalog));
  const requested = [];
  const read = async (url) => {
    requested.push(url);
    return expected;
  };
  const seen = await readCatalog("lotus", request, read);
  assert.deepEqual(requested, [
    `https://raw.githubusercontent.com/bigduu/Bodhi-AI/${branchRevision}/lotus-v1.json`,
    "https://raw.githubusercontent.com/bigduu/Bodhi-AI/components-stable/lotus-v1.json",
  ]);
  assert.deepEqual(seen.catalog, catalog);
  assert.equal(seen.baseline.branchRevision, branchRevision);
  assert.match(seen.baseline.sha256, /^[0-9a-f]{64}$/);
  await assert.rejects(readCatalog("lotus", request, async (url) =>
    url.includes("/components-stable/") ? Buffer.concat([expected, Buffer.from("\n")]) : expected), /CDN propagation/);
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
