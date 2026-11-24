const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BOOTSTRAP_FILE = "src-tauri/component-bootstrap.json";
const CONFIG_FILE = "src-tauri/tauri.thin.conf.json";
const CATALOG_URL = "https://raw.githubusercontent.com/bigduu/Bodhi-AI/components-stable/channel-v1.json";
const INPUTS = Object.freeze([BOOTSTRAP_FILE, CONFIG_FILE].sort());
const SHA256 = /^[0-9a-f]{64}$/;
const LOG_PREFIX = /^\S+Z Bodhi component bootstrap: /;
const WITNESS = /^(\S+) ([1-9][0-9]{0,9}) ([1-9][0-9]{0,19}) [0-9a-f]{64} [0-9a-f]{64} ([-a-z0-9_]+)$/;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function read(root) {
  const files = new Map(INPUTS.map((relative) => {
    const file = path.join(root, relative);
    const metadata = fs.lstatSync(file);
    assert.ok(metadata.isFile() && metadata.size > 0 && metadata.size <= 128 * 1024, `Invalid thin release input ${relative}`);
    assert.equal(fs.realpathSync(file), path.resolve(root, relative), `Unexpected link in thin release input ${relative}`);
    return [relative, fs.readFileSync(file)];
  }));
  const lockHashes = Object.fromEntries(INPUTS.map((file) => [file, sha256(files.get(file))]));
  const config = JSON.parse(files.get(CONFIG_FILE));
  delete config.$schema;
  assert.deepEqual(config, { build: { beforeBuildCommand: null }, bundle: { externalBin: [], resources: [] } });
  const bootstrap = JSON.parse(files.get(BOOTSTRAP_FILE));
  verifyBootstrap(bootstrap, lockHashes);
  return { frontend: null, bootstrap, lockHashes };
}

function verifyBootstrap(bootstrap, lockHashes) {
  assert.deepEqual(Object.keys(bootstrap).sort(), ["catalogUrl", "kind", "shellProtocol"]);
  assert.equal(bootstrap.kind, "bodhi-component-bootstrap/v3");
  assert.equal(bootstrap.catalogUrl, CATALOG_URL, "The installer requires the official component catalog URL");
  assert.ok(Number.isInteger(bootstrap.shellProtocol) && bootstrap.shellProtocol > 0 &&
    bootstrap.shellProtocol <= 0xffffffff, "Invalid shell protocol");
  assert.deepEqual(Object.keys(lockHashes).sort(), INPUTS);
  for (const hash of Object.values(lockHashes)) assert.match(hash, SHA256);
  return bootstrap;
}

function verifyNativeBootstrap(proof, bootstrap, readLog) {
  const jobs = proof.jobs.filter((job) => job.name.startsWith("Unit and E2E ("));
  assert.equal(jobs.length, 5);
  for (const job of jobs) {
    const target = /^Unit and E2E \(([-a-z0-9_]+)\)$/.exec(job.name)?.[1];
    assert.ok(target, "Invalid bootstrap feature job name");
    const markers = readLog(job.id).split(/\r?\n/).filter((line) => LOG_PREFIX.test(line));
    assert.equal(markers.length, 1, `Missing or ambiguous native bootstrap check for ${target}`);
    const witness = WITNESS.exec(markers[0].replace(LOG_PREFIX, ""));
    assert.ok(witness, `Invalid native bootstrap check for ${target}`);
    const [, catalogUrl, shellProtocol, sequence, observedTarget] = witness;
    assert.equal(catalogUrl, bootstrap.catalogUrl, "Bootstrap witness has the wrong catalog URL");
    assert.equal(shellProtocol, String(bootstrap.shellProtocol), "Bootstrap witness has the wrong shell protocol");
    assert.ok(BigInt(sequence) <= 0xffffffffffffffffn, "Invalid catalog sequence");
    assert.equal(observedTarget, target, "Bootstrap witness has the wrong native target");
  }
}

module.exports = { CATALOG_URL, BOOTSTRAP_FILE, CONFIG_FILE, INPUTS, read, verifyBootstrap, verifyNativeBootstrap };
