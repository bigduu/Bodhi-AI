const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { FEATURE_WORKFLOW_BLOB, LEGACY_FEATURE_WORKFLOW_BLOB, FEATURE_CONTEXT_SCHEMA, ADMISSION_SCHEMA } = require("./release-source.cjs");
const processEnv = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/ci.yml"), "utf8");
const job = (id) => {
  const match = workflow.match(new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|$(?![\\s\\S]))`, "m"));
  assert.ok(match, `Missing job ${id}`);
  return match[1];
};

test("CI splits Dev tests from read-only Main admission with no push/release producer", () => {
  const triggers = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
  assert.match(triggers, /pull_request:\n    branches: \[dev, main\]/);
  assert.doesNotMatch(triggers, /push:|workflow_dispatch:|release|paths:/);
  assert.match(workflow, /group: bodhi-feature-\$\{\{ github.event.pull_request.number \}\}/);
  assert.doesNotMatch(workflow, /contents: write|secrets\.|tauri-action|upload-artifact|cargo build|cargo test[^\n]*--release|release\/bundle|prepare-crates-io-build/);
});
test("the six-job context producer agrees with admission and records before any product or unit command", () => {
  const blob = execFileSync("git", ["hash-object", "--stdin"], { input: workflow, encoding: "utf8", env: processEnv }).trim();
  assert.equal(blob, FEATURE_WORKFLOW_BLOB); assert.notEqual(blob, LEGACY_FEATURE_WORKFLOW_BLOB);
  assert.equal(FEATURE_CONTEXT_SCHEMA, "bodhi-feature-context/v1"); assert.equal(ADMISSION_SCHEMA, 2);
  assert.equal([...workflow.matchAll(/^  [a-z][a-z0-9-]*:\n    name:/gm)].length, 5);
  const writers = [...workflow.matchAll(/          node <<'NODE'\n([\s\S]*?)^          NODE$/gm)].map(match => match[1]);
  assert.equal(writers.length, 2); assert.equal(writers[0], writers[1]);
  const original = execFileSync("git", ["cat-file", "blob", require("./release-source.cjs").CONTEXT_WORKFLOW_BLOB], { encoding: "utf8", env: processEnv });
  assert.deepEqual(writers, [...original.matchAll(/          node <<'NODE'\n([\s\S]*?)^          NODE$/gm)].map(match => match[1]), "Original context writer bytes must remain unchanged");
  assert.match(writers[0], /schema: 'bodhi-feature-context\/v1'/);
  assert.doesNotMatch(writers[0], /require\(['"]\.\//);
  for (const id of ["unit-node", "native-tests"]) {
    const block = job(id), record = block.indexOf("node <<'NODE'");
    assert.ok(record > block.indexOf("uses: actions/checkout@v6") && record < block.indexOf("uses: actions/setup-node@v6"));
    assert.match(block.slice(0, record), /name: Require the exact feature merge source\n        shell: bash/);
  }
  assert.doesNotMatch(workflow, /GITHUB_(?:SHA|REF|RUN_ID|RUN_ATTEMPT)\s*[:=]/);
});
test("Main executes only the base controller verifier, and all feature jobs skip on Main", () => {
  const main = job("main-admission");
  assert.match(main, /name: Main Admission/); assert.match(main, /github.event_name == 'pull_request' && github.base_ref == 'main'/);
  assert.match(main, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.match(main, /run: node scripts\/main-admission.cjs/);
  assert.doesNotMatch(main, /needs:|setup-node|\brust\b|cache|npm |cargo |tauri|upload|contents: write|actions: write|head.sha|exit 0|\|\| true/);
  assert.doesNotMatch(main, /!cancelled\(\)/, "A selected Main gate cannot become a successful conditional skip on cancellation");
  for (const id of ["unit-node", "native-tests", "unit-tests", "e2e-tests"])
    assert.match(job(id), /if: .*github.event_name == 'pull_request' && github.base_ref == 'dev'/);
});

test("each native target compiles once for Unit and E2E and consumes the same debug assembly", () => {
  const native = job("native-tests");
  assert.match(native, /fail-fast: false/);
  assert.deepEqual([...native.matchAll(/^            target: (\S+)$/gm)].map((match) => match[1]),
    ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin", "x86_64-pc-windows-msvc"]);
  assert.equal([...workflow.matchAll(/run: cargo test\b/g)].length, 1);
  const compile = "run: cargo test --locked --manifest-path src-tauri/Cargo.toml --target ${{ matrix.target }}";
  const staging = native.indexOf("run: npm run build:sidecar:dev");
  const unit = native.indexOf(compile);
  const assembly = native.indexOf('run: npm run verify:assembly -- "${{ matrix.target }}" --assembly=debug');
  const actor = native.indexOf('run: node scripts/sidecar-bundle-smoke.cjs "${{ matrix.target }}" --assembly=debug');
  const browser = native.indexOf('run: node scripts/browser-bundle-smoke.cjs "${{ matrix.target }}" "target/${{ matrix.target }}/debug/browser-runtime"');
  assert.ok(staging > 0 && unit > staging && assembly > unit && actor > assembly && browser > actor);
  assert.doesNotMatch(native, /continue-on-error|\|\| true|if: (?:false|always\(\))/);
  assert.match(native, /BAMBOO_SIDECAR_TARGET: \$\{\{ matrix.target \}\}/);
  assert.match(native, /TAURI_ENV_TARGET_TRIPLE: \$\{\{ matrix.target \}\}/);
});

test("both feature gates wait for actual tests and run after a selected dependency fails", () => {
  assert.match(job("unit-tests"), /name: Unit Tests\n    needs: \[unit-node, native-tests\]/);
  assert.match(job("e2e-tests"), /name: E2E Tests\n    needs: native-tests/);
  for (const id of ["unit-tests", "e2e-tests"]) {
    assert.match(job(id), /if: always\(\) && !cancelled\(\)/);
    assert.doesNotMatch(job(id), /continue-on-error|\|\| true|exit 0/);
  }
});

test("feature aggregate gates reject failed, skipped, cancelled and absent native results", {
  skip: process.platform === "win32" && "aggregate commands use the hosted Linux shell",
}, () => {
  for (const id of ["unit-tests", "e2e-tests"]) {
    const block = job(id);
    const match = block.match(/        run: \|\n([\s\S]*)/) || block.match(/        run: ([^\n]+)/);
    assert.ok(match);
    const script = match[1].replace(/^          /gm, "");
    const run = (overrides = {}) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      env: { ...processEnv, NODE_RESULT: "success", NATIVE_RESULT: "success", ...overrides }, encoding: "utf8",
    });
    assert.equal(run().status, 0);
    for (const NATIVE_RESULT of ["failure", "cancelled", "skipped", "", "unknown"]) {
      assert.notEqual(run({ NATIVE_RESULT }).status, 0, `${id} accepted ${NATIVE_RESULT}`);
    }
    if (id === "unit-tests") {
      for (const NODE_RESULT of ["failure", "cancelled", "skipped", "", "unknown"]) {
        assert.notEqual(run({ NODE_RESULT }).status, 0, `Unit accepted ${NODE_RESULT}`);
      }
    }
  }
});
