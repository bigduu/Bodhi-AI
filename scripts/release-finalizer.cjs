#!/usr/bin/env node
"use strict";

// Bodhi owns its release identity, original build evidence and publication.
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { readLock } = require("./bamboo-sidecar.cjs");
const { readArtifactLock } = require("./lotus-next-artifact.cjs");

const NATIVE_TARGETS = Object.freeze(["aarch64-apple-darwin", "x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc"]);
const REPOSITORY = "bigduu/Bodhi-AI";
const ROOT = path.resolve(__dirname, "..");
const WORKFLOW = ".github/workflows/release.yml";
const NATIVE_GATES = ["Require the exact accepted release source", "Set Bodhi app version (workflow override)",
  "Build Tauri app", "Verify exact frontend and real target sidecar", "Smoke native bundled sidecar actor transport",
  "Smoke bundled browser host", "Upload Build Artifacts to Workflow"];
const FINALIZER_GATES = ["Require the exact accepted release source", "Verify original release assets", "Retain original release evidence"];
const assetIdentity = (release) => release.assets.map(({ id, name, size, digest, state }) => ({ id, name, size, digest, state }))
  .sort((a, b) => a.name.localeCompare(b.name));

function positiveId(value, label) {
  assert.match(String(value), /^[1-9][0-9]*$/, `Invalid ${label}`);
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number), `Invalid ${label}`);
  return number;
}

function context(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  const version = env.RELEASE_VERSION;
  assert.match(version || "", /^[1-9][0-9]{3}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*$/, "Use an explicit YYYY.M.N Bodhi version; placeholders and latest are forbidden");
  assert.ok(Number(version.split(".")[2]) <= 65535, "Bodhi version counter must fit the Windows installer version");
  const source = env.EXPECTED_SOURCE_SHA;
  assert.match(source || "", /^[0-9a-f]{40}$/, "Use the full exact Bodhi source SHA");
  const runId = positiveId(env.ORIGINAL_RELEASE_RUN_ID || env.GITHUB_RUN_ID, "release run ID");
  const attempt = positiveId(env.ORIGINAL_RELEASE_ATTEMPT || env.GITHUB_RUN_ATTEMPT, "release attempt");
  return { repository: REPOSITORY, version, source, runId, attempt,
    draftTag: `bodhi-draft-v${version}-${runId}-${attempt}`, finalTag: `app-v${version}`,
    evidenceName: `bodhi-release-evidence-${runId}-${attempt}` };
}

function requireSource(ctx, env = process.env, root = ROOT) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  assert.equal(env.GITHUB_SHA, ctx.source, "Selected workflow source must equal expected_source_sha");
  assert.equal(git("rev-parse", "HEAD"), ctx.source, "Checkout must equal expected_source_sha");
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "", "Release source must be clean before stamping");
  readLock(root, env);
  return readArtifactLock(path.join(root, "scripts/frontend-package-lock.json"));
}

