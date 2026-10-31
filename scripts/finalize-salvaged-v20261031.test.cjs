"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const out = require("./release-output.cjs");
const original = require("./replace-v20261031.cjs");
const recovery = require("./finalize-salvaged-v20261031.cjs");
const windows = require("./v31-windows-proof.cjs");
const win = require("./verify-v31-windows.cjs");
const linux = require("./v31-linux-proof.cjs");
const lin = require("./verify-v31-linux.cjs");
const main = require("./main-admission.cjs");

function sample() {
  const reservation = { source: original.FIXED.source };
  const assets = [], targets = [];
  out.NATIVE_TARGETS.forEach((target, index) => {
    const jobId = index + 100, attempt = 1;
    const files = out.names(original.FIXED.version, target).map((name, fileIndex) => {
      const sha256 = String(index + fileIndex + 1).repeat(64), id = assets.length + 1, size = 1024 ** 2;
      assets.push({ id, name, size, digest: `sha256:${sha256}`, state: "uploaded",
        url: `https://api.github.com/repos/${out.REPOSITORY}/releases/assets/${id}`,
        browser_download_url: `https://github.com/${out.REPOSITORY}/releases/download/${original.originalContext().draftTag}/${name}` });
      return { name, size, sha256 };
    });
    if ([windows.TARGET, linux.TARGET].includes(target)) {
      const platform = target === windows.TARGET ? "windows" : "linux";
      const proof = platform === "windows" ? windows : linux, verifier = platform === "windows" ? win : lin;
      targets.push({ receipt: { schemaVersion: 1, kind: `bodhi-v31-revalidated-${platform}`, source: original.FIXED.source,
        version: original.FIXED.version, target, reservationSha256: out.sha256(out.bytes(reservation)),
        builder: { runId: verifier.BUILD_RUN, attempt: 1, controller: verifier.BUILD_CONTROLLER, jobId: verifier.BUILD_JOB },
        emergency: { id: verifier.EMERGENCY_ID, digest: verifier.EMERGENCY_DIGEST },
        diagnostic: { runId: verifier.DIAG_RUN, attempt: 1, controller: verifier.DIAG_CONTROLLER, jobId: verifier.DIAG_JOB, yarnBlob: verifier.DIAG_YARN_BLOB },
        limitations: { originalYarnLockRetained: false, originalCargoLockRetained: false },
        validation: { runId: proof.RUN, attempt: 1, controller: proof.CONTROLLER, jobId: proof.JOB },
        checks: [...out.checks(target), "locked-cargo-log-versions", "reproduced-npm-platform-lock"], files },
        artifact: { id: proof.ARTIFACT, name: `bodhi-v31-verified-${platform}-${proof.RUN}-1`, digest: proof.DIGEST },
        logical: { id: proof.JOB, attempt: 1 } });
      return;
    }
    targets.push({ receipt: { schemaVersion: 1, kind: "bodhi-v31-recovered-target", source: original.FIXED.source,
      version: original.FIXED.version, originalRunId: original.FIXED.runId, reservationSha256: out.sha256(out.bytes(reservation)),
      recovery: { runId: recovery.RECOVERY_RUN, attempt, controller: recovery.RECOVERY_CONTROLLER, jobId }, target,
      checks: out.checks(target), files }, artifact: { id: index + 10,
        name: original.artifactName({ runId: recovery.RECOVERY_RUN }, target, attempt), digest: "sha256:" + "a".repeat(64) },
      logical: { id: jobId, attempt } });
  });
  const manifest = { schemaVersion: 1, kind: "bodhi-lost-output-replacement/v1", releaseId: original.FIXED.releaseId,
    reservation, original: { runId: original.FIXED.runId, attempt: 1, controller: original.FIXED.controller,
      artifactId: original.FIXED.artifactId, artifactDigest: original.FIXED.artifactDigest },
    lost: { runId: original.LOST_RUN, attempt: 1, controller: original.LOST_CONTROLLER,
      macJobId: original.LOST_JOBS["aarch64-apple-darwin"] },
    recovery: { runId: recovery.RECOVERY_RUN, attempt: 1, controller: recovery.RECOVERY_CONTROLLER },
    publisher: { runId: 4, attempt: 1, controller: "a".repeat(40), jobId: 5 }, targets,
    assets: assets.map(({ id, name, size, digest, state }) => ({ id, name, size, digest, state })).sort((a, b) => a.name.localeCompare(b.name)) };
  return { manifest, release: { assets }, reservation };
}

