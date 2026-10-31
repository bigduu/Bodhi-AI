#!/usr/bin/env node
"use strict";

// Publication-only recovery: the original assembly and immutable assets remain authoritative.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const out = require("./release-output.cjs");
const original = require("./replace-v20261031.cjs");
const finalizer = require("./release-finalizer-v2.cjs");
const saved = require("./finalize-salvaged-v20261031.cjs");
const windows = require("./v31-windows-proof.cjs");
const linux = require("./v31-linux-proof.cjs");
const ASSEMBLER_RUN = 40796552747, ASSEMBLER_JOB = 123194313606;
const ASSEMBLER_CONTROLLER = "622ed9209113f479100f906e45463232515d7e1a";
const ASSEMBLER_ARTIFACT = 12863489475;
const ASSEMBLER_DIGEST = "sha256:5a214296107e1e8e4e76be877aacd2dce2896839b39a037386a41f93865f7a6f";
const WORKFLOW = ".github/workflows/publish-v31-preserved.yml";
const JOB = "Publish verified Bodhi release";
const identity = asset => ({ id: asset.id, name: asset.name, size: asset.size, digest: asset.digest, state: asset.state });
const sorted = release => release.assets.map(identity).sort((a,b) => a.name.localeCompare(b.name));
const log = id => execFileSync("gh", ["api", `repos/${out.REPOSITORY}/actions/jobs/${id}/logs`, "--allow-escape-sequences"],
  { env: out.childEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

function context(env = process.env) {
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
function inspect(request = out.api, readLog = log, restore = out.download) {
  const run = request(`actions/runs/${ASSEMBLER_RUN}`);
  assert.equal(run.id, ASSEMBLER_RUN); assert.equal(run.repository.full_name, out.REPOSITORY);
  assert.equal(run.event, "workflow_dispatch"); assert.equal(out.workflow(run.path), saved.WORKFLOW);
  assert.equal(run.head_branch, "main"); assert.equal(run.head_sha, ASSEMBLER_CONTROLLER);
  assert.equal(run.display_title, `Finalize Bodhi v2026.10.31 saved outputs ${saved.RECOVERY_RUN}`);
  assert.equal(run.run_attempt, 1); assert.equal(run.status, "completed"); assert.equal(run.conclusion, "failure");
  assert.equal(request(`contents/${saved.WORKFLOW}?ref=${ASSEMBLER_CONTROLLER}`).sha, "0fc7de135db1718c7fa5147a3a4512e2db191583");
  assert.equal(request(`contents/scripts/finalize-salvaged-v20261031.cjs?ref=${ASSEMBLER_CONTROLLER}`).sha, "07d3378bc2dc602752becd1650b1f64c366bb490");
  const jobs = out.pages(`actions/runs/${ASSEMBLER_RUN}/jobs?filter=all`, "jobs", request);
  assert.equal(jobs.length, 1); const job = jobs[0];
  assert.equal(job.id, ASSEMBLER_JOB); assert.equal(job.name, saved.JOB); assert.equal(job.run_id, ASSEMBLER_RUN);
  assert.equal(job.head_sha, ASSEMBLER_CONTROLLER); assert.equal(job.run_attempt, 1);
  assert.equal(job.status, "completed"); assert.equal(job.conclusion, "failure");
  out.gate(job, saved.ASSEMBLE); out.gate(job, saved.EVIDENCE);
  assert.deepEqual(job.steps.filter(step => step.conclusion === "failure").map(step => step.name), [saved.PUBLISH]);
  const failure = readLog(job.id).replace(/\x1b\[[0-9;]*m/g, "");
  const section = failure.slice(failure.indexOf("Bodhi v31 finalizer: Expected values to be strictly equal:"));
  assert.ok(section.includes("+ 'in_progress'") && section.includes("- 'completed'"), "Original failure differs from the stale job-state response");
  const ctx = { runId: run.id, attempt: run.run_attempt, controller: run.head_sha };
  const artifact = out.artifact(out.pages(`actions/runs/${run.id}/artifacts`, "artifacts", request),
    `bodhi-v31-publication-${run.id}-${run.run_attempt}`, ctx, job);
  assert.equal(artifact.id, ASSEMBLER_ARTIFACT); assert.equal(artifact.digest, ASSEMBLER_DIGEST);
  const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v31-publication-recovery-")), "original");
  try {
    restore(artifact, ["bodhi-v31-evidence.json"], directory);
    const evidence = out.readJson(path.join(directory, "bodhi-v31-evidence.json"));
    assert.equal(evidence.schemaVersion, 1); assert.deepEqual(evidence.finalizer, ctx);
    assert.deepEqual(evidence.manifest.publisher, { ...ctx, jobId: job.id });
    const retained = saved.originalProof(request, readLog, restore), build = saved.recoveryRun(request);
    const release = retained.release, reservation = retained.reservation;
    assert.equal(release.id, original.FIXED.releaseId); assert.equal(typeof release.draft, "boolean");
    assert.equal(evidence.manifest.recovery.attempt, build.run.run_attempt);
    saved.verifyManifest(evidence.manifest, release, reservation);
    const asset = release.assets.filter(item => item.name === saved.MANIFEST); assert.equal(asset.length, 1);
    assert.deepEqual(identity(asset[0]), evidence.manifestAsset); assert.deepEqual(sorted(release), evidence.assets);
    assert.equal(asset[0].size, out.bytes(evidence.manifest).length);
    assert.equal(asset[0].digest, `sha256:${out.sha256(out.bytes(evidence.manifest))}`);
    const manifest = finalizer.readManifest(asset[0].id); assert.deepEqual(manifest, evidence.manifest);
    for (const proofModule of [windows, linux]) {
      const proof = proofModule.evidence(request, readLog);
      const target = manifest.targets.find(item => item.receipt.target === proofModule.TARGET); assert.ok(target);
      proofModule.verifyReceipt(target.receipt, reservation, proof);
      assert.deepEqual(target.artifact, { id: proof.artifact.id, name: proof.artifact.name, digest: proof.artifact.digest });
      assert.deepEqual(target.logical, { id: proof.logical.id, attempt: proof.logical.run_attempt });
    }
    finalizer.available(original.originalContext(), request, release, true);
    finalizer.refreshSource(original.originalContext(), reservation, request);
    return { releaseId: release.id, reservation, manifest, assets: evidence.assets, assembler: ctx, assemblerJob: job.id };
  } finally { fs.rmSync(path.dirname(directory), { recursive: true, force: true }); }
}
function publish(ctx) {
  const checked = inspect();
  const job = out.currentJob(ctx, JOB); assert.equal(job.status, "in_progress");
  const originalCtx = original.originalContext();
  const before = out.api(`releases/${checked.releaseId}`);
  out.releaseReservation(before, originalCtx); saved.verifyManifest(checked.manifest, before, checked.reservation);
  assert.equal(before.draft, true); assert.deepEqual(sorted(before), checked.assets);
  finalizer.available(originalCtx, out.api, before, true);
  finalizer.refreshSource(originalCtx, checked.reservation);
  let failure;
  try { out.api(`releases/${checked.releaseId}`, "PATCH", { tag_name: originalCtx.finalTag,
    target_commitish: originalCtx.source, name: `App v${originalCtx.version}`, draft: false, prerelease: false, make_latest: "true" }); }
  catch (error) { failure = error; }
  const release = out.api(`releases/${checked.releaseId}`);
  if (release.draft) throw failure || new Error("Publication did not complete; retained assets are unchanged");
  assert.equal(release.tag_name, originalCtx.finalTag); assert.equal(release.target_commitish, originalCtx.source);
  assert.deepEqual(sorted(release), checked.assets); saved.verifyManifest(checked.manifest, release, checked.reservation);
  assert.equal(out.api(`git/ref/tags/${originalCtx.finalTag}`)?.object?.sha, originalCtx.source);
  return { releaseId: release.id, tag: release.tag_name, source: originalCtx.source, assembler: checked.assembler, recovery: ctx, jobId: job.id };
}
module.exports = { ASSEMBLER_RUN, ASSEMBLER_JOB, ASSEMBLER_CONTROLLER, ASSEMBLER_ARTIFACT, ASSEMBLER_DIGEST, WORKFLOW, JOB, context, inspect, publish };
if (require.main === module) {
  try { console.log(JSON.stringify(process.argv[2] === "inspect" ? inspect() : publish(context()))); }
  catch (error) { console.error(`Bodhi preserved publication: ${error.message}`); process.exitCode = 1; }
}
