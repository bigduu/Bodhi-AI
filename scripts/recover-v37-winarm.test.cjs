"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const out = require("./release-output.cjs");
const recovery = require("./recover-v37-winarm.cjs");
const { FIXED } = recovery;

function manifest() {
  const finalizer = { jobId: 42, attempt: 1 };
  return {
    releaseId: FIXED.releaseId,
    reservation: { preflight: { attempt: FIXED.attempt } },
    finalizer,
    captureRecovery: { kind: "bodhi-v37-winarm-capture/v1", runId: 12, controller: "a".repeat(40), ...finalizer },
    targets: [{
      receipt: { target: FIXED.target, jobId: FIXED.buildJobId, attempt: FIXED.attempt,
        files: [{ name: out.names(FIXED.version, FIXED.target)[0], size: FIXED.installerSize, sha256: FIXED.installerSha256 }] },
      artifact: { id: FIXED.emergencyId, name: `bodhi-v4-emergency-${FIXED.runId}-1-${FIXED.target}`, digest: FIXED.emergencyDigest },
    }],
  };
}

test("the v37 exception accepts only the authenticated original installer and archive", () => {
  assert.equal(recovery.verifyCaptureManifest(FIXED, manifest()), FIXED.target);
  for (const key of ["version", "source", "controller", "runId"]) {
    assert.throws(() => recovery.verifyCaptureManifest({ ...FIXED, [key]: "changed" }, manifest()));
  }
  const mutations = [
    value => { value.releaseId++; },
    value => { value.targets[0].receipt.jobId++; },
    value => { value.targets[0].receipt.files[0].sha256 = "a".repeat(64); },
    value => { value.targets[0].artifact.id++; },
    value => { value.targets[0].artifact.name = "replacement"; },
    value => { value.targets[0].artifact.digest = "sha256:" + "a".repeat(64); },
    value => { value.finalizer.jobId++; },
    value => { value.captureRecovery.runId = FIXED.runId; },
  ];
  for (const mutate of mutations) {
    const changed = manifest();
    mutate(changed);
    assert.throws(() => recovery.verifyCaptureManifest(FIXED, changed));
  }
});

test("the retained evidence is bound to the reviewed Main dispatch workflow", () => {
  const workflow = fs.readFileSync(join(__dirname, "..", recovery.WORKFLOW));
  const gitBlob = createHash("sha1").update(`blob ${workflow.length}\0`).update(workflow).digest("hex");
  assert.equal(gitBlob, recovery.WORKFLOW_BLOB);
  const locator = { runId: 12, attempt: 1 };
  const run = {
    id: 12, run_attempt: 1, head_sha: "a".repeat(40), head_branch: "main", event: "workflow_dispatch",
    path: recovery.WORKFLOW, repository: { full_name: out.REPOSITORY }, head_repository: { full_name: out.REPOSITORY },
  };
  const request = (route) => {
    if (route === "actions/runs/12") return run;
    if (route.startsWith("contents/")) return { sha: "b".repeat(40) };
    assert.fail("An unreviewed workflow must fail before loading evidence");
  };
  assert.throws(() => recovery.recoveryProof(locator, request), /Unreviewed recovery workflow/);
  run.head_branch = "dev";
  assert.throws(() => recovery.recoveryProof(locator, request), /'main'/);
});
