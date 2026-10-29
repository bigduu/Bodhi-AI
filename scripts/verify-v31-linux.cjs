#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const out = require("./release-output.cjs");
const source = require("./release-source.cjs");
const replacement = require("./replace-v20261031.cjs");
const TARGET = "x86_64-unknown-linux-gnu";
const BUILD_RUN = 40791597216, BUILD_JOB = 123178097609;
const BUILD_CONTROLLER = "977d4dfeb715f8ce688173d067ab5a9361520d0d";
const EMERGENCY_ID = 12863378013;
const EMERGENCY_DIGEST = "sha256:3c79fef6fdf54e59c766085ffadc142f689658769e0e0416a9f465d22d76c48e";
const DIAG_RUN = 40795468001, DIAG_JOB = 123190773540;
const DIAG_CONTROLLER = "97dd09fc796370470adf6d6ec0fe60e3f6a6036a";
const DIAG_YARN_BLOB = "db480002b7e1918c3a8ad6860ff02d881df10714";
const WORKFLOW = ".github/workflows/verify-v31-linux.yml";
const BRANCH = "bodhi/recover/v31-linux-output-20261029";
const JOB = "Verify saved Linux output";
const VERIFY = "Verify original Linux installers and staging";
const RETAIN = "Retain verified Linux output";
const log = id => execFileSync("gh", ["api", `repos/${out.REPOSITORY}/actions/jobs/${id}/logs`, "--allow-escape-sequences"],
  { env: out.childEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

function context(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, out.REPOSITORY); assert.equal(env.GITHUB_EVENT_NAME, "push");
  assert.equal(env.GITHUB_REF, `refs/heads/${BRANCH}`);
  assert.equal(env.GITHUB_WORKFLOW_REF, `${out.REPOSITORY}/${WORKFLOW}@refs/heads/${BRANCH}`);
  assert.match(env.GITHUB_WORKFLOW_SHA || "", out.SHA); assert.equal(env.GITHUB_SHA, env.GITHUB_WORKFLOW_SHA);
  const root = path.resolve(__dirname, "..");
  const git = (...args) => execFileSync("git", args, { cwd: root, env: out.childEnv(), encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), env.GITHUB_WORKFLOW_SHA);
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
  const runId = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT);
  assert.ok(Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0);
  return { runId, attempt, controller: env.GITHUB_WORKFLOW_SHA };
}
function evidence(request = out.api, readLog = log) {
  const run = request(`actions/runs/${BUILD_RUN}`);
  assert.equal(run?.id, BUILD_RUN); assert.equal(run.repository.full_name, out.REPOSITORY);
  assert.equal(run.head_sha, BUILD_CONTROLLER); assert.equal(run.run_attempt, 1); assert.equal(run.event, "workflow_dispatch");
  assert.equal(out.workflow(run.path), replacement.WORKFLOW); assert.equal(run.head_branch, "main");
  const rows = out.pages(`actions/runs/${BUILD_RUN}/jobs?filter=all`, "jobs", request).filter(job => job.id === BUILD_JOB);
  assert.equal(rows.length, 1); const job = rows[0];
  assert.equal(job.name, `Build recovered (${TARGET})`); assert.equal(job.run_id, BUILD_RUN);
  assert.equal(job.head_sha, BUILD_CONTROLLER); assert.equal(job.run_attempt, 1);
  assert.equal(job.status, "completed"); assert.equal(job.conclusion, "failure");
  out.gate(job, replacement.BUILD); out.gate(job, "Preserve successful build files if capture fails");
  const capture = job.steps.filter(step => step.name === replacement.CAPTURE);
  assert.equal(capture.length, 1); assert.equal(capture[0].conclusion, "failure");
  const retain = job.steps.filter(step => step.name === replacement.RETAIN);
  assert.equal(retain.length, 1); assert.equal(retain[0].conclusion, "skipped");
  const buildLog = readLog(BUILD_JOB).replace(/\x1b\[[0-9;]*m/g, "");
  const start = buildLog.indexOf("Bodhi v31 recovery: Expected values to be strictly deep-equal:");
  const end = buildLog.indexOf("##[error]Process completed with exit code 1.", start);
  assert.ok(start >= 0 && end > start, "Original capture failure is not the expected lock change");
  const names = [...buildLog.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(names, ["Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "yarn.lock"]);
  const artifactName = `bodhi-v31-emergency-${BUILD_RUN}-1-${TARGET}`;
  const artifact = out.artifact(out.pages(`actions/runs/${BUILD_RUN}/artifacts`, "artifacts", request), artifactName,
    { runId: BUILD_RUN, attempt: 1, controller: BUILD_CONTROLLER }, job);
  assert.equal(artifact.id, EMERGENCY_ID); assert.equal(artifact.digest, EMERGENCY_DIGEST);
  const diagnostic = request(`actions/runs/${DIAG_RUN}`);
  assert.equal(diagnostic?.id, DIAG_RUN); assert.equal(diagnostic.repository.full_name, out.REPOSITORY);
  assert.equal(diagnostic.head_sha, DIAG_CONTROLLER); assert.equal(diagnostic.run_attempt, 1);
  assert.equal(diagnostic.event, "push"); assert.equal(diagnostic.head_branch, "bodhi/debug/v31-linux-lock-20261029");
  assert.equal(out.workflow(diagnostic.path), ".github/workflows/diagnose-v31-linux-lock.yml");
  assert.equal(diagnostic.status, "completed"); assert.equal(diagnostic.conclusion, "success");
  const tests = out.pages(`actions/runs/${DIAG_RUN}/jobs?filter=all`, "jobs", request).filter(item => item.id === DIAG_JOB);
  assert.equal(tests.length, 1); const test = tests[0]; assert.equal(test.run_id, DIAG_RUN); assert.equal(test.head_sha, DIAG_CONTROLLER);
  out.passed(test, ["Stamp disposable source and show initial status", "Install locked shell CLI and inspect lock",
    "Stage exact immutable Lotus package and inspect lock", "Stop at the Tauri build hook and inspect lock"]);
  const diagLog = readLog(DIAG_JOB).replace(/\x1b\[[0-9;]*m/g, "");
  for (const value of ["node: v24.22.1", "npm: 11.19.1", "yarn: 1.22.22"]) {
    assert.ok(buildLog.includes(value) && diagLog.includes(value), `Diagnostic toolchain differs: ${value}`);
  }
  assert.ok(diagLog.includes("index 609bedd..db48000 100644"));
  assert.ok(diagLog.includes('+"@tauri-apps/cli-linux-x64-gnu@2.5.0":'));
  assert.ok(diagLog.includes('+"@tauri-apps/cli-linux-x64-musl@2.5.0":'));
  assert.ok(diagLog.includes("sha512-SG5sFNL7VMmDBdIg3nO3EzNRT306HsiEQ0N90ILe3ZABYAVoPDO/ttpCO37ApLInTzrq/DLN+gOlC/mgZvLw1w=="));
  assert.ok(diagLog.includes("sha512-QXDM8zp/6v05PNWju5ELsVwF0VH1n6b5pk2E6W/jFbbiwz80Vs1lACl9pv5kEHkrxBj+aWU/03JzGuIj2g3SkQ=="));
  const yarn = request(`contents/yarn.lock?ref=${replacement.FIXED.source}`);
  assert.equal(yarn.sha, "609bedde0939a22e6d56bf5a2a6a436eb22ba03e");
  const lines = diagLog.split(/\r?\n/).map(line => line.replace(/^\S+Z /, ""));
  const first = lines.indexOf("diff --git a/yarn.lock b/yarn.lock");
  const last = lines.findIndex((line, index) => index > first && line.startsWith("##[group]"));
  assert.ok(first >= 0 && last > first);
  const patch = `${lines.slice(first, last).join("\n")}\n`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v31-linux-yarn-"));
  try {
    fs.writeFileSync(path.join(directory, "yarn.lock"), Buffer.from(yarn.content, "base64"), { flag: "wx" });
    execFileSync("git", ["apply", "--check", "-"], { cwd: directory, input: patch, env: out.childEnv() });
    execFileSync("git", ["apply", "-"], { cwd: directory, input: patch, env: out.childEnv() });
    assert.equal(execFileSync("git", ["hash-object", "yarn.lock"], { cwd: directory, env: out.childEnv(), encoding: "utf8" }).trim(), DIAG_YARN_BLOB);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  return { job, artifact, buildLog };
}
function prepare(product, zip, buildLogFile) {
  const retained = out.loadBuildReservation(replacement.originalContext());
  assert.equal(retained.releaseId, replacement.FIXED.releaseId);
  const checked = source.requireProduct(replacement.FIXED.source, product);
  assert.deepEqual(checked.lockHashes, retained.reservation.lockHashes);
  const lock = JSON.parse(fs.readFileSync(path.join(product, "package-lock.json"), "utf8"));
  const cli = lock.packages["node_modules/@tauri-apps/cli-linux-x64-gnu"];
  assert.equal(cli.version, "2.5.0");
  assert.equal(cli.integrity, "sha512-SG5sFNL7VMmDBdIg3nO3EzNRT306HsiEQ0N90ILe3ZABYAVoPDO/ttpCO37ApLInTzrq/DLN+gOlC/mgZvLw1w==");
  const musl = lock.packages["node_modules/@tauri-apps/cli-linux-x64-musl"];
  assert.equal(musl.version, "2.5.0");
  assert.equal(musl.integrity, "sha512-QXDM8zp/6v05PNWju5ELsVwF0VH1n6b5pk2E6W/jFbbiwz80Vs1lACl9pv5kEHkrxBj+aWU/03JzGuIj2g3SkQ==");
  const saved = evidence();
  fs.writeFileSync(buildLogFile, saved.buildLog, { flag: "wx" });
  const fd = fs.openSync(zip, "wx");
  try { execFileSync("gh", ["api", `repos/${out.REPOSITORY}/actions/artifacts/${EMERGENCY_ID}/zip`],
    { env: out.childEnv(), stdio: ["ignore", fd, "pipe"] }); } finally { fs.closeSync(fd); }
  assert.equal(`sha256:${out.hashFile(zip)}`, EMERGENCY_DIGEST, "Preserved artifact ZIP bytes differ");
  out.stamp(product, replacement.FIXED.version);
}
function capture(product, output, ctx) {
  const retained = out.loadBuildReservation(replacement.originalContext());
  const git = (...args) => execFileSync("git", args, { cwd: product, env: out.childEnv(), encoding: "utf8" }).trimEnd();
  assert.equal(git("rev-parse", "HEAD"), replacement.FIXED.source);
  const changed = git("status", "--porcelain", "--untracked-files=all").split(/\r?\n/).filter(Boolean).map(line => line.slice(3)).sort();
  assert.deepEqual(changed, ["Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
  const files = ["src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "Cargo.lock"];
  const originals = files.map(file => execFileSync("git", ["show", `${replacement.FIXED.source}:${file}`], { cwd: product, env: out.childEnv(), encoding: "utf8" }));
  for (const [file, expected] of Object.entries(out.stamped(...originals, replacement.FIXED.version)))
    assert.ok(fs.readFileSync(path.join(product, file)).equals(Buffer.from(expected)), `Unexpected version stamp: ${file}`);
  for (const [file, hash] of Object.entries(retained.reservation.lockHashes)) assert.equal(out.sha256(fs.readFileSync(path.join(product, file))), hash);
  assert.ok(path.isAbsolute(output) && !fs.existsSync(output)); fs.mkdirSync(output, { recursive: true });
  out.staticOutputs(product, replacement.originalContext(), TARGET, output);
  const job = out.currentJob(ctx, JOB);
  out.gate(job, "Authenticate and download the saved original");
  out.gate(job, "Restore saved staging and verify logged Cargo versions");
  const receipt = { schemaVersion: 1, kind: "bodhi-v31-revalidated-linux", source: replacement.FIXED.source,
    version: replacement.FIXED.version, target: TARGET, reservationSha256: out.sha256(out.bytes(retained.reservation)),
    builder: { runId: BUILD_RUN, attempt: 1, controller: BUILD_CONTROLLER, jobId: BUILD_JOB },
    emergency: { id: EMERGENCY_ID, digest: EMERGENCY_DIGEST },
    diagnostic: { runId: DIAG_RUN, attempt: 1, controller: DIAG_CONTROLLER, jobId: DIAG_JOB, yarnBlob: DIAG_YARN_BLOB },
    limitations: { originalYarnLockRetained: false, originalCargoLockRetained: false },
    validation: { runId: ctx.runId, attempt: ctx.attempt, controller: ctx.controller, jobId: job.id },
    checks: [...out.checks(TARGET), "locked-cargo-log-versions", "reproduced-npm-platform-lock"],
    files: out.names(replacement.FIXED.version, TARGET).map(name => ({ name,
      size: fs.lstatSync(path.join(output, name)).size, sha256: out.hashFile(path.join(output, name)) })) };
  out.write(path.join(output, "target-receipt.json"), receipt);
}
module.exports = { TARGET, BUILD_RUN, BUILD_JOB, BUILD_CONTROLLER, EMERGENCY_ID, EMERGENCY_DIGEST,
  DIAG_RUN, DIAG_JOB, DIAG_CONTROLLER, DIAG_YARN_BLOB, WORKFLOW, BRANCH, JOB, VERIFY, RETAIN, context, evidence, prepare, capture };
if (require.main === module) {
  try { const ctx = context(), command = process.argv[2];
    if (command === "prepare") prepare(process.env.SOURCE_ROOT, process.env.EMERGENCY_ZIP, process.env.BUILD_LOG);
    else if (command === "capture") capture(process.env.SOURCE_ROOT, process.env.TARGET_OUTPUT, ctx);
    else throw Error("Unknown command");
  } catch (error) { console.error(`Saved Linux verification: ${error.message}`); process.exitCode = 1; }
}
