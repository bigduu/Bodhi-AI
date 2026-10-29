"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const out = require("./release-output.cjs");
const original = require("./replace-v20261031.cjs");
const recovery = require("./finalize-replacement-v20261031.cjs");

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
    value => { value.lost.macJobId = 999; },
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    assert.throws(() => recovery.verifyManifest(changed, release, reservation));
  }
  const wrongRelease = structuredClone(release); wrongRelease.assets[0].digest = "sha256:" + "f".repeat(64);
  assert.throws(() => recovery.verifyManifest(manifest, wrongRelease, reservation));
});

test("finalizer verifies retained installer bytes and refuses a changed file", t => {
  const { manifest, reservation } = sample();
  const run = { id: recovery.RECOVERY_RUN, head_sha: recovery.RECOVERY_CONTROLLER, run_attempt: 1 };
  const start = "2026-10-28T00:00:00Z", end = "2026-10-28T00:10:00Z";
  const names = ["Select existing recovered target", "Verify frozen source and stamp version", "Stage the exact prebuilt Lotus package",
    "Verify source boundaries", original.BUILD, original.CAPTURE, original.RETAIN];
  const jobs = manifest.targets.map(item => ({ id: item.receipt.recovery.jobId, run_id: run.id, run_attempt: 1,
    name: `Build recovered (${item.receipt.target})`, head_sha: run.head_sha, status: "completed", conclusion: "success",
    started_at: start, completed_at: end, steps: names.map((name, index) => ({ name, number: index + 1,
      status: "completed", conclusion: "success", started_at: start, completed_at: end })) }));
  const artifacts = manifest.targets.map(item => ({ ...item.artifact, expired: false, size_in_bytes: 100,
    created_at: "2026-10-28T00:05:00Z", workflow_run: { id: run.id, head_sha: run.head_sha } }));
  for (const item of manifest.targets) for (const file of item.receipt.files) {
    file.sha256 = out.sha256(Buffer.alloc(file.size, 7));
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v31-finalizer-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const restore = corrupt => (artifact, entries, directory) => {
    const item = manifest.targets.find(target => target.artifact.id === artifact.id);
    assert.ok(item); assert.deepEqual(entries.sort(), ["target-receipt.json", ...item.receipt.files.map(file => file.name)].sort());
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "target-receipt.json"), JSON.stringify(item.receipt));
    for (const file of item.receipt.files) fs.writeFileSync(path.join(directory, file.name), Buffer.alloc(file.size, corrupt ? 8 : 7));
  };
  const result = recovery.recoveredTargets({ run, jobs, artifacts }, reservation, path.join(root, "valid"), restore(false));
  assert.equal(result.length, 3);
  assert.throws(() => recovery.recoveredTargets({ run, jobs, artifacts }, reservation, path.join(root, "changed"), restore(true)));
});
