"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const out = require("./release-output.cjs");
const source = require("./release-source.cjs");
const original = require("./replace-v20261031.cjs");
const linux = require("./verify-v31-linux.cjs");

const RUN = 40796291226, CONTROLLER = "368f3082ffc0335a32d83750679c29adac12023c";
const PREVIOUS_CONTROLLER = "0e6bc467de1b333163167305342e7b46c1682719";
const JOB = 123193446996, ARTIFACT = 12863892851;
const DIGEST = "sha256:94d0cf5a5dcfb2ecfa8f89921c261f688a786d712f6a850a47a2a79e2f41c899";
const WORKFLOW_BLOB = "c9af6d0f0302e781f4e3e735414a8b843adde7ef";
const SCRIPT_BLOB = "d13cecea803700a5f9cdc5cc677418459bc2ccbf";
const RESTORE_BLOB = "a16303cf4ea62c96c3cf36ffe7d81fd289a98080";
const TARGET = "x86_64-unknown-linux-gnu";

function evidence(request = out.api, readLog) {
  const originalEvidence = linux.evidence(request, readLog);
  const run = request(`actions/runs/${RUN}`);
  assert.equal(run?.id, RUN); assert.equal(run.repository.full_name, out.REPOSITORY);
  assert.equal(run.event, "push"); assert.equal(out.workflow(run.path), linux.WORKFLOW);
  assert.equal(run.head_branch, linux.BRANCH); assert.equal(run.head_sha, CONTROLLER);
  assert.equal(run.status, "completed"); assert.equal(run.conclusion, "success");
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  const commit = request(`git/commits/${CONTROLLER}`); assert.equal(commit?.sha, CONTROLLER);
  assert.deepEqual(commit.parents.map(parent => parent.sha), [PREVIOUS_CONTROLLER]);
  assert.deepEqual(request(`git/commits/${PREVIOUS_CONTROLLER}`).parents.map(parent => parent.sha), [linux.BUILD_CONTROLLER]);
  for (const [file, blob] of [[linux.WORKFLOW, WORKFLOW_BLOB], ["scripts/verify-v31-linux.cjs", SCRIPT_BLOB],
    ["scripts/restore-v31-linux.py", RESTORE_BLOB], ["scripts/check-v31-cargo-log.py", "f44268dd7cd3c4843bc8ccabde4b2c887e827c81"]]) assert.equal(request(`contents/${file}?ref=${CONTROLLER}`)?.sha, blob);
  const rows = out.pages(`actions/runs/${RUN}/jobs?filter=all`, "jobs", request).filter(job => job.name === linux.JOB);
  assert.ok(rows.length); const latest = rows.filter(job => job.run_attempt === Math.max(...rows.map(job => job.run_attempt)));
  assert.equal(latest.length, 1); const logical = latest[0];
  out.passed(logical, ["Authenticate and download the saved original", "Restore saved staging and verify logged Cargo versions", linux.VERIFY, linux.RETAIN]);
  const physical = source.executionOrigin(logical, rows);
  out.passed(physical, ["Authenticate and download the saved original", "Restore saved staging and verify logged Cargo versions", linux.VERIFY, linux.RETAIN]);
  assert.equal(physical.id, JOB);
  const ctx = { runId: RUN, attempt: run.run_attempt, controller: CONTROLLER };
  const name = `bodhi-v31-verified-linux-${RUN}-${physical.run_attempt}`;
  const artifact = out.artifact(out.pages(`actions/runs/${RUN}/artifacts`, "artifacts", request), name, ctx, physical);
  assert.equal(artifact.id, ARTIFACT); assert.equal(artifact.digest, DIGEST);
  return { run, physical, logical, artifact, originalEvidence };
}
function verifyReceipt(receipt, reservation, proof) {
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, "bodhi-v31-revalidated-linux");
  assert.equal(receipt.source, original.FIXED.source); assert.equal(receipt.version, original.FIXED.version); assert.equal(receipt.target, TARGET);
  assert.equal(receipt.reservationSha256, out.sha256(out.bytes(reservation)));
  assert.deepEqual(receipt.builder, { runId: linux.BUILD_RUN, attempt: 1, controller: linux.BUILD_CONTROLLER, jobId: linux.BUILD_JOB });
  assert.deepEqual(receipt.emergency, { id: linux.EMERGENCY_ID, digest: linux.EMERGENCY_DIGEST });
  assert.deepEqual(receipt.diagnostic, { runId: linux.DIAG_RUN, attempt: 1, controller: linux.DIAG_CONTROLLER,
    jobId: linux.DIAG_JOB, yarnBlob: linux.DIAG_YARN_BLOB });
  assert.deepEqual(receipt.limitations, { originalYarnLockRetained: false, originalCargoLockRetained: false });
  assert.deepEqual(receipt.validation, { runId: RUN, attempt: proof.physical.run_attempt, controller: CONTROLLER, jobId: proof.physical.id });
  assert.deepEqual(receipt.checks, [...out.checks(TARGET), "locked-cargo-log-versions", "reproduced-npm-platform-lock"]);
  assert.deepEqual(receipt.files.map(file => file.name), out.names(original.FIXED.version, TARGET));
  for (const file of receipt.files) {
    assert.match(file.sha256 || "", /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 1024 ** 2 && file.size <= 4 * 1024 ** 3);
  }
}
function select(proof, reservation, directory, restore = out.download) {
  restore(proof.artifact, ["target-receipt.json", ...out.names(original.FIXED.version, TARGET)], directory);
  const receipt = out.readJson(path.join(directory, "target-receipt.json"));
  verifyReceipt(receipt, reservation, proof);
  for (const file of receipt.files) {
    const actual = path.join(directory, file.name);
    assert.equal(fs.lstatSync(actual).size, file.size); assert.equal(out.hashFile(actual), file.sha256);
  }
  return { receipt, artifact: { id: proof.artifact.id, name: proof.artifact.name, digest: proof.artifact.digest },
    logical: { id: proof.logical.id, attempt: proof.logical.run_attempt }, directory };
}
module.exports = { RUN, CONTROLLER, JOB, ARTIFACT, DIGEST, TARGET, evidence, verifyReceipt, select };
