#!/usr/bin/env node
"use strict";

// Main consumes Git and retained bytes as data. It never executes product S.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const out = require("./release-output.cjs");
const source = require("./release-source.cjs");
const finalizer = require("./release-finalizer-v2.cjs");
const recovery31 = require("./replace-v20261031.cjs");
const finalizer31 = require("./finalize-salvaged-v20261031.cjs");
const windows31 = require("./v31-windows-proof.cjs");
const linux31 = require("./v31-linux-proof.cjs");
const publish31 = require("./publish-v31-preserved.cjs");
const { REPOSITORY, NATIVE_TARGETS, SHA, MANIFEST } = out;
const LEGACY_BASE = "aef64d4adce7296086a71b1a6c82fa65c7ccf42d";
const LEGACY_TREE = "41baf69faf3b4c3da5f649a80b58b7283ed90400";
const RELEASE_BLOB = "ff91ec4ca4c3047d6c23c5dc06d575f15fe190e3";
const CURRENT_RELEASE_BLOB = "7b666dc5f0f8f2f79e9b2064acdfe8cc4fa881ca";
const RECOVERY_BLOB = "bebaa01d241bc33c3f968cac5292735845876c78";
const RECOVERY31_BLOB = "3f201b9725f5e1da751841569f41f174db8f00e2";
const FINALIZER31_BLOB = "0fc7de135db1718c7fa5147a3a4512e2db191583";
const FINALIZER31_RUN = 40796552747;
const FINALIZER31_CONTROLLER = "622ed9209113f479100f906e45463232515d7e1a";
const PUBLISHER31_RUN = 40797223393;
const PUBLISHER31_CONTROLLER = "250ab6d8c827385d885f624828179409561e9b27";
const PUBLISHER31_BLOB = "66e95e96b7311a22af0959ac8202b1c88be89219";
const CONTROLS = Object.freeze([".github/workflows/ci.yml", ".github/workflows/release.yml", ".github/workflows/recover-release.yml",
  "scripts/release-source.cjs", "scripts/release-output.cjs", "scripts/release-finalizer-v2.cjs", "scripts/main-admission.cjs", "scripts/main-admission.test.cjs",
  "scripts/browser-runtime.cjs", "scripts/verify-assembly.cjs", "AGENTS.md", "docs/releasing.md",
  ".github/workflows/replace-v20261031.yml", ".github/workflows/finalize-replacement-v20261031.yml", "scripts/replace-v20261031.cjs",
  "scripts/replace-v20261031.test.cjs", "scripts/finalize-replacement-v20261031.cjs", "scripts/finalize-replacement-v20261031.test.cjs",
  "scripts/stage-v20261031-lotus.py", "scripts/stage-v20261031-lotus.test.py", "scripts/release-output-host.test.cjs",
  "scripts/release-output.test.cjs", ".github/workflows/finalize-salvaged-v20261031.yml",
  "scripts/finalize-salvaged-v20261031.cjs", "scripts/finalize-salvaged-v20261031.test.cjs",
  "scripts/v31-windows-proof.cjs", "scripts/verify-v31-windows.cjs", "scripts/v31-linux-proof.cjs", "scripts/verify-v31-linux.cjs",
  ".github/workflows/publish-v31-preserved.yml", "scripts/publish-v31-preserved.cjs",
  "scripts/release-install-shell.cjs", "scripts/release-install-shell.test.cjs",
  "scripts/stage-release-frontend.py", "scripts/stage-release-frontend.test.py"]);
