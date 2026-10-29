const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { admitFeature, verifyAcceptedDev, requireController, requireProduct, sourceFromLog, contextFromLog,
  executionOrigin, FEATURE_WORKFLOW_BLOB, CONTEXT_WORKFLOW_BLOB, MAIN_GATE, LEGACY_FEATURE_WORKFLOW_BLOB, FEATURE_CONTEXT_SCHEMA, ADMISSION_SCHEMA, ADMISSION_KIND } = require("./release-source.cjs");
const { NATIVE_TARGETS, REPOSITORY } = require("./release-finalizer.cjs");
const S = "1".repeat(40), B = "2".repeat(40), F = "3".repeat(40), M = "4".repeat(40), T = "5".repeat(40), C = "6".repeat(40);
const D = "7".repeat(40), D2 = "8".repeat(40);
const sourceGate = "Require the exact feature merge source";
const input = { source: S, pullRequest: 17, runId: 42, attempt: 1 };
const processEnv = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const originalContext = (overrides = {}) => ({ schema: FEATURE_CONTEXT_SCHEMA, repository: REPOSITORY, runId: 42, physicalAttempt: 1,
  pullRequest: 17, base: B, head: F, snapshot: M, tree: T, ...overrides });
function contextLog(value = originalContext()) {
  return `2026-10-26T17:25:40.0279841Z Feature source: ${value.snapshot} tree: ${value.tree}\n` +
    `2026-10-26T17:25:40.0280000Z Feature context: ${Buffer.from(JSON.stringify(value)).toString("base64")}\n`;
}
function fixture() {
  const gates = [["Unit Tests (Node)", [sourceGate, "Run script unit tests"]],
    ...NATIVE_TARGETS.map(target => [`Unit and E2E (${target})`, [sourceGate, "Stage accepted inputs for debug assembly", "Run native shell unit tests",
      "Verify debug assembly inputs", "Run native actor and static frontend E2E", "Run native browser E2E"]]),
    ["Unit Tests", ["Require every unit test result"]], ["E2E Tests", ["Require every native E2E result"]]];
  const f = {
    pr: { number: 17, state: "closed", merged: true, merged_at: "2026-10-26T18:30:00Z", merge_commit_sha: S, base: { sha: B, ref: "dev", repo: { full_name: REPOSITORY } },
      head: { sha: F, repo: { full_name: REPOSITORY } } },
    run: { id: 42, repository: { full_name: REPOSITORY }, event: "pull_request", path: ".github/workflows/ci.yml", head_sha: F,
      run_attempt: 1, status: "completed", conclusion: "success", pull_requests: [{ number: 17, base: { ref: "dev", sha: B }, head: { sha: F } }] },
    jobs: gates.map(([name, names], i) => timed({ id: i + 100, name, run_id: 42, run_attempt: 1, head_sha: F, status: "completed", conclusion: "success",
      steps: names.map(name => ({ name, status: "completed", conclusion: "success" })) }, i * 60)),
    accepted: { parents: [{ sha: B }, { sha: F }], tree: { sha: T } },
    snapshot: { parents: [{ sha: B }, { sha: F }], tree: { sha: T } },
    branch: { protected: true, commit: { sha: D }, protection: { required_status_checks: { enforcement_level: "everyone", contexts: ["Unit Tests", "E2E Tests"],
      checks: ["Unit Tests", "E2E Tests"].map(context => ({ context, app_id: 15368 })) } } },
    frozen: S, ancestor: S, workflowBlob: FEATURE_WORKFLOW_BLOB, total: undefined,
    logs: Object.fromEntries(gates.slice(0, 4).map((_job, i) => [100 + i, contextLog()])),
  };
  f.jobs.push({ id: 106, name: MAIN_GATE, run_id: 42, run_attempt: 1, head_sha: F, status: "completed", conclusion: "skipped", steps: [] });
  f.request = endpoint => {
    const replies = { "pulls/17": f.pr, [`git/commits/${S}`]: f.accepted, [`git/commits/${M}`]: f.snapshot,
      [`compare/${S}...${D}`]: { merge_base_commit: { sha: f.ancestor } }, [`git/ref/heads/release/${S}`]: { object: { sha: f.frozen } },
      [`compare/${D}...${D2}`]: { status: "ahead", behind_by: 0, merge_base_commit: { sha: D } },
      "branches/dev": f.branch, "actions/runs/42": f.run,
      "actions/runs/42/jobs?filter=all&per_page=100&page=1": { total_count: f.total ?? f.jobs.length, jobs: f.jobs },
      [`contents/.github/workflows/ci.yml?ref=${M}`]: { sha: f.workflowBlob } };
    assert.ok(Object.hasOwn(replies, endpoint), `Unexpected request ${endpoint}`);
    return structuredClone(replies[endpoint]);
  };
  f.verify = overrides => admitFeature({ ...input, ...overrides }, f.request, job => f.logs[job]);
  return f;
}
test("admission preserves actual feature snapshot separately from accepted dev and controller", () => {
  const proof = fixture().verify();
  assert.equal(proof.source, S); assert.equal(proof.snapshot, M); assert.equal(proof.tree, T);
  assert.equal(proof.schemaVersion, ADMISSION_SCHEMA); assert.equal(proof.kind, ADMISSION_KIND);
  assert.equal(proof.base, B); assert.equal(proof.head, F); assert.equal(proof.workflowBlob, FEATURE_WORKFLOW_BLOB);
  assert.equal(proof.observedDev, D); assert.equal(proof.currentDev, D); assert.notEqual(proof.observedDev, proof.source);
  assert.deepEqual(proof.jobs.map(job => job.id), [100, 101, 102, 103, 104, 105]);
});
test("empty post-merge API association is supplied by all four original contexts", () => {
  const f = fixture(); f.run.pull_requests = [];
  const proof = f.verify(); assert.equal(proof.pullRequest, 17); assert.equal(proof.snapshot, M);
  for (const jobId of [100, 101, 102, 103]) {
    const missing = fixture(); missing.run.pull_requests = []; missing.logs[jobId] = missing.logs[jobId].split("\n")[0] + "\n";
    assert.throws(() => missing.verify(), /original feature context/);
  }
});
test("the original context producer has six actual jobs and no Main skip", () => {
  const f = fixture(); f.workflowBlob = CONTEXT_WORKFLOW_BLOB; f.jobs.pop();
  const proof = f.verify(); assert.equal(proof.workflowBlob, CONTEXT_WORKFLOW_BLOB); assert.equal(proof.jobs.length, 6);
});
for (const [name, mutate] of [
  ["missing skip", f => f.jobs.pop()], ["green stub", f => { f.jobs.at(-1).conclusion = "success"; }],
  ["neutral stub", f => { f.jobs.at(-1).conclusion = "neutral"; }], ["running main gate", f => { f.jobs.at(-1).status = "in_progress"; }],
  ["executed main step", f => { f.jobs.at(-1).steps.push({ name: "anything", conclusion: "skipped" }); }],
  ["ambiguous skip", f => f.jobs.push({ ...f.jobs.at(-1), id: 107 })],
  ["foreign skip run", f => { f.jobs.at(-1).run_id++; }], ["future skip attempt", f => { f.jobs.at(-1).run_attempt++; }],
  ["skip on the old context producer", f => { f.workflowBlob = CONTEXT_WORKFLOW_BLOB; }],
]) test(`finite producer graph refuses ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => f.verify()); });
test("accepted-dev verification has no release-ref dependency while the release wrapper requires it", () => {
  const f = fixture(), requests = []; f.frozen = null; f.run.pull_requests = [];
  const proof = verifyAcceptedDev(input, endpoint => { requests.push(endpoint); return f.request(endpoint); }, job => f.logs[job]);
  assert.equal(proof.source, S); assert.ok(requests.every(endpoint => !endpoint.includes("git/ref/heads/release/")));
  assert.throws(() => f.verify(), /Frozen branch/);
});
for (const [key, value] of [["schema", "bodhi-feature-context/v2"], ["repository", "other/Bodhi-AI"], ["runId", 43],
  ["runId", "42"], ["physicalAttempt", 2], ["physicalAttempt", 0], ["physicalAttempt", "1"], ["pullRequest", 18],
  ["base", S], ["head", B], ["snapshot", B], ["tree", S], ["extra", true]]) {
  test(`original context refuses mismatched ${key}=${value} even with empty association`, () => {
    const f = fixture(); f.run.pull_requests = []; f.logs[101] = contextLog(originalContext({ [key]: value }));
    assert.throws(() => f.verify());
  });
}
test("the old source line and new context must agree in one physical log", () => {
  const f = fixture(); f.logs[100] = f.logs[100].replace(`Feature source: ${M}`, `Feature source: ${B}`);
  assert.throws(() => f.verify(), /Source and context/);
});
test("legacy 492 contexts cannot become new release or bootstrap admission", () => {
  const f = fixture(); f.workflowBlob = LEGACY_FEATURE_WORKFLOW_BLOB;
  assert.throws(() => verifyAcceptedDev(input, f.request, job => f.logs[job]), /Legacy feature producer/);
  for (const jobId of [100, 101, 102, 103]) f.logs[jobId] = f.logs[jobId].split("\n")[0] + "\n";
  f.run.pull_requests = [];
  assert.throws(() => f.verify(), /original feature context/);
});
for (const value of [undefined, null, "", "unknown", "2026-10-26", 1793039400000]) {
  test("source time refuses missing or invalid merge timestamp " + String(value), () => {
    const f = fixture(); f.pr.merged_at = value;
    assert.throws(() => f.verify(), /merge time/);
  });
}
test("source time requires all six original executions to complete before admission", () => {
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const f = fixture(); timed(f.jobs[index], 3600);
    assert.throws(() => f.verify(), /completed after/);
  }
});
test("source time retains the inclusive original completion boundary", () => {
  const f = fixture();
  f.pr.merged_at = f.jobs.filter(job => job.conclusion === "success").map(job => job.completed_at).sort().at(-1);
  const proof = f.verify(); assert.equal(proof.mergedAt, f.pr.merged_at);
});
test("source time permits a later logical projection while preserving pre-merge physical completion", () => {
  const f = fixture(); f.run.run_attempt = 2; f.run.updated_at = "2026-10-26T19:00:00Z";
  for (const original of [...f.jobs]) f.jobs.push({ ...structuredClone(original), id: original.id + 1000,
    run_attempt: 2, created_at: "2026-10-26T18:45:00Z" });
  const proof = f.verify({ attempt: 2 });
  assert.equal(proof.jobs[0].id, 100); assert.equal(proof.jobs[0].attempt, 1);
  assert.equal(proof.jobs[0].logical.id, 1100); assert.equal(proof.mergedAt, f.pr.merged_at);
});
test("source time rejects a late original hidden by a green logical projection", () => {
  const f = fixture(); f.run.run_attempt = 2;
  timed(f.jobs[0], 3600); f.jobs.push({ ...structuredClone(f.jobs[0]), id: 200, run_attempt: 2 });
  assert.throws(() => f.verify({ attempt: 2 }), /completed after/);
});
test("source time rereads the same confirmed merge timestamp before returning", () => {
  const f = fixture(); let reads = 0;
  assert.throws(() => admitFeature(input, endpoint => {
    const value = f.request(endpoint);
    if (endpoint === "pulls/17" && ++reads > 1) value.merged_at = "2026-10-26T18:31:00Z";
    return value;
  }, job => f.logs[job]), /merge time/);
});
test("same-run failed-job-only rerun retains earlier successful jobs and their actual attempts", () => {
  const f = fixture(); f.run.run_attempt = 2;
  const failed = structuredClone(f.jobs[1]); failed.conclusion = "failure";
  f.jobs[1].run_attempt = 2; f.jobs[1].id = 201; f.logs[201] = contextLog(originalContext({ physicalAttempt: 2 })); f.jobs.push(failed);
  const proof = f.verify({ attempt: 2 });
  assert.equal(proof.jobs[1].id, 201); assert.equal(proof.jobs[1].attempt, 2);
  assert.equal(proof.jobs[2].attempt, 1);
});
function timed(job, shift = 0) {
  const time = seconds => new Date(Date.UTC(2026, 9, 26, 18, 14, 55 + shift + seconds)).toISOString();
  job.started_at = time(0); job.completed_at = time(job.steps.length * 2 + 2);
  job.steps = job.steps.map((step, index) => ({ ...step, number: index + 1,
    started_at: time(index * 2 + 1), completed_at: time(index * 2 + 2) }));
  return job;
}
test("GitHub copied success keeps physical job/attempt and reads original logs, while recording its logical attempt", () => {
  const f = fixture(); f.run.run_attempt = 2; f.run.pull_requests = [];
  const original = timed(f.jobs[0]);
  f.jobs.push({ ...structuredClone(original), id: 200, run_attempt: 2 });
  const read = [];
  const proof = admitFeature({ ...input, attempt: 2 }, f.request, job => { read.push(job); assert.notEqual(job, 200); return f.logs[job]; });
  assert.deepEqual(proof.jobs[0], { id: 100, name: original.name, attempt: 1, logical: { id: 200, attempt: 2 } });
  assert.ok(read.includes(100));
});
test("a logical projection cannot replace the physical context attempt", () => {
  const f = fixture(); f.run.run_attempt = 2;
  f.jobs.push({ ...structuredClone(f.jobs[0]), id: 200, run_attempt: 2 });
  f.logs[100] = contextLog(originalContext({ physicalAttempt: 2 }));
  assert.throws(() => f.verify({ attempt: 2 }), /Original context attempt/);
});
test("a third logical projection still preserves the earliest physical execution", () => {
  const job = timed(fixture().jobs[0]), second = { ...structuredClone(job), id: 200, run_attempt: 2 };
  const third = { ...structuredClone(job), id: 300, run_attempt: 3 };
  assert.equal(executionOrigin(third, [third, second, job]).id, 100);
});
for (const [name, mutate] of [
  ["different job execution", job => timed(job, 60)],
  ["different step execution", job => { job.steps[0].completed_at = job.steps[0].started_at; }],
  ["different step name", job => { job.steps[0].name += " changed"; }],
  ["different step number", job => { job.steps[0].number = 99; }],
]) test(`similarity with ${name} never reattributes execution to an older success`, () => {
  const original = timed(fixture().jobs[0]);
  const logical = { ...structuredClone(original), id: 200, run_attempt: 2 }; mutate(logical);
  assert.equal(executionOrigin(logical, [original, logical]).id, 200);
});
for (const [name, mutate] of [
  ["missing step times", job => { delete job.steps[0].completed_at; }],
  ["invalid step times", job => { job.steps[0].completed_at = "invalid"; }],
  ["step outside job", job => { job.steps[0].completed_at = "2026-10-27T18:14:55.000Z"; }],
  ["incomplete step", job => { job.steps[0].status = "in_progress"; }],
]) test(`unprovable ${name} cannot authorize an original execution`, () => {
  const original = timed(fixture().jobs[0]);
  const logical = { ...structuredClone(original), id: 200, run_attempt: 2 }; mutate(logical);
  assert.throws(() => executionOrigin(logical, [original, logical]), /execution times/);
});
test("same-attempt aliases remain ambiguous rather than being deduplicated", () => {
  const original = timed(fixture().jobs[0]);
  assert.throws(() => executionOrigin(original, [original, { ...structuredClone(original), id: 200 }]), /Ambiguous/);
});
test("a later failed logical result cannot reuse an older physical success", () => {
  const f = fixture(); f.run.run_attempt = 2;
  const original = timed(f.jobs[0]);
  f.jobs.push({ ...structuredClone(original), id: 200, run_attempt: 2, conclusion: "failure" });
  assert.throws(() => f.verify({ attempt: 2 }), /Unsuccessful/);
});
for (const [name, change] of [
  ["unconfirmed PR despite an identical normal dev merge", f => { f.pr.merged = false; f.pr.state = "open"; }],
  ["unmerged PR state", f => { f.pr.state = "open"; }],
  ["foreign source repository", f => { f.pr.head.repo.full_name = "other/Bodhi-AI"; }],
  ["main feature base", f => { f.pr.base.ref = "main"; }],
  ["other accepted merge", f => { f.pr.merge_commit_sha = B; }],
  ["non-normal accepted parents", f => { f.accepted.parents.reverse(); }],
  ["cut outside dev", f => { f.ancestor = B; }],
  ["moved frozen branch", f => { f.frozen = B; }],
  ["absent frozen branch", f => { f.frozen = null; }],
  ["unprotected dev", f => { f.branch.protected = false; }],
  ["missing required E2E", f => { f.branch.protection.required_status_checks.contexts.pop(); }],
  ["admin bypass", f => { f.branch.protection.required_status_checks.enforcement_level = "non_admins"; }],
  ["foreign check app", f => { f.branch.protection.required_status_checks.checks[1].app_id = 42; }],
  ["foreign run", f => { f.run.repository.full_name = "other/Bodhi-AI"; }],
  ["push evidence", f => { f.run.event = "push"; }],
  ["foreign workflow", f => { f.run.path = "other/Bodhi-AI/.github/workflows/ci.yml"; }],
  ["run for other head", f => { f.run.head_sha = B; }],
  ["changed attempt", f => { f.run.run_attempt = 2; }],
  ["incomplete run", f => { f.run.status = "in_progress"; }],
  ["failed run", f => { f.run.conclusion = "failure"; }],
  ["wrong PR association", f => { f.run.pull_requests[0].number++; }],
  ["ambiguous PR associations", f => { f.run.pull_requests.push(structuredClone(f.run.pull_requests[0])); }],
  ["missing association API field", f => { delete f.run.pull_requests; }],
  ["wrong historical base", f => { f.run.pull_requests[0].base.sha = S; }],
  ["truncated jobs", f => { f.total = f.jobs.length + 1; }],
  ["missing native job", f => { f.jobs.splice(2, 1); }],
  ["foreign job", f => { f.jobs.push({ ...f.jobs[0], name: "foreign", id: 999 }); }],
  ["ambiguous job", f => { f.jobs.push({ ...f.jobs[0], id: 999 }); }],
  ["duplicated job page", f => { f.jobs.push(structuredClone(f.jobs[0])); }],
  ["foreign job run", f => { f.jobs[0].run_id++; }],
  ["future job attempt", f => { f.jobs[0].run_attempt = 2; }],
  ["foreign job source", f => { f.jobs[0].head_sha = B; }],
  ["failed native step inside green job", f => { f.jobs[1].steps[3].conclusion = "failure"; }],
  ["skipped native step inside green job", f => { f.jobs[1].steps[3].conclusion = "skipped"; }],
  ["in-progress native step inside green job", f => { f.jobs[1].steps[3].status = "in_progress"; }],
  ["missing native gate", f => { f.jobs[2].steps.pop(); }],
  ["another tested tree", f => { f.logs[100] = f.logs[100].replace(T, S); }],
  ["different selected snapshot", f => { f.logs[101] = f.logs[101].replace(M, B); }],
  ["wrong snapshot parents", f => { f.snapshot.parents[0].sha = S; }],
  ["wrong snapshot tree", f => { f.snapshot.tree.sha = S; }],
  ["unreviewed CI blob", f => { f.workflowBlob = B; }],
  ["unpublished candidate-defined Main producer", f => { f.workflowBlob = "e2d177fd8f7efa9e514b8b48d27a41eeb161cd7b"; }],
  ["legacy producer with even a fabricated new context", f => { f.workflowBlob = LEGACY_FEATURE_WORKFLOW_BLOB; }],
]) test(`source admission refuses ${name}`, () => { const f = fixture(); change(f); assert.throws(() => f.verify()); });
for (const conclusion of ["failure", "cancelled", "skipped", "neutral", null]) test(`source admission refuses ${conclusion} required job`, () => {
  const f = fixture(); f.jobs[1].conclusion = conclusion; assert.throws(() => f.verify());
});
test("latest failed required job cannot be hidden behind an older success", () => {
  const f = fixture(); f.run.run_attempt = 2;
  f.jobs.push({ ...f.jobs[1], id: 201, run_attempt: 2, conclusion: "failure" });
  assert.throws(() => f.verify({ attempt: 2 }));
});
for (const [endpoint, mutate] of [["pulls/17", value => { value.head.sha = B; }], ["actions/runs/42", value => { value.run_attempt++; }],
  ["actions/runs/42", value => { value.pull_requests[0].number++; }],
  [`git/ref/heads/release/${S}`, value => { value.object.sha = B; }]]) test(`admission catches a concurrent change to ${endpoint}`, () => {
  const f = fixture(); let reads = 0;
  assert.throws(() => admitFeature(input, key => { const value = f.request(key); if (key === endpoint && ++reads > 1) mutate(value); return value; }, job => f.logs[job]));
});
test("normal dev advance while logs are read preserves both observed and current dev identities", () => {
  const f = fixture(); let branchReads = 0;
  const proof = admitFeature(input, endpoint => {
    const value = f.request(endpoint); if (endpoint === "branches/dev" && ++branchReads > 1) value.commit.sha = D2;
    return value;
  }, job => f.logs[job]);
  assert.equal(proof.source, S); assert.equal(proof.observedDev, D); assert.equal(proof.currentDev, D2);
});
for (const [name, mutate] of [
  ["unprotected dev", branch => { branch.protected = false; }],
  ["removed required check", branch => { branch.protection.required_status_checks.contexts.pop(); }],
  ["changed check app", branch => { branch.protection.required_status_checks.checks[0].app_id = 42; }],
  ["administrator bypass", branch => { branch.protection.required_status_checks.enforcement_level = "non_admins"; }],
  ["rewritten ancestry", () => {}],
]) test(`final dev recheck rejects ${name} during log reads`, () => {
  const f = fixture(); let branchReads = 0;
  assert.throws(() => admitFeature(input, endpoint => {
    const value = f.request(endpoint);
    if (endpoint === "branches/dev" && ++branchReads > 1) { value.commit.sha = D2; mutate(value); }
    if (endpoint === `compare/${D}...${D2}` && name === "rewritten ancestry") { value.merge_base_commit.sha = B; value.status = "diverged"; value.behind_by = 1; }
    return value;
  }, job => f.logs[job]));
});
test("observed #118 open/merged-false state blocks admission before inspecting its matching Git merge", () => {
  assert.throws(() => verifyAcceptedDev({ source: "1ff40d39ef6ec4580402890c8ccb75f85e79d652", pullRequest: 118, runId: 40368488426, attempt: 1 }, endpoint => {
    assert.equal(endpoint, "pulls/118");
    return { number: 118, state: "open", merged: false };
  }, () => assert.fail("Unconfirmed PR must not acquire a fabricated source receipt")), /not confirmed/);
});
test("source records require exactly one actual timestamped checkout line", () => {
  const line = `2026-10-26T17:25:40.000Z Feature source: ${M} tree: ${T}\r\n`;
  assert.deepEqual(sourceFromLog(line), { snapshot: M, tree: T });
  assert.throws(() => sourceFromLog(line + line));
  assert.throws(() => sourceFromLog(`echo Feature source: ${M} tree: ${T}`));
});
test("new contexts require one bounded canonical original record, preserving the historical parser only as data", () => {
  const log = contextLog(), encoded = log.split("Feature context: ")[1].trim();
  assert.deepEqual(contextFromLog(log), originalContext());
  for (const changed of [log + log, log.replace("Z Feature context:", "Z echo Feature context:"), log.replace(encoded, "!"), log.replace(encoded, "A".repeat(4100)),
    log.replace(encoded, Buffer.from(JSON.stringify(originalContext(), null, 2)).toString("base64")),
    log.replace(encoded, Buffer.from(JSON.stringify(originalContext()).replace('"runId":42', '"runId":42,"runId":42')).toString("base64")),
    log.replace(encoded, encoded + "=")]) assert.throws(() => contextFromLog(changed));
  const historical = `2026-10-26T17:25:40.000Z Feature source: ${M} tree: ${T}\n`;
  assert.deepEqual(sourceFromLog(historical), { snapshot: M, tree: T });
  assert.throws(() => contextFromLog(historical), /original feature context/);
});
test("the literal source-step CLI proves a clean depth-one merge, event parents and unchanged GitHub identity", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-context-record-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repository"), shallow = path.join(temporary, "shallow"), eventFile = path.join(temporary, "event.json");
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/ci.yml"), "utf8");
  const match = workflow.match(/          node <<'NODE'\n([\s\S]*?)^          NODE$/m); assert.ok(match);
  const writer = match[1].replace(/^          /gm, "");
  const execute = (directory, ...args) => execFileSync("git", ["-c", "user.name=Context fixture", "-c", "user.email=context@example.invalid",
    "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${path.join(temporary, "empty-hooks")}`, ...args],
    { cwd: directory, env: processEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execute(root, "init", "-q", "--initial-branch=dev"); execute(root, "add", "."); execute(root, "commit", "-qm", "base");
  const base = execute(root, "rev-parse", "HEAD"); execute(root, "checkout", "-qb", "feature");
  fs.writeFileSync(path.join(root, "feature.txt"), "feature\n"); execute(root, "add", "."); execute(root, "commit", "-qm", "feature");
  const head = execute(root, "rev-parse", "HEAD"); execute(root, "checkout", "-q", "dev"); execute(root, "merge", "--no-ff", "--no-edit", "-q", "feature");
  const snapshot = execute(root, "rev-parse", "HEAD"), tree = execute(root, "rev-parse", "HEAD^{tree}");
  execute(temporary, "clone", "--quiet", "--depth=1", "--no-local", root, shallow);
  assert.equal(execute(shallow, "rev-parse", "--is-shallow-repository"), "true");
  const event = { repository: { full_name: REPOSITORY }, number: 17, pull_request: { number: 17,
    base: { sha: base, ref: "dev", repo: { full_name: REPOSITORY } }, head: { sha: head, repo: { full_name: REPOSITORY } } } };
  fs.writeFileSync(eventFile, JSON.stringify(event));
  const env = Object.freeze({ ...processEnv, GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventFile,
    GITHUB_REF: "refs/pull/17/merge", GITHUB_SHA: snapshot, GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1" });
  const original = structuredClone(env), run = (extra = {}) => spawnSync(process.execPath, ["-e", writer],
    { cwd: shallow, env: { ...env, ...extra }, encoding: "utf8" });
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").map(line => `2026-10-27T00:00:00.000Z ${line}`).join("\n");
  assert.deepEqual(contextFromLog(lines), originalContext({ base, head, snapshot, tree }));
  assert.deepEqual(env, original);
  for (const extra of [{ GITHUB_SHA: head }, { GITHUB_RUN_ATTEMPT: "0" }, { GITHUB_REF: "refs/heads/dev" }, { GITHUB_EVENT_NAME: "workflow_dispatch" }])
    assert.notEqual(run(extra).status, 0);
  event.pull_request.base.sha = head; fs.writeFileSync(eventFile, JSON.stringify(event)); assert.notEqual(run().status, 0);
  event.pull_request.base.sha = base; fs.writeFileSync(eventFile, JSON.stringify(event));
  fs.writeFileSync(path.join(shallow, "untracked.txt"), "dirty\n"); const dirty = run(); assert.notEqual(dirty.status, 0); assert.equal(dirty.stdout, "");
});
const controllerEnv = () => ({ GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`, GITHUB_WORKFLOW_SHA: C, GITHUB_SHA: C });
test("trusted controller retains actual GitHub values independently of product source", () => {
  const env = Object.freeze(controllerEnv());
  assert.equal(requireController(env, "/controller", (_root, command) => command === "rev-parse" ? C : ""), C);
  assert.equal(env.GITHUB_SHA, C); assert.notEqual(env.GITHUB_SHA, S);
});
for (const [key, value] of [["GITHUB_REPOSITORY", "other/Bodhi-AI"], ["GITHUB_EVENT_NAME", "pull_request"], ["GITHUB_REF", `refs/heads/release/${S}`],
  ["GITHUB_WORKFLOW_SHA", S], ["GITHUB_WORKFLOW_REF", `${REPOSITORY}/.github/workflows/release.yml@refs/heads/dev`]])
  test(`controller refuses foreign ${key}`, () => assert.throws(() => requireController({ ...controllerEnv(), [key]: value }, "/controller", () => C)));
test("product locks are read from explicit S checkout, never the controller root", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-product-source-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  for (const file of ["bamboo-sidecar-lock.json", "frontend-package-lock.json"]) fs.copyFileSync(path.join(__dirname, file), path.join(root, "scripts", file));
  const frontendPath = path.join(root, "scripts/frontend-package-lock.json");
  const frontend = JSON.parse(fs.readFileSync(frontendPath)); frontend.packageVersion = "2026.10.99";
  fs.writeFileSync(frontendPath, JSON.stringify(frontend, null, 2) + "\n");
  const executeGit = (directory, command) => { assert.equal(directory, root); return command === "rev-parse" ? S : ""; };
  const product = requireProduct(S, root, {}, executeGit);
  assert.equal(product.frontend.packageVersion, "2026.10.99");
  assert.equal(product.lockHashes["scripts/frontend-package-lock.json"], crypto.createHash("sha256").update(fs.readFileSync(frontendPath)).digest("hex"));
  assert.notEqual(product.frontend.packageVersion, JSON.parse(fs.readFileSync(path.join(__dirname, "frontend-package-lock.json"))).packageVersion);
  assert.throws(() => requireProduct(S, root, {}, () => C), /Product checkout differs/);
  assert.throws(() => requireProduct(S, path.resolve(__dirname, ".."), {}, () => S), /separate checkout/);
});
test("actual read-only CLI emits the C/S proof and fails closed on unconfirmed PR or API failure", { skip: process.platform === "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-source-cli-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const product = path.join(root, "product"), bin = path.join(root, "bin"), database = path.join(root, "responses.json");
  fs.mkdirSync(path.join(product, "scripts"), { recursive: true }); fs.mkdirSync(bin);
  for (const file of ["bamboo-sidecar-lock.json", "frontend-package-lock.json"]) fs.copyFileSync(path.join(__dirname, file), path.join(product, "scripts", file));
  const f = fixture(), endpoints = ["pulls/17", `git/commits/${S}`, `git/commits/${M}`, `compare/${S}...${D}`, `git/ref/heads/release/${S}`,
    "branches/dev", "actions/runs/42", "actions/runs/42/jobs?filter=all&per_page=100&page=1", `contents/.github/workflows/ci.yml?ref=${M}`];
  f.run.pull_requests = [];
  const save = () => fs.writeFileSync(database, JSON.stringify({ responses: Object.fromEntries(endpoints.map(endpoint => [endpoint, f.request(endpoint)])), logs: f.logs }));
  save();
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  stub("git", `if(process.argv[2]==="rev-parse") process.stdout.write(require("node:fs").realpathSync(process.cwd())===require("node:fs").realpathSync(process.env.SOURCE_ROOT)?${JSON.stringify(S)}:${JSON.stringify(C)}); else if(process.argv[2]!=="status") process.exit(2);`);
  stub("gh", `const f=require(process.env.SOURCE_DATABASE), endpoint=process.argv[3].replace(/^repos\\/bigduu\\/Bodhi-AI\\//,"");
if(process.env.SOURCE_API_FAILURE===endpoint){process.stderr.write("HTTP 503 service unavailable");process.exit(1)}
const log=/^actions\\/jobs\\/(\\d+)\\/logs$/.exec(endpoint);if(log){if(!process.argv.includes("--allow-escape-sequences"))process.exit(3);process.stdout.write(f.logs[log[1]])}else if(Object.hasOwn(f.responses,endpoint))process.stdout.write(JSON.stringify(f.responses[endpoint]));else process.exit(2);`);
  const run = (file, extra = {}) => spawnSync(process.execPath, [path.join(__dirname, "release-source.cjs"), "admit", file], { encoding: "utf8", env: {
    ...processEnv, ...controllerEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH}`, SOURCE_ROOT: product, SOURCE_DATABASE: database,
    EXPECTED_SOURCE_SHA: S, FEATURE_PULL_REQUEST: "17", FEATURE_RUN_ID: "42", FEATURE_RUN_ATTEMPT: "1", ...extra } });
  const output = path.join(root, "accepted.json"), accepted = run(output);
  assert.equal(accepted.status, 0, accepted.stderr);
  const proof = JSON.parse(fs.readFileSync(output)); assert.equal(proof.controller, C); assert.equal(proof.source, S); assert.equal(proof.snapshot, M);
  assert.equal(proof.schemaVersion, ADMISSION_SCHEMA); assert.equal(proof.kind, ADMISSION_KIND);
  assert.notEqual(run(output).status, 0, "An existing original receipt must not be overwritten");
  f.pr.state = "open"; f.pr.merged = false; save();
  const denied = path.join(root, "denied.json"); assert.notEqual(run(denied).status, 0); assert.equal(fs.existsSync(denied), false);
  f.pr.state = "closed"; f.pr.merged = true; save();
  const outage = path.join(root, "outage.json"); assert.notEqual(run(outage, { SOURCE_API_FAILURE: "pulls/17" }).status, 0); assert.equal(fs.existsSync(outage), false);
});
