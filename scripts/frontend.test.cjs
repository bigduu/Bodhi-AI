const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const frontend = require("./lotus-dist.cjs");

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-frontend-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "bodhi");
  const sourceRoot = path.join(temp, "lotus-next");
  fs.mkdirSync(root);
  write(path.join(sourceRoot, "package.json"), { name: frontend.NEXT_PACKAGE, version: "0.0.0" });
  write(path.join(sourceRoot, ".gitignore"), "dist\n");
  const git = (...args) => execFileSync("git", ["-C", sourceRoot, ...args], { stdio: "pipe" });
  git("init");
  git("add", ".");
  git("-c", "user.name=Bodhi Test", "-c", "user.email=bodhi-test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=.no-hooks", "commit", "-m", "fixture");
  write(path.join(sourceRoot, "dist/index.html"), '<html><script type="module" src="./assets/app.js"></script><link rel="stylesheet" href="./assets/app.css"></html>');
  write(path.join(sourceRoot, "dist/assets/app.js"), 'import("./lazy.js");');
  write(path.join(sourceRoot, "dist/assets/app.css"), "body { color: black; }");
  write(path.join(sourceRoot, "dist/assets/lazy.js"), "export const lazy = true;");
  write(path.join(sourceRoot, "dist/asset-manifest.json"), {
    "index.html": { isEntry: true, file: "assets/app.js", css: ["assets/app.css"], dynamicImports: ["lazy"] },
    lazy: { file: "assets/lazy.js" },
  });
  return { temp, root, sourceRoot, source: frontend.resolveSource({}, root) };
}

test("local default selects only sibling Lotus Next, even with legacy fallbacks available", (t) => {
  const { root, sourceRoot, source, temp } = fixture(t);
  assert.equal(source.mode, "local");
  assert.equal(source.sourceRoot, sourceRoot);
  write(path.join(temp, "lotus/package.json"), { name: frontend.LEGACY_PACKAGE, version: "1.0.0" });
  write(path.join(root, "node_modules/@bigduu/lotus/package.json"), { name: frontend.LEGACY_PACKAGE, version: "1.0.0" });
  fs.renameSync(sourceRoot, `${sourceRoot}-missing`);
  assert.throws(() => frontend.resolveSource({}, root), /Lotus Next is missing.*LOTUS_LOCAL_PATH/);
  assert.throws(() => frontend.resolveSource({ LOTUS_SOURCE: "auto" }, root), /automatic fallback was removed/);
});

test("wrong package identity or legacy local override fails closed", (t) => {
  const { root, sourceRoot } = fixture(t);
  assert.throws(() => frontend.resolveSource({ LOTUS_PACKAGE_NAME: frontend.LEGACY_PACKAGE }, root), /Local builds require/);
  write(path.join(sourceRoot, "package.json"), { name: frontend.LEGACY_PACKAGE, version: "1.0.0" });
  assert.throws(() => frontend.resolveSource({}, root), /identity mismatch/);
});

test("deterministic receipt records revision and dirty state without checkout addresses", (t) => {
  const { root, sourceRoot, source } = fixture(t);
  const first = frontend.stageDist(source, root);
  const second = frontend.stageDist(source, root);
  assert.deepEqual(first, second);
  assert.match(first.sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(first.sourceDirty, false);
  assert.equal(first.contentHash, frontend.contentHash(frontend.inventory(path.join(root, ".bodhi-frontend/dist"))));
  assert.equal(JSON.stringify(first).includes(sourceRoot), false);
  write(path.join(sourceRoot, "new-source.ts"), "changed source");
  const dirty = frontend.stageDist(source, root);
  assert.equal(dirty.sourceDirty, true);
  assert.equal(dirty.sourceRevision, first.sourceRevision);
  write(path.join(sourceRoot, "dist/assets/lazy.js"), "export const lazy = false;");
  assert.notEqual(frontend.stageDist(source, root).contentHash, first.contentHash);
});

test("local build binds the backend at runtime and overrides public .env addresses", (t) => {
  const { source } = fixture(t);
  assert.throws(() => frontend.localBuildEnvironment(source, { VITE_BACKEND_BASE_URL: "https://example.invalid" }), /runtime backend discovery/);
  const env = frontend.localBuildEnvironment(source, {});
  assert.equal(env.VITE_BACKEND_BASE_URL, "");
  assert.match(env.VITE_APP_REVISION, /^[a-f0-9]{40}$/);
});

test("numeric root filenames use the same canonical UTF-8 order as Rust", (t) => {
  const { root } = fixture(t);
  const numbered = path.join(root, "numbered");
  write(path.join(numbered, "2"), "two");
  write(path.join(numbered, "10"), "ten");
  const files = frontend.inventory(numbered);
  assert.deepEqual(Object.keys(files), ["2", "10"]);
  // Golden vector hashes UTF-8 `10\0<sha256(ten)>\n2\0<sha256(two)>\n`.
  assert.equal(frontend.contentHash(files), "7b0c2eb6e494ca5000c68d513c21b0ce1cb1fff55b5077d0036c7ff62e951b3b");
});

test("a source revision change during production build prevents staging", (t) => {
  const f = fixture(t);
  const initial = frontend.sourceIdentity(f.source);
  let staged = false;
  let capturedRevision;
  let revision = initial.sourceRevision;
  const context = {
    module: { exports: {} },
    process: { env: {}, platform: process.platform },
    require(name) {
      if (name === "./lotus-dist.cjs") return {
        ...frontend,
        sourceIdentity: () => ({ ...initial, sourceRevision: revision }),
        stageDist() { staged = true; },
      };
      if (name === "node:child_process") return {
        spawnSync(_command, args, options) {
          if (args.includes("build")) {
            capturedRevision = options.env.VITE_APP_REVISION;
            revision = "b".repeat(40);
          }
          return { status: 0 };
        },
      };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "web-build.cjs"), "utf8"), context);
  assert.throws(() => context.module.exports.buildFrontend(f.source), /source revision or dirty status changed/);
  assert.equal(capturedRevision, initial.sourceRevision);
  assert.equal(staged, false);
});

