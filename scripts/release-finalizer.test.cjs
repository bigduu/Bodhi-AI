"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync, spawnSync } = require("node:child_process");
const finalizer = require("./release-finalizer.cjs");
const { NATIVE_TARGETS } = finalizer;
const env = { GITHUB_REPOSITORY: "bigduu/Bodhi-AI", RELEASE_VERSION: "2026.10.17", EXPECTED_SOURCE_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1" };
const ctx = finalizer.context(env);

function fixture(recovery = false) {
  const run = { id: ctx.runId, run_attempt: ctx.attempt, repository: { full_name: ctx.repository },
    path: ".github/workflows/release.yml", event: "workflow_dispatch", head_sha: ctx.source,
    display_title: `Bodhi v${ctx.version} @ ${ctx.source}`, status: recovery ? "completed" : "in_progress", conclusion: recovery ? "failure" : null };
  const job = (name, names, conclusion = "success") => ({ name, head_sha: ctx.source, run_attempt: ctx.attempt,
    status: conclusion === null ? "in_progress" : "completed", conclusion, steps: names.map((name) => ({ name, conclusion: "success" })) });
  const jobs = [job("Validate independent release", ["Validate source, locked inputs and unused version"]),
    ...NATIVE_TARGETS.map((target) => job(`Build Bodhi (${target})`, finalizer.NATIVE_GATES)),
    job("Publish fully verified release", finalizer.FINALIZER_GATES, recovery ? "failure" : null)];
  if (recovery) jobs.at(-1).steps.push({ name: "Publish the completed draft", conclusion: "failure" });
  const version = ctx.version;
  const names = [`Bodhi.AI-${version}-1.x86_64.rpm`, `Bodhi.AI_${version}_aarch64.dmg`, `Bodhi.AI_${version}_amd64.AppImage`,
    `Bodhi.AI_${version}_amd64.deb`, `Bodhi.AI_${version}_x64-setup.exe`,
    "Bodhi.AI_aarch64.app.tar.gz"];
  const draft = { id: 99, url: `https://api.github.com/repos/${ctx.repository}/releases/99`, draft: true,
    prerelease: false, tag_name: ctx.draftTag, target_commitish: ctx.source,
    assets: names.map((name, index) => ({ id: index + 1, name, state: "uploaded", size: 2e6,
      digest: `sha256:${"b".repeat(64)}`, url: `https://api.github.com/repos/${ctx.repository}/releases/assets/${index + 1}`,
      browser_download_url: `https://github.com/${ctx.repository}/releases/download/untagged-abcdef/${name}` })) };
  const artifact = { id: 123, name: ctx.evidenceName, expired: false, size_in_bytes: 1000,
    workflow_run: { id: ctx.runId, head_sha: ctx.source } };
  return { run, jobs, draft, artifacts: [artifact], calls: [], otherReleases: [] };
}

function mockApi(f) {
  let reads = 0;
  return (endpoint, method = "GET", body) => {
    f.calls.push({ endpoint, method, body });
    if (f.apiFailure === endpoint) throw new Error("GitHub unavailable (HTTP 503)");
    const prefix = `actions/runs/${ctx.runId}/attempts/${ctx.attempt}`;
    if (endpoint === prefix) return structuredClone(f.run);
    if (endpoint === `${prefix}/jobs?per_page=100`) return { total_count: f.jobs.length, jobs: structuredClone(f.jobs) };
    if (endpoint.startsWith(`actions/runs/${ctx.runId}/artifacts?`)) return { artifacts: structuredClone(f.artifacts) };
    if (endpoint.startsWith("releases?")) return structuredClone([f.draft, ...f.otherReleases]);
    if (endpoint === "releases/99" && method === "GET") {
      reads++;
      if (f.failReadback && !f.draft.draft) throw new Error("GET failed (HTTP 503)");
      const observed = structuredClone(f.draft);
      if (f.tamperAtRead === reads) observed.assets[0].digest = `sha256:${"c".repeat(64)}`;
      return observed;
    }
    if (endpoint === "releases/99" && method === "PATCH") {
      if (f.patchWithoutCommit) throw new Error("PATCH unavailable (HTTP 503)");
      Object.assign(f.draft, body);
      for (const asset of f.draft.assets) asset.browser_download_url = `https://github.com/${ctx.repository}/releases/download/${ctx.finalTag}/${asset.name}`;
      f.draft.html_url = `https://github.com/${ctx.repository}/releases/tag/${ctx.finalTag}`;
      if (f.losePatchResponse) throw new Error("PATCH response lost (HTTP 500)");
      return structuredClone(f.draft);
    }
    if (endpoint === `git/ref/tags/${ctx.finalTag}`) return f.existingTag || (!f.draft.draft ? { object: { type: "commit", sha: ctx.source } } : null);
    throw new Error(`Unexpected GitHub request: ${method} ${endpoint}`);
  };
}
const patches = (f) => f.calls.filter((call) => call.method === "PATCH");

for (const [name, value] of [["missing", ""], ["moving latest", "latest"], ["placeholder", "0.0.0"],
  ["padded month", "2026.01.1"], ["invalid month", "2026.13.1"], ["zero counter", "2026.10.0"],
  ["installer overflow", "2026.10.65536"], ["shell input", "2026.10.17$(false)"]]) {
  test(`explicit Bodhi version rejects ${name}`, () => assert.throws(() => finalizer.context({ ...env, RELEASE_VERSION: value })));
}
test("release context binds exact SHA and immutable original run/attempt", () => {
  assert.equal(ctx.draftTag, "bodhi-draft-v2026.10.17-42-1");
  for (const overrides of [{ EXPECTED_SOURCE_SHA: "main" }, { EXPECTED_SOURCE_SHA: "A".repeat(40) },
    { GITHUB_REPOSITORY: "bigduu/Zenith" }, { GITHUB_RUN_ID: "1;false" }, { GITHUB_RUN_ATTEMPT: "0" }]) {
    assert.throws(() => finalizer.context({ ...env, ...overrides }));
  }
  assert.equal(finalizer.context({ ...env, ORIGINAL_RELEASE_RUN_ID: "42", ORIGINAL_RELEASE_ATTEMPT: "1", GITHUB_RUN_ATTEMPT: "2" }).attempt, 1);
});

test("source preflight requires exact clean checkout and both committed artifact locks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-release-source-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    for (const name of ["bamboo-sidecar-lock.json", "frontend-package-lock.json"]) fs.copyFileSync(path.join(__dirname, name), path.join(root, "scripts", name));
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const source = git("rev-parse", "HEAD"), current = { ...ctx, source };
    const selected = { ...env, GITHUB_SHA: source };
    assert.equal(finalizer.requireSource(current, selected, root).packageName, "@bigduu/lotus-next");
    assert.throws(() => finalizer.requireSource(current, { ...selected, GITHUB_SHA: "b".repeat(40) }, root));
    assert.throws(() => finalizer.requireSource(ctx, { ...selected, GITHUB_SHA: ctx.source }, root));
    fs.writeFileSync(path.join(root, "untracked"), "dirty");
    assert.throws(() => finalizer.requireSource(current, selected, root), /clean/);
    fs.rmSync(path.join(root, "untracked"));
    assert.throws(() => finalizer.requireSource(current, { ...selected, BAMBOO_RELEASE_VERSION: "latest" }, root), /sidecar lock/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("original native build evidence is sufficient for snapshot and finalizer-only recovery", () => {
  const normal = fixture();
  const receipt = finalizer.snapshot(ctx, mockApi(normal));
  assert.equal(receipt.releaseId, 99);
  assert.equal(receipt.attempt, 1);
  assert.equal(receipt.assets.length, 6);
  const recovery = fixture(true);
  assert.equal(finalizer.recoveryArtifact(ctx, mockApi(recovery)), 123);
});
for (const recovery of [false, true]) {
  const phase = recovery ? "recovery" : "normal finalization";
  const verify = (f) => recovery ? finalizer.recoveryArtifact(ctx, mockApi(f)) : finalizer.snapshot(ctx, mockApi(f));
  for (const workflowPath of [".github/workflows/release.yml", ".github/workflows/release.yml@main",
    ".github/workflows/release.yml@refs/tags/own-tag", "bigduu/Bodhi-AI/.github/workflows/release.yml@main"]) {
    test(`${phase} accepts own exact workflow path ${workflowPath}`, () => {
      const f = fixture(recovery); f.run.path = workflowPath;
      assert.doesNotThrow(() => verify(f));
    });
  }
  for (const workflowPath of [".github/workflows/ci.yml@main", "octocat/octo-repo/.github/workflows/release.yml@main",
    "bigduu/Zenith/.github/workflows/release.yml@refs/tags/own-tag", "bigduu/Bodhi-AI-evil/.github/workflows/release.yml@main",
    "bigduu/Bodhi-AI/.github/workflows/release.yml@"]) {
    test(`${phase} rejects foreign or malformed workflow path ${workflowPath}`, () => {
      const f = fixture(recovery); f.run.path = workflowPath;
      assert.throws(() => verify(f));
      assert.equal(patches(f).length, 0);
    });
  }
}
for (const [name, mutate] of [
  ["wrong source", f => { f.run.head_sha = "b".repeat(40); }],
  ["wrong version", f => { f.run.display_title = f.run.display_title.replace(ctx.version, "2026.10.18"); }],
  ["wrong original attempt", f => { f.run.run_attempt = 2; }],
  ["wrong workflow", f => { f.run.path = ".github/workflows/ci.yml"; }],
  ["another repository", f => { f.run.repository.full_name = "bigduu/Zenith"; }],
  ["missing ARM platform", f => { f.jobs.splice(1, 1); }],
  ["missing Linux platform", f => { f.jobs.splice(2, 1); }],
  ["missing Windows platform", f => { f.jobs.splice(3, 1); }],
  ["unexpected Intel platform", f => { f.jobs.splice(1, 0, { ...structuredClone(f.jobs[1]), name: "Build Bodhi (x86_64-apple-darwin)" }); }],
  ["duplicate platform", f => { f.jobs[2].name = f.jobs[1].name; }],
  ["failed native platform", f => { f.jobs[3].conclusion = "failure"; }],
  ["wrong native job attempt", f => { f.jobs[3].run_attempt = 2; }],
  ["skipped actor gate", f => { f.jobs[1].steps.find(s => s.name === "Smoke native bundled sidecar actor transport").conclusion = "skipped"; }],
  ["missing browser gate", f => { f.jobs[2].steps = f.jobs[2].steps.filter(s => s.name !== "Smoke bundled browser host"); }],
  ["duplicate assembly gate", f => { f.jobs[3].steps.push(f.jobs[3].steps.find(s => s.name === "Verify exact frontend and real target sidecar")); }],
  ["missing preflight", f => { f.jobs[0].steps = []; }],
  ["incomplete original run", f => { f.run.status = "in_progress"; }],
  ["successful original run", f => { f.run.conclusion = "success"; }],
  ["failed source finalizer gate", f => { f.jobs.at(-1).steps[0].conclusion = "failure"; }],
  ["failed evidence upload", f => { f.jobs.at(-1).steps[2].conclusion = "failure"; }],
  ["failed other finalizer step", f => { f.jobs.at(-1).steps.push({ name: "Resolve identity", conclusion: "failure" }); }],
]) test(`recovery refuses ${name}`, () => {
  const f = fixture(true); mutate(f);
  assert.throws(() => finalizer.recoveryArtifact(ctx, mockApi(f)));
  assert.equal(patches(f).length, 0);
});

for (const [name, mutate] of [
  ["wrong attempt draft", f => { f.draft.tag_name = ctx.draftTag.replace(/-1$/, "-2"); }],
  ["wrong source draft", f => { f.draft.target_commitish = "c".repeat(40); }],
  ["prerelease draft", f => { f.draft.prerelease = true; }],
  ["missing ARM DMG", f => { f.draft.assets = f.draft.assets.filter(a => !a.name.endsWith("_aarch64.dmg")); }],
  ["missing Windows installer", f => { f.draft.assets = f.draft.assets.filter(a => !a.name.endsWith(".exe")); }],
  ["unexpected asset", f => { f.draft.assets[0].name = "extra.rpm"; }],
  ["unexpected Intel DMG", f => { f.draft.assets.push({ ...structuredClone(f.draft.assets[0]), id: 999, name: `Bodhi.AI_${ctx.version}_x64.dmg` }); }],
  ["duplicate asset ID", f => { f.draft.assets[1].id = f.draft.assets[0].id; }],
  ["invalid content digest", f => { f.draft.assets[0].digest = null; }],
  ["unfinished upload", f => { f.draft.assets[0].state = "new"; }],
  ["tiny incomplete asset", f => { f.draft.assets[1].size = 100; }],
  ["foreign asset API", f => { f.draft.assets[0].url = f.draft.assets[0].url.replace(ctx.repository, "bigduu/Zenith"); }],
  ["foreign asset download", f => { f.draft.assets[0].browser_download_url = f.draft.assets[0].browser_download_url.replace("github.com", "example.com"); }],
  ["mixed download prefix", f => { f.draft.assets[0].browser_download_url = f.draft.assets[0].browser_download_url.replace("untagged-abcdef", ctx.draftTag); }],
  ["ambiguous original draft", f => { f.otherReleases.push(structuredClone(f.draft)); }],
  ["different existing final release", f => { f.otherReleases.push({ id: 100, tag_name: ctx.finalTag, draft: true }); }],
  ["existing final tag", f => { f.existingTag = { object: { type: "commit", sha: ctx.source } }; }],
]) test(`snapshot refuses ${name} without publishing`, () => {
  const f = fixture(); mutate(f);
  assert.throws(() => finalizer.snapshot(ctx, mockApi(f)));
  assert.equal(patches(f).length, 0);
});

for (const [name, mutate] of [
  ["missing", f => { f.artifacts = []; }],
  ["expired", f => { f.artifacts[0].expired = true; }],
  ["duplicate", f => { f.artifacts.push(structuredClone(f.artifacts[0])); }],
  ["other run", f => { f.artifacts[0].workflow_run.id++; }],
  ["other source", f => { f.artifacts[0].workflow_run.head_sha = "c".repeat(40); }],
  ["later attempt", f => { f.artifacts[0].name = ctx.evidenceName.replace(/-1$/, "-2"); }],
  ["oversized", f => { f.artifacts[0].size_in_bytes = 1e6; }],
]) test(`recovery refuses ${name} original evidence artifact`, () => {
  const f = fixture(true); mutate(f);
  assert.throws(() => finalizer.recoveryArtifact(ctx, mockApi(f)));
});

test("publication patches only the verified original ID and preserves every asset", () => {
  const f = fixture(), api = mockApi(f), receipt = finalizer.snapshot(ctx, api);
  const result = finalizer.publish(ctx, receipt, api);
  assert.equal(result.id, receipt.releaseId);
  assert.deepEqual(finalizer.assetIdentity(result), receipt.assets);
  assert.equal(patches(f).length, 1);
  assert.deepEqual(patches(f)[0].body, { tag_name: ctx.finalTag, target_commitish: ctx.source,
    name: `App v${ctx.version}`, draft: false, prerelease: false, make_latest: "true" });
});
test("successful PATCH with lost response is confirmed from the original ID, assets and source tag", () => {
  const f = fixture(), api = mockApi(f), receipt = finalizer.snapshot(ctx, api);
  f.losePatchResponse = true;
  assert.equal(finalizer.publish(ctx, receipt, api).draft, false);
  assert.equal(patches(f).length, 1);
  assert.equal(finalizer.publish(ctx, receipt, api).id, receipt.releaseId);
  assert.equal(patches(f).length, 1, "Safe retry confirms the same publication without another PATCH");
});
test("unconfirmed PATCH failure stays failed and is never automatically retried", () => {
  for (const option of ["patchWithoutCommit", "failReadback"]) {
    const f = fixture(), api = mockApi(f), receipt = finalizer.snapshot(ctx, api);
    f[option] = true;
    assert.throws(() => finalizer.publish(ctx, receipt, api), /could not be confirmed/);
    assert.equal(patches(f).length, 1);
  }
});
for (const [name, mutate] of [
  ["receipt source", (f, receipt) => { receipt.source = "c".repeat(40); }],
  ["receipt run", (f, receipt) => { receipt.runId++; }],
  ["receipt attempt", (f, receipt) => { receipt.attempt++; }],
  ["receipt version", (f, receipt) => { receipt.version = "2026.10.18"; }],
  ["receipt ID", (f, receipt) => { receipt.releaseId++; }],
  ["replaced original asset", f => { f.draft.assets[0].digest = `sha256:${"c".repeat(64)}`; }],
  ["asset changed just before PATCH", f => { f.tamperAtRead = 3; }],
  ["another final publication", f => { f.otherReleases.push({ id: 100, tag_name: ctx.finalTag, draft: false }); }],
]) test(`publication refuses mismatched ${name}`, () => {
  const f = fixture(), api = mockApi(f), receipt = finalizer.snapshot(ctx, api); mutate(f, receipt);
  assert.throws(() => finalizer.publish(ctx, receipt, api));
  assert.equal(patches(f).length, 0);
});
test("existing publication is accepted only with the exact original ID, source, asset identities and tag", () => {
  for (const mutate of [f => { f.draft.target_commitish = "c".repeat(40); },
    f => { f.draft.assets[0].digest = `sha256:${"c".repeat(64)}`; },
    f => { f.existingTag = { object: { type: "commit", sha: "c".repeat(40) } }; },
    f => { f.otherReleases.push({ id: 100, tag_name: ctx.finalTag }); }]) {
    const f = fixture(), api = mockApi(f), receipt = finalizer.snapshot(ctx, api);
    finalizer.publish(ctx, receipt, api); mutate(f);
    assert.throws(() => finalizer.publish(ctx, receipt, api));
    assert.equal(patches(f).length, 1);
  }
});
test("GitHub API outage during preflight or recovery cannot be mistaken for absence", () => {
  const f = fixture(true), api = mockApi(f);
  f.apiFailure = `git/ref/tags/${ctx.finalTag}`;
  assert.throws(() => finalizer.requireUnused(ctx, api), /unavailable/);
  f.apiFailure = `actions/runs/${ctx.runId}/attempts/${ctx.attempt}`;
  assert.throws(() => finalizer.recoveryArtifact(ctx, api), /unavailable/);
  assert.equal(patches(f).length, 0);
});

test("actual gh adapter distinguishes explicit 404 from auth, transport and server failures", () => {
  let result;
  const sandbox = { module: { exports: {} }, require(name) {
    return name === "node:child_process" ? { execFileSync, spawnSync: () => result } : require(name);
  }, __dirname, process, console, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "release-finalizer.cjs"), "utf8"), sandbox);
  const api = sandbox.module.exports.api;
  result = { status: 1, stderr: "gh: Not Found (HTTP 404)" };
  assert.equal(api("git/ref/tags/app-v2026.10.17"), null);
  for (const stderr of ["HTTP 401", "HTTP 403", "HTTP 503", "unexpected EOF"]) {
    result = { status: 1, stderr };
    assert.throws(() => api("releases"));
  }
  result = { status: 1, stderr: "HTTP 404" };
  assert.throws(() => api("releases/99", "PATCH", {}));
});

test("actual CLI snapshots evidence and recovers only the original failed publication, including a lost PATCH response", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-finalizer-cli-"));
  const stateFile = path.join(directory, "github.json"), evidenceFile = path.join(directory, "bodhi-release-evidence.json");
  const outputFile = path.join(directory, "outputs");
  try {
    fs.writeFileSync(stateFile, JSON.stringify(fixture()));
    fs.writeFileSync(path.join(directory, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const ctx = ${JSON.stringify(ctx)};
const f = JSON.parse(fs.readFileSync(process.env.BODHI_FIXTURE));
const args = process.argv.slice(2), endpoint = args.find(arg => arg.startsWith("repos/")).slice("repos/${ctx.repository}/".length);
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
const body = method === "PATCH" ? JSON.parse(fs.readFileSync(0, "utf8")) : undefined;
try {
  const result = (${mockApi.toString()})(f)(endpoint, method, body);
  if (result === null) { process.stderr.write("gh: Not Found (HTTP 404)"); process.exitCode = 1; }
  else process.stdout.write(JSON.stringify(result));
} catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
finally { fs.writeFileSync(process.env.BODHI_FIXTURE, JSON.stringify(f)); }
`, { mode: 0o700 });
    const command = (mode, overrides = {}) => spawnSync(process.execPath, [path.join(__dirname, "release-finalizer.cjs"), mode, evidenceFile],
      { encoding: "utf8", env: { ...process.env, ...env, PATH: directory + path.delimiter + process.env.PATH,
        BODHI_FIXTURE: stateFile, GITHUB_OUTPUT: outputFile, ...overrides } });
    const verify = command("verify");
    assert.equal(verify.status, 0, verify.stderr);
    const evidence = JSON.parse(fs.readFileSync(evidenceFile));
    assert.equal(evidence.releaseId, 99);
    const original = JSON.parse(fs.readFileSync(stateFile));
    original.patchWithoutCommit = true;
    fs.writeFileSync(stateFile, JSON.stringify(original));
    assert.notEqual(command("publish").status, 0);
    const failed = JSON.parse(fs.readFileSync(stateFile));
    Object.assign(failed, { run: fixture(true).run, jobs: fixture(true).jobs, patchWithoutCommit: false, losePatchResponse: true });
    fs.writeFileSync(stateFile, JSON.stringify(failed));
    const recovery = { ORIGINAL_RELEASE_RUN_ID: "42", ORIGINAL_RELEASE_ATTEMPT: "1", ORIGINAL_EVIDENCE_ARTIFACT_ID: "123" };
    const precheck = command("check-recovery", recovery);
    assert.equal(precheck.status, 0, precheck.stderr);
    assert.match(fs.readFileSync(outputFile, "utf8"), /^artifact_id=123\n$/);
    assert.notEqual(command("recover", { ...recovery, ORIGINAL_EVIDENCE_ARTIFACT_ID: "124" }).status, 0);
    const recovered = command("recover", recovery);
    assert.equal(recovered.status, 0, recovered.stderr);
    const confirmed = command("recover", recovery);
    assert.equal(confirmed.status, 0, confirmed.stderr);
    const final = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(patches(final).length, 2, "One failed original PATCH and one successful recovered PATCH, with no blind retry");
    assert.deepEqual(finalizer.assetIdentity(final.draft), evidence.assets);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("frozen v1 workflows bind original evidence and historical native acceptance", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "tests/fixtures/release-v1/release.yml"), "utf8");
  const recovery = fs.readFileSync(path.join(__dirname, "tests/fixtures/release-v1/recover-release.yml"), "utf8");
  const digest = text => require("node:crypto").createHash("sha256").update(text).digest("hex");
  assert.equal(digest(workflow), "d215ea742e352ef590fb386a143d853ba58613153e61e0a831d48b8a9aff3184");
  assert.equal(digest(recovery), "a00dc4dc9c46794240c9ce64524b02d1eb1d2923f2221790c5e2d551337dc11e");
  assert.equal(digest(fs.readFileSync(path.join(__dirname, "release-finalizer.cjs"))), "a5e188d837e869d031938196dbb1f44a855a6d32af921c1b095da7822fdcb366");
  const inputs = workflow.slice(workflow.indexOf("    inputs:"), workflow.indexOf("permissions:"));
  assert.deepEqual([...inputs.matchAll(/^      (\w+):$/gm)].map(match => match[1]), ["expected_source_sha", "bodhi_version"]);
  assert.doesNotMatch(workflow, /inputs\.(?:bamboo_version|bamboo_ref|lotus_version|frontend_package)|release.train|RELEASE_ORCHESTRATOR_TOKEN/);
  assert.match(workflow, /publish-tauri:\n    name: Build Bodhi \(\$\{\{ matrix.target \}\}\)\n    needs: preflight/);
  for (const name of finalizer.NATIVE_GATES) assert.ok(workflow.includes(`- name: ${name}`));
  for (const text of ["scripts/release-finalizer.cjs preflight", "scripts/release-finalizer.cjs verify", "scripts/release-finalizer.cjs publish",
    "bodhi-release-evidence-${{ github.run_id }}-${{ github.run_attempt }}", "if-no-files-found: error"]) assert.ok(workflow.includes(text));
  for (const text of ["scripts/release-finalizer.cjs check-recovery", "scripts/release-finalizer.cjs recover",
    "artifact-ids: ${{ steps.original.outputs.artifact_id }}", "run-id: ${{ inputs.release_run_id }}", "ORIGINAL_RELEASE_ATTEMPT: ${{ inputs.release_attempt }}"]) assert.ok(recovery.includes(text));
  for (const body of [workflow, recovery]) assert.match(body, /group: bodhi-release-\$\{\{ inputs.bodhi_version \}\}\n  cancel-in-progress: false/);
});

// Bamboo publishes four reusable targets; this Bodhi release supports three.
test("feature native tests and release packaging preserve the supported target contract", () => {
  assert.deepEqual(NATIVE_TARGETS, ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc"]);
  assert.equal(require("./bamboo-sidecar.cjs").TARGETS.length, 4);
  for (const name of ["ci.yml", "release.yml"]) {
    const body = fs.readFileSync(path.join(__dirname, name === "release.yml" ? "tests/fixtures/release-v1/release.yml" : "../.github/workflows/ci.yml"), "utf8");
    const targets = [...body.matchAll(/^            target: "?([a-z0-9_-]+)"?$/gm)].map(match => match[1]);
    assert.deepEqual(targets.sort(), [...NATIVE_TARGETS].sort());
    assert.doesNotMatch(body, /macos-15-intel|x86_64-apple-darwin/);
    const gates = name === "ci.yml"
      ? ["Verify debug assembly inputs", "Run native actor and static frontend E2E", "Run native browser E2E"]
      : ["Verify exact frontend and real target sidecar", "Smoke native bundled sidecar actor transport", "Smoke bundled browser host"];
    for (const gate of gates) assert.ok(body.includes(`- name: ${gate}`));
  }
});
