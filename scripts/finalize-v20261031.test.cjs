"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const out = require("./release-output.cjs");
const original = require("./recover-v20261031.cjs");
const recovery = require("./finalize-v20261031.cjs");

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
  const manifest = { schemaVersion: 1, kind: "bodhi-prebuild-failure-recovery/v1", releaseId: original.FIXED.releaseId,
    reservation, original: { runId: original.FIXED.runId, attempt: 1, controller: original.FIXED.controller,
      artifactId: original.FIXED.artifactId, artifactDigest: original.FIXED.artifactDigest },
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
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    assert.throws(() => recovery.verifyManifest(changed, release, reservation));
  }
  const wrongRelease = structuredClone(release); wrongRelease.assets[0].digest = "sha256:" + "f".repeat(64);
  assert.throws(() => recovery.verifyManifest(manifest, wrongRelease, reservation));
});
