#!/usr/bin/env node
"use strict";

// Publication and recovery consume original installer bytes. No product code runs here.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const legacy = require("./release-finalizer.cjs");
const source = require("./release-source.cjs");
const out = require("./release-output.cjs");
const { REPOSITORY, NATIVE_TARGETS, MANIFEST, api, pages, bytes, sha256, readJson, write } = out;
const ASSEMBLE = "Verify original target receipts and upload assets";
const EVIDENCE = "Retain original publication evidence";
const PUBLISH = "Publish the original draft";
const assetIdentity = asset => ({ id: asset.id, name: asset.name, size: asset.size, digest: asset.digest, state: asset.state });
const identities = release => release.assets.map(assetIdentity).sort((a, b) => a.name.localeCompare(b.name));
function available(ctx, request = api, allowed) {
  legacy.requireUnused(ctx, request, allowed?.id);
  const reservations = pages("releases", undefined, request).filter(release => release.tag_name === ctx.finalTag ||
    release.tag_name.startsWith(`bodhi-draft-v${ctx.version}-`) || release.tag_name.startsWith(`bodhi-v2-draft-v${ctx.version}-`));
  assert.ok(reservations.every(release => release.id === allowed?.id), "Version is reserved by another release/run");
  const tag = request(`git/ref/tags/${ctx.finalTag}`);
  if (tag) assert.ok(allowed?.draft === false && tag.object.type === "commit" && tag.object.sha === ctx.source, "Final tag is occupied or changed");
}
function reserve(ctx, product, proof, request = api) {
  const releases = pages("releases", undefined, request);
  assert.ok(!releases.some(release => release.tag_name === ctx.draftTag), "Use the authenticated original reservation on a rerun");
  available(ctx, request);
  const job = out.currentJob(ctx, "Reserve admitted release", request);
  const reservation = out.verifyReservation({ schemaVersion: 2, kind: "bodhi-original-release", repository: REPOSITORY,
    version: ctx.version, source: ctx.source, tree: proof.tree, controller: ctx.controller, runId: ctx.runId,
    preflight: { jobId: job.id, attempt: ctx.attempt }, admission: proof, lockHashes: product.lockHashes, frontend: product.frontend }, ctx);
  const body = { tag_name: ctx.draftTag, target_commitish: ctx.source, name: `App v${ctx.version}`, body: JSON.stringify(reservation),
    draft: true, prerelease: false, make_latest: "false" };
  let created, failure;
  try { created = request("releases", "POST", body); } catch (error) { failure = error; }
  // Resolve a lost create response by identity. Never blindly create another reservation.
  const matches = pages("releases", undefined, request).filter(release => release.tag_name === ctx.draftTag);
  if (matches.length !== 1) throw failure || new Error("Version reservation was not retained");
  const release = request(`releases/${matches[0].id}`);
  if (created) assert.equal(release.id, created.id);
  assert.deepEqual(out.releaseReservation(release, ctx), reservation); assert.equal(release.draft, true);
  assert.deepEqual(release.assets, []); available(ctx, request, release);
  return { releaseId: release.id, reservation };
}
function originalRun(ctx, request = api, recovery = false) {
  const value = out.run({ ...ctx, controller: recovery ? undefined : ctx.controller }, request, recovery);
  return { ...ctx, controller: value.head_sha };
}
function validateAsset(asset, ctx) {
  assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0); assert.equal(asset.state, "uploaded");
  assert.match(asset.digest || "", out.DIGEST); assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
  assert.equal(asset.url, `https://api.github.com/repos/${REPOSITORY}/releases/assets/${asset.id}`);
  const prefix = `https://github.com/${REPOSITORY}/releases/download/`;
  assert.ok(asset.browser_download_url.startsWith(prefix));
  const tail = asset.browser_download_url.slice(prefix.length).split("/");
  assert.equal(tail.length, 2); assert.ok([ctx.draftTag, ctx.finalTag].includes(decodeURIComponent(tail[0])) || /^untagged-[A-Za-z0-9]+$/.test(tail[0]));
  assert.equal(decodeURIComponent(tail[1]), asset.name);
}
function nativeAssets(release, ctx) {
  const assets = release.assets.filter(asset => asset.name !== MANIFEST);
  legacy.verifyRelease({ ...release, assets }, ctx, release.id, !release.draft);
  return assets.map(assetIdentity).sort((a, b) => a.name.localeCompare(b.name));
}
function verifyManifest(manifest, ctx, release) {
  assert.equal(manifest.schemaVersion, 2); assert.equal(manifest.kind, "bodhi-original-installers");
  assert.equal(manifest.releaseId, release.id); out.verifyReservation(manifest.reservation, ctx);
  assert.deepEqual(out.releaseReservation(release, ctx), manifest.reservation, "Release reservation changed");
  assert.equal(manifest.reservationArtifact.name, ctx.reservationName); assert.ok(Number.isSafeInteger(manifest.reservationArtifact.id) && manifest.reservationArtifact.id > 0);
  assert.match(manifest.reservationArtifact.digest || "", out.DIGEST);
  assert.equal(manifest.finalizer.attempt, ctx.attempt); assert.ok(Number.isSafeInteger(manifest.finalizer.jobId) && manifest.finalizer.jobId > 0);
  assert.deepEqual(manifest.targets.map(target => target.receipt.target).sort(), [...NATIVE_TARGETS].sort());
  const fileNames = new Set();
  for (const target of manifest.targets) {
    const { receipt, artifact } = target;
    out.verifyReceipt(receipt, ctx, manifest.reservation, receipt.target, { id: receipt.jobId, run_attempt: receipt.attempt });
    assert.equal(artifact.name, out.artifactName(ctx, receipt.target, receipt.attempt));
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0); assert.match(artifact.digest || "", out.DIGEST);
    for (const file of receipt.files) {
      assert.ok(!fileNames.has(file.name)); fileNames.add(file.name);
      const matches = manifest.assets.filter(asset => asset.name === file.name); assert.equal(matches.length, 1);
      assert.equal(matches[0].size, file.size); assert.equal(matches[0].digest, `sha256:${file.sha256}`);
    }
  }
  assert.equal(new Set(manifest.targets.map(target => target.artifact.id)).size, 3);
  assert.equal(new Set(manifest.targets.map(target => target.receipt.jobId)).size, 3);
  assert.equal(new Set([manifest.reservationArtifact.id, ...manifest.targets.map(target => target.artifact.id)]).size, 4);
  assert.equal(new Set([manifest.reservation.preflight.jobId, manifest.finalizer.jobId, ...manifest.targets.map(target => target.receipt.jobId)]).size, 5);
  assert.deepEqual(manifest.assets, nativeAssets(release, ctx), "Manifest differs from original release assets");
  return manifest;
}
function upload(release, file, name) {
  assert.equal(release.upload_url, `https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets{?name,label}`);
  const result = execFileSync("gh", ["api", `https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    "--method", "POST", "-H", "Content-Type: application/octet-stream", "--input", file],
  { env: out.childEnv(), encoding: "utf8", maxBuffer: 128 * 1024 });
  return JSON.parse(result);
}
function retainAsset(releaseId, file, name, ctx, request = api, send = upload) {
  const size = fs.lstatSync(file).size, digest = `sha256:${out.hashFile(file)}`;
  let release = request(`releases/${releaseId}`), matches = release.assets.filter(asset => asset.name === name), failure;
  assert.ok(matches.length <= 1, "Ambiguous release asset");
  if (!matches.length) {
    assert.equal(release.draft, true, "Published assets cannot be repaired/replaced");
    try { send(release, file, name); } catch (error) { failure = error; }
    release = request(`releases/${releaseId}`); matches = release.assets.filter(asset => asset.name === name);
  }
  if (matches.length !== 1) throw failure || new Error(`Original asset was not retained: ${name}`);
  const asset = matches[0]; validateAsset(asset, ctx);
  assert.equal(asset.size, size, `Conflicting original asset: ${name}`); assert.equal(asset.digest, digest, `Conflicting original asset: ${name}`);
  return assetIdentity(asset);
}
function assemble(ctx, output, request = api, restore = out.download, send = upload, read = readManifest) {
  const original = out.loadReservation(ctx, request, restore), { reservation } = original;
  available(ctx, request, original.release);
  const targets = NATIVE_TARGETS.map(target => {
    const selected = out.selectTarget(ctx, reservation, target, request, restore, true);
    assert.ok(selected, `Missing original target: ${target}`); return selected;
  });
  const allowed = [...NATIVE_TARGETS.flatMap(target => out.names(ctx.version, target)), MANIFEST];
  assert.ok(original.release.assets.every(asset => allowed.includes(asset.name)), "Foreign asset on the reserved release");
  const assets = [];
  for (const target of targets) for (const file of target.receipt.files) {
    assets.push(retainAsset(original.release.id, path.join(target.directory, file.name), file.name, ctx, request, send));
  }
  assets.sort((a, b) => a.name.localeCompare(b.name));
  let manifest;
  const existing = request(`releases/${original.release.id}`).assets.filter(asset => asset.name === MANIFEST);
  if (existing.length) {
    // A retry reuses the first finalizer receipt, including its original attempt.
    const stored = read(existing[0].id);
    const originalCtx = { ...ctx, attempt: stored.finalizer.attempt };
    verifyManifest(stored, originalCtx, request(`releases/${original.release.id}`));
    assert.deepEqual(stored.reservationArtifact, { id: original.artifact.id, name: original.artifact.name, digest: original.artifact.digest });
    assert.ok(out.jobs(ctx, request).some(job => job.id === stored.finalizer.jobId && job.name === "Publish original release" && job.run_attempt === stored.finalizer.attempt), "Original assembler job differs");
    assert.deepEqual(stored.assets, assets);
    assert.deepEqual(stored.targets, targets.map(({ receipt, artifact }) => ({ receipt, artifact })));
    manifest = stored;
  } else {
    const job = out.currentJob(ctx, "Publish original release", request);
    manifest = { schemaVersion: 2, kind: "bodhi-original-installers", releaseId: original.release.id, reservation,
      reservationArtifact: { id: original.artifact.id, name: original.artifact.name, digest: original.artifact.digest },
      finalizer: { jobId: job.id, attempt: ctx.attempt }, targets: targets.map(({ receipt, artifact }) => ({ receipt, artifact })), assets };
  }
  const manifestFile = path.join(path.dirname(output), MANIFEST); write(manifestFile, manifest);
  const manifestAsset = retainAsset(original.release.id, manifestFile, MANIFEST, ctx, request, send);
  const release = request(`releases/${original.release.id}`);
  verifyManifest(manifest, { ...ctx, attempt: manifest.finalizer.attempt }, release);
  assert.equal(release.assets.length, 7); assert.equal(new Set(release.assets.map(asset => asset.id)).size, 7);
  const evidence = { schemaVersion: 2, finalizerAttempt: ctx.attempt, manifest, manifestSha256: sha256(bytes(manifest)), manifestAsset, assets: identities(release) };
  write(output, evidence); return evidence;
}
function verifyEvidence(ctx, evidence, release) {
  assert.equal(evidence.schemaVersion, 2); assert.equal(evidence.finalizerAttempt, ctx.attempt);
  assert.equal(evidence.manifestSha256, sha256(bytes(evidence.manifest)));
  assert.ok(evidence.manifest.finalizer.attempt <= ctx.attempt);
  verifyManifest(evidence.manifest, { ...ctx, attempt: evidence.manifest.finalizer.attempt }, release);
  assert.deepEqual(evidence.assets, identities(release), "Original asset IDs or bytes changed");
  assert.equal(release.assets.length, 7); assert.equal(new Set(release.assets.map(asset => asset.id)).size, 7);
  const manifest = release.assets.filter(asset => asset.name === MANIFEST); assert.equal(manifest.length, 1);
  validateAsset(manifest[0], ctx); assert.deepEqual(assetIdentity(manifest[0]), evidence.manifestAsset);
  assert.equal(manifest[0].digest, `sha256:${evidence.manifestSha256}`); assert.equal(manifest[0].size, bytes(evidence.manifest).length);
}
function refreshSource(ctx, reservation, request = api) {
  assert.equal(request(`git/ref/heads/release/${ctx.source}`)?.object?.sha, ctx.source, "Frozen source changed before publication");
  assert.equal(request(`git/commits/${ctx.source}`)?.tree?.sha, reservation.tree, "Product tree changed before publication");
  const current = source.devHead(request("branches/dev"));
  const ancestry = request(`compare/${ctx.source}...${current}`);
  assert.equal(ancestry?.merge_base_commit?.sha, ctx.source, "Admitted source left dev ancestry");
  if (current !== reservation.admission.currentDev) {
    const advance = request(`compare/${reservation.admission.currentDev}...${current}`);
    assert.ok(advance?.status === "ahead" && advance.behind_by === 0 && advance.merge_base_commit?.sha === reservation.admission.currentDev,
      "Dev was rewritten after source admission");
  }
}
function publish(ctx, evidence, request = api) {
  const releaseId = evidence.manifest.releaseId;
  let release = request(`releases/${releaseId}`); out.releaseReservation(release, ctx); verifyEvidence(ctx, evidence, release);
  available(ctx, request, release);
  if (release.draft) {
    // Last read immediately before the one mutation; no delete/overwrite or rebuild fallback.
    release = request(`releases/${releaseId}`); verifyEvidence(ctx, evidence, release); available(ctx, request, release);
    refreshSource(ctx, evidence.manifest.reservation, request);
    let failure;
    try { request(`releases/${releaseId}`, "PATCH", { tag_name: ctx.finalTag, target_commitish: ctx.source,
      name: `App v${ctx.version}`, draft: false, prerelease: false, make_latest: "true" }); } catch (error) { failure = error; }
    release = request(`releases/${releaseId}`);
    if (release.draft) throw failure || new Error("Publication did not complete; retain originals and recover");
  }
  assert.equal(release.draft, false); assert.equal(release.tag_name, ctx.finalTag); assert.equal(release.target_commitish, ctx.source);
  verifyEvidence(ctx, evidence, release); available(ctx, request, release);
  assert.equal(request(`git/ref/tags/${ctx.finalTag}`)?.object?.sha, ctx.source, "Published tag differs from product source");
  return release;
}
function recoveryArtifact(ctx, request = api) {
  ctx = originalRun(ctx, request, true);
  const rows = out.jobs(ctx, request), candidates = rows.filter(job => job.name === "Publish original release" && job.run_attempt === ctx.attempt);
  assert.equal(candidates.length, 1); const job = candidates[0]; assert.equal(job.status, "completed"); assert.equal(job.conclusion, "failure");
  out.gate(job, ASSEMBLE); out.gate(job, EVIDENCE);
  assert.deepEqual(job.steps.filter(step => step.conclusion === "failure").map(step => step.name), [PUBLISH], "Recovery requires a publication-only failure");
  const artifact = out.artifact(pages(`actions/runs/${ctx.runId}/artifacts`, "artifacts", request), ctx.evidenceName, ctx, job);
  return { ctx, artifact };
}
function retainedEvidence(ctx, evidence, request = api, restore = out.download) {
  const job = out.currentJob(ctx, "Publish original release", request);
  out.gate(job, ASSEMBLE); out.gate(job, EVIDENCE);
  const artifact = out.artifact(pages(`actions/runs/${ctx.runId}/artifacts`, "artifacts", request), ctx.evidenceName, ctx, job, true);
  const directory = path.join(require("node:os").tmpdir(), `bodhi-v2-evidence-${require("node:crypto").randomUUID()}`);
  restore(artifact, ["evidence.json"], directory);
  assert.deepEqual(readJson(path.join(directory, "evidence.json")), evidence, "Retained publication evidence differs");
  return artifact;
}
function readManifest(assetId) {
  return JSON.parse(execFileSync("gh", ["api", `repos/${REPOSITORY}/releases/assets/${assetId}`, "-H", "Accept: application/octet-stream"],
    { env: out.childEnv(), encoding: "utf8", maxBuffer: 128 * 1024 }));
}
function publicationEvidence(ctx, job, release, request = api, restore = out.download) {
  // Passive consumer of an already completed original job. It never resumes it.
  assert.equal(job.name, "Publish original release"); assert.equal(job.status, "completed");
  assert.equal(job.run_id, ctx.runId); assert.equal(job.head_sha, ctx.controller);
  assert.equal(job.run_attempt, ctx.attempt); out.gate(job, ASSEMBLE); out.gate(job, EVIDENCE);
  const artifact = out.artifact(pages(`actions/runs/${ctx.runId}/artifacts`, "artifacts", request), ctx.evidenceName, ctx, job);
  const temporary = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "bodhi-main-evidence-"));
  const directory = path.join(temporary, "original");
  try {
    restore(artifact, ["evidence.json"], directory);
    const evidence = readJson(path.join(directory, "evidence.json")); verifyEvidence(ctx, evidence, release);
    return { evidence, artifact };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
// Structural component for a later main consumer, whose caller supplies an
// authenticated expected C/S/run. This export alone does not admit a promotion.
function verifyPublished(ctx, release, manifest) {
  assert.equal(release.draft, false); assert.equal(release.tag_name, ctx.finalTag); out.releaseReservation(release, ctx);
  verifyManifest(manifest, { ...ctx, attempt: manifest.finalizer.attempt }, release);
  const assets = release.assets.filter(asset => asset.name === MANIFEST); assert.equal(assets.length, 1); validateAsset(assets[0], ctx);
  assert.equal(assets[0].digest, `sha256:${sha256(bytes(manifest))}`); assert.equal(assets[0].size, bytes(manifest).length);
  assert.equal(release.assets.length, 7); assert.equal(new Set(release.assets.map(asset => asset.id)).size, 7); return manifest;
}
function main() {
  const [command, file] = process.argv.slice(2); let ctx = out.context();
  const recovering = command === "recover"; out.controller(recovering);
  if (command === "reserve") {
    originalRun(ctx);
    const product = source.requireProduct(ctx.source, process.env.SOURCE_ROOT);
    const existing = pages("releases").filter(release => release.tag_name === ctx.draftTag || release.tag_name === ctx.finalTag);
    let value;
    if (existing.length) {
      const original = out.loadReservation(ctx); available(ctx, api, original.release);
      assert.deepEqual(product.lockHashes, original.reservation.lockHashes);
      for (const [key, variable] of [["pullRequest", "FEATURE_PULL_REQUEST"], ["runId", "FEATURE_RUN_ID"], ["attempt", "FEATURE_RUN_ATTEMPT"]])
        assert.equal(String(original.reservation.admission[key]), process.env[variable]);
      value = { releaseId: original.release.id, reservation: original.reservation };
    } else {
      const proof = source.admitFeature({ source: ctx.source, pullRequest: process.env.FEATURE_PULL_REQUEST, runId: process.env.FEATURE_RUN_ID, attempt: process.env.FEATURE_RUN_ATTEMPT }, api,
        jobId => execFileSync("gh", ["api", `repos/${REPOSITORY}/actions/jobs/${jobId}/logs`, "--allow-escape-sequences"], { env: out.childEnv(), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
      value = reserve(ctx, product, proof);
    }
    write(file, value); out.outputs({ reuse: Boolean(existing.length), version: ctx.version, frontend_package: product.frontend.packageName, frontend_version: product.frontend.packageVersion }); return;
  }
  if (recovering) {
    const original = recoveryArtifact(ctx); ctx = original.ctx;
    const directory = `${file}.original`; out.download(original.artifact, ["evidence.json"], directory);
    const evidence = readJson(path.join(directory, "evidence.json"));
    // Authenticate source admission and every original target again, without rebuilding.
    const originalReservation = out.loadReservation(ctx);
    assert.deepEqual(evidence.manifest.reservation, originalReservation.reservation);
    const targets = NATIVE_TARGETS.map(target => out.selectTarget(ctx, originalReservation.reservation, target, api, out.download, true));
    assert.deepEqual(evidence.manifest.targets, targets.map(({ receipt, artifact }) => ({ receipt, artifact })));
    publish(ctx, evidence); return;
  }
  originalRun(ctx);
  if (command === "assemble") { assemble(ctx, file); return; }
  assert.equal(command, "publish"); const evidence = readJson(file); retainedEvidence(ctx, evidence); publish(ctx, evidence);
}
module.exports = { ASSEMBLE, EVIDENCE, PUBLISH, available, reserve, originalRun, validateAsset, nativeAssets, verifyManifest,
  retainAsset, assemble, verifyEvidence, refreshSource, publish, recoveryArtifact, retainedEvidence, readManifest, publicationEvidence, verifyPublished };
if (require.main === module) { try { main(); } catch (error) { console.error(`Bodhi v2 release: ${error.message}`); process.exitCode = 1; } }
