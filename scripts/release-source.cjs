#!/usr/bin/env node
"use strict";

// Trusted controller code reads product Git objects and locks as data only.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { api, NATIVE_TARGETS, REPOSITORY } = require("./release-finalizer.cjs");
const { readLock } = require("./bamboo-sidecar.cjs");
const { readArtifactLock } = require("./lotus-next-artifact.cjs");

const ROOT = path.resolve(__dirname, "..");
const FEATURE_WORKFLOW = ".github/workflows/ci.yml";
const LEGACY_FEATURE_WORKFLOW_BLOB = "492770d810a8c51df8f63057ed95f1446426c7c6";
const FEATURE_WORKFLOW_BLOB = "85fd611d3ee5171eb70b9c5a28d53c92a2c09c50";
const FEATURE_CONTEXT_SCHEMA = "bodhi-feature-context/v1";
const ADMISSION_SCHEMA = 2;
const ADMISSION_KIND = "bodhi-accepted-dev";
const SOURCE_GATE = "Require the exact feature merge source";
const SHA = /^[0-9a-f]{40}$/;
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function id(value, label) {
  assert.match(String(value), /^[1-9][0-9]*$/, `Invalid ${label}`);
  assert.ok(Number.isSafeInteger(Number(value)), `Invalid ${label}`);
  return Number(value);
}
function sha(value, label) { assert.match(value || "", SHA, `Invalid ${label}`); return value; }
function workflow(value) {
  assert.equal(typeof value, "string");
  const [file, ref, extra] = value.split("@");
  assert.ok(!extra && (ref === undefined || /^\S+$/.test(ref)), "Invalid workflow ref");
  return file.startsWith(`${REPOSITORY}/`) ? file.slice(REPOSITORY.length + 1) : file;
}
function pages(endpoint, key, request) {
  const rows = [];
  for (let page = 1; ; page++) {
    const result = request(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = result?.[key];
    assert.ok(Array.isArray(batch), "Incomplete paginated evidence");
    rows.push(...batch);
    if (batch.length < 100) {
      assert.equal(result.total_count, rows.length, "Truncated job evidence");
      return rows;
    }
  }
}
function requireController(env = process.env, root = ROOT, executeGit = git) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "Release requires the trusted main dispatcher");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`);
  const controller = sha(env.GITHUB_WORKFLOW_SHA, "controller SHA");
  assert.equal(env.GITHUB_SHA, controller, "Keep the actual controller identity");
  assert.equal(executeGit(root, "rev-parse", "HEAD"), controller, "Controller checkout differs");
  assert.equal(executeGit(root, "status", "--porcelain", "--untracked-files=all"), "", "Controller must be clean");
  return controller;
}
function requireProduct(source, root, env = process.env, executeGit = git) {
  sha(source, "product source");
  assert.ok(path.isAbsolute(root) && fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink(), "Explicit product checkout required");
  assert.notEqual(fs.realpathSync(root), fs.realpathSync(ROOT), "Product must use a separate checkout from the controller");
  assert.equal(executeGit(root, "rev-parse", "HEAD"), source, "Product checkout differs");
  assert.equal(executeGit(root, "status", "--porcelain", "--untracked-files=all"), "", "Product must be clean before stamping");
  const bamboo = readLock(root, { ...env, BAMBOO_SIDECAR_SOURCE: "release" });
  const frontend = readArtifactLock(path.join(root, "scripts/frontend-package-lock.json"));
  const hashes = Object.fromEntries(["scripts/bamboo-sidecar-lock.json", "scripts/frontend-package-lock.json"].map((file) =>
    [file, digest(fs.readFileSync(path.join(root, file)))]));
  return { bamboo, frontend, lockHashes: hashes };
}
function sourceFromLog(log) {
  assert.equal(typeof log, "string");
  const rows = [...log.matchAll(/^\S+Z Feature source: ([0-9a-f]{40}) tree: ([0-9a-f]{40})\r?$/gm)];
  assert.equal(rows.length, 1, "Require one actual checkout source record");
  return { snapshot: rows[0][1], tree: rows[0][2] };
}
function featureContext(value) {
  assert.deepEqual(Object.keys(value).sort(), ["schema", "repository", "runId", "physicalAttempt", "pullRequest", "base", "head", "snapshot", "tree"].sort(), "Unexpected feature context fields");
  assert.equal(value.schema, FEATURE_CONTEXT_SCHEMA); assert.equal(value.repository, REPOSITORY);
  for (const key of ["runId", "physicalAttempt", "pullRequest"]) assert.equal(value[key], id(value[key], key), `Numeric ${key} required`);
  for (const key of ["base", "head", "snapshot", "tree"]) sha(value[key], key);
  return value;
}
function contextFromLog(log) {
  assert.equal(typeof log, "string");
  const rows = log.split(/\r?\n/).filter(line => /^\S+Z Feature context:/.test(line));
  assert.equal(rows.length, 1, "Require one original feature context");
  const match = rows[0].match(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z Feature context: ([A-Za-z0-9+/]+={0,2})$/);
  assert.ok(match && match[1].length <= 4096, "Invalid bounded feature context record");
  const data = Buffer.from(match[1], "base64");
  assert.equal(data.toString("base64"), match[1], "Noncanonical context encoding");
  const value = JSON.parse(data.toString("utf8"));
  assert.equal(data.toString("utf8"), JSON.stringify(value), "Noncanonical context JSON");
  return featureContext(value);
}
function jobLog(jobId) {
  return execFileSync("gh", ["api", `repos/${REPOSITORY}/actions/jobs/${id(jobId, "job ID")}/logs`, "--method", "GET", "--allow-escape-sequences"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}
function passed(job, gates) {
  assert.equal(job.status, "completed", `Incomplete job: ${job.name}`);
  assert.equal(job.conclusion, "success", `Unsuccessful job: ${job.name}`);
  for (const gate of gates) {
    const steps = job.steps.filter((step) => step.name === gate);
    assert.equal(steps.length, 1, `Missing or ambiguous gate: ${gate}`);
    assert.equal(steps[0].status, "completed", `Incomplete gate: ${gate}`);
    assert.equal(steps[0].conclusion, "success", `Unsuccessful gate: ${gate}`);
  }
}
function executionOrigin(logical, matching) {
  // GitHub can copy a successful job into a later attempt with a new ID while
  // retaining every execution timestamp. Keep that logical status separate
  // from the original execution that owns its logs and artifacts.
  const attempts = new Set();
  for (const job of matching) {
    assert.equal(job.name, logical.name); assert.equal(job.run_id, logical.run_id);
    assert.equal(job.head_sha, logical.head_sha);
    assert.equal(job.run_attempt, id(job.run_attempt, "job attempt"));
    assert.ok(!attempts.has(job.run_attempt), "Ambiguous job attempt");
    attempts.add(job.run_attempt);
  }
  const present = matching.filter(job => job.id === logical.id);
  assert.equal(present.length, 1, "Logical job is missing or ambiguous");
  assert.deepEqual(present[0], logical);
  function execution(job) {
    if (job.status !== "completed" || job.conclusion !== "success") return null;
    const start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || !job.steps?.length) return null;
    const numbers = new Set(), steps = [];
    for (const step of job.steps) {
      if (!Number.isSafeInteger(step.number) || step.number <= 0 || numbers.has(step.number) ||
          typeof step.name !== "string" || !step.name || step.status !== "completed" ||
          !["success", "skipped", "neutral"].includes(step.conclusion)) return null;
      numbers.add(step.number);
      const skipped = step.conclusion === "skipped" && step.started_at === null && step.completed_at === null;
      if (!skipped) {
        const first = Date.parse(step.started_at), last = Date.parse(step.completed_at);
        if (!Number.isFinite(first) || !Number.isFinite(last) || first < start || last > end || first > last) return null;
      }
      steps.push({ number: step.number, name: step.name, status: step.status, conclusion: step.conclusion,
        started_at: step.started_at, completed_at: step.completed_at });
    }
    return JSON.stringify({ started_at: job.started_at, completed_at: job.completed_at, steps });
  }
  const key = execution(logical);
  assert.notEqual(key, null, "Complete successful execution times are required");
  return matching.filter(job => job.run_attempt <= logical.run_attempt && execution(job) === key)
    .sort((a, b) => a.run_attempt - b.run_attempt)[0];
}
function devHead(branch) {
  const protection = branch?.protection?.required_status_checks;
  assert.equal(branch?.protected, true, "Dev must be protected");
  assert.equal(protection?.enforcement_level, "everyone", "Dev administrators must follow admission");
  for (const context of ["Unit Tests", "E2E Tests"]) {
    assert.ok(protection.contexts.includes(context), `Dev must require ${context}`);
    assert.ok(protection.checks.some((check) => check.context === context && check.app_id === 15368), `Require the GitHub Actions ${context} check`);
  }
  return sha(branch.commit?.sha, "observed dev head");
}
function association(run, pullRequest, base, head) {
  assert.ok(Array.isArray(run.pull_requests), "Missing feature association API state");
  // GitHub can remove this array's entries after merge. Only the new pinned
  // producer's original contexts below can supply the missing association.
  if (!run.pull_requests.length) return;
  assert.equal(run.pull_requests.length, 1, "Ambiguous feature association");
  const item = run.pull_requests[0]; assert.equal(item.number, pullRequest, "Feature PR association differs");
  assert.equal(item.base.ref, "dev"); assert.equal(item.base.sha, base); assert.equal(item.head.sha, head);
}
function verifyAcceptedDev({ source, pullRequest, runId, attempt }, request = api, readLog = jobLog) {
  sha(source, "accepted dev source");
  pullRequest = id(pullRequest, "feature PR"); runId = id(runId, "feature run"); attempt = id(attempt, "feature attempt");
  const pr = request(`pulls/${pullRequest}`);
  // A matching Git merge alone is not a confirmed protected PR receipt (#118).
  assert.equal(pr?.merged, true, "Feature PR merge is not confirmed by GitHub");
  assert.equal(pr.state, "closed");
  assert.equal(pr.number, pullRequest);
  assert.equal(pr.base.repo.full_name, REPOSITORY);
  assert.equal(pr.head.repo.full_name, REPOSITORY);
  assert.equal(pr.base.ref, "dev");
  assert.equal(pr.merge_commit_sha, source, "Cut must be the actual accepted dev merge");
  assert.ok(typeof pr.merged_at === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(pr.merged_at) &&
    Number.isFinite(Date.parse(pr.merged_at)), "Missing or invalid feature merge time");
  const mergedAt = Date.parse(pr.merged_at);
  const base = sha(pr.base.sha, "feature base"), head = sha(pr.head.sha, "feature head");
  const accepted = request(`git/commits/${source}`);
  assert.deepEqual(accepted.parents.map((parent) => parent.sha), [base, head], "Require the normal accepted merge parents");
  const tree = sha(accepted.tree.sha, "accepted tree");
  const observedDev = devHead(request("branches/dev"));
  const ancestry = request(`compare/${source}...${observedDev}`);
  assert.equal(ancestry?.merge_base_commit?.sha, source, "Cut is not in dev ancestry");
  // This ordinary branch endpoint is readable by the controller token. The
  // administration-only /protection endpoint must not require extra authority.
  // Exact B/F merge parents and M/S tree equality above reject stale admission.
  const run = request(`actions/runs/${runId}`);
  assert.equal(run?.id, runId);
  assert.equal(run?.repository?.full_name, REPOSITORY);
  assert.equal(run.event, "pull_request");
  assert.equal(workflow(run.path), FEATURE_WORKFLOW);
  assert.equal(run.head_sha, head, "Feature run belongs to another head");
  assert.equal(run.run_attempt, attempt, "Feature attempt changed");
  assert.equal(run.status, "completed"); assert.equal(run.conclusion, "success");
  association(run, pullRequest, base, head);
  const expected = new Map([
    ["Unit Tests (Node)", [SOURCE_GATE, "Run script unit tests"]],
    ...NATIVE_TARGETS.map((target) => [`Unit and E2E (${target})`, [SOURCE_GATE, "Stage accepted inputs for debug assembly",
      "Run native shell unit tests", "Verify debug assembly inputs", "Run native actor and static frontend E2E", "Run native browser E2E"]]),
    ["Unit Tests", ["Require every unit test result"]], ["E2E Tests", ["Require every native E2E result"]],
  ]);
  const jobs = pages(`actions/runs/${runId}/jobs?filter=all`, "jobs", request), selected = [];
  assert.equal(new Set(jobs.map((job) => job.id)).size, jobs.length, "Duplicate job evidence");
  assert.ok(jobs.every((job) => expected.has(job.name)), "Foreign job in feature evidence");
  let snapshot;
  for (const [name, gates] of expected) {
    const matching = jobs.filter((job) => job.name === name);
    assert.ok(matching.length, `Missing required job: ${name}`);
    for (const job of matching) {
      assert.equal(job.run_id, runId); assert.equal(job.head_sha, head);
      assert.ok(id(job.run_attempt, "job attempt") <= attempt, "Future job attempt");
    }
    const last = Math.max(...matching.map((job) => job.run_attempt));
    const latest = matching.filter((job) => job.run_attempt === last);
    assert.equal(latest.length, 1, `Ambiguous selected job: ${name}`);
    const logical = latest[0]; passed(logical, gates);
    const job = executionOrigin(logical, matching); passed(job, gates);
    assert.ok(Date.parse(job.completed_at) <= mergedAt, "Feature execution completed after accepted dev merge: " + name);
    if (gates.includes(SOURCE_GATE)) {
      const log = readLog(job.id), observed = contextFromLog(log);
      assert.deepEqual(sourceFromLog(log), { snapshot: observed.snapshot, tree: observed.tree }, "Source and context records differ");
      assert.equal(observed.runId, runId); assert.equal(observed.physicalAttempt, job.run_attempt, "Original context attempt differs");
      assert.equal(observed.pullRequest, pullRequest); assert.equal(observed.base, base); assert.equal(observed.head, head);
      assert.equal(observed.tree, tree, "Actual tested tree differs from dev");
      if (snapshot) assert.equal(observed.snapshot, snapshot, "Selected jobs tested different snapshots");
      snapshot = observed.snapshot;
    }
    selected.push({ id: id(job.id, "job ID"), name, attempt: job.run_attempt,
      logical: { id: id(logical.id, "logical job ID"), attempt: logical.run_attempt } });
  }
  const merge = request(`git/commits/${snapshot}`);
  assert.deepEqual(merge.parents.map((parent) => parent.sha), [base, head], "Actual snapshot parents differ");
  assert.equal(merge.tree.sha, tree);
  const blob = request(`contents/${FEATURE_WORKFLOW}?ref=${snapshot}`)?.sha;
  assert.notEqual(blob, LEGACY_FEATURE_WORKFLOW_BLOB, "Legacy feature producer cannot authorize new releases or bootstrap");
  assert.equal(blob, FEATURE_WORKFLOW_BLOB, "Unreviewed feature workflow");
  const fresh = request(`pulls/${pullRequest}`), latestRun = request(`actions/runs/${runId}`);
  assert.ok(fresh.merged && fresh.state === "closed" && fresh.merge_commit_sha === source && fresh.head.sha === head && fresh.base.sha === base, "Feature PR changed during admission");
  assert.equal(fresh.number, pullRequest); assert.equal(fresh.base.ref, "dev");
  assert.equal(fresh.merged_at, pr.merged_at, "Feature merge time changed during admission");
  assert.equal(fresh.base.repo.full_name, REPOSITORY); assert.equal(fresh.head.repo.full_name, REPOSITORY);
  assert.ok(latestRun.run_attempt === attempt && latestRun.status === "completed" && latestRun.conclusion === "success", "Feature run changed during admission");
  assert.equal(latestRun.id, runId); assert.equal(latestRun.repository.full_name, REPOSITORY);
  assert.equal(latestRun.event, "pull_request"); assert.equal(workflow(latestRun.path), FEATURE_WORKFLOW); assert.equal(latestRun.head_sha, head);
  association(latestRun, pullRequest, base, head);
  const currentDev = devHead(request("branches/dev"));
  if (currentDev !== observedDev) {
    const advance = request(`compare/${observedDev}...${currentDev}`);
    assert.ok(advance?.status === "ahead" && advance.behind_by === 0 && advance.merge_base_commit?.sha === observedDev, "Dev was rewritten during admission");
  }
  return { schemaVersion: ADMISSION_SCHEMA, kind: ADMISSION_KIND, repository: REPOSITORY, source, tree, pullRequest, mergedAt: pr.merged_at, base, head, snapshot, runId, attempt,
    observedDev, currentDev, workflowBlob: FEATURE_WORKFLOW_BLOB, jobs: selected };
}
function admitFeature(input, request = api, readLog = jobLog) {
  const source = sha(input.source, "frozen source"), ref = `git/ref/heads/release/${source}`;
  assert.equal(request(ref)?.object?.sha, source, "Frozen branch differs from its cut");
  const proof = verifyAcceptedDev(input, request, readLog);
  assert.equal(request(ref)?.object?.sha, source, "Frozen source changed during admission");
  return proof;
}
function main() {
  const [command, output] = process.argv.slice(2);
  assert.equal(command, "admit"); assert.ok(output, "An admission output file is required");
  const controller = requireController();
  const source = sha(process.env.EXPECTED_SOURCE_SHA, "frozen source");
  const proof = admitFeature({ source, pullRequest: process.env.FEATURE_PULL_REQUEST,
    runId: process.env.FEATURE_RUN_ID, attempt: process.env.FEATURE_RUN_ATTEMPT });
  const product = requireProduct(source, process.env.SOURCE_ROOT);
  fs.writeFileSync(output, JSON.stringify({ ...proof, controller, lockHashes: product.lockHashes,
    frontend: product.frontend }, null, 2) + "\n", { flag: "wx" });
}
module.exports = { LEGACY_FEATURE_WORKFLOW_BLOB, FEATURE_WORKFLOW_BLOB, FEATURE_CONTEXT_SCHEMA, ADMISSION_SCHEMA, ADMISSION_KIND,
  requireController, requireProduct, sourceFromLog, contextFromLog, executionOrigin, devHead, verifyAcceptedDev, admitFeature };
if (require.main === module) { try { main(); } catch (error) { console.error(`Bodhi source: ${error.message}`); process.exitCode = 1; } }
