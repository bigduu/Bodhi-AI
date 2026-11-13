#!/usr/bin/env node
"use strict";

// Trusted controller code. Product S is an explicit disposable checkout, never GITHUB_SHA.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const legacy = require("./release-finalizer.cjs");
const admission = require("./release-source.cjs");
const ROOT = path.resolve(__dirname, "..");
const { REPOSITORY, NATIVE_TARGETS } = legacy;
const BUILD = "Build original Tauri installers";
const CAPTURE = "Verify static assembly and capture original outputs";
const RETAIN = "Retain original target output";
const PREFLIGHT = "Admit frozen dev source and reserve version";
const RESERVATION = "Retain original source admission and reservation";
const MANIFEST = "bodhi-release-v2.json";
const ARM_LINUX = "aarch64-unknown-linux-gnu";
const ARM_WINDOWS = "aarch64-pc-windows-msvc";
const V2_CONTRACT = Object.freeze({ schemaVersion: 2, manifest: MANIFEST, targets: Object.freeze([...NATIVE_TARGETS]) });
const V3_CONTRACT = Object.freeze({ schemaVersion: 3, manifest: "bodhi-release-v3.json",
  targets: Object.freeze([...NATIVE_TARGETS, ARM_LINUX, ARM_WINDOWS]) });
const ORIGINAL_RELEASE_WORKFLOW_BLOB = "ff91ec4ca4c3047d6c23c5dc06d575f15fe190e3";
const V2_RELEASE_WORKFLOW_BLOB = "7b666dc5f0f8f2f79e9b2064acdfe8cc4fa881ca";
const ARM64_RELEASE_WORKFLOW_BLOB = "a73ce504ce9ed1ad6ee62f09921a27f63c0e5412";
const RELEASE_MATRIX = {
  "aarch64-apple-darwin": { platform: "macos-latest", bundles: "app,dmg" },
  "x86_64-unknown-linux-gnu": { platform: "ubuntu-22.04", bundles: "appimage,deb,rpm" },
  "x86_64-pc-windows-msvc": { platform: "windows-latest", bundles: "nsis" },
  [ARM_LINUX]: { platform: "ubuntu-22.04-arm", bundles: "appimage,deb,rpm" },
  [ARM_WINDOWS]: { platform: "windows-11-arm", bundles: "nsis" },
};
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: childEnv() }).trimEnd();
function id(value) { assert.match(String(value), /^[1-9][0-9]*$/); assert.ok(Number.isSafeInteger(Number(value))); return Number(value); }
function childEnv(env = process.env) {
  return Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "GH_TOKEN", "GH_HOST", "GH_CONFIG_DIR"]
    .filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}
