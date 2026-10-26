const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const frontend = require("./lotus-dist.cjs");
const artifact = require("./lotus-next-artifact.cjs");
const { verifySidecar } = require("./verify-assembly.cjs");

test("Mac bundle verification threads the selected S browser lock to staged and bundled C verifiers", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-mac-selected-lock-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "candidate.app"), staged = path.join(root, "src-tauri/browser-runtime"), bundled = path.join(app, "Contents/Resources/browser-runtime");
  const receipt = { packageName: "@bigduu/lotus", schemaVersion: 1 }, selected = { schemaVersion: 1, nodeVersion: "99.0.1" }, calls = [];
  for (const directory of [staged, bundled, path.join(app, "Contents/Resources/frontend")]) {
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "receipt.json"), JSON.stringify(receipt));
  }
  const sandbox = { module: { exports: {} }, __dirname, Buffer, process, JSON, require(name) {
    if (name === "./browser-runtime.cjs") return { verifyRuntime(...args) { calls.push(args); return {}; } };
    if (name === "node:child_process") return { execFileSync(program) { assert.equal(program, "codesign"); } };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "verify-assembly.cjs"), "utf8"), sandbox);
  sandbox.module.exports.verifyMacosBundle(root, "aarch64-apple-darwin", receipt, app, selected);
  assert.deepEqual(calls.map(args => args[0]), [staged, bundled]);
  assert.ok(calls.every(args => args[3] === selected));
});

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

function installNextPackage(root, sourceDist) {
  const packageRoot = path.join(root, "node_modules/@bigduu/lotus-next");
  write(path.join(packageRoot, "package.json"), {
    name: frontend.NEXT_PACKAGE,
    version: "2026.9.22",
  });
  fs.cpSync(sourceDist, path.join(packageRoot, "dist"), { recursive: true });
  const dist = path.join(packageRoot, "dist");
  const resources = Object.keys(frontend.inventory(dist)).map((resourcePath) => {
    const contents = fs.readFileSync(path.join(dist, resourcePath));
    return {
      path: resourcePath,
      size: contents.byteLength,
      sha256: sha256(contents),
    };
  });
  const manifest = {
    schemaVersion: 1,
    packageName: frontend.NEXT_PACKAGE,
    packageVersion: "2026.9.22",
    sourceRevision: "a".repeat(40),
    sourceDirty: false,
    entrypoint: "index.html",
    resourcesSha256: artifact.calculateResourcesSha256(resources),
    resources,
  };
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(
    path.join(dist, frontend.ARTIFACT_MANIFEST_FILE),
    manifestSource,
  );
  const lock = {
    schemaVersion: 1,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    sourceRevision: manifest.sourceRevision,
    sourceDirty: false,
    entrypoint: manifest.entrypoint,
    resourcesSha256: manifest.resourcesSha256,
    manifestSha256: sha256(manifestSource),
  };
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "scripts/frontend-package-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  return { packageRoot, manifest, lock };
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
  assert.doesNotThrow(() =>
    frontend.verifyDist({
      ...source,
      mode: "package",
      packageName: frontend.LEGACY_PACKAGE,
    }),
  );
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

test("a symlinked staging parent is rejected without touching its target", { skip: process.platform === "win32" }, (t) => {
  const { root, source } = fixture(t);
  const outside = path.join(path.dirname(root), "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "tmp"));
  assert.throws(() => frontend.stageDist(source, root), /staging parent/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(root, ".bodhi-frontend")), false);
});

test("a symlinked staged receipt is rejected", { skip: process.platform === "win32" }, (t) => {
  const { root, source } = fixture(t);
  frontend.stageDist(source, root);
  const receipt = path.join(root, ".bodhi-frontend/receipt.json");
  const outside = path.join(root, "outside-receipt.json");
  fs.renameSync(receipt, outside);
  fs.symlinkSync(outside, receipt);
  assert.throws(
    () => frontend.verifyStaged(source, root),
    /expected a regular file, not a symbolic link/,
  );
});

test("locked Lotus Next is the default package and stages an owned dist", (t) => {
  const { root, sourceRoot } = fixture(t);
  const { manifest, lock } = installNextPackage(
    root,
    path.join(sourceRoot, "dist"),
  );
  const source = frontend.resolveSource({ LOTUS_SOURCE: "package" }, root);
  const receipt = frontend.stageDist(source, root);
  assert.equal(source.packageName, frontend.NEXT_PACKAGE);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.mode, "package");
  assert.equal(receipt.sourceRevision, manifest.sourceRevision);
  assert.equal(receipt.sourceDirty, false);
  assert.equal(receipt.artifactManifestSha256, lock.manifestSha256);
  assert.equal(receipt.artifactResourcesSha256, lock.resourcesSha256);
  assert.equal(
    fs.existsSync(path.join(root, ".bodhi-frontend/dist/index.html")),
    true,
  );
});

