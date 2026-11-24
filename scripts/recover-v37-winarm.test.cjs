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
    captureRecovery: { kind: "bodhi-v37-winarm-capture/v1", runId: 12, controller: "a".repeat(40), ...finalizer,
      admission: { pullRequest: 51, runId: 52, attempt: 2, tree: "b".repeat(40) } },
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
    value => { value.captureRecovery.admission.attempt = 0; },
    value => { value.captureRecovery.admission.tree = "changed"; },
  ];
  for (const mutate of mutations) {
    const changed = manifest();
    mutate(changed);
    assert.throws(() => recovery.verifyCaptureManifest(FIXED, changed));
  }
});

test("the retained evidence is bound to the reviewed Dev dispatch workflow", () => {
  const workflow = fs.readFileSync(join(__dirname, "..", recovery.WORKFLOW));
  const gitBlob = createHash("sha1").update(`blob ${workflow.length}\0`).update(workflow).digest("hex");
  assert.equal(gitBlob, recovery.WORKFLOW_BLOB);
  const locator = { runId: 12, attempt: 1 };
  const run = {
    id: 12, run_attempt: 1, head_sha: "a".repeat(40), head_branch: "dev", event: "workflow_dispatch",
    display_title: `Recover Bodhi v${FIXED.version} from ${FIXED.runId} attempt ${FIXED.attempt}`,
    path: recovery.WORKFLOW, repository: { full_name: out.REPOSITORY }, head_repository: { full_name: out.REPOSITORY },
  };
  const request = (route) => {
    if (route === "actions/runs/12") return run;
    if (route.startsWith("contents/")) return { sha: "b".repeat(40) };
    assert.fail("An unreviewed workflow must fail before loading evidence");
  };
  assert.throws(() => recovery.recoveryProof(locator, request), /Unreviewed recovery workflow/);
  const unprotected = (route) => {
    if (route === "actions/runs/12") return run;
    if (route.startsWith("contents/")) return { sha: recovery.WORKFLOW_BLOB };
    if (route === "branches/dev") return { protected: false };
    assert.fail("An unprotected controller must fail before loading evidence");
  };
  assert.throws(() => recovery.recoveryProof(locator, unprotected), /Dev must be protected/);
  run.head_branch = "main";
  assert.throws(() => recovery.recoveryProof(locator, request), /'dev'/);
});

test("the recovery controller uses the protected feature admission for its exact source", () => {
  const controller = "a".repeat(40);
  const tree = "b".repeat(40);
  const input = { pullRequest: "51", runId: "52", attempt: "2" };
  const request = () => assert.fail("Use the configured read-only GitHub request");
  const proof = { source: controller, pullRequest: 51, runId: 52, attempt: 2, tree };
  assert.deepEqual(recovery.controllerAdmission(controller, input, request, (identity, api) => {
    assert.deepEqual(identity, { source: controller, ...input });
    assert.equal(api, request);
    return proof;
  }), { pullRequest: 51, runId: 52, attempt: 2, tree });
  assert.throws(() => recovery.controllerAdmission(controller, input, request, () =>
    ({ ...proof, source: "c".repeat(40) })), /does not admit this recovery controller/);
});

test("fixed recovery never replaces a different latest stable release", () => {
  const release = { id: FIXED.priorReleaseId, tag_name: "app-v2026.11.36", draft: false, prerelease: false };
  const request = route => { assert.equal(route, "releases/latest"); return release; };
  recovery.requireExpectedLatest(request);
  release.tag_name = "app-v2026.11.38";
  assert.throws(() => recovery.requireExpectedLatest(request), /latest stable Bodhi release changed/);
  release.tag_name = "app-v2026.11.37";
  assert.throws(() => recovery.requireExpectedLatest(request), /latest stable Bodhi release changed/);
  release.id = FIXED.releaseId;
  recovery.requireExpectedLatest(request);
  release.draft = true;
  assert.throws(() => recovery.requireExpectedLatest(request), /latest stable Bodhi release changed/);
});
