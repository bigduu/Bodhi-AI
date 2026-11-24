#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const out = require("./release-output.cjs");
const finalizer = require("./release-finalizer-v2.cjs");
const source = require("./release-source.cjs");

const FIXED = Object.freeze({
  version: "2026.11.37",
  source: "84a0181d5875a6b91cd847e060e9255a56a378bf",
  controller: "b24ee6277a8910ad318b094874dfedaff034b2f1",
  runId: 45432961380,
  attempt: 1,
  releaseId: 457005976,
  target: "aarch64-pc-windows-msvc",
  buildJobId: 138583610124,
  emergencyId: 14941036030,
  emergencyDigest: "sha256:5547b5166f9476cef0f8c05a91f7ea3639060a8793e22f27e25cffff09f65d8f",
  installerSize: 3970701,
  installerSha256: "9eb883a4b93efce1ce032d79ec68bb93a0775f6469e9e672d769538218af0aec",
  priorReleaseId: 456353247,
});
const WORKFLOW = ".github/workflows/recover-release.yml";
const WORKFLOW_BLOB = "86225399ee6083f4bcb9ab6bcaa3fc0c22987368";
const JOB = "Recover original 2026.11.37 installers";
const ASSEMBLE = "Verify and assemble retained installers";
const EVIDENCE = "Retain verified recovery evidence";
const KIND = "bodhi-v37-winarm-capture/v1";
const emergencyName = `bodhi-v4-emergency-${FIXED.runId}-${FIXED.attempt}-${FIXED.target}`;
const evidenceName = (runId, attempt) => `bodhi-v37-winarm-recovery-${runId}-${attempt}`;
const identity = ({ id, name, digest }) => ({ id, name, digest });
const positive = value => Number.isSafeInteger(value) && value > 0;
const readLog = jobId => execFileSync("gh", ["api", `repos/${out.REPOSITORY}/actions/jobs/${jobId}/logs`, "--allow-escape-sequences"],
  { env: out.childEnv(), encoding: "utf8", maxBuffer: 16 * 1024 ** 2 });

function original(request = out.api, restore = out.download, log = readLog) {
  const { version, source, runId, attempt, controller } = FIXED;
  const ctx = out.originalContext({ repository: out.REPOSITORY, version, source, runId, attempt, finalTag: `app-v${version}` }, controller, request);
  const run = out.run(ctx, request, true);
  assert.equal(run.head_repository?.full_name, out.REPOSITORY);
  assert.equal(out.releaseContract(ctx).schemaVersion, 4);
  const reservation = out.loadReservation(ctx, request, restore);
  assert.equal(reservation.release.id, FIXED.releaseId, "Original draft identity differs");

  const jobs = out.jobs(ctx, request);
  const windows = jobs.filter(job => job.name === `Build original (${FIXED.target})`);
  assert.equal(windows.length, 1);
  const [windowsJob] = windows;
  assert.equal(windowsJob.id, FIXED.buildJobId);
  assert.equal(windowsJob.run_attempt, attempt);
  assert.equal(windowsJob.status, "completed");
  assert.equal(windowsJob.conclusion, "failure");
  for (const step of ["Verify source and stamp reserved version", out.BUILD, "Preserve successful build files if capture fails"]) out.gate(windowsJob, step);
  const failed = windowsJob.steps.filter(step => step.conclusion === "failure");
  assert.deepEqual(failed.map(step => [step.name, step.status]), [[out.CAPTURE, "completed"]]);
  const retained = windowsJob.steps.filter(step => step.name === out.RETAIN);
  assert.deepEqual(retained.map(step => [step.conclusion, step.status]), [["skipped", "completed"]]);
  const publisher = jobs.filter(job => job.name === "Publish original release");
  assert.deepEqual(publisher.map(job => [job.run_attempt, job.status, job.conclusion]), [[attempt, "completed", "skipped"]]);
  const failure = log(windowsJob.id);
  assert.match(failure, /VersionInfo\.ProductVersion/);
  assert.match(failure, /Internal CLR error\. \(0x80131506\)/);
  const originalArtifacts = out.pages(`actions/runs/${runId}/artifacts`, "artifacts", request);
  assert.ok(!originalArtifacts.some(artifact => artifact.name === out.artifactName(ctx, FIXED.target, attempt)),
    "There is already a canonical Windows ARM64 capture");
  const emergency = out.artifact(originalArtifacts, emergencyName, ctx, windowsJob);
  assert.deepEqual(identity(emergency), { id: FIXED.emergencyId, name: emergencyName, digest: FIXED.emergencyDigest });
  return { ctx, ...reservation, windowsJob, emergency };
}