test("rejected package bytes do not replace the last verified generated output", (t) => {
  const { root, sourceRoot } = fixture(t);
  const { packageRoot } = installNextPackage(
    root,
    path.join(sourceRoot, "dist"),
  );
  const source = frontend.resolveSource({ LOTUS_SOURCE: "package" }, root);
  frontend.stageDist(source, root);
  const receiptBefore = fs.readFileSync(
    path.join(root, ".bodhi-frontend/receipt.json"),
  );
  const indexBefore = fs.readFileSync(path.join(root, ".lotus-dist/index.html"));
  fs.appendFileSync(path.join(packageRoot, "dist/index.html"), "tampered\n");
  assert.throws(() => frontend.stageDist(source, root), /does not match/);
  assert.deepEqual(
    fs.readFileSync(path.join(root, ".bodhi-frontend/receipt.json")),
    receiptBefore,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(root, ".lotus-dist/index.html")),
    indexBefore,
  );
});

test("package metadata and the committed artifact lock must agree", (t) => {
  const { root, sourceRoot } = fixture(t);
  const { packageRoot } = installNextPackage(
    root,
    path.join(sourceRoot, "dist"),
  );
  write(path.join(packageRoot, "package.json"), {
    name: frontend.NEXT_PACKAGE,
    version: "2026.9.15",
  });
  assert.throws(
    () => frontend.resolveSource({ LOTUS_SOURCE: "package" }, root),
    /does not match the locked 2026\.9\.22/,
  );
});

test("explicit legacy package staging remains the rollback embed path", (t) => {
  const { root, sourceRoot } = fixture(t);
  const packageRoot = path.join(root, "node_modules/@bigduu/lotus");
  write(path.join(packageRoot, "package.json"), { name: frontend.LEGACY_PACKAGE, version: "2026.9.0" });
  fs.cpSync(path.join(sourceRoot, "dist"), path.join(packageRoot, "dist"), { recursive: true });
  const source = frontend.resolveSource({ LOTUS_SOURCE: "package", LOTUS_PACKAGE_NAME: frontend.LEGACY_PACKAGE }, root);
  const receipt = frontend.stageDist(source, root);
  assert.equal(receipt.mode, "package");
  assert.equal(receipt.sourceRevision, null);
  assert.equal(receipt.artifactManifestSha256, null);
  assert.equal(fs.existsSync(path.join(root, ".lotus-dist/index.html")), true);
  assert.deepEqual(fs.readdirSync(path.join(root, ".bodhi-frontend")), ["receipt.json"]);
  assert.throws(
    () => frontend.resolveSource({ LOTUS_SOURCE: "package" }, root),
    /@bigduu\/lotus-next is not installed/,
  );
});

