"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const out = require("./release-output.cjs");
const recovery = require("./replace-v20261031.cjs");

const target = "aarch64-apple-darwin";
const step = (name, conclusion) => ({ name, status: "completed", conclusion });
const original = () => ({ id: recovery.FIXED.jobs[target], name: `Build original (${target})`,
  status: "completed", conclusion: "failure", steps: [step(out.BUILD, "failure"), step(out.CAPTURE, "skipped"), step(out.RETAIN, "skipped")] });
const failureLog = "##[group]Run npm run tauri:build\nFound version mismatched Tauri packages\n@tauri-apps/api\n@tauri-apps/plugin-dialog\n@tauri-apps/plugin-fs\n##[error]Process completed with exit code 1.";

test("original failure must prove all output steps were skipped before compilation", () => {
  assert.doesNotThrow(() => recovery.assertOriginalFailure(original(), target, failureLog));
  for (const text of [failureLog.replace("Found version mismatched Tauri packages", "Unknown error"),
    failureLog.replace("@tauri-apps/plugin-fs", "missing"), failureLog.replace("##[error]", "beforeBuildCommand started\n##[error]"),
    failureLog.replace("##[error]", "Compiling bodhi\n##[error]")]) {
    assert.throws(() => recovery.assertOriginalFailure(original(), target, text));
  }
  const changed = original(); changed.steps[1].conclusion = "success";
  assert.throws(() => recovery.assertOriginalFailure(changed, target, failureLog));
  assert.throws(() => recovery.assertOriginalFailure({ ...original(), id: 1 }, target, failureLog));
});

test("recovery cannot start another run or rebuild an ambiguous prior output", () => {
  const ctx = { runId: 998, attempt: 2, controller: "a".repeat(40) };
  const current = { id: 20, run_id: ctx.runId, run_attempt: 2, head_sha: ctx.controller,
    name: `Build recovered (${target})`, status: "in_progress", steps: [] };
  const run = { id: ctx.runId, repository: { full_name: out.REPOSITORY }, event: "workflow_dispatch",
    path: recovery.WORKFLOW, head_branch: "main", head_sha: ctx.controller, run_attempt: ctx.attempt,
    status: "in_progress", display_title: `Replace Bodhi v${recovery.FIXED.version} lost output from ${recovery.LOST_RUN}` };
  const request = (rows, runs = [run], artifacts = []) => route => {
    if (route.startsWith("actions/workflows/")) return { workflow_runs: runs, total_count: runs.length };
    if (route.includes("/jobs?")) return { jobs: rows, total_count: rows.length };
    if (route.includes("/artifacts?")) return { artifacts, total_count: artifacts.length };
    throw new Error("Unexpected endpoint: " + route);
  };
  assert.deepEqual(recovery.plan(ctx, target, request([current])),
    { reuse: false, artifactName: recovery.artifactName(ctx, target) });
  assert.throws(() => recovery.plan(ctx, target, request([current], [{ ...run, id: 997 }, run])), /another build/);
  assert.throws(() => recovery.plan(ctx, target, request([current], [{ ...run, head_sha: "f".repeat(40) }])), /strictly equal/);
  const failed = { ...current, id: 10, run_attempt: 1, status: "completed", conclusion: "failure", steps: [step(recovery.BUILD, "failure")] };
  assert.throws(() => recovery.plan(ctx, target, request([failed, current])), /classify/);
  const success = { ...failed, conclusion: "success", started_at: "2026-10-28T00:00:00Z", completed_at: "2026-10-28T00:10:00Z",
    steps: [step(recovery.BUILD, "success"), step(recovery.CAPTURE, "success"), step(recovery.RETAIN, "success")] };
  assert.throws(() => recovery.plan(ctx, target, request([success, current])), /artifact missing/);
  const artifact = { id: 42, name: recovery.artifactName(ctx, target, 1), expired: false,
    digest: "sha256:" + "b".repeat(64), size_in_bytes: 100, created_at: "2026-10-28T00:09:00Z",
    workflow_run: { id: ctx.runId, head_sha: ctx.controller } };
  assert.deepEqual(recovery.plan(ctx, target, request([success, current], undefined, [artifact])),
    { reuse: true, artifactId: 42, artifactName: artifact.name });
});

test("replacement requires the exact failed capture and proves no retained target output", () => {
  const run = { id: recovery.LOST_RUN, repository: { full_name: out.REPOSITORY }, event: "workflow_dispatch",
    path: ".github/workflows/recover-v20261031.yml", head_branch: "main", head_sha: recovery.LOST_CONTROLLER,
    run_attempt: 1, status: "completed", conclusion: "cancelled",
    display_title: `Recover Bodhi v${recovery.FIXED.version} original ${recovery.FIXED.runId}` };
  const jobs = [{ id: 9, name: "Authenticate original pre-build failure", status: "completed", conclusion: "success",
    steps: [step("Verify original reservation, source and pre-compile failures", "success")] }];
  for (const target of out.NATIVE_TARGETS) {
    const mac = target.includes("darwin");
    jobs.push({ id: recovery.LOST_JOBS[target], run_id: run.id, run_attempt: 1, head_sha: run.head_sha,
      name: `Build recovered (${target})`, status: "completed", conclusion: mac ? "failure" : "cancelled",
      steps: [step(recovery.BUILD, mac ? "success" : "cancelled"), step(recovery.CAPTURE, mac ? "failure" : "skipped"), step(recovery.RETAIN, "skipped")] });
  }
  const request = (jobRows = jobs, artifacts = []) => endpoint => {
    if (endpoint === `actions/runs/${run.id}`) return run;
    if (endpoint.includes("/jobs?")) return { jobs: jobRows, total_count: jobRows.length };
    if (endpoint.includes("/artifacts?")) return { artifacts, total_count: artifacts.length };
    throw Error(`Unexpected endpoint: ${endpoint}`);
  };
  const log = () => "ENOENT: no such file or directory, open '/cache/browser-host/host.cjs'";
  assert.doesNotThrow(() => recovery.assertLostRecovery(request(), log));
  assert.throws(() => recovery.assertLostRecovery(request(jobs, [{ id: 1 }]), log));
  assert.throws(() => recovery.assertLostRecovery(request(), () => "different failure"));
  const changed = structuredClone(jobs); changed.find(job => job.name.includes("aarch64")).steps[0].conclusion = "failure";
  assert.throws(() => recovery.assertLostRecovery(request(changed), log));
});
