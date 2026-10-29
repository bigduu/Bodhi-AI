#!/usr/bin/env node
"use strict";

// The user authorized a replacement after the prior Mac build was lost.
// Keep both earlier runs and the actual replacement job identities distinct.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const out = require("./release-output.cjs");
const source = require("./release-source.cjs");
const original = require("./replace-v20261031.cjs");
const finalizer = require("./release-finalizer-v2.cjs");
const windows = require("./v31-windows-proof.cjs");
const linux = require("./v31-linux-proof.cjs");

const RECOVERY_RUN = 40791597216;
const RECOVERY_CONTROLLER = "977d4dfeb715f8ce688173d067ab5a9361520d0d";
const WORKFLOW = ".github/workflows/finalize-salvaged-v20261031.yml";
const MANIFEST = "bodhi-release-v31-replacement.json";
const JOB = "Finalize recovered Bodhi release";
const ASSEMBLE = "Verify replacement builds and upload assets";
const EVIDENCE = "Retain verified recovery publication evidence";
const PUBLISH = "Publish the original reserved release";
const identity = asset => ({ id: asset.id, name: asset.name, size: asset.size, digest: asset.digest, state: asset.state });
const sortedAssets = release => release.assets.map(identity).sort((a, b) => a.name.localeCompare(b.name));