// Execute the real assembly script with instrumented process launches. All
// filesystem work uses an isolated fixture; no Cargo or user checkout is touched.
function assemble(f, mode, producerLayout = "crate", overrides = {}) {
  const bamboo = path.join(f.temp, "bamboo");
  write(path.join(bamboo, "Cargo.toml"), "[workspace]\n");
  const rootOutput = path.join(bamboo, "frontend_package");
  const crateOutput = path.join(bamboo, "crates/app/bamboo-server/frontend_package");
  if (mode === "legacy-package") {
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
  let source = f.source;
  if (mode === "next-package") {
    installNextPackage(f.root, path.join(f.sourceRoot, "dist"));
    source = frontend.resolveSource({ LOTUS_SOURCE: "package" }, f.root);
  } else if (mode === "legacy-package") {
    source = {
      ...f.source,
      mode: "package",
      packageName: frontend.LEGACY_PACKAGE,
    };
  }
  const env = { BAMBOO_SIDECAR_SOURCE: "local", BAMBOO_LOCAL_PATH: bamboo, ...overrides };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "build-sidecar.cjs"), "utf8"), {
    __dirname: path.join(f.root, "scripts"),
    console: { log() {}, warn() {}, error() {} },
    process: { env, argv: ["node", "build-sidecar.cjs"], execPath: process.execPath },
    require(name) {
      if (name === "./lotus-dist.cjs") {
        return {
          LEGACY_PACKAGE: frontend.LEGACY_PACKAGE,
          NEXT_PACKAGE: frontend.NEXT_PACKAGE,
          resolveSource: () => source,
        };
      }
      if (name === "./web-build.cjs") return { buildFrontend: () => frontend.stageDist(source, f.root) };
      if (name === "node:child_process") return {
        execFileSync(command, args, options) {
          if (command === "rustc") return "host: x86_64-unknown-linux-gnu\n";
          calls.push({ command, args: [...args], env: { ...options.env } });
          if (args[0] === "scripts/bamboo-sidecar.cjs" && f.downloadFailure) throw f.downloadFailure;
          if (command === "cargo") {
            const profile = args.includes("--release") ? "release" : "debug";
            const targetIndex = args.indexOf("--target");
            const parts = targetIndex < 0 ? [] : [args[targetIndex + 1]];
            write(path.join(bamboo, "target", ...parts, profile, "bamboo"), "fixture binary");
          }
          else if (args[0] === "scripts/frontend-package.cjs") {
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

test("local sidecar defaults to api-only because Bodhi owns the frontend resources", (t) => {
  const f = fixture(t);
  const { calls, bamboo } = assemble(f, "local");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["scripts/browser-runtime.cjs", "x86_64-unknown-linux-gnu"]);
  assert.equal(calls[1].command, "cargo");
  assert.equal(calls[1].env.BAMBOO_FRONTEND_BUILD_MODE, "api-only");
  assert.ok(calls[1].args.includes("--locked"));
  assert.equal(fs.existsSync(path.join(bamboo, "frontend_package")), false);
  assert.equal(fs.readFileSync(path.join(f.root, "src-tauri/binaries/bamboo-x86_64-unknown-linux-gnu"), "utf8"), "fixture binary");
});

test("explicit local package assembly uses api-only and owned Tauri resources", (t) => {
  const f = fixture(t);
  const { calls, bamboo } = assemble(f, "next-package");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["scripts/browser-runtime.cjs", "x86_64-unknown-linux-gnu"]);
  assert.equal(calls[1].command, "cargo");
  assert.equal(calls[1].env.BAMBOO_FRONTEND_BUILD_MODE, "api-only");
  assert.equal(fs.existsSync(path.join(bamboo, "frontend_package")), false);
  assert.equal(
    fs.existsSync(path.join(f.root, ".bodhi-frontend/dist/index.html")),
    true,
  );
});

test("local sidecar honors supported explicit frontend modes", (t) => {
  for (const mode of ["api-only", "embedded", " API-ONLY "]) {
    const { calls } = assemble(fixture(t), "local", "crate", { BAMBOO_FRONTEND_BUILD_MODE: mode });
    assert.equal(calls[1].env.BAMBOO_FRONTEND_BUILD_MODE, mode.trim().toLowerCase());
  }
});

test("unsupported local frontend mode fails before frontend staging, browser preparation or Cargo", (t) => {
  for (const mode of ["auto", "unknown"]) {
    const f = fixture(t);
    assert.throws(() => assemble(f, "local", "crate", { BAMBOO_FRONTEND_BUILD_MODE: mode }), /Invalid BAMBOO_FRONTEND_BUILD_MODE.*Use embedded or api-only/);
    assert.equal(fs.existsSync(path.join(f.root, ".bodhi-frontend")), false);
    assert.equal(fs.existsSync(path.join(f.root, "src-tauri/browser-runtime")), false);
    assert.equal(fs.existsSync(path.join(f.temp, "bamboo/target")), false);
  }
});

test("production defaults to the published full Bamboo binary even with a checkout available", (t) => {
  const f = fixture(t);
  const { calls } = assemble(f, "next-package", "crate", {
    BAMBOO_SIDECAR_SOURCE: "", BAMBOO_SIDECAR_TARGET: "aarch64-apple-darwin", BAMBOO_FRONTEND_BUILD_MODE: "auto",
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["scripts/bamboo-sidecar.cjs", "install", "aarch64-apple-darwin"]);
  assert.deepEqual(calls[1].args, ["scripts/browser-runtime.cjs", "aarch64-apple-darwin"]);
  assert.ok(calls.every((call) => call.env.BAMBOO_SIDECAR_SOURCE === "release"));
  assert.ok(calls.every((call) => call.env.BAMBOO_FRONTEND_BUILD_MODE === "embedded"));
  assert.ok(calls.every((call) => call.command !== "cargo"));
});

test("full release reuse retains the locked Bodhi frontend and rejects unknown sources", (t) => {
  assert.throws(() => assemble(fixture(t), "legacy-package", "crate", { BAMBOO_SIDECAR_SOURCE: "release" }), /retains the verified Lotus Next/);
  assert.throws(() => assemble(fixture(t), "local", "crate", { BAMBOO_SIDECAR_SOURCE: "fallback" }), /Unknown BAMBOO_SIDECAR_SOURCE/);
});

test("a failed published asset install stops the hook before browser staging or Cargo", (t) => {
  const f = fixture(t);
  f.downloadFailure = new Error("fixture: published asset missing");
  assert.throws(() => assemble(f, "next-package", "crate", { BAMBOO_SIDECAR_SOURCE: "release" }), /published asset missing/);
  assert.equal(fs.existsSync(path.join(f.temp, "bamboo/target")), false);
  assert.equal(fs.existsSync(path.join(f.root, ".bodhi-frontend")), false);
  assert.equal(fs.existsSync(path.join(f.root, "src-tauri/browser-runtime")), false);
});

test("debug development keeps the local source default", (t) => {
  const { calls } = assemble(fixture(t), "local", "crate", { BAMBOO_SIDECAR_SOURCE: "", TAURI_ENV_DEBUG: "true" });
  assert.equal(calls[1].command, "cargo");
  assert.equal(calls[1].env.BAMBOO_FRONTEND_BUILD_MODE, "api-only");
  assert.equal(calls[1].args.includes("--release"), false);
});

test("Tauri hook target and debug profile control both sidecar and browser assembly", (t) => {
  const { calls } = assemble(fixture(t), "local", "crate", {
    TAURI_ENV_DEBUG: "true", TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin",
  });
  assert.deepEqual(calls[0].args, ["scripts/browser-runtime.cjs", "aarch64-apple-darwin"]);
  assert.equal(calls[0].env.BODHI_BROWSER_RUNTIME_RELEASE_BUILD, "0");
  assert.equal(calls[1].args.includes("--release"), false);
  assert.equal(calls[1].args.at(-1), "aarch64-apple-darwin");
  assert.throws(() => assemble(fixture(t), "local", "crate", {
    TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin", BAMBOO_SIDECAR_TARGET: "x86_64-unknown-linux-gnu",
  }), /must match the Tauri build target/);
});

test("explicit legacy rollback accepts main/root and dev/crate producers", (t) => {
  for (const layout of ["root", "crate"]) {
    const f = fixture(t);
    const { calls, bamboo } = assemble(f, "legacy-package", layout, { BAMBOO_FRONTEND_BUILD_MODE: layout === "root" ? "api-only" : "auto" });
    assert.deepEqual(calls[1].args, ["scripts/frontend-package.cjs"]);
    assert.equal(calls[2].command, "cargo");
    assert.equal(calls[2].env.BAMBOO_FRONTEND_BUILD_MODE, "embedded");
    assert.equal(fs.readFileSync(path.join(bamboo, "crates/app/bamboo-server/frontend_package/lotus-frontend.zip"), "utf8"), "explicit legacy embed");
    if (layout === "crate") assert.equal(fs.readFileSync(path.join(bamboo, "frontend_package/lotus-frontend.zip"), "utf8"), "stale zip");
  }
});

test("explicit legacy rollback rejects stale-only, partial and ambiguous output", (t) => {
  for (const layout of ["none", "partial", "both"]) {
    assert.throws(() => assemble(fixture(t), "legacy-package", layout), /one fresh, complete zip\/manifest pair/);
  }
});

test("legacy rollback leaves an existing producer symlink untouched", { skip: process.platform === "win32" }, (t) => {
  for (const layout of ["symlink", "root-alias"]) {
    const f = fixture(t);
    assert.throws(() => assemble(f, "legacy-package", layout), /Set BAMBOO_LOCAL_PATH to a clean checkout/);
    assert.equal(fs.lstatSync(path.join(f.temp, "bamboo/crates/app/bamboo-server/frontend_package")).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(f.temp, "bamboo/frontend_package/lotus-frontend.zip"), "utf8"), "stale zip");
  }
});

test("assembly verification rejects placeholders and validates target binaries", (t) => {
  const { root } = fixture(t);
  const binaryRoot = path.join(root, "src-tauri/binaries");
  fs.mkdirSync(binaryRoot, { recursive: true });

  const elf = (machine) => {
    const contents = Buffer.alloc(65536);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(contents);
    contents[4] = 2;
    contents[5] = 1;
    contents.writeUInt16LE(machine, 18);
    return contents;
  };
  const mach = (cpuType) => {
    const contents = Buffer.alloc(65536);
    contents.writeUInt32LE(0xfeedfacf, 0);
    contents.writeUInt32LE(cpuType, 4);
    return contents;
  };
  const universalMach = (...cpuTypes) => {
    const contents = Buffer.alloc(65536);
    contents.writeUInt32BE(0xcafebabe, 0);
    contents.writeUInt32BE(cpuTypes.length, 4);
    cpuTypes.forEach((cpuType, index) => {
      contents.writeUInt32BE(cpuType, 8 + index * 20);
    });
    return contents;
  };
  const pe = (machine) => {
    const contents = Buffer.alloc(65536);
    contents.write("MZ", 0, "ascii");
    contents.writeUInt32LE(128, 0x3c);
    contents.write("PE\0\0", 128, "binary");
    contents.writeUInt16LE(machine, 132);
    return contents;
  };
  const cases = [
    ["x86_64-unknown-linux-gnu", elf(0x3e), elf(0xb7), "", "x86_64"],
    ["aarch64-apple-darwin", mach(0x0100000c), mach(0x01000007), "", "aarch64"],
    ["x86_64-pc-windows-msvc", pe(0x8664), pe(0xaa64), ".exe", "x86_64"],
  ];
  for (const [target, valid, wrongCpu, extension, architecture] of cases) {
    const file = path.join(binaryRoot, `bamboo-${target}${extension}`);
    fs.writeFileSync(file, "placeholder");
    assert.throws(() => verifySidecar(root, target), /placeholder/);
    fs.writeFileSync(file, wrongCpu);
    assert.throws(() => verifySidecar(root, target), /CPU architecture/);
    fs.writeFileSync(file, valid);
    assert.deepEqual(verifySidecar(root, target), {
      binary: file,
      size: valid.length,
      architecture,
    });
  }
  const universalTarget = "aarch64-apple-darwin";
  const universalFile = path.join(binaryRoot, `bamboo-${universalTarget}`);
  const universal = universalMach(0x01000007, 0x0100000c);
  fs.writeFileSync(universalFile, universal);
  assert.deepEqual(verifySidecar(root, universalTarget), {
    binary: universalFile,
    size: universal.length,
    architecture: "aarch64",
  });
  assert.throws(() => verifySidecar(root, "../outside"), /Invalid sidecar/);
});

test("release captures original root-workspace installers before finalization", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/release.yml"), "utf8");
  const output = fs.readFileSync(path.join(__dirname, "release-output.cjs"), "utf8");
  assert.doesNotMatch(workflow, /src-tauri\/target\/|tauri-apps\/tauri-action/);
  assert.equal((workflow.match(/npm run tauri:build/g) || []).length, 1);
  assert.match(workflow, /scripts\/release-output\.cjs capture/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.ok(output.includes('path.join(root, "target", target, "release")'));
  assert.ok(output.includes('["appimage", "deb", "rpm"]'));
  assert.ok(output.includes('["dmg", "macos"]'));
  assert.ok(output.includes('["nsis"]'));
});

// The installed package must match the committed universal artifact lock.
test("CI installs the committed frontend identity before exact staging", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "frontend-package-lock.json"), "utf8"));
  const ci = fs.readFileSync(path.join(__dirname, "../.github/workflows/ci.yml"), "utf8");
  assert.doesNotMatch(ci, /^  LOTUS_VERSION:/m);
  assert.ok(ci.includes("require('./scripts/frontend-package-lock.json').packageVersion"));
  assert.equal(ci.match(/^  LOTUS_PACKAGE_NAME: "([^"]+)"$/m)?.[1], lock.packageName);
});
