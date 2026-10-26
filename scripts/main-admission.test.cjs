"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const main = require("./main-admission.cjs");
const out = require("./release-output.cjs");
const source = require("./release-source.cjs");
const finalizer = require("./release-finalizer-v2.cjs");
const S = "1".repeat(40), ST = "2".repeat(40), C = "4".repeat(40), C2 = "5".repeat(40), MT = "6".repeat(40);
const B = "a".repeat(40), P = "b".repeat(40), M = "c".repeat(40), D = "d".repeat(40), FM = "e".repeat(40), FB = "f".repeat(40), F = "0".repeat(40);
const blob = data => crypto.createHash("sha1").update(`blob ${Buffer.byteLength(data)}\0`).update(data).digest("hex");
const copy = value => structuredClone(value);
const gate = "Require the exact feature merge source";
const childEnv = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
function timed(id, name, run, head, steps, attempt = 1) {
  const stamp = seconds => new Date(Date.UTC(2026, 9, 27, 0, 0, seconds)).toISOString();
  return { id, name, run_id: run, head_sha: head, run_attempt: attempt, status: "completed", conclusion: "success",
    started_at: stamp(0), completed_at: stamp(300), steps: steps.map((name, i) => ({ number: i + 1, name, status: "completed", conclusion: "success",
      started_at: stamp(10 + i * 10), completed_at: stamp(15 + i * 10) })) };
}
function fixture() {
  const featureSteps = [[gate, "Run script unit tests"], ...out.NATIVE_TARGETS.map(() => [gate, "Stage accepted inputs for debug assembly",
    "Run native shell unit tests", "Verify debug assembly inputs", "Run native actor and static frontend E2E", "Run native browser E2E"]),
    ["Require every unit test result"], ["Require every native E2E result"]];
  const names = ["Unit Tests (Node)", ...out.NATIVE_TARGETS.map(t => `Unit and E2E (${t})`), "Unit Tests", "E2E Tests"];
  const featureJobs = names.map((name, i) => timed(500 + i, name, 90, F, featureSteps[i]));
  featureJobs.push({ id: 506, name: source.MAIN_GATE, run_id: 90, head_sha: F, run_attempt: 1, status: "completed", conclusion: "skipped", steps: [] });
  const admission = { schemaVersion: source.ADMISSION_SCHEMA, kind: source.ADMISSION_KIND, repository: out.REPOSITORY, source: S, tree: ST,
    pullRequest: 17, base: FB, head: F, snapshot: FM, runId: 90, attempt: 1, observedDev: D, currentDev: D, workflowBlob: source.FEATURE_WORKFLOW_BLOB,
    jobs: names.map((name, i) => ({ id: 500 + i, name, attempt: 1, logical: { id: 500 + i, attempt: 1 } })) };
  const value = { mode: "promotion", source: S, version: "2026.10.30", releaseId: 99, runId: 42, attempt: 1 };
  const ctx = out.context({ GITHUB_REPOSITORY: out.REPOSITORY, RELEASE_VERSION: value.version, EXPECTED_SOURCE_SHA: S, GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKFLOW_SHA: C });
  const lockBytes = Object.fromEntries(["scripts/bamboo-sidecar-lock.json", "scripts/frontend-package-lock.json"].map(file => [file, fs.readFileSync(path.join(__dirname, "..", file))]));
  const reservation = { schemaVersion: 2, kind: "bodhi-original-release", repository: out.REPOSITORY, source: S, tree: ST, controller: C, version: value.version,
    runId: 42, preflight: { jobId: 10, attempt: 1 }, admission, lockHashes: Object.fromEntries(Object.entries(lockBytes).map(([file, bytes]) => [file, out.sha256(bytes)])),
    frontend: JSON.parse(lockBytes["scripts/frontend-package-lock.json"]) };
  const jobs = [timed(10, "Reserve admitted release", 42, C, [out.PREFLIGHT, out.RESERVATION]),
    ...out.NATIVE_TARGETS.map((target, i) => timed(11 + i, `Build original (${target})`, 42, C, ["Select retained target output", "Verify source and stamp reserved version", out.BUILD, out.CAPTURE, out.RETAIN])),
    timed(14, "Publish original release", 42, C, [finalizer.ASSEMBLE, finalizer.EVIDENCE, finalizer.PUBLISH])];
  const artifact = (id, name) => ({ id, name, expired: false, digest: `sha256:${out.sha256(String(id))}`, size_in_bytes: 6000,
    created_at: "2026-10-27T00:04:00Z", workflow_run: { id: 42, head_sha: C } });
  const artifacts = [artifact(100, ctx.reservationName)], files = { 100: { "reservation.json": out.bytes({ releaseId: 99, reservation }) } };
  const targets = out.NATIVE_TARGETS.map((target, i) => {
    const contents = {}, outputFiles = out.names(value.version, target).map((name, index) => {
      const bytes = Buffer.alloc(1024 ** 2, i * 4 + index + 1); contents[name] = bytes;
      return { name, size: bytes.length, sha256: out.sha256(bytes) };
    });
    const receipt = { schemaVersion: 2, target, reservationSha256: out.sha256(out.bytes(reservation)), jobId: 11 + i, attempt: 1, checks: out.checks(target), files: outputFiles };
    contents["target-receipt.json"] = out.bytes(receipt); const item = artifact(101 + i, out.artifactName(ctx, target, 1)); artifacts.push(item); files[item.id] = contents;
    return { receipt, artifact: { id: item.id, name: item.name, digest: item.digest } };
  });
  const assets = targets.flatMap(t => t.receipt.files).map((file, index) => ({ id: 200 + index, name: file.name, size: file.size, digest: `sha256:${file.sha256}`, state: "uploaded" }));
  assets.sort((a, b) => a.name.localeCompare(b.name));
  const manifest = { schemaVersion: 2, kind: "bodhi-original-installers", releaseId: 99, reservation,
    reservationArtifact: { id: 100, name: ctx.reservationName, digest: artifacts[0].digest }, finalizer: { jobId: 14, attempt: 1 }, targets, assets };
  const manifestAsset = { id: 206, name: out.MANIFEST, size: out.bytes(manifest).length, digest: `sha256:${out.sha256(out.bytes(manifest))}`, state: "uploaded" };
  const release = { id: 99, url: `https://api.github.com/repos/${out.REPOSITORY}/releases/99`, draft: false, prerelease: false, target_commitish: S,
    tag_name: ctx.finalTag, body: JSON.stringify(reservation), assets: [...assets, manifestAsset].map(asset => ({ ...asset,
      created_at: "2026-10-27T00:00:12Z", url: `https://api.github.com/repos/${out.REPOSITORY}/releases/assets/${asset.id}`,
      browser_download_url: `https://github.com/${out.REPOSITORY}/releases/download/${ctx.finalTag}/${asset.name}` })) };
  const evidence = { schemaVersion: 2, finalizerAttempt: 1, manifest, manifestSha256: out.sha256(out.bytes(manifest)), manifestAsset,
    assets: [...assets, manifestAsset].sort((a, b) => a.name.localeCompare(b.name)) };
  artifacts.push(artifact(150, ctx.evidenceName)); files[150] = { "evidence.json": out.bytes(evidence) };
  const f = { value, ctx, reservation, featureJobs, jobs, artifacts, files, manifest, release, evidence, reads: [], responses: {}, counts: new Map(), lockBytes,
    run: { id: 42, repository: { full_name: out.REPOSITORY }, run_attempt: 1, event: "workflow_dispatch", path: ".github/workflows/release.yml@refs/heads/main",
      head_sha: C, head_branch: "main", display_title: `Bodhi v2 v${value.version} @ ${S}`, status: "completed", conclusion: "success" },
    featureRun: { id: 90, repository: { full_name: out.REPOSITORY }, event: "pull_request", path: ".github/workflows/ci.yml", head_sha: F,
      run_attempt: 1, status: "completed", conclusion: "success", pull_requests: [] },
    featurePR: { number: 17, state: "closed", merged: true, merge_commit_sha: S,
      base: { ref: "dev", sha: FB, repo: { full_name: out.REPOSITORY } }, head: { sha: F, repo: { full_name: out.REPOSITORY } } },
    dev: { name: "dev", protected: true, commit: { sha: D }, protection: { required_status_checks: { enforcement_level: "everyone", contexts: ["Unit Tests", "E2E Tests"],
      checks: ["Unit Tests", "E2E Tests"].map(context => ({ context, app_id: 15368 })) } } },
    branch: { name: "main", protected: true, commit: { sha: B }, protection: { required_status_checks: { enforcement_level: "everyone", contexts: [source.MAIN_GATE],
      checks: [{ context: source.MAIN_GATE, app_id: 15368 }] } } },
    pr: { number: 23, state: "open", merged: false, mergeable: true, merge_commit_sha: M,
      base: { ref: "main", sha: B, repo: { full_name: out.REPOSITORY } }, head: { ref: "promotion/source", sha: P, repo: { full_name: out.REPOSITORY } } },
    commits: { [S]: { sha: S, tree: { sha: ST }, parents: [{ sha: FB }, { sha: F }] }, [FM]: { sha: FM, tree: { sha: ST }, parents: [{ sha: FB }, { sha: F }] },
      [B]: { sha: B, tree: { sha: "7".repeat(40) } }, [M]: { sha: M, tree: { sha: ST }, parents: [{ sha: B }, { sha: P }] } }, trees: {} };
  const entry = (file, hash) => ({ path: file, type: "blob", mode: "100644", sha: hash });
  const image = owner => [...main.CONTROLS.map(file => entry(file, file.endsWith("/ci.yml") ? source.FEATURE_WORKFLOW_BLOB : file.endsWith("/release.yml") ? main.RELEASE_BLOB :
    file.endsWith("/recover-release.yml") ? main.RECOVERY_BLOB : blob(owner + file))),
    entry("src-tauri/src/main.rs", blob(owner + "product")), entry("src-tauri/Cargo.toml", blob('version = "0.0.0"\n')),
    ...Object.entries(lockBytes).map(([file, bytes]) => entry(file, blob(bytes))),
    { path: "scripts", type: "tree", mode: "040000", sha: blob(owner + "scripts-directory") }];
  f.trees[ST] = image("source"); f.trees["7".repeat(40)] = image("base");
  f.body = () => { f.pr.body = `Review notes\n<!-- bodhi-main-locator/v1\n${JSON.stringify(f.value)}\n-->`; };
  f.body();
  f.request = (endpoint, method = "GET", body) => {
    assert.equal(method, "GET", "Main attempted a GitHub write"); assert.equal(body, undefined); f.reads.push(endpoint);
    const count = (f.counts.get(endpoint) || 0) + 1; f.counts.set(endpoint, count);
    let result;
    if (endpoint === "pulls/23") result = f.pr;
    else if (endpoint === "pulls/17") result = f.featurePR;
    else if (endpoint === "branches/main") result = f.branch;
    else if (endpoint === "branches/dev") result = f.dev;
    else if (endpoint === "actions/runs/42") result = f.run;
    else if (endpoint === "actions/runs/90") result = f.featureRun;
    else if (endpoint === "actions/runs/77") result = f.recovery;
    else if (endpoint.startsWith("actions/runs/42/jobs?")) result = { total_count: f.jobs.length, jobs: f.jobs };
    else if (endpoint.startsWith("actions/runs/90/jobs?")) result = { total_count: f.featureJobs.length, jobs: f.featureJobs };
    else if (endpoint.startsWith("actions/runs/77/jobs?")) result = { total_count: f.recoveryJobs.length, jobs: f.recoveryJobs };
    else if (endpoint.startsWith("actions/runs/42/artifacts?")) result = { total_count: f.artifacts.length, artifacts: f.artifacts };
    else if (endpoint.startsWith("releases?")) result = [f.release];
    else if (endpoint === "releases/99") result = f.release;
    else if (endpoint === `git/ref/heads/release/${S}` || endpoint === `git/ref/tags/${ctx.finalTag}`) result = { object: { sha: S, type: "commit" } };
    else if (endpoint.startsWith("git/commits/")) result = f.commits[endpoint.slice(12)];
    else if (endpoint.startsWith("git/trees/")) { const hash = endpoint.slice(10).split("?")[0]; result = { sha: hash, truncated: false, tree: f.trees[hash] }; }
    else if (endpoint.startsWith("compare/")) { const [before] = endpoint.slice(8).split("..."); result = { merge_base_commit: { sha: before }, status: "ahead", behind_by: 0 }; }
    else if (endpoint === `contents/.github/workflows/release.yml?ref=${C}`) result = { sha: main.RELEASE_BLOB };
    else if (endpoint === `contents/.github/workflows/recover-release.yml?ref=${C2}`) result = { sha: main.RECOVERY_BLOB };
    else if (endpoint === `contents/.github/workflows/ci.yml?ref=${FM}`) result = { sha: source.FEATURE_WORKFLOW_BLOB };
    else if (endpoint.startsWith("contents/") && endpoint.endsWith(`?ref=${S}`)) {
      const file = endpoint.slice(9).split("?")[0]; result = { encoding: "base64", content: lockBytes[file].toString("base64") };
    } else assert.fail(`Unexpected read-only request: ${endpoint}`);
    assert.ok(result, `Missing fixture: ${endpoint}`); const response = copy(result);
    if (f.onRead) f.onRead(endpoint, response, count); f.responses[endpoint] = copy(response); return response;
  };
  f.options = { readLog: jobId => {
    assert.ok([500, 501, 502, 503].includes(jobId), "Only physical original source logs may be read");
    const context = { schema: source.FEATURE_CONTEXT_SCHEMA, repository: out.REPOSITORY, runId: 90, physicalAttempt: 1, pullRequest: 17, base: FB, head: F, snapshot: FM, tree: ST };
    return `2026-10-27T00:00:00.000Z Feature source: ${FM} tree: ${ST}\n2026-10-27T00:00:00.001Z Feature context: ${Buffer.from(JSON.stringify(context)).toString("base64")}\n`;
  }, readManifest: assetId => { assert.equal(assetId, 206); return copy(f.manifest); }, restore: (item, entries, directory) => {
    assert.deepEqual([...entries].sort(), Object.keys(f.files[item.id]).sort()); fs.mkdirSync(directory, { recursive: true });
    for (const [file, bytes] of Object.entries(f.files[item.id])) fs.writeFileSync(path.join(directory, file), bytes, { flag: "wx" });
  } };
  f.verify = () => main.verifyMain({ pullRequest: 23, snapshot: M }, f.request, f.options);
  f.actual = entries => { f.commits[M].tree.sha = MT; f.trees[MT] = copy(entries); };
  f.overlay = () => {
    const entries = copy(f.trees[ST]), base = f.trees[f.commits[f.pr.base.sha].tree.sha];
    for (const file of main.CONTROLS) entries.splice(entries.findIndex(entry => entry.path === file), 1, copy(base.find(entry => entry.path === file)));
    f.actual(entries);
  };
  return f;
}
test("normal completed release admits a complete S Main postimage, preserving actual C/S/M roles", () => {
  const f = fixture(), proof = f.verify(); assert.equal(proof.source, S); assert.equal(proof.controller, C); assert.equal(proof.snapshot, M);
  assert.equal(proof.postimage, "complete-source"); assert.equal(proof.mainTree, ST); assert.equal(proof.publisher.id, 14);
  assert.ok(f.reads.includes(`compare/${C}...${B}`)); assert.ok(!f.reads.includes(`compare/${C}...${S}`));
});
test("Main may retain the whole trusted controller closure while its complete product/locks remain S", () => {
  const f = fixture(); f.overlay(); const proof = f.verify(); assert.equal(proof.postimage, "retained-main-controls"); assert.equal(proof.mainTree, MT);
});
function refreshManifest(f) {
  const asset = f.release.assets.find(item => item.name === out.MANIFEST);
  asset.digest = `sha256:${out.sha256(out.bytes(f.manifest))}`; asset.size = out.bytes(f.manifest).length;
  const identity = ({ id, name, size, digest, state }) => ({ id, name, size, digest, state });
  f.evidence.manifestSha256 = out.sha256(out.bytes(f.manifest)); f.evidence.manifestAsset = identity(asset);
  f.evidence.assets = f.release.assets.map(identity).sort((a, b) => a.name.localeCompare(b.name));
  f.files[150]["evidence.json"] = out.bytes(f.evidence);
}
function recover(f) {
  f.value.recovery = { runId: 77, attempt: 1 }; f.body(); f.run.conclusion = "failure";
  f.jobs.at(-1).conclusion = "failure"; f.jobs.at(-1).steps.at(-1).conclusion = "failure";
  f.recovery = { id: 77, run_attempt: 1, repository: { full_name: out.REPOSITORY }, event: "workflow_dispatch", path: ".github/workflows/recover-release.yml@main",
    head_sha: C2, head_branch: "main", status: "completed", conclusion: "success", display_title: "Recover Bodhi v2026.10.30 from 42 attempt 1" };
  f.recoveryJobs = [timed(71, "recover-v2", 77, C2, ["Verify original immutable outputs and recover publication"]),
    { id: 72, name: "recover", run_id: 77, head_sha: C2, run_attempt: 1, status: "completed", conclusion: "skipped", steps: [] }];
}
function bootstrap(f) {
  const entries = copy(f.trees[f.commits[B].tree.sha]).filter(entry => !["scripts/main-admission.cjs", "scripts/release-source.cjs"].includes(entry.path));
  f.commits[main.LEGACY_BASE] = { sha: main.LEGACY_BASE, tree: { sha: main.LEGACY_TREE } }; f.trees[main.LEGACY_TREE] = entries;
  f.pr.base.sha = f.branch.commit.sha = f.commits[M].parents[0].sha = main.LEGACY_BASE;
  f.value = { mode: "bootstrap", source: S, feature: { pullRequest: 17, runId: 90, attempt: 1 } }; f.body();
  const actual = copy(entries).filter(entry => !main.CONTROLS.includes(entry.path));
  actual.push(...f.trees[ST].filter(entry => main.CONTROLS.includes(entry.path))); f.actual(actual);
}
test("completed publication-only recovery authenticates original C1, distinct C2 and the same seven assets", () => {
  const f = fixture(); recover(f); const proof = f.verify();
  assert.equal(proof.controller, C); assert.equal(proof.recovery.controller, C2); assert.equal(proof.recovery.jobId, 71);
  assert.equal(proof.assets.length, 7); assert.ok(f.reads.includes(`compare/${C2}...${B}`));
});
test("a copied successful release keeps physical outputs, assembler and publication evidence", () => {
  const f = fixture(); f.value.attempt = f.run.run_attempt = 2; f.body();
  for (const job of [...f.jobs]) f.jobs.push({ ...copy(job), id: job.id + 1000, run_attempt: 2 });
  const proof = f.verify(); assert.equal(proof.publisher.id, 14); assert.deepEqual(proof.publisher.logical, { id: 1014, attempt: 2 });
  assert.deepEqual(f.manifest.targets.map(t => t.receipt.attempt), [1, 1, 1]);
});
test("a copied recovery success also preserves its original physical execution", () => {
  const f = fixture(); recover(f); f.value.recovery.attempt = f.recovery.run_attempt = 2; f.body();
  f.recoveryJobs.push({ ...copy(f.recoveryJobs[0]), id: 171, run_attempt: 2 });
  const proof = f.verify(); assert.equal(proof.recovery.jobId, 71); assert.deepEqual(proof.recovery.logical, { id: 171, attempt: 2 });
});
for (const [name, mutate] of [
  ["release run head", f => { f.run.head_sha = S; }], ["release workflow", f => { f.run.path = ".github/workflows/foreign.yml"; }],
  ["release event", f => { f.run.event = "push"; }], ["release attempt", f => { f.run.run_attempt++; }], ["failed publication", f => { f.run.conclusion = "failure"; }],
  ["unpublished draft", f => { f.release.draft = true; }], ["source identity", f => { f.release.target_commitish = C; }],
  ["asset replacement", f => { f.release.assets[0].id++; }], ["asset digest", f => { f.release.assets[0].digest = `sha256:${"0".repeat(64)}`; }],
  ["missing seventh asset", f => { f.release.assets.pop(); }], ["missing reservation", f => { f.artifacts.shift(); }],
  ["missing prior success output", f => { f.artifacts.splice(1, 1); }], ["expired original", f => { f.artifacts[1].expired = true; }],
  ["artifact run", f => { f.artifacts[1].workflow_run.head_sha = S; }],
  ["actual original byte", f => { const name = Object.keys(f.files[101])[0]; f.files[101][name] = Buffer.alloc(1024 ** 2, 99); }],
  ["latest native failure", f => { f.jobs[1].conclusion = "failure"; }], ["skipped static gate", f => { f.jobs[1].steps[3].conclusion = "skipped"; }],
  ["ambiguous physical build", f => { f.jobs.push({ ...copy(f.jobs[1]), id: 99 }); }],
  ["foreign release job", f => { f.jobs.push({ ...copy(f.jobs[1]), name: "unregistered", id: 99 }); }],
  ["missing original assembler", f => { f.manifest.finalizer.jobId = 88; refreshManifest(f); }],
  ["manifest outside assembler", f => { f.release.assets.at(-1).created_at = "2026-10-28T00:00:00Z"; }],
  ["unconfirmed source", f => { f.featurePR.merged = false; }], ["failed source run", f => { f.featureRun.conclusion = "failure"; }],
  ["unprotected dev", f => { f.dev.protected = false; }], ["unprotected Main", f => { f.branch.protected = false; }],
  ["missing Main enforcement", f => { f.branch.protection.required_status_checks.enforcement_level = "off"; }],
  ["foreign Main check app", f => { f.branch.protection.required_status_checks.checks[0].app_id = 7; }],
  ["closed Main PR", f => { f.pr.state = "closed"; }], ["foreign Main head repo", f => { f.pr.head.repo.full_name = "other/Bodhi-AI"; }],
  ["unknown mergeability", f => { f.pr.mergeable = null; }],
]) test(`Main refuses ${name} without a write/rebuild fallback`, () => { const f = fixture(); mutate(f); assert.throws(() => f.verify()); });
for (const [name, endpoint, mutate] of [
  ["unreviewed controller workflow", `contents/.github/workflows/release.yml?ref=${C}`, value => { value.sha = B; }],
  ["controller outside Main history", `compare/${C}...${B}`, value => { value.merge_base_commit.sha = S; }],
  ["frozen ref moved", `git/ref/heads/release/${S}`, value => { value.object.sha = C; }],
  ["wrong final tag", "git/ref/tags/app-v2026.10.30", value => { value.object.sha = C; }],
  ["source lock mismatch", `contents/scripts/frontend-package-lock.json?ref=${S}`, value => { value.content = Buffer.from("{}").toString("base64"); }],
  ["truncated tree", `git/trees/${ST}?recursive=1`, value => { value.truncated = true; }],
]) test(`Main authenticates ${name}`, () => { const f = fixture(); f.onRead = (key, value) => { if (key === endpoint) mutate(value); }; assert.throws(() => f.verify()); });
for (const [name, mutate] of [
  ["partial controller overlay", entries => { entries.find(e => e.path === "scripts/main-admission.cjs").sha = blob("partial"); }],
  ["extra product", entries => entries.push({ path: "extra.rs", type: "blob", mode: "100644", sha: blob("extra") })],
  ["removed product", entries => entries.splice(entries.findIndex(e => e.path === "src-tauri/src/main.rs"), 1)],
  ["changed product mode", entries => { entries.find(e => e.path === "src-tauri/src/main.rs").mode = "100755"; }],
  ["stamped source version", entries => { entries.find(e => e.path === "src-tauri/Cargo.toml").sha = blob('version = "2026.10.30"\n'); }],
  ["changed upstream lock", entries => { entries.find(e => e.path === "scripts/frontend-package-lock.json").sha = blob("lock"); }],
  ["extra empty directory", entries => entries.push({ path: "scripts/extra", type: "tree", mode: "040000", sha: blob("empty tree") })],
]) test(`postimage rejects ${name}`, () => { const f = fixture(); f.overlay(); mutate(f.trees[MT]); assert.throws(() => f.verify()); });
for (const [name, mutate] of [
  ["failed recovery", f => { f.recovery.conclusion = "failure"; }], ["wrong recovery controller", f => { f.recovery.head_branch = "dev"; }],
  ["wrong original locator", f => { f.recovery.display_title = "Recover Bodhi v2026.10.30 from 43 attempt 1"; }],
  ["legacy success instead of v2", f => { f.recoveryJobs[1].conclusion = "success"; }],
  ["native failure before recovery", f => { f.jobs[1].conclusion = "failure"; }],
  ["assembly failure instead of publish-only", f => { f.jobs.at(-1).steps[0].conclusion = "failure"; }],
  ["missing original evidence", f => { f.artifacts.pop(); }], ["missing recovery gates", f => { f.recoveryJobs[0].steps = []; }],
  ["ambiguous recovery", f => { f.recoveryJobs.push({ ...copy(f.recoveryJobs[0]), id: 171 }); }],
]) test(`recovered publication refuses ${name}`, () => { const f = fixture(); recover(f); mutate(f); assert.throws(() => f.verify()); });
test("guarded bootstrap imports exactly the complete control closure and keeps Main products/locks", () => {
  const f = fixture(); bootstrap(f); const proof = f.verify(); assert.equal(proof.kind, "bodhi-main-bootstrap/v1");
  assert.equal(proof.controllerSource, S); assert.equal(proof.base, main.LEGACY_BASE);
  assert.ok(f.reads.every(endpoint => !endpoint.includes("heads/release/") && !endpoint.startsWith("releases") && !endpoint.includes("/artifacts")));
});
for (const [name, mutate] of [
  ["another base", f => { f.pr.base.sha = f.branch.commit.sha = f.commits[M].parents[0].sha = B; }],
  ["unknown legacy tree", f => { f.commits[main.LEGACY_BASE].tree.sha = ST; }],
  ["already imported Main helper", f => { f.trees[main.LEGACY_TREE].push(copy(f.trees[ST].find(e => e.path === "scripts/main-admission.cjs"))); }],
  ["partial closure", f => { f.trees[MT].splice(f.trees[MT].findIndex(e => e.path === "scripts/main-admission.cjs"), 1); }],
  ["product promotion before release", f => { f.trees[MT].find(e => e.path === "src-tauri/src/main.rs").sha = blob("unreleased"); }],
  ["upstream lock exception", f => { f.trees[MT].find(e => e.path === "scripts/bamboo-sidecar-lock.json").sha = blob("new lock"); }],
  ["executable controller mode", f => { f.trees[ST].find(e => e.path === "scripts/main-admission.cjs").mode = "100755"; }],
  ["unconfirmed Dev source", f => { f.featurePR.merged = false; }],
]) test(`bootstrap refuses ${name}`, () => { const f = fixture(); bootstrap(f); mutate(f); assert.throws(() => f.verify()); });
test("PR text is a locator only: arbitrary branch/bot names cannot select a bypass", () => {
  const f = fixture(); f.pr.body = "bootstrap approved by release-bot from release/anything"; assert.throws(() => f.verify(), /locator/);
  f.body(); f.pr.body += f.pr.body; assert.throws(() => f.verify(), /locator/);
});
for (const [name, endpoint, after, mutate] of [
  ["Main base", "branches/main", 1, value => { value.commit.sha = C2; }],
  ["Main PR head", "pulls/23", 1, value => { value.head.sha = C2; }],
  ["Main PR locator", "pulls/23", 1, value => { value.body = value.body.replace('"releaseId":99', '"releaseId":100'); }],
  ["release source", "releases/99", 2, value => { value.target_commitish = C2; }],
  ["release run status", "actions/runs/42", 1, value => { value.conclusion = "cancelled"; }],
  ["release run head", "actions/runs/42", 1, value => { value.head_sha = C2; }],
  ["late Dev protection", "branches/dev", 3, value => { value.protected = false; }],
  ["late frozen ref", `git/ref/heads/release/${S}`, 2, value => { value.object.sha = C2; }],
]) test(`final admission rejects concurrent ${name} change`, () => {
  const f = fixture(); f.onRead = (key, value, count) => { if (key === endpoint && count > after) mutate(value); }; assert.throws(() => f.verify());
});
test("non-authority review metadata changes do not replace source or invalidate an unchanged locator", () => {
  const f = fixture(); f.onRead = (key, value, count) => { if (key === "pulls/23" && count > 1) { value.comments = 7; value.body = "Updated review notes\n" + value.body; } };
  assert.equal(f.verify().source, S);
});
test("recovery changes after verification are rejected without another publication attempt", () => {
  const f = fixture(); recover(f); f.onRead = (key, value, count) => { if (key === "actions/runs/77" && count > 1) value.conclusion = "failure"; };
  assert.throws(() => f.verify());
});
test("the Main transport rejects every mutation before calling GitHub", () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) assert.throws(() => main.readOnly("releases/99", method, {}), /read authority/);
});
test("actual Main CLI reads immutable ZIPs, preserves real Target B/independent M and rejects candidate-defined execution", {
  skip: process.platform === "win32" && "Main executes on hosted Linux; the CLI adapter uses POSIX executable shims",
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-main-cli-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture(), bin = path.join(root, "bin"), database = path.join(root, "evidence.json"), eventFile = path.join(root, "event.json");
  fs.mkdirSync(bin); const archives = {};
  function archive(item) {
    const directory = path.join(root, `artifact-${item.id}`); fs.mkdirSync(directory);
    for (const [file, bytes] of Object.entries(f.files[item.id])) fs.writeFileSync(path.join(directory, file), bytes);
    const zip = path.join(root, `${item.id}.zip`);
    execFileSync("zip", ["-q", zip, ...Object.keys(f.files[item.id])], { cwd: directory, env: childEnv, stdio: "pipe" });
    item.digest = `sha256:${out.hashFile(zip)}`; item.size_in_bytes = fs.statSync(zip).size; archives[item.id] = zip;
  }
  for (const item of f.artifacts.filter(item => item.id !== 150)) archive(item);
  f.manifest.reservationArtifact.digest = f.artifacts[0].digest;
  for (const target of f.manifest.targets) target.artifact.digest = f.artifacts.find(item => item.id === target.artifact.id).digest;
  refreshManifest(f); archive(f.artifacts.find(item => item.id === 150));
  f.verify();
  const runtime = { id: 70, run_attempt: 1, repository: { full_name: out.REPOSITORY }, event: "pull_request_target", path: ".github/workflows/ci.yml",
    head_sha: P, head_branch: f.pr.head.ref, status: "in_progress", conclusion: null };
  const runtimeJobs = { total_count: 1, jobs: [{ id: 701, name: source.MAIN_GATE, run_id: 70, head_sha: P, run_attempt: 1, status: "in_progress", conclusion: null,
    steps: [{ name: "Verify completed publication and exact main postimage", status: "in_progress", conclusion: null }] }] };
  let currentHead = B;
  const save = () => fs.writeFileSync(database, JSON.stringify({ head: currentHead, responses: { ...f.responses,
    [`contents/.github/workflows/ci.yml?ref=${M}`]: { sha: source.FEATURE_WORKFLOW_BLOB }, "actions/runs/70": runtime,
    [`contents/.github/workflows/ci.yml?ref=${B}`]: { sha: source.FEATURE_WORKFLOW_BLOB },
    "actions/runs/70/jobs?filter=all&per_page=100&page=1": runtimeJobs }, archives, manifest: f.manifest,
    logs: Object.fromEntries([500, 501, 502, 503].map(id => [id, f.options.readLog(id)])) }));
  save(); fs.writeFileSync(eventFile, JSON.stringify({ number: 23, pull_request: f.pr }));
  const shim = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  shim("git", `if(process.argv[2]==="rev-parse")process.stdout.write(JSON.parse(require("node:fs").readFileSync(${JSON.stringify(database)})).head);else if(process.argv[2]!=="status")process.exit(2);`);
  shim("gh", `const fs=require("node:fs"), f=JSON.parse(fs.readFileSync(${JSON.stringify(database)}));
const args=process.argv.slice(2), method=args.indexOf("--method");if(method!==-1&&args[method+1]!=="GET")process.exit(9);
const route=args[1].replace(/^repos\\/bigduu\\/Bodhi-AI\\//,"");
const zip=/^actions\\/artifacts\\/(\\d+)\\/zip$/.exec(route), log=/^actions\\/jobs\\/(\\d+)\\/logs$/.exec(route);
if(zip)process.stdout.write(fs.readFileSync(f.archives[zip[1]]));else if(log)process.stdout.write(f.logs[log[1]]);
else if(route==="releases/assets/206")process.stdout.write(JSON.stringify(f.manifest,null,2)+"\\n");
else if(Object.hasOwn(f.responses,route))process.stdout.write(JSON.stringify(f.responses[route]));else{process.stderr.write("Unknown readonly fixture route");process.exit(2);}`);
  const env = Object.freeze({ ...childEnv, PATH: `${bin}${path.delimiter}${childEnv.PATH}`,
    GITHUB_REPOSITORY: out.REPOSITORY, GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: eventFile,
    GITHUB_SHA: B, GITHUB_WORKFLOW_SHA: B, GITHUB_WORKFLOW_REF: `${out.REPOSITORY}/.github/workflows/ci.yml@refs/heads/main`,
    GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "70", GITHUB_RUN_ATTEMPT: "1" });
  const before = copy(env), run = extra => spawnSync(process.execPath, [path.join(__dirname, "main-admission.cjs")], { env: { ...env, ...extra }, encoding: "utf8" });
  runtime.event = "pull_request"; runtime.head_sha = runtimeJobs.jobs[0].head_sha = P; save();
  const candidate = run({ GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: M, GITHUB_WORKFLOW_SHA: M, GITHUB_REF: "refs/pull/23/merge",
    GITHUB_WORKFLOW_REF: `${out.REPOSITORY}/.github/workflows/ci.yml@refs/pull/23/merge` });
  assert.notEqual(candidate.status, 0, "A candidate pull_request definition cannot authorize the Main metadata gate");
  runtime.event = "pull_request_target"; runtime.head_sha = runtimeJobs.jobs[0].head_sha = P; save();
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout); assert.equal(proof.snapshot, M); assert.equal(proof.controller, C); assert.equal(proof.source, S);
  assert.equal(proof.runtime.jobId, 701); assert.equal(proof.runtime.verifier, B); assert.deepEqual(env, before);
  const originalBody = f.responses["pulls/23"].body;
  f.responses["pulls/23"].body = originalBody.replace('"releaseId":99', '"releaseId":100'); save();
  const edited = run(); assert.notEqual(edited.status, 0); assert.match(edited.stderr, /Locator changed after this Target event/);
  f.responses["pulls/23"].body = originalBody;
  for (const extra of [{ GITHUB_SHA: C }, { GITHUB_WORKFLOW_SHA: C }, { GITHUB_EVENT_NAME: "workflow_dispatch" }])
    assert.notEqual(run(extra).status, 0);
  currentHead = S; save(); assert.notEqual(run().status, 0); currentHead = B;
  runtime.conclusion = "cancelled"; save(); assert.notEqual(run().status, 0);
});