function api(endpoint, method = "GET", body) {
  const args = ["api", `repos/${REPOSITORY}/${endpoint}`, "--method", method];
  if (body) args.push("--input", "-");
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    input: body && JSON.stringify(body) });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // Only an explicit 404 is absence. Auth, transport and server failures stop.
    if (method === "GET" && /HTTP 404\b/.test(result.stderr)) return null;
    throw new Error(`GitHub ${method} ${endpoint} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

function list(endpoint, request = api, key) {
  const rows = [];
  for (let page = 1; ; page++) {
    const result = request(`${endpoint}?per_page=100&page=${page}`);
    const items = key ? result?.[key] : result;
    assert.ok(Array.isArray(items), `Cannot read ${endpoint}`);
    rows.push(...items);
    if (items.length < 100) return rows;
  }
}

function requireUnused(ctx, request = api, allowedId) {
  const matches = list("releases", request).filter((release) => release.tag_name === ctx.finalTag);
  assert.ok(matches.every((release) => release.id === allowedId), "Refusing a different existing final release, including a draft");
  assert.ok(matches.length <= (allowedId ? 1 : 0), "Ambiguous final release");
  if (!allowedId) assert.equal(request(`git/ref/tags/${ctx.finalTag}`), null, "Refusing an existing final tag");
}

function workflowFile(runPath) {
  assert.equal(typeof runPath, "string", "Missing original workflow path");
  const separator = runPath.indexOf("@");
  if (separator !== -1) assert.match(runPath.slice(separator + 1), /^\S+$/, "Invalid qualified workflow ref");
  const file = separator === -1 ? runPath : runPath.slice(0, separator);
  const ownPrefix = `${REPOSITORY}/`;
  return file.startsWith(ownPrefix) ? file.slice(ownPrefix.length) : file;
}

function verifyBuild(run, jobs, ctx, recovery = false) {
  assert.equal(run?.id, ctx.runId);
  assert.equal(run.run_attempt, ctx.attempt, "Use the original build attempt");
  assert.equal(run.repository.full_name, REPOSITORY);
  assert.equal(workflowFile(run.path), WORKFLOW);
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.head_sha, ctx.source);
  assert.equal(run.display_title, `Bodhi v${ctx.version} @ ${ctx.source}`, "Original run must bind the requested version and source");
  assert.equal(run.status, recovery ? "completed" : "in_progress");
  assert.equal(run.conclusion, recovery ? "failure" : null, "Recovery requires a failed finalizer, not a failed native build");
  assert.equal(jobs.length, NATIVE_TARGETS.length + 2, "Require preflight, all three supported native targets and one finalizer");
  function jobNamed(name, conclusion) {
    const matches = jobs.filter((job) => job.name === name);
    assert.equal(matches.length, 1, `Missing or ambiguous job: ${name}`);
    const job = matches[0];
    assert.equal(job.head_sha, ctx.source);
    assert.equal(job.run_attempt, ctx.attempt);
    assert.equal(job.conclusion, conclusion, `Job did not pass: ${name}`);
    assert.equal(job.status, conclusion === null ? "in_progress" : "completed");
    return job;
  }
  function passed(job, names) {
    for (const name of names) {
      const steps = job.steps.filter((step) => step.name === name);
      assert.equal(steps.length, 1, `Missing or ambiguous gate: ${name}`);
      assert.equal(steps[0].conclusion, "success", `Gate did not pass: ${name}`);
    }
  }
  passed(jobNamed("Validate independent release", "success"), ["Validate source, locked inputs and unused version"]);
  for (const target of NATIVE_TARGETS) passed(jobNamed(`Build Bodhi (${target})`, "success"), NATIVE_GATES);
  const finalizer = jobNamed("Publish fully verified release", recovery ? "failure" : null);
  if (recovery) {
    passed(finalizer, FINALIZER_GATES);
    assert.deepEqual(finalizer.steps.filter((step) => step.conclusion === "failure").map((step) => step.name),
      ["Publish the completed draft"], "Recovery only retries publication after evidence was retained");
  }
}

function readBuild(ctx, request = api, recovery = false) {
  const prefix = `actions/runs/${ctx.runId}/attempts/${ctx.attempt}`;
  const run = request(prefix);
  const result = request(`${prefix}/jobs?per_page=100`);
  assert.ok(run && result && result.total_count === result.jobs?.length, "Incomplete original attempt evidence");
  verifyBuild(run, result.jobs, ctx, recovery);
}

function expectedNames(version) {
  return [`Bodhi.AI-${version}-1.x86_64.rpm`, `Bodhi.AI_${version}_aarch64.dmg`, `Bodhi.AI_${version}_amd64.AppImage`,
    `Bodhi.AI_${version}_amd64.deb`, `Bodhi.AI_${version}_x64-setup.exe`,
    "Bodhi.AI_aarch64.app.tar.gz"].sort();
}

function verifyRelease(release, ctx, releaseId, published = false) {
  assert.equal(release?.id, releaseId);
  assert.equal(release.url, `https://api.github.com/repos/${REPOSITORY}/releases/${releaseId}`);
  assert.equal(release.draft, !published);
  assert.equal(release.prerelease, false);
  assert.equal(release.tag_name, published ? ctx.finalTag : ctx.draftTag);
  assert.equal(release.target_commitish, ctx.source, "Release must bind the exact Bodhi source");
  assert.deepEqual(release.assets.map((asset) => asset.name).sort(), expectedNames(ctx.version), "All six original supported-platform assets are required");
  assert.equal(new Set(release.assets.map((asset) => asset.id)).size, expectedNames(ctx.version).length);
  const prefixes = new Set();
  for (const asset of release.assets) {
    positiveId(asset.id, "asset ID");
    assert.equal(asset.state, "uploaded");
    assert.ok(Number.isSafeInteger(asset.size) && asset.size >= 1024 * 1024);
    assert.match(asset.digest || "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(asset.url, `https://api.github.com/repos/${REPOSITORY}/releases/assets/${asset.id}`);
    const download = new URL(asset.browser_download_url);
    assert.equal(download.origin, "https://github.com");
    assert.equal(download.search + download.hash, "");
    const prefix = `/${REPOSITORY}/releases/download/`;
    assert.ok(download.pathname.startsWith(prefix) && download.pathname.endsWith(`/${asset.name}`));
    const tag = download.pathname.slice(prefix.length, -(asset.name.length + 1));
    assert.ok(published ? tag === ctx.finalTag : tag === ctx.draftTag || /^untagged-[0-9a-f]+$/.test(tag));
    prefixes.add(tag);
  }
  assert.equal(prefixes.size, 1, "Assets must share one original GitHub download prefix");
}

function verifyEvidence(evidence, ctx) {
  assert.equal(evidence?.schemaVersion, 1);
  for (const key of ["repository", "version", "source", "runId", "attempt", "draftTag"]) assert.equal(evidence[key], ctx[key], `Original evidence differs: ${key}`);
  positiveId(evidence.releaseId, "release ID");
  assert.deepEqual(evidence.assets.map((asset) => asset.name).sort(), expectedNames(ctx.version));
  assert.equal(new Set(evidence.assets.map((asset) => asset.id)).size, expectedNames(ctx.version).length);
}

function snapshot(ctx, request = api) {
  readBuild(ctx, request);
  requireUnused(ctx, request);
  const matches = list("releases", request).filter((release) => release.tag_name === ctx.draftTag);
  assert.equal(matches.length, 1, "Require one original run/attempt draft");
  const releaseId = positiveId(matches[0].id, "release ID");
  const release = request(`releases/${releaseId}`);
  verifyRelease(release, ctx, releaseId);
  return { schemaVersion: 1, repository: REPOSITORY, version: ctx.version, source: ctx.source, runId: ctx.runId,
    attempt: ctx.attempt, draftTag: ctx.draftTag, releaseId, assets: assetIdentity(release) };
}

function requireFinalTag(ctx, request) {
  let object = request(`git/ref/tags/${ctx.finalTag}`)?.object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++) object = request(`git/tags/${object.sha}`)?.object;
  assert.equal(object?.type, "commit", "Published tag must resolve to a commit");
  assert.equal(object.sha, ctx.source, "Published tag must resolve to the original source");
}

