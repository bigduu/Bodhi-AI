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
function context(env = process.env) {
  const ctx = legacy.context(env);
  return { ...ctx, controller: env.GITHUB_WORKFLOW_SHA,
    draftTag: `bodhi-v2-draft-v${ctx.version}-${ctx.runId}`,
    reservationName: `bodhi-v2-reservation-${ctx.runId}`, evidenceName: `bodhi-v2-evidence-${ctx.runId}-${ctx.attempt}` };
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
function run(ctx, request = api, recovery = false) {
  const value = request(`actions/runs/${ctx.runId}`);
  assert.equal(value?.id, ctx.runId); assert.equal(value.repository.full_name, REPOSITORY);
  assert.equal(value.run_attempt, ctx.attempt, "Release attempt changed");
  assert.equal(value.event, "workflow_dispatch"); assert.equal(workflow(value.path), ".github/workflows/release.yml");
  assert.equal(value.head_branch, "main"); assert.match(value.head_sha || "", SHA);
  if (ctx.controller) assert.equal(value.head_sha, ctx.controller, "Original controller differs");
  assert.equal(value.display_title, `Bodhi v2 v${ctx.version} @ ${ctx.source}`);
  assert.equal(value.status, recovery ? "completed" : "in_progress");
  assert.equal(value.conclusion, recovery ? "failure" : null);
  return value;
}
function jobs(ctx, request = api) {
  const rows = pages(`actions/runs/${ctx.runId}/jobs?filter=all`, "jobs", request);
  const names = ["Reserve admitted release", "Publish original release", ...NATIVE_TARGETS.map(target => `Build original (${target})`)];
  assert.equal(new Set(rows.map(job => job.id)).size, rows.length);
  for (const job of rows) {
    assert.ok(names.includes(job.name), "Foreign release job"); assert.equal(job.run_id, ctx.runId);
    assert.equal(job.head_sha, ctx.controller); assert.ok(id(job.run_attempt) <= ctx.attempt, "Future job attempt");
  }
  return rows;
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
function names(version, target) {
  assert.ok(NATIVE_TARGETS.includes(target));
  if (target.includes("darwin")) return [`Bodhi.AI_${version}_aarch64.dmg`, "Bodhi.AI_aarch64.app.tar.gz"];
  if (target.includes("linux")) return [`Bodhi.AI_${version}_amd64.AppImage`, `Bodhi.AI_${version}_amd64.deb`, `Bodhi.AI-${version}-1.x86_64.rpm`];
  return [`Bodhi.AI_${version}_x64-setup.exe`];
}
function artifactName(ctx, target, attempt) { return `bodhi-v2-target-${ctx.runId}-${id(attempt)}-${target}`; }
function artifact(artifacts, name, ctx, job, active = false) {
  const matches = artifacts.filter(value => value.name === name); assert.equal(matches.length, 1, `Original artifact missing or ambiguous: ${name}`);
  const value = matches[0]; id(value.id); assert.equal(value.expired, false, "Original artifact expired");
  assert.match(value.digest || "", DIGEST, "Immutable artifact digest required");
  assert.ok(Number.isSafeInteger(value.size_in_bytes) && value.size_in_bytes > 0 && value.size_in_bytes <= 8 * 1024 ** 3);
  assert.equal(value.workflow_run.id, ctx.runId); assert.equal(value.workflow_run.head_sha, ctx.controller);
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
  assert.equal(value.schemaVersion, 2); assert.equal(value.kind, "bodhi-original-release");
  for (const key of ["repository", "version", "source", "controller", "runId"]) assert.equal(value[key], ctx[key], `Reservation ${key} differs`);
  assert.match(value.tree || "", SHA); assert.equal(value.admission.schemaVersion, 1);
  assert.equal(value.admission.repository, REPOSITORY); assert.equal(value.admission.source, ctx.source); assert.equal(value.admission.tree, value.tree);
  for (const key of ["base", "head", "snapshot", "observedDev", "currentDev"]) assert.match(value.admission[key] || "", SHA);
  for (const key of ["pullRequest", "runId", "attempt"]) id(value.admission[key]);
  assert.equal(value.admission.workflowBlob, admission.FEATURE_WORKFLOW_BLOB);
  assert.deepEqual(value.admission.jobs.map(job => job.name).sort(), ["Unit Tests (Node)", "Unit Tests", "E2E Tests", ...NATIVE_TARGETS.map(target => `Unit and E2E (${target})`)].sort());
  assert.equal(new Set(value.admission.jobs.map(job => id(job.id))).size, 6);
  assert.equal(new Set(value.admission.jobs.map(job => id(job.logical?.id))).size, 6);
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
function loadReservation(ctx, request = api, restore = download) {
  const matching = pages("releases", undefined, request).filter(release => release.tag_name === ctx.draftTag || release.tag_name === ctx.finalTag);
  assert.equal(matching.length, 1, "Reserved release missing or conflicting");
  const release = request(`releases/${id(matching[0].id)}`), reservation = releaseReservation(release, ctx);
  const job = jobs(ctx, request).find(item => item.id === reservation.preflight.jobId);
  assert.ok(job); assert.equal(job.name, "Reserve admitted release"); assert.equal(job.run_attempt, reservation.preflight.attempt);
  passed(job, [PREFLIGHT, RESERVATION]);
  const original = artifact(pages(`actions/runs/${ctx.runId}/artifacts`, "artifacts", request), ctx.reservationName, ctx, job);
  const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v2-admission-")), "original");
  restore(original, ["reservation.json"], directory);
  assert.deepEqual(readJson(path.join(directory, "reservation.json")), { releaseId: release.id, reservation }, "Original reservation bytes differ");
  assert.equal(request(`git/ref/heads/release/${ctx.source}`)?.object?.sha, ctx.source, "Frozen source moved");
  assert.equal(request(`git/commits/${ctx.source}`)?.tree?.sha, reservation.tree);
  return { release, reservation, artifact: original };
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
  assert.ok(NATIVE_TARGETS.includes(target)); const rows = jobs(ctx, request).filter(job => job.name === `Build original (${target})`);
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
  const candidates = all.filter(value => value.name.startsWith(`bodhi-v2-target-${ctx.runId}-`) && value.name.endsWith(`-${target}`));
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
function checks(target) { return ["locked-upstreams", "shell-architecture", "package-version", target.includes("darwin") ? "macos-signature" : "staged-runtime"]; }
function verifyReceipt(receipt, ctx, reservation, target, job) {
  id(receipt.jobId); assert.ok(id(receipt.attempt) <= ctx.attempt); assert.ok(NATIVE_TARGETS.includes(target));
  assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.target, target);
  assert.equal(receipt.reservationSha256, sha256(bytes(reservation))); assert.equal(receipt.jobId, job.id);
  assert.equal(receipt.attempt, job.run_attempt); assert.deepEqual(receipt.checks, checks(target));
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
function staticOutputs(root, ctx, target, output) {
  const lotus = require("./lotus-dist.cjs"), assembly = require("./verify-assembly.cjs"), browser = require("./browser-runtime.cjs");
  const source = lotus.resolveSource({ LOTUS_SOURCE: "package", LOTUS_PACKAGE_NAME: "@bigduu/lotus-next" }, root);
  const receipt = lotus.verifyStaged(source, root);
  const sidecar = require("./bamboo-sidecar.cjs").installedRelease(root, target, { BAMBOO_SIDECAR_SOURCE: "release", BAMBOO_SIDECAR_TARGET: target });
  // Read immutable product data with controller code, never require a module from S.
  const runtimeLock = JSON.parse(execFileSync("git", ["show", `${ctx.source}:scripts/browser-runtime.lock.json`],
    { cwd: root, env: childEnv(), encoding: "utf8", maxBuffer: 128 * 1024 }));
  browser.verifyRuntime(path.join(root, "src-tauri/browser-runtime"), target, sidecar.hostDirectory, runtimeLock);
  const base = path.join(root, "target", target, "release"), bundle = path.join(base, "bundle");
  browser.verifyArchitecture(path.join(base, target.includes("windows") ? "bodhi.exe" : "bodhi"), target);
  const command = (name, args) => execFileSync(name, args, { env: childEnv(), encoding: "utf8" }).trim();
  if (target.includes("darwin")) {
    assembly.verifyMacosBundle(root, target, receipt, undefined, runtimeLock);
    const app = path.join(bundle, "macos/Bodhi AI.app");
    assert.equal(command("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(app, "Contents/Info.plist")]), ctx.version);
    command("tar", ["-czf", path.join(bundle, "macos/Bodhi.AI_aarch64.app.tar.gz"), "-C", path.dirname(app), path.basename(app)]);
  }
  const directories = target.includes("darwin") ? ["dmg", "macos"] : target.includes("linux") ? ["appimage", "deb", "rpm"] : ["nsis"];
  const expected = names(ctx.version, target);
  for (let index = 0; index < directories.length; index++) {
    const directory = path.join(bundle, directories[index]);
    const matches = fs.readdirSync(directory).filter(name => name.replaceAll(" ", ".") === expected[index]);
    assert.equal(matches.length, 1, `Missing original installer: ${expected[index]}`);
    const file = path.join(directory, matches[0]); hashFile(file); fs.copyFileSync(file, path.join(output, expected[index]), fs.constants.COPYFILE_EXCL);
    if (directories[index] === "deb") assert.equal(command("dpkg-deb", ["-f", file, "Version", "Architecture"]), `Version: ${ctx.version}\nArchitecture: amd64`);
    if (directories[index] === "rpm") assert.equal(command("rpm", ["-qp", "--queryformat", "%{VERSION}|%{RELEASE}|%{ARCH}", file]), `${ctx.version}|1|x86_64`);
  }
  if (target.includes("windows")) {
    const binary = path.join(base, "bodhi.exe");
    const version = command("pwsh", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${binary.replaceAll("'", "''")}').VersionInfo.ProductVersion`]);
    assert.ok(version === ctx.version || version === `${ctx.version}.0`, "Shell PE version differs");
  }
}
function outputs(values) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}
function main() {
  const [command, target] = process.argv.slice(2), ctx = context();
  controller(); run(ctx);
  const { reservation } = loadReservation(ctx);
  if (command === "plan") {
    const existing = selectTarget(ctx, reservation, target);
    outputs({ reuse: Boolean(existing), artifact_name: artifactName(ctx, target, ctx.attempt) }); return;
  }
  const root = process.env.SOURCE_ROOT;
  if (command === "prepare") {
    const product = admission.requireProduct(ctx.source, root); assert.deepEqual(product.lockHashes, reservation.lockHashes);
    stamp(root, ctx.version); return;
  }
  assert.equal(command, "capture"); assert.ok(NATIVE_TARGETS.includes(target));
  assert.equal(git(root, "rev-parse", "HEAD"), ctx.source);
  const changed = git(root, "status", "--porcelain", "--untracked-files=all").split(/\r?\n/).filter(Boolean).map(line => line.slice(3)).sort();
  assert.deepEqual(changed, ["Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"))).version, ctx.version);
  const originals = ["src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "Cargo.lock"].map(file => execFileSync("git", ["show", `${ctx.source}:${file}`],
    { cwd: root, env: childEnv(), encoding: "utf8" }));
  for (const [file, expected] of Object.entries(stamped(...originals, ctx.version))) assert.ok(fs.readFileSync(path.join(root, file)).equals(Buffer.from(expected)), `Unexpected publishing edit: ${file}`);
  for (const [file, hash] of Object.entries(reservation.lockHashes)) assert.equal(sha256(fs.readFileSync(path.join(root, file))), hash);
  const output = process.env.TARGET_OUTPUT; assert.ok(path.isAbsolute(output) && !fs.existsSync(output)); fs.mkdirSync(output, { recursive: true });
  staticOutputs(root, ctx, target, output);
  const job = currentJob(ctx, `Build original (${target})`); gate(job, BUILD);
  const receipt = { schemaVersion: 2, target, reservationSha256: sha256(bytes(reservation)), jobId: job.id, attempt: ctx.attempt, checks: checks(target),
    files: names(ctx.version, target).map(name => ({ name, size: fs.lstatSync(path.join(output, name)).size, sha256: hashFile(path.join(output, name)) })) };
  verifyReceipt(receipt, ctx, reservation, target, job); write(path.join(output, "target-receipt.json"), receipt);
}
module.exports = { ROOT, REPOSITORY, NATIVE_TARGETS, BUILD, CAPTURE, RETAIN, PREFLIGHT, RESERVATION, MANIFEST, SHA, DIGEST, bytes, sha256,
  childEnv, api, pages, context, controller, run, jobs, gate, passed, currentJob, readJson, write, names, artifactName, artifact, download, hashFile,
  verifyReservation, releaseReservation, loadReservation, selectTarget, verifyReceipt, checks, stamped, stamp, staticOutputs, outputs };
if (require.main === module) { try { main(); } catch (error) { console.error(`Original Bodhi output: ${error.message}`); process.exitCode = 1; } }