test("missing, development or external entry assets are rejected", (t) => {
  const { source, sourceRoot } = fixture(t);
  for (const index of [
    '<script type="module" src="/src/main.tsx"></script>',
    '<script type="module" src="https://example.invalid/app.js"></script>',
    '<script type="module" src="./assets/missing.js"></script>',
    '<script type="module" src="../outside.js"></script>',
  ]) {
    write(path.join(sourceRoot, "dist/index.html"), index);
    assert.throws(() => frontend.verifyDist(source));
  }
  fs.rmSync(path.join(sourceRoot, "dist/index.html"));
  assert.throws(() => frontend.verifyDist(source), /index.html/);
});

test("published inline diagnostics and comments do not become fake asset references", (t) => {
  const { source, sourceRoot } = fixture(t);
  write(path.join(sourceRoot, "dist/index.html"), `
    <!-- <script type="module" src="missing-comment.js"></script> -->
    <script src="./assets/app.js" type=module></script>
    <script>
      setStatus("Bodhi UI is still loading. href=" + location.href + " module=" + moduleSrc);
      var example = '<img src="missing-script-string.png">';
    </script>
    <style>body::before { content: '<img src="missing-style-string.png">'; }</style>
    <link rel="stylesheet" href="./assets/app.css">
  `);
  assert.doesNotThrow(() => frontend.verifyDist(source));
  assert.doesNotThrow(() => frontend.verifyDist({ ...source, mode: "package" }));
  fs.rmSync(path.join(sourceRoot, "dist/assets/app.css"));
  assert.throws(() => frontend.verifyDist(source), /assets\/app.css/);
});

test("missing lazy chunks, manifest edges and unsafe resource paths are rejected", (t) => {
  const { source, sourceRoot } = fixture(t);
  const lazy = path.join(sourceRoot, "dist/assets/lazy.js");
  fs.rmSync(lazy);
  assert.throws(() => frontend.verifyDist(source), /assets\/lazy.js/);
  write(lazy, "export {};");
  write(path.join(sourceRoot, "dist/asset-manifest.json"), {
    "index.html": { isEntry: true, file: "assets/app.js", dynamicImports: ["missing"] },
  });
  assert.throws(() => frontend.verifyDist(source), /Missing asset manifest import/);
  for (const file of ["../outside", "/absolute", "a\\b", "a//b", "a\0b", "C:/data"]) {
    assert.equal(frontend.safeRelative(file), false);
  }
});

test("symlinked frontend files are rejected", { skip: process.platform === "win32" }, (t) => {
  const { source, sourceRoot } = fixture(t);
  fs.symlinkSync(path.join(sourceRoot, "package.json"), path.join(sourceRoot, "dist/linked.json"));
  assert.throws(() => frontend.verifyDist(source), /Unsafe frontend path/);
});

test("explicit legacy package staging remains supported without bundling a second UI", (t) => {
  const { root, sourceRoot } = fixture(t);
  const packageRoot = path.join(root, "node_modules/@bigduu/lotus");
  write(path.join(packageRoot, "package.json"), { name: frontend.LEGACY_PACKAGE, version: "2026.9.0" });
  fs.cpSync(path.join(sourceRoot, "dist"), path.join(packageRoot, "dist"), { recursive: true });
  const source = frontend.resolveSource({ LOTUS_SOURCE: "package", LOTUS_PACKAGE_NAME: frontend.LEGACY_PACKAGE }, root);
  const receipt = frontend.stageDist(source, root);
  assert.equal(receipt.mode, "package");
  assert.equal(receipt.sourceRevision, null);
  assert.equal(fs.existsSync(path.join(root, ".lotus-dist/index.html")), true);
  assert.deepEqual(fs.readdirSync(path.join(root, ".bodhi-frontend")), ["receipt.json"]);
  assert.throws(() => frontend.resolveSource({ LOTUS_SOURCE: "package" }, root), /requires explicit/);
});