function verifyCaptureManifest(ctx, manifest) {
  for (const key of ["version", "source", "runId", "controller"]) assert.equal(ctx[key], FIXED[key]);
  assert.equal(manifest.releaseId, FIXED.releaseId);
  assert.equal(manifest.reservation.preflight.attempt, FIXED.attempt);
  const actor = manifest.captureRecovery;
  assert.deepEqual(Object.keys(actor).sort(), ["admission", "attempt", "controller", "jobId", "kind", "runId"]);
  assert.equal(actor.kind, KIND);
  assert.ok(positive(actor.runId) && actor.runId !== FIXED.runId && positive(actor.attempt) && positive(actor.jobId));
  assert.match(actor.controller, out.SHA);
  assert.deepEqual(Object.keys(actor.admission).sort(), ["attempt", "pullRequest", "runId", "tree"]);
  assert.ok([actor.admission.attempt, actor.admission.pullRequest, actor.admission.runId].every(positive));
  assert.match(actor.admission.tree, out.SHA);
  assert.deepEqual(manifest.finalizer, { jobId: actor.jobId, attempt: actor.attempt });
  const targets = manifest.targets.filter(target => target.receipt.target === FIXED.target);
  assert.equal(targets.length, 1);
  const [windows] = targets;
  assert.equal(windows.receipt.jobId, FIXED.buildJobId);
  assert.equal(windows.receipt.attempt, FIXED.attempt);
  assert.deepEqual(windows.artifact, { id: FIXED.emergencyId, name: emergencyName, digest: FIXED.emergencyDigest });
  const [name] = out.names(FIXED.version, FIXED.target);
  assert.deepEqual(windows.receipt.files, [{ name, size: FIXED.installerSize, sha256: FIXED.installerSha256 }],
    "Windows installer differs from the retained original");
  assert.ok(manifest.targets.every(target => target.receipt.attempt === FIXED.attempt), "Target is outside the original attempt");
  return FIXED.target;
}

