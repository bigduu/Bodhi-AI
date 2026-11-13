const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { appImageTarget } = require("./tauri-build.cjs");

const linuxArm = "aarch64-unknown-linux-gnu";
const linuxX64 = "x86_64-unknown-linux-gnu";
const releaseEnvironment = (target) => ({ BAMBOO_SIDECAR_SOURCE: "release", BAMBOO_SIDECAR_TARGET: target });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-tauri-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(__dirname, "../package.json"), path.join(root, "package.json"));
  fs.copyFileSync(path.join(__dirname, "tauri.cjs"), path.join(root, "scripts/tauri.cjs"));
  fs.copyFileSync(path.join(__dirname, "tauri-build.cjs"), path.join(root, "scripts/tauri-build.cjs"));
  const observed = path.join(root, "observed.json");
  const record = (entry, args) => `require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({entry:${JSON.stringify(entry)},args:${args}})); process.exitCode=Number(process.env.BODHI_TEST_EXIT_CODE || 0);`;
  fs.writeFileSync(path.join(root, "scripts/tauri-dev.cjs"), `exports.runDevCommand=(args)=>{${record("owned-development", "args")}};`);
  const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, record("official-cli", "process.argv.slice(2)"));
  const releaseEnv = "({ PATCHELF: process.env.PATCHELF, NO_STRIP: process.env.NO_STRIP })";
  fs.appendFileSync(cli, `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "environment.json"))}, JSON.stringify(${releaseEnv}));`);
  return { root, observed };
}

function invoke(f, args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: f.root, env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  return { result, observed: JSON.parse(fs.readFileSync(f.observed, "utf8")) };
}

test("development dispatch retains native options and literal cargo/application arguments", (t) => {
  const f = fixture(t);
  const args = ["--release", "--", "--", "a path with spaces", "$(literal)"];
  for (const global of [[], ["--verbose"], ["-vv"]]) {
    const { result, observed } = invoke(f, ["scripts/tauri.cjs", ...global, "dev", ...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(observed, { entry: "owned-development", args: [...global, ...args] });
  }
});

test("non-development commands retain official CLI arguments and failure status", (t) => {
  const f = fixture(t);
  for (const args of [["build", "--debug"], ["info"], ["--help"], ["--version"], ["plugin", "add", "dev"]]) {
    const { result, observed } = invoke(f, ["scripts/tauri.cjs", ...args], { BODHI_TEST_EXIT_CODE: "7" });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(observed, { entry: "official-cli", args });
  }
});

test("both npm spellings reach owned development with the same native arguments", {
  skip: !process.env.npm_execpath && "Run npm run test:build to exercise npm argument forwarding.",
}, (t) => {
  const f = fixture(t);
  const args = ["--release", "--", "--", "a path with spaces"];
  for (const command of [["tauri", "dev", "--", ...args], ["tauri:dev", "--", ...args]]) {
    const { result, observed } = invoke(f, [process.env.npm_execpath, "run", "--silent", ...command]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(observed, { entry: "owned-development", args });
  }
});

test("npm tauri build keeps the official CLI and development failures remain failures", {
  skip: !process.env.npm_execpath && "Run npm run test:build to exercise npm exit status forwarding.",
}, (t) => {
  const f = fixture(t);
  const { result, observed } = invoke(f, [process.env.npm_execpath, "run", "--silent", "tauri", "--", "build", "--debug"], { BODHI_TEST_EXIT_CODE: "9" });
  assert.equal(result.status, 9, result.stderr);
  assert.deepEqual(observed, { entry: "official-cli", args: ["build", "--debug"] });
  for (const command of [["tauri", "dev"], ["tauri:dev"]]) {
    const failure = invoke(f, [process.env.npm_execpath, "run", "--silent", ...command], { BODHI_TEST_EXIT_CODE: "8" });
    assert.equal(failure.result.status, 8, failure.result.stderr);
    assert.equal(failure.observed.entry, "owned-development");
  }
});

test("only explicit matching Linux release AppImage bundles enable runtime byte preservation", () => {
  for (const target of [linuxArm, linuxX64]) {
    const env = releaseEnvironment(target);
    for (const args of [
      ["--target", target, "--bundles", "appimage,deb,rpm", "--verbose"],
      [`--target=${target}`, "--bundles=deb,appimage"],
      ["-t", target, "-b", "deb", "appimage", "-b", "rpm"],
      [`-t${target}`, "-bappimage", "--", "--profile=production"],
    ]) assert.equal(appImageTarget(args, env, "linux"), target);

    const appImage = ["--target", target, "--bundles", "appimage"];
    for (const args of [
      [],
      ["--target", target],
      ["--target", target, "--bundles", "deb,rpm"],
      ["--target", target, "--bundles", "appimage-extra"],
      ["--target", target, "--config", "appimage", "--bundles", "deb"],
      ["--target", target, "--bundles", "deb", "--", "--bundles", "appimage"],
      [...appImage, "--no-bundle"],
      [...appImage, "--debug"],
      [...appImage, "-dv"],
      [...appImage, "--help"],
      [...appImage, "-V"],
      [...appImage, "--target", target],
    ]) assert.equal(appImageTarget(args, env, "linux"), undefined);
    assert.equal(appImageTarget(appImage, { ...env, BAMBOO_SIDECAR_SOURCE: "local" }, "linux"), undefined);
    assert.equal(appImageTarget(appImage, { ...env, BAMBOO_SIDECAR_TARGET: "unmatched" }, "linux"), undefined);
    for (const platform of ["darwin", "win32"]) assert.equal(appImageTarget(appImage, env, platform), undefined);
  }
});

test("npm tauri:build forwards exact arguments and status outside Linux AppImage release", {
  skip: !process.env.npm_execpath && "Run npm run test:build to exercise npm argument forwarding.",
}, (t) => {
  const f = fixture(t);
  const args = ["--target", linuxX64, "--bundles", "deb,rpm", "--verbose", "--", "a path with spaces", "$(literal)"];
  const env = { ...releaseEnvironment(linuxX64), BODHI_TEST_EXIT_CODE: "11", PATCHELF: "existing-patchelf", NO_STRIP: "existing-no-strip" };
  const { result, observed } = invoke(f, [process.env.npm_execpath, "run", "--silent", "tauri:build", "--", ...args], env);
  assert.equal(result.status, 11, result.stderr);
  assert.deepEqual(observed, { entry: "official-cli", args: ["build", ...args] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "environment.json"), "utf8")), {
    PATCHELF: env.PATCHELF,
    NO_STRIP: env.NO_STRIP,
  });
});

test("the Linux AppImage release entrypoint supplies the wrapper to the locally installed CLI", {
  skip: process.platform !== "linux" || !fs.existsSync("/usr/bin/patchelf") || !process.env.npm_execpath,
}, (t) => {
  const f = fixture(t);
  const wrapper = path.join(f.root, "scripts/appimage-patchelf.sh");
  fs.copyFileSync(path.join(__dirname, "appimage-patchelf.sh"), wrapper);
  fs.chmodSync(wrapper, 0o755);
  const args = ["--target", linuxArm, "--bundles", "appimage,deb,rpm", "--verbose"];
  const { result, observed } = invoke(f, [process.env.npm_execpath, "run", "--silent", "tauri:build", "--", ...args], releaseEnvironment(linuxArm));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(observed, { entry: "official-cli", args: ["build", ...args] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "environment.json"), "utf8")), { PATCHELF: wrapper, NO_STRIP: "1" });
});