// Execute the real assembly script with instrumented process launches. All
// filesystem work uses an isolated fixture; no Cargo or user checkout is touched.
function assemble(f, mode, producerLayout = "crate") {
  const bamboo = path.join(f.temp, "bamboo");
  write(path.join(bamboo, "Cargo.toml"), "[workspace]\n");
  const rootOutput = path.join(bamboo, "frontend_package");
  const crateOutput = path.join(bamboo, "crates/app/bamboo-server/frontend_package");
  if (mode === "package") {
    for (const output of [rootOutput, crateOutput]) {
      write(path.join(output, "lotus-frontend.zip"), "stale zip");
      write(path.join(output, "frontend-manifest.json"), "stale manifest");
    }
    if (["symlink", "root-alias"].includes(producerLayout)) {
      fs.rmSync(crateOutput, { recursive: true });
      fs.symlinkSync(producerLayout === "root-alias" ? rootOutput : path.join(f.temp, "outside"), crateOutput, "dir");
    }
  }
  const calls = [];
  const source = mode === "local" ? f.source : { ...f.source, mode: "package", packageName: frontend.LEGACY_PACKAGE };
  const env = { BAMBOO_LOCAL_PATH: bamboo, BAMBOO_FRONTEND_BUILD_MODE: producerLayout === "root" ? "api-only" : "auto" };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "build-sidecar.cjs"), "utf8"), {
    __dirname: path.join(f.root, "scripts"),
    console: { log() {}, warn() {}, error() {} },
    process: { env, argv: ["node", "build-sidecar.cjs"], execPath: process.execPath },
    require(name) {
      if (name === "./lotus-dist.cjs") return { resolveSource: () => source };
      if (name === "./web-build.cjs") return { buildFrontend: () => frontend.stageDist(source, f.root) };
      if (name === "node:child_process") return {
        execFileSync(command, args, options) {
          if (command === "rustc") return "host: x86_64-unknown-linux-gnu\n";
          calls.push({ command, args: [...args], env: { ...options.env } });
          if (command === "cargo") write(path.join(bamboo, "target/release/bamboo"), "fixture binary");
          else {
            const outputs = producerLayout === "both" ? [rootOutput, crateOutput] :
              producerLayout === "none" ? [] : [producerLayout === "root" ? rootOutput : crateOutput];
            for (const output of outputs) {
              write(path.join(output, "lotus-frontend.zip"), "explicit legacy embed");
              if (producerLayout !== "partial") write(path.join(output, "frontend-manifest.json"), {});
            }
          }
        },
      };
      return require(name);
    },
  });
  return { calls, bamboo };
}

test("local sidecar assembly forces API-only and never invokes the legacy embed builder", (t) => {
  const f = fixture(t);
  const { calls, bamboo } = assemble(f, "local");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "cargo");
  assert.equal(calls[0].env.BAMBOO_FRONTEND_BUILD_MODE, "api-only");
  assert.ok(calls[0].args.includes("--locked"));
  assert.equal(fs.existsSync(path.join(bamboo, "frontend_package")), false);
  assert.equal(fs.readFileSync(path.join(f.root, "src-tauri/binaries/bamboo-x86_64-unknown-linux-gnu"), "utf8"), "fixture binary");
});

test("explicit package assembly accepts main/root and dev/crate producers without stale overwrites", (t) => {
  for (const layout of ["root", "crate"]) {
    const f = fixture(t);
    const { calls, bamboo } = assemble(f, "package", layout);
    assert.deepEqual(calls[0].args, ["scripts/frontend-package.cjs"]);
    assert.equal(calls[1].command, "cargo");
    assert.equal(calls[1].env.BAMBOO_FRONTEND_BUILD_MODE, "embedded");
    assert.equal(fs.readFileSync(path.join(bamboo, "crates/app/bamboo-server/frontend_package/lotus-frontend.zip"), "utf8"), "explicit legacy embed");
    if (layout === "crate") assert.equal(fs.readFileSync(path.join(bamboo, "frontend_package/lotus-frontend.zip"), "utf8"), "stale zip");
  }
});

test("explicit package assembly rejects stale-only, partial and ambiguous producer output", (t) => {
  for (const layout of ["none", "partial", "both"]) {
    assert.throws(() => assemble(fixture(t), "package", layout), /one fresh, complete zip\/manifest pair/);
  }
});

test("package assembly leaves an existing producer symlink untouched with actionable guidance", { skip: process.platform === "win32" }, (t) => {
  for (const layout of ["symlink", "root-alias"]) {
    const f = fixture(t);
    assert.throws(() => assemble(f, "package", layout), /Set BAMBOO_LOCAL_PATH to a clean checkout/);
    assert.equal(fs.lstatSync(path.join(f.temp, "bamboo/crates/app/bamboo-server/frontend_package")).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(f.temp, "bamboo/frontend_package/lotus-frontend.zip"), "utf8"), "stale zip");
  }
});
