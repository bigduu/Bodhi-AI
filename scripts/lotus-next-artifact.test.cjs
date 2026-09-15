const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  calculateResourcesSha256,
  verifyLotusNextArtifact,
} = require("./lotus-next-artifact.cjs");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function artifactFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bodhi-lotus-next-artifact-"),
  );
  fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
  fs.writeFileSync(path.join(directory, "index.html"), "<main>Lotus Next</main>\n");
  fs.writeFileSync(
    path.join(directory, "assets", "app.js"),
    "console.log('ok')\n",
  );

  const resources = ["assets/app.js", "index.html"].map((resourcePath) => {
    const contents = fs.readFileSync(path.join(directory, resourcePath));
    return {
      path: resourcePath,
      size: contents.byteLength,
      sha256: sha256(contents),
    };
  });
  const manifest = {
    schemaVersion: 1,
    packageName: "@bigduu/lotus-next",
    packageVersion: "2026.9.16",
    sourceRevision: "a".repeat(40),
    sourceDirty: false,
    entrypoint: "index.html",
    resourcesSha256: calculateResourcesSha256(resources),
    resources,
  };
  const source = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, "lotus-next-manifest.json"), source);
  return { directory, manifest, manifestSha256: sha256(source) };
}

test("verifies an exact clean Lotus Next identity and every resource", (t) => {
  const fixture = artifactFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const result = verifyLotusNextArtifact({
    distDirectory: fixture.directory,
    expectedIdentity: {
      packageName: fixture.manifest.packageName,
      packageVersion: fixture.manifest.packageVersion,
      sourceRevision: fixture.manifest.sourceRevision,
      sourceDirty: false,
      entrypoint: fixture.manifest.entrypoint,
      resourcesSha256: fixture.manifest.resourcesSha256,
      manifestSha256: fixture.manifestSha256,
    },
  });

  assert.equal(result.manifest.resources.length, 2);
  assert.equal(result.manifestSha256, fixture.manifestSha256);
});

test("rejects changed bytes, unlisted resources, and wrong identity", (t) => {
  const fixture = artifactFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const asset = path.join(fixture.directory, "assets", "app.js");
  fs.appendFileSync(asset, "tampered\n");
  assert.throws(
    () => verifyLotusNextArtifact({ distDirectory: fixture.directory }),
    /does not match its manifest/,
  );

  fs.writeFileSync(asset, "console.log('ok')\n");
  fs.writeFileSync(path.join(fixture.directory, "unlisted.txt"), "unexpected\n");
  assert.throws(
    () => verifyLotusNextArtifact({ distDirectory: fixture.directory }),
    /resource inventory does not match/,
  );

  fs.rmSync(path.join(fixture.directory, "unlisted.txt"));
  assert.throws(
    () =>
      verifyLotusNextArtifact({
        distDirectory: fixture.directory,
        expectedIdentity: { sourceRevision: "b".repeat(40) },
      }),
    /sourceRevision .* does not match expected/,
  );
});

test("rejects noncanonical manifests and unsafe portable paths", (t) => {
  const fixture = artifactFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const file = path.join(fixture.directory, "lotus-next-manifest.json");
  fs.writeFileSync(file, JSON.stringify(fixture.manifest));
  assert.throws(
    () => verifyLotusNextArtifact({ distDirectory: fixture.directory }),
    /not canonical/,
  );

  for (const unsafe of [
    "../outside",
    "C:/outside",
    "a\\b",
    "a//b",
    "assets/CON.js",
    "assets/COM¹.log",
    "assets/CONOUT$.txt",
    "assets/question?.js",
    "assets/star*.js",
    "assets/pipe|name.js",
    "assets/quote\"name.js",
    "LOTUS-NEXT-MANIFEST.JSON",
    "assets/trailing. ",
  ]) {
    const next = { ...fixture.manifest };
    next.resources = [
      { path: unsafe, size: 0, sha256: "0".repeat(64) },
      ...fixture.manifest.resources,
    ];
    next.resourcesSha256 = calculateResourcesSha256(next.resources);
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    assert.throws(
      () => verifyLotusNextArtifact({ distDirectory: fixture.directory }),
      /unsafe Lotus Next resource path/,
    );
  }
});

test("rejects case-colliding paths before platform extraction can alias them", (t) => {
  const fixture = artifactFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const file = path.join(fixture.directory, "lotus-next-manifest.json");
  const next = { ...fixture.manifest };
  next.resources = [
    { path: "A.js", size: 0, sha256: "0".repeat(64) },
    { path: "a.js", size: 0, sha256: "0".repeat(64) },
  ];
  next.resourcesSha256 = calculateResourcesSha256(next.resources);
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  assert.throws(
    () => verifyLotusNextArtifact({ distDirectory: fixture.directory }),
    /non-portable case collision/,
  );

  next.resources = [
    { path: "Assets/a.js", size: 0, sha256: "0".repeat(64) },
    { path: "assets/b.js", size: 0, sha256: "0".repeat(64) },
  ];
  next.resourcesSha256 = calculateResourcesSha256(next.resources);
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  assert.throws(
    () => verifyLotusNextArtifact({ distDirectory: fixture.directory }),
    /non-portable case collision/,
  );
});

test("rejects symlinked artifact resources", { skip: process.platform === "win32" }, (t) => {
  const fixture = artifactFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fs.symlinkSync(
    path.join(fixture.directory, "index.html"),
    path.join(fixture.directory, "linked.html"),
  );
  assert.throws(
    () => verifyLotusNextArtifact({ distDirectory: fixture.directory }),
    /must not be a symbolic link/,
  );
});