function requireAncestor(ancestor, descendant, request) {
  if (descendant === ancestor) return;
  const history = request(`compare/${ancestor}...${descendant}`);
  assert.equal(history?.status, "ahead");
  assert.equal(history.behind_by, 0);
  assert.equal(history.merge_base_commit?.sha, ancestor, "Recovery controller is outside protected Dev history");
}
function recoveryRun({ runId, attempt }, request) {
  assert.ok(positive(runId) && runId !== FIXED.runId && positive(attempt));
  const run = request(`actions/runs/${runId}`);
  assert.equal(run?.id, runId);
  assert.equal(run.run_attempt, attempt);
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.head_branch, "dev");
  assert.equal(run.repository?.full_name, out.REPOSITORY);
  assert.equal(run.head_repository?.full_name, out.REPOSITORY);
  assert.equal(out.workflow(run.path), WORKFLOW);
  assert.equal(run.display_title, `Recover Bodhi v${FIXED.version} from ${FIXED.runId} attempt ${FIXED.attempt}`);
  assert.match(run.head_sha || "", out.SHA);
  assert.equal(request(`contents/${WORKFLOW}?ref=${run.head_sha}`)?.sha, WORKFLOW_BLOB, "Unreviewed recovery workflow");
  const dev = source.devHead(request("branches/dev"));
  assert.notEqual(run.head_sha, FIXED.source, "The frozen product is not a recovery controller");
  requireAncestor(FIXED.source, run.head_sha, request);
  requireAncestor(run.head_sha, dev, request);
  return run;
}
function jobFor(run, attempt, request) {
  const jobs = out.pages(`actions/runs/${run.id}/jobs?filter=all`, "jobs", request)
    .filter(job => job.run_attempt === attempt && job.name === JOB);
  assert.equal(jobs.length, 1, "Missing or ambiguous recovery job");
  const [job] = jobs;
  assert.ok(positive(job.id));
  assert.equal(job.run_id, run.id);
  assert.equal(job.head_sha, run.head_sha);
  return job;
}
function readEvidence(run, job, request) {
  const artifact = out.artifact(out.pages(`actions/runs/${run.id}/artifacts`, "artifacts", request),
    evidenceName(run.id, job.run_attempt), { runId: run.id, attempt: job.run_attempt, controller: run.head_sha }, job, true);
  assert.ok(artifact.size_in_bytes <= 1024 ** 2, "Recovery evidence archive is too large");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v37-recovery-proof-"));
  try {
    const directory = path.join(temporary, "original");
    out.download(artifact, ["evidence.json"], directory);
    const evidence = out.readJson(path.join(directory, "evidence.json"));
    return { artifact, evidence };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function actorOf(run, job) {
  return { kind: KIND, runId: run.id, attempt: job.run_attempt, controller: run.head_sha, jobId: job.id,
    admission: run.controllerAdmission };
}
function checkAssembly(run, evidence, request) {
  const actor = evidence.manifest.captureRecovery;
  assert.ok(actor && actor.attempt <= run.run_attempt);
  const assembly = jobFor(run, actor.attempt, request);
  const steps = assembly.steps.filter(step => step.name === ASSEMBLE);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, "completed");
  // An earlier assembly can retain the manifest before a readback fails.
  // A retry still verifies every original byte and must pass all its own gates.
  assert.ok(steps[0].conclusion === "success" || actor.attempt < run.run_attempt && steps[0].conclusion === "failure");
  assert.deepEqual(actor, actorOf(run, assembly));
  const uploaded = request(`releases/assets/${evidence.manifestAsset.id}`);
  const created = Date.parse(uploaded?.created_at);
  const end = assembly.status === "in_progress" ? Date.now() : Date.parse(assembly.completed_at);
  assert.ok(Number.isFinite(created) && created >= Date.parse(assembly.started_at) && created <= end,
    "Manifest was uploaded outside its recorded assembly job");
}
function controllerAdmission(controller, identity, request, verify = source.verifyAcceptedDev) {
  const proof = verify({ source: controller, pullRequest: identity.pullRequest,
    runId: identity.runId, attempt: identity.attempt }, request);
  assert.equal(proof.source, controller, "Dev receipt does not admit this recovery controller");
  const { pullRequest, runId, attempt, tree } = proof;
  return { pullRequest, runId, attempt, tree };
}
function requireController(request, env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, out.REPOSITORY);
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/dev");
  assert.equal(env.GITHUB_REF_PROTECTED, "true");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${out.REPOSITORY}/${WORKFLOW}@refs/heads/dev`);
  assert.match(env.GITHUB_WORKFLOW_SHA || "", out.SHA);
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA);
  assert.equal(env.EXPECTED_CONTROLLER_SHA, env.GITHUB_WORKFLOW_SHA);
  const git = (...args) => execFileSync("git", args, { cwd: out.ROOT, env: out.childEnv(), encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), env.GITHUB_WORKFLOW_SHA);
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
  const run = recoveryRun({ runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT) }, request);
  assert.equal(run.head_sha, env.GITHUB_WORKFLOW_SHA);
  assert.equal(run.status, "in_progress");
  assert.equal(run.conclusion, null);
  const dev = source.devHead(request("branches/dev"));
  requireAncestor(run.head_sha, dev, request);
  run.controllerAdmission = controllerAdmission(run.head_sha, {
    pullRequest: env.CONTROLLER_PR, runId: env.CONTROLLER_CI_RUN, attempt: env.CONTROLLER_CI_ATTEMPT,
  }, request);
  requireAncestor(dev, source.devHead(request("branches/dev")), request);
  return run;
}
function downloadEmergency(artifact, destination) {
  const descriptor = fs.openSync(destination, "wx");
  try {
    execFileSync("gh", ["api", `repos/${out.REPOSITORY}/actions/artifacts/${artifact.id}/zip`],
      { env: out.childEnv(), stdio: ["ignore", descriptor, "pipe"], timeout: 5 * 60 * 1000 });
  } finally { fs.closeSync(descriptor); }
  assert.equal(`sha256:${out.hashFile(destination)}`, artifact.digest);
}
function assemble(originalRelease, run, output, request) {
  const { ctx, reservation, emergency, windowsJob, release } = originalRelease;
  const job = jobFor(run, run.run_attempt, request);
  assert.equal(job.status, "in_progress");
  finalizer.available(ctx, request, release, true);
  finalizer.refreshSource(ctx, reservation, request);

  const root = path.dirname(output);
  fs.mkdirSync(root, { recursive: true });
  const zip = path.join(root, "emergency.zip");
  downloadEmergency(emergency, zip);
  const { captureWindows } = require("./v37-winarm-original.cjs");
  const windows = captureWindows({ zip, directory: path.join(root, "windows"), ctx, reservation, job: windowsJob, digest: emergency.digest, request });
  const targets = out.releaseContract(ctx).targets.map(target => {
    if (target === FIXED.target) return { ...windows, artifact: identity(emergency) };
    const selected = out.selectTarget(ctx, reservation, target, request, out.download, true);
    assert.ok(selected, `Missing original target: ${target}`);
    return selected;
  });

  let actor = actorOf(run, job);
  const existing = release.assets.filter(asset => asset.name === out.releaseContract(ctx).manifest);
  assert.ok(existing.length <= 1, "Ambiguous original manifest");
  if (existing.length === 1) {
    const manifest = finalizer.readManifest(existing[0].id);
    verifyCaptureManifest(ctx, manifest);
    checkAssembly(run, { manifest, manifestAsset: existing[0] }, request);
    actor = manifest.captureRecovery;
  }
  return finalizer.retainAssembly({ ...ctx, attempt: run.run_attempt }, output, originalRelease, targets,
    request, undefined, undefined, actor);
}
function requireExpectedLatest(request) {
  const release = request("releases/latest");
  assert.ok(release?.draft === false && release.prerelease === false &&
    ((release.id === FIXED.priorReleaseId && release.tag_name === "app-v2026.11.36") ||
      (release.id === FIXED.releaseId && release.tag_name === `app-v${FIXED.version}`)),
  "The latest stable Bodhi release changed before v37 recovery");
}
function publish(originalRelease, run, file, request) {
  const evidence = out.readJson(file);
  let job;
  for (let retry = 0; ; retry++) {
    job = jobFor(run, run.run_attempt, request);
    out.gate(job, ASSEMBLE);
    const steps = job.steps.filter(step => step.name === EVIDENCE);
    assert.equal(steps.length, 1);
    if (steps[0].status === "completed") { out.gate(job, EVIDENCE); break; }
    assert.equal(steps[0].status, "in_progress");
    assert.equal(steps[0].conclusion, null);
    assert.ok(retry < 4, "Recovery upload gate did not become visible");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 * 2 ** retry);
  }
  const retained = readEvidence(run, job, request);
  assert.deepEqual(retained.evidence, evidence);
  checkAssembly(run, evidence, request);
  return finalizer.publish({ ...originalRelease.ctx, attempt: run.run_attempt }, evidence, (endpoint, method, body) => {
    if (method === "PATCH") {
      assert.equal(endpoint, `releases/${FIXED.releaseId}`);
      requireAncestor(run.head_sha, source.devHead(request("branches/dev")), request);
      requireExpectedLatest(request);
    }
    return request(endpoint, method, body);
  });
}
function main() {
  const [command, file] = process.argv.slice(2);
  assert.ok(["assemble", "publish"].includes(command) && path.isAbsolute(file));
  const run = requireController(out.api);
  const retained = original();
  if (command === "assemble") assemble(retained, run, file, out.api);
  else publish(retained, run, file, out.api);
}
module.exports = { FIXED, WORKFLOW, WORKFLOW_BLOB, JOB, ASSEMBLE, EVIDENCE, evidenceName, original, recoveryRun,
  controllerAdmission, requireExpectedLatest, verifyCaptureManifest };
if (require.main === module) {
  try { main(); } catch (error) { console.error(`Bodhi 2026.11.37 recovery: ${error.message}`); process.exitCode = 1; }
}
