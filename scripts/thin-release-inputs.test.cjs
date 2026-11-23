const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const out = require("./release-output.cjs");
const source = require("./release-source.cjs");
const inputs = require("./thin-release-inputs.cjs");

test("the reviewed dispatcher and immutable product marker select v4", () => {
  const real = execFileSync("git", ["hash-object", ".github/workflows/release.yml"], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8",
  }).trim();
  assert.equal(out.THIN_RELEASE_WORKFLOW_BLOB, real);
  const controller = "b".repeat(40);
  const ctx = { source: "a".repeat(40), version: "2026.11.35", runId: 1, attempt: 1 };
  const lookup = (producer, marker) => (key) => {
    if (key === `contents/.github/workflows/release.yml?ref=${controller}`) return { sha: producer };
    if (key === `contents/.github/workflows/ci.yml?ref=${ctx.source}`) return { sha: source.ARM64_FEATURE_WORKFLOW_BLOB };
    if (key === `contents/${inputs.BOOTSTRAP_FILE}?ref=${ctx.source}`) return marker;
    throw Error(`Unexpected request ${key}`);
  };
  const selected = out.originalContext(ctx, controller, lookup(real, { sha: "c".repeat(40) }));
  assert.equal(out.releaseContract(selected).schemaVersion, 4);
  assert.equal(out.releaseContract(selected).targets.length, 5);
  const unchanged = out.originalContext(ctx, controller, lookup(real, null));
  assert.equal(out.releaseContract(unchanged).schemaVersion, 3);
  const original = out.originalContext(ctx, controller, lookup(out.ARM64_RELEASE_WORKFLOW_BLOB, { sha: "c".repeat(40) }));
  assert.equal(out.releaseContract(original).schemaVersion, 3);
});

test("thin inputs bind the root and all original native bootstrap witnesses", (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bodhi-thin-inputs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src-tauri"));
  const trusted = Buffer.from(JSON.stringify({ signed: { _type: "root", consistent_snapshot: true } }));
  const record = { kind: "bodhi-component-bootstrap/v1", sequence: 2,
    rootSha256: crypto.createHash("sha256").update(trusted).digest("hex"),
    bambooManifestSha256: "a".repeat(64), lotusManifestSha256: "b".repeat(64) };
  fs.writeFileSync(path.join(root, inputs.ROOT_FILE), trusted);
  fs.writeFileSync(path.join(root, inputs.BOOTSTRAP_FILE), JSON.stringify(record));
  fs.writeFileSync(path.join(root, inputs.CONFIG_FILE), JSON.stringify({
    build: { beforeBuildCommand: null }, bundle: { externalBin: [], resources: [] },
  }));
  const accepted = inputs.read(root);
  assert.equal(accepted.frontend, null);
  assert.deepEqual(accepted.bootstrap, record);
  const targets = source.featureTargets(source.ARM64_FEATURE_WORKFLOW_BLOB);
  const proof = { jobs: targets.map((target, id) => ({ id, name: `Unit and E2E (${target})` })) };
  const marker = (id) => `2026-11-24T00:00:00Z Bodhi component bootstrap: ${record.rootSha256} 2 ${record.bambooManifestSha256} ${record.lotusManifestSha256} ${targets[id]}`;
  assert.doesNotThrow(() => inputs.verifyNativeBootstrap(proof, record, marker));
  assert.throws(() => inputs.verifyNativeBootstrap(proof, record, (id) => id === 0 ? "" : marker(id)), /Missing or ambiguous/);
  fs.appendFileSync(path.join(root, inputs.ROOT_FILE), "\n");
  assert.throws(() => inputs.read(root));
});