function api(endpoint, method = "GET", body) {
  const args = ["api", `repos/${REPOSITORY}/${endpoint}`, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  const result = spawnSync("gh", args, { env: childEnv(), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    input: body === undefined ? undefined : JSON.stringify(body) });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (method === "GET" && /HTTP 404\b/.test(result.stderr)) return null;
    throw new Error(`GitHub ${method} ${endpoint} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}
function pages(endpoint, key, request = api) {
  const rows = [];
  for (let page = 1; ; page++) {
    const response = request(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = key ? response?.[key] : response;
    assert.ok(Array.isArray(batch), "Incomplete GitHub evidence"); rows.push(...batch);
    if (batch.length < 100) {
      if (key) assert.equal(response.total_count, rows.length, "Truncated GitHub evidence");
      return rows;
    }
  }
}
function releaseContract(ctx) {
  if (ctx.v3FeatureWorkflowBlob === undefined) return V2_CONTRACT;
  assert.equal(ctx.v3FeatureWorkflowBlob, admission.ARM64_FEATURE_WORKFLOW_BLOB, "Require the reviewed v3 feature workflow blob");
  return V3_CONTRACT;
}
function releaseMatrix(ctx) {
  return { include: releaseContract(ctx).targets.map(target => ({ target, ...RELEASE_MATRIX[target] })) };
}
function context(env = process.env) {
  return releaseContext({ ...legacy.context(env), controller: env.GITHUB_WORKFLOW_SHA });
}
function releaseContext(ctx) {
  const prefix = `bodhi-v${releaseContract(ctx).schemaVersion}`;
  return { ...ctx, draftTag: `${prefix}-draft-v${ctx.version}-${ctx.runId}`,
    reservationName: `${prefix}-reservation-${ctx.runId}`, evidenceName: `${prefix}-evidence-${ctx.runId}-${ctx.attempt}` };
}
function controller(recovery = false, env = process.env, root = ROOT, executeGit = git) {
  if (!recovery) return admission.requireController(env, root, executeGit);
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY); assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/.github/workflows/recover-release.yml@refs/heads/main`);
  assert.match(env.GITHUB_WORKFLOW_SHA || "", SHA); assert.equal(env.GITHUB_SHA, env.GITHUB_WORKFLOW_SHA);
  assert.equal(executeGit(root, "rev-parse", "HEAD"), env.GITHUB_WORKFLOW_SHA);
  assert.equal(executeGit(root, "status", "--porcelain", "--untracked-files=all"), "");
  return env.GITHUB_WORKFLOW_SHA;
}
function workflow(value) {
  const [file, ref, extra] = String(value).split("@"); assert.ok(!extra && (ref === undefined || /^\S+$/.test(ref)));
  return file.startsWith(`${REPOSITORY}/`) ? file.slice(REPOSITORY.length + 1) : file;
}
// Derive the contract from the immutable source and the original dispatcher.
// A caller's version/schema flags and retained receipt bytes cannot select it.
function originalContext(ctx, commit, request = api) {
  assert.match(commit || "", SHA, "Invalid original controller");
  const producer = request(`contents/.github/workflows/release.yml?ref=${commit}`)?.sha;
  if ([ORIGINAL_RELEASE_WORKFLOW_BLOB, V2_RELEASE_WORKFLOW_BLOB].includes(producer)) {
    return releaseContext({ ...ctx, controller: commit, producer, v3FeatureWorkflowBlob: undefined });
  }
  assert.equal(producer, ARM64_RELEASE_WORKFLOW_BLOB, "Unreviewed original workflow producer");
  const featureBlob = request(`contents/.github/workflows/ci.yml?ref=${ctx.source}`)?.sha;
  const targets = admission.featureTargets(featureBlob);
  const v3FeatureWorkflowBlob = targets.length === V3_CONTRACT.targets.length ? featureBlob : undefined;
  return releaseContext({ ...ctx, controller: commit, producer, v3FeatureWorkflowBlob });
}
function runIdentity(ctx, value) {
  assert.equal(value?.id, ctx.runId); assert.equal(value.repository.full_name, REPOSITORY);
  assert.equal(value.run_attempt, ctx.attempt, "Release attempt changed");
  assert.equal(value.event, "workflow_dispatch"); assert.equal(workflow(value.path), ".github/workflows/release.yml");
  assert.equal(value.head_branch, "main"); assert.match(value.head_sha || "", SHA);
  if (ctx.controller) assert.equal(value.head_sha, ctx.controller, "Original controller differs");
  const label = ctx.producer === ARM64_RELEASE_WORKFLOW_BLOB ? "original" : `v${releaseContract(ctx).schemaVersion}`;
  assert.equal(value.display_title, `Bodhi ${label} v${ctx.version} @ ${ctx.source}`);
  return value;
}
function run(ctx, request = api, recovery = false) {
  const value = runIdentity(ctx, request(`actions/runs/${ctx.runId}`));
  assert.equal(value.status, recovery ? "completed" : "in_progress");
  assert.equal(value.conclusion, recovery ? "failure" : null);
  return value;
}
function jobs(ctx, request = api, { preflightOnly = false } = {}) {
  let rows = pages(`actions/runs/${ctx.runId}/jobs?filter=all`, "jobs", request);
  // A rerun can expose a matrix placeholder until this preflight emits its
  // outputs. Target selection still authenticates the complete expanded graph.
  if (preflightOnly) rows = rows.filter(job => job.name === "Reserve admitted release");
  const names = ["Reserve admitted release", "Publish original release", ...releaseContract(ctx).targets.map(target => `Build original (${target})`)];
  const inertMatrixAttempts = new Set();
  assert.equal(new Set(rows.map(job => job.id)).size, rows.length);
  return rows.filter(job => {
    assert.equal(job.run_id, ctx.runId); assert.equal(job.head_sha, ctx.controller);
    const attempt = id(job.run_attempt); assert.ok(attempt <= ctx.attempt, "Future job attempt");
    if (names.includes(job.name)) return true;
    const skippedMatrix = job.name === "Build original (${{ matrix.target }})" && attempt < ctx.attempt &&
      job.status === "completed" && job.conclusion === "skipped" && Array.isArray(job.steps) && job.steps.length === 0;
    assert.ok(skippedMatrix && !inertMatrixAttempts.has(attempt), "Foreign release job");
    inertMatrixAttempts.add(attempt);
    return false;
  });
}
function gate(job, name) {
  const steps = job.steps.filter(step => step.name === name);
  assert.equal(steps.length, 1, `Missing or ambiguous gate: ${name}`);
  assert.equal(steps[0].status, "completed"); assert.equal(steps[0].conclusion, "success", `Gate did not pass: ${name}`);
}
function passed(job, gates) {
  assert.equal(job.status, "completed"); assert.equal(job.conclusion, "success", `Job did not pass: ${job.name}`);
  for (const name of gates) gate(job, name);
}
function currentJob(ctx, name, request = api) {
  // While preflight runs, dependent matrix jobs may still have an unexpanded
  // scheduler name. Authenticate this job now; validate the complete graph when
  // selecting completed output evidence.
  const matches = pages(`actions/runs/${ctx.runId}/jobs?filter=all`, "jobs", request).filter(job => job.name === name && job.run_attempt === ctx.attempt);
  assert.equal(matches.length, 1, `Missing or ambiguous current job: ${name}`);
  const job = matches[0]; assert.ok(Number.isSafeInteger(job.id) && job.id > 0);
  assert.equal(job.run_id, ctx.runId); assert.equal(job.head_sha, ctx.controller);
  assert.equal(job.status, "in_progress"); return job;
}
function readJson(file, maximum = 128 * 1024) {
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, "Bounded regular JSON required");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function write(file, value) { fs.writeFileSync(file, bytes(value), { flag: "wx" }); }
function linuxPackageArchitectures(target) {
  if (target === "x86_64-unknown-linux-gnu") return { appimage: "amd64", deb: "amd64", rpm: "x86_64" };
  assert.equal(target, ARM_LINUX, "Unsupported Linux packaging target");
  return { appimage: "aarch64", deb: "arm64", rpm: "aarch64" };
}
function names(version, target) {
  assert.ok(V3_CONTRACT.targets.includes(target), "Unsupported installer target");
  if (target === "aarch64-apple-darwin") return [`Bodhi.AI_${version}_aarch64.dmg`, "Bodhi.AI_aarch64.app.tar.gz"];
  if (target.endsWith("-linux-gnu")) {
    const arch = linuxPackageArchitectures(target);
    return [`Bodhi.AI_${version}_${arch.appimage}.AppImage`, `Bodhi.AI_${version}_${arch.deb}.deb`, `Bodhi.AI-${version}-1.${arch.rpm}.rpm`];
  }
  return [`Bodhi.AI_${version}_${target === ARM_WINDOWS ? "arm64" : "x64"}-setup.exe`];
}
function artifactName(ctx, target, attempt) {
  const contract = releaseContract(ctx);
  assert.ok(contract.targets.includes(target), "Target is outside the selected release contract");
  return `bodhi-v${contract.schemaVersion}-target-${ctx.runId}-${id(attempt)}-${target}`;
}
function artifactMetadata(artifacts, name, ctx, maximum = 8 * 1024 ** 3) {
  const matches = artifacts.filter(value => value.name === name); assert.equal(matches.length, 1, `Original artifact missing or ambiguous: ${name}`);
  const value = matches[0]; id(value.id); assert.equal(value.expired, false, "Original artifact expired");
  assert.match(value.digest || "", DIGEST, "Immutable artifact digest required");
  assert.ok(Number.isSafeInteger(value.size_in_bytes) && value.size_in_bytes > 0 && value.size_in_bytes <= maximum);
  assert.equal(value.workflow_run.id, ctx.runId); assert.equal(value.workflow_run.head_sha, ctx.controller);
  return value;
}
function artifact(artifacts, name, ctx, job, active = false) {
  const value = artifactMetadata(artifacts, name, ctx);
  if (active) { assert.equal(job.status, "in_progress"); assert.equal(job.run_attempt, ctx.attempt); }
  const created = Date.parse(value.created_at), start = Date.parse(job.started_at), end = active ? Date.now() : Date.parse(job.completed_at);
  assert.ok(Number.isFinite(created) && created >= start && created <= end, "Artifact is outside its original job");
  return value;
}
function download(value, entries, destination) {
  assert.ok(!fs.existsSync(destination), "Restore destination must be new"); fs.mkdirSync(destination, { recursive: true });
  const zip = path.join(destination, ".original.zip"), descriptor = fs.openSync(zip, "wx");
  try { execFileSync("gh", ["api", `repos/${REPOSITORY}/actions/artifacts/${id(value.id)}/zip`, "--method", "GET"],
    { env: childEnv(), stdio: ["ignore", descriptor, "pipe"] }); } finally { fs.closeSync(descriptor); }
  // Hash streaming, so multi-GB installers are never buffered in the controller heap.
  assert.equal(`sha256:${hashFile(zip)}`, value.digest, "Downloaded artifact ZIP digest differs");
  if (process.platform === "win32") {
    // Hosted Windows has PowerShell/.NET, but need not expose Git's unzip on PATH.
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip=[IO.Compression.ZipFile]::OpenRead($env:BODHI_ORIGINAL_ZIP)
      try { $expected=@(ConvertFrom-Json $env:BODHI_ORIGINAL_ENTRIES | Sort-Object -CaseSensitive)
        $actual=@($zip.Entries.FullName | Sort-Object -CaseSensitive)
        if (($expected -join [char]0) -cne ($actual -join [char]0)) { throw 'Unexpected original ZIP entries' }
        foreach ($entry in $zip.Entries) {
          if ($entry.Length -gt 4294967296 -or ($entry.FullName.EndsWith('.json') -and $entry.Length -gt 131072)) { throw 'Oversized original entry' }
          $inputStream=$entry.Open(); $outputStream=[IO.File]::Open([IO.Path]::Combine($env:BODHI_ORIGINAL_DEST,$entry.FullName),[IO.FileMode]::CreateNew)
          try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
      } finally { $zip.Dispose() }`;
    execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...childEnv(),
      BODHI_ORIGINAL_ZIP: zip, BODHI_ORIGINAL_DEST: destination, BODHI_ORIGINAL_ENTRIES: JSON.stringify(entries) }, stdio: "pipe" });
    fs.unlinkSync(zip); return destination;
  }
  const actual = execFileSync("unzip", ["-Z1", zip], { env: childEnv(), encoding: "utf8", maxBuffer: 64 * 1024 }).trim().split(/\r?\n/);
  assert.deepEqual(actual.sort(), [...entries].sort(), "Artifact must contain only the original flat file set");
  for (const name of entries) {
    assert.match(name, /^[A-Za-z0-9_.-]+$/); const fd = fs.openSync(path.join(destination, name), "wx");
    try { execFileSync("unzip", ["-p", zip, name], { env: childEnv(), stdio: ["ignore", fd, "pipe"] }); }
    finally { fs.closeSync(fd); }
  }
  fs.unlinkSync(zip); return destination;
}
function hashFile(file) {
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Original output must be a regular file");
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), buffer = Buffer.alloc(1024 * 1024);
  try { for (let length; (length = fs.readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, length)); }
  finally { fs.closeSync(fd); } return hash.digest("hex");
}
function verifyReservation(value, ctx) {
  assert.match(ctx.controller || "", SHA);
  const contract = releaseContract(ctx);
  assert.equal(value.schemaVersion, contract.schemaVersion); assert.equal(value.kind, "bodhi-original-release");
  for (const key of ["repository", "version", "source", "controller", "runId"]) assert.equal(value[key], ctx[key], `Reservation ${key} differs`);
  assert.match(value.tree || "", SHA); assert.equal(value.admission.schemaVersion, admission.ADMISSION_SCHEMA);
  assert.equal(value.admission.kind, admission.ADMISSION_KIND);
  assert.equal(value.admission.repository, REPOSITORY); assert.equal(value.admission.source, ctx.source); assert.equal(value.admission.tree, value.tree);
  for (const key of ["base", "head", "snapshot", "observedDev", "currentDev"]) assert.match(value.admission[key] || "", SHA);
  for (const key of ["pullRequest", "runId", "attempt"]) id(value.admission[key]);
  if (contract === V2_CONTRACT) assert.ok([admission.CONTEXT_WORKFLOW_BLOB, admission.FEATURE_WORKFLOW_BLOB].includes(value.admission.workflowBlob),
    "Unreviewed feature producer");
  else assert.equal(value.admission.workflowBlob, ctx.v3FeatureWorkflowBlob, "V3 reservation differs from the reviewed feature workflow");
  const featureJobs = ["Unit Tests (Node)", "Unit Tests", "E2E Tests", ...contract.targets.map(target => `Unit and E2E (${target})`)];
  assert.deepEqual(value.admission.jobs.map(job => job.name).sort(), featureJobs.sort());
  assert.equal(new Set(value.admission.jobs.map(job => id(job.id))).size, featureJobs.length);
  assert.equal(new Set(value.admission.jobs.map(job => id(job.logical?.id))).size, featureJobs.length);
  for (const job of value.admission.jobs) {
    assert.ok(id(job.attempt) <= id(job.logical.attempt) && job.logical.attempt <= value.admission.attempt, "Feature physical/logical attempts are out of order");
    assert.equal(job.id === job.logical.id, job.attempt === job.logical.attempt, "Feature physical/logical identity differs within one attempt");
  }
  id(value.preflight.jobId); assert.ok(id(value.preflight.attempt) <= ctx.attempt);
  assert.equal(value.frontend.packageName, "@bigduu/lotus-next");
  assert.deepEqual(Object.keys(value.lockHashes).sort(), ["scripts/bamboo-sidecar-lock.json", "scripts/frontend-package-lock.json"]);
  for (const hash of Object.values(value.lockHashes)) assert.match(hash, /^[0-9a-f]{64}$/);
  return value;
}
function releaseReservation(release, ctx) {
  id(release.id); assert.equal(release.target_commitish, ctx.source); assert.equal(release.prerelease, false);
  assert.equal(release.url, `https://api.github.com/repos/${REPOSITORY}/releases/${release.id}`);
  assert.equal(typeof release.draft, "boolean"); assert.equal(release.tag_name, release.draft ? ctx.draftTag : ctx.finalTag);
  assert.ok(typeof release.body === "string" && Buffer.byteLength(release.body) <= 128 * 1024);
  return verifyReservation(JSON.parse(release.body), ctx);
}
function loadReservation(ctx, request = api, restore = download, options) {
  const matching = pages("releases", undefined, request).filter(release => release.tag_name === ctx.draftTag || release.tag_name === ctx.finalTag);
  assert.equal(matching.length, 1, "Reserved release missing or conflicting");
  const release = request(`releases/${id(matching[0].id)}`), reservation = releaseReservation(release, ctx);
  const rows = jobs(ctx, request, options), preflights = rows.filter(item => item.name === "Reserve admitted release");
  const job = preflights.find(item => item.id === reservation.preflight.jobId);
  assert.ok(job); assert.equal(job.name, "Reserve admitted release"); assert.equal(job.run_attempt, reservation.preflight.attempt);
  passed(job, [PREFLIGHT, RESERVATION]);
  const physical = admission.executionOrigin(job, preflights);
  assert.equal(physical.id, job.id, "Reservation must name the physical preflight job");
  const original = artifact(pages(`actions/runs/${ctx.runId}/artifacts`, "artifacts", request), ctx.reservationName, ctx, job);
  const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v2-admission-")), "original");
  restore(original, ["reservation.json"], directory);
  assert.deepEqual(readJson(path.join(directory, "reservation.json")), { releaseId: release.id, reservation }, "Original reservation bytes differ");
  assert.equal(request(`git/ref/heads/release/${ctx.source}`)?.object?.sha, ctx.source, "Frozen source moved");
  assert.equal(request(`git/commits/${ctx.source}`)?.tree?.sha, reservation.tree);
  return { release, reservation, artifact: original };
}
// Build jobs have read-only tokens, which cannot see a draft GitHub Release.
// Authenticate the retained original preflight instead; the write-authorized
// finalizer still checks the live draft against these exact bytes before publishing.
function loadBuildReservation(ctx, request = api, restore = download) {
  const all = pages(`actions/runs/${ctx.runId}/artifacts`, "artifacts", request);
  const candidate = artifactMetadata(all, ctx.reservationName, ctx, 1024 ** 2);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v2-build-admission-"));
  const directory = path.join(root, "original");
  try {
    restore(candidate, ["reservation.json"], directory);
    const value = readJson(path.join(directory, "reservation.json"));
    assert.deepEqual(Object.keys(value).sort(), ["releaseId", "reservation"]);
    assert.equal(value.releaseId, id(value.releaseId), "Original release ID must be numeric");
    const reservation = verifyReservation(value.reservation, ctx);
    const preflights = jobs(ctx, request).filter(item => item.name === "Reserve admitted release");
    const job = preflights.find(item => item.id === reservation.preflight.jobId);
    assert.ok(job); assert.equal(job.name, "Reserve admitted release"); assert.equal(job.run_attempt, reservation.preflight.attempt);
    passed(job, [PREFLIGHT, RESERVATION]);
    const physical = admission.executionOrigin(job, preflights);
    assert.equal(physical.id, job.id, "Reservation must name the physical preflight job");
    assert.equal(physical.run_attempt, job.run_attempt, "Reservation must name the physical preflight attempt");
    const original = artifact(all, ctx.reservationName, ctx, job);
    assert.equal(original.id, candidate.id);
    assert.equal(request(`git/ref/heads/release/${ctx.source}`)?.object?.sha, ctx.source, "Frozen source moved");
    assert.equal(request(`git/commits/${ctx.source}`)?.tree?.sha, reservation.tree);
    return { releaseId: value.releaseId, reservation, artifact: original };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function selectorOnlyFailure(job) {
  const failed = job.steps.filter(step => step.conclusion === "failure");
  return job.status === "completed" && job.conclusion === "failure" && failed.length === 1 && failed[0].name === "Select retained target output" && failed[0].status === "completed" &&
    [BUILD, CAPTURE, RETAIN].every(name => {
      const steps = job.steps.filter(step => step.name === name);
      return steps.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "skipped";
    });
}
function activeSelector(ctx, rows) {
  const current = rows.filter(job => job.run_attempt === ctx.attempt);
  if (current.length !== 1 || !Number.isSafeInteger(current[0].id) || current[0].id <= 0 || current[0].status !== "in_progress" || current[0].conclusion !== null) return false;
  const steps = current[0].steps.filter(step => step.name === "Select retained target output");
  return steps.length === 1 && steps[0].status === "in_progress" && steps[0].conclusion === null &&
    !current[0].steps.some(step => step.conclusion === "failure" || step.name === BUILD &&
      !(step.status === "completed" && step.conclusion === "skipped" || ["queued", "pending"].includes(step.status) && step.conclusion === null));
}
function selectTarget(ctx, reservation, target, request = api, restore = download, requireLatestSuccess = false) {
  const contract = releaseContract(ctx);
  assert.ok(contract.targets.includes(target), "Target is outside the selected release contract");
  const rows = jobs(ctx, request).filter(job => job.name === `Build original (${target})`);
  assert.equal(new Set(rows.map(job => job.run_attempt)).size, rows.length, "Ambiguous target job in one attempt");
  if (requireLatestSuccess) {
    const last = Math.max(...rows.map(job => job.run_attempt)), selected = rows.filter(job => job.run_attempt === last);
    assert.equal(selected.length, 1); passed(selected[0], ["Select retained target output"]);
  }
  const successfulBuilds = rows.filter(job => job.steps.some(step => step.name === BUILD && step.conclusion === "success"));
  const completed = rows.filter(job => job.status === "completed").sort((a, b) => b.run_attempt - a.run_attempt);
  const built = [];
  for (const job of successfulBuilds.sort((a, b) => a.run_attempt - b.run_attempt)) {
    const original = admission.executionOrigin(job, rows);
    if (!built.some(existing => existing.id === original.id)) built.push(original);
  }
  assert.ok(built.length <= 1, "Multiple physical builds for one reserved target");
  if (built.length) {
    for (const later of completed.filter(job => job.run_attempt > built[0].run_attempt)) {
      assert.ok(later.conclusion === "success" || selectorOnlyFailure(later), "A later real target failure cannot be hidden by retained output");
      assert.ok(!later.steps.some(step => step.name === BUILD && !["success", "skipped"].includes(step.conclusion)), "A later Build did not pass");
    }
    if (completed[0]?.conclusion === "failure" && !requireLatestSuccess && selectorOnlyFailure(completed[0])) {
      assert.ok(activeSelector(ctx, rows), "Only an active current selector may revalidate after a selector failure");
    } else passed(completed[0], ["Select retained target output"]);
  }
  const all = pages(`actions/runs/${ctx.runId}/artifacts`, "artifacts", request);
  const candidates = all.filter(value => value.name.startsWith(`bodhi-v${contract.schemaVersion}-target-${ctx.runId}-`) && value.name.endsWith(`-${target}`));
  if (!built.length) { assert.equal(candidates.length, 0, "Artifact without an original successful build"); return null; }
  const job = built[0]; passed(job, ["Verify source and stamp reserved version", BUILD, CAPTURE, RETAIN]);
  const original = artifact(all, artifactName(ctx, target, job.run_attempt), ctx, job);
  assert.equal(candidates.length, 1, "Conflicting original target outputs");
  const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v2-target-")), "original");
  restore(original, ["target-receipt.json", ...names(ctx.version, target)], directory);
  const receipt = readJson(path.join(directory, "target-receipt.json"));
  verifyReceipt(receipt, ctx, reservation, target, job);
  for (const file of receipt.files) {
    const actual = path.join(directory, file.name);
    assert.equal(fs.lstatSync(actual).size, file.size); assert.equal(hashFile(actual), file.sha256, "Original installer bytes differ");
  }
  return { receipt, artifact: { id: original.id, name: original.name, digest: original.digest }, directory };
}
function checks(target, schemaVersion = 2) {
  const values = ["locked-upstreams", "shell-architecture", "package-version", target.includes("darwin") ? "macos-signature" : "staged-runtime"];
  if (schemaVersion === 3 && !target.includes("darwin")) values.push("installer-payload");
  return values;
}
function verifyReceipt(receipt, ctx, reservation, target, job) {
  const contract = releaseContract(ctx);
  id(receipt.jobId); assert.ok(id(receipt.attempt) <= ctx.attempt);
  assert.ok(contract.targets.includes(target), "Target is outside the selected release contract");
  assert.equal(reservation.schemaVersion, contract.schemaVersion);
  assert.equal(receipt.schemaVersion, contract.schemaVersion); assert.equal(receipt.target, target);
  assert.equal(receipt.reservationSha256, sha256(bytes(reservation))); assert.equal(receipt.jobId, job.id);
  assert.equal(receipt.attempt, job.run_attempt); assert.deepEqual(receipt.checks, checks(target, contract.schemaVersion));
  assert.deepEqual(receipt.files.map(file => file.name).sort(), names(ctx.version, target).sort());
  for (const file of receipt.files) {
    assert.match(file.sha256 || "", /^[0-9a-f]{64}$/); assert.ok(Number.isSafeInteger(file.size) && file.size >= 1024 ** 2 && file.size <= 4 * 1024 ** 3);
  }
}
function stamped(cargo, configText, lock, version) {
  const config = JSON.parse(configText);
  assert.match(cargo, /^version = "0\.0\.0"$/m); assert.equal(config.version, "0.0.0");
  assert.match(lock, /\[\[package\]\]\nname = "bodhi"\nversion = "0\.0\.0"/);
  config.version = version;
  return { "src-tauri/Cargo.toml": cargo.replace(/^version = "0\.0\.0"$/m, `version = "${version}"`),
    "src-tauri/tauri.conf.json": bytes(config), "Cargo.lock": lock.replace(/(\[\[package\]\]\nname = "bodhi"\nversion = )"0\.0\.0"/, `$1"${version}"`) };
}
function stamp(root, version) {
  const files = ["src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "Cargo.lock"].map(file => fs.readFileSync(path.join(root, file), "utf8"));
  for (const [file, data] of Object.entries(stamped(...files, version))) fs.writeFileSync(path.join(root, file), data);
}
function verifyLinuxPackage(command, format, file, version, target) {
  const arch = linuxPackageArchitectures(target);
  let args, expected;
  if (format === "deb") {
    args = ["dpkg-deb", "-f", file, "Version", "Architecture"];
    expected = `Version: ${version}\nArchitecture: ${arch.deb}`;
  } else {
    assert.equal(format, "rpm");
    args = ["rpm", "-qp", "--queryformat", "%{VERSION}|%{RELEASE}|%{ARCH}", file];
    expected = `${version}|1|${arch.rpm}`;
  }
  const [program, ...parameters] = args;
  assert.equal(command(program, parameters), expected, `Original ${format} version or architecture differs`);
}
function staticOutputs(root, ctx, target, output) {
  const contract = releaseContract(ctx);
  assert.ok(contract.targets.includes(target), "Target is outside the selected release contract");
  const lotus = require("./lotus-dist.cjs"), assembly = require("./verify-assembly.cjs"), browser = require("./browser-runtime.cjs");
  const source = lotus.resolveSource({ LOTUS_SOURCE: "package", LOTUS_PACKAGE_NAME: "@bigduu/lotus-next" }, root);
  const receipt = lotus.verifyStaged(source, root);
  const sidecar = require("./bamboo-sidecar.cjs").installedRelease(root, target, { BAMBOO_SIDECAR_SOURCE: "release", BAMBOO_SIDECAR_TARGET: target });
  // Read immutable product data with controller code, never require a module from S.
  const runtimeLock = JSON.parse(execFileSync("git", ["show", `${ctx.source}:scripts/browser-runtime.lock.json`],
    { cwd: root, env: childEnv(), encoding: "utf8", maxBuffer: 128 * 1024 }));
  const browserRoot = path.join(root, "src-tauri/browser-runtime");
  browser.verifyRuntime(browserRoot, target, path.join(sidecar.hostDirectory, "browser-runtime"), runtimeLock);
  const base = path.join(root, "target", target, "release"), bundle = path.join(base, "bundle");
  const shell = path.join(base, target.includes("windows") ? "bodhi.exe" : "bodhi");
  browser.verifyArchitecture(shell, target);
  const command = (name, args) => execFileSync(name, args, { env: childEnv(), encoding: "utf8" }).trim();
  if (target.includes("darwin")) {
    assembly.verifyMacosBundle(root, target, receipt, undefined, runtimeLock);
    const app = path.join(bundle, "macos/Bodhi AI.app");
    assert.equal(command("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(app, "Contents/Info.plist")]), ctx.version);
    command("tar", ["-czf", path.join(bundle, "macos/Bodhi.AI_aarch64.app.tar.gz"), "-C", path.dirname(app), path.basename(app)]);
  }
  const directories = target.includes("darwin") ? ["dmg", "macos"] : target.includes("linux") ? ["appimage", "deb", "rpm"] : ["nsis"];
  const expected = names(ctx.version, target);
  const files = [];
  for (let index = 0; index < directories.length; index++) {
    const format = directories[index];
    const directory = path.join(bundle, format);
    const matches = fs.readdirSync(directory).filter(name => name.replaceAll(" ", ".") === expected[index]);
    assert.equal(matches.length, 1, `Missing original installer: ${expected[index]}`);
    const file = path.join(directory, matches[0]); hashFile(file);
    if (format === "deb" || format === "rpm") verifyLinuxPackage(command, format, file, ctx.version, target);
    if (contract.schemaVersion === 3 && !target.includes("darwin")) {
      const appDir = format === "appimage" ? path.join(directory, "Bodhi AI.AppDir") : undefined;
      require("./installer-payload.cjs").verifyInstallerPayload({ format, file, target, shell, sidecar: sidecar.binary,
        browserRoot, browserLock: runtimeLock, frontendReceipt: receipt, appDir }, childEnv());
    }
    files.push([file, expected[index]]);
  }
  if (target.includes("windows")) {
    const version = command("pwsh", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${shell.replaceAll("'", "''")}').VersionInfo.ProductVersion`]);
    assert.ok(version === ctx.version || version === `${ctx.version}.0`, "Shell PE version differs");
  }
  for (const [file, name] of files) fs.copyFileSync(file, path.join(output, name), fs.constants.COPYFILE_EXCL);
}
function outputs(values) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}
function captureTarget(root, ctx, reservation, target, output, request = api) {
  const contract = releaseContract(ctx);
  assert.ok(contract.targets.includes(target), "Target is outside the selected release contract");
  verifyReservation(reservation, ctx);
  assert.equal(git(root, "rev-parse", "HEAD"), ctx.source);
  const changed = git(root, "status", "--porcelain", "--untracked-files=all").split(/\r?\n/).filter(Boolean).map(line => line.slice(3)).sort();
  assert.deepEqual(changed, ["Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"))).version, ctx.version);
  const originals = ["src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "Cargo.lock"].map(file => execFileSync("git", ["show", `${ctx.source}:${file}`],
    { cwd: root, env: childEnv(), encoding: "utf8" }));
  for (const [file, expected] of Object.entries(stamped(...originals, ctx.version))) assert.ok(fs.readFileSync(path.join(root, file)).equals(Buffer.from(expected)), `Unexpected publishing edit: ${file}`);
  for (const [file, hash] of Object.entries(reservation.lockHashes)) assert.equal(sha256(fs.readFileSync(path.join(root, file))), hash);
  assert.ok(path.isAbsolute(output) && !fs.existsSync(output)); fs.mkdirSync(output, { recursive: true });
  staticOutputs(root, ctx, target, output);
  const job = currentJob(ctx, `Build original (${target})`, request); gate(job, BUILD);
  const receipt = { schemaVersion: contract.schemaVersion, target, reservationSha256: sha256(bytes(reservation)), jobId: job.id,
    attempt: ctx.attempt, checks: checks(target, contract.schemaVersion),
    files: names(ctx.version, target).map(name => ({ name, size: fs.lstatSync(path.join(output, name)).size, sha256: hashFile(path.join(output, name)) })) };
  verifyReceipt(receipt, ctx, reservation, target, job); write(path.join(output, "target-receipt.json"), receipt);
  return receipt;
}
function main() {
  const [command, target] = process.argv.slice(2), ctx = originalContext(context(), controller());
  run(ctx);
  const { reservation } = loadBuildReservation(ctx);
  if (command === "plan") {
    const existing = selectTarget(ctx, reservation, target);
    outputs({ reuse: Boolean(existing), artifact_name: artifactName(ctx, target, ctx.attempt),
      emergency_name: `bodhi-v${releaseContract(ctx).schemaVersion}-emergency-${ctx.runId}-${ctx.attempt}-${target}` }); return;
  }
  const root = process.env.SOURCE_ROOT;
  if (command === "prepare") {
    const product = admission.requireProduct(ctx.source, root); assert.deepEqual(product.lockHashes, reservation.lockHashes);
    stamp(root, ctx.version); return;
  }
  assert.equal(command, "capture");
  captureTarget(root, ctx, reservation, target, process.env.TARGET_OUTPUT);
}
module.exports = { ROOT, REPOSITORY, NATIVE_TARGETS, BUILD, CAPTURE, RETAIN, PREFLIGHT, RESERVATION, MANIFEST, SHA, DIGEST, bytes, sha256,
  ORIGINAL_RELEASE_WORKFLOW_BLOB, V2_RELEASE_WORKFLOW_BLOB, ARM64_RELEASE_WORKFLOW_BLOB,
  childEnv, api, pages, context, controller, workflow, originalContext, runIdentity, run, jobs, gate, passed, currentJob, readJson, write, names, artifactName, artifact, download, hashFile,
  releaseContract, releaseContext, releaseMatrix, verifyReservation, releaseReservation, loadReservation, loadBuildReservation, selectTarget, verifyReceipt, checks,
  stamped, stamp, verifyLinuxPackage, staticOutputs, captureTarget, outputs };
if (require.main === module) { try { main(); } catch (error) { console.error(`Original Bodhi output: ${error.message}`); process.exitCode = 1; } }