const LOCKS = ["scripts/bamboo-sidecar-lock.json", "scripts/frontend-package-lock.json"];
function id(value) { assert.match(String(value), /^[1-9][0-9]*$/); assert.ok(Number.isSafeInteger(Number(value))); return Number(value); }
function sha(value) { assert.match(value || "", SHA); return value; }
function keys(value, expected) { assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), "Unexpected locator fields"); }
function readOnly(endpoint, method = "GET", body) {
  assert.equal(method, "GET", "Main has read authority only"); assert.equal(body, undefined);
  return out.api(endpoint, "GET");
}
function jobLog(jobId) {
  return execFileSync("gh", ["api", `repos/${REPOSITORY}/actions/jobs/${id(jobId)}/logs`, "--method", "GET", "--allow-escape-sequences"],
    { env: out.childEnv(), encoding: "utf8", maxBuffer: 8 * 1024 ** 2 });
}
function locator(body) {
  assert.ok(typeof body === "string" && Buffer.byteLength(body) <= 128 * 1024);
  const records = [...body.matchAll(/<!-- bodhi-main-locator\/v1\n([\s\S]*?)\n-->/g)];
  assert.equal(records.length, 1, "Require one locator; PR text is not authority");
  const value = JSON.parse(records[0][1]); sha(value.source);
  assert.ok(["promotion", "bootstrap"].includes(value.mode));
  if (value.mode === "bootstrap") {
    keys(value, ["mode", "source", "feature"]); keys(value.feature, ["pullRequest", "runId", "attempt"]);
    for (const item of Object.values(value.feature)) id(item);
  } else {
    keys(value, ["mode", "source", "version", "releaseId", "runId", "attempt", ...(value.recovery ? ["recovery"] : [])]);
    for (const key of ["releaseId", "runId", "attempt"]) id(value[key]);
    if (value.recovery) { keys(value.recovery, ["runId", "attempt"]); id(value.recovery.runId); id(value.recovery.attempt); }
  }
  return value;
}
function ancestor(earlier, later, request) {
  const proof = request(`compare/${sha(earlier)}...${sha(later)}`);
  assert.equal(proof?.merge_base_commit?.sha, earlier, "Controller/source left accepted history");
  assert.ok(["ahead", "identical"].includes(proof.status) && proof.behind_by === 0, "History was rewritten");
}
function mainHead(branch) {
  assert.equal(branch?.name, "main"); assert.equal(branch.protected, true);
  const checks = branch.protection?.required_status_checks;
  assert.equal(checks?.enforcement_level, "everyone", "Main activation requires enforced admission");
  assert.ok(checks.contexts.includes(source.MAIN_GATE));
  assert.ok(checks.checks.some(check => check.context === source.MAIN_GATE && check.app_id === 15368));
  return sha(branch.commit.sha);
}
function tree(commit, request) {
  const object = request(`git/commits/${sha(commit)}`); assert.equal(object?.sha, commit);
  const hash = sha(object.tree.sha);
  const result = request(`git/trees/${hash}?recursive=1`);
  assert.equal(result?.sha, hash); assert.equal(result.truncated, false, "Complete Git tree required");
  assert.ok(Array.isArray(result.tree) && result.tree.length <= 20000);
  const entries = new Map();
  for (const item of result.tree) {
    assert.ok(typeof item.path === "string" && item.path && !item.path.startsWith("/") && !item.path.split("/").some(part => !part || [".", ".."].includes(part)));
    assert.ok(!entries.has(item.path), "Ambiguous Git entry"); sha(item.sha);
    assert.ok(({ blob: ["100644", "100755", "120000"], tree: ["040000"], commit: ["160000"] })[item.type]?.includes(item.mode), "Unsupported Git mode/type");
    entries.set(item.path, { mode: item.mode, type: item.type, sha: item.sha });
  }
  return { hash, entries };
}
const ancestors = new Set(CONTROLS.flatMap(file => file.split("/").slice(0, -1).map((_part, index, parts) => parts.slice(0, index + 1).join("/"))));
function projection(value) { return [...value.entries].filter(([file]) => !ancestors.has(file)).sort(([a], [b]) => a.localeCompare(b)); }
function overlay(base, controls) {
  const entries = new Map(base.entries);
  for (const file of CONTROLS) {
    const entry = controls.entries.get(file);
    assert.ok(entry && entry.type === "blob" && entry.mode === "100644", `Missing regular controller file: ${file}`);
    entries.set(file, entry);
  }
  return { entries };
}
function postimage(base, product, actual, producer) {
  if (actual.hash === product.hash) {
    assert.equal(source.FEATURE_PRODUCERS.get(producer), true, "Complete S requires a recognized Main-capable producer");
    overlay(product, product); // Require every ordinary control file, including this entrypoint.
    assert.equal(product.entries.get(".github/workflows/ci.yml").sha, producer, "Source controller workflow differs");
    return "complete-source";
  }
  assert.deepEqual(projection(actual), projection(overlay(product, base)), "Main differs from the complete source/controller postimage");
  return "retained-main-controls";
}
function sourceReceipt(reservation, request, readLog) {
  const recorded = reservation.admission;
  const fresh = source.verifyAcceptedDev({ source: reservation.source, pullRequest: recorded.pullRequest, runId: recorded.runId, attempt: recorded.attempt }, request, readLog);
  const stable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !["observedDev", "currentDev"].includes(key)));
  assert.deepEqual(stable(fresh), stable(recorded), "Original accepted source proof differs");
  finalizer.refreshSource({ source: reservation.source }, reservation, request);
  for (const file of LOCKS) {
    const response = request(`contents/${file}?ref=${reservation.source}`);
    assert.equal(response?.encoding, "base64"); assert.ok(response.content.length <= 180000);
    const data = Buffer.from(response.content, "base64"); assert.equal(out.sha256(data), reservation.lockHashes[file], "Original source lock differs");
    if (file === LOCKS[1]) assert.deepEqual(JSON.parse(data), reservation.frontend);
  }
  return fresh;
}
function controller(commit, base, workflow, blob, request) {
  ancestor(commit, base, request);
  const allowed = Array.isArray(blob) ? blob : [blob];
  assert.ok(allowed.includes(request(`contents/.github/workflows/${workflow}?ref=${commit}`)?.sha), "Unreviewed original workflow producer");
}
function releaseContext(value, original) {
  // Parse explicit release identity with the existing formatter. These are
  // original-release inputs, never replacements for the Main runtime's env.
  const parsed = out.context({ GITHUB_REPOSITORY: REPOSITORY, RELEASE_VERSION: value.version, EXPECTED_SOURCE_SHA: value.source,
    ORIGINAL_RELEASE_RUN_ID: value.runId, ORIGINAL_RELEASE_ATTEMPT: value.attempt });
  return { ...parsed, controller: sha(original.head_sha) };
}
function runReceipt(run) {
  return Object.fromEntries(["id", "run_attempt", "event", "path", "head_sha", "head_branch", "display_title", "status", "conclusion"]
    .map(key => [key, run[key]]).concat([["repository", run.repository.full_name]]));
}
function recovered31Targets(proof, manifest, windowsProof, linuxProof) {
  assert.equal(manifest.recovery.attempt, proof.run.run_attempt);
  const ctx = { runId: proof.run.id, attempt: proof.run.run_attempt, controller: proof.run.head_sha };
  for (const target of NATIVE_TARGETS) {
    const item = manifest.targets.find(value => value.receipt.target === target); assert.ok(item);
    if (target === windows31.TARGET) {
      windows31.verifyReceipt(item.receipt, manifest.reservation, windowsProof);
      assert.deepEqual(item.logical, { id: windowsProof.logical.id, attempt: windowsProof.logical.run_attempt });
      assert.deepEqual(item.artifact, { id: windowsProof.artifact.id, name: windowsProof.artifact.name, digest: windowsProof.artifact.digest });
      continue;
    }
    if (target === linux31.TARGET) {
      linux31.verifyReceipt(item.receipt, manifest.reservation, linuxProof);
      assert.deepEqual(item.logical, { id: linuxProof.logical.id, attempt: linuxProof.logical.run_attempt });
      assert.deepEqual(item.artifact, { id: linuxProof.artifact.id, name: linuxProof.artifact.name, digest: linuxProof.artifact.digest });
      continue;
    }
    const rows = proof.jobs.filter(job => job.name === `Build recovered (${target})`);
    assert.ok(rows.length); const latest = rows.filter(job => job.run_attempt === Math.max(...rows.map(job => job.run_attempt)));
    assert.equal(latest.length, 1); out.passed(latest[0], ["Select existing recovered target"]);
    const builds = [];
    for (const job of rows.filter(row => row.steps.some(step => step.name === recovery31.BUILD && step.conclusion === "success"))) {
      const physical = source.executionOrigin(job, rows);
      if (!builds.some(value => value.id === physical.id)) builds.push(physical);
    }
    assert.equal(builds.length, 1); const physical = builds[0];
    out.passed(physical, ["Select existing recovered target", "Verify frozen source and stamp version", "Stage the exact prebuilt Lotus package",
      "Verify source boundaries", recovery31.BUILD, recovery31.CAPTURE, recovery31.RETAIN]);
    finalizer31.verifyReceipt(item.receipt, manifest.reservation, target, physical, proof.run);
    assert.deepEqual(item.logical, { id: latest[0].id, attempt: latest[0].run_attempt });
    const artifact = out.artifact(proof.artifacts, recovery31.artifactName(ctx, target, physical.run_attempt), ctx, physical);
    const candidates = proof.artifacts.filter(value => value.name.startsWith(`bodhi-v31-recovered-${recovery31.FIXED.runId}-${ctx.runId}-`) && value.name.endsWith(`-${target}`));
    assert.equal(candidates.length, 1);
    assert.deepEqual(item.artifact, { id: artifact.id, name: artifact.name, digest: artifact.digest });
  }
}
function published31(value, base, request = readOnly, options = {}) {
  assert.deepEqual(value, { mode: "promotion", source: recovery31.FIXED.source, version: recovery31.FIXED.version,
    releaseId: recovery31.FIXED.releaseId, runId: recovery31.FIXED.runId, attempt: 1 }, "Recovery is limited to its original release");
  const restore = options.restore || out.download, readLog = options.readLog || jobLog;
  const originalRun = request(`actions/runs/${value.runId}`), originalCtx = releaseContext(value, originalRun);
  out.runIdentity(originalCtx, originalRun); assert.equal(originalRun.conclusion, "failure");
  controller(originalCtx.controller, base, "release.yml", RELEASE_BLOB, request);
  controller(finalizer31.RECOVERY_CONTROLLER, base, "replace-v20261031.yml", RECOVERY31_BLOB, request);
  controller(FINALIZER31_CONTROLLER, base, "finalize-salvaged-v20261031.yml", FINALIZER31_BLOB, request);
  controller(PUBLISHER31_CONTROLLER, base, "publish-v31-preserved.yml", PUBLISHER31_BLOB, request);
  const retained = publish31.inspect(request, readLog, restore);
  assert.equal(retained.releaseId, value.releaseId);
  const reservation = retained.reservation, manifest = retained.manifest, release = request(`releases/${value.releaseId}`);
  assert.equal(release.draft, false); assert.equal(release.tag_name, originalCtx.finalTag);
  assert.equal(release.target_commitish, value.source); sourceReceipt(reservation, request, readLog);
  finalizer31.verifyManifest(manifest, release, reservation); assert.equal(release.assets.length, 7);
  const identity = asset => ({ id: asset.id, name: asset.name, size: asset.size, digest: asset.digest, state: asset.state });
  const identities = release.assets.map(identity).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(identities, retained.assets);
  const build = finalizer31.recoveryRun(request), windowsProof = windows31.evidence(request, readLog), linuxProof = linux31.evidence(request, readLog);
  recovered31Targets(build, manifest, windowsProof, linuxProof);
  const assembler = request(`actions/runs/${FINALIZER31_RUN}`);
  assert.equal(assembler.id, FINALIZER31_RUN); assert.equal(assembler.conclusion, "failure");
  assert.deepEqual(retained.assembler, { runId: assembler.id, attempt: assembler.run_attempt, controller: assembler.head_sha });
  const run = request(`actions/runs/${PUBLISHER31_RUN}`);
  assert.equal(run.id, PUBLISHER31_RUN); assert.equal(run.repository.full_name, REPOSITORY);
  assert.equal(run.event, "workflow_dispatch"); assert.equal(out.workflow(run.path), publish31.WORKFLOW);
  assert.equal(run.head_branch, "main"); assert.equal(run.head_sha, PUBLISHER31_CONTROLLER);
  assert.equal(run.display_title, "Publish Bodhi v2026.10.31 preserved assets");
  assert.equal(run.status, "completed"); assert.equal(run.conclusion, "success");
  const jobs = out.pages(`actions/runs/${run.id}/jobs?filter=all`, "jobs", request);
  assert.ok(jobs.length && jobs.every(job => job.name === publish31.JOB && job.run_id === run.id && job.head_sha === run.head_sha));
  const selected = jobs.filter(job => job.run_attempt === run.run_attempt); assert.equal(selected.length, 1);
  out.passed(selected[0], ["Verify original evidence and publish its reserved draft"]);
  const physical = source.executionOrigin(selected[0], jobs);
  out.passed(physical, ["Verify original evidence and publish its reserved draft"]);
  assert.equal(request(`git/ref/tags/${originalCtx.finalTag}`)?.object?.sha, value.source);
  return { kind: "bodhi-main-promotion/v31-recovery", source: value.source, controller: originalCtx.controller, runId: value.runId,
    attempt: value.attempt, version: value.version, releaseId: value.releaseId, reservation, originalRun: runReceipt(originalRun),
    recovery31: runReceipt(build.run), windows31: runReceipt(windowsProof.run), linux31: runReceipt(linuxProof.run),
    finalizer31: runReceipt(assembler), publisher31: runReceipt(run), manifestSha256: out.sha256(out.bytes(manifest)), assets: identities };
}
function published(value, base, request = readOnly, options = {}) {
  assert.equal(value.mode, "promotion");
  if (value.version === recovery31.FIXED.version && value.runId === recovery31.FIXED.runId)
    return published31(value, base, request, options);
  const original = request(`actions/runs/${id(value.runId)}`), ctx = releaseContext(value, original);
  out.runIdentity(ctx, original); assert.equal(original.status, "completed");
  controller(ctx.controller, base, "release.yml", [RELEASE_BLOB, CURRENT_RELEASE_BLOB], request);
  const release = request(`releases/${id(value.releaseId)}`);
  assert.equal(release?.id, id(value.releaseId)); const reservation = out.releaseReservation(release, ctx);
  const read = options.readManifest || finalizer.readManifest;
  const assets = release.assets.filter(asset => asset.name === MANIFEST); assert.equal(assets.length, 1);
  finalizer.validateAsset(assets[0], ctx); const manifest = read(assets[0].id);
  finalizer.verifyPublished(ctx, release, manifest);
  const destinations = [];
  const restore = (artifact, entries, directory) => {
    assert.equal(fs.existsSync(directory), false); destinations.push(directory);
    return (options.restore || out.download)(artifact, entries, directory);
  };
  try {
    const retained = out.loadReservation(ctx, request, restore);
    assert.equal(retained.release.id, release.id); assert.deepEqual(retained.reservation, reservation);
    assert.deepEqual(manifest.reservationArtifact, { id: retained.artifact.id, name: retained.artifact.name, digest: retained.artifact.digest });
    sourceReceipt(reservation, request, options.readLog || jobLog);
    const targets = NATIVE_TARGETS.map(target => out.selectTarget(ctx, reservation, target, request, restore, true));
    assert.ok(targets.every(Boolean));
    assert.deepEqual(manifest.targets, targets.map(({ receipt, artifact }) => ({ receipt, artifact })));
    const rows = out.jobs(ctx, request), matches = rows.filter(job => job.name === "Publish original release");
    const latest = matches.filter(job => job.run_attempt === Math.max(...matches.map(job => job.run_attempt)));
    assert.equal(latest.length, 1); const logical = latest[0];
    let publisher, recoveryReceipt;
    if (!value.recovery) {
      assert.equal(original.conclusion, "success"); out.passed(logical, [finalizer.ASSEMBLE, finalizer.EVIDENCE, finalizer.PUBLISH]);
      publisher = source.executionOrigin(logical, matches);
    } else {
      assert.equal(original.conclusion, "failure");
      const recovered = finalizer.recoveryArtifact(ctx, request);
      assert.equal(logical.run_attempt, ctx.attempt); assert.equal(recovered.ctx.controller, ctx.controller);
      publisher = logical;
      const recovery = request(`actions/runs/${id(value.recovery.runId)}`);
      assert.equal(recovery?.id, id(value.recovery.runId)); assert.equal(recovery.run_attempt, id(value.recovery.attempt));
      assert.equal(recovery.repository.full_name, REPOSITORY); assert.equal(recovery.event, "workflow_dispatch");
      assert.equal(recovery.head_branch, "main"); assert.equal(recovery.status, "completed"); assert.equal(recovery.conclusion, "success");
      assert.equal(out.workflow(recovery.path), ".github/workflows/recover-release.yml");
      assert.equal(recovery.display_title, `Recover Bodhi v${ctx.version} from ${ctx.runId} attempt ${ctx.attempt}`);
      controller(sha(recovery.head_sha), base, "recover-release.yml", RECOVERY_BLOB, request);
      const jobs = out.pages(`actions/runs/${recovery.id}/jobs?filter=all`, "jobs", request);
      assert.equal(new Set(jobs.map(job => job.id)).size, jobs.length);
      assert.ok(jobs.every(job => ["recover", "recover-v2"].includes(job.name)));
      for (const job of jobs) { assert.equal(job.run_id, recovery.id); assert.equal(job.head_sha, recovery.head_sha); assert.ok(id(job.run_attempt) <= recovery.run_attempt); }
      const selected = jobs.filter(job => job.name === "recover-v2" && job.run_attempt === recovery.run_attempt);
      assert.equal(selected.length, 1); out.passed(selected[0], ["Verify original immutable outputs and recover publication"]);
      const physical = source.executionOrigin(selected[0], jobs.filter(job => job.name === "recover-v2"));
      recoveryReceipt = { run: runReceipt(recovery), controller: recovery.head_sha, jobId: physical.id, attempt: physical.run_attempt,
        logical: { id: selected[0].id, attempt: selected[0].run_attempt } };
      const legacy = jobs.filter(job => job.name === "recover"); assert.ok(legacy.length);
      assert.equal(new Set(legacy.map(job => job.run_attempt)).size, legacy.length);
      for (const job of legacy) { assert.equal(job.status, "completed"); assert.equal(job.conclusion, "skipped"); assert.deepEqual(job.steps, []); }
    }
    const assembler = matches.filter(job => job.id === manifest.finalizer.jobId && job.run_attempt === manifest.finalizer.attempt);
    assert.equal(assembler.length, 1, "Original manifest assembler is missing"); assert.equal(assembler[0].status, "completed");
    const assembly = assembler[0].steps.filter(step => step.name === finalizer.ASSEMBLE);
    assert.equal(assembly.length, 1); assert.equal(assembly[0].status, "completed");
    assert.ok(["success", "failure"].includes(assembly[0].conclusion), "Original assembler never executed");
    const created = Date.parse(assets[0].created_at), started = Date.parse(assembler[0].started_at), completed = Date.parse(assembler[0].completed_at);
    assert.ok(Number.isFinite(created) && Number.isFinite(started) && Number.isFinite(completed) && created >= started && created <= completed,
      "Manifest asset is outside its original assembler");
    const evidenceCtx = { ...ctx, attempt: publisher.run_attempt, evidenceName: `bodhi-v2-evidence-${ctx.runId}-${publisher.run_attempt}` };
    const evidence = finalizer.publicationEvidence(evidenceCtx, publisher, release, request, restore);
    assert.deepEqual(evidence.evidence.manifest, manifest);
    assert.equal(request(`git/ref/tags/${ctx.finalTag}`)?.object?.sha, ctx.source);
    return { kind: "bodhi-main-promotion/v1", source: ctx.source, controller: ctx.controller, runId: ctx.runId, attempt: ctx.attempt,
      version: ctx.version, releaseId: release.id, reservation, originalRun: runReceipt(original), ...(recoveryReceipt ? { recovery: recoveryReceipt } : {}),
      manifestSha256: out.sha256(out.bytes(manifest)), publisher: { id: publisher.id, attempt: publisher.run_attempt,
        logical: { id: logical.id, attempt: logical.run_attempt } }, assets: evidence.evidence.assets };
  } finally { for (const directory of destinations) fs.rmSync(directory, { recursive: true, force: true }); }
}
function bootstrap(value, base, actual, request = readOnly, readLog = jobLog) {
  assert.equal(value.mode, "bootstrap"); assert.equal(base, LEGACY_BASE, "Bootstrap only at the fixed legacy base");
  const branch = request("branches/main"); assert.equal(branch?.name, "main"); assert.equal(branch.protected, true); assert.equal(branch.commit.sha, base);
  const before = tree(base, request); assert.equal(before.hash, LEGACY_TREE);
  assert.equal(before.entries.has("scripts/main-admission.cjs"), false, "Bootstrap already present");
  const admission = source.verifyAcceptedDev({ source: value.source, ...value.feature }, request, readLog);
  assert.equal(admission.workflowBlob, source.FEATURE_WORKFLOW_BLOB, "Bootstrap requires the Main-capable producer");
  const controls = tree(value.source, request);
  assert.equal(controls.hash, admission.tree);
  assert.equal(controls.entries.get(".github/workflows/release.yml")?.sha, RELEASE_BLOB);
  assert.equal(controls.entries.get(".github/workflows/recover-release.yml")?.sha, RECOVERY_BLOB);
  assert.deepEqual(projection(actual), projection(overlay(before, controls)), "Bootstrap changes nonallowlisted source or imports partial controls");
  const dev = source.devHead(request("branches/dev")); ancestor(admission.currentDev, dev, request);
  assert.equal(request("branches/main").commit.sha, base, "Main advanced after bootstrap proof");
  return { kind: "bodhi-main-bootstrap/v1", base, controllerSource: value.source, tree: actual.hash, admission };
}
function mainPR(number, snapshot, request) {
  const pr = request(`pulls/${id(number)}`);
  assert.equal(pr?.number, id(number)); assert.equal(pr.state, "open"); assert.equal(pr.merged, false); assert.equal(pr.mergeable, true);
  assert.equal(pr.base.ref, "main"); assert.equal(pr.base.repo.full_name, REPOSITORY); assert.equal(pr.head.repo.full_name, REPOSITORY);
  sha(pr.base.sha); sha(pr.head.sha); assert.equal(pr.merge_commit_sha, sha(snapshot));
  const merge = request(`git/commits/${snapshot}`);
  assert.deepEqual(merge.parents.map(parent => parent.sha), [pr.base.sha, pr.head.sha]);
  return pr;
}
function verifyMain({ pullRequest, snapshot }, request = readOnly, options = {}) {
  const pr = mainPR(pullRequest, snapshot, request), value = locator(pr.body);
  const branch = request("branches/main"); assert.equal(branch?.name, "main"); assert.equal(branch.protected, true); assert.equal(branch.commit.sha, pr.base.sha);
  const actual = tree(snapshot, request); let proof;
  if (value.mode === "bootstrap") proof = bootstrap(value, pr.base.sha, actual, request, options.readLog || jobLog);
  else {
    assert.equal(mainHead(branch), pr.base.sha);
    proof = published(value, pr.base.sha, request, options);
    proof.postimage = postimage(tree(pr.base.sha, request), tree(value.source, request), actual, proof.reservation.admission.workflowBlob);
  }
  const fresh = mainPR(pullRequest, snapshot, request);
  assert.equal(fresh.base.sha, pr.base.sha); assert.equal(fresh.head.sha, pr.head.sha);
  assert.deepEqual(locator(fresh.body), value, "Main locator changed during admission");
  assert.equal(request("branches/main").commit.sha, pr.base.sha, "Main base advanced during admission");
  if (value.mode === "promotion") {
    assert.equal(mainHead(request("branches/main")), pr.base.sha);
    const release = request(`releases/${value.releaseId}`);
    const ctx = releaseContext(value, { head_sha: proof.controller });
    assert.deepEqual(out.releaseReservation(release, ctx), proof.reservation, "Release reservation changed during Main admission");
    const isRecovery31 = proof.kind === "bodhi-main-promotion/v31-recovery";
    const name = isRecovery31 ? finalizer31.MANIFEST : MANIFEST;
    const manifest = (options.readManifest || finalizer.readManifest)(release.assets.find(asset => asset.name === name)?.id);
    if (isRecovery31) {
      finalizer31.verifyManifest(manifest, release, proof.reservation);
      assert.deepEqual(runReceipt(request(`actions/runs/${proof.recovery31.id}`)), proof.recovery31, "Build recovery changed during Main admission");
      assert.deepEqual(runReceipt(request(`actions/runs/${proof.windows31.id}`)), proof.windows31, "Windows validation changed during Main admission");
      assert.deepEqual(runReceipt(request(`actions/runs/${proof.linux31.id}`)), proof.linux31, "Linux validation changed during Main admission");
      assert.deepEqual(runReceipt(request(`actions/runs/${proof.finalizer31.id}`)), proof.finalizer31, "Finalizer changed during Main admission");
      assert.deepEqual(runReceipt(request(`actions/runs/${proof.publisher31.id}`)), proof.publisher31, "Publisher changed during Main admission");
    } else finalizer.verifyPublished(ctx, release, manifest);
    assert.equal(out.sha256(out.bytes(manifest)), proof.manifestSha256);
    assert.deepEqual(release.assets.map(({ id, name, size, digest, state }) => ({ id, name, size, digest, state })).sort((a, b) => a.name.localeCompare(b.name)), proof.assets);
    assert.deepEqual(runReceipt(request(`actions/runs/${value.runId}`)), proof.originalRun, "Release run changed during Main admission");
    if (proof.recovery) assert.deepEqual(runReceipt(request(`actions/runs/${proof.recovery.run.id}`)), proof.recovery.run, "Recovery run changed during Main admission");
    finalizer.refreshSource(ctx, proof.reservation, request);
    assert.equal(request(`git/ref/tags/app-v${value.version}`)?.object?.sha, value.source);
  }
  return { ...proof, pullRequest: id(pullRequest), base: pr.base.sha, head: pr.head.sha, snapshot, mainTree: actual.hash };
}
function main() {
  const env = process.env, event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY); assert.equal(env.GITHUB_EVENT_NAME, "pull_request_target");
  assert.equal(event.pull_request.base.ref, "main"); assert.equal(env.GITHUB_REF, "refs/heads/main");
  const verifier = sha(env.GITHUB_WORKFLOW_SHA); assert.equal(env.GITHUB_SHA, verifier);
  assert.equal(event.pull_request.base.sha, verifier, "Main base changed after the Target event");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main`);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, ".."), env: out.childEnv(), encoding: "utf8" }).trim(), verifier);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: path.resolve(__dirname, ".."), env: out.childEnv(), encoding: "utf8" }).trim(), "");
  assert.equal(readOnly(`contents/.github/workflows/ci.yml?ref=${verifier}`)?.sha, source.FEATURE_WORKFLOW_BLOB);
  const triggered = locator(event.pull_request.body), pr = readOnly(`pulls/${id(event.number)}`);
  assert.equal(pr?.base.sha, verifier); assert.equal(pr.head.sha, event.pull_request.head.sha, "Main head changed after the Target event");
  assert.equal(pr.head.ref, event.pull_request.head.ref);
  assert.deepEqual(locator(pr.body), triggered, "Locator changed after this Target event; require the edited-event check");
  assert.notEqual(triggered.mode, "bootstrap", "The first trusted-D entrypoint requires separate Ops anchoring");
  const snapshot = sha(pr.merge_commit_sha); // M is independent PR/API evidence, never GITHUB_SHA.
  const runtime = () => {
    const runId = id(env.GITHUB_RUN_ID), attempt = id(env.GITHUB_RUN_ATTEMPT), run = readOnly(`actions/runs/${runId}`);
    assert.equal(run?.id, runId); assert.equal(run.run_attempt, attempt); assert.equal(run.repository.full_name, REPOSITORY);
    assert.equal(run.event, "pull_request_target"); assert.equal(out.workflow(run.path), ".github/workflows/ci.yml");
    // Target's definition/GITHUB_SHA are B, but REST run/job head fields name P.
    assert.equal(run.head_sha, pr.head.sha); assert.equal(run.head_branch, pr.head.ref); assert.equal(run.status, "in_progress"); assert.equal(run.conclusion, null);
    const rows = out.pages(`actions/runs/${runId}/jobs?filter=all`, "jobs", readOnly);
    const selected = rows.filter(job => job.name === source.MAIN_GATE && job.run_attempt === attempt);
    assert.equal(selected.length, 1); const job = selected[0];
    assert.equal(job.run_id, runId); assert.equal(job.head_sha, run.head_sha); assert.equal(job.status, "in_progress"); assert.equal(job.conclusion, null);
    const steps = job.steps.filter(step => step.name === "Verify completed publication and exact main postimage");
    assert.equal(steps.length, 1); assert.equal(steps[0].status, "in_progress"); assert.equal(steps[0].conclusion, null);
    return { runId, attempt, jobId: id(job.id), verifier };
  };
  const identity = runtime(), proof = verifyMain({ pullRequest: event.number, snapshot });
  assert.equal(proof.base, verifier); assert.deepEqual(locator(readOnly(`pulls/${event.number}`).body), triggered, "Target locator changed before returning success");
  assert.deepEqual(runtime(), identity, "Main execution changed while admitting source");
  console.log(JSON.stringify({ ...proof, runtime: identity }, null, 2));
}
module.exports = { LEGACY_BASE, LEGACY_TREE, RELEASE_BLOB, RECOVERY_BLOB, CONTROLS, locator, readOnly, mainHead, tree, postimage,
  sourceReceipt, recovered31Targets, published31, published, bootstrap, verifyMain };
if (require.main === module) { try { main(); } catch (error) { console.error(`Bodhi main admission: ${error.message}`); process.exitCode = 1; } }
