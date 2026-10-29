"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const out = require("./release-output.cjs");
const source = require("./release-source.cjs");
const original = require("./replace-v20261031.cjs");
const windows = require("./verify-v31-windows.cjs");

const RUN = 40794385703, CONTROLLER = "3a7a4f1bd4440d8989ffddb817655c76be796700";
const JOB = 123187162939, ARTIFACT = 12862618904;
const DIGEST = "sha256:9e66da51d74cedebd1d434262b18b8c3b103dea441e5558835bb8dcc6893dbac";
const WORKFLOW_BLOB = "336bf77424604d362ece9e7b90ee225abfb4b264";
const SCRIPT_BLOB = "cdb4171ad4bb999a0f734183149950b737db9198";
const RESTORE_BLOB = "044050c852164f0fba587515acbd38485b7acbec";
const TARGET = "x86_64-pc-windows-msvc";

function evidence(request = out.api, readLog) {
  const originalEvidence = windows.evidence(request, readLog);
  const run = request(`actions/runs/${RUN}`);
  assert.equal(run?.id, RUN); assert.equal(run.repository.full_name, out.REPOSITORY);
  assert.equal(run.event, "push"); assert.equal(out.workflow(run.path), windows.WORKFLOW);
  assert.equal(run.head_branch, windows.BRANCH); assert.equal(run.head_sha, CONTROLLER);
  assert.equal(run.status, "completed"); assert.equal(run.conclusion, "success");
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  const commit = request(`git/commits/${CONTROLLER}`); assert.equal(commit?.sha, CONTROLLER);
  assert.deepEqual(commit.parents.map(parent => parent.sha), [windows.BUILD_CONTROLLER]);
  for (const [file, blob] of [[windows.WORKFLOW, WORKFLOW_BLOB], ["scripts/verify-v31-windows.cjs", SCRIPT_BLOB],
    ["scripts/restore-v31-windows.py", RESTORE_BLOB]]) assert.equal(request(`contents/${file}?ref=${CONTROLLER}`)?.sha, blob);
  const rows = out.pages(`actions/runs/${RUN}/jobs?filter=all`, "jobs", request).filter(job => job.name === windows.JOB);
  assert.ok(rows.length); const latest = rows.filter(job => job.run_attempt === Math.max(...rows.map(job => job.run_attempt)));
  assert.equal(latest.length, 1); const logical = latest[0];
  out.passed(logical, ["Authenticate and download the saved original", "Restore saved staging and verify logged Cargo versions", windows.VERIFY, windows.RETAIN]);
  const physical = source.executionOrigin(logical, rows);
  out.passed(physical, ["Authenticate and download the saved original", "Restore saved staging and verify logged Cargo versions", windows.VERIFY, windows.RETAIN]);
  assert.equal(physical.id, JOB);
  const ctx = { runId: RUN, attempt: run.run_attempt, controller: CONTROLLER };
  const name = `bodhi-v31-verified-windows-${RUN}-${physical.run_attempt}`;
  const artifact = out.artifact(out.pages(`actions/runs/${RUN}/artifacts`, "artifacts", request), name, ctx, physical);
  assert.equal(artifact.id, ARTIFACT); assert.equal(artifact.digest, DIGEST);
  return { run, physical, logical, artifact, originalEvidence };
}
function verifyReceipt(receipt, reservation, proof) {
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, "bodhi-v31-revalidated-windows");
  assert.equal(receipt.source, original.FIXED.source); assert.equal(receipt.version, original.FIXED.version); assert.equal(receipt.target, TARGET);
  assert.equal(receipt.reservationSha256, out.sha256(out.bytes(reservation)));
  assert.deepEqual(receipt.builder, { runId: windows.BUILD_RUN, attempt: 1, controller: windows.BUILD_CONTROLLER, jobId: windows.BUILD_JOB });
  assert.deepEqual(receipt.emergency, { id: windows.EMERGENCY_ID, digest: windows.EMERGENCY_DIGEST });
  assert.deepEqual(receipt.diagnostic, { runId: windows.DIAG_RUN, attempt: 1, controller: windows.DIAG_CONTROLLER,
    jobId: windows.DIAG_JOB, yarnBlob: windows.DIAG_YARN_BLOB });
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