function publish(ctx, evidence, request = api) {
  verifyEvidence(evidence, ctx);
  const endpoint = `releases/${evidence.releaseId}`;
  const checkPublished = (release) => {
    verifyRelease(release, ctx, evidence.releaseId, true);
    assert.deepEqual(assetIdentity(release), evidence.assets, "Preserve every original asset ID, size and digest");
    requireUnused(ctx, request, evidence.releaseId);
    requireFinalTag(ctx, request);
    return release;
  };
  const release = request(endpoint);
  if (release?.draft === false) return checkPublished(release); // Idempotent recovery of this exact publication only.
  requireUnused(ctx, request);
  verifyRelease(release, ctx, evidence.releaseId);
  assert.deepEqual(assetIdentity(release), evidence.assets, "Original draft assets changed after verification");
  const fresh = request(endpoint);
  verifyRelease(fresh, ctx, evidence.releaseId);
  assert.deepEqual(assetIdentity(fresh), evidence.assets, "Original draft assets changed immediately before publication");
  requireUnused(ctx, request);
  let patchError;
  try {
    request(endpoint, "PATCH", { tag_name: ctx.finalTag, target_commitish: ctx.source, name: `App v${ctx.version}`,
      draft: false, prerelease: false, make_latest: "true" });
  } catch (error) { patchError = error; }
  // A transport failure may happen after GitHub commits PATCH. Never blindly
  // repeat it: read the same ID, original asset identities and final tag back.
  try { return checkPublished(request(endpoint)); }
  catch (error) {
    throw new Error(`Publication could not be confirmed. Recover the original run/attempt; do not rebuild or substitute assets. ${patchError?.message || error.message}`, { cause: error });
  }
}

