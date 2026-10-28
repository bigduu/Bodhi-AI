#!/usr/bin/env node
"use strict";

// One bounded recovery: the original v31 jobs stopped at the Tauri CLI version
// check, before its build hook or a compiler ran. Preserve that reservation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const out = require("./release-output.cjs");
const source = require("./release-source.cjs");
const finalizer = require("./release-finalizer-v2.cjs");

const FIXED = Object.freeze({
  version: "2026.10.31", source: "ebd73744e75ea20ecd068a730213eeeb3f26e52b",
  controller: "c5237878fbae13b5eddf121c2d96b940eb00e4f3", runId: 40714739339,
  releaseId: 426837551, artifactId: 12828435129,
  artifactDigest: "sha256:e4547cb7caa7087f0e87895b37a4ea652b9cdb4aa48ab29cd29f2808890cbd25",
  jobs: { "x86_64-unknown-linux-gnu": 122909585360, "aarch64-apple-darwin": 122909585376,
    "x86_64-pc-windows-msvc": 122909585486 },
});
const WORKFLOW = ".github/workflows/recover-v20261031.yml";
const BUILD = "Build recovered Tauri installers";
const CAPTURE = "Verify and capture recovered output";
const RETAIN = "Retain recovered target output";

function originalContext() {
  return out.context({ GITHUB_REPOSITORY: out.REPOSITORY, RELEASE_VERSION: FIXED.version,
    EXPECTED_SOURCE_SHA: FIXED.source, ORIGINAL_RELEASE_RUN_ID: String(FIXED.runId),
    ORIGINAL_RELEASE_ATTEMPT: "1", GITHUB_WORKFLOW_SHA: FIXED.controller });
}
function jobLog(id) {
  return execFileSync("gh", ["api", `repos/${out.REPOSITORY}/actions/jobs/${id}/logs`, "--allow-escape-sequences"],
    { env: out.childEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}
function assertOriginalFailure(job, target, log) {
  assert.equal(job.id, FIXED.jobs[target]); assert.equal(job.name, `Build original (${target})`);
  assert.equal(job.status, "completed"); assert.equal(job.conclusion, "failure");
  const step = name => { const rows = job.steps.filter(item => item.name === name); assert.equal(rows.length, 1); return rows[0]; };
  assert.equal(step(out.BUILD).conclusion, "failure");
  assert.equal(step(out.CAPTURE).conclusion, "skipped"); assert.equal(step(out.RETAIN).conclusion, "skipped");
  const plain = log.replace(/\x1b\[[0-9;]*m/g, "");
  const start = plain.indexOf("##[group]Run npm run tauri:build");
  const end = plain.indexOf("##[error]Process completed with exit code 1.", start);
  assert.ok(start >= 0 && end > start, "Missing original failing build log");
  const build = plain.slice(start, end);
  assert.match(build, /Found version mismatched Tauri packages/);
  for (const name of ["@tauri-apps/api", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-fs"]) assert.ok(build.includes(name));
  assert.doesNotMatch(build, /beforeBuildCommand|\bCompiling\b|cargo (?:build|rustc)/i,
    "An original product compile or hook may have started");
}
function assertOriginal(request = out.api, readLog = jobLog, restore = out.download) {
  const ctx = originalContext(); out.run(ctx, request, true);
  const jobs = out.jobs(ctx, request);
  for (const target of out.NATIVE_TARGETS) {
    const rows = jobs.filter(job => job.name === `Build original (${target})`);
    assert.equal(rows.length, 1); assertOriginalFailure(rows[0], target, readLog(rows[0].id));
  }
  const artifacts = out.pages(`actions/runs/${ctx.runId}/artifacts`, "artifacts", request);
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0].id, FIXED.artifactId);
  assert.equal(artifacts[0].digest, FIXED.artifactDigest);
  const retained = out.loadReservation(ctx, request, restore);
  assert.equal(retained.release.id, FIXED.releaseId); assert.equal(retained.release.draft, true);
  assert.deepEqual(retained.release.assets, []);
  finalizer.available(ctx, request, retained.release, true);
  finalizer.refreshSource(ctx, retained.reservation, request);
  return retained;
}
function recoveryContext(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, out.REPOSITORY); assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${out.REPOSITORY}/${WORKFLOW}@refs/heads/main`);
  assert.match(env.GITHUB_WORKFLOW_SHA || "", out.SHA); assert.equal(env.GITHUB_SHA, env.GITHUB_WORKFLOW_SHA);
  const runId = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT);
  assert.ok(Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0);
  const controller = execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname + "/..", encoding: "utf8" }).trim();
  assert.equal(controller, env.GITHUB_WORKFLOW_SHA);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"],
    { cwd: __dirname + "/..", encoding: "utf8" }).trim(), "", "Controller checkout is not clean");
  return { runId, attempt, controller };
}
function artifactName(recovery, target, attempt = recovery.attempt) {
  return `bodhi-v31-recovered-${FIXED.runId}-${recovery.runId}-${attempt}-${target}`;
}
function requireUniqueRun(recovery, request = out.api) {
  const runs = out.pages(`actions/workflows/recover-v20261031.yml/runs?event=workflow_dispatch`, "workflow_runs", request);
  assert.ok(runs.every(run => run.id === recovery.runId), "Use the original recovery run; do not start another build");
  assert.equal(runs.length, 1, "Recovery run is missing or ambiguous");
  const run = runs[0];
  assert.equal(run.repository.full_name, out.REPOSITORY);
  assert.equal(run.event, "workflow_dispatch"); assert.equal(out.workflow(run.path), WORKFLOW);
  assert.equal(run.head_branch, "main"); assert.equal(run.head_sha, recovery.controller);
  assert.equal(run.run_attempt, recovery.attempt); assert.equal(run.status, "in_progress");
  assert.equal(run.display_title, `Recover Bodhi v${FIXED.version} original ${FIXED.runId}`);
}
function plan(recovery, target, request = out.api) {
  assert.ok(out.NATIVE_TARGETS.includes(target));
  requireUniqueRun(recovery, request);
  const all = out.pages(`actions/runs/${recovery.runId}/jobs?filter=all`, "jobs", request);
  const rows = all.filter(job => job.name === `Build recovered (${target})`);
  const current = rows.filter(job => job.run_attempt === recovery.attempt && job.status === "in_progress");
  assert.equal(current.length, 1, "Current recovery job is missing");
  assert.equal(current[0].head_sha, recovery.controller);
  const previous = rows.filter(job => job.run_attempt < recovery.attempt && job.status === "completed");
  const builds = previous.filter(job => job.steps.some(step => step.name === BUILD && step.conclusion === "success"));
  assert.ok(builds.length <= 1, "Multiple physical builds are ambiguous");
  if (builds.length) {
    const job = builds[0]; out.passed(job, [BUILD, CAPTURE, RETAIN]);
    const artifacts = out.pages(`actions/runs/${recovery.runId}/artifacts`, "artifacts", request);
    const value = out.artifact(artifacts, artifactName(recovery, target, job.run_attempt), recovery, job);
    return { reuse: true, artifactId: value.id, artifactName: value.name };
  }
  for (const job of previous) assert.ok(!job.steps.some(step => step.name === BUILD && step.conclusion === "failure"),
    "A prior recovered build failed; classify it before any retry");
  return { reuse: false, artifactName: artifactName(recovery, target) };
}
function prepare(product, reservation) {
  const verified = source.requireProduct(FIXED.source, product);
  assert.deepEqual(verified.lockHashes, reservation.lockHashes);
  out.stamp(product, FIXED.version);
}
function capture(product, target, output, recovery, reservation) {
  const git = (...args) => execFileSync("git", args, { cwd: product, env: out.childEnv(), encoding: "utf8" }).trimEnd();
  assert.equal(git("rev-parse", "HEAD"), FIXED.source);
  const changed = git("status", "--porcelain", "--untracked-files=all").split(/\r?\n/).filter(Boolean).map(line => line.slice(3)).sort();
  assert.deepEqual(changed, ["Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
  const files = ["src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "Cargo.lock"];
  const originals = files.map(file => execFileSync("git", ["show", `${FIXED.source}:${file}`], { cwd: product, env: out.childEnv(), encoding: "utf8" }));
  for (const [file, expected] of Object.entries(out.stamped(...originals, FIXED.version)))
    assert.ok(fs.readFileSync(path.join(product, file)).equals(Buffer.from(expected)), `Unexpected publishing edit: ${file}`);
  for (const [file, hash] of Object.entries(reservation.lockHashes)) assert.equal(out.sha256(fs.readFileSync(path.join(product, file))), hash);
  assert.ok(path.isAbsolute(output) && !fs.existsSync(output)); fs.mkdirSync(output, { recursive: true });
  out.staticOutputs(product, originalContext(), target, output);
  const job = out.currentJob(recovery, `Build recovered (${target})`); out.gate(job, BUILD);
  const receipt = { schemaVersion: 1, kind: "bodhi-v31-recovered-target", source: FIXED.source, version: FIXED.version,
    originalRunId: FIXED.runId, reservationSha256: out.sha256(out.bytes(reservation)),
    recovery: { runId: recovery.runId, attempt: recovery.attempt, controller: recovery.controller, jobId: job.id },
    target, checks: out.checks(target),
    files: out.names(FIXED.version, target).map(name => ({ name, size: fs.lstatSync(path.join(output, name)).size,
      sha256: out.hashFile(path.join(output, name)) })) };
  out.write(path.join(output, "target-receipt.json"), receipt);
}
function main() {
  const [command, target] = process.argv.slice(2), recovery = recoveryContext();
  if (command === "preflight") {
    requireUniqueRun(recovery); const retained = assertOriginal();
    const fresh = source.verifyAcceptedDev({ source: FIXED.source, pullRequest: 148, runId: 40704922855, attempt: 1 });
    const stable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !["observedDev", "currentDev"].includes(key)));
    assert.deepEqual(stable(fresh), stable(retained.reservation.admission));
    console.log(`Authenticated original release ${FIXED.releaseId}, source ${FIXED.source}, and pre-compile failures`);
    return;
  }
  const retained = out.loadBuildReservation(originalContext());
  assert.equal(retained.releaseId, FIXED.releaseId); assert.equal(retained.artifact.id, FIXED.artifactId);
  if (command === "plan") { const value = plan(recovery, target); out.outputs({ reuse: value.reuse, artifact_name: value.artifactName }); return; }
  if (command === "prepare") return prepare(process.env.SOURCE_ROOT, retained.reservation);
  if (command === "capture") return capture(process.env.SOURCE_ROOT, target, process.env.TARGET_OUTPUT, recovery, retained.reservation);
  throw new Error("Unknown recovery command");
}
module.exports = { FIXED, WORKFLOW, BUILD, CAPTURE, RETAIN, originalContext, assertOriginalFailure, assertOriginal,
  recoveryContext, artifactName, requireUniqueRun, plan, prepare, capture };
if (require.main === module) { try { main(); } catch (error) { console.error(`Bodhi v31 recovery: ${error.message}`); process.exitCode = 1; } }