test("recovered installer evidence binds original source, physical jobs and exact release bytes", () => {
  const { manifest, release, reservation } = sample();
  assert.doesNotThrow(() => recovery.verifyManifest(manifest, release, reservation));
  for (const mutate of [
    value => { value.targets[0].receipt.source = "f".repeat(40); },
    value => { value.original.artifactDigest = "sha256:" + "f".repeat(64); },
    value => { value.targets[0].receipt.files[0].sha256 = "f".repeat(64); },
    value => { value.targets[1].artifact.id = value.targets[0].artifact.id; },
    value => { value.targets[0].logical.id = 999; },
    value => { value.targets[0].receipt.recovery.runId = 999; },
    value => { value.targets[2].receipt.emergency.id = 999; },
    value => { value.targets[2].receipt.limitations.originalCargoLockRetained = true; },
    value => { value.targets.find(item => item.receipt.target === linux.TARGET).receipt.validation.jobId++; },
    value => { value.targets.find(item => item.receipt.target === linux.TARGET).receipt.limitations.originalYarnLockRetained = true; },
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    assert.throws(() => recovery.verifyManifest(changed, release, reservation));
  }
  const wrongRelease = structuredClone(release); wrongRelease.assets[0].digest = "sha256:" + "f".repeat(64);
  assert.throws(() => recovery.verifyManifest(manifest, wrongRelease, reservation));
});

test("Main binds preserved Linux and Windows outputs to their actual verification jobs", () => {
  const { manifest } = sample();
  const run = { id: recovery.RECOVERY_RUN, head_sha: recovery.RECOVERY_CONTROLLER, run_attempt: 1 };
  const start = "2026-10-28T00:00:00Z", end = "2026-10-28T00:10:00Z";
  const steps = ["Select existing recovered target", "Verify frozen source and stamp version", "Stage the exact prebuilt Lotus package",
    "Verify source boundaries", original.BUILD, original.CAPTURE, original.RETAIN].map((name, index) => ({
      name, number: index + 1, status: "completed", conclusion: "success", started_at: start, completed_at: end }));
  const native = manifest.targets.filter(item => ![windows.TARGET, linux.TARGET].includes(item.receipt.target));
  const jobs = native.map(item => ({ id: item.receipt.recovery.jobId, run_id: run.id, run_attempt: 1,
    name: `Build recovered (${item.receipt.target})`, head_sha: run.head_sha, status: "completed", conclusion: "success",
    started_at: start, completed_at: end, steps: structuredClone(steps) }));
  const artifacts = native.map(item => ({ ...item.artifact, expired: false, size_in_bytes: 100,
    created_at: "2026-10-28T00:05:00Z", workflow_run: { id: run.id, head_sha: run.head_sha } }));
  const winItem = manifest.targets.find(item => item.receipt.target === windows.TARGET);
  const winProof = { physical: { id: windows.JOB, run_attempt: 1 }, logical: { id: windows.JOB, run_attempt: 1 }, artifact: winItem.artifact };
  const linItem = manifest.targets.find(item => item.receipt.target === linux.TARGET);
  const linProof = { physical: { id: linux.JOB, run_attempt: 1 }, logical: { id: linux.JOB, run_attempt: 1 }, artifact: linItem.artifact };
  assert.doesNotThrow(() => main.recovered31Targets({ run, jobs, artifacts }, manifest, winProof, linProof));
  const badJob = structuredClone(jobs); badJob[0].steps[4].conclusion = "failure";
  assert.throws(() => main.recovered31Targets({ run, jobs: badJob, artifacts }, manifest, winProof, linProof));
  const badArtifact = structuredClone(artifacts); badArtifact[0].digest = "sha256:" + "f".repeat(64);
  assert.throws(() => main.recovered31Targets({ run, jobs, artifacts: badArtifact }, manifest, winProof, linProof));
  const badWindows = structuredClone(manifest); badWindows.targets.find(item => item.receipt.target === windows.TARGET).artifact.id++;
  assert.throws(() => main.recovered31Targets({ run, jobs, artifacts }, badWindows, winProof, linProof));
  const badLinux = structuredClone(manifest); badLinux.targets.find(item => item.receipt.target === linux.TARGET).artifact.id++;
  assert.throws(() => main.recovered31Targets({ run, jobs, artifacts }, badLinux, winProof, linProof));
});
