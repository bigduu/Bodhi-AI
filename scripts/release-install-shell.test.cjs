"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { install } = require("./release-install-shell.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-release-shell-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = { "darwin:arm64": ["aarch64-apple-darwin", "cli-darwin-arm64"],
    "linux:x64": ["x86_64-unknown-linux-gnu", "cli-linux-x64-gnu"],
    "win32:x64": ["x86_64-pc-windows-msvc", "cli-win32-x64-msvc"] }[`${process.platform}:${process.arch}`];
  assert.ok(target, "Tests require a supported native target");
  fs.writeFileSync(path.join(root, "yarn.lock"), "original yarn lock\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: {
    "node_modules/@tauri-apps/cli": { version: "2.5.0" },
    [`node_modules/@tauri-apps/${target[1]}`]: { version: "2.5.0" },
  } }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init"); git("add", "yarn.lock", "package-lock.json");
  git("-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "-m", "fixture");
  return { root, target: target[0], package: target[1] };
}
function populate(fixture, version = "2.5.0") {
  for (const name of ["cli", fixture.package]) {
    const dir = path.join(fixture.root, "node_modules/@tauri-apps", name);
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  }
}

test("npm installs only the locked CLI while restoring the original Yarn lock", t => {
  const f = fixture(t);
  install(f.root, f.target, (_command, args) => {
    assert.ok(args.includes("ci") && args.includes("--ignore-scripts"));
    assert.equal(fs.existsSync(path.join(f.root, "yarn.lock")), false);
    populate(f); return { status: 0 };
  });
  assert.equal(fs.readFileSync(path.join(f.root, "yarn.lock"), "utf8"), "original yarn lock\n");
  assert.equal(fs.existsSync(path.join(f.root, ".bodhi-release-yarn-lock")), false);
});

test("a failed npm install restores the original Yarn lock", t => {
  const f = fixture(t);
  assert.throws(() => install(f.root, f.target, () => ({ status: 1 })), /Locked npm installation failed/);
  assert.equal(fs.readFileSync(path.join(f.root, "yarn.lock"), "utf8"), "original yarn lock\n");
});

test("an unexpected replacement Yarn lock is not silently overwritten", t => {
  const f = fixture(t);
  assert.throws(() => install(f.root, f.target, () => {
    fs.writeFileSync(path.join(f.root, "yarn.lock"), "unexpected\n"); return { status: 0 };
  }), /npm unexpectedly created a Yarn lock/);
  assert.equal(fs.readFileSync(path.join(f.root, ".bodhi-release-yarn-lock"), "utf8"), "original yarn lock\n");
  assert.equal(fs.readFileSync(path.join(f.root, "yarn.lock"), "utf8"), "unexpected\n");
});

test("a CLI version different from package-lock is rejected", t => {
  const f = fixture(t);
  assert.throws(() => install(f.root, f.target, () => { populate(f, "2.9.0"); return { status: 0 }; }));
});