function originalProof(request = out.api, readLog, restore = out.download) {
  const ctx = original.originalContext(); out.run(ctx, request, true);
  const jobs = out.jobs(ctx, request);
  const log = readLog || (id => execFileSync("gh", ["api", `repos/${out.REPOSITORY}/actions/jobs/${id}/logs`, "--allow-escape-sequences"],
    { env: out.childEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  for (const target of out.NATIVE_TARGETS) {
    const rows = jobs.filter(job => job.name === `Build original (${target})`);
    assert.equal(rows.length, 1); original.assertOriginalFailure(rows[0], target, log(rows[0].id));
  }
  original.assertLostRecovery(request, log);
  const retained = out.loadReservation(ctx, request, restore);
  assert.equal(retained.release.id, original.FIXED.releaseId);
  assert.equal(retained.artifact.id, original.FIXED.artifactId);
  assert.equal(retained.artifact.digest, original.FIXED.artifactDigest);
  finalizer.available(ctx, request, retained.release, true);
  finalizer.refreshSource(ctx, retained.reservation, request);
  return retained;
}
function recoveryRun(request = out.api) {
  const run = request(`actions/runs/${RECOVERY_RUN}`);
  assert.equal(run?.id, RECOVERY_RUN); assert.equal(run.repository.full_name, out.REPOSITORY);
  assert.equal(run.event, "workflow_dispatch"); assert.equal(out.workflow(run.path), original.WORKFLOW);
  assert.equal(run.head_branch, "main"); assert.equal(run.head_sha, RECOVERY_CONTROLLER);
  assert.equal(run.display_title, `Replace Bodhi v${original.FIXED.version} lost output from ${original.LOST_RUN}`);
  assert.equal(run.status, "completed"); assert.equal(run.conclusion, "failure");
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  const runs = out.pages("actions/workflows/replace-v20261031.yml/runs?event=workflow_dispatch", "workflow_runs", request);
  assert.equal(runs.length, 1); assert.equal(runs[0].id, run.id);
  const jobs = out.pages(`actions/runs/${run.id}/jobs?filter=all`, "jobs", request);
  const names = ["Authenticate original pre-build failure", ...out.NATIVE_TARGETS.map(target => `Build recovered (${target})`)];
  assert.equal(new Set(jobs.map(job => job.id)).size, jobs.length);
  for (const job of jobs) {
    assert.ok(names.includes(job.name), "Foreign recovery job");
    assert.equal(job.run_id, run.id); assert.equal(job.head_sha, run.head_sha);
    assert.ok(Number.isSafeInteger(job.run_attempt) && job.run_attempt <= run.run_attempt);
  }
  const preflight = jobs.filter(job => job.name === names[0]);
  assert.ok(preflight.length); const latest = preflight.filter(job => job.run_attempt === Math.max(...preflight.map(item => item.run_attempt)));
  assert.equal(latest.length, 1); out.passed(latest[0], ["Verify original reservation, source and pre-compile failures"]);
  return { run, jobs, artifacts: out.pages(`actions/runs/${run.id}/artifacts`, "artifacts", request) };
}
function verifyReceipt(receipt, reservation, target, job, run) {
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, "bodhi-v31-recovered-target");
  assert.equal(receipt.source, original.FIXED.source); assert.equal(receipt.version, original.FIXED.version);
  assert.equal(receipt.originalRunId, original.FIXED.runId);
  assert.equal(receipt.reservationSha256, out.sha256(out.bytes(reservation)));
  assert.deepEqual(receipt.recovery, { runId: run.id, attempt: job.run_attempt, controller: run.head_sha, jobId: job.id });
  assert.equal(receipt.target, target); assert.deepEqual(receipt.checks, out.checks(target));
  assert.deepEqual(receipt.files.map(file => file.name).sort(), out.names(original.FIXED.version, target).sort());
  for (const file of receipt.files) {
    assert.match(file.sha256 || "", /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 1024 ** 2 && file.size <= 4 * 1024 ** 3);
  }
}
function recoveredTargets(proof, windowsProof, linuxProof, reservation, destination, restore = out.download) {
  const { run, jobs, artifacts } = proof;
  const ctx = { runId: run.id, attempt: run.run_attempt, controller: run.head_sha };
  return out.NATIVE_TARGETS.map(target => {
    if (target === windows.TARGET) return windows.select(windowsProof, reservation, path.join(destination, target), restore);
    if (target === linux.TARGET) return linux.select(linuxProof, reservation, path.join(destination, target), restore);
    const rows = jobs.filter(job => job.name === `Build recovered (${target})`);
    assert.ok(rows.length); const latest = rows.filter(job => job.run_attempt === Math.max(...rows.map(item => item.run_attempt)));
    assert.equal(latest.length, 1); out.passed(latest[0], ["Select existing recovered target"]);
    const executions = [];
    for (const job of rows.filter(item => item.steps.some(step => step.name === original.BUILD && step.conclusion === "success"))) {
      const physical = source.executionOrigin(job, rows);
      if (!executions.some(item => item.id === physical.id)) executions.push(physical);
    }
    assert.equal(executions.length, 1, "Require one physical successful target build");
    const job = executions[0];
    out.passed(job, ["Select existing recovered target", "Verify frozen source and stamp version", "Stage the exact prebuilt Lotus package",
      "Verify source boundaries", original.BUILD, original.CAPTURE, original.RETAIN]);
    const name = original.artifactName(ctx, target, job.run_attempt);
    const candidates = artifacts.filter(item => item.name.startsWith(`bodhi-v31-recovered-${original.FIXED.runId}-${run.id}-`) && item.name.endsWith(`-${target}`));
    assert.equal(candidates.length, 1, "Conflicting recovery artifacts");
    const artifact = out.artifact(artifacts, name, ctx, job);
    const directory = path.join(destination, target);
    restore(artifact, ["target-receipt.json", ...out.names(original.FIXED.version, target)], directory);
    const receipt = out.readJson(path.join(directory, "target-receipt.json"));
    verifyReceipt(receipt, reservation, target, job, run);
    for (const file of receipt.files) {
      const installer = path.join(directory, file.name);
      assert.equal(fs.lstatSync(installer).size, file.size); assert.equal(out.hashFile(installer), file.sha256);
    }
    return { receipt, artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest },
      logical: { id: latest[0].id, attempt: latest[0].run_attempt }, directory };
  });
}
function finalizerContext(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, out.REPOSITORY); assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main"); assert.equal(env.GITHUB_REF_PROTECTED, "true");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${out.REPOSITORY}/${WORKFLOW}@refs/heads/main`);
  assert.match(env.GITHUB_WORKFLOW_SHA || "", out.SHA); assert.equal(env.GITHUB_SHA, env.GITHUB_WORKFLOW_SHA);
  const root = path.resolve(__dirname, "..");
  const git = (...args) => execFileSync("git", args, { cwd: root, env: out.childEnv(), encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), env.GITHUB_WORKFLOW_SHA);
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
  const runId = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT);
  assert.ok(Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0);
  return { runId, attempt, controller: env.GITHUB_WORKFLOW_SHA };
}
function verifyManifest(manifest, release, reservation) {
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, "bodhi-lost-output-replacement/v1");
  assert.equal(manifest.releaseId, original.FIXED.releaseId); assert.deepEqual(manifest.reservation, reservation);
  assert.deepEqual(manifest.original, { runId: original.FIXED.runId, attempt: 1, controller: original.FIXED.controller,
    artifactId: original.FIXED.artifactId, artifactDigest: original.FIXED.artifactDigest });
  assert.deepEqual(manifest.lost, { runId: original.LOST_RUN, attempt: 1, controller: original.LOST_CONTROLLER,
    macJobId: original.LOST_JOBS["aarch64-apple-darwin"] });
  assert.equal(manifest.recovery.runId, RECOVERY_RUN); assert.equal(manifest.recovery.controller, RECOVERY_CONTROLLER);
  assert.ok(Number.isSafeInteger(manifest.recovery.attempt) && manifest.recovery.attempt > 0);
  assert.ok(Number.isSafeInteger(manifest.publisher.runId) && manifest.publisher.runId > 0);
  assert.ok(Number.isSafeInteger(manifest.publisher.attempt) && manifest.publisher.attempt > 0);
  assert.ok(Number.isSafeInteger(manifest.publisher.jobId) && manifest.publisher.jobId > 0);
  assert.match(manifest.publisher.controller || "", out.SHA);
  assert.deepEqual(manifest.targets.map(item => item.receipt.target).sort(), [...out.NATIVE_TARGETS].sort());
  assert.equal(new Set(manifest.targets.map(item => item.artifact.id)).size, 3);
  assert.equal(new Set(manifest.targets.map(item => [windows.TARGET, linux.TARGET].includes(item.receipt.target) ? item.receipt.builder.jobId : item.receipt.recovery.jobId)).size, 3);
  assert.equal(new Set(manifest.targets.map(item => item.logical.id)).size, 3);
  assert.equal(new Set(manifest.assets.map(item => item.id)).size, 6);
  const names = [];
  for (const item of manifest.targets) {
    if (item.receipt.target === windows.TARGET) {
      windows.verifyReceipt(item.receipt, reservation, { physical: { id: windows.JOB, run_attempt: 1 } });
      assert.equal(item.artifact.name, `bodhi-v31-verified-windows-${windows.RUN}-1`);
      assert.equal(item.artifact.id, windows.ARTIFACT); assert.equal(item.artifact.digest, windows.DIGEST);
      assert.deepEqual(item.logical, { id: windows.JOB, attempt: 1 });
    } else if (item.receipt.target === linux.TARGET) {
      linux.verifyReceipt(item.receipt, reservation, { physical: { id: linux.JOB, run_attempt: 1 } });
      assert.equal(item.artifact.name, `bodhi-v31-verified-linux-${linux.RUN}-1`);
      assert.equal(item.artifact.id, linux.ARTIFACT); assert.equal(item.artifact.digest, linux.DIGEST);
      assert.deepEqual(item.logical, { id: linux.JOB, attempt: 1 });
    } else {
      const job = { id: item.receipt.recovery.jobId, run_attempt: item.receipt.recovery.attempt };
      verifyReceipt(item.receipt, reservation, item.receipt.target, job, { id: RECOVERY_RUN, head_sha: RECOVERY_CONTROLLER });
      assert.equal(item.artifact.name, original.artifactName({ runId: RECOVERY_RUN }, item.receipt.target, job.run_attempt));
      assert.ok(job.run_attempt <= item.logical.attempt && item.logical.attempt <= manifest.recovery.attempt);
      assert.equal(job.id === item.logical.id, job.run_attempt === item.logical.attempt);
    }
    assert.ok(Number.isSafeInteger(item.artifact.id) && item.artifact.id > 0); assert.match(item.artifact.digest, out.DIGEST);
    assert.ok(Number.isSafeInteger(item.logical.id) && item.logical.id > 0 && Number.isSafeInteger(item.logical.attempt));
    for (const file of item.receipt.files) {
      names.push(file.name); const asset = manifest.assets.filter(entry => entry.name === file.name);
      assert.equal(asset.length, 1); assert.equal(asset[0].size, file.size); assert.equal(asset[0].digest, `sha256:${file.sha256}`);
    }
  }
  assert.equal(new Set(names).size, 6); assert.equal(manifest.assets.length, 6);
  assert.deepEqual(manifest.assets, sortedAssets({ assets: release.assets.filter(asset => asset.name !== MANIFEST) }));
  for (const asset of release.assets) finalizer.validateAsset(asset, original.originalContext());
  return manifest;
}
function assemble(ctx, output) {
  const retained = originalProof(), proof = recoveryRun(), windowsProof = windows.evidence(), linuxProof = linux.evidence();
  assert.equal(retained.release.draft, true);
  const allowed = [...out.NATIVE_TARGETS.flatMap(target => out.names(original.FIXED.version, target)), MANIFEST];
  assert.ok(retained.release.assets.every(asset => allowed.includes(asset.name)), "Foreign release asset");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v31-recovered-"));
  const targets = recoveredTargets(proof, windowsProof, linuxProof, retained.reservation, temporary);
  const assets = [];
  for (const target of targets) for (const file of target.receipt.files) {
    assets.push(finalizer.retainAsset(retained.release.id, path.join(target.directory, file.name), file.name, original.originalContext()));
  }
  assets.sort((a, b) => a.name.localeCompare(b.name));
  let release = out.api(`releases/${retained.release.id}`);
  const existing = release.assets.filter(asset => asset.name === MANIFEST); assert.ok(existing.length <= 1);
  let manifest;
  if (existing.length) {
    manifest = finalizer.readManifest(existing[0].id); verifyManifest(manifest, release, retained.reservation);
    assert.deepEqual(manifest.assets, assets);
    assert.deepEqual(manifest.targets, targets.map(({ receipt, artifact, logical }) => ({ receipt, artifact, logical })));
  } else {
    const job = out.currentJob(ctx, JOB);
    manifest = { schemaVersion: 1, kind: "bodhi-lost-output-replacement/v1", releaseId: retained.release.id,
      reservation: retained.reservation,
      original: { runId: original.FIXED.runId, attempt: 1, controller: original.FIXED.controller,
        artifactId: original.FIXED.artifactId, artifactDigest: original.FIXED.artifactDigest },
      lost: { runId: original.LOST_RUN, attempt: 1, controller: original.LOST_CONTROLLER,
        macJobId: original.LOST_JOBS["aarch64-apple-darwin"] },
      recovery: { runId: proof.run.id, attempt: proof.run.run_attempt, controller: proof.run.head_sha },
      publisher: { runId: ctx.runId, attempt: ctx.attempt, controller: ctx.controller, jobId: job.id },
      targets: targets.map(({ receipt, artifact, logical }) => ({ receipt, artifact, logical })), assets };
  }
  const file = path.join(path.dirname(output), MANIFEST); out.write(file, manifest);
  const manifestAsset = finalizer.retainAsset(retained.release.id, file, MANIFEST, original.originalContext());
  release = out.api(`releases/${retained.release.id}`); verifyManifest(manifest, release, retained.reservation);
  assert.equal(release.assets.length, 7); assert.equal(new Set(release.assets.map(asset => asset.id)).size, 7);
  assert.equal(manifestAsset.digest, `sha256:${out.sha256(out.bytes(manifest))}`);
  out.write(output, { schemaVersion: 1, manifest, manifestAsset, assets: sortedAssets(release), finalizer: ctx });
}
function publish(ctx, file) {
  const evidence = out.readJson(file), job = out.currentJob(ctx, JOB);
  out.gate(job, ASSEMBLE); out.gate(job, EVIDENCE);
  const name = `bodhi-v31-publication-${ctx.runId}-${ctx.attempt}`;
  const artifact = out.artifact(out.pages(`actions/runs/${ctx.runId}/artifacts`, "artifacts"), name, ctx, job, true);
  const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v31-evidence-")), "original");
  out.download(artifact, ["bodhi-v31-evidence.json"], directory);
  assert.deepEqual(out.readJson(path.join(directory, "bodhi-v31-evidence.json")), evidence);
  const originalCtx = original.originalContext(), retained = out.loadReservation(originalCtx), proof = recoveryRun();
  assert.equal(retained.release.id, original.FIXED.releaseId);
  assert.deepEqual(evidence.finalizer, ctx); verifyManifest(evidence.manifest, retained.release, retained.reservation);
  assert.equal(evidence.manifest.recovery.attempt, proof.run.run_attempt);
  const windowsProof = windows.evidence();
  const savedWindows = evidence.manifest.targets.find(target => target.receipt.target === windows.TARGET);
  assert.ok(savedWindows); windows.verifyReceipt(savedWindows.receipt, retained.reservation, windowsProof);
  assert.deepEqual(savedWindows.artifact, { id: windowsProof.artifact.id, name: windowsProof.artifact.name, digest: windowsProof.artifact.digest });
  const linuxProof = linux.evidence();
  const savedLinux = evidence.manifest.targets.find(target => target.receipt.target === linux.TARGET);
  assert.ok(savedLinux); linux.verifyReceipt(savedLinux.receipt, retained.reservation, linuxProof);
  assert.deepEqual(savedLinux.artifact, { id: linuxProof.artifact.id, name: linuxProof.artifact.name, digest: linuxProof.artifact.digest });
  assert.deepEqual(evidence.assets, sortedAssets(retained.release));
  const matches = retained.release.assets.filter(asset => asset.name === MANIFEST); assert.equal(matches.length, 1);
  assert.deepEqual(identity(matches[0]), evidence.manifestAsset);
  assert.equal(matches[0].digest, `sha256:${out.sha256(out.bytes(evidence.manifest))}`);
  finalizer.available(originalCtx, out.api, retained.release, true);
  finalizer.refreshSource(originalCtx, retained.reservation);
  if (retained.release.draft) {
    let failure;
    try { out.api(`releases/${retained.release.id}`, "PATCH", { tag_name: originalCtx.finalTag,
      target_commitish: originalCtx.source, name: `App v${originalCtx.version}`, draft: false, prerelease: false, make_latest: "true" }); }
    catch (error) { failure = error; }
    const after = out.api(`releases/${retained.release.id}`);
    if (after.draft) throw failure || new Error("Publication did not complete; retain the original assets");
  }
  const release = out.api(`releases/${retained.release.id}`);
  assert.equal(release.draft, false); assert.equal(release.tag_name, originalCtx.finalTag);
  assert.equal(release.target_commitish, originalCtx.source); assert.deepEqual(evidence.assets, sortedAssets(release));
  assert.equal(out.api(`git/ref/tags/${originalCtx.finalTag}`)?.object?.sha, originalCtx.source);
  return release;
}
module.exports = { RECOVERY_RUN, RECOVERY_CONTROLLER, WORKFLOW, MANIFEST, JOB, ASSEMBLE, EVIDENCE, PUBLISH,
  originalProof, recoveryRun, verifyReceipt, recoveredTargets, finalizerContext, verifyManifest, assemble, publish };
if (require.main === module) {
  try { const ctx = finalizerContext(); const [command, file] = process.argv.slice(2);
    if (command === "assemble") assemble(ctx, file); else if (command === "publish") publish(ctx, file); else throw new Error("Unknown command");
  } catch (error) { console.error(`Bodhi v31 finalizer: ${error.message}`); process.exitCode = 1; }
}
