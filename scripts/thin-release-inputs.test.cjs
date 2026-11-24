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

test("recovery routes v4 to the original-output finalizer", () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, "../.github/workflows/recover-release.yml"), "utf8");
  assert.match(workflow, /^  recover:\n    if: inputs\.evidence_schema == '1'$/m);
  assert.match(workflow, /^  recover-original:\n    if: inputs\.evidence_schema == '2' \|\| inputs\.evidence_schema == '3' \|\| inputs\.evidence_schema == '4'$/m);
});

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

test("thin inputs bind the shell while native witnesses can observe different component pairs", (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bodhi-thin-inputs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src-tauri"));
  const trusted = Buffer.from(JSON.stringify({ signed: { _type: "root", consistent_snapshot: true } }));
  const record = {
    kind: "bodhi-component-bootstrap/v2",
    rootSha256: crypto.createHash("sha256").update(trusted).digest("hex"),
    shellProtocol: 1,
  };
  fs.writeFileSync(path.join(root, inputs.ROOT_FILE), trusted);
  fs.writeFileSync(path.join(root, inputs.BOOTSTRAP_FILE), JSON.stringify(record));
  fs.writeFileSync(path.join(root, inputs.CONFIG_FILE), JSON.stringify({
    build: { beforeBuildCommand: null }, bundle: { externalBin: [], resources: [] },
  }));
  const accepted = inputs.read(root);
  assert.equal(accepted.frontend, null);
  assert.deepEqual(accepted.bootstrap, record);
  assert.deepEqual(Object.keys(accepted.lockHashes).sort(), inputs.INPUTS);
  assert.throws(() => inputs.verifyBootstrap({ ...record, sequence: 2 }, accepted.lockHashes));
  assert.throws(() => inputs.verifyBootstrap({ ...record, shellProtocol: 0 }, accepted.lockHashes), /Invalid shell protocol/);
  const targets = source.featureTargets(source.ARM64_FEATURE_WORKFLOW_BLOB);
  const proof = { jobs: targets.map((target, id) => ({ id, name: `Unit and E2E (${target})` })) };
  const marker = (id, {
    rootSha256 = record.rootSha256,
    protocol = record.shellProtocol,
    sequence = id + 2,
    bamboo = String(id).repeat(64),
    lotus = "b".repeat(64),
    target = targets[id],
  } = {}) => `2026-11-24T00:00:00Z Bodhi component bootstrap: ${rootSha256} ${protocol} ${sequence} ${bamboo} ${lotus} ${target}`;
  assert.doesNotThrow(() => inputs.verifyNativeBootstrap(proof, record, marker));
  for (const [badMarker, error] of [
    ["", /Missing or ambiguous/],
    [`${marker(0)}\n${marker(0)}`, /Missing or ambiguous/],
    [marker(0, { rootSha256: "f".repeat(64) }), /wrong trust root/],
    [marker(0, { protocol: 2 }), /wrong shell protocol/],
    [marker(0, { target: targets[1] }), /wrong native target/],
    [marker(0, { bamboo: "invalid" }), /Invalid native bootstrap check/],
    [marker(0, { sequence: 0x10000000000000000n }), /Invalid signed catalog sequence/],
  ]) {
    assert.throws(() => inputs.verifyNativeBootstrap(proof, record, (id) => id === 0 ? badMarker : marker(id)), error);
  }
  fs.appendFileSync(path.join(root, inputs.ROOT_FILE), "\n");
  assert.throws(() => inputs.read(root));
});