test("patchelf preserves only the exact staged sidecar and browser runtime paths", {
  skip: process.platform !== "linux" || !fs.existsSync("/usr/bin/patchelf"),
}, (t) => {
  const f = fixture(t);
  const parent = path.join(f.root, "bundle", "appimage");
  const appDir = path.join(parent, "Bodhi AI.AppDir");
  const runtime = "usr/lib/Bodhi AI/browser-runtime";
  const preserved = ["usr/bin/bamboo", `${runtime}/node/node`, `${runtime}/chromium/libEGL.so`];
  const mutable = ["usr/bin/bodhi", "usr/lib/libGTK-fixture.so", `${runtime}-neighbor/libEGL.so`];
  const input = fs.readFileSync("/bin/true");
  for (const relative of [...preserved, ...mutable]) {
    const file = path.join(appDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, input);
  }
  fs.symlinkSync(path.join(appDir, preserved[0]), path.join(appDir, "usr/bin/bamboo-link"));
  fs.symlinkSync(parent, path.join(f.root, "appimage-link"));
  const output = path.join(f.root, "appimage-link", "Bodhi AI_0.0.0_aarch64.AppImage");
  const patch = (args, selected = output) => spawnSync(path.join(__dirname, "appimage-patchelf.sh"), args, {
    env: { ...process.env, OUTPUT: selected }, encoding: "utf8",
  });
  for (const relative of [...preserved, ...mutable, "usr/bin/bamboo-link"]) {
    const file = path.join(appDir, relative);
    const result = patch(["--set-rpath", "$ORIGIN/../lib", file]);
    assert.equal(result.status, 0, result.stderr);
    const unchanged = preserved.includes(relative) || relative === "usr/bin/bamboo-link";
    assert.equal(fs.readFileSync(file).equals(input), unchanged, relative);
    if (!unchanged) assert.equal(patch(["--print-rpath", file]).stdout.trim(), "$ORIGIN/../lib");
  }
  const locked = path.join(appDir, preserved[0]);
  for (const invalid of ["", "Bodhi AI_0.0.0_aarch64.AppImage", path.join(parent, "unrelated.AppImage")]) {
    const failure = patch(["--set-rpath", "$ORIGIN", locked], invalid);
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /Expected the Bodhi AppImage output path from Tauri/);
  }
  assert.equal(patch(["--remove-rpath", locked]).status, 1);
  assert.ok(fs.readFileSync(locked).equals(input));
});