function recoveryArtifact(ctx, request = api) {
  readBuild(ctx, request, true);
  const matches = list(`actions/runs/${ctx.runId}/artifacts`, request, "artifacts")
    .filter((artifact) => artifact.name === ctx.evidenceName);
  assert.equal(matches.length, 1, "Original attempt evidence is missing or ambiguous");
  const artifact = matches[0];
  positiveId(artifact.id, "evidence artifact ID");
  assert.equal(artifact.expired, false, "Original evidence expired; recovery is forbidden");
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128 * 1024);
  assert.equal(artifact.workflow_run.id, ctx.runId);
  assert.equal(artifact.workflow_run.head_sha, ctx.source);
  return artifact.id;
}

function output(values) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function main() {
  const [command, evidenceFile] = process.argv.slice(2);
  assert.ok(["preflight", "identity", "verify", "publish", "check-recovery", "recover"].includes(command), "Unknown release command");
  const ctx = context();
  if (["preflight", "identity"].includes(command)) {
    const frontend = requireSource(ctx);
    if (command === "preflight") requireUnused(ctx);
    output({ version: ctx.version, frontend_package: frontend.packageName, frontend_version: frontend.packageVersion });
    return;
  }
  if (["check-recovery", "recover"].includes(command)) {
    positiveId(process.env.ORIGINAL_RELEASE_RUN_ID, "original release run ID");
    positiveId(process.env.ORIGINAL_RELEASE_ATTEMPT, "original release attempt");
    const artifactId = recoveryArtifact(ctx);
    if (command === "check-recovery") { output({ artifact_id: artifactId }); return; }
    assert.equal(positiveId(process.env.ORIGINAL_EVIDENCE_ARTIFACT_ID, "downloaded evidence artifact ID"), artifactId);
  } else {
    assert.equal(ctx.runId, positiveId(process.env.GITHUB_RUN_ID, "current release run"));
    assert.equal(ctx.attempt, positiveId(process.env.GITHUB_RUN_ATTEMPT, "current release attempt"));
  }
  assert.ok(evidenceFile, "An attempt-scoped evidence file is required");
  if (command === "verify") {
    fs.writeFileSync(evidenceFile, `${JSON.stringify(snapshot(ctx), null, 2)}\n`, { flag: "wx" });
    return;
  }
  const stat = fs.lstatSync(evidenceFile);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024, "Evidence must be a bounded regular JSON file");
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
  const published = publish(ctx, evidence);
  console.log(`Verified original Bodhi release ${published.id}: ${published.html_url}`);
}

module.exports = { REPOSITORY, NATIVE_TARGETS, NATIVE_GATES, FINALIZER_GATES, context, requireSource, api, requireUnused,
  verifyBuild, verifyRelease, verifyEvidence, assetIdentity, snapshot, publish, recoveryArtifact };
if (require.main === module) {
  try { main(); } catch (error) { console.error(`Bodhi release: ${error.message}`); process.exitCode = 1; }
}
