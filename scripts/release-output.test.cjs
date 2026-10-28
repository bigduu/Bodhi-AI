"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync, spawnSync } = require("node:child_process");
const out = require("./release-output.cjs");
const finalizer = require("./release-finalizer-v2.cjs");
const { FEATURE_WORKFLOW_BLOB, CONTEXT_WORKFLOW_BLOB, LEGACY_FEATURE_WORKFLOW_BLOB, ADMISSION_SCHEMA, ADMISSION_KIND } = require("./release-source.cjs");
const C = "c".repeat(40), S = "a".repeat(40), T = "b".repeat(40);
const env = { GITHUB_REPOSITORY: out.REPOSITORY, RELEASE_VERSION: "2026.10.30", EXPECTED_SOURCE_SHA: S,
  GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2", GITHUB_WORKFLOW_SHA: C };
const ctx = out.context(env);
const clone = value => structuredClone(value);
const restored = [];
test.afterEach(() => {
  for (const destination of restored.splice(0)) {
    const owned = path.basename(destination) === "original" ? path.dirname(destination) : destination;
    fs.rmSync(owned, { recursive: true, force: true });
  }
});
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-original-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function fixture() {
  const proof = { schemaVersion: ADMISSION_SCHEMA, kind: ADMISSION_KIND, repository: out.REPOSITORY, source: S, tree: T, base: "d".repeat(40), head: "e".repeat(40), snapshot: "f".repeat(40),
    observedDev: S, currentDev: S, pullRequest: 17, runId: 20, attempt: 1, workflowBlob: FEATURE_WORKFLOW_BLOB,
    jobs: ["Unit Tests (Node)", ...out.NATIVE_TARGETS.map(target => `Unit and E2E (${target})`), "Unit Tests", "E2E Tests"]
      .map((name, index) => ({ id: index + 500, name, attempt: 1, logical: { id: index + 500, attempt: 1 } })) };
  const reservation = { schemaVersion: 2, kind: "bodhi-original-release", repository: out.REPOSITORY, source: S, tree: T,
    controller: C, version: ctx.version, runId: ctx.runId, preflight: { jobId: 10, attempt: 1 }, admission: proof,
    lockHashes: { "scripts/bamboo-sidecar-lock.json": "1".repeat(64), "scripts/frontend-package-lock.json": "2".repeat(64) },
    frontend: JSON.parse(fs.readFileSync(path.join(__dirname, "frontend-package-lock.json"))) };
  const job = (id, name, attempt, gates, active = false) => ({ id, name, run_id: ctx.runId, head_sha: C, run_attempt: attempt,
    status: active ? "in_progress" : "completed", conclusion: active ? null : "success", started_at: "2026-10-27T00:00:00Z",
    completed_at: active ? null : "2026-10-27T00:05:00Z", steps: gates.map((name, index) => ({ name, number: index + 1, status: "completed", conclusion: "success",
      started_at: new Date(Date.parse("2026-10-27T00:00:10Z") + index * 10000).toISOString(),
      completed_at: new Date(Date.parse("2026-10-27T00:00:15Z") + index * 10000).toISOString() })) });
  const jobs = [job(10, "Reserve admitted release", 1, [out.PREFLIGHT, out.RESERVATION]),
    ...out.NATIVE_TARGETS.map((target, index) => job(index + 11, `Build original (${target})`, index === 1 ? 2 : 1,
      ["Select retained target output", "Verify source and stamp reserved version", out.BUILD, out.CAPTURE, out.RETAIN])),
    job(14, "Publish original release", 2, [], true)];
  const f = { reservation, job, jobs, run: { id: ctx.runId, run_attempt: ctx.attempt, repository: { full_name: out.REPOSITORY },
    path: `${out.REPOSITORY}/.github/workflows/release.yml@refs/heads/main`, event: "workflow_dispatch", head_sha: C, head_branch: "main",
    display_title: `Bodhi v2 v${ctx.version} @ ${S}`, status: "in_progress", conclusion: null }, calls: [], artifacts: [], files: {}, manifestBytes: {}, uploads: [], tag: null };
  f.release = { id: 99, url: `https://api.github.com/repos/${out.REPOSITORY}/releases/99`, html_url: `https://github.com/${out.REPOSITORY}/releases/tag/${ctx.draftTag}`,
    upload_url: `https://uploads.github.com/repos/${out.REPOSITORY}/releases/99/assets{?name,label}`, draft: true, prerelease: false,
    target_commitish: S, tag_name: ctx.draftTag, body: JSON.stringify(reservation), assets: [] };
  const artifact = (id, name) => ({ id, name, expired: false, digest: `sha256:${String(id).padStart(64, "0")}`, size_in_bytes: 3000,
    created_at: "2026-10-27T00:04:00Z", workflow_run: { id: ctx.runId, head_sha: C } });
  f.artifacts.push(artifact(100, ctx.reservationName)); f.files[100] = { "reservation.json": out.bytes({ releaseId: 99, reservation }) };
  for (let index = 0; index < out.NATIVE_TARGETS.length; index++) {
    const target = out.NATIVE_TARGETS[index], originalJob = jobs[index + 1], contents = {};
    const files = out.names(ctx.version, target).map((name, fileIndex) => {
      const data = Buffer.alloc(1024 ** 2, index * 4 + fileIndex + 1); contents[name] = data;
      return { name, size: data.length, sha256: out.sha256(data) };
    });
    const receipt = { schemaVersion: 2, target, reservationSha256: out.sha256(out.bytes(reservation)), jobId: originalJob.id,
      attempt: originalJob.run_attempt, checks: out.checks(target), files };
    contents["target-receipt.json"] = out.bytes(receipt);
    f.artifacts.push(artifact(101 + index, out.artifactName(ctx, target, originalJob.run_attempt))); f.files[101 + index] = contents;
  }
  f.extraReleases = []; return f;
}
function adapters(f) {
  const request = (endpoint, method = "GET", body) => {
    f.calls.push({ endpoint, method, body }); if (f.failEndpoint === endpoint) throw new Error("GitHub unavailable (HTTP 503)");
    if (endpoint === `actions/runs/${ctx.runId}`) return clone(f.run);
    if (endpoint.startsWith(`actions/runs/${ctx.runId}/jobs?`)) return { total_count: f.jobs.length, jobs: clone(f.jobs) };
    if (endpoint.startsWith(`actions/runs/${ctx.runId}/artifacts?`)) return { total_count: f.artifacts.length, artifacts: clone(f.artifacts) };
    if (endpoint.startsWith("releases?")) return clone([...(f.release ? [f.release] : []), ...f.extraReleases]);
    if (endpoint === "releases" && method === "POST") {
      assert.equal(f.release, null); f.release = { ...fixture().release, ...clone(body) };
      if (f.lostCreate) throw new Error("lost create response"); return clone(f.release);
    }
    if (endpoint === "releases/99") {
      if (method === "PATCH") {
        if (f.patchWithoutCommit) throw new Error("PATCH failed before commit");
        Object.assign(f.release, clone(body)); f.tag = { object: { type: "commit", sha: S } };
        for (const asset of f.release.assets) asset.browser_download_url = `https://github.com/${out.REPOSITORY}/releases/download/${ctx.finalTag}/${asset.name}`;
        if (f.lostPatch) throw new Error("lost PATCH response");
      }
      return clone(f.release);
    }
    if (endpoint === `git/ref/tags/${ctx.finalTag}`) return clone(f.tag);
    if (endpoint === `git/ref/heads/release/${S}`) return f.frozen === null ? null : { object: { sha: f.frozen || S } };
    if (endpoint === `git/commits/${S}`) return f.tree === null ? null : { tree: { sha: f.tree || T } };
    if (endpoint === "branches/dev") return clone(f.branch || { protected: true, commit: { sha: f.dev || S }, protection: { required_status_checks: {
      enforcement_level: "everyone", contexts: ["Unit Tests", "E2E Tests"], checks: ["Unit Tests", "E2E Tests"].map(context => ({ context, app_id: 15368 })) } } });
    if (endpoint.startsWith("compare/")) {
      if (f.comparisons?.[endpoint]) return clone(f.comparisons[endpoint]);
      const [base, head] = endpoint.slice("compare/".length).split("...");
      return { status: base === head ? "identical" : "ahead", behind_by: 0, merge_base_commit: { sha: base } };
    }
    throw new Error(`Unexpected API call: ${method} ${endpoint}`);
  };
  const restore = (artifact, entries, destination) => {
    restored.push(destination);
    assert.ok(!fs.existsSync(destination)); fs.mkdirSync(destination, { recursive: true });
    const contents = f.files[artifact.id]; assert.ok(contents, "Missing retained bytes");
    assert.deepEqual(Object.keys(contents).sort(), [...entries].sort());
    for (const [name, data] of Object.entries(contents)) fs.writeFileSync(path.join(destination, name), data, { flag: "wx" });
  };
  const send = (release, file, name) => {
    f.uploads.push(name); const data = fs.readFileSync(file), id = 200 + f.release.assets.length;
    assert.ok(!f.release.assets.some(asset => asset.name === name));
    const asset = { id, name, size: data.length, digest: `sha256:${out.sha256(data)}`, state: "uploaded",
      url: `https://api.github.com/repos/${out.REPOSITORY}/releases/assets/${id}`,
      browser_download_url: `https://github.com/${out.REPOSITORY}/releases/download/${release.tag_name}/${name}` };
    f.release.assets.push(asset); f.manifestBytes[id] = data;
    if (f.lostUpload) throw new Error("lost upload response"); return clone(asset);
  };
  return { request, restore, send, read: id => JSON.parse(f.manifestBytes[id]) };
}
function assemble(t, f) {
  const a = adapters(f), root = directory(t);
  return finalizer.assemble(ctx, path.join(root, "evidence.json"), a.request, a.restore, a.send, a.read);
}
test("version reservation precedes every original build and binds separate controller/product", () => {
  const f = fixture(), a = adapters(f), { reservation } = f;
  f.release = null; f.jobs = [f.job(10, "Reserve admitted release", 2, [], true)]; f.artifacts = [];
  f.jobs.push({ name: "Build original (${{ matrix.target }})", status: "queued" });
  f.lostCreate = true;
  const result = finalizer.reserve(ctx, { lockHashes: reservation.lockHashes, frontend: reservation.frontend }, reservation.admission, a.request);
  assert.equal(result.releaseId, 99); assert.equal(result.reservation.controller, C); assert.equal(result.reservation.source, S);
  assert.equal(result.reservation.preflight.attempt, 2); assert.equal(f.release.assets.length, 0);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  assert.throws(() => finalizer.reserve(ctx, reservation, reservation.admission, a.request), /authenticated original reservation/);
});
test("a successful create waits for its exact release to appear in the list", () => {
  const f = fixture(), a = adapters(f), { reservation } = f;
  f.release = null; f.jobs = [f.job(10, "Reserve admitted release", 2, [], true)]; f.artifacts = [];
  let created = false, staleReads = 0;
  const waits = [];
  const request = (endpoint, method = "GET", body) => {
    if (created && endpoint.startsWith("releases?") && staleReads++ < 2) return [];
    const result = a.request(endpoint, method, body);
    if (endpoint === "releases" && method === "POST") created = true;
    return result;
  };
  const result = finalizer.reserve(ctx, { lockHashes: reservation.lockHashes, frontend: reservation.frontend }, reservation.admission, request, delay => waits.push(delay));
  assert.equal(result.releaseId, 99);
  assert.equal(result.reservation.source, S);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(f.calls.filter(call => call.endpoint === "releases/99" && call.method === "GET").length, 1);
});
test("a created reservation that stays invisible in the list fails without another create", () => {
  const f = fixture(), a = adapters(f), { reservation } = f;
  f.release = null; f.jobs = [f.job(10, "Reserve admitted release", 2, [], true)]; f.artifacts = [];
  let created = false;
  const waits = [];
  const request = (endpoint, method = "GET", body) => {
    if (created && endpoint.startsWith("releases?")) return [];
    const result = a.request(endpoint, method, body);
    if (endpoint === "releases" && method === "POST") created = true;
    return result;
  };
  assert.throws(() => finalizer.reserve(ctx, { lockHashes: reservation.lockHashes, frontend: reservation.frontend }, reservation.admission, request, delay => waits.push(delay)),
    /Version reservation was not retained/);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(f.release.tag_name, ctx.draftTag);
});
test("a lost create response is recovered only after the exact draft becomes visible", () => {
  const f = fixture(), a = adapters(f), { reservation } = f;
  f.release = null; f.jobs = [f.job(10, "Reserve admitted release", 2, [], true)]; f.artifacts = []; f.lostCreate = true;
  let created = false, staleReads = 0;
  const waits = [];
  const request = (endpoint, method = "GET", body) => {
    if (created && endpoint.startsWith("releases?") && staleReads++ < 2) return [];
    try { return a.request(endpoint, method, body); }
    finally { if (endpoint === "releases" && method === "POST" && f.release) created = true; }
  };
  const result = finalizer.reserve(ctx, { lockHashes: reservation.lockHashes, frontend: reservation.frontend }, reservation.admission, request, delay => waits.push(delay));
  assert.equal(result.releaseId, 99);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});
test("a conflicting release ID in the post-create list fails without another create", () => {
  const f = fixture(), a = adapters(f), { reservation } = f;
  f.release = null; f.jobs = [f.job(10, "Reserve admitted release", 2, [], true)]; f.artifacts = [];
  let created = false;
  const request = (endpoint, method = "GET", body) => {
    if (created && endpoint.startsWith("releases?")) return [{ ...clone(f.release), id: 100 }];
    const result = a.request(endpoint, method, body);
    if (endpoint === "releases" && method === "POST") created = true;
    return result;
  };
  assert.throws(() => finalizer.reserve(ctx, { lockHashes: reservation.lockHashes, frontend: reservation.frontend }, reservation.admission, request),
    /Created release ID differs from the version list/);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});
test("a previously reserved release absent from the version list fails closed", () => {
  const f = fixture(), a = adapters(f);
  const request = (endpoint, method = "GET", body) => endpoint.startsWith("releases?") ? [] : a.request(endpoint, method, body);
  assert.throws(() => finalizer.available(ctx, request, f.release, true), /original reservation is not visible/);
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});
test("a published release can be confirmed while its list still shows the same draft ID", () => {
  const f = fixture(), a = adapters(f);
  const published = { ...clone(f.release), draft: false, tag_name: ctx.finalTag };
  f.tag = { object: { type: "commit", sha: S } };
  assert.doesNotThrow(() => finalizer.available(ctx, a.request, published));
});
test("a created reservation that cannot be read by ID fails without another create", () => {
  const f = fixture(), a = adapters(f), { reservation } = f;
  f.release = null; f.jobs = [f.job(10, "Reserve admitted release", 2, [], true)]; f.artifacts = [];
  const waits = [];
  const request = (endpoint, method = "GET", body) => {
    const result = a.request(endpoint, method, body);
    return endpoint === "releases/99" && method === "GET" ? null : result;
  };
  assert.throws(() => finalizer.reserve(ctx, { lockHashes: reservation.lockHashes, frontend: reservation.frontend }, reservation.admission, request, delay => waits.push(delay)),
    /Created release could not be read back/);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(f.release.tag_name, ctx.draftTag);
});
test("a temporarily invisible created release is read by the same ID without another create", () => {
  const f = fixture(), a = adapters(f), { reservation } = f;
  f.release = null; f.jobs = [f.job(10, "Reserve admitted release", 2, [], true)]; f.artifacts = [];
  const waits = []; let reads = 0;
  const request = (endpoint, method = "GET", body) => {
    const result = a.request(endpoint, method, body);
    return endpoint === "releases/99" && method === "GET" && reads++ < 2 ? null : result;
  };
  const result = finalizer.reserve(ctx, { lockHashes: reservation.lockHashes, frontend: reservation.frontend }, reservation.admission, request, delay => waits.push(delay));
  assert.equal(result.releaseId, 99);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});
test("a concurrent different reservation is still rejected after direct readback", () => {
  const f = fixture(), a = adapters(f), { reservation } = f;
  f.release = null; f.jobs = [f.job(10, "Reserve admitted release", 2, [], true)]; f.artifacts = [];
  const request = (endpoint, method = "GET", body) => {
    const result = a.request(endpoint, method, body);
    if (endpoint === "releases" && method === "POST")
      f.extraReleases.push({ ...clone(f.release), id: 100, tag_name: `bodhi-v2-draft-v${ctx.version}-101` });
    return result;
  };
  assert.throws(() => finalizer.reserve(ctx, { lockHashes: reservation.lockHashes, frontend: reservation.frontend }, reservation.admission, request),
    /reserved by another release\/run/);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});
test("a visible conflicting reservation stops immediately while the original is absent", () => {
  const f = fixture(), a = adapters(f), { reservation } = f;
  f.release = null; f.jobs = [f.job(10, "Reserve admitted release", 2, [], true)]; f.artifacts = [];
  let created = false, reads = 0;
  const waits = [];
  const request = (endpoint, method = "GET", body) => {
    if (created && endpoint.startsWith("releases?") && reads++ === 0)
      return [{ ...clone(f.release), id: 100, tag_name: `bodhi-v2-draft-v${ctx.version}-101` }];
    const result = a.request(endpoint, method, body);
    if (endpoint === "releases" && method === "POST") created = true;
    return result;
  };
  assert.throws(() => finalizer.reserve(ctx, { lockHashes: reservation.lockHashes, frontend: reservation.frontend }, reservation.admission, request, delay => waits.push(delay)),
    /reserved by another release\/run/);
  assert.deepEqual(waits, []);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});
test("duplicate entries for the original reservation fail without another create", () => {
  const f = fixture(), a = adapters(f), { reservation } = f;
  f.release = null; f.jobs = [f.job(10, "Reserve admitted release", 2, [], true)]; f.artifacts = [];
  let created = false;
  const waits = [];
  const request = (endpoint, method = "GET", body) => {
    if (created && endpoint.startsWith("releases?")) return [clone(f.release), { ...clone(f.release), id: 100 }];
    const result = a.request(endpoint, method, body);
    if (endpoint === "releases" && method === "POST") created = true;
    return result;
  };
  assert.throws(() => finalizer.reserve(ctx, { lockHashes: reservation.lockHashes, frontend: reservation.frontend }, reservation.admission, request, delay => waits.push(delay)),
    /Ambiguous version reservation/);
  assert.deepEqual(waits, []);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});
for (const [field, value] of [["run_attempt", 1], ["head_sha", S], ["head_branch", "dev"], ["event", "push"],
  ["path", "foreign/Bodhi-AI/.github/workflows/release.yml@main"], ["display_title", `Bodhi v${ctx.version} @ ${S}`],
  ["status", "completed"], ["conclusion", "success"]]) test(`v2 run rejects different ${field}`, () => {
  const f = fixture(); f.run[field] = value; assert.throws(() => finalizer.originalRun(ctx, adapters(f).request));
});
test("v2 recovery keeps a new trusted controller distinct from the original producer", () => {
  const current = "9".repeat(40), values = { GITHUB_REPOSITORY: out.REPOSITORY, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `${out.REPOSITORY}/.github/workflows/recover-release.yml@refs/heads/main`, GITHUB_WORKFLOW_SHA: current, GITHUB_SHA: current };
  const git = (_root, ...args) => args[0] === "rev-parse" ? current : "";
  assert.equal(out.controller(true, values, out.ROOT, git), current);
  for (const [field, value] of [["GITHUB_SHA", S], ["GITHUB_REF", `refs/heads/release/${S}`],
    ["GITHUB_WORKFLOW_REF", `${out.REPOSITORY}/.github/workflows/release.yml@refs/heads/main`], ["GITHUB_EVENT_NAME", "pull_request"]])
    assert.throws(() => out.controller(true, { ...values, [field]: value }, out.ROOT, git));
  assert.equal(values.GITHUB_SHA, current);
});
test("reservation retains separate physical and latest logical feature identities", () => {
  const { reservation } = fixture(); reservation.admission.attempt = 2;
  reservation.admission.jobs[0].logical = { id: 900, attempt: 2 };
  const original = clone(reservation); out.verifyReservation(reservation, ctx); assert.deepEqual(reservation, original);
});
test("prepared Main consumer accepts the original context producer without changing its source schema", () => {
  const { reservation } = fixture(); reservation.admission.workflowBlob = CONTEXT_WORKFLOW_BLOB;
  out.verifyReservation(reservation, ctx);
});
test("passive run identity does not relax publisher/recovery state predicates", () => {
  const f = fixture(); f.run.status = "completed"; f.run.conclusion = "success";
  assert.deepEqual(out.runIdentity(ctx, f.run), f.run);
  assert.throws(() => out.run(ctx, adapters(f).request));
  assert.throws(() => out.run(ctx, adapters(f).request, true));
});
test("passive publication evidence verifies the original retained bytes without writing GitHub", t => {
  const f = fixture(), evidence = assemble(t, f), a = adapters(f), job = f.jobs.at(-1);
  job.status = "completed"; job.conclusion = "success"; job.completed_at = "2026-10-27T00:05:00Z";
  job.steps = [finalizer.ASSEMBLE, finalizer.EVIDENCE, finalizer.PUBLISH].map(name => ({ name, status: "completed", conclusion: "success" }));
  f.artifacts.push({ ...f.artifacts[0], id: 150, name: ctx.evidenceName }); f.files[150] = { "evidence.json": out.bytes(evidence) };
  const before = f.calls.length;
  assert.deepEqual(finalizer.publicationEvidence(ctx, job, f.release, a.request, a.restore).evidence, evidence);
  assert.ok(f.calls.slice(before).every(call => call.method === "GET"));
  f.files[150]["evidence.json"] = out.bytes({ ...evidence, manifestSha256: "0".repeat(64) });
  assert.throws(() => finalizer.publicationEvidence(ctx, job, f.release, a.request, a.restore));
});
for (const [label, mutate] of [
  ["historical source schema", value => { value.admission.schemaVersion = 1; delete value.admission.kind; }],
  ["foreign source proof kind", value => { value.admission.kind = "bodhi-main-bootstrap"; }],
  ["legacy producer", value => { value.admission.workflowBlob = LEGACY_FEATURE_WORKFLOW_BLOB; }],
  ["missing logical identity", value => { delete value.admission.jobs[0].logical; }],
  ["future logical attempt", value => { value.admission.jobs[0].logical.attempt = 2; }],
  ["physical after logical", value => { value.admission.jobs[0].attempt = 2; }],
  ["ambiguous logical job", value => { value.admission.jobs[1].logical = clone(value.admission.jobs[0].logical); }],
  ["different ID within one attempt", value => { value.admission.jobs[0].logical.id = 900; }],
  ["same ID under a later attempt", value => { value.admission.attempt = 2; value.admission.jobs[0].logical.attempt = 2; }],
]) test(`reservation refuses ${label} in feature provenance`, () => {
  const { reservation } = fixture(); mutate(reservation); assert.throws(() => out.verifyReservation(reservation, ctx));
});
for (const [label, mutate] of [
  ["legacy draft", f => f.extraReleases.push({ id: 88, tag_name: `bodhi-draft-v${ctx.version}-55-1` })],
  ["other v2 run", f => f.extraReleases.push({ id: 88, tag_name: `bodhi-v2-draft-v${ctx.version}-55` })],
  ["existing tag", f => { f.tag = { object: { type: "commit", sha: S } }; }],
  ["existing final release", f => f.extraReleases.push({ id: 88, tag_name: ctx.finalTag })],
]) test(`reservation refuses ${label} without a build or write`, () => {
  const f = fixture(); f.release = null; mutate(f); const a = adapters(f);
  assert.throws(() => finalizer.available(ctx, a.request)); assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});
test("independent successful targets from attempts 1/2 retain their exact immutable IDs and installer bytes", t => {
  const f = fixture(), a = adapters(f), reservation = out.loadReservation(ctx, a.request, a.restore).reservation;
  assert.deepEqual(reservation, f.reservation);
  const chosen = out.NATIVE_TARGETS.map(target => out.selectTarget(ctx, reservation, target, a.request, a.restore, true));
  assert.deepEqual(chosen.map(target => target.receipt.attempt), [1, 2, 1]);
  assert.deepEqual(chosen.map(target => target.artifact.id), [101, 102, 103]);
  assert.equal(chosen.flatMap(target => target.receipt.files).length, 6);
  assert.ok(chosen[1].receipt.files.some(file => file.name.endsWith(".rpm")));
  for (const item of chosen) t.after(() => fs.rmSync(path.dirname(item.directory), { recursive: true, force: true }));
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});
test("rerun-all target selectors reuse earlier siblings without another physical build", () => {
  const f = fixture(), target = out.NATIVE_TARGETS[0], a = adapters(f);
  f.jobs.push(f.job(31, `Build original (${target})`, 2, ["Select retained target output"]));
  const selected = out.selectTarget(ctx, f.reservation, target, a.request, a.restore, true);
  assert.equal(selected.receipt.jobId, 11); assert.equal(selected.receipt.attempt, 1); assert.equal(selected.artifact.id, 101);
});
test("observed GitHub failed-job retry projects the same successful execution under a new logical ID", () => {
  const recorded = require("./tests/fixtures/github-success-projection.json"), [original, projection] = recorded.jobs;
  assert.equal(recorded.runId, 40375990335); assert.equal(recorded.totalRows, 22);
  assert.equal(original.id, 121759187383); assert.equal(projection.id, 121813921707);
  assert.equal(original.started_at, "2026-10-26T18:14:55Z"); assert.equal(original.completed_at, "2026-10-26T18:18:14Z");
  assert.notEqual(original.runner_group_id, projection.runner_group_id);
  assert.equal(require("./release-source.cjs").executionOrigin(projection, recorded.jobs).id, original.id);
});
function targetProjection(f) {
  const original = f.jobs[1];
  original.steps.forEach((step, index) => Object.assign(step, { number: index + 1,
    started_at: "2026-10-27T00:01:00Z", completed_at: "2026-10-27T00:02:00Z" }));
  const projection = { ...clone(original), id: 31, run_attempt: 2 };
  f.jobs.push(projection); return projection;
}
test("server projection keeps the original physical receipt/job/attempt/artifact and verifies latest logical success", () => {
  const f = fixture(); targetProjection(f); const a = adapters(f);
  const original = out.selectTarget(ctx, f.reservation, out.NATIVE_TARGETS[0], a.request, a.restore, true);
  assert.equal(original.receipt.jobId, 11); assert.equal(original.receipt.attempt, 1); assert.equal(original.artifact.id, 101);
});
function selectorRetry(f) {
  const target = out.NATIVE_TARGETS[0], retry = out.context({ ...env, GITHUB_RUN_ATTEMPT: "3" });
  const failed = f.job(31, `Build original (${target})`, 2, ["Select retained target output", out.BUILD, out.CAPTURE, out.RETAIN]);
  failed.conclusion = "failure";
  failed.steps.forEach((step, index) => { step.conclusion = index === 0 ? "failure" : "skipped"; });
  const current = f.job(41, `Build original (${target})`, 3, ["Select retained target output"], true);
  Object.assign(current.steps[0], { status: "in_progress", conclusion: null, completed_at: null });
  current.steps.push({ name: out.BUILD, number: 2, status: "queued", conclusion: null });
  f.jobs.push(failed, current); f.run.run_attempt = 3;
  return { target, retry, failed, current };
}
test("active selector retry restores original bytes after an API-only selector failure; finalizer still waits for logical success", () => {
  const f = fixture(), { target, retry, current } = selectorRetry(f), a = adapters(f);
  const original = out.selectTarget(retry, f.reservation, target, a.request, a.restore);
  assert.equal(original.receipt.jobId, 11); assert.equal(original.receipt.attempt, 1); assert.equal(original.artifact.id, 101);
  assert.throws(() => out.selectTarget(retry, f.reservation, target, a.request, a.restore, true));
  current.status = "completed"; current.conclusion = "success"; current.completed_at = "2026-10-27T00:05:00Z";
  Object.assign(current.steps[0], { status: "completed", conclusion: "success", completed_at: "2026-10-27T00:02:00Z" });
  Object.assign(current.steps[1], { status: "completed", conclusion: "skipped" });
  const completed = out.selectTarget(retry, f.reservation, target, a.request, a.restore, true);
  assert.deepEqual(completed.receipt, original.receipt); assert.deepEqual(completed.artifact, original.artifact);
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});
for (const [label, mutate] of [
  ["missing active retry", (f, state) => f.jobs.pop()],
  ["inactive selector step", (f, state) => { state.current.steps[0].status = "queued"; }],
  ["current Build already running", (f, state) => { state.current.steps[1].status = "in_progress"; }],
  ["previous real Build failure", (f, state) => { state.failed.steps[1].conclusion = "failure"; }],
  ["previous unknown Build state", (f, state) => { state.failed.steps.splice(1, 1); }],
  ["second real physical Build", (f, state) => { state.failed.conclusion = "success"; state.failed.steps.forEach(step => { step.conclusion = "success"; }); }],
  ["missing original artifact", f => f.artifacts.splice(1, 1)],
]) test(`selector retry refuses ${label} rather than rebuilding or hiding a real failure`, () => {
  const f = fixture(), state = selectorRetry(f); mutate(f, state); const a = adapters(f);
  assert.throws(() => out.selectTarget(state.retry, f.reservation, state.target, a.request, a.restore));
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});
test("a later logical success cannot hide an intervening real Build failure", () => {
  const f = fixture(), { target, retry, failed, current } = selectorRetry(f), a = adapters(f);
  failed.steps[1].conclusion = "failure";
  current.status = "completed"; current.conclusion = "success"; current.steps = [clone(f.jobs[1].steps[0])];
  assert.throws(() => out.selectTarget(retry, f.reservation, target, a.request, a.restore, true));
});
for (const [label, mutate] of [
  ["latest failed logical job", (f, job) => { job.conclusion = "failure"; job.steps.find(step => step.name === out.BUILD).conclusion = "failure"; }],
  ["different real execution", (f, job) => { job.started_at = "2026-10-27T00:00:01Z"; }],
  ["different step execution", (f, job) => { job.steps[2].started_at = "2026-10-27T00:01:01Z"; }],
  ["missing real step time", (f, job) => { delete job.steps[2].started_at; }],
  ["same-attempt ambiguity", (f, job) => { job.run_attempt = 1; }],
  ["a second physical output", f => f.artifacts.push({ ...clone(f.artifacts[1]), id: 151, name: out.artifactName(ctx, out.NATIVE_TARGETS[0], 2) })],
]) test(`projection handling refuses ${label} without hiding a later build or failure`, () => {
  const f = fixture(), projection = targetProjection(f); mutate(f, projection); const a = adapters(f);
  for (const latest of [false, true]) assert.throws(() => out.selectTarget(ctx, f.reservation, out.NATIVE_TARGETS[0], a.request, a.restore, latest));
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});
for (const [label, mutate] of [
  ["missing successful output", f => f.artifacts.splice(1, 1)],
  ["expired output", f => { f.artifacts[1].expired = true; }],
  ["foreign run", f => { f.artifacts[1].workflow_run.id = 43; }],
  ["foreign controller", f => { f.artifacts[1].workflow_run.head_sha = S; }],
  ["missing immutable digest", f => { delete f.artifacts[1].digest; }],
  ["outside original job", f => { f.artifacts[1].created_at = "2026-10-28T00:00:00Z"; }],
  ["duplicate output", f => f.artifacts.push(clone(f.artifacts[1]))],
  ["missing retention gate", f => { f.jobs[1].steps.at(-1).conclusion = "failure"; }],
  ["failed original job", f => { f.jobs[1].conclusion = "failure"; }],
  ["second physical build", f => f.jobs.push(f.job(31, f.jobs[1].name, 2, [out.BUILD]))],
  ["foreign target receipt", f => { const r = JSON.parse(f.files[101]["target-receipt.json"]); r.target = out.NATIVE_TARGETS[1]; f.files[101]["target-receipt.json"] = out.bytes(r); }],
  ["foreign job receipt", f => { const r = JSON.parse(f.files[101]["target-receipt.json"]); r.jobId = 999; f.files[101]["target-receipt.json"] = out.bytes(r); }],
  ["foreign attempt receipt", f => { const r = JSON.parse(f.files[101]["target-receipt.json"]); r.attempt = 2; f.files[101]["target-receipt.json"] = out.bytes(r); }],
  ["foreign source reservation", f => { const r = JSON.parse(f.files[101]["target-receipt.json"]); r.reservationSha256 = "f".repeat(64); f.files[101]["target-receipt.json"] = out.bytes(r); }],
  ["changed installer", f => { f.files[101][Object.keys(f.files[101])[0]][0] ^= 1; }],
]) test(`original target selection refuses ${label}; never rebuilds or mutates`, () => {
  const f = fixture(); mutate(f); const a = adapters(f);
  assert.throws(() => out.selectTarget(ctx, f.reservation, out.NATIVE_TARGETS[0], a.request, a.restore));
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});
test("a failed build with no successful build output may retry; successful Build with no receipt may not", () => {
  const f = fixture(), a = adapters(f), target = out.NATIVE_TARGETS[0];
  f.jobs[1].steps.find(step => step.name === out.BUILD).conclusion = "failure"; f.jobs[1].conclusion = "failure"; f.artifacts.splice(1, 1);
  assert.equal(out.selectTarget(ctx, f.reservation, target, a.request, a.restore), null);
  f.jobs[1].steps.find(step => step.name === out.BUILD).conclusion = "success";
  assert.throws(() => out.selectTarget(ctx, f.reservation, target, a.request, a.restore));
});
for (const [label, mutate] of [
  ["moved frozen source", f => { f.frozen = C; }], ["changed source tree", f => { f.tree = C; }],
  ["preflight evidence missing", f => f.artifacts.shift()], ["preflight evidence expired", f => { f.artifacts[0].expired = true; }],
  ["preflight evidence changed", f => { f.files[100]["reservation.json"] = out.bytes({ releaseId: 99, reservation: { ...f.reservation, source: C } }); }],
  ["unretained preflight", f => { f.jobs[0].steps.at(-1).conclusion = "skipped"; }],
]) test(`source-bound reservation refuses ${label}`, () => {
  const f = fixture(); mutate(f); const a = adapters(f); assert.throws(() => out.loadReservation(ctx, a.request, a.restore));
});
test("finalization uploads all six originals plus manifest; ambiguous upload and PATCH responses read back same IDs", t => {
  const f = fixture(); f.lostUpload = true; f.lostPatch = true;
  const evidence = assemble(t, f), a = adapters(f), before = clone(evidence.assets);
  assert.equal(f.uploads.length, 7); assert.equal(evidence.manifest.reservation.controller, C); assert.equal(evidence.manifest.reservation.source, S);
  const release = finalizer.publish(ctx, evidence, a.request);
  assert.equal(release.id, 99); assert.equal(release.target_commitish, S); assert.equal(release.tag_name, ctx.finalTag);
  finalizer.verifyPublished(ctx, release, evidence.manifest);
  finalizer.publish(ctx, evidence, a.request);
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
  assert.deepEqual(evidence.assets, before); assert.equal(f.uploads.length, 7);
});
test("same-run finalizer retry retains existing asset IDs and original manifest attempt", t => {
  const f = fixture(), first = assemble(t, f), a = adapters(f);
  const output = path.join(directory(t), "evidence.json");
  const second = finalizer.assemble(ctx, output, a.request, a.restore, a.send, a.read);
  assert.deepEqual(second, first); assert.equal(f.uploads.length, 7);
});
test("a later finalizer attempt reuses earlier native outputs and the first immutable manifest", t => {
  const f = fixture(), first = assemble(t, f), a = adapters(f), next = out.context({ ...env, GITHUB_RUN_ATTEMPT: "3" });
  f.jobs.at(-1).status = "completed"; f.jobs.at(-1).conclusion = "failure"; f.jobs.at(-1).completed_at = "2026-10-27T00:05:00Z";
  f.jobs.push(f.job(24, "Publish original release", 3, [], true)); f.run.run_attempt = 3;
  const second = finalizer.assemble(next, path.join(directory(t), "evidence.json"), a.request, a.restore, a.send, a.read);
  assert.equal(second.finalizerAttempt, 3); assert.equal(second.manifest.finalizer.attempt, 2);
  assert.deepEqual(second.manifest, first.manifest); assert.equal(f.uploads.length, 7);
  finalizer.publish(next, second, a.request);
});
for (const [label, mutate] of [
  ["asset digest", f => { f.release.assets[0].digest = `sha256:${"0".repeat(64)}`; }],
  ["asset size", f => { f.release.assets[0].size++; }], ["asset ID", f => { f.release.assets[0].id++; }],
  ["source", f => { f.release.target_commitish = C; }], ["foreign asset", f => f.release.assets.push(clone(f.release.assets[0]))],
  ["reservation lock", f => { const value = JSON.parse(f.release.body); value.lockHashes["scripts/frontend-package-lock.json"] = "f".repeat(64); f.release.body = JSON.stringify(value); }],
  ["reservation PR", f => { const value = JSON.parse(f.release.body); value.admission.pullRequest++; f.release.body = JSON.stringify(value); }],
  ["final tag occupied", f => { f.tag = { object: { type: "commit", sha: C } }; }],
]) test(`publication refuses changed ${label} without replacement or PATCH`, t => {
  const f = fixture(), evidence = assemble(t, f); mutate(f); const a = adapters(f);
  assert.throws(() => finalizer.publish(ctx, evidence, a.request));
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 0); assert.equal(f.uploads.length, 7);
});
test("conflicting pre-existing installer is refused, never deleted/replaced", t => {
  const f = fixture(), a = adapters(f), root = directory(t), targetFile = Object.keys(f.files[101])[0], file = path.join(root, targetFile);
  fs.writeFileSync(file, f.files[101][targetFile]); a.send(f.release, file, targetFile); f.release.assets[0].digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => finalizer.assemble(ctx, path.join(root, "evidence.json"), a.request, a.restore, a.send, a.read), /Conflicting original asset/);
  assert.equal(f.uploads.length, 1); assert.equal(f.calls.filter(call => ["PATCH", "DELETE"].includes(call.method)).length, 0);
});
test("read-only recovery requires the exact failed finalizer/evidence attempt and retains mixed native attempts", t => {
  const f = fixture(), evidence = assemble(t, f), a = adapters(f);
  f.run.status = "completed"; f.run.conclusion = "failure";
  const job = f.jobs.at(-1); job.status = "completed"; job.conclusion = "failure"; job.completed_at = "2026-10-27T00:05:00Z";
  job.steps = [finalizer.ASSEMBLE, finalizer.EVIDENCE, finalizer.PUBLISH].map((name, index) => ({ name, status: "completed", conclusion: index === 2 ? "failure" : "success" }));
  f.artifacts.push({ ...f.artifacts[0], id: 150, name: ctx.evidenceName }); f.files[150] = { "evidence.json": out.bytes(evidence) };
  const original = finalizer.recoveryArtifact({ ...ctx, controller: "9".repeat(40) }, a.request);
  assert.equal(original.ctx.controller, C); assert.equal(original.artifact.id, 150);
  f.lostPatch = true; finalizer.publish(original.ctx, evidence, a.request); finalizer.publish(original.ctx, evidence, a.request);
  assert.deepEqual(evidence.manifest.targets.map(target => target.receipt.attempt), [1, 2, 1]);
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
  job.steps[0].conclusion = "failure"; assert.throws(() => finalizer.recoveryArtifact(ctx, a.request));
});
test("lost publication before commit stops; retry uses originals and performs one later PATCH", t => {
  const f = fixture(), evidence = assemble(t, f), a = adapters(f); f.patchWithoutCommit = true;
  assert.throws(() => finalizer.publish(ctx, evidence, a.request), /before commit/);
  f.patchWithoutCommit = false; finalizer.publish(ctx, evidence, a.request);
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 2); assert.equal(f.uploads.length, 7);
});
for (const [label, mutate] of [
  ["frozen ref moved", f => { f.frozen = C; }],
  ["frozen ref missing", f => { f.frozen = null; }],
  ["source tree changed", f => { f.tree = C; }],
  ["dev protection lost", f => { f.branch = { protected: false, commit: { sha: S } }; }],
  ["required checks removed", f => { f.branch = { protected: true, commit: { sha: S }, protection: { required_status_checks: { enforcement_level: "everyone", contexts: [], checks: [] } } }; }],
  ["dev source ancestry changed", f => { f.dev = C; f.comparisons = { [`compare/${S}...${C}`]: { status: "diverged", behind_by: 1, merge_base_commit: { sha: "9".repeat(40) } } }; }],
  ["frozen ref API unknown", f => { f.failEndpoint = `git/ref/heads/release/${S}`; }],
  ["dev API unknown", f => { f.failEndpoint = "branches/dev"; }],
  ["source tree API unknown", f => { f.failEndpoint = `git/commits/${S}`; }],
  ["ancestry API unknown", f => { f.failEndpoint = `compare/${S}...${S}`; }],
]) test(`publication freshness refuses ${label} after assembly/evidence, before any PATCH`, t => {
  const f = fixture(), evidence = assemble(t, f), original = clone(evidence.manifest.reservation), a = adapters(f);
  mutate(f); assert.throws(() => finalizer.publish(ctx, evidence, a.request));
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 0); assert.equal(f.uploads.length, 7);
  assert.deepEqual(evidence.manifest.reservation, original);
});
test("publication allows normal protected-dev advancement without rewriting original admission", t => {
  const f = fixture(), evidence = assemble(t, f), original = clone(evidence.manifest.reservation), a = adapters(f); f.dev = C;
  finalizer.publish(ctx, evidence, a.request); assert.deepEqual(evidence.manifest.reservation, original);
  assert.equal(JSON.parse(f.release.body).admission.currentDev, S);
});
test("publication rejects a rewritten dev descendant even when S remains an ancestor", t => {
  const f = fixture(), acceptedDev = "d".repeat(40), nextDev = "e".repeat(40);
  f.reservation.admission.currentDev = acceptedDev; f.release.body = JSON.stringify(f.reservation);
  f.files[100]["reservation.json"] = out.bytes({ releaseId: 99, reservation: f.reservation });
  for (const id of [101, 102, 103]) {
    const receipt = JSON.parse(f.files[id]["target-receipt.json"]); receipt.reservationSha256 = out.sha256(out.bytes(f.reservation));
    f.files[id]["target-receipt.json"] = out.bytes(receipt);
  }
  const evidence = assemble(t, f), a = adapters(f); f.dev = nextDev;
  f.comparisons = { [`compare/${acceptedDev}...${nextDev}`]: { status: "diverged", behind_by: 1, merge_base_commit: { sha: S } } };
  assert.throws(() => finalizer.publish(ctx, evidence, a.request), /rewritten/);
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 0); assert.equal(f.uploads.length, 7);
});
test("publication requires the exact retained evidence artifact before PATCH", t => {
  const f = fixture(), evidence = assemble(t, f), a = adapters(f), job = f.jobs.at(-1);
  job.steps = [finalizer.ASSEMBLE, finalizer.EVIDENCE].map(name => ({ name, status: "completed", conclusion: "success" }));
  job.started_at = new Date(Date.now() - 60000).toISOString();
  f.artifacts.push({ ...f.artifacts[0], id: 150, name: ctx.evidenceName, created_at: new Date(Date.now() - 1000).toISOString() }); f.files[150] = { "evidence.json": out.bytes(evidence) };
  assert.equal(finalizer.retainedEvidence(ctx, evidence, a.request, a.restore).id, 150);
  f.files[150]["evidence.json"] = out.bytes({ ...evidence, finalizerAttempt: 1 });
  assert.throws(() => finalizer.retainedEvidence(ctx, evidence, a.request, a.restore), /evidence differs/);
  f.artifacts.pop(); assert.throws(() => finalizer.retainedEvidence(ctx, evidence, a.request, a.restore), /artifact missing/);
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 0);
});
test("API failures never become absence or a new build/version", () => {
  const f = fixture(), a = adapters(f); f.failEndpoint = `git/ref/tags/${ctx.finalTag}`;
  assert.throws(() => finalizer.available(ctx, a.request), /unavailable/);
  f.failEndpoint = `actions/runs/${ctx.runId}`; assert.throws(() => finalizer.originalRun(ctx, a.request), /unavailable/);
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});
test("temporary version stamping updates only the local app metadata and package lock", t => {
  const root = directory(t); fs.mkdirSync(path.join(root, "src-tauri"));
  const cargo = '[package]\nname = "bodhi"\nversion = "0.0.0"\n', lock = 'version = 4\n[[package]]\nname = "bodhi"\nversion = "0.0.0"\n[[package]]\nname = "other"\nversion = "0.0.0"\n';
  fs.writeFileSync(path.join(root, "src-tauri/Cargo.toml"), cargo); fs.writeFileSync(path.join(root, "Cargo.lock"), lock);
  fs.writeFileSync(path.join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.0.0", build: { beforeBuildCommand: "hook" } }));
  out.stamp(root, ctx.version);
  assert.match(fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8"), /version = "2026\.10\.30"/);
  assert.match(fs.readFileSync(path.join(root, "Cargo.lock"), "utf8"), /name = "other"\nversion = "0\.0\.0"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"))).build.beforeBuildCommand, "hook");
  assert.throws(() => out.stamp(root, ctx.version));
});
test("actual immutable ZIP adapter checks raw digest and flat entry set before restoring original bytes", t => {
  const root = directory(t), input = path.join(root, "input"); fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, "target-receipt.json"), '{"schemaVersion":2}\n'); fs.writeFileSync(path.join(input, "original.rpm"), Buffer.alloc(1024 ** 2, 7));
  const zip = path.join(root, "original.zip"); execFileSync("zip", ["-q", zip, "target-receipt.json", "original.rpm"], { cwd: input, env: out.childEnv() });
  // The child receives only adapter-specific data, never the host publisher/tunnel environment.
  const gh = path.join(root, "gh"); fs.writeFileSync(gh, `#!/bin/sh\nexec /bin/cat '${zip.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = root + path.delimiter + oldPath;
  try {
    const artifact = { id: 101, digest: `sha256:${out.hashFile(zip)}` }, entries = ["target-receipt.json", "original.rpm"];
    const output = path.join(root, "restored"); out.download(artifact, entries, output);
    assert.equal(out.hashFile(path.join(output, "original.rpm")), out.hashFile(path.join(input, "original.rpm")));
    assert.throws(() => out.download({ ...artifact, digest: `sha256:${"0".repeat(64)}` }, entries, path.join(root, "bad-digest")), /ZIP digest differs/);
    assert.throws(() => out.download(artifact, ["target-receipt.json"], path.join(root, "bad-entries")), /flat file set/);
    assert.throws(() => out.download(artifact, entries, output), /must be new/);
  } finally { process.env.PATH = oldPath; }
});
test("subprocess credential scope excludes unrelated publisher and host secrets", () => {
  assert.deepEqual(out.childEnv({ PATH: "/bin", HOME: "/home", GH_TOKEN: "needed", GITHUB_TOKEN: "unused", NPM_TOKEN: "unused", HOST_TUNNEL_TOKEN: "unused" }),
    { PATH: "/bin", HOME: "/home", GH_TOKEN: "needed" });
});
test("static verification reads immutable S browser-lock data with C code, never an S module", t => {
  const root = directory(t), lock = { schemaVersion: 1, nodeVersion: "99.0.0" }, calls = [];
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts/browser-runtime.cjs"), "throw Error('S code must never execute');\n");
  const sandbox = { module: { exports: {} }, __dirname, process, console, Buffer, require(name) {
    if (name === "node:child_process") return { execFileSync(program, args, options) {
      assert.equal(program, "git"); assert.deepEqual(Array.from(args), ["show", `${S}:scripts/browser-runtime.lock.json`]);
      assert.equal(options.cwd, root); assert.equal(options.maxBuffer, 128 * 1024); return JSON.stringify(lock);
    } };
    if (name === "./lotus-dist.cjs") return { resolveSource(_env, checkout) { assert.equal(checkout, root); return {}; }, verifyStaged() { return {}; } };
    if (name === "./bamboo-sidecar.cjs") return { installedRelease(checkout) { assert.equal(checkout, root); return { hostDirectory: "selected-host" }; } };
    if (name === "./browser-runtime.cjs") return { verifyRuntime(runtime, target, source, selected) {
      calls.push({ runtime, target, source, selected }); throw Error("fixture stops after lock binding");
    } };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "release-output.cjs"), "utf8"), sandbox);
  assert.throws(() => sandbox.module.exports.staticOutputs(root, ctx, out.NATIVE_TARGETS[1], root), /after lock binding/);
  assert.equal(calls.length, 1); assert.equal(calls[0].source, "selected-host");
  assert.equal(JSON.stringify(calls[0].selected), JSON.stringify(lock));
});
test("actual CLI keeps real Git controller/source identities and stamps only the disposable product checkout", t => {
  const root = directory(t), controller = path.join(root, "controller"), product = path.join(root, "product"), bin = path.join(root, "bin");
  fs.mkdirSync(controller); fs.mkdirSync(product); fs.mkdirSync(bin);
  fs.cpSync(__dirname, path.join(controller, "scripts"), { recursive: true, filter: file => !file.includes("node_modules") });
  fs.mkdirSync(path.join(product, "scripts")); fs.mkdirSync(path.join(product, "src-tauri"));
  for (const name of ["bamboo-sidecar-lock.json", "frontend-package-lock.json"]) fs.copyFileSync(path.join(__dirname, name), path.join(product, "scripts", name));
  fs.writeFileSync(path.join(product, "src-tauri/Cargo.toml"), '[package]\nname = "bodhi"\nversion = "0.0.0"\n');
  fs.writeFileSync(path.join(product, "src-tauri/tauri.conf.json"), '{"version":"0.0.0"}\n');
  fs.writeFileSync(path.join(product, "Cargo.lock"), 'version = 4\n[[package]]\nname = "bodhi"\nversion = "0.0.0"\n');
  const gitEnv = { ...out.childEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
  for (const cwd of [controller, product]) {
    git(cwd, "init", "--quiet"); git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  }
  const actualC = git(controller, "rev-parse", "HEAD"), actualS = git(product, "rev-parse", "HEAD"), actualT = git(product, "rev-parse", "HEAD^{tree}");
  const f = fixture();
  const changed = JSON.parse(JSON.stringify({ run: f.run, jobs: f.jobs, release: f.release, artifacts: f.artifacts, reservation: f.reservation })
    .replaceAll(C, actualC).replaceAll(S, actualS).replaceAll(T, actualT));
  const actualCtx = { ...ctx, source: actualS, controller: actualC };
  for (const file of Object.keys(changed.reservation.lockHashes)) changed.reservation.lockHashes[file] = out.sha256(fs.readFileSync(path.join(product, file)));
  changed.release.body = JSON.stringify(changed.reservation);
  const contents = { "reservation.json": out.bytes({ releaseId: 99, reservation: changed.reservation }) };
  const mac = JSON.parse(f.files[101]["target-receipt.json"]); mac.reservationSha256 = out.sha256(out.bytes(changed.reservation));
  const macContents = { ...f.files[101], "target-receipt.json": out.bytes(mac) };
  changed.zip = {};
  for (const [id, files] of [[100, contents], [101, macContents]]) {
    const input = path.join(root, `zip-${id}`); fs.mkdirSync(input);
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(input, name), data);
    const archive = path.join(root, `${id}.zip`); execFileSync("zip", ["-q", archive, ...Object.keys(files)], { cwd: input, env: out.childEnv() });
    changed.zip[id] = archive; changed.artifacts.find(artifact => artifact.id === id).digest = `sha256:${out.hashFile(archive)}`;
  }
  const state = path.join(root, "github.json"); fs.writeFileSync(state, JSON.stringify(changed));
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
const fs=require('node:fs'), f=JSON.parse(fs.readFileSync(${JSON.stringify(state)}));
if(process.env.HOST_TUNNEL_TOKEN || process.env.NPM_TOKEN) throw Error('unrelated credentials inherited');
const endpoint=process.argv.find(v=>v.startsWith('repos/')).slice('repos/${out.REPOSITORY}/'.length);
if(endpoint.endsWith('/zip')) { process.stdout.write(fs.readFileSync(f.zip[endpoint.split('/')[2]])); process.exit(0); }
let result;
if(endpoint==='actions/runs/42') result=f.run;
else if(endpoint.includes('/jobs?')) result={total_count:f.jobs.length,jobs:f.jobs};
else if(endpoint.includes('/artifacts?')) result={total_count:f.artifacts.length,artifacts:f.artifacts};
else if(endpoint.startsWith('releases?')) result=[f.release];
else if(endpoint==='releases/99') result=f.release;
else if(endpoint==='git/ref/heads/release/${actualS}') result={object:{sha:${JSON.stringify(actualS)}}};
else if(endpoint==='git/commits/${actualS}') result={tree:{sha:${JSON.stringify(actualT)}}};
else throw Error('unexpected endpoint '+endpoint);
process.stdout.write(JSON.stringify(result));\n`, { mode: 0o700 });
  const output = path.join(root, "outputs"), cliEnv = { ...out.childEnv({ PATH: bin + path.delimiter + process.env.PATH, HOME: process.env.HOME, TMPDIR: root }), ...env,
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_WORKFLOW_REF: `${out.REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: actualC, GITHUB_SHA: actualC, EXPECTED_SOURCE_SHA: actualS, SOURCE_ROOT: product, GITHUB_OUTPUT: output,
    HOST_TUNNEL_TOKEN: "fixture-unused", NPM_TOKEN: "fixture-unused" };
  const run = command => spawnSync(process.execPath, [path.join(controller, "scripts/release-output.cjs"), command, out.NATIVE_TARGETS[0]],
    { cwd: controller, env: cliEnv, encoding: "utf8" });
  const plan = run("plan"); assert.equal(plan.status, 0, plan.stderr); assert.match(fs.readFileSync(output, "utf8"), /^reuse=true\n/);
  const prepare = run("prepare"); assert.equal(prepare.status, 0, prepare.stderr);
  assert.equal(git(product, "rev-parse", "HEAD"), actualS); assert.equal(git(controller, "rev-parse", "HEAD"), actualC);
  assert.equal(git(controller, "status", "--porcelain"), ""); assert.equal(cliEnv.GITHUB_SHA, actualC);
  assert.equal(JSON.parse(fs.readFileSync(path.join(product, "src-tauri/tauri.conf.json"))).version, actualCtx.version);
});
test("release/recovery graph has one build owner, no release runtime tests, explicit legacy recovery and unchanged locks", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/release.yml"), "utf8");
  const recovery = fs.readFileSync(path.join(__dirname, "../.github/workflows/recover-release.yml"), "utf8");
  const native = workflow.slice(workflow.indexOf("  publish-tauri:"), workflow.indexOf("  finalize:"));
  const finalization = workflow.slice(workflow.indexOf("  finalize:"));
  assert.equal((workflow.match(/npm run tauri:build/g) || []).length, 1);
  assert.doesNotMatch(workflow, /cargo test|test:build|sidecar-bundle-smoke|browser-bundle-smoke|npm run web:build|scripts\/bamboo-sidecar\.cjs install|tauri-apps\/tauri-action/);
  assert.doesNotMatch(native, /contents: write|GITHUB_TOKEN:/); assert.match(native, /bundles: appimage,deb,rpm/);
  assert.doesNotMatch(finalization, /working-directory: product|cargo |npm |tauri:build/);
  for (const name of [out.PREFLIGHT, out.RESERVATION, out.BUILD, out.CAPTURE, out.RETAIN, finalizer.ASSEMBLE, finalizer.EVIDENCE, finalizer.PUBLISH]) assert.ok(workflow.includes(`- name: ${name}`));
  assert.ok(workflow.includes("ref: ${{ github.workflow_sha }}")); assert.ok(workflow.includes("ref: ${{ inputs.expected_source_sha }}"));
  assert.doesNotMatch(workflow + recovery, /GITHUB_SHA:\s|export GITHUB_SHA|GITHUB_WORKFLOW_SHA:\s/);
  for (const body of [workflow, recovery]) assert.match(body, /group: bodhi-release-\$\{\{ inputs.bodhi_version \}\}\n  cancel-in-progress: false/);
  assert.match(recovery, /if: inputs\.evidence_schema == '1'/); assert.match(recovery, /if: inputs\.evidence_schema == '2'/);
  assert.match(recovery, /scripts\/release-finalizer\.cjs recover/); assert.match(recovery, /scripts\/release-finalizer-v2\.cjs recover/);
  assert.equal(out.NATIVE_TARGETS.length, 3); assert.equal(out.NATIVE_TARGETS.flatMap(target => out.names(ctx.version, target)).length, 6);
});
